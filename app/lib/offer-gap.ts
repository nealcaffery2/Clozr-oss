// How far an ask sat above what we offered, for the People gap filters.
// Pure, so tools/offer-gap.test.ts can pin the arithmetic.

export type GapBasis = 'Either' | 'Actual offer' | 'UW high';
export type GapInput = { ask: number; offer: number; high: number | null };

export const GAP_WITHIN: Record<string, number> = {
  'Within $5k': 5_000, 'Within $10k': 10_000, 'Within $20k': 20_000, 'Within $50k': 50_000, 'Any gap': Infinity,
};
export const DEFAULT_GAP_WITHIN = 'Within $20k';
export const DEFAULT_GAP_BASIS: GapBasis = 'Either';

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Dollars between the ask and the number on `basis`, never below zero: an
 * offer at or above the ask closed the gap, it did not open one the other
 * way (the old Math.abs turned a $30k overbid into a $30k miss). Null when
 * that basis has no number: no ask, no offer, or no underwriting ceiling for
 * 'UW high', so the deal drops out rather than counting as a zero gap.
 */
export function gapOf(g: GapInput, basis: string | undefined): number | null {
  if (!positive(g.ask)) return null;
  const toOffer = positive(g.offer) ? Math.max(0, g.ask - g.offer) : null;
  const toHigh = positive(g.high) ? Math.max(0, g.ask - g.high) : null;
  if (basis === 'Actual offer') return toOffer;
  if (basis === 'UW high') return toHigh;
  if (toOffer == null) return toHigh;
  if (toHigh == null) return toOffer;
  return Math.min(toOffer, toHigh);
}

/** The threshold a "Close is" label stands for; an unknown label reads as the default. */
export const withinOf = (label: string | undefined) => GAP_WITHIN[label ?? DEFAULT_GAP_WITHIN] ?? GAP_WITHIN[DEFAULT_GAP_WITHIN];

/**
 * How many close calls a filter asks for. "Close calls: Any" used to switch
 * the whole gap filter off, so picking a basis or a "Close is" threshold on
 * its own changed nothing on screen. Moving either off its default now means
 * "at least one offer that close".
 */
export function closeCallsNeeded(f: { closeCalls?: string; gapBasis?: string; gapWithin?: string }): number {
  const n = f.closeCalls && f.closeCalls !== 'Any' ? Number(f.closeCalls.replace('+', '')) || 0 : 0;
  if (n) return n;
  const touched = (f.gapBasis && f.gapBasis !== DEFAULT_GAP_BASIS) || (f.gapWithin && f.gapWithin !== DEFAULT_GAP_WITHIN);
  return touched ? 1 : 0;
}
