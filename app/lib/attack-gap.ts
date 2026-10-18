// How our number sits against what they are asking.
// Asking $100k and we can offer $120k is a +$20k gap: room to attack the deal.
// A negative gap is how far short we are. Null when either number is missing,
// so a deal with no ask does not read as a $0 gap.

import { shortMoney } from './people-stack';

export const GAP_CHOICES = ['Any', 'At or above their ask', 'Within $5k', 'Within $10k', 'Within $20k', 'Within $50k'] as const;
export const GAP_BASIS = ['Our offer', 'UW high'] as const;

const WITHIN: Record<string, number> = {
  'Within $5k': 5_000, 'Within $10k': 10_000, 'Within $20k': 20_000, 'Within $50k': 50_000,
};

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Our number minus their ask. Positive: we can pay more than they want. */
export function room(ours: number | null | undefined, ask: number | null | undefined): number | null {
  if (!positive(ours) || !positive(ask)) return null;
  return ours - ask;
}

/** A gap choice. 'Any' matches every deal, including ones with no numbers. */
export function gapPasses(dollars: number | null, choice: string | undefined): boolean {
  if (!choice || choice === 'Any') return true;
  if (dollars == null) return false;
  if (choice === 'At or above their ask') return dollars >= 0;
  const within = WITHIN[choice];
  return within == null ? true : Math.abs(dollars) <= within;
}

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + shortMoney(Math.abs(n));
const full = (n: number) => (n < 0 ? '−' : n > 0 ? '+' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

/** One line for a deal card. Null when there is no ask, or no offer and no underwriter high. */
export function gapLine(ask: number | null | undefined, offer: number | null | undefined, high: number | null | undefined): string | null {
  if (!positive(ask)) return null;
  const parts: string[] = [];
  const o = room(offer, ask);
  const h = room(high, ask);
  if (o != null) parts.push(`Offer ${signed(o)}`);
  if (h != null) parts.push(`UW high ${signed(h)}`);
  return parts.length ? `Ask ${shortMoney(ask)} · ${parts.join(' · ')}` : null;
}

/** The same numbers in full dollars, for the card's tooltip. */
export function gapTitle(ask: number | null | undefined, offer: number | null | undefined, high: number | null | undefined): string {
  if (!positive(ask)) return '';
  const bits = [`Asking $${Math.round(ask).toLocaleString('en-US')}`];
  const o = room(offer, ask);
  const h = room(high, ask);
  if (o != null && positive(offer)) bits.push(`our offer $${Math.round(offer).toLocaleString('en-US')} (${full(o)})`);
  if (h != null && positive(high)) bits.push(`underwriter high $${Math.round(high).toLocaleString('en-US')} (${full(h)})`);
  return bits.join('. ');
}

/** True when at least one gap is room we have, not a shortfall. */
export function gapUp(ask: number | null | undefined, offer: number | null | undefined, high: number | null | undefined): boolean {
  const o = room(offer, ask);
  const h = room(high, ask);
  return (o != null && o >= 0) || (h != null && h >= 0);
}
