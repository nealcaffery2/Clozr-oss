// Shared ranking for Acme Homes PandaDoc templates. The offers function and
// Settings use the same order: a pinned id wins, then cash-offer / LOI, then
// a purchase agreement, then whatever PandaDoc listed first.

export function pickPandaDocTemplate<T extends { id: string; name: string }>(
  templates: T[],
  preferredId?: string | null,
): T | null {
  if (preferredId) {
    const hit = templates.find((t) => t.id === preferredId);
    if (hit) return hit;
  }
  if (!templates.length) return null;
  const score = (n: string) => {
    const s = n.toLowerCase();
    if (/cash offer|offer letter|letter of intent|\bloi\b/.test(s)) return 5;
    if (/\boffer\b/.test(s)) return 4;
    if (/psa|purchase agreement|purchase and sale/.test(s)) return 3;
    if (/assignment|wholesale/.test(s)) return 2;
    return 1;
  };
  return [...templates].sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name))[0];
}
