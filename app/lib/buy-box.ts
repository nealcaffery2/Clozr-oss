// Example buy box: the states you buy in with each state's max purchase
// price, and per market the smallest house you take (beds, baths, square feet,
// year built). A market with two rows is two acceptable shapes: a house passes
// on either. Markets with no row inherit nothing: a house in a listed state but
// an unlisted city is judged on price alone. Replace EXAMPLE_BUY_BOX with yours.
//
// Used by People > Submissions "Outside of buy box" (lib/submission-views.ts)
// through buyBoxVerdict().

export type BuyBoxShape = { beds: number; baths: number; sqft: number; year: number };
export type BuyBoxMarket = { name: string; shapes: BuyBoxShape[]; max?: number };
export type BuyBoxState = { max: number; markets: BuyBoxMarket[] };

const s = (beds: number, baths: number, sqft: number, year: number): BuyBoxShape => ({ beds, baths, sqft, year });
const m = (name: string, shapes: BuyBoxShape[], max?: number): BuyBoxMarket => (max ? { name, shapes, max } : { name, shapes });

/** Keyed by the two-letter state. */
export const EXAMPLE_BUY_BOX: Record<string, BuyBoxState> = {
  TX: { max: 300_000, markets: [m('Example City', [s(3, 2, 1200, 1960), s(2, 1.5, 1000, 1980)])] },
  OK: { max: 200_000, markets: [m('Sample Town', [s(3, 1, 1000, 1950)])] },
};

export type BuyBoxVerdict = { fit: 'in' | 'out' | 'unknown'; why: string };

const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/** The market row for a city, by name inside the city line ("Ft. Worth" matches Fort Worth through "worth"). */
function marketFor(state: BuyBoxState, city: string): BuyBoxMarket | null {
  const c = norm(city);
  if (!c) return null;
  return state.markets.find((mk) => { const n = norm(mk.name); return c === n || c.includes(n) || n.includes(c); }) ?? null;
}

/**
 * Whether a house fits the buy box. `unknown` when the state is blank or the
 * house has no numbers to judge; `out` names the first rule it fails.
 */
export function buyBoxVerdict(
  house: { st?: string | null; city?: string | null; beds?: number | null; baths?: number | null; sqft?: number | null; year?: number | null },
  asking: number | null | undefined,
): BuyBoxVerdict {
  const st = (house.st ?? '').trim().toUpperCase();
  if (!st) return { fit: 'unknown', why: 'No state on the property.' };
  const state = EXAMPLE_BUY_BOX[st];
  if (!state) return { fit: 'out', why: `${st} is not a buy box state.` };
  const market = marketFor(state, house.city ?? '');
  const max = market?.max ?? state.max;
  if (asking != null && asking > max) return { fit: 'out', why: `Asking $${Math.round(asking).toLocaleString('en-US')} is over the ${market?.name ?? st} max of $${max.toLocaleString('en-US')}.` };
  if (!market) return { fit: asking != null ? 'in' : 'unknown', why: asking != null ? `Under the ${st} max; ${house.city || 'the city'} is not a listed market.` : 'No listed market and no asking price.' };
  const known = [house.beds, house.baths, house.sqft, house.year].some((n) => typeof n === 'number' && n > 0);
  if (!known) return { fit: asking != null ? 'in' : 'unknown', why: `No beds, baths, sqft or year to check against ${market.name}.` };
  const fails = (sh: BuyBoxShape): string | null => {
    if (house.beds != null && house.beds > 0 && house.beds < sh.beds) return `${house.beds} bed, ${market.name} wants ${sh.beds}+`;
    if (house.baths != null && house.baths > 0 && house.baths < sh.baths) return `${house.baths} bath, ${market.name} wants ${sh.baths}+`;
    if (sh.sqft && house.sqft != null && house.sqft > 0 && house.sqft < sh.sqft) return `${house.sqft.toLocaleString('en-US')} sqft, ${market.name} wants ${sh.sqft.toLocaleString('en-US')}+`;
    if (house.year != null && house.year > 0 && house.year < sh.year) return `Built ${house.year}, ${market.name} wants ${sh.year}+`;
    return null;
  };
  const reasons = market.shapes.map(fails);
  const ok = reasons.indexOf(null);
  if (ok >= 0) return { fit: 'in', why: `Fits ${market.name}.` };
  return { fit: 'out', why: reasons[0] + '.' };
}

export const BUY_BOX_FILTER = ['Any', 'In buy box', 'Outside buy box'] as const;
