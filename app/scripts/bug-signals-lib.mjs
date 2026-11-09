// Pure helpers for scripts/bug-signals.mjs: turn raw error rows into grouped
// signals and the issue text that reports them. No I/O here, so
// tools/bug-signals.test.ts can run all of it.

import { createHash } from 'node:crypto';

/**
 * Emails, phone-like digit runs and credentials out of anything that lands in
 * an issue. Browser stacks carry URLs: a listing's ?t=, email-track and
 * calendar-feed ?token=, an OAuth #access_token= fragment, so those query
 * values go, and so does any 32+ character hex or base64url run with a digit
 * in it (a token, a key, a JWT segment) wherever it sits.
 */
export function mask(text) {
  return String(text ?? '')
    .replace(/([?&#](?:token|t|access_token|refresh_token|key|secret|code)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9_-]{32,}={0,2}/g, (run) => (/\d/.test(run) ? '<secret>' : run))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '<phone>');
}

/**
 * One line that is the same for every occurrence of the same error: newlines
 * folded, ids and numbers collapsed, masked, capped. "tx: 90" and "tx: 4"
 * group together; so do two "Stale request cancelled (id=…)" rejections.
 */
export function normalizeMessage(message) {
  return mask(String(message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<id>'))
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * The app's path slugs and the screen each names, a copy of lib/routes.ts
 * (this file runs under plain node, so it cannot import the TypeScript).
 * tools/bug-signals.test.ts checks every path lib/routes.ts writes reads back
 * to its screen here.
 */
const PATH_SCREENS = {
  home: 'home', today: 'today', people: 'people', import: 'import', database: 'liveLists', inbox: 'inbox',
  dialer: 'dialer', tasks: 'tasks', calendar: 'calendar', plans: 'plans', automations: 'automations',
  deals: 'deals', contracts: 'contracts', dispo: 'dispo', buyers: 'buyers', campaigns: 'campaigns',
  'deal-machine': 'dealMachine', reporting: 'reporting', leaderboard: 'leaderboard', coaching: 'coaching',
  settings: 'settings', account: 'account',
};
const PERSON_SUB = { 'deal-sheet': 'dealSheet', tc: 'tc', dispo: 'dispoProperty' };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The screen an app path names (`/app/people/s42` → "person"), or null when it names none. */
function pathScreen(pathname) {
  const m = pathname.match(/^\/(?:app|demo)\/(.+?)\/?$/);
  if (!m) return null;
  const [a, b, c] = m[1].split('/');
  if (a === 'people' && b) return c ? (own(PERSON_SUB, c) ? PERSON_SUB[c] : 'person') : /^v\d+$/.test(b) ? 'vendor' : 'person';
  if (a === 'deals' && b) return c === 'tc' ? 'tc' : 'dealSheet';
  if (a === 'dispo' && b) return 'dispoProperty';
  if (a === 'buyers' && b) return 'buyer';
  if (a === 'settings' && b === 'you' && c === 'account') return 'account';
  return own(PATH_SCREENS, a) ? PATH_SCREENS[a] : null;
}

/**
 * The screen name without record ids, so one screen groups: "/app/people/s42"
 * → "person". Rows written before the app moved to paths carry the hash
 * ("/app#screen=dealSheet&id=s26180" → "dealSheet"); anything else is its path.
 */
export function screenOf(path) {
  const p = String(path ?? '');
  const m = p.match(/[#?&]screen=([^&]+)/);
  if (m) return m[1];
  const bare = p.split(/[?#]/)[0];
  return pathScreen(bare) ?? (bare || null);
}

/** "iPhone · Safari", "Computer (Mac) · Chrome". */
export function deviceOf(userAgent) {
  const ua = String(userAgent ?? '');
  const device =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
          : /Macintosh/.test(ua) ? 'Computer (Mac)'
            : /Windows/.test(ua) ? 'Computer (Windows)'
              : /Linux|CrOS/.test(ua) ? 'Computer (Linux/Chromebook)'
                : 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /CriOS|Chrome\//.test(ua) ? 'Chrome'
          : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari'
              : 'Unknown browser';
  return `${device} · ${browser}`;
}

export const fingerprint = (...parts) =>
  createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);

export const marker = (fp) => `<!-- bug-signal:${fp} -->`;
export const markerOf = (body) => (String(body ?? '').match(/<!-- bug-signal:([0-9a-f]{12}) -->/) || [])[1] ?? null;

/** Lower sorts first. */
const SEVERITY = { workflow: 0, deploy: 0, cron: 1, function_5xx: 2, screen_crash: 3, function_error: 4, browser_error: 5 };

const tally = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const top = (map, n = 5) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const minIso = (a, b) => (!a || (b && b < a) ? b : a);
const maxIso = (a, b) => (!a || (b && b > a) ? b : a);
const iso = (t) => (t == null ? null : new Date(t).toISOString());

/**
 * Browser errors (public.client_errors rows: kind, where_at, message, stack,
 * component_stack, path, user_agent, user_id, created_at) grouped into
 * signals. A crash card ('screen' / 'app') counts on its first occurrence; a
 * stray window error or unhandled rejection needs 3 hits or 2 people.
 */
export function clientSignals(rows) {
  const groups = new Map();
  for (const r of rows) {
    const crash = r.kind === 'screen' || r.kind === 'app';
    const msg = normalizeMessage(r.message);
    const where = r.where_at || screenOf(r.path) || 'unknown screen';
    const key = `${crash ? 'crash' : 'error'}|${where}|${msg}`;
    let g = groups.get(key);
    if (!g) {
      g = { crash, where, msg, count: 0, users: new Set(), devices: new Map(), screens: new Map(), first: null, last: null, sample: r };
      groups.set(key, g);
    }
    g.count++;
    if (r.user_id) g.users.add(r.user_id);
    tally(g.devices, deviceOf(r.user_agent));
    tally(g.screens, screenOf(r.path) ?? 'unknown');
    g.first = minIso(g.first, iso(r.created_at));
    g.last = maxIso(g.last, iso(r.created_at));
  }
  const out = [];
  for (const g of groups.values()) {
    if (!g.crash && g.count < 3 && g.users.size < 2) continue;
    const s = g.sample;
    const stack = [mask(s.stack ?? ''), s.component_stack ? `Component stack:\n${mask(s.component_stack)}` : '']
      .filter(Boolean).join('\n').split('\n').slice(0, 14).join('\n');
    out.push({
      kind: g.crash ? 'screen_crash' : 'browser_error',
      fp: fingerprint('client', g.crash ? 'crash' : 'error', g.where, g.msg),
      title: `${g.crash ? 'Screen crash' : 'Browser error'} on ${g.where}: ${g.msg}`,
      count: g.count,
      people: g.users.size,
      first: g.first,
      last: g.last,
      facts: [
        ['Where', `\`${g.where}\``],
        ['Devices', top(g.devices).map(([d, n]) => `${d} (${n})`).join(', ')],
        ['Screens', top(g.screens, 3).map(([p, n]) => `\`${p}\` (${n})`).join(', ')],
        ['Kind', g.crash ? 'crash card shown to the user' : `${s.kind} (uncaught in the browser)`],
      ],
      detail: stack ? { label: 'Stack (first occurrence)', text: stack } : null,
      look: `select created_at, kind, where_at, message, path, user_agent, stack\nfrom client_errors\nwhere created_at > now() - interval '7 days' and message ilike '%${sqlLike(g.msg)}%'\norder by created_at desc limit 20;`,
    });
  }
  return out;
}

const sqlLike = (msg) => msg.split(/<id>|<email>|<phone>|<redacted>|<secret>|N/)[0].trim().slice(0, 60).replace(/'/g, "''").replace(/[%_]/g, '');

/**
 * Edge function error log lines ({ fn, msg, n, last }) grouped after
 * normalizing. 5 or more a day counts.
 */
export function functionErrorSignals(rows, min = 5) {
  const groups = new Map();
  for (const r of rows) {
    const msg = normalizeMessage(r.msg);
    const key = `${r.fn}|${msg}`;
    const g = groups.get(key) ?? { fn: r.fn, msg, count: 0, last: null, sample: r.msg };
    g.count += Number(r.n) || 0;
    g.last = maxIso(g.last, iso(r.last));
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.count >= min).map((g) => ({
    kind: 'function_error',
    fp: fingerprint('fnlog', g.fn, g.msg),
    title: `${g.fn} logs an error: ${g.msg}`,
    count: g.count,
    people: null,
    first: null,
    last: g.last,
    facts: [['Function', `\`${g.fn}\` (\`app/supabase/functions/${g.fn}\`)`]],
    detail: { label: 'Log line (one occurrence)', text: mask(g.sample).slice(0, 1500) },
    look: `Supabase dashboard → Edge Functions → ${g.fn} → Logs, filter level = error.`,
  }));
}

/** 5xx responses per function ({ fn, status, n, last }). 3 or more counts. */
export function function5xxSignals(rows, min = 3) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.fn) ?? { fn: r.fn, count: 0, statuses: new Map(), last: null };
    g.count += Number(r.n) || 0;
    tally(g.statuses, String(r.status), Number(r.n) || 0);
    g.last = maxIso(g.last, iso(r.last));
    groups.set(r.fn, g);
  }
  return [...groups.values()].filter((g) => g.count >= min).map((g) => ({
    kind: 'function_5xx',
    fp: fingerprint('fn5xx', g.fn),
    title: `${g.fn} is failing requests (5xx)`,
    count: g.count,
    people: null,
    first: null,
    last: g.last,
    facts: [
      ['Function', `\`${g.fn}\` (\`app/supabase/functions/${g.fn}\`)`],
      ['Status codes', top(g.statuses).map(([s, n]) => `${s} (${n})${STATUS_HINT[s] ? `: ${STATUS_HINT[s]}` : ''}`).join(', ')],
    ],
    detail: null,
    look: `Supabase dashboard → Edge Functions → ${g.fn} → Invocations, filter status ≥ 500; then Logs around the same times.`,
  }));
}

const STATUS_HINT = {
  500: 'the function threw',
  502: 'bad gateway',
  503: 'function unavailable or boot error',
  504: 'timed out',
  546: 'killed for CPU time or memory',
};

/** Failed pg_cron runs ({ job, msg, n, last }). Any failure counts. */
export function cronSignals(rows) {
  return rows.map((r) => {
    const msg = normalizeMessage(r.msg) || 'failed';
    return {
      kind: 'cron',
      fp: fingerprint('cron', r.job, msg),
      title: `Scheduled job ${r.job} is failing: ${msg}`,
      count: Number(r.n) || 0,
      people: null,
      first: null,
      last: iso(r.last),
      facts: [['Job', `\`${r.job}\` (pg_cron)`]],
      detail: { label: 'Error', text: mask(r.msg ?? '').slice(0, 1500) },
      look: `select start_time, status, return_message from cron.job_run_details d join cron.job j using (jobid)\nwhere j.jobname = '${String(r.job).replace(/'/g, "''")}' order by start_time desc limit 20;`,
    };
  });
}

/** A GitHub Actions workflow whose latest run on main failed. */
export function workflowSignal(run) {
  return {
    kind: 'workflow',
    fp: fingerprint('workflow', run.name),
    title: `"${run.name}" is failing on main`,
    count: 1,
    people: null,
    first: null,
    last: iso(run.created_at),
    facts: [['Run', `[${run.name} #${run.run_number}](${run.html_url}) on \`${String(run.head_sha).slice(0, 7)}\``]],
    detail: null,
    look: `Open the run above and read the failed step's log.`,
  };
}

/** A Vercel deployment of main that failed. */
export function deploySignal({ context, description, url, sha }) {
  return {
    kind: 'deploy',
    fp: fingerprint('deploy', context),
    title: `Vercel deploy of main failed (${context})`,
    count: 1,
    people: null,
    first: null,
    last: null,
    facts: [
      ['Commit', `\`${String(sha).slice(0, 7)}\``],
      ['Vercel says', mask(description || 'failed')],
      ...(url ? [['Build log', url]] : []),
    ],
    detail: null,
    look: 'Open the build log above. `pnpm build` from `app/` reproduces most failures.',
  };
}

export function sortSignals(signals) {
  return [...signals].sort((a, b) => (SEVERITY[a.kind] - SEVERITY[b.kind]) || (b.count - a.count));
}

const when = (t) => (t ? t.replace('T', ' ').slice(0, 16) + ' UTC' : null);

/** GitHub caps titles at 256; keep them readable well before that. */
export function issueTitle(signal) {
  const t = signal.title.replace(/\s+/g, ' ').trim();
  return t.length > 110 ? `${t.slice(0, 107)}...` : t;
}

/** opts: { hours, cameBackFrom? }, where cameBackFrom is the closed issue it recurred after. */
export function issueBody(signal, opts) {
  const { hours, cameBackFrom } = opts;
  const seen = [
    `${signal.count} time${signal.count === 1 ? '' : 's'} in the last ${hours} hours`,
    signal.people != null ? `${signal.people} ${signal.people === 1 ? 'person' : 'people'}` : null,
    signal.first ? `first ${when(signal.first)}` : null,
    signal.last ? `last ${when(signal.last)}` : null,
  ].filter(Boolean).join(' · ');
  const lines = [
    marker(signal.fp),
    cameBackFrom ? `This came back after #${cameBackFrom} was closed.\n` : null,
    seen,
    '',
    ...signal.facts.map(([k, v]) => `- ${k}: ${v}`),
  ];
  if (signal.detail) lines.push('', `#### ${signal.detail.label}`, '', '```', signal.detail.text.replace(/```/g, "'''"), '```');
  lines.push('', '#### Look closer', '', signal.look.includes('\n') || signal.look.startsWith('select') ? `\`\`\`sql\n${signal.look}\n\`\`\`` : signal.look);
  lines.push('', '_Filed by the nightly bug-signals job (`.github/workflows/bug-signals.yml`). The bug sweep picks it up next. Close it as "not planned" to stop hearing about it._');
  return lines.filter((l) => l !== null).join('\n');
}

export function stillHappeningComment(signal, hours) {
  return [
    `Still happening: ${signal.count} in the last ${hours} hours${signal.people ? `, ${signal.people} ${signal.people === 1 ? 'person' : 'people'}` : ''}${signal.last ? `, last ${when(signal.last)}` : ''}.`,
  ].join('\n');
}

/**
 * What to do with a signal given the bug-signal issues already on GitHub
 * (each { number, state, state_reason, closed_at, body }):
 *   { action: 'comment', issue }   an open issue tracks it
 *   { action: 'skip', issue }      closed as not planned, or closed after the last occurrence
 *   { action: 'reopen-new', issue } closed as fixed, and it happened again after that
 *   { action: 'create' }
 */
export function decide(signal, issues) {
  const mine = issues.filter((i) => markerOf(i.body) === signal.fp).sort((a, b) => b.number - a.number);
  const open = mine.find((i) => i.state === 'open');
  if (open) return { action: 'comment', issue: open };
  const last = mine[0];
  if (!last) return { action: 'create' };
  if (last.state_reason === 'not_planned' || last.state_reason === 'duplicate') return { action: 'skip', issue: last };
  if (signal.last && last.closed_at && signal.last > new Date(last.closed_at).toISOString()) return { action: 'reopen-new', issue: last };
  if (!signal.last && (signal.kind === 'workflow' || signal.kind === 'deploy')) return { action: 'reopen-new', issue: last };
  return { action: 'skip', issue: last };
}
