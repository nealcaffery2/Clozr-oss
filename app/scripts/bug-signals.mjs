#!/usr/bin/env node
// Nightly bug signals: read what broke in the last day and file it as GitHub
// issues labeled `bug`, so the scheduled bug sweep (.claude/skills/bug-sweep)
// finds it next to the bugs people report.
//
// Sources:
//   browser crashes and errors   public.client_errors (lib/client-errors.ts)
//   edge function 5xx responses  function_edge_logs
//   edge function error lines    function_logs, level = error
//   failed scheduled jobs        cron.job_run_details
//   failed workflows on main     GitHub Actions (CI, migrations, function deploy)
//   failed Vercel deploy of main commit statuses and check runs on main
//
// Each problem gets a fingerprint hidden in its issue body. An open issue with
// the same fingerprint gets a "still happening" comment instead of a new
// issue. One closed as not planned stays quiet. One closed as fixed that
// happens again gets a new issue pointing at the old one.
//
//   node scripts/bug-signals.mjs            file and comment
//   DRY_RUN=1 node scripts/bug-signals.mjs  print what it would file
//
// Env: SUPABASE_ACCESS_TOKEN (Management API: SQL and logs), SUPABASE_PROJECT_REF
// (optional, default your-project-ref), GITHUB_TOKEN, GITHUB_REPOSITORY
// (owner/repo), HOURS (window, default 24, max 24 for logs), MAX_NEW (new
// issues per run, default 8).
//
// A source that fails (expired token, API change) is reported in the summary
// and the run exits 1 after filing everything else, so a dead source is loud.

import { appendFileSync } from 'node:fs';
import {
  clientSignals, cronSignals, decide, deploySignal, function5xxSignals, functionErrorSignals,
  issueBody, issueTitle, sortSignals, stillHappeningComment, workflowSignal,
} from './bug-signals-lib.mjs';

const DEFAULT_REF = 'your-project-ref';
const API = process.env.SUPABASE_API_URL || 'https://api.supabase.com';
const GH = process.env.GITHUB_API_URL || 'https://api.github.com';
const HOURS = Math.min(24, Math.max(1, Number(process.env.HOURS) || 24));
const MAX_NEW = Math.max(0, Number(process.env.MAX_NEW ?? 8));
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const REPO = process.env.GITHUB_REPOSITORY || 'nealcaffery2/clozr';
const SELF = '.github/workflows/bug-signals.yml';
const LABELS = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'bug-signal', color: 'f9d0c4', description: 'Filed from production errors by the nightly bug-signals job' },
];

const end = new Date();
const start = new Date(end.getTime() - HOURS * 3600_000);
const summary = [];
const problems = [];
const say = (line) => { console.log(line); summary.push(line); };

// ---- Supabase ---------------------------------------------------------------------

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = ((process.env.SUPABASE_PROJECT_REF || '').match(/(?:^|[^a-z])([a-z]{20})(?:[^a-z]|$)/) || [])[1] || DEFAULT_REF;

async function supa(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch { /* keep the body */ }
    throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}: ${String(msg).slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

const sql = async (query) => {
  const out = await supa(`/v1/projects/${ref}/database/query`, { method: 'POST', body: JSON.stringify({ query }) });
  return Array.isArray(out) ? out : [];
};

async function logs(query) {
  const qs = new URLSearchParams({ sql: query, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() });
  const out = await supa(`/v1/projects/${ref}/analytics/endpoints/logs.all?${qs}`);
  if (out?.error) throw new Error(`logs query: ${typeof out.error === 'string' ? out.error : JSON.stringify(out.error).slice(0, 300)}`);
  return Array.isArray(out?.result) ? out.result : [];
}

/** Log timestamps come back as microseconds since the epoch. */
const logTime = (t) => {
  if (t == null) return null;
  const n = Number(t);
  if (Number.isFinite(n)) return new Date(n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000).toISOString();
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function browserErrors() {
  const rows = await sql(`
    select kind, where_at, message, left(stack, 3000) as stack, left(component_stack, 2000) as component_stack,
           path, user_agent, user_id, created_at
    from public.client_errors
    where created_at > now() - interval '${HOURS} hours'
    order by created_at desc
    limit 1500`);
  return clientSignals(rows);
}

async function functionNames() {
  const list = await supa(`/v1/projects/${ref}/functions`);
  return new Map((Array.isArray(list) ? list : []).map((f) => [f.id, f.slug || f.name]));
}

async function functionErrors() {
  const names = await functionNames();
  const rows = await logs(`
    select m.function_id as fn, event_message as msg, count(*) as n, max(function_logs.timestamp) as last
    from function_logs cross join unnest(metadata) as m
    where m.level = 'error'
    group by fn, msg
    order by n desc
    limit 500`);
  return functionErrorSignals(rows.map((r) => ({ fn: names.get(r.fn) || r.fn || 'unknown function', msg: r.msg, n: r.n, last: logTime(r.last) })));
}

async function function5xx() {
  const rows = await logs(`
    select request.pathname as path, response.status_code as status, count(*) as n, max(function_edge_logs.timestamp) as last
    from function_edge_logs
      cross join unnest(metadata) as m
      cross join unnest(m.response) as response
      cross join unnest(m.request) as request
    where response.status_code >= 500
    group by path, status
    order by n desc
    limit 200`);
  return function5xxSignals(rows.map((r) => ({
    fn: (String(r.path || '').match(/\/functions\/v1\/([^/?]+)/) || [])[1] || String(r.path || 'unknown'),
    status: r.status, n: r.n, last: logTime(r.last),
  })));
}

async function cronFailures() {
  const rows = await sql(`
    select j.jobname as job, left(d.return_message, 1500) as msg, count(*) as n, max(d.start_time) as last
    from cron.job_run_details d join cron.job j using (jobid)
    where d.status = 'failed' and d.start_time > now() - interval '${HOURS} hours'
    group by 1, 2
    order by n desc
    limit 50`);
  return cronSignals(rows);
}

// ---- GitHub -----------------------------------------------------------------------

const ghToken = process.env.GITHUB_TOKEN;

async function gh(path, init = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${init.method || 'GET'} ${path.split('?')[0]}: ${data?.message ?? text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function failedWorkflows() {
  const since = new Date(end.getTime() - 3 * 24 * 3600_000).toISOString();
  const { workflow_runs: runs = [] } = await gh(`/repos/${REPO}/actions/runs?branch=main&status=completed&per_page=100&created=%3E%3D${since}`);
  const latest = new Map();
  for (const r of runs) {
    if (r.path === SELF || r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
    const prev = latest.get(r.workflow_id);
    if (!prev || r.created_at > prev.created_at) latest.set(r.workflow_id, r);
  }
  return [...latest.values()].filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out').map(workflowSignal);
}

async function failedDeploys() {
  const out = [];
  const status = await gh(`/repos/${REPO}/commits/main/status`);
  for (const s of status.statuses ?? []) {
    if (/vercel/i.test(s.context) && (s.state === 'failure' || s.state === 'error')) {
      out.push(deploySignal({ context: s.context, description: s.description, url: s.target_url, sha: status.sha }));
    }
  }
  const checks = await gh(`/repos/${REPO}/commits/main/check-runs?per_page=100`);
  for (const c of checks.check_runs ?? []) {
    if (c.app?.slug === 'vercel' && c.conclusion === 'failure') {
      out.push(deploySignal({ context: c.name, description: c.output?.title, url: c.details_url || c.html_url, sha: c.head_sha }));
    }
  }
  return out;
}

async function signalIssues() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/repos/${REPO}/issues?labels=bug-signal&state=all&per_page=100&page=${page}`);
    all.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return all;
}

async function ensureLabels() {
  for (const label of LABELS) {
    try { await gh(`/repos/${REPO}/labels`, { method: 'POST', body: JSON.stringify(label) }); } catch (e) { if (e.status !== 422) throw e; }
  }
}

// ---- run --------------------------------------------------------------------------

async function collect(name, needs, fn) {
  if (needs === 'supabase' && !token) { problems.push(`${name}: SUPABASE_ACCESS_TOKEN is not set`); return []; }
  if (needs === 'github' && !ghToken) { problems.push(`${name}: GITHUB_TOKEN is not set`); return []; }
  try {
    const found = await fn();
    say(`- ${name}: ${found.length} signal${found.length === 1 ? '' : 's'}`);
    return found;
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    say(`- ${name}: **failed**, ${e.message}`);
    return [];
  }
}

say(`### Bug signals · last ${HOURS} hours${DRY ? ' · dry run' : ''}`);
say('');
const signals = sortSignals([
  ...await collect('Failed workflows on main', 'github', failedWorkflows),
  ...await collect('Vercel deploy of main', 'github', failedDeploys),
  ...await collect('Failed scheduled jobs', 'supabase', cronFailures),
  ...await collect('Edge function 5xx', 'supabase', function5xx),
  ...await collect('Browser crashes and errors', 'supabase', browserErrors),
  ...await collect('Edge function error logs', 'supabase', functionErrors),
]);
say('');

let issues = [];
if (ghToken) {
  try { issues = await signalIssues(); } catch (e) { problems.push(`Reading bug-signal issues: ${e.message}`); }
}
if (!DRY && ghToken && signals.length) {
  try { await ensureLabels(); } catch (e) { problems.push(`Creating labels: ${e.message}`); }
}

let created = 0;
for (const s of signals) {
  const d = decide(s, issues);
  const title = issueTitle(s);
  try {
    if (d.action === 'skip') {
      say(`- skip: ${title} (#${d.issue.number} closed${d.issue.state_reason ? ` as ${d.issue.state_reason}` : ''})`);
    } else if (d.action === 'comment') {
      if (!DRY) await gh(`/repos/${REPO}/issues/${d.issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: stillHappeningComment(s, HOURS) }) });
      say(`- still happening: #${d.issue.number} ${title} (${s.count})`);
    } else if (created >= MAX_NEW) {
      say(`- held for the next run (cap of ${MAX_NEW} new issues): ${title}`);
    } else {
      const body = issueBody(s, { hours: HOURS, cameBackFrom: d.action === 'reopen-new' ? d.issue.number : null });
      created++;
      if (DRY) {
        say(`- would file: ${title}`);
        console.log(`\n${body}\n`);
      } else {
        const issue = await gh(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: LABELS.map((l) => l.name) }) });
        issues.push(issue);
        say(`- filed: #${issue.number} ${title}`);
      }
    }
  } catch (e) {
    problems.push(`${title}: ${e.message}`);
    say(`- **failed** on ${title}: ${e.message}`);
  }
}
if (!signals.length && !problems.length) say('Nothing new broke.');

if (problems.length) {
  say('');
  say('**Sources that failed**');
  for (const p of problems) say(`- ${p}`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
if (problems.length) {
  for (const p of problems) console.log(`::error title=Bug signals source failed::${p.replace(/\n/g, ' ')}`);
  process.exit(1);
}
