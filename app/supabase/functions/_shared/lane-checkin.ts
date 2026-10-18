// Lane's morning check-in and fire alarms, the pure half (lane-checkin runs
// it; tools/lane-checkin.test.ts tests it). Which TC checklist lines are past
// their day or due today, what got done since yesterday, and the note Lane
// writes when the model is not available: same day rules as lib/lane.ts
// laneDrive (D-marks count from the contract date, T-marks back from close).
//
// Lane assists the TC; it does not micromanage her. So:
//  * only files on live deals count (LIVE_STAGES, not archived, not closed),
//  * a late line someone else owns (title, seller, buyer, dispo,
//    acquisitions) is "waiting on them", never her miss, and never pings her,
//  * the 9am read of her emails, texts and calls marks a late line of hers
//    as waiting on someone or already done, and those are not pinged either.

export type CkTask = { id: string; t: string; day: string; owner: string; critical: boolean };
export type CkTemplate = { phases: { tasks: CkTask[] }[] };
export type CkFile = {
  id: number; address: string; seller: string;
  contract_date: string | null; close_date: string | null;
  checklist: Record<string, unknown> | null;
};
export type FileState = {
  id: number; address: string; seller: string;
  dayMarker: string; daysToClose: number | null;
  /** The TC's own lines past their day. */
  overdue: CkTask[];
  /** Lines past their day that someone else owns: waiting on them, not on her. */
  waitingOn: CkTask[];
  dueToday: CkTask[];
  doneIds: string[];
};

/** Deal stages a TC file is live in (the same set the team stoplight uses, migration 260). */
export const LIVE_STAGES = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow'] as const;

/** A file counts only while its deal is in the pipeline: not archived, closed or terminated, in a live stage. */
export function isLiveDeal(d: { stage?: string | null; archived_at?: string | null; closed_on?: string | null; terminated?: boolean | null } | null | undefined): boolean {
  return !!d && !d.archived_at && !d.closed_on && !d.terminated && (LIVE_STAGES as readonly string[]).includes(String(d.stage ?? ''));
}

/** Lines the TC owns herself; the rest are other people's. */
export const tcOwns = (t: CkTask) => !t.owner || t.owner === 'TC';

const DAY = 86_400_000;
const dateOnly = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) : null);

/** today: the local calendar day as YYYY-MM-DD. */
export function fileState(f: CkFile, template: CkTemplate | null, today: string): FileState {
  const t0 = dateOnly(today)!;
  const d0 = dateOnly(f.contract_date);
  const close = dateOnly(f.close_date);
  const dayN = d0 === null ? null : Math.round((t0 - d0) / DAY);
  const daysToClose = close === null ? null : Math.round((close - t0) / DAY);
  const ticks = f.checklist && typeof f.checklist === 'object' ? f.checklist : {};
  const done = (id: string) => !!(ticks as Record<string, unknown>)[id];
  const tasks = template ? template.phases.flatMap((p) => p.tasks) : [];

  let dayMarker = '—';
  if (daysToClose !== null && daysToClose <= 0) dayMarker = daysToClose === 0 ? 'CLOSE' : `+${-daysToClose}`;
  else if (daysToClose !== null && daysToClose <= 5) dayMarker = `T-${daysToClose}`;
  else if (dayN !== null) dayMarker = `D${Math.max(0, dayN)}`;

  const due = (t: CkTask, when: 'overdue' | 'today'): boolean => {
    const day = t.day.trim();
    let m = /^D(\d+)/.exec(day);
    if (m) { if (dayN === null) return false; const n = Number(m[1]); return when === 'today' ? dayN === n : dayN > n; }
    m = /^T-(\d+)/.exec(day);
    if (m) { if (daysToClose === null) return false; const n = Number(m[1]); return when === 'today' ? daysToClose === n : daysToClose < n; }
    if (/^CLOSE/i.test(day)) { if (daysToClose === null) return false; return when === 'today' ? daysToClose === 0 : daysToClose < 0; }
    m = /^\+(\d+)/.exec(day);
    if (m) { if (daysToClose === null) return false; const n = Number(m[1]); return when === 'today' ? -daysToClose === n : -daysToClose > n; }
    return false;
  };
  const late = tasks.filter((t) => !done(t.id) && due(t, 'overdue'));
  return {
    id: f.id, address: f.address, seller: f.seller, dayMarker, daysToClose,
    overdue: late.filter(tcOwns),
    waitingOn: late.filter((t) => !tcOwns(t)),
    dueToday: tasks.filter((t) => !done(t.id) && tcOwns(t) && due(t, 'today')),
    doneIds: tasks.filter((t) => done(t.id)).map((t) => t.id),
  };
}

/** Lines ticked since the last check-in's snapshot (file id → ticked ids). */
export function winsSince(files: FileState[], before: Record<string, string[]> | null, template: (f: FileState) => CkTemplate | null): { address: string; task: string }[] {
  if (!before) return [];
  const out: { address: string; task: string }[] = [];
  for (const f of files) {
    const had = new Set(before[String(f.id)] ?? []);
    if (!before[String(f.id)]) continue;
    const tasks = template(f)?.phases.flatMap((p) => p.tasks) ?? [];
    for (const id of f.doneIds) if (!had.has(id)) out.push({ address: f.address, task: tasks.find((t) => t.id === id)?.t ?? id });
  }
  return out;
}

export const snapshotOf = (files: FileState[]): Record<string, string[]> => Object.fromEntries(files.map((f) => [String(f.id), f.doneIds]));

/** What the 9am read made of a late line: waiting on someone, looks done, or hers to do. */
export type Verdict = { key: string; verdict: 'waiting' | 'looks_done' | 'needs_tc'; why: string };

/**
 * Her critical lines past their day, as ping keys ("<file id>:<line id>").
 * `quiet` is the keys today's read found waiting on someone or already done.
 */
export const fireKeys = (files: FileState[], quiet: ReadonlySet<string> = new Set()) =>
  files.flatMap((f) => f.overdue.filter((t) => t.critical).map((t) => ({ key: `${f.id}:${t.id}`, file: f, task: t })))
    .filter((x) => !quiet.has(x.key));

/** The keys a day's verdicts say not to ping. */
export const quietKeys = (verdicts: readonly Verdict[] | null | undefined) =>
  new Set((verdicts ?? []).filter((v) => v.verdict !== 'needs_tc').map((v) => v.key));

/** The model's verdicts, kept only when they name a late line of a file it was shown. */
export function cleanVerdicts(raw: unknown, files: FileState[]): Verdict[] {
  const known = new Set(files.flatMap((f) => [...f.overdue, ...f.waitingOn].map((t) => `${f.id}:${t.id}`)));
  const list = Array.isArray(raw) ? raw : [];
  const out: Verdict[] = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const key = String(r.key ?? '');
    const verdict = r.verdict === 'waiting' || r.verdict === 'looks_done' || r.verdict === 'needs_tc' ? r.verdict : null;
    if (known.has(key) && verdict) out.push({ key, verdict, why: String(r.why ?? '').slice(0, 240) });
  }
  return out;
}

const short = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The check-in Lane posts when the model cannot write one: same voice, plain facts. */
export function fallbackCheckin(tc: string, files: FileState[], wins: { address: string; task: string }[]): string {
  const first = tc.split(/\s+/)[0] || 'partner';
  const lines: string[] = [`🤠 Mornin', ${first}! Lane here with your 9 o'clock round-up.`];
  if (wins.length) {
    lines.push('', `🌟 Tip of the hat: you knocked out ${wins.length} ${wins.length === 1 ? 'item' : 'items'} since yesterday${wins[0] ? `, including "${short(wins[0].task, 60)}" on ${wins[0].address}` : ''}. That's how it's done!`);
  }
  const hot = files.filter((f) => f.overdue.length);
  const today = files.filter((f) => f.dueToday.length);
  const waiting = files.filter((f) => f.waitingOn.length);
  if (!hot.length && !today.length && !waiting.length) {
    lines.push('', "✅ Every file's on track this mornin'. Nothin' past due and nothin' on fire. Enjoy your coffee ☕");
    return lines.join('\n');
  }
  if (hot.length) {
    lines.push('', `🔥 Yours to move on ${hot.length} ${hot.length === 1 ? 'file' : 'files'}:`);
    for (const f of hot.slice(0, 6)) {
      const crit = f.overdue.filter((t) => t.critical);
      const lead = (crit[0] ?? f.overdue[0])!;
      lines.push(`• ${f.address} (${f.dayMarker}): ${short(lead.t)}${f.overdue.length > 1 ? ` (+${f.overdue.length - 1} more)` : ''}${crit.length ? ' ⚠️' : ''}`);
    }
    if (hot.length > 6) lines.push(`• …and ${hot.length - 6} more on the TC board.`);
  }
  if (waiting.length) {
    lines.push('', `⏳ Waiting on other folks (not on you):`);
    for (const f of waiting.slice(0, 5)) lines.push(`• ${f.address}: ${short(f.waitingOn[0]!.t)} (${f.waitingOn[0]!.owner})${f.waitingOn.length > 1 ? ` (+${f.waitingOn.length - 1})` : ''}`);
  }
  if (today.length) {
    lines.push('', `📋 On today's docket:`);
    for (const f of today.slice(0, 5)) lines.push(`• ${f.address} (${f.dayMarker}): ${short(f.dueToday[0]!.t)}${f.dueToday.length > 1 ? ` (+${f.dueToday.length - 1})` : ''}`);
  }
  lines.push('', "Holler at me on any of these and I'll draft the email, the text or the task. Let's ride! 🐎");
  return lines.join('\n');
}

/** The ping when a critical line slips past its day. */
export function fireNote(tc: string, fires: { file: FileState; task: CkTask }[]): { title: string; body: string } {
  const first = tc.split(/\s+/)[0] || 'partner';
  const one = fires.length === 1 ? fires[0] : null;
  return {
    title: one ? `🔥 Lane: ${one.file.address} needs you` : `🔥 Lane: ${fires.length} items slipped past their day`,
    body: [
      `Hey ${first}, quick holler 🤠`,
      ...fires.slice(0, 5).map((x) => `• ${x.file.address} (${x.file.dayMarker}): ${short(x.task.t)} was due ${x.task.day}`),
      fires.length > 5 ? `• …and ${fires.length - 5} more` : '',
      "Want me to draft the nudge? Open Lane and I'll have it ready.",
    ].filter(Boolean).join('\n'),
  };
}
