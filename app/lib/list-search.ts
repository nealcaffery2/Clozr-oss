// The People and Buyers search boxes. Each row gets its search text built
// once (a "key"), and a query is read once per search, so matching 11,000
// buyers is a few substring checks a row rather than joining and lowercasing
// every field on every keystroke.
//
// What it does that one lowercase `includes` did not:
// - every word must hit, in any field and any order ("smith dallas");
// - case, accents and punctuation are ignored ("O'Brien" finds "obrien");
// - phones match on digits, so "(214) 555", "214-555" and "214555" all hit;
// - names that equal or start with the query rank first.

export type SearchKey = {
  /** Every searchable field, normalized, space-separated and padded with spaces. */
  hay: string;
  /** The names a row is known by (person, company), normalized, for ranking. */
  names: string[];
};

export type SearchQuery = {
  /** The query normalized, e.g. "john smith". */
  phrase: string;
  /** Its words; each must appear in the row. */
  terms: string[];
  /** A phone typed with punctuation ("(214) 555-12") as bare digits, else null. */
  digits: string | null;
};

type Field = string | null | undefined;

/** Lowercase, accents off, apostrophes dropped, other punctuation to spaces. */
export function normSearch(s: Field): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A row's search key. `names` rank; `fields` only match; `phones` also match
 * on their bare digits so a number typed any way finds them.
 */
export function searchKey(names: Field[], fields: Field[], phones: Field[] = []): SearchKey {
  const n = names.map(normSearch).filter(Boolean);
  const parts = [...n, ...fields.map(normSearch), ...phones.map(normSearch)].filter(Boolean);
  for (const p of phones) {
    const d = (p ?? '').replace(/\D/g, '');
    if (d.length >= 3) parts.push(d);
  }
  return { hay: ' ' + parts.join(' ') + ' ', names: n };
}

/** Read a query once. Null for a blank one (show everything). */
export function parseSearch(q: string): SearchQuery | null {
  const phrase = normSearch(q);
  if (!phrase) return null;
  const terms = phrase.split(' ');
  const raw = q.trim();
  const d = raw.replace(/\D/g, '');
  // Only digits and phone punctuation: also try it as one run of digits.
  const digits = terms.length > 1 && d.length >= 3 && /^[\d\s()+.\-]+$/.test(raw) ? d : null;
  return { phrase, terms, digits };
}

/**
 * How well a row matches: -1 not at all, else lower is better.
 * 0 a name is the query, 1 a name starts with it, 2 a word in a name starts
 * with it, 3 every word starts a word of one name, 4 it matched elsewhere
 * (phone, email, address, tag…).
 */
export function searchRank(key: SearchKey, q: SearchQuery): number {
  const hit = q.terms.every((t) => key.hay.includes(t)) || (q.digits != null && key.hay.includes(q.digits));
  if (!hit) return -1;
  let best = 4;
  for (const n of key.names) {
    if (n === q.phrase) return 0;
    const padded = ' ' + n;
    if (n.startsWith(q.phrase)) best = Math.min(best, 1);
    else if (padded.includes(' ' + q.phrase)) best = Math.min(best, 2);
    else if (q.terms.every((t) => padded.includes(' ' + t))) best = Math.min(best, 3);
  }
  return best;
}

/**
 * The rows that match, best first; rows that rank the same keep the order
 * they came in (the list's own sort). A blank query returns `rows` as is.
 */
export function searchRows<T>(rows: T[], keyOf: (row: T) => SearchKey, q: SearchQuery | null): T[] {
  if (!q) return rows;
  const hits: { row: T; rank: number; at: number }[] = [];
  rows.forEach((row, at) => {
    const rank = searchRank(keyOf(row), q);
    if (rank >= 0) hits.push({ row, rank, at });
  });
  hits.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return hits.map((h) => h.row);
}
