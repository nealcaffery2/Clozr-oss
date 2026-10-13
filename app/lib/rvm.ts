/**
 * Smart ringless voicemail: who gets a drop, which recording, and when.
 *
 * The rules run the same way in the dialer and in the rvm-tick function.
 * A drop is skipped when there is no number, the person is do-not-call, or
 * they were just talked to or just dropped. It waits (it is not skipped)
 * when their local clock is outside the window. A daily cap is optional;
 * bulk sends leave it unset so a thousand drops are not held for tomorrow.
 * Among the recordings in the group, one they have not already heard wins.
 */

// With the extension: rvm-tick imports this file under Deno, which does not
// guess one, and the function failed to load without it.
import { zoneForNumber } from './talkr-web/time.ts';

const DNC = /^(dnc|dnd|do[\s_-]?not[\s_-]?(call|contact|disturb))$/i;

export function isDncTag(tag: string): boolean {
  return DNC.test(tag.trim());
}

export function hasDnc(tags: readonly string[] | null | undefined): boolean {
  return (tags ?? []).some(isDncTag);
}

/**
 * The property's state beats the area code. Numbers get ported; the house
 * does not. Split states (Florida, Texas, Indiana, Kentucky) use the zone
 * most of the state lives in.
 */
const STATE_ZONES: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York',
  MI: 'America/Detroit', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
  NC: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
  KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver',
  NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

export function zoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  const raw = state.trim().toUpperCase();
  const code = raw.length === 2 ? raw : STATE_NAMES[raw];
  return code ? STATE_ZONES[code] ?? null : null;
}

/** State when we have it, else the area-code hint, else Central — Acme Homes' zone. */
export function zoneForRvm(phone: string | null | undefined, fallback = 'America/Chicago', state?: string | null): string {
  const fromState = zoneForState(state);
  if (fromState) return fromState;
  if (!phone) return fallback;
  const e = phone.trim().startsWith('+') ? phone.trim() : `+1${phone.replace(/\D/g, '').replace(/^1/, '')}`;
  return zoneForNumber(e) ?? fallback;
}

/** UTC instant of local midnight in `timeZone`, so a daily cap is a calendar day there. */
export function localMidnightIso(now: Date, timeZone: string): string {
  const clock = zonedClock(now, timeZone);
  return new Date(now.getTime() - clock.minutes * 60_000).toISOString();
}

export type ZonedClock = { day: number; minutes: number };

/** Sunday = 0. `minutes` is minutes since local midnight. */
export function zonedClock(now: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return { day: day < 0 ? 0 : day, minutes: hour * 60 + minute };
}

export type RvmWindow = {
  /** Minutes since local midnight, inclusive. */
  startMin: number;
  /** Minutes since local midnight, exclusive. */
  endMin: number;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
};

export const DEFAULT_RVM_WINDOW: RvmWindow = {
  startMin: 8 * 60,
  endMin: 20 * 60,
  days: [1, 2, 3, 4, 5, 6],
};

export function inWindow(clock: ZonedClock, window: RvmWindow): boolean {
  return window.days.includes(clock.day) && clock.minutes >= window.startMin && clock.minutes < window.endMin;
}

/** The next local instant the window is open, as a UTC Date. Walks at most eight days. */
export function nextWindowOpen(now: Date, timeZone: string, window: RvmWindow): Date {
  const clock = zonedClock(now, timeZone);
  if (inWindow(clock, window)) return now;
  for (let add = 0; add < 8; add++) {
    const probe = new Date(now.getTime() + add * 86_400_000);
    const c = zonedClock(probe, timeZone);
    if (!window.days.includes(c.day)) continue;
    const startToday = new Date(probe.getTime() - c.minutes * 60_000 + window.startMin * 60_000);
    if (startToday.getTime() > now.getTime()) return startToday;
  }
  return new Date(now.getTime() + 86_400_000);
}

export type RvmRecording = { id: string; name: string };

export type RvmFacts = {
  phone: string | null;
  dnc: boolean;
  /** On the blacklist (secret tag or buyer blacklisted_at). Checked before dnc so the row says why. */
  blacklisted?: boolean;
  now: Date;
  timeZone: string;
  window: RvmWindow;
  lastLiveTalkAt: string | null;
  lastDropAt: string | null;
  /** Days that must pass after a real conversation before another drop. */
  minDaysSinceTalk: number;
  /** Days that must pass after a drop before another one. */
  minDaysSinceDrop: number;
  sentToday: number;
  /** Null means no workspace cap. A number still holds the rest until the next open window. */
  dailyCap: number | null;
  recordings: RvmRecording[];
  /** Recording ids this number has already been left. */
  heardIds: string[];
  /** Last time each recording was left, so a repeat is the one they heard longest ago. */
  heardAt?: Record<string, string>;
};

export type RvmDecision =
  | { action: 'send'; recordingId: string }
  | { action: 'wait'; reason: 'outside_window' | 'daily_cap'; until: string }
  | { action: 'skip'; reason: 'no_phone' | 'blacklisted' | 'do_not_call' | 'recent_talk' | 'recent_drop' | 'no_recording' };

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

/** A recording they have not heard. Once they have heard them all, the one heard longest ago. */
export function pickRecording(
  recordings: RvmRecording[],
  heardIds: readonly string[],
  heardAt?: Record<string, string>,
): RvmRecording | null {
  if (!recordings.length) return null;
  const heard = new Set(heardIds);
  const fresh = recordings.find((r) => !heard.has(r.id));
  if (fresh) return fresh;
  if (!heardAt) return recordings[0]!;
  return [...recordings].sort((a, b) => (heardAt[a.id] ?? '').localeCompare(heardAt[b.id] ?? ''))[0] ?? recordings[0]!;
}

export function decideRvm(f: RvmFacts): RvmDecision {
  if (!f.phone || f.phone.replace(/\D/g, '').length < 10) return { action: 'skip', reason: 'no_phone' };
  if (f.blacklisted) return { action: 'skip', reason: 'blacklisted' };
  if (f.dnc) return { action: 'skip', reason: 'do_not_call' };
  const talk = daysSince(f.lastLiveTalkAt, f.now);
  if (talk !== null && talk < f.minDaysSinceTalk) return { action: 'skip', reason: 'recent_talk' };
  const drop = daysSince(f.lastDropAt, f.now);
  if (drop !== null && drop < f.minDaysSinceDrop) return { action: 'skip', reason: 'recent_drop' };
  const clock = zonedClock(f.now, f.timeZone);
  if (!inWindow(clock, f.window)) {
    return { action: 'wait', reason: 'outside_window', until: nextWindowOpen(f.now, f.timeZone, f.window).toISOString() };
  }
  if (f.dailyCap != null && f.sentToday >= f.dailyCap) {
    return { action: 'wait', reason: 'daily_cap', until: nextWindowOpen(new Date(f.now.getTime() + 60_000), f.timeZone, f.window).toISOString() };
  }
  const recording = pickRecording(f.recordings, f.heardIds, f.heardAt);
  if (!recording) return { action: 'skip', reason: 'no_recording' };
  return { action: 'send', recordingId: recording.id };
}

/**
 * The caller ID used least so far, so a blast does not park a thousand drops
 * on one number. Ties rotate with `seq` (the drop's place in this batch).
 */
export function spinCallerId(lines: readonly string[], counts: Readonly<Record<string, number>>, seq = 0): string | null {
  if (!lines.length) return null;
  let least = Infinity;
  for (const line of lines) least = Math.min(least, counts[line] ?? 0);
  const tied = lines.filter((line) => (counts[line] ?? 0) === least).slice().sort();
  return tied[Math.abs(seq) % tied.length] ?? null;
}

/** NANP area code, or null when the number is not a 10-digit US number. */
export function areaCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length >= 10 ? digits.slice(-10) : '';
  if (national.length < 10) return null;
  const npa = national.slice(0, 3);
  if (npa.startsWith('0') || npa.startsWith('1')) return null;
  return npa;
}

export type ReputationLine = { key: string; areaCode?: string | null };

function lineArea(line: ReputationLine): string | null {
  return line.areaCode || areaCodeOf(line.key);
}

/**
 * Local presence first, then the least-used line. A line whose area code
 * matches the destination wins when any line has it; otherwise the whole
 * pool is used. Ties rotate with `seq`. One line is that line.
 */
export function reputationPick<T extends ReputationLine>(
  lines: readonly T[],
  counts: Readonly<Record<string, number>>,
  dest: string | null | undefined,
  seq = 0,
): T | null {
  if (!lines.length) return null;
  const want = areaCodeOf(dest);
  const local = want ? lines.filter((line) => lineArea(line) === want) : [];
  const pool = (local.length ? local : lines).slice().sort((a, b) => a.key.localeCompare(b.key));
  let least = Infinity;
  for (const line of pool) least = Math.min(least, counts[line.key] ?? 0);
  const tied = pool.filter((line) => (counts[line.key] ?? 0) === least);
  return tied[Math.abs(seq) % tied.length] ?? null;
}

/** E.164 form of `reputationPick`, for drops that store the number itself. */
export function reputationE164(
  lines: readonly string[],
  counts: Readonly<Record<string, number>>,
  dest: string | null | undefined,
  seq = 0,
): string | null {
  return reputationPick(lines.map((key) => ({ key })), counts, dest, seq)?.key ?? null;
}

export const RVM_SKIP_SENTENCES: Record<string, string> = {
  no_phone: 'No phone number on file.',
  do_not_call: 'Marked do not call.',
  recent_talk: 'You spoke with them recently, so this drop waits them out.',
  recent_drop: 'A voicemail was just left, so another one is not sent.',
  no_recording: 'No voicemail recording is saved for this step.',
  outside_window: 'Outside their local calling window. It goes out when that window opens.',
  daily_cap: 'Today’s voicemail cap is full. It goes out on the next open day.',
  no_pool_line: 'Every line in the RVM number pool is paused, flagged or retired. It goes out once a pool line is healthy again.',
};
