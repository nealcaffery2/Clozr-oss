// Several picks in one list filter (People and Buyers: Stage, Tags, Owner,
// State...). A filter value stays one string so saved views, smart lists and
// "is anything on" checks keep working unchanged: 'Any' is off, a plain label
// is one pick (every view saved before multi-select reads as a set of one),
// and several picks are joined with a separator no label contains.

export const ANY = 'Any';
/** ASCII unit separator: never typed, never in a stage, tag or rep name. */
export const PICK_SEP = '\u001f';

/** The picks in a filter value, in the order they were made. 'Any' or nothing is none. */
export function picksOf(value: string | null | undefined): string[] {
  if (!value || value === ANY) return [];
  return value.split(PICK_SEP).filter((p) => p && p !== ANY);
}

/** A filter value for these picks: 'Any' when there are none, duplicates dropped. */
export function joinPicks(picks: readonly string[]): string {
  const out: string[] = [];
  for (const p of picks) if (p && p !== ANY && !out.includes(p)) out.push(p);
  return out.length ? out.join(PICK_SEP) : ANY;
}

/** Clicking an option in a multi-pick menu: 'Any' clears, anything else goes in or out. */
export function togglePick(value: string | null | undefined, option: string): string {
  if (option === ANY) return ANY;
  const picks = picksOf(value);
  return joinPicks(picks.includes(option) ? picks.filter((p) => p !== option) : [...picks, option]);
}

/** Is this option one of the picks (or, for 'Any', is nothing picked). */
export function isPicked(value: string | null | undefined, option: string): boolean {
  const picks = picksOf(value);
  return option === ANY ? picks.length === 0 : picks.includes(option);
}

/** Does a record's single value pass: no picks, or it is one of them. */
export function matchesPick(value: string | null | undefined, actual: string | null | undefined): boolean {
  const picks = picksOf(value);
  return !picks.length || (actual != null && picks.includes(actual));
}

/** Does a record with several values (tags, markets) pass: no picks, or it has any of them. */
export function matchesAnyPick(value: string | null | undefined, actual: readonly string[] | null | undefined): boolean {
  const picks = picksOf(value);
  return !picks.length || (!!actual && actual.some((a) => picks.includes(a)));
}

/** What the filter chip reads: the pick, "A, B", or "A +2". */
export function picksLabel(value: string | null | undefined, max = 2): string {
  const picks = picksOf(value);
  if (!picks.length) return ANY;
  if (picks.length <= max) return picks.join(', ');
  return `${picks[0]} +${picks.length - 1}`;
}

/** Keep only picks that are still options (a saved view may name a stage since renamed). */
export function keepPicks(value: string | null | undefined, options: readonly string[]): string {
  return joinPicks(picksOf(value).filter((p) => options.includes(p)));
}
