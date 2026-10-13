/**
 * The ringless-voicemail number pool: which line a drop goes out on, how many
 * drops a line may carry today while it warms up, and how many lines each
 * state should have.
 *
 * A line is in the RVM pool when caller_lines.pool = 'rvm' (migration 135).
 * Each pool line has a market state, a warm-up start and an optional hard cap.
 * The drop is the lead's state first (sellers: the property's state; buyers:
 * their first market state), then a neighbouring state or a line in the
 * lead's area code, then any pool line. A line at today's cap is never used;
 * among the rest the least used today goes first. A paused line, an "At risk"
 * grade or a high spam risk (number-guard, migration 68) takes a line out.
 *
 * Imported by rvm-tick under Deno, so every import carries its extension.
 */

import { areaCodeOf } from './rvm.ts';

/**
 * Drops per line per day while a new number warms up, by day since the ramp
 * started (index 0 = the first day). Ringless networks and the carriers they
 * ride on flag a brand-new number that suddenly leaves hundreds of voicemails,
 * so a line starts small and roughly doubles over the first week, reaching
 * the ceiling on day 14. Tunable per workspace: settings.rvm_pool.ramp (this
 * array's shape) and settings.rvm_pool.ceiling.
 */
export const DEFAULT_RVM_RAMP: readonly number[] = [25, 35, 50, 65, 80, 100, 125, 150, 175, 200, 225, 250, 275, 300];
export const DEFAULT_RVM_CEILING = 300;

/** Days a callback (or a text back) counts toward the drop that preceded it. */
export const CALLBACK_WINDOW_DAYS = 7;

export type RvmPoolSettings = {
  ramp?: number[] | null;
  ceiling?: number | null;
  /** Dollars per delivered drop, for the Blast results' cost line. Slybroadcast bills per drop. */
  cost_per_drop?: number | null;
  /** What rotation does when it retires a line (lib/rvm-rotation.ts). Off unless an admin turns it on. */
  replace?: { mode?: 'off' | 'approve' | 'auto' | null; monthly_cap?: number | null; retire_on?: 'high' | 'medium' | null } | null;
};

function cleanRamp(ramp: readonly unknown[] | null | undefined): number[] {
  const out = (ramp ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n));
  return out.length ? out : [...DEFAULT_RVM_RAMP];
}

/** Whole days from `start` (a date or timestamp) to `now`. Null start means the line is already warm. */
export function rampDay(start: string | null | undefined, now: Date): number | null {
  if (!start) return null;
  const t = Date.parse(start.length === 10 ? `${start}T00:00:00Z` : start);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * Today's cap for one line. The ramp's step for this day, never above the
 * workspace ceiling or the line's own daily_cap. A line with no ramp start is
 * treated as warm: the ceiling (or its own cap).
 */
export function rampCap(
  day: number | null,
  settings: RvmPoolSettings | null | undefined = null,
  lineCap: number | null | undefined = null,
): number {
  const ramp = cleanRamp(settings?.ramp);
  const ceilingRaw = Number(settings?.ceiling);
  const ceiling = Number.isFinite(ceilingRaw) && ceilingRaw > 0 ? Math.floor(ceilingRaw) : Math.max(DEFAULT_RVM_CEILING, ramp[ramp.length - 1]!);
  const step = day == null ? ceiling : ramp[Math.min(day, ramp.length - 1)]!;
  let cap = Math.min(step, ceiling);
  if (lineCap != null && Number.isFinite(lineCap) && lineCap >= 0) cap = Math.min(cap, Math.floor(lineCap));
  return cap;
}

export type LineHealth = { paused?: boolean | null; grade?: string | null; spam_risk?: string | null };

const RISK_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/**
 * The worse of two spam verdicts: Talkr's (number_health) and the carrier's
 * Number Reputation read (caller_lines, migration 195). Either one saying
 * high takes the line out.
 */
export function worseRisk(...risks: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const r of risks) {
    const k = String(r ?? '').toLowerCase();
    if (!RISK_RANK[k]) continue;
    if (!best || RISK_RANK[k]! > RISK_RANK[best]!) best = k;
  }
  return best;
}

/** False for a paused line, an "At risk" grade (the poor one) or a high spam risk. */
export function lineUsable(h: LineHealth | null | undefined): boolean {
  if (!h) return true;
  if (h.paused) return false;
  const grade = String(h.grade ?? '').toLowerCase();
  if (grade === 'at_risk' || grade === 'poor') return false;
  if (String(h.spam_risk ?? '').toLowerCase() === 'high') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Geography: area code → state, and which states touch.
// ---------------------------------------------------------------------------

/**
 * US area codes by state (NANPA, overlays included). A hint for a line's
 * market when nobody set one and for a lead with no state on file; numbers
 * port, so the property's state always wins.
 */
const NPA_BY_STATE: Record<string, string> = {
  AL: '205 251 256 334 659 938',
  AK: '907',
  AZ: '480 520 602 623 928',
  AR: '479 501 870 327',
  CA: '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951',
  CO: '303 719 720 970 983',
  CT: '203 475 860 959',
  DE: '302',
  DC: '202 771',
  FL: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  GA: '229 404 470 478 678 706 762 770 912 943',
  HI: '808',
  ID: '208 986',
  IL: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
  IN: '219 260 317 463 574 765 812 930',
  IA: '319 515 563 641 712',
  KS: '316 620 785 913',
  KY: '270 364 502 606 859',
  LA: '225 318 337 504 985',
  ME: '207',
  MD: '227 240 301 410 443 667',
  MA: '339 351 413 508 617 774 781 857 978',
  MI: '231 248 269 313 517 586 616 679 734 810 906 947 989',
  MN: '218 320 507 612 651 763 952',
  MS: '228 601 662 769',
  MO: '235 314 417 557 573 636 660 816',
  MT: '406',
  NE: '308 402 531',
  NV: '702 725 775',
  NH: '603',
  NJ: '201 551 609 640 732 848 856 862 908 973',
  NM: '505 575',
  NY: '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
  NC: '252 336 472 704 743 828 910 919 980 984',
  ND: '701',
  OH: '216 220 234 283 326 330 380 419 436 440 513 567 614 740 937',
  OK: '405 539 572 580 918',
  OR: '458 503 541 971',
  PA: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  RI: '401',
  SC: '803 821 839 843 854 864',
  SD: '605',
  TN: '423 615 629 731 865 901 931',
  TX: '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979',
  UT: '385 435 801',
  VT: '802',
  VA: '276 434 540 571 686 703 757 804 826 948',
  WA: '206 253 360 425 509 564',
  WV: '304 681',
  WI: '262 274 353 414 534 608 715 920',
  WY: '307',
};

const STATE_OF_NPA: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [st, codes] of Object.entries(NPA_BY_STATE)) for (const c of codes.split(' ')) m.set(c, st);
  return m;
})();

/** A state's area codes (overlays included), or none. */
export function areaCodesOfState(state: string | null | undefined): string[] {
  const code = String(state ?? '').trim().toUpperCase();
  return NPA_BY_STATE[code]?.split(' ') ?? [];
}

/** The state an area code belongs to, or null. */
export function stateOfAreaCode(npa: string | null | undefined): string | null {
  return npa ? STATE_OF_NPA.get(npa) ?? null : null;
}

/** The state a phone number's area code belongs to, or null. */
export function stateOfPhone(phone: string | null | undefined): string | null {
  return stateOfAreaCode(areaCodeOf(phone));
}

/** States that share a border (contiguous US; AK and HI have none). */
export const NEIGHBORS: Record<string, readonly string[]> = {
  AL: ['FL', 'GA', 'MS', 'TN'], AZ: ['CA', 'CO', 'NM', 'NV', 'UT'], AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'],
  CA: ['AZ', 'NV', 'OR'], CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'], CT: ['MA', 'NY', 'RI'],
  DE: ['MD', 'NJ', 'PA'], DC: ['MD', 'VA'], FL: ['AL', 'GA'], GA: ['AL', 'FL', 'NC', 'SC', 'TN'],
  ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'], IL: ['IA', 'IN', 'KY', 'MO', 'WI'], IN: ['IL', 'KY', 'MI', 'OH'],
  IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'], KS: ['CO', 'MO', 'NE', 'OK'], KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'],
  LA: ['AR', 'MS', 'TX'], ME: ['NH'], MD: ['DC', 'DE', 'PA', 'VA', 'WV'], MA: ['CT', 'NH', 'NY', 'RI', 'VT'],
  MI: ['IN', 'OH', 'WI'], MN: ['IA', 'ND', 'SD', 'WI'], MS: ['AL', 'AR', 'LA', 'TN'],
  MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'], MT: ['ID', 'ND', 'SD', 'WY'], NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'],
  NV: ['AZ', 'CA', 'ID', 'OR', 'UT'], NH: ['MA', 'ME', 'VT'], NJ: ['DE', 'NY', 'PA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'],
  NY: ['CT', 'MA', 'NJ', 'PA', 'VT'], NC: ['GA', 'SC', 'TN', 'VA'], ND: ['MN', 'MT', 'SD'], OH: ['IN', 'KY', 'MI', 'PA', 'WV'],
  OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'], OR: ['CA', 'ID', 'NV', 'WA'], PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'],
  RI: ['CT', 'MA'], SC: ['GA', 'NC'], SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'],
  TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'], TX: ['AR', 'LA', 'NM', 'OK'], UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'],
  VT: ['MA', 'NH', 'NY'], VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'], WA: ['ID', 'OR'], WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
  WI: ['IA', 'IL', 'MI', 'MN'], WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};

/** A two-letter code from "sc", "SC" or "South Carolina"-style input already reduced to a code. */
export function stateCode2(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) && (s in NPA_BY_STATE) ? s : null;
}

/**
 * The first state a buyer's markets name: "SC", "Columbia, SC" or
 * "Greenville County, SC". Null when none does.
 */
export function marketState(markets: readonly (string | null | undefined)[] | null | undefined): string | null {
  for (const m of markets ?? []) {
    const raw = String(m ?? '').trim().toUpperCase();
    const code = stateCode2(raw) ?? stateCode2(/(?:,|\s)\s*([A-Z]{2})$/.exec(raw)?.[1]);
    if (code) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Picking the line for one drop
// ---------------------------------------------------------------------------

export type PoolLine = {
  e164: string;
  /** The market the line serves; falls back to its area code's state. */
  state?: string | null;
  /** Today's cap (rampCap). */
  cap: number;
  usable?: boolean;
};

/**
 * How local the caller ID is (stored on rvm_drops.pool_tier, migration 198):
 *   area_code    the recipient's own area code: local on their handset
 *   state        the lead's state (the property's, or the buyer's first market)
 *   phone_state  the state of the recipient's phone, when it is not the lead's
 *   neighbor     a state bordering the lead's (or the phone's)
 *   any          any pool line
 */
export type PoolTier = 'area_code' | 'state' | 'phone_state' | 'neighbor' | 'any';

/** Tiers that count as local presence in the blast results. */
export const LOCAL_TIERS: ReadonlySet<PoolTier> = new Set(['area_code', 'state', 'phone_state']);

export type PoolPick =
  | { ok: true; e164: string; tier: PoolTier }
  | { ok: false; reason: 'no_pool' | 'pool_full' };

function lineState(l: PoolLine): string | null {
  return stateCode2(l.state) ?? stateOfPhone(l.e164);
}

/**
 * The pool line for one drop. `used` is drops each line already carried today
 * (counted forward as the batch goes). Local first: a line in the recipient's
 * area code, then in the lead's state, then in their phone's state, then a
 * neighbouring state, then any line. Never one at its cap; the least used
 * today first, ties rotating with `seq`. An SC recipient gets an SC line
 * whenever the pool has one with room.
 */
export function pickPoolLine(
  lines: readonly PoolLine[],
  lead: { state?: string | null; phone?: string | null },
  used: Readonly<Record<string, number>>,
  seq = 0,
): PoolPick {
  const live = lines.filter((l) => l.usable !== false);
  if (!live.length) return { ok: false, reason: 'no_pool' };
  const open = live.filter((l) => (used[l.e164] ?? 0) < l.cap);
  if (!open.length) return { ok: false, reason: 'pool_full' };
  const leadState = stateCode2(lead.state);
  const phoneState = stateOfPhone(lead.phone);
  const want = leadState ?? phoneState;
  const npa = areaCodeOf(lead.phone);
  const near = new Set(want ? NEIGHBORS[want] ?? [] : []);
  const tiers: [PoolTier, PoolLine[]][] = [
    ['area_code', npa ? open.filter((l) => areaCodeOf(l.e164) === npa) : []],
    ['state', want ? open.filter((l) => lineState(l) === want) : []],
    ['phone_state', phoneState && phoneState !== want ? open.filter((l) => lineState(l) === phoneState) : []],
    ['neighbor', open.filter((l) => near.has(lineState(l) ?? ''))],
    ['any', open],
  ];
  for (const [tier, pool] of tiers) {
    if (!pool.length) continue;
    const sorted = pool.slice().sort((a, b) => a.e164.localeCompare(b.e164));
    let least = Infinity;
    for (const l of sorted) least = Math.min(least, used[l.e164] ?? 0);
    const tied = sorted.filter((l) => (used[l.e164] ?? 0) === least);
    const pick = tied[Math.abs(seq) % tied.length]!;
    return { ok: true, e164: pick.e164, tier };
  }
  return { ok: false, reason: 'pool_full' };
}

// ---------------------------------------------------------------------------
// How many lines per state
// ---------------------------------------------------------------------------

/**
 * How `total` lines split across the states the leads are in. No state gets
 * more than half the pool (one market's lines all flagged at once is the risk
 * a pool exists to avoid); the rest is proportional with largest remainders.
 * States left without a line are served by a neighbour's, then any line.
 * Informational: nothing is bought.
 */
export function suggestPool(leadsByState: Readonly<Record<string, number>>, total: number): { state: string; lines: number; leads: number }[] {
  const n = Math.max(0, Math.floor(total));
  const rows = Object.entries(leadsByState)
    .map(([st, c]) => [stateCode2(st), Math.max(0, Number(c) || 0)] as const)
    .filter((r): r is readonly [string, number] => !!r[0] && r[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!n || !rows.length) return [];
  const out = new Map<string, number>();
  const half = rows.length > 1 ? Math.max(1, Math.floor(n / 2)) : n;
  let left = n;
  let pool = rows.slice();
  // Cap the leaders at half the lines, one at a time, then share the rest.
  for (;;) {
    const sum = pool.reduce((s, [, c]) => s + c, 0);
    const over = pool.find(([, c]) => (c / sum) * left > half);
    if (!over) break;
    out.set(over[0], half);
    left -= half;
    pool = pool.filter((r) => r[0] !== over[0]);
    if (!pool.length || left <= 0) break;
  }
  if (left > 0 && pool.length) {
    const sum = pool.reduce((s, [, c]) => s + c, 0);
    const shares = pool.map(([st, c]) => ({ st, exact: (c / sum) * left }));
    let given = 0;
    for (const s of shares) { const f = Math.floor(s.exact); out.set(s.st, f); given += f; }
    const byRemainder = shares.slice().sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || b.exact - a.exact);
    for (let i = 0; given < left && i < byRemainder.length; i++, given++) out.set(byRemainder[i]!.st, (out.get(byRemainder[i]!.st) ?? 0) + 1);
  }
  const leads = new Map(rows);
  return [...out.entries()].filter(([, l]) => l > 0)
    .map(([state, lines]) => ({ state, lines, leads: leads.get(state) ?? 0 }))
    .sort((a, b) => b.lines - a.lines || b.leads - a.leads);
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export type Touch = { id: number | string; at: string; kind: 'rvm' | 'call' | 'sms' | 'email'; rep_id?: string | null };

/**
 * The outreach a callback answers: the latest touch at or before the call and
 * no more than `windowDays` before it. Null when nothing qualifies.
 */
export function attributeCallback<T extends Touch>(touches: readonly T[], callAt: string | Date, windowDays = CALLBACK_WINDOW_DAYS): T | null {
  const at = typeof callAt === 'string' ? Date.parse(callAt) : callAt.getTime();
  if (Number.isNaN(at)) return null;
  const earliest = at - windowDays * 86_400_000;
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const t of touches) {
    const ts = Date.parse(t.at);
    if (Number.isNaN(ts) || ts > at || ts < earliest) continue;
    if (ts > bestAt) { best = t; bestAt = ts; }
  }
  return best;
}

/** "Calling back about your RVM from Oct 2", for the incoming-call card. */
export function callbackLine(touch: Pick<Touch, 'at' | 'kind'>, mine: boolean, sender?: string | null, timeZone?: string): string {
  const day = new Date(touch.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
  const what = touch.kind === 'rvm' ? 'RVM' : touch.kind === 'email' ? 'email' : touch.kind === 'sms' ? 'text' : 'call';
  return `Calling back about ${mine ? 'your' : sender ? `${sender}'s` : 'the'} ${what} from ${day}`;
}
