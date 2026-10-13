#!/usr/bin/env node
// Apply the SQL migrations in supabase/migrations/ to the Supabase project —
// in order, each one once.
//
//   pnpm migrate              apply everything not yet applied
//   pnpm migrate:status       what is applied, what is pending, what changed
//   pnpm migrate:dry-run      list what a run would apply, apply nothing
//   pnpm migrate --baseline   record every file as already applied, running none
//                             (first-time setup on a database that already has them)
//   pnpm migrate --mark 125_x.sql   record one file as applied without running it
//
// How it connects, in order of preference:
//   SUPABASE_DB_URL         a Postgres connection string (Dashboard → Connect →
//                           Session pooler). Runs through psql, so a migration
//                           can take as long as it needs. The most reliable path.
//   SUPABASE_ACCESS_TOKEN   a personal access token; SQL goes through the
//                           Management API. No psql needed, but a single
//                           statement is cut off after about a minute, so heavy
//                           data backfills belong on the DB URL path.
//   SUPABASE_PROJECT_REF    the project ref (only the
//                           Management API path uses it).
//
// What "applied" means: a row in public.applied_migrations, keyed by file name.
// Files are ordered by their leading number ("23_", "122_"), then by name. Each
// migration runs in one transaction with its own ledger row, so a failing
// migration leaves no trace and the run stops there — nothing after it runs.
// A file that contains CREATE INDEX CONCURRENTLY (or VACUUM) cannot run inside
// a transaction and is run plain, with a warning.
//
// Nothing here depends on anything outside Node 22 (and psql for the DB URL
// path — present on every GitHub runner and on any machine with Postgres).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { splitStatements } from './sql-split.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.MIGRATIONS_DIR || join(HERE, '..', 'supabase', 'migrations'));
const LEDGER = 'public.applied_migrations';
const API = process.env.SUPABASE_API_URL || 'https://api.supabase.com';

// ---- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const mode = flag('--status') ? 'status' : flag('--dry-run') ? 'dry-run' : flag('--baseline') ? 'baseline' : flag('--mark') ? 'mark' : 'apply';
const marks = mode === 'mark' ? args.slice(args.indexOf('--mark') + 1).filter((a) => !a.startsWith('--')) : [];
if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

// ---- the files ---------------------------------------------------------------

/** Every NN_name.sql in the folder, in the order they are meant to run. */
export function listMigrations(dir = DIR) {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f));
  const parsed = files.map((name) => ({ name, number: Number(/^(\d+)_/.exec(name)[1]) }));
  parsed.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const seen = new Map();
  for (const m of parsed) {
    if (seen.has(m.number)) warn(`${m.name} and ${seen.get(m.number)} share the number ${m.number}; they run in name order.`);
    seen.set(m.number, m.name);
  }
  return parsed.map((m) => {
    const sql = readFileSync(join(dir, m.name), 'utf8');
    return { ...m, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
}

const NO_TRANSACTION = /\bconcurrently\b|^\s*vacuum\b/im;

// ---- the two ways to reach the database -----------------------------------

function psqlRunner(url) {
  const run = (argv, input) => {
    const r = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...argv], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`psql could not start: ${r.error.message}. Install the PostgreSQL client, or set SUPABASE_ACCESS_TOKEN instead of SUPABASE_DB_URL.`);
    return r;
  };
  return {
    label: 'psql (SUPABASE_DB_URL)',
    /** Rows of one SELECT, as objects. */
    rows(sql) {
      const r = run(['-At', '-c', `select coalesce(json_agg(r), '[]'::json) from (${sql.replace(/;\s*$/, '')}) r`]);
      if (r.status !== 0) throw new Error(r.stderr.trim());
      return JSON.parse(r.stdout.trim() || '[]');
    },
    /** A whole script. Notices (RAISE NOTICE) are returned so the run can show them. */
    exec(script, { transaction }) {
      const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
      const file = join(dir, 'migration.sql');
      try {
        writeFileSync(file, script);
        const r = run([...(transaction ? ['--single-transaction'] : []), '-f', file]);
        const notices = r.stderr.split('\n').filter((l) => /^psql:.*NOTICE:/.test(l)).map((l) => l.replace(/^psql:[^:]*:\d+:\s*NOTICE:\s*/, ''));
        if (r.status !== 0) throw new Error(r.stderr.split('\n').filter((l) => !/NOTICE:/.test(l)).join('\n').trim());
        return notices;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function apiRunner(token, ref) {
  const call = async (query) => {
    const res = await fetch(`${API}/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* keep the body */ }
      throw new Error(`Management API ${res.status}: ${msg}`);
    }
    try { return JSON.parse(text); } catch { return []; }
  };
  return {
    label: `Management API (SUPABASE_ACCESS_TOKEN, project ${ref})`,
    async rows(sql) { const out = await call(sql); return Array.isArray(out) ? out : []; },
    async exec(script, { transaction }) {
      // One request is one implicit transaction: an error anywhere rolls the
      // whole script back. That is the transaction case. CREATE INDEX
      // CONCURRENTLY refuses to run inside one, so a no-transaction file goes
      // one statement per request, in order, stopping at the first failure.
      if (transaction) { await call(script); return []; }
      for (const statement of splitStatements(script)) await call(statement);
      return [];
    },
  };
}

function pickRunner() {
  if (process.env.SUPABASE_DB_URL) return psqlRunner(process.env.SUPABASE_DB_URL);
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    const raw = process.env.SUPABASE_PROJECT_REF || '';
    // The ref as pasted: bare, or inside the project / dashboard URL.
    const ref = (raw.match(/(?:^|[^a-z])([a-z]{20})(?:[^a-z]|$)/) || [])[1];
    if (!ref) fail(2, 'Set SUPABASE_PROJECT_REF to your project ref (the 20 letters in the project URL).');
    return apiRunner(process.env.SUPABASE_ACCESS_TOKEN, ref);
  }
  fail(2, 'No way to reach the database. Set SUPABASE_DB_URL (Dashboard → Connect → Session pooler connection string) or SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens).');
}

// ---- the ledger -----------------------------------------------------------------

const ENSURE_LEDGER = `
create table if not exists ${LEDGER} (
  name        text primary key,
  sha256      text not null,
  applied_at  timestamptz not null default now(),
  applied_by  text
);
alter table ${LEDGER} enable row level security;
comment on table ${LEDGER} is 'Which files in supabase/migrations/ have run here. Maintained by scripts/migrate.mjs; no policies, so only the database owner reads it.';
`;

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const who = () => process.env.GITHUB_ACTOR ? `github:${process.env.GITHUB_ACTOR}` : (process.env.USER || 'local');
const record = (m) => `insert into ${LEDGER} (name, sha256, applied_by) values (${lit(m.name)}, ${lit(m.sha256)}, ${lit(who())});`;

// ---- output ---------------------------------------------------------------------

const summary = [];
const say = (line) => { console.log(line); summary.push(line); };
const warn = (line) => { console.warn(`warning: ${line}`); summary.push(`⚠ ${line}`); };
function fail(code, line) {
  console.error(`error: ${line}`);
  summary.push(`✗ ${line}`);
  flushSummary();
  process.exit(code);
}
function flushSummary() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.map((l) => l.replace(/^(✓|✗|⚠|·)/, '$1')).join('  \n') + '\n');
}

// ---- main ------------------------------------------------------------------------

async function main() {
  const runner = pickRunner();
  const files = listMigrations();
  if (!files.length) fail(2, `No NN_name.sql files in ${DIR}.`);

  await runner.exec(ENSURE_LEDGER, { transaction: true });
  const applied = new Map((await runner.rows(`select name, sha256, applied_at from ${LEDGER}`)).map((r) => [r.name, r]));
  const pending = files.filter((m) => !applied.has(m.name));
  const changed = files.filter((m) => applied.has(m.name) && applied.get(m.name).sha256 !== m.sha256);

  say(`${files.length} migration files in ${DIR}; ${applied.size} recorded as applied via ${runner.label}.`);
  for (const m of changed) warn(`${m.name} has changed since it was applied (${String(applied.get(m.name).applied_at).slice(0, 10)}). The database still has the old version; put the change in a new file.`);

  if (mode === 'status') {
    for (const m of files) {
      const a = applied.get(m.name);
      say(a ? `✓ ${m.name}  applied ${String(a.applied_at).slice(0, 10)}${a.sha256 !== m.sha256 ? '  (file changed since)' : ''}` : `· ${m.name}  pending`);
    }
    say(pending.length ? `${pending.length} pending.` : 'Nothing pending.');
    return flushSummary();
  }

  if (mode === 'baseline') {
    if (!pending.length) { say('Nothing to baseline: every file is already recorded.'); return flushSummary(); }
    await runner.exec(pending.map(record).join('\n'), { transaction: true });
    for (const m of pending) say(`✓ ${m.name}  recorded as applied (not run)`);
    say(`${pending.length} files recorded. From here on, only new files run.`);
    return flushSummary();
  }

  if (mode === 'mark') {
    const chosen = files.filter((m) => marks.includes(m.name));
    const unknown = marks.filter((n) => !files.some((m) => m.name === n));
    if (unknown.length) fail(2, `Not in ${DIR}: ${unknown.join(', ')}`);
    const todo = chosen.filter((m) => !applied.has(m.name));
    if (!todo.length) { say('Already recorded.'); return flushSummary(); }
    await runner.exec(todo.map(record).join('\n'), { transaction: true });
    for (const m of todo) say(`✓ ${m.name}  recorded as applied (not run)`);
    return flushSummary();
  }

  if (!pending.length) { say('Nothing pending. The database is up to date with the folder.'); return flushSummary(); }
  say(`${pending.length} pending: ${pending.map((m) => m.name).join(', ')}`);
  if (mode === 'dry-run') { say('Dry run: nothing applied.'); return flushSummary(); }

  for (const m of pending) {
    const transaction = !NO_TRANSACTION.test(m.sql);
    if (!transaction) warn(`${m.name} uses CONCURRENTLY or VACUUM, so it runs outside a transaction: a failure half way leaves whatever ran before it in place.`);
    const started = Date.now();
    try {
      const notices = await runner.exec(`${m.sql}\n\n${record(m)}\n`, { transaction });
      say(`✓ ${m.name}  applied in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      for (const n of notices) say(`    ${n}`);
    } catch (e) {
      say(`✗ ${m.name}  failed after ${((Date.now() - started) / 1000).toFixed(1)}s and was rolled back; nothing after it ran.`);
      fail(1, `${m.name}: ${e.message}`);
    }
  }
  say(`${pending.length} applied. Done.`);
  flushSummary();
}

main().catch((e) => fail(1, e.message));
