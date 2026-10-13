/**
 * Rotation for the RVM number pool: when a line goes bad it leaves the pool,
 * and a replacement is bought only when the workspace allows it.
 *
 * A line goes bad on any one of:
 *   spam_label   the worse of Talkr's and the carrier's spam verdict is high
 *                (or medium, when settings.rvm_pool.replace.retire_on is 'medium')
 *   reputation   the number guard graded it At risk, or paused it
 *   registry     Free Caller Registry refused it (fcr_status failed)
 *   attestation  fewer than min_attestation_a of its last 7 days' calls were
 *                signed A (STIR/SHAKEN), over at least 20 calls
 *
 * A retired line stays on the carrier: callbacks to it still ring and are
 * still credited to their drop (migration 196). It just carries no new drops.
 *
 * Buying is governed by settings.rvm_pool.replace:
 *   mode 'off' (the default)  nothing is bought; admins are told what retired
 *   mode 'approve'            an admin approves each purchase in the RVM tab
 *   mode 'auto'               bought straight away
 * and in every mode never more than monthly_cap purchases a calendar month
 * (0 or unset means none). Imported by supabase/functions/rvm-pool under Deno.
 */

import { areaCodeOf } from './rvm.ts';
import { areaCodesOfState, stateCode2, stateOfPhone, worseRisk, type RvmPoolSettings } from './rvm-pool.ts';

export type RotationReason = 'spam_label' | 'reputation' | 'registry' | 'attestation';

export const ROTATION_REASON_LABEL: Record<RotationReason, string> = {
  spam_label: 'carriers label it spam',
  reputation: 'the number guard graded it at risk or paused it',
  registry: 'Free Caller Registry refused it',
  attestation: 'too few of its calls are signed A (STIR/SHAKEN)',
};

export type RotationLine = {
  phone_e164: string;
  market_state?: string | null;
  spam_risk?: string | null;
  fcr_status?: string | null;
  retired_at?: string | null;
};

export type RotationHealth = {
  paused?: boolean | null;
  grade?: string | null;
  spam_risk?: string | null;
  attestation_a_7d?: number | string | null;
  attestation_calls_7d?: number | null;
};

export type RotationPolicy = {
  /** 'high' (default) or 'medium': the spam verdict that retires a line. */
  retireOn: 'high' | 'medium';
  /** The number guard's floor for the share of A-signed calls. */
  minAttestationA: number;
  /** Calls in 7 days before the attestation share counts. */
  minAttestationCalls: number;
};

export const DEFAULT_ROTATION_POLICY: RotationPolicy = { retireOn: 'high', minAttestationA: 0.9, minAttestationCalls: 20 };

export function rotationPolicy(pool: RvmPoolSettings | null | undefined, guard: { min_attestation_a?: number | null } | null | undefined): RotationPolicy {
  const floor = Number(guard?.min_attestation_a);
  return {
    retireOn: pool?.replace?.retire_on === 'medium' ? 'medium' : 'high',
    minAttestationA: Number.isFinite(floor) && floor > 0 && floor <= 1 ? floor : DEFAULT_ROTATION_POLICY.minAttestationA,
    minAttestationCalls: DEFAULT_ROTATION_POLICY.minAttestationCalls,
  };
}

/** Why this line should leave the pool; empty when it is fine (or already retired). */
export function lineVerdict(line: RotationLine, health: RotationHealth | null | undefined, policy: RotationPolicy = DEFAULT_ROTATION_POLICY): RotationReason[] {
  if (line.retired_at) return [];
  const out: RotationReason[] = [];
  const risk = worseRisk(health?.spam_risk, line.spam_risk);
  if (risk === 'high' || (risk === 'medium' && policy.retireOn === 'medium')) out.push('spam_label');
  const grade = String(health?.grade ?? '').toLowerCase();
  if (health?.paused || grade === 'at_risk' || grade === 'poor') out.push('reputation');
  if (line.fcr_status === 'failed') out.push('registry');
  const calls = Number(health?.attestation_calls_7d ?? 0);
  const share = Number(health?.attestation_a_7d);
  if (calls >= policy.minAttestationCalls && Number.isFinite(share) && share < policy.minAttestationA) out.push('attestation');
  return out;
}

export function reasonsSentence(reasons: readonly RotationReason[]): string {
  return reasons.map((r) => ROTATION_REASON_LABEL[r]).join('; ');
}

export type ReplaceMode = 'off' | 'approve' | 'auto';

export type ReplaceSettings = { mode: ReplaceMode; monthlyCap: number };

export function replaceSettings(pool: RvmPoolSettings | null | undefined): ReplaceSettings {
  const mode = pool?.replace?.mode;
  const cap = Math.floor(Number(pool?.replace?.monthly_cap ?? 0));
  return { mode: mode === 'approve' || mode === 'auto' ? mode : 'off', monthlyCap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, 50) : 0 };
}

export type ReplaceDecision =
  | { action: 'buy' }
  | { action: 'request' }
  | { action: 'skip'; why: 'off' | 'cap' };

/**
 * What to do about one retired line, given what has already been bought (and
 * asked for) this month. `spent` counts purchases this month plus open
 * requests, so approving every open request still cannot pass the cap.
 */
export function replaceDecision(settings: ReplaceSettings, spent: number): ReplaceDecision {
  if (settings.mode === 'off') return { action: 'skip', why: 'off' };
  if (spent >= settings.monthlyCap) return { action: 'skip', why: 'cap' };
  return settings.mode === 'auto' ? { action: 'buy' } : { action: 'request' };
}

/**
 * Area codes to search for a replacement, best first: the retired line's own,
 * then the rest of its market state's, so an SC line is replaced by an SC line.
 */
export function replacementAreaCodes(line: Pick<RotationLine, 'phone_e164' | 'market_state'>): string[] {
  const own = areaCodeOf(line.phone_e164);
  const state = stateCode2(line.market_state) ?? stateOfPhone(line.phone_e164);
  const out: string[] = [];
  if (own) out.push(own);
  for (const c of areaCodesOfState(state)) if (!out.includes(c)) out.push(c);
  return out.slice(0, 12);
}

/** "2026-10": the calendar month a purchase counts against, in Acme Homes' zone. */
export function capMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
