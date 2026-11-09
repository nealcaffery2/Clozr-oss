#!/usr/bin/env node
// Apply new migrations and deploy every edge function, from the Vercel build.
//
// Why this exists. GitHub Actions stopped starting runs on this repo (every
// run since 2026-10-22 is a startup_failure), so functions.yml and
// migrations.yml did nothing and merged work sat undeployed for days. Vercel
// builds every push to main regardless, so the production build does the same
// two steps before it builds the site:
//
//   1. node scripts/migrate.mjs   (pending migrations, in order, once)
//   2. supabase functions deploy  (every function, verify_jwt from config.toml)
//
// Runs only for the production build of main. Preview builds, and any build
// without SUPABASE_ACCESS_TOKEN in its environment, skip it. A failure fails
// the build, so the site stays on the last good deploy instead of going out
// ahead of a database or functions it needs.
//
// One build at a time, newest wins. Four merges a minute apart start four
// builds at once, and four deploys racing leave whichever finished last live,
// which can be an older commit. public.deploy_lock (migration 429) records the
// newest commit any build has seen and which build holds the turn: a build
// whose commit is older than the newest skips, and the newest waits for the
// build already deploying to finish. The turn is held per build
// (VERCEL_DEPLOYMENT_ID, in the holder_sha column), so a "Redeploy" of the
// same commit waits for the first build like any other. While a build holds
// the turn it refreshes locked_at every few minutes (HEARTBEAT_MS), so a
// long deploy is not mistaken for a dead one after STALE_MIN; the turn of a
// build that died goes stale STALE_MIN after its last heartbeat.
//
// Vercel → Project → Settings → Environment Variables (Production only):
//   SUPABASE_ACCESS_TOKEN  a personal access token from
//                          supabase.com/dashboard/account/tokens. Expires
//                          after 90 days; the build fails loudly when it has.
//   SUPABASE_PROJECT_REF   optional, default your-project-ref.
//
// When the GitHub workflows run again they deploy the same code a second
// time, which is harmless.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
// Same pin as functions.yml. `latest` is what got us rate limited.
const CLI = 'supabase@2.117.0';
const env = process.env;
const ref = env.SUPABASE_PROJECT_REF || 'your-project-ref';
const API = env.SUPABASE_API_URL || 'https://api.supabase.com';
// A turn not refreshed for this long belongs to a build that died mid-deploy.
const STALE_MIN = 20;
// How often the build holding the turn refreshes locked_at.
const HEARTBEAT_MS = 4 * 60_000;
const WAIT_MS = 25 * 60_000;

if (env.VERCEL_ENV !== 'production' || env.VERCEL_GIT_COMMIT_REF !== 'main') {
  console.log(`deploy-supabase: skipped (${env.VERCEL_ENV || 'not Vercel'}, ${env.VERCEL_GIT_COMMIT_REF || 'no branch'}); only the production build of main deploys.`);
  process.exit(0);
}
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.log('deploy-supabase: skipped, SUPABASE_ACCESS_TOKEN is not set in Vercel. Migrations and edge functions were NOT deployed.');
  process.exit(0);
}

// Async, not spawnSync: the heartbeat timer has to fire while a step runs.
const run = (cmd, args) => new Promise((done) => {
  const child = spawn(cmd, args, { cwd: APP, stdio: 'inherit', env });
  child.on('error', (e) => { console.error(`deploy-supabase: ${cmd} could not start (${e.message})`); done(false); });
  child.on('close', (code) => done(code === 0));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sql(query, tries = 3) {
  let res;
  try {
    res = await fetch(`${API}/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    // A kept-alive socket can go stale during the minutes-long deploy, and the
    // release after it is the call that must not be lost. Every query here is
    // safe to send twice.
    if (tries > 1) { await sleep(2_000); return sql(query, tries - 1); }
    throw e;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return []; }
}

const sha = env.VERCEL_GIT_COMMIT_SHA || '';
const git = spawnSync('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: APP, encoding: 'utf8' });
const committedAt = git.status === 0 ? git.stdout.trim() : '';
// Both go into SQL as literals, so they must look exactly like a sha and a date.
// Without them there is no telling which build is newer, so deploy as before,
// without a turn, rather than hold the site back.
const ordered = /^[0-9a-f]{40}$/.test(sha) && /^\d{4}-\d\d-\d\dT[\d:]+([+-]\d\d:\d\d|Z)$/.test(committedAt);
if (!ordered) console.warn(`deploy-supabase: can't tell this commit's sha or time (sha "${sha}", time "${committedAt}"); deploying without waiting for a turn.`);
// Who holds the turn: this build, not this commit, so a redeploy of the same
// sha is another holder. Also a SQL literal; a shape we don't expect falls
// back to the sha.
const holder = /^[A-Za-z0-9_-]{1,80}$/.test(env.VERCEL_DEPLOYMENT_ID || '') ? env.VERCEL_DEPLOYMENT_ID : sha;

/** Wait for this build's turn. False when a newer commit has a build of its own. */
async function takeTurn() {
  await sql(readFileSync(join(APP, 'supabase/migrations/429_deploy_lock.sql'), 'utf8'));
  await sql(`insert into public.deploy_lock (id, newest_sha, newest_commit_at) values (1, '${sha}', '${committedAt}')
    on conflict (id) do update set
      newest_sha = case when excluded.newest_commit_at > coalesce(deploy_lock.newest_commit_at, '-infinity') then excluded.newest_sha else deploy_lock.newest_sha end,
      newest_commit_at = greatest(deploy_lock.newest_commit_at, excluded.newest_commit_at)`);
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const got = await sql(`update public.deploy_lock set holder_sha = '${holder}', locked_at = now()
      where id = 1 and newest_sha = '${sha}'
        and (holder_sha is null or holder_sha = '${holder}' or locked_at < now() - interval '${STALE_MIN} minutes')
      returning 1 as ok`);
    if (got.length) return true;
    const [row] = await sql('select newest_sha, holder_sha from public.deploy_lock where id = 1');
    if (row?.newest_sha !== sha) {
      console.log(`deploy-supabase: skipped, newer commit ${row?.newest_sha?.slice(0, 7)} deploys migrations and functions instead.`);
      return false;
    }
    if (Date.now() > until) throw new Error(`waited ${WAIT_MS / 60_000} minutes for build ${row?.holder_sha?.slice(0, 7)} to finish deploying`);
    console.log(`deploy-supabase: waiting for build ${row?.holder_sha?.slice(0, 7)} to finish deploying`);
    await sleep(15_000);
  }
}

/** Keep locked_at fresh while this build deploys. Returns the stop function. */
function heartbeat() {
  const timer = setInterval(() => {
    sql(`update public.deploy_lock set locked_at = now() where id = 1 and holder_sha = '${holder}'`)
      .catch((e) => console.error(`deploy-supabase: could not refresh the turn (${e}); another build may take it after ${STALE_MIN} minutes.`));
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

const release = () => !ordered ? null : sql(`update public.deploy_lock set holder_sha = null where id = 1 and holder_sha = '${holder}'`).catch((e) => console.error(`deploy-supabase: could not release the turn (${e}); the next build waits ${STALE_MIN} minutes.`));

let ok = false;
let stopHeartbeat = () => {};
try {
  if (ordered && !(await takeTurn())) process.exit(0);
  if (ordered) stopHeartbeat = heartbeat();

  console.log('deploy-supabase: applying migrations');
  if (!(await run('node', ['scripts/migrate.mjs']))) throw new Error('a migration failed; functions and site not deployed.');

  // The bundler runs on Supabase's side and sometimes times out fetching a JSR
  // package ("Fetch 'https://jsr.io/...' timed out after 10s"). That is theirs,
  // not the code's, so one retry before failing the build.
  const deploy = ['-y', CLI, 'functions', 'deploy', '--project-ref', ref, '--use-api'];
  console.log('deploy-supabase: deploying edge functions');
  if (!(await run('npx', deploy))) {
    console.log('deploy-supabase: deploy failed, retrying once');
    if (!(await run('npx', deploy))) throw new Error('edge functions did not deploy; site not deployed.');
  }
  ok = true;
  console.log('deploy-supabase: done');
} catch (e) {
  console.error(`deploy-supabase: ${e instanceof Error ? e.message : e}`);
} finally {
  stopHeartbeat();
  await release();
}
process.exit(ok ? 0 : 1);
