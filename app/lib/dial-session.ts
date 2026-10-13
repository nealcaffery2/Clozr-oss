// A CLOZR dial session, start to finish: the setup a rep confirms before the
// first number rings, the tally the session bar and the finished summary
// read, the copy kept in the browser so a reload or a lunch break can pick
// the list back up, and the "run it again" filters.
//
// The walk itself (who rings next, skips, claims, do-not-call, calling hours)
// stays in useClozr's advanceRun; nothing here decides who to call.
//
// Pure apart from the small hand-off at the bottom (the setup sheet on
// screen takes requests the way the readiness checklist does). Tests:
// tools/dial-session.test.ts.

import { OUTCOMES, outcomeByKey, type OutcomeKey } from './call-outcomes';
import type { DialMode } from './dial-engine';
import type { ReadinessFacts } from './dialer-readiness';
import { walkKey, type QueueDepth, type WalkRow } from './seller-phones';

/** The clock, for timestamps taken in click handlers (kept out of render by the callers). */
export const nowMs = (): number => Date.now();

// ---- who a row is ------------------------------------------------------------

/** One person in a session: their record, or the number for a row with no record (a vendor). */
export const personKey = (t: { phone: string; personId?: string | null; buyerId?: string | null }): string =>
  walkKey(t) ?? 'n:' + t.phone.replace(/\D/g, '');

// ---- the tally ---------------------------------------------------------------

export type SessionTally = {
  /** Calls whose outcome was logged. */
  logged: number;
  /** Conversations: talked, follow up / appointment / offer / not interested. */
  connects: number;
  voicemails: number;
  noAnswer: number;
  wrong: number;
  dnc: number;
  appointments: number;
  /** Ready for an offer. */
  offers: number;
  followUps: number;
  notInterested: number;
  talkSeconds: number;
  /** Each person's last outcome this session (personKey). */
  last: Record<string, OutcomeKey>;
};

export const emptyTally = (): SessionTally => ({
  logged: 0, connects: 0, voicemails: 0, noAnswer: 0, wrong: 0, dnc: 0,
  appointments: 0, offers: 0, followUps: 0, notInterested: 0, talkSeconds: 0, last: {},
});

const BUMP: Record<OutcomeKey, (keyof SessionTally)[]> = {
  noanswer: ['noAnswer'],
  vm: ['voicemails'],
  followup: ['connects', 'followUps'],
  appt: ['connects', 'appointments'],
  offer: ['connects', 'offers'],
  notint: ['connects', 'notInterested'],
  wrong: ['wrong'],
  dnc: ['dnc'],
  accepted: ['connects', 'offers'],
  declined: ['connects', 'followUps'],
  nooffer: ['connects', 'notInterested'],
};

/** One logged call. Talk time only counts a call that was answered. */
export function tallyOutcome(t: SessionTally, key: OutcomeKey, who: string, talkSeconds = 0): SessionTally {
  const next: SessionTally = { ...t, logged: t.logged + 1, last: { ...t.last, [who]: key } };
  for (const f of BUMP[key]) (next[f] as number) = (t[f] as number) + 1;
  const answered = outcomeByKey(key).conversation || key === 'dnc' || key === 'wrong';
  if (answered && talkSeconds > 0) next.talkSeconds = t.talkSeconds + Math.round(talkSeconds);
  return next;
}

/** A voicemail drop stands in for an outcome when nothing else was logged for them. */
export function tallyDrop(t: SessionTally, who: string): SessionTally {
  return t.last[who] ? t : { ...t, last: { ...t.last, [who]: 'vm' } };
}

/**
 * The outcome a Talkr disposition means (a buyer's or an unknown number's
 * wrap-up picks a disposition, not one of the eight outcomes). The same
 * matching the outcome picker uses to find the org's disposition, backwards.
 */
export function outcomeForDisposition(name: string | null | undefined): OutcomeKey | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  for (const o of OUTCOMES) {
    if (o.talkr.names.some((x) => x.toLowerCase() === n.toLowerCase())) return o.key;
  }
  for (const o of OUTCOMES) {
    if (o.talkr.include && o.talkr.include.test(n) && !(o.talkr.exclude && o.talkr.exclude.test(n))) return o.key;
  }
  return null;
}

// ---- where the session is ----------------------------------------------------

type ProgressRun = { list: readonly WalkRow[]; pos: number; at: number; dialed: number; reached: readonly string[] };

export type SessionProgress = {
  /** People on the list, each once however many numbers they have. */
  people: number;
  /** The person being called (or last called), 1-based; 0 before the first call. */
  position: number;
  /** People talked to this session. */
  reached: number;
  /** Numbers still to try: rows from here on, less people already reached. */
  numbersLeft: number;
  /** Numbers dialled per person started on, one decimal. */
  depth: number;
  /** "Number 2 of 3" on the person being walked, or null. */
  number: { n: number; of: number } | null;
  /** 0–100, by people. */
  percent: number;
};

export function sessionProgress(run: ProgressRun, tally: SessionTally): SessionProgress {
  const order = new Map<string, number>();
  run.list.forEach((r) => {
    const k = personKey(r.target);
    if (!order.has(k)) order.set(k, order.size + 1);
  });
  const people = order.size;
  const cur = run.at >= 0 ? run.list[run.at] : undefined;
  const position = cur ? order.get(personKey(cur.target)) ?? 0 : 0;
  const done = new Set(run.reached);
  const numbersLeft = run.list.slice(run.pos).filter((r) => !done.has(personKey(r.target))).length;
  const reached = Object.values(tally.last).filter((k) => outcomeByKey(k).conversation).length;
  return {
    people,
    position,
    reached,
    numbersLeft,
    depth: position ? Math.round((run.dialed / position) * 10) / 10 : 0,
    number: cur && (cur.of ?? 1) > 1 ? { n: cur.n ?? 1, of: cur.of ?? 1 } : null,
    percent: people ? Math.round((position / people) * 100) : 0,
  };
}

/** 1h 04m, 12m 30s, 45s. */
export function talkTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

// ---- before the first call: blockers and warnings ----------------------------

/** What the setup sheet knows about the list it is about to dial. */
export type ListFacts = {
  people: number;
  /** No number on the record that can be dialled. */
  noNumber: number;
  /** Marked do not call (or the number is). */
  dnc: number;
  /** A pool lead a teammate has claimed since the list was built. */
  claimed: number;
};

export const dialableOf = (l: ListFacts): number => Math.max(0, l.people - l.noNumber - l.dnc - l.claimed);

export type SetupCheck = { blockers: string[]; warnings: string[] };

/**
 * What stops a session from starting, and what only makes it worse. Blocking:
 * nobody on the list can be called, Talkr cannot be reached, the phone in
 * this browser is not connected (or it says why — another tab, a failed
 * login), the microphone is blocked, or there is no
 * line to call from. Everything else (a voicemail to drop, the microphone not
 * yet allowed, people the walk will skip) is a warning the rep can start past.
 * `facts` is null where there is no Talkr phone (the demo): the list checks only.
 */
export function setupCheck(facts: ReadinessFacts | null, list: ListFacts | null, depth: QueueDepth): SetupCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (list) {
    const dialable = dialableOf(list);
    if (list.people === 0) blockers.push('Nobody is on this list.');
    else if (dialable === 0 && depth === 1) blockers.push('Nobody on this list has a number you can call.');
    else if (dialable === 0) warnings.push('Nobody has a main number you can call; only their other numbers will be tried.');
    const skip = list.noNumber + list.dnc + list.claimed;
    if (list.people > 0 && skip > 0 && dialable > 0) {
      const parts = [
        list.noNumber ? `${list.noNumber} with no number` : '',
        list.dnc ? `${list.dnc} do not call` : '',
        list.claimed ? `${list.claimed} claimed by a teammate` : '',
      ].filter(Boolean);
      warnings.push(`${skip} of ${list.people} will be skipped: ${parts.join(', ')}.`);
    }
  }
  if (facts) {
    if (facts.phone === 'unreachable' || facts.phone === 'error') blockers.push('Talkr cannot be reached, so no call can be placed.');
    else if (facts.phone === 'unlinked') warnings.push('Talkr does not know this sign-in: calls fall back to your own phone and are not recorded.');
    else if (facts.phone === 'ok' && facts.softphone !== 'ready' && facts.softphone !== 'connecting') {
      const reason = facts.softphoneReason?.trim();
      blockers.push(reason ? (/[.!?]$/.test(reason) ? reason : `${reason}.`) : 'The phone in this browser is not connected.');
    }
    else if (facts.phone !== 'ok' || facts.softphone === 'connecting') warnings.push('The phone is still connecting. The first call waits for it.');
    if (facts.mic === 'denied') blockers.push('The microphone is blocked for this site.');
    else if (facts.mic === 'prompt') warnings.push('Allow the microphone now so the first call does not stop to ask.');
    if (!facts.callerId) blockers.push('You have no number to call from.');
    if (facts.ownVoicemails === 0) warnings.push(facts.teamVoicemails ? 'You have no voicemail of your own; Drop VM plays a teammate’s.' : 'No voicemail recorded to drop on a machine.');
  }
  return { blockers, warnings };
}

// ---- remembered choices -------------------------------------------------------

export type SetupPrefs = { mode: DialMode; depth: QueueDepth; vmClipId: number | null };
export const DEFAULT_PREFS: SetupPrefs = { mode: 'power', depth: 1, vmClipId: null };

export const prefsKey = (ws: string | number | null, uid: string | null) => `clozr.dialSetup.${ws ?? 'demo'}.${uid ?? 'me'}`;
export const runKey = (ws: string | number | null, uid: string | null) => `clozr.dialRun.${ws ?? 'demo'}.${uid ?? 'me'}`;

const isDepth = (d: unknown): d is QueueDepth => d === 1 || d === 2 || d === 3 || d === 'all';
const isMode = (m: unknown): m is DialMode => m === 'power' || m === 'predictive';

export function parsePrefs(raw: string | null | undefined): Partial<SetupPrefs> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<SetupPrefs> = {};
    if (isMode(o.mode)) out.mode = o.mode;
    if (isDepth(o.depth)) out.depth = o.depth;
    if (o.vmClipId === null || (typeof o.vmClipId === 'number' && Number.isFinite(o.vmClipId))) out.vmClipId = o.vmClipId as number | null;
    return out;
  } catch {
    return {};
  }
}

export function readPrefs(ws: string | number | null, uid: string | null): SetupPrefs {
  try {
    return { ...DEFAULT_PREFS, ...parsePrefs(localStorage.getItem(prefsKey(ws, uid))) };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Fired on window when the rep's session choices change, so the Drop VM button picks up the new default. */
export const DIAL_PREFS_CHANGED = 'clozr-dial-prefs-changed';

export function savePrefs(ws: string | number | null, uid: string | null, p: SetupPrefs): void {
  try {
    localStorage.setItem(prefsKey(ws, uid), JSON.stringify(p));
    // The queue's own pickers read these (DialerParts QueueList).
    localStorage.setItem('clozr.queueDialMode', p.mode);
    localStorage.setItem('clozr.queueDepth', String(p.depth));
  } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(DIAL_PREFS_CHANGED)); } catch { /* no window */ }
}

// ---- resume ------------------------------------------------------------------

export type SavedRow = { target: { name: string; phone: string; personId?: string | null; buyerId?: string | null; phoneId?: number | null }; queueItemId?: string; claim?: boolean; n?: number; of?: number };

/** What the browser keeps of a running session (useClozr's QueueRun, less what cannot outlive the tab). */
export type SavedRun = {
  v: 1;
  title: string;
  mode: DialMode;
  depth: QueueDepth;
  list: SavedRow[];
  /** The list as the rep started it, one row per person: what "run it again" dials. */
  origin: SavedRow[];
  pos: number;
  at: number;
  reached: string[];
  dialed: number;
  skipped: number;
  dropped: number;
  tally: SessionTally;
  startedAt: number;
  savedAt: number;
};

export const RESUME_MAX_AGE_MS = 7 * 86_400_000;

const nat = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function validRow(r: unknown): r is SavedRow {
  if (!r || typeof r !== 'object') return false;
  const t = (r as SavedRow).target;
  if (!t || typeof t !== 'object' || typeof t.name !== 'string' || typeof t.phone !== 'string') return false;
  if (t.personId != null && typeof t.personId !== 'string') return false;
  if (t.buyerId != null && typeof t.buyerId !== 'string') return false;
  const { n, of } = r as SavedRow;
  if (n !== undefined && !nat(n)) return false;
  if (of !== undefined && !nat(of)) return false;
  return true;
}

function validTally(t: unknown): SessionTally {
  const base = emptyTally();
  if (!t || typeof t !== 'object') return base;
  const o = t as Record<string, unknown>;
  for (const k of Object.keys(base) as (keyof SessionTally)[]) {
    if (k === 'last') continue;
    if (nat(o[k])) (base[k] as number) = o[k] as number;
  }
  if (o.last && typeof o.last === 'object') {
    const keys = new Set<string>(OUTCOMES.map((x) => x.key));
    for (const [who, k] of Object.entries(o.last as Record<string, unknown>)) if (typeof k === 'string' && keys.has(k)) base.last[who] = k as OutcomeKey;
  }
  return base;
}

/**
 * A saved session read back, or null: unreadable, from an older shape, too
 * old, out of bounds, or nothing left in it to call. Never trusted further
 * than this; the walk re-checks every row as it reaches it.
 */
export function parseSavedRun(raw: string | null | undefined, now: number, maxAge = RESUME_MAX_AGE_MS): SavedRun | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  if (typeof o.title !== 'string' || !isMode(o.mode) || !isDepth(o.depth)) return null;
  if (!Array.isArray(o.list) || !o.list.length || !o.list.every(validRow)) return null;
  const origin = Array.isArray(o.origin) && o.origin.every(validRow) && o.origin.length ? o.origin as SavedRow[] : null;
  const list = o.list as SavedRow[];
  if (!nat(o.pos) || o.pos > list.length) return null;
  if (typeof o.at !== 'number' || !Number.isInteger(o.at) || o.at < -1 || o.at >= list.length) return null;
  if (!nat(o.dialed) || !nat(o.skipped) || !nat(o.dropped)) return null;
  if (typeof o.startedAt !== 'number' || typeof o.savedAt !== 'number') return null;
  if (now - o.savedAt > maxAge || o.savedAt - now > 60_000) return null;
  const reached = Array.isArray(o.reached) ? (o.reached as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const done = new Set(reached);
  // Nothing left: the session finished, it just never got to say so.
  if (!list.slice(o.pos).some((r) => !done.has(personKey(r.target)))) return null;
  return {
    v: 1, title: o.title, mode: o.mode, depth: o.depth, list, origin: origin ?? firstRows(list), pos: o.pos, at: o.at, reached,
    dialed: o.dialed, skipped: o.skipped, dropped: o.dropped, tally: validTally(o.tally), startedAt: o.startedAt, savedAt: o.savedAt,
  };
}

/** One row per person, their first number: the list as it was before their other numbers were spliced in. */
export function firstRows<T extends SavedRow>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of list) {
    const k = personKey(r.target);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.of && r.of > 1 ? { ...r, n: undefined, of: undefined } : r);
  }
  return out;
}

/** "Resume session (23 of 140, started 2:14pm)". The clock is formatted by the caller. */
export function resumeLabel(saved: Pick<SavedRun, 'list' | 'pos' | 'at' | 'dialed' | 'reached' | 'tally'>, startedClock: string): string {
  const p = sessionProgress(saved, saved.tally);
  return `Resume session (${Math.max(1, p.position)} of ${p.people}, started ${startedClock})`;
}

// ---- run it again ------------------------------------------------------------

export type RunAgainFilter = 'all' | 'not_reached' | 'no_answer';

export const RUN_AGAIN: { id: RunAgainFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Everyone', hint: 'The whole list again, less anyone who asked not to be called' },
  { id: 'not_reached', label: 'Not reached', hint: 'Everyone you did not talk to this session' },
  { id: 'no_answer', label: 'No answer / voicemail', hint: 'Only people you rang who did not pick up' },
];

/**
 * The same leads for a fresh session. Do not call is always left out (the
 * walk would skip them anyway); "not reached" leaves out every conversation;
 * "no answer" keeps only people rung whose last result was no answer or a
 * voicemail.
 */
export function runAgainList<T extends SavedRow>(origin: readonly T[], tally: SessionTally, reached: readonly string[], filter: RunAgainFilter): T[] {
  const done = new Set(reached);
  return origin.filter((r) => {
    const k = personKey(r.target);
    const last = tally.last[k];
    if (last === 'dnc') return false;
    if (filter === 'all') return true;
    if (filter === 'not_reached') return !done.has(k) && !(last && outcomeByKey(last).conversation);
    return last === 'noanswer' || last === 'vm';
  }).map((r) => (r.of && r.of > 1 ? { ...r, n: undefined, of: undefined } : r));
}

export function runAgainCounts(origin: readonly SavedRow[], tally: SessionTally, reached: readonly string[]): Record<RunAgainFilter, number> {
  return {
    all: runAgainList(origin, tally, reached, 'all').length,
    not_reached: runAgainList(origin, tally, reached, 'not_reached').length,
    no_answer: runAgainList(origin, tally, reached, 'no_answer').length,
  };
}

// ---- the hand-off to the setup sheet on screen ------------------------------

export type SetupListOption = {
  id: string;
  title: string;
  /** Null for a Talkr campaign: the server picks who to call. */
  facts: ListFacts | null;
  /** Whether Numbers per lead means anything (the list has sellers or buyers on it). */
  hasRecords: boolean;
};

export type SetupRequest = {
  /** A CLOZR list walked in the browser, or a Talkr campaign walked on the server. */
  kind: 'list' | 'campaign';
  lists: SetupListOption[];
  listId: string;
  /** Where the start came from asked for this mode; null takes the rep's last. */
  mode: DialMode | null;
  depth: QueueDepth | null;
};

export type SetupChoice = { listId: string; mode: DialMode; depth: QueueDepth; vmClipId: number | null };

type SetupPrompt = SetupRequest & { resolve: (c: SetupChoice | null) => void };
let setupHost: ((p: SetupPrompt) => void) | null = null;

/** The setup sheet on screen takes requests. One host at a time. */
export function hostSessionSetup(fn: (p: SetupPrompt) => void): () => void {
  setupHost = fn;
  return () => { if (setupHost === fn) setupHost = null; };
}

/**
 * Every session start asks here first. The rep's answer (null when they
 * cancel), or null straight away with `false` when nothing on screen can ask,
 * in which case the caller starts with what it has.
 */
export function requestSessionSetup(req: SetupRequest): Promise<SetupChoice | null> | false {
  const show = setupHost;
  if (!show) return false;
  return new Promise<SetupChoice | null>((resolve) => show({ ...req, resolve }));
}
