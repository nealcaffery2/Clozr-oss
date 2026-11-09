/**
 * Caller ID health: what the dialer's rotation did with the org's lines over
 * the last seven days, read from Talkr history the way lib/caller-spin.ts
 * reads it (outbound calls, `from_number` per call). Pure, so
 * tools/caller-health.test.ts covers the arithmetic.
 */

import { canonE164 } from './caller-spin';
import { areaCodeOf } from './rvm';

export type HealthCall = { at: string; from_number: string; to_number: string; user_id: string | null };

export type LineLoad = { today: number; week: number };

/** Local midnight of `now`, as a timestamp. Talkr's "today" follows the org zone; this follows the browser, close enough for a load bar. */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Outbound calls per line, today and over the whole window. A line with no calls reads 0, never missing. */
export function lineLoads(
  lines: readonly { id: string; phone_e164: string }[],
  calls: readonly HealthCall[],
  now = Date.now(),
): Record<string, LineLoad> {
  const byE164 = new Map(lines.map((l) => [canonE164(l.phone_e164), l.id]));
  const out: Record<string, LineLoad> = {};
  for (const l of lines) out[l.id] = { today: 0, week: 0 };
  const today = startOfToday(now);
  for (const c of calls) {
    const id = byE164.get(canonE164(c.from_number));
    if (!id) continue;
    out[id]!.week++;
    if (Date.parse(c.at) >= today) out[id]!.today++;
  }
  return out;
}

/**
 * How often a rep's calls went out on a line in the seller's area code.
 * Only calls where both ends have a US area code count; null when there are none.
 */
export function localMatchRate(calls: readonly HealthCall[], userId: string | null): number | null {
  let seen = 0;
  let hit = 0;
  for (const c of calls) {
    if (userId && c.user_id && c.user_id !== userId) continue;
    const from = areaCodeOf(c.from_number);
    const to = areaCodeOf(c.to_number);
    if (!from || !to) continue;
    seen++;
    if (from === to) hit++;
  }
  return seen ? hit / seen : null;
}

/** Area codes the rep dialed with no line to match them, most dialed first. */
export function uncoveredAreaCodes(
  lines: readonly { phone_e164: string; area_code?: string | null }[],
  calls: readonly HealthCall[],
  limit = 3,
): Array<{ area: string; calls: number }> {
  const have = new Set(lines.map((l) => l.area_code || areaCodeOf(l.phone_e164)).filter(Boolean));
  const counts = new Map<string, number>();
  for (const c of calls) {
    const to = areaCodeOf(c.to_number);
    if (!to || have.has(to)) continue;
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  return [...counts].map(([area, n]) => ({ area, calls: n })).sort((a, b) => b.calls - a.calls).slice(0, limit);
}

/** Load against the cap as a 0–1 share; a line with no cap shows against 100, Talkr's suggested cap. */
export const SUGGESTED_CAP = 100;
export function loadShare(count: number, cap: number | null): number {
  const against = cap ?? SUGGESTED_CAP;
  return Math.min(1, against > 0 ? count / against : 0);
}
