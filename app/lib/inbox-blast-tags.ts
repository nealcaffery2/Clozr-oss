// Deal blast labels in the Inbox: which deal blasts reached the person on a
// thread (migration 437, inbox_blast_tags), so a buyer's reply reads as the
// answer to the 5323 Sage Hill Road blast, and the Deal blasted filter can
// narrow any tab to one deal.
//
// Pure, so the rules are testable without Supabase
// (`npx tsx tools/inbox-blast-tags.test.ts`). The fetching hook is
// lib/use-blast-tags.ts.

/** One row of inbox_blast_tags: one buyer, one deal. */
export type BlastRow = {
  phone_key: string | null;
  email: string | null;
  buyer_id: number;
  buyer_status: string | null;
  deal_id: number;
  line1: string;
  last_sent_at: string;
};

export type BlastDeal = { dealId: number; line1: string; lastSentAt: string };

/** What the Inbox shows for one thread: the deals blasted to them, newest first. */
export type BlastTag = {
  buyerId: number;
  /** buyers.status is "Prospect": not a known buyer yet. */
  prospect: boolean;
  deals: BlastDeal[];
};

/** The same key normalize_phone() stores in dispo_campaign_recipients.phone_key. */
export function phoneKeyOf(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}

export const emailKeyOf = (raw: string | null | undefined): string | null => {
  const e = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
};

/** Cache keys: a number and an address never collide. */
export const phoneCacheKey = (k: string) => `p:${k}`;
export const emailCacheKey = (k: string) => `e:${k}`;

function merge(into: BlastTag | undefined, r: BlastRow): BlastTag {
  const t = into ?? { buyerId: r.buyer_id, prospect: false, deals: [] };
  const prospect = t.prospect || (r.buyer_status ?? '').trim().toLowerCase() === 'prospect';
  const had = t.deals.find((d) => d.dealId === r.deal_id);
  const deals = had
    ? t.deals.map((d) => (d.dealId === r.deal_id && r.last_sent_at > d.lastSentAt ? { ...d, lastSentAt: r.last_sent_at } : d))
    : [...t.deals, { dealId: r.deal_id, line1: r.line1, lastSentAt: r.last_sent_at }];
  return { buyerId: t.buyerId, prospect, deals: deals.sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt)) };
}

/** The RPC's rows filed under every number and address they matched. */
export function tagsFromRows(rows: readonly BlastRow[]): Map<string, BlastTag> {
  const out = new Map<string, BlastTag>();
  for (const r of rows) {
    if (r.phone_key) out.set(phoneCacheKey(r.phone_key), merge(out.get(phoneCacheKey(r.phone_key)), r));
    const e = emailKeyOf(r.email);
    if (e) out.set(emailCacheKey(e), merge(out.get(emailCacheKey(e)), r));
  }
  return out;
}

/** One thread's tag from its number and address; both found, their deals merge. */
export function tagOf(map: ReadonlyMap<string, BlastTag | null>, phone: string | null | undefined, email: string | null | undefined): BlastTag | null {
  const p = phoneKeyOf(phone);
  const e = emailKeyOf(email);
  const a = p ? map.get(phoneCacheKey(p)) ?? null : null;
  const b = e ? map.get(emailCacheKey(e)) ?? null : null;
  if (!a || !b) return a ?? b;
  let t: BlastTag = a;
  for (const d of b.deals) t = merge(t, { phone_key: null, email: null, buyer_id: t.buyerId, buyer_status: b.prospect ? 'Prospect' : null, deal_id: d.dealId, line1: d.line1, last_sent_at: d.lastSentAt });
  return t;
}

export const blastedAbout = (t: BlastTag | null | undefined, dealId: number) => !!t?.deals.some((d) => d.dealId === dealId);

export type DealOption = { dealId: number; line1: string; count: number };

/** The deals the threads on screen were blasted about, most threads first, for the Deal blasted picker. */
export function dealOptions(tags: readonly (BlastTag | null | undefined)[]): DealOption[] {
  const by = new Map<number, DealOption & { last: string }>();
  for (const t of tags) for (const d of t?.deals ?? []) {
    const o = by.get(d.dealId);
    if (o) { o.count++; if (d.lastSentAt > o.last) o.last = d.lastSentAt; } else by.set(d.dealId, { dealId: d.dealId, line1: d.line1, count: 1, last: d.lastSentAt });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).map(({ dealId, line1, count }) => ({ dealId, line1, count }));
}

/** The keys still to ask about: not cached, or cached longer ago than `maxAgeMs`. */
export function missingKeys(keys: readonly string[], cachedAt: ReadonlyMap<string, number>, now: number, maxAgeMs: number): string[] {
  return [...new Set(keys)].filter((k) => { const at = cachedAt.get(k); return at == null || now - at > maxAgeMs; });
}
