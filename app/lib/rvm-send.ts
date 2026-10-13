// The pre-send check for a bulk ringless voicemail: before anything is queued,
// how many go out now, how many wait for their local window, how many the
// tick would skip and why, and whether the pool can carry today's share.
//
// The rules are rvm-tick's own (lib/rvm.ts decideRvm, lib/rvm-pool.ts
// pickPoolLine), run over what rvm_send_preview (migration 194) reads for the
// selection: the record's tags and blacklist, its last delivered drop, its last
// real conversation, a drop already on the way, its state, and the pool lines
// with what each already carried today. Pure, so tools/rvm-send.test.ts runs it.

import { isBlacklisted } from './blacklist.ts';
import { DEFAULT_RVM_WINDOW, decideRvm, hasDnc, zoneForRvm, type RvmWindow } from './rvm.ts';
import { lineUsable, marketState, worseRisk, pickPoolLine, rampCap, rampDay, stateCode2, stateOfPhone, type PoolLine, type PoolTier, type RvmPoolSettings } from './rvm-pool.ts';

/** One row of rvm_send_preview's `people`. */
export type PreviewPerson = {
  kind: 'seller' | 'buyer';
  id: number;
  tags?: string[] | null;
  /** Buyers: buyers.blacklisted_at. A seller's blacklist is the secret tag in `tags`. */
  blacklisted_at?: string | null;
  blacklisted?: boolean | null;
  wants_calls?: boolean | null;
  /** Sellers: the property's state. */
  state?: string | null;
  /** Buyers: their markets; the first state among them. */
  markets?: string[] | null;
  last_drop_at?: string | null;
  last_talk_at?: string | null;
  /** A drop for them already queued or in flight. */
  pending?: number | null;
};

/** One row of rvm_send_preview's `pool`: a caller_lines row plus today's count and the guard's verdict. */
export type PreviewLine = {
  phone_e164: string;
  market_state?: string | null;
  daily_cap?: number | null;
  ramp_started_at?: string | null;
  spam_risk?: string | null;
  retired_at?: string | null;
  used_today?: number | null;
  paused?: boolean | null;
  grade?: string | null;
  health_spam_risk?: string | null;
};

export type SendSkip = 'no_phone' | 'blacklisted' | 'do_not_call' | 'recent_talk' | 'recent_drop' | 'already_queued';

export type PersonVerdict =
  | { key: string; action: 'now'; tier: PoolTier | null }
  | { key: string; action: 'later'; reason: 'outside_window' | 'pool_full' | 'no_pool_line'; until: string | null; tier: PoolTier | null }
  | { key: string; action: 'skip'; reason: SendSkip };

export type SendPreview = {
  now: number;
  /** Queued, but held until their local 8am (or the pool's next day). */
  later: number;
  /** Earliest moment a held drop opens. */
  laterFrom: string | null;
  /** Of `later`, the drops the pool cannot carry today (every line at its warm-up cap). */
  overCap: number;
  /** Of `later`, the drops held because every pool line is retired, paused or flagged (rvm-tick holds them, it does not use the main lines). */
  noLine: number;
  skipped: Partial<Record<SendSkip, number>>;
  /** Which line tier each sendable drop lands on (local presence). */
  tiers: Partial<Record<PoolTier, number>>;
  /** States in the selection with no pool line of their own, and how many people each. */
  noLocalLine: Record<string, number>;
  /** Pool lines a drop can go out on today, and what they can still carry. */
  poolLines: number;
  poolLeft: number;
  /** True when no line is marked RVM pool: drops rotate across the main caller lines. */
  noPool: boolean;
  people: PersonVerdict[];
};

export const SEND_SKIP_LABEL: Record<SendSkip, string> = {
  no_phone: 'no phone number',
  blacklisted: 'blacklisted',
  do_not_call: 'do not call',
  recent_talk: 'spoken with in the last 7 days',
  recent_drop: 'dropped on in the last 3 days',
  already_queued: 'a voicemail is already on the way',
};

export const personKey = (kind: 'seller' | 'buyer', id: number) => `${kind}:${id}`;

/** The pool as rvm-tick builds it: today's warm-up cap, the guard's verdict, a retired line still the pool's but unusable. */
export function poolFromPreview(lines: readonly PreviewLine[], settings: RvmPoolSettings | null, now: Date): { pool: PoolLine[]; used: Record<string, number> } {
  const pool: PoolLine[] = [];
  const used: Record<string, number> = {};
  for (const l of lines) {
    if (!l.phone_e164) continue;
    pool.push({
      e164: l.phone_e164,
      state: l.market_state ?? null,
      cap: rampCap(rampDay(l.ramp_started_at ?? null, now), settings, l.daily_cap ?? null),
      usable: !l.retired_at && lineUsable({ paused: l.paused, grade: l.grade, spam_risk: worseRisk(l.health_spam_risk, l.spam_risk) }),
    });
    used[l.phone_e164] = Number(l.used_today ?? 0);
  }
  return { pool, used };
}

/**
 * The verdict for every selected person, in the order given. `phones` is the
 * number the composer would drop to (keyed by personKey); a person rvm_send_preview
 * did not return (deleted since the list loaded) is a no_phone skip.
 */
export function previewSend(input: {
  phones: Readonly<Record<string, string | null | undefined>>;
  people: readonly PreviewPerson[];
  lines: readonly PreviewLine[];
  settings?: RvmPoolSettings | null;
  now: Date;
  window?: RvmWindow;
}): SendPreview {
  const window = input.window ?? DEFAULT_RVM_WINDOW;
  const { pool, used } = poolFromPreview(input.lines, input.settings ?? null, input.now);
  const live = pool.filter((l) => l.usable !== false);
  const left = { ...used };
  const states = new Set(live.map((l) => stateCode2(l.state) ?? stateOfPhone(l.e164)).filter(Boolean) as string[]);
  const byKey = new Map(input.people.map((p) => [personKey(p.kind, p.id), p]));
  const out: SendPreview = {
    now: 0, later: 0, laterFrom: null, overCap: 0, noLine: 0, skipped: {}, tiers: {}, noLocalLine: {},
    poolLines: live.length, poolLeft: live.reduce((s, l) => s + Math.max(0, l.cap - (used[l.e164] ?? 0)), 0),
    noPool: pool.length === 0, people: [],
  };
  const seen = new Set<string>();
  let seq = 0;
  const skip = (key: string, reason: SendSkip) => {
    out.skipped[reason] = (out.skipped[reason] ?? 0) + 1;
    out.people.push({ key, action: 'skip', reason });
  };
  for (const [key, phone] of Object.entries(input.phones)) {
    const p = byKey.get(key);
    const digits = (phone ?? '').replace(/\D/g, '').slice(-10);
    if (!p || digits.length < 10) { skip(key, 'no_phone'); continue; }
    if (p.pending) { skip(key, 'already_queued'); continue; }
    // One drop per number per send: two records sharing a phone get one.
    if (seen.has(digits)) { skip(key, 'already_queued'); continue; }
    const state = p.kind === 'seller' ? stateCode2(p.state) : marketState(p.markets ?? null);
    const decision = decideRvm({
      phone: phone ?? null,
      dnc: hasDnc(p.tags) || p.wants_calls === false,
      blacklisted: isBlacklisted(p),
      now: input.now,
      timeZone: zoneForRvm(phone, 'America/Chicago', state),
      window,
      lastLiveTalkAt: p.last_talk_at ?? null,
      lastDropAt: p.last_drop_at ?? null,
      minDaysSinceTalk: 7,
      minDaysSinceDrop: 3,
      sentToday: 0,
      dailyCap: null,
      recordings: [{ id: 'clip', name: 'clip' }],
      heardIds: [],
    });
    if (decision.action === 'skip') { skip(key, decision.reason === 'no_recording' ? 'no_phone' : decision.reason); continue; }
    seen.add(digits);
    const want = state ?? stateOfPhone(phone);
    if (live.length && want && !states.has(want)) out.noLocalLine[want] = (out.noLocalLine[want] ?? 0) + 1;
    // Like the tick: a drop outside its window waits before any line is taken,
    // so it does not use today's capacity.
    if (decision.action === 'wait') {
      out.later++;
      if (!out.laterFrom || decision.until < out.laterFrom) out.laterFrom = decision.until;
      out.people.push({ key, action: 'later', reason: 'outside_window', until: decision.until, tier: null });
      continue;
    }
    let tier: PoolTier | null = null;
    if (pool.length && !live.length) {
      // Like the tick: a pool with no usable line holds the drop instead of using the main lines.
      out.later++; out.noLine++;
      out.people.push({ key, action: 'later', reason: 'no_pool_line', until: null, tier: null });
      continue;
    }
    if (live.length) {
      const pick = pickPoolLine(live, { state, phone }, left, seq++);
      if (!pick.ok) {
        out.later++; out.overCap++;
        out.people.push({ key, action: 'later', reason: 'pool_full', until: null, tier: null });
        continue;
      }
      left[pick.e164] = (left[pick.e164] ?? 0) + 1;
      tier = pick.tier;
      out.tiers[tier] = (out.tiers[tier] ?? 0) + 1;
    }
    out.now++;
    out.people.push({ key, action: 'now', tier });
  }
  return out;
}

/** "212 go out now · 40 wait for 8am their time · 9 skipped (5 do not call, 4 dropped on in the last 3 days)". */
export function previewSentence(p: SendPreview, fmtTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): string {
  const parts = [`${p.now} go${p.now === 1 ? 'es' : ''} out now`];
  const held = p.later - p.overCap - p.noLine;
  if (held > 0) parts.push(`${held} wait for their local window${p.laterFrom ? ` (first at ${fmtTime(p.laterFrom)})` : ''}`);
  if (p.overCap > 0) parts.push(`${p.overCap} wait for tomorrow: the pool's warm-up caps are full today`);
  if (p.noLine > 0) parts.push(`${p.noLine} wait for a healthy pool line: every RVM line is retired, paused or flagged`);
  const skips = Object.entries(p.skipped).filter(([, n]) => n);
  const total = skips.reduce((s, [, n]) => s + (n ?? 0), 0);
  if (total) parts.push(`${total} skipped (${skips.map(([r, n]) => `${n} ${SEND_SKIP_LABEL[r as SendSkip]}`).join(', ')})`);
  return parts.join(' · ');
}
