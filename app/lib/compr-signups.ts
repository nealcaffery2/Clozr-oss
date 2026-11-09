// Not part of the open-source build: the hosted CLOZR workspace for the
// underwriting product uses this. Inert stand-in with the same exports.

export type ComprSignup = { buyer_id: number; tier: string | null; status: string | null; paid_cents: number | null; signed_up_at: string; trial_ends_at: string | null; runs: number; [k: string]: unknown };
export type ComprBillingFlag = { label: string; tone: string } | null;
export type ComprReport = { id: string; url: string };
export const COMPR_PLAN_FILTERS: readonly string[] = [];
export const comprBillingFlag = (_s: ComprSignup): ComprBillingFlag => null;
export const comprPlanBucket = (_s: ComprSignup | undefined): string => '';
export const comprReportUrl = (_r: ComprReport): string => '';
export const comprStatusLabel = (_s: ComprSignup): string => '';
export const paidLabel = (cents: number): string => `$${Math.round(cents / 100)}`;
export const planLabel = (tier: string | null): string => tier ?? '';
export const trialLeft = (_s: ComprSignup): number | null => null;
export function useComprSignups(_workspaceId: number | null, _on: boolean): Map<number, ComprSignup> {
  return new Map();
}
