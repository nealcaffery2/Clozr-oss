// Option period countdown. Seller option lives on deals.option_ends_on.
// Buyer option lives on deals.buyer_option_ends_on. Both boards read the
// same readout, and the hourly scan uses the same three-day window.

export const OPTION_RISK_DAYS = 3;

export type OptionSide = 'seller' | 'buyer';

export type OptionReadout = {
  side: OptionSide;
  /** Calendar days until the date, in America/Chicago. Negative means it has passed. */
  days: number;
  endsOn: string;
  atRisk: boolean;
  /** "Seller option · Sep 28 · 2d left" */
  label: string;
  title: string;
};

/** Today as YYYY-MM-DD in America/Chicago. */
export function chicagoToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function daysUntil(endsOn: string | null | undefined, now = new Date()): number | null {
  if (!endsOn) return null;
  const end = String(endsOn).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const a = Date.parse(end + 'T12:00:00Z');
  const b = Date.parse(chicagoToday(now) + 'T12:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

function shortDate(iso: string): string {
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function one(side: OptionSide, endsOn: string | null | undefined, now: Date): OptionReadout | null {
  const days = daysUntil(endsOn, now);
  if (days == null || !endsOn) return null;
  const who = side === 'seller' ? 'Seller option' : 'Buyer option';
  const when = shortDate(endsOn);
  const left = days < 0 ? `expired ${Math.abs(days)}d` : days === 0 ? 'ends today' : `${days}d left`;
  return {
    side, days, endsOn: endsOn.slice(0, 10), atRisk: days <= OPTION_RISK_DAYS,
    label: `${who} · ${when} · ${left}`,
    title: `${who} ends ${when}. ${days < 0 ? 'The option period has passed.' : days === 0 ? 'It ends today.' : `${days} day${days === 1 ? '' : 's'} left.`}`,
  };
}

export function optionReadouts(
  sellerEnds: string | null | undefined,
  buyerEnds: string | null | undefined,
  now = new Date(),
): OptionReadout[] {
  return [one('seller', sellerEnds, now), one('buyer', buyerEnds, now)].filter((x): x is OptionReadout => !!x);
}

export function optionAtRisk(sellerEnds: string | null | undefined, buyerEnds: string | null | undefined, now = new Date()): boolean {
  return optionReadouts(sellerEnds, buyerEnds, now).some((r) => r.atRisk);
}

/**
 * Who hears that an option is about to run out.
 * Seller contract: the acquisitions rep on that deal, and the TC.
 * Buyer contract: the dispositions rep on that deal, and the TC.
 * An amendment that moves the date starts a new window; a termination clears it.
 */
export function optionAlertAudience(side: OptionSide): { dealParty: 'acquisitions' | 'dispositions'; includeTc: true } {
  return side === 'seller'
    ? { dealParty: 'acquisitions', includeTc: true }
    : { dealParty: 'dispositions', includeTc: true };
}
