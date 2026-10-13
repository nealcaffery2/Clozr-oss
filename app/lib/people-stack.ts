// List stacking and money ranges for the People filters.
//
// Stacking is how often a contact shows up: deals they have sent (Offerpad
// has sent 881), properties they hold, and lists they are on. A seller tagged
// Pre-foreclosure, Probate and Tax delinquent stacks 3. Bookkeeping tags are
// not lists: the Podio import marks every row "Podio submission", the merge
// marks "Multiple sources", and a partner carries its own company name.

export const MONEY_BUCKETS = ['Any', 'Under $100k', '$100k–$200k', '$200k–$300k', '$300k–$500k', '$500k+', 'Custom'];
export const SUBMISSION_STEPS = ['Any', '2+', '5+', '10+', '25+', '100+'];
export const PROPERTY_STEPS = ['Any', '2+', '3+', '5+', '10+'];
export const STACK_STEPS = ['Any', '1+', '2+', '3+', '4+', '5+'];
export const HISTORY_WHEN = ['Ever', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'This year', 'Custom'];

/** "$150,000", "150k", "1.2m" → dollars; anything else → null. */
export function parseDollars(v: string | undefined | null): number | null {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([km])?$/i.exec((v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  return Math.round(unit === 'k' ? n * 1e3 : unit === 'm' ? n * 1e6 : n);
}

/** The [min, max) a money filter asks for, or null when it asks for nothing. */
export function moneyRange(bucket: string | undefined, min?: string, max?: string): [number, number] | null {
  switch (bucket) {
    case 'Under $100k': return [0, 100_000];
    case '$100k–$200k': return [100_000, 200_000];
    case '$200k–$300k': return [200_000, 300_000];
    case '$300k–$500k': return [300_000, 500_000];
    case '$500k+': return [500_000, Infinity];
    case 'Custom': {
      const lo = parseDollars(min);
      const hi = parseDollars(max);
      return lo == null && hi == null ? null : [lo ?? 0, hi == null ? Infinity : hi + 1];
    }
    default: return null;
  }
}

/** Any of the values inside the range. A contact with no figure is outside every range. */
export const anyInRange = (values: number[], r: [number, number]) => values.some((v) => v >= r[0] && v < r[1]);

/** '5+' → 5; 'Any' or unset → 0. */
export const atLeastOf = (v: string | undefined) => (v && v !== 'Any' ? Number(v.replace('+', '')) || 0 : 0);

const NOT_LISTS = /^(podio submission|podio deal|multiple sources|dead|long-term|secret-blacklist|merged-into-.*|dm-prospect|deal-machine|deal_machine)$/i;

/** How many lists a contact is on: distinct tags, less bookkeeping and their own name or source. */
export function listStack(tags: string[], name: string, source: string): number {
  const own = new Set([name, source].map((x) => (x ?? '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  for (const t of tags) {
    const k = t.trim().toLowerCase();
    if (!k || NOT_LISTS.test(k) || own.has(k)) continue;
    seen.add(k);
  }
  return seen.size;
}

/** $123,456 → "$123k"; $1,250,000 → "$1.25m". For narrow columns. */
export function shortMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'm';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}
