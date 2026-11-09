// Nothing writes an app link in an old form. The operator app's address is a
// path (`/app/people/s42`, lib/routes.ts); the `#screen=` hash, the webhook
// query (`/app?seller=N`) and the dead `/clozr/` and `/docs/?contract=` links
// are only read, by parseLegacy and the hosting redirects, so old emails,
// calendar events and bookmarks keep working.
//
// Allowed: the codec that reads the old forms (lib/routes.ts, lib/nav-hash.ts,
// lib/shell-history.ts), tests (their legacy inputs are on purpose),
// migrations older than webhook_record_paths, and comments in code and SQL.
// Run: npx tsx tools/no-hash-links.test.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The old link forms, each with why it is wrong now. */
const OLD_FORMS: { re: RegExp; why: string }[] = [
  { re: /#screen=/, why: 'a #screen= hash; write the path (lib/routes.ts pathFor, or _shared/app-paths.ts in a function)' },
  { re: /\bencodeNavHash\(/, why: 'encodeNavHash builds a #screen= hash; write the path' },
  { re: /URLSearchParams\(\{\s*screen\b/, why: 'a screen= query built by hand; write the path' },
  { re: /\/app\/?\?(?:seller|deal|buyer)=/, why: 'the old webhook query; write /app/people/sN, /app/deals/dN, /app/buyers/bN' },
  { re: /\$\{[^}]*\}\/clozr\b/, why: 'the dead /clozr/ link; write the record or /app/calendar' },
  { re: /\/docs\/?\?contract=/, why: 'the dead /docs/?contract= link; write /app/contracts/kN' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.vinext', 'out', '.git']);
const EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|html|md)$/;
/** Files that read the old forms: the codec, and the guard that forwards `/#screen=` to /app. */
const READERS = new Set(['lib/routes.ts', 'lib/nav-hash.ts', 'lib/shell-history.ts']);
const isTest = (rel: string) => /\.test\.tsx?$/.test(rel) || /\.e2e\.mjs$/.test(rel);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const MIGRATIONS = 'supabase/migrations/';
const migNo = (rel: string) => Number(rel.slice(MIGRATIONS.length).match(/^(\d+)_/)?.[1] ?? NaN);
const files = walk(APP).map((p) => relative(APP, p).split('\\').join('/'));
const pathsMigration = files.find((f) => f.startsWith(MIGRATIONS) && /^\d+_webhook_record_paths\.sql$/.test(f.slice(MIGRATIONS.length)));
assert.ok(pathsMigration, 'the webhook_record_paths migration is where old migrations end');
const firstNew = migNo(pathsMigration!);

/** A line that is only a comment: `//`, ` * `, `/*` in code, `--` in SQL. */
function isComment(rel: string, line: string): boolean {
  const t = line.trim();
  if (rel.endsWith('.sql')) return t.startsWith('--');
  if (/\.(?:md|json|html)$/.test(rel)) return false;
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const found: string[] = [];
let scanned = 0;
for (const rel of files) {
  if (READERS.has(rel) || isTest(rel)) continue;
  if (rel.startsWith(MIGRATIONS) && rel.endsWith('.sql') && !(migNo(rel) >= firstNew)) continue;
  scanned++;
  const lines = readFileSync(join(APP, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isComment(rel, line)) return;
    for (const f of OLD_FORMS) if (f.re.test(line)) found.push(`${rel}:${i + 1}  ${f.why}\n    ${line.trim().slice(0, 160)}`);
  });
}

// The check itself sees each form: one line per form, as code.
for (const f of OLD_FORMS) {
  const sample = { '#screen=': "const u = '/app#screen=person&id=s1';", encodeNavHash: 'x = encodeNavHash(nav);', URLSearchParams: "new URLSearchParams({ screen: 'tc' })", query: "'/app?deal=' + id", clozr: '`${origin}/clozr/`', docs: '`${o}/docs/?contract=${id}`' };
  assert.ok(Object.values(sample).some((s) => f.re.test(s) && !isComment('x.ts', s)), `the pattern for "${f.why}" matches its own sample`);
}
assert.ok(isComment('x.ts', '  // An old #screen= link'), 'a code comment is skipped');
assert.ok(isComment('x.sql', "  -- it said '/app?seller=N'"), 'a SQL comment is skipped');
assert.ok(!isComment('x.md', '- `/app#screen=person`'), 'docs are read in full');
assert.ok(scanned > 500, `scanned ${scanned} files`);

if (found.length) {
  console.error(`An app link is written in an old form (${found.length}):\n${found.join('\n')}`);
  process.exit(1);
}
console.log(`no-hash-links: ${scanned} files, no old app links written`);
