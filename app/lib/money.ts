// Dollars as people type them, into a number or a reason it is not one.
//
// Every money input in the app reads through here: "$185,000", "185k",
// "1.25m" and "185000" are the same number, and "abc" is an error the field
// shows under itself, never a silent 0 or a silently cleared value. Call
// transcripts keep their own looser reader (useTalkrPhone.parseMoney), which
// has to cope with words like "one eighty five".

export type Dollars = { value: number | null; error?: string };

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000 };

/**
 * `raw` → whole dollars (cents kept when typed). Blank is `{ value: null }`
 * with no error: an empty field means "no number", which is a valid answer.
 * Negative amounts are refused; nothing in the CRM is a negative price.
 */
export function parseDollars(raw: string | number | null | undefined): Dollars {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? { value: raw } : { value: null, error: 'Enter a dollar amount, like 185,000 or 185k' };
  }
  const t = raw.trim().toLowerCase().replace(/[\s$,]/g, '').replace(/^usd/, '').replace(/usd$/, '');
  if (!t) return raw.trim() ? { value: null, error: 'Enter a dollar amount, like 185,000 or 185k' } : { value: null };
  const m = /^(\d+(?:\.\d+)?|\.\d+)([km])?$/.exec(t);
  if (!m) return { value: null, error: /^-/.test(t) ? 'Amounts can’t be negative' : 'Enter a dollar amount, like 185,000 or 185k' };
  const n = Number(m[1]) * (m[2] ? SUFFIX[m[2]] : 1);
  if (!Number.isFinite(n)) return { value: null, error: 'That number is too large' };
  // 1.25m is exactly 1,250,000; float noise never reaches the database.
  return { value: Math.round(n * 100) / 100 };
}

/**
 * "150,000 - 175,000", "150k–175k", "$150k to $175k" → both ends. One number
 * is a range of one. The low end must not be above the high end.
 */
export function parseDollarRange(raw: string | null | undefined): { low: number | null; high: number | null; error?: string } {
  const t = (raw ?? '').trim();
  if (!t) return { low: null, high: null };
  // A leading minus would otherwise read as a separator with nothing before it.
  if (/^-/.test(t)) return { low: null, high: null, error: 'Amounts can’t be negative' };
  const parts = t.split(/\s*(?:–|—|\bto\b|-(?=\s*\$?\s*\d))\s*/i).filter((p) => p.trim() !== '');
  if (parts.length > 2) return { low: null, high: null, error: 'Enter one amount or a range, like 150k – 175k' };
  const a = parseDollars(parts[0]);
  if (a.error) return { low: null, high: null, error: a.error };
  if (parts.length === 1) return { low: a.value, high: a.value };
  const b = parseDollars(parts[1]);
  if (b.error) return { low: null, high: null, error: b.error };
  if (a.value !== null && b.value !== null && a.value > b.value) return { low: null, high: null, error: 'The low end is above the high end' };
  return { low: a.value, high: b.value };
}

/** 185000 → "$185,000"; null → "". The display half of parseDollars. */
export function formatDollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}
