/**
 * Telnyx account balance and top-ups: the rules, kept free of I/O so
 * `_shared/telnyx-billing.test.ts` covers them. The HTTP lives in
 * supabase/functions/telnyx-billing.
 */

/** Smallest and largest single top-up CLOZR will charge. */
export const MIN_TOPUP = 10;
export const MAX_TOPUP = 500;

/** "25" / "25.5" / "$25.00" → "25.00", or an error a person can act on. */
export function topupAmount(raw: unknown): { amount: string } | { error: string } {
  const n = Number(String(raw ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { error: 'Enter an amount in dollars.' };
  if (Math.round(n * 100) !== n * 100) return { error: 'Use dollars and cents, like 25 or 25.50.' };
  if (n < MIN_TOPUP) return { error: `The smallest top-up is $${MIN_TOPUP}.` };
  if (n > MAX_TOPUP) return { error: `The largest top-up from CLOZR is $${MAX_TOPUP}. Add more at portal.telnyx.com → Billing.` };
  return { amount: n.toFixed(2) };
}

export type Balance = { balance: number; available: number; creditLimit: number; pending: number; currency: string };

/** Telnyx GET /v2/balance `data` → numbers. Amounts arrive as strings. */
export function readBalance(data: unknown): Balance | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  if (d.balance === undefined && d.available_credit === undefined) return null;
  return {
    balance: num(d.balance),
    available: num(d.available_credit ?? d.balance),
    creditLimit: num(d.credit_limit),
    pending: num(d.pending),
    currency: typeof d.currency === 'string' && d.currency ? d.currency : 'USD',
  };
}
