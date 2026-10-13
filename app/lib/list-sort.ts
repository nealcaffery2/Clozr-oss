/** Shared list sorting for Buyers, People and Deals. */

export type SortDir = 'asc' | 'desc';

/** "Sep 26, 2026". Empty when the timestamp is missing. */
export function addedOn(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A display cell turned into something that sorts: money and plain numbers as numbers, blanks as empty. */
export function sortToken(v: string | number | null | undefined): string | number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  const t = String(v ?? '').trim();
  if (!t || t === '—') return '';
  const n = Number(t.replace(/[$,]/g, ''));
  if (/^-?\$?[\d,]+(\.\d+)?%?$/.test(t) && Number.isFinite(n)) return n;
  return t;
}

/** Blanks stay at the bottom in either direction. */
export function cmpSort(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  const blank = (v: string | number | null | undefined) => v == null || v === '';
  const av = typeof a === 'number' ? a : sortToken(a);
  const bv = typeof b === 'number' ? b : sortToken(b);
  if (blank(av) && blank(bv)) return 0;
  if (blank(av)) return 1;
  if (blank(bv)) return -1;
  const mul = dir === 'asc' ? 1 : -1;
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * mul;
}

export function toggleSort<T extends { key: string; dir: SortDir }>(current: T, key: string, firstDir: SortDir): T {
  if (current.key !== key) return { ...current, key, dir: firstDir };
  return { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * The ids a record's arrows walk, in the order the list showed them. `sorted`
 * is what the list screen last drew; `ids` is who is in the list now, which
 * can have changed since (a buyer added, one archived). Anyone the screen did
 * not draw goes at the end in their own order, so nobody becomes unreachable.
 */
export function inDrawnOrder(ids: readonly string[], sorted: readonly string[]): string[] {
  const here = new Set(ids);
  const placed = Array.from(new Set(sorted.filter((id) => here.has(id))));
  if (placed.length === here.size) return placed;
  const drawn = new Set(placed);
  return [...placed, ...ids.filter((id) => !drawn.has(id))];
}

/** People column click → the sort label stored on the list. Null when that column does not sort. */
export function peopleColumnSort(current: string, column: string): string | null {
  switch (column) {
    case 'created': return current === 'Date added' ? 'Oldest added' : 'Date added';
    case 'name': return 'Name';
    case 'stage': return 'Stage';
    case 'score': return 'Lead score';
    case 'lastComm': return current === 'Recent' ? 'Oldest' : 'Recent';
    // Highest first: the question is "who sent us the most", not the fewest.
    case 'arv': return 'ARV (high to low)';
    case 'offer': return 'Offer (high to low)';
    case 'market': return 'Market (A to Z)';
    case 'subs': return 'Most submissions';
    case 'props': return 'Most properties';
    case 'stack': return 'Largest list stack';
    default: return null;
  }
}

/** Which column header shows the arrow for the current People sort. */
export function peopleSortColumn(sort: string): { key: string; dir: SortDir } | null {
  switch (sort) {
    case 'Date added': return { key: 'created', dir: 'desc' };
    case 'Oldest added': return { key: 'created', dir: 'asc' };
    case 'Name': return { key: 'name', dir: 'asc' };
    case 'Stage': return { key: 'stage', dir: 'asc' };
    case 'Lead score': return { key: 'score', dir: 'desc' };
    case 'Recent': return { key: 'lastComm', dir: 'desc' };
    case 'Oldest': return { key: 'lastComm', dir: 'asc' };
    case 'ARV (high to low)': return { key: 'arv', dir: 'desc' };
    case 'Offer (high to low)': return { key: 'offer', dir: 'desc' };
    case 'Market (A to Z)': return { key: 'market', dir: 'asc' };
    case 'Most submissions': return { key: 'subs', dir: 'desc' };
    case 'Most properties': return { key: 'props', dir: 'desc' };
    case 'Largest list stack': return { key: 'stack', dir: 'desc' };
    default: return null;
  }
}
