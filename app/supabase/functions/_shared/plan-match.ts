/**
 * Which action plan a rep means, from an id or a name as they said it.
 * Pure, so tools/plan-match.test.ts can pin it; ask-clozr does the IO.
 *
 * An id wins. Then an exact name (case and punctuation ignored). Then every
 * word of the request appearing in one plan's name. Two or more candidates is
 * ambiguous: the assistant asks which one rather than guessing.
 */
export type PlanRef = { id: number; name: string };
export type PlanMatch<T extends PlanRef> = { plan: T } | { ambiguous: T[] } | { none: true };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function matchPlan<T extends PlanRef>(plans: T[], ref: unknown): PlanMatch<T> {
  const s = String(ref ?? '').trim();
  if (/^\d+$/.test(s)) {
    const byId = plans.find((p) => p.id === Number(s));
    if (byId) return { plan: byId };
  }
  const q = norm(s);
  if (!q) return { none: true };
  const pick = (hits: T[]): PlanMatch<T> | null =>
    hits.length === 1 ? { plan: hits[0] } : hits.length > 1 ? { ambiguous: hits } : null;
  const words = q.split(' ');
  return pick(plans.filter((p) => norm(p.name) === q))
    ?? pick(plans.filter((p) => { const n = norm(p.name); return words.every((w) => n.includes(w)); }))
    ?? { none: true };
}
