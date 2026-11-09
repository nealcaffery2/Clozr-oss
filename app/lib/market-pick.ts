// People's State and Market filters, and the Top 25% deal cut.
// A market reads "Anderson, SC" (lib/place-names dealMarketLabel); the state
// filter narrows which markets the Market menu offers. Top 25% keeps the best
// quarter of the rows the other filters left, by spread (lib/attack-gap room).

import { STATE_NAMES } from './market-geo';
import { stateCodeOf } from './place-names';

/** The Deal quality filter's one setting. */
export const TOP_QUARTILE = 'Top 25%';

/** "Anderson, SC" → "SC"; a bare state ("SC", "South Carolina") is itself; null when none. */
export function marketStateCode(market: string | null | undefined): string | null {
  const m = String(market ?? '').trim();
  if (!m || m === '—') return null;
  return stateCodeOf(m.split(',').pop()) ?? stateCodeOf(m);
}

/** The State menu: every state the markets (or bare states, "TX") name, by name, A to Z. */
export function stateOptions(markets: readonly (string | null | undefined)[]): string[] {
  const codes = new Set(markets.map(marketStateCode).filter((c): c is string => !!c));
  return [...codes].map((c) => STATE_NAMES[c] ?? c).sort((a, b) => a.localeCompare(b));
}

/** The Market menu: the markets inside the picked states (all of them with none picked). */
export function marketsInStates(markets: readonly string[], states: readonly string[]): string[] {
  const want = new Set(states.map((s) => stateCodeOf(s)).filter(Boolean));
  return want.size ? markets.filter((m) => want.has(marketStateCode(m))) : [...markets];
}

/** Type-to-find over a menu's options: "anderson" finds "Anderson, SC". */
export function searchOptions(options: readonly string[], q: string): string[] {
  const needle = q.trim().toLowerCase();
  return needle ? options.filter((o) => o.toLowerCase().includes(needle)) : [...options];
}

/**
 * The best quarter of `rows` by `score`, best first. Rows with no score are
 * out (no ask or no number is not a deal to rank); a list of 1 to 4 scored rows
 * keeps its best one.
 */
export function topQuartile<T>(rows: readonly T[], score: (r: T) => number | null | undefined): T[] {
  const scored = rows.map((r) => ({ r, s: score(r) })).filter((x): x is { r: T; s: number } => x.s != null && Number.isFinite(x.s));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, Math.ceil(scored.length / 4)).map((x) => x.r);
}
