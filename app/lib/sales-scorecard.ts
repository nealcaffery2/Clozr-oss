// Rep scorecards: one row per rep for a period, built from the leaderboard's
// activity numbers (lib/leaderboard.ts, so a call count here is the call
// count on the board), the graded calls (communications.coaching_review) and
// the roleplay sessions (migration 149).
//
// Pure. The sales-manager function and the weekly email build the same rows
// from the same reads; the Scorecards view draws them.

import {
  FLAG_DEFS, FLAG_IDS, FRAMEWORK_STAGES, STAGE_IDS, flagIdsOf, flagLabel, frameworkOf,
  type FlagId, type StageId,
} from './sales-framework.ts';

/** The activity numbers this needs from the leaderboard's SalesPerson. */
export type ActivityRow = {
  id: string; name: string; role?: string;
  totalCalls?: number; calls?: number; conversations?: number; totalTalkTime?: number;
  appointments?: number; meetings?: number; offersMade?: number; dealsUnderContract?: number; deals?: number; leads?: number;
};

export type ReviewRow = {
  id: number;
  rep_id: string | null;
  occurred_at: string;
  duration_s: number | null;
  coaching_review: unknown;
};

export type RoleplayRow = { user_id: string; started_at: string; score: number | null; stage_hit_rate?: number | null; status?: string | null };

export type HeldAppointment = { assigned_to: string | null; seller_rep?: string | null; starts_at: string; deleted_at?: string | null };

export type RepScorecard = {
  id: string;
  name: string;
  calls: number;
  conversations: number;
  talkTimeS: number;
  appointmentsSet: number;
  appointmentsHeld: number;
  offersMade: number;
  contracts: number;
  /** Contracts per appointment held, 0 to 100. Null with no appointment held. */
  contractRate: number | null;
  reviewedCalls: number;
  avgCallScore: number | null;
  /** Framework stage hit-rate (0 to 100) per stage, over the reviewed calls that reached it. */
  stageHitRates: Record<StageId, number | null>;
  /** Mean of the per-call framework hit rates. */
  frameworkHitRate: number | null;
  flags: Record<FlagId, number>;
  flaggedCalls: number;
  roleplaySessions: number;
  avgRoleplayScore: number | null;
  /** The weakest stages, worst first, with at least two calls behind each. */
  weakStages: StageId[];
};

const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const inWin = (iso: string | null | undefined, w: { start: number | null; end: number }) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && (w.start === null || t >= w.start) && t < w.end;
};

const STAGE_MIN_CALLS = 2;

export function buildScorecards(input: {
  activity: ActivityRow[];
  reviews: ReviewRow[];
  roleplays: RoleplayRow[];
  appointments?: HeldAppointment[];
  window: { start: number | null; end: number };
  now?: number;
}): RepScorecard[] {
  const now = input.now ?? Date.now();
  const held = new Map<string, number>();
  for (const a of input.appointments ?? []) {
    if (a.deleted_at) continue;
    const t = Date.parse(a.starts_at);
    if (!Number.isFinite(t) || t > now || !inWin(a.starts_at, input.window)) continue;
    const who = a.assigned_to ?? a.seller_rep ?? null;
    if (who) held.set(who, (held.get(who) ?? 0) + 1);
  }

  return input.activity.map((p) => {
    const reviews = input.reviews.filter((r) => r.rep_id === p.id && inWin(r.occurred_at, input.window));
    const scores: number[] = [];
    const rates: number[] = [];
    const stageGot = Object.fromEntries(STAGE_IDS.map((s) => [s, 0])) as Record<StageId, number>;
    const stageOf = Object.fromEntries(STAGE_IDS.map((s) => [s, 0])) as Record<StageId, number>;
    const flags = Object.fromEntries(FLAG_IDS.map((f) => [f, 0])) as Record<FlagId, number>;
    let flagged = 0;
    let reviewed = 0;
    for (const r of reviews) {
      const cr = r.coaching_review as { status?: string; overall?: unknown } | null;
      if (!cr || cr.status !== 'completed' || typeof cr.overall !== 'number') continue;
      reviewed++;
      scores.push(cr.overall);
      const fw = frameworkOf(cr);
      if (fw) {
        if (fw.hit_rate != null) rates.push(fw.hit_rate);
        for (const s of STAGE_IDS) {
          const st = fw.stages[s];
          if (!st || st === 'na') continue;
          stageOf[s]++;
          stageGot[s] += st === 'hit' ? 1 : st === 'partial' ? 0.5 : 0;
        }
      }
      const ids = flagIdsOf(cr);
      if (ids.length) flagged++;
      for (const id of ids) flags[id]++;
    }
    const stageHitRates = Object.fromEntries(STAGE_IDS.map((s) => [s, stageOf[s] ? Math.round((stageGot[s] / stageOf[s]) * 100) : null])) as Record<StageId, number | null>;
    const weakStages = STAGE_IDS
      .filter((s) => stageOf[s] >= STAGE_MIN_CALLS && (stageHitRates[s] ?? 100) < 60)
      .sort((a, b) => (stageHitRates[a] ?? 0) - (stageHitRates[b] ?? 0) || stageOf[b] - stageOf[a]);

    const rp = input.roleplays.filter((r) => r.user_id === p.id && inWin(r.started_at, input.window) && (r.status ?? 'scored') !== 'abandoned');
    const rpScores = rp.map((r) => r.score).filter((n): n is number => typeof n === 'number');
    const appointmentsHeld = held.get(p.id) ?? 0;
    const contracts = p.dealsUnderContract ?? p.deals ?? 0;
    return {
      id: p.id,
      name: p.name,
      calls: p.totalCalls || p.calls || 0,
      conversations: p.conversations ?? 0,
      talkTimeS: p.totalTalkTime ?? 0,
      appointmentsSet: p.appointments ?? p.meetings ?? 0,
      appointmentsHeld,
      offersMade: p.offersMade ?? 0,
      contracts,
      contractRate: appointmentsHeld ? Math.round((contracts / appointmentsHeld) * 100) : null,
      reviewedCalls: reviewed,
      avgCallScore: mean(scores),
      stageHitRates,
      frameworkHitRate: mean(rates),
      flags,
      flaggedCalls: flagged,
      roleplaySessions: rp.length,
      avgRoleplayScore: mean(rpScores),
      weakStages,
    };
  });
}

/** Reps worth a row: anyone who called, was graded or practised. */
export const activeScorecards = (cards: RepScorecard[]) =>
  cards.filter((c) => c.calls > 0 || c.reviewedCalls > 0 || c.roleplaySessions > 0 || c.appointmentsSet > 0 || c.contracts > 0);

/**
 * Three coaching lines from the numbers alone: the weakest stages, then the
 * most common flags, then practice. The weekly email uses these when the
 * model is not available, and as the facts it hands the model.
 */
export function ruleInsights(c: RepScorecard, max = 3): string[] {
  const out: string[] = [];
  const stageLabel = (s: StageId) => FRAMEWORK_STAGES.find((x) => x.id === s)!;
  for (const s of c.weakStages) {
    if (out.length >= max) break;
    const st = stageLabel(s);
    out.push(`${st.label}: hit on ${c.stageHitRates[s]}% of calls. ${st.hint}`);
  }
  const topFlags = (Object.entries(c.flags) as [FlagId, number][]).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || FLAG_DEFS.findIndex((f) => f.id === a[0]) - FLAG_DEFS.findIndex((f) => f.id === b[0]));
  for (const [id, n] of topFlags) {
    if (out.length >= max) break;
    out.push(`${flagLabel(id)} on ${n} call${n === 1 ? '' : 's'}. ${FLAG_DEFS.find((f) => f.id === id)!.hint}`);
  }
  if (out.length < max && c.reviewedCalls > 0 && c.roleplaySessions === 0) out.push('No roleplay this period. One drill on the weakest stage before the next call block.');
  if (out.length < max && c.reviewedCalls === 0 && c.calls > 0) out.push('No call was long enough to grade. Aim for real conversations, past the first minute.');
  return out.slice(0, max);
}

export function teamTotals(cards: RepScorecard[]) {
  const sum = (k: keyof RepScorecard) => cards.reduce((a, c) => a + (typeof c[k] === 'number' ? (c[k] as number) : 0), 0);
  const scored = cards.filter((c) => c.avgCallScore != null);
  const weighted = (get: (c: RepScorecard) => number | null, w: (c: RepScorecard) => number) => {
    let n = 0;
    let d = 0;
    for (const c of cards) { const v = get(c); if (v == null || !w(c)) continue; n += v * w(c); d += w(c); }
    return d ? Math.round(n / d) : null;
  };
  return {
    reps: cards.length,
    calls: sum('calls'),
    conversations: sum('conversations'),
    reviewedCalls: sum('reviewedCalls'),
    flaggedCalls: sum('flaggedCalls'),
    appointmentsSet: sum('appointmentsSet'),
    contracts: sum('contracts'),
    roleplaySessions: sum('roleplaySessions'),
    avgCallScore: scored.length ? weighted((c) => c.avgCallScore, (c) => c.reviewedCalls) : null,
    frameworkHitRate: weighted((c) => c.frameworkHitRate, (c) => c.reviewedCalls),
  };
}

export const fmtTalk = (s: number): string => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
