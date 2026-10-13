export type PdRecipient = {
  email?: string; first_name?: string; last_name?: string;
  has_completed?: boolean; role?: string; shared_link?: string;
};

export type PdWebhookDoc = {
  id?: string; name?: string; status?: string;
  metadata?: Record<string, string | undefined>;
  recipients?: PdRecipient[];
  tokens?: { name?: string; value?: string }[];
  template?: { id?: string; name?: string };
  grand_total?: { amount?: string; currency?: string };
  tags?: string[];
};

export const recipientEmails = (doc: PdWebhookDoc): string[] =>
  Array.from(new Set((doc.recipients ?? []).map((r) => (r.email ?? '').trim().toLowerCase()).filter((e) => e.includes('@'))));

export function guessKindFromName(name: string): string {
  const n = name.toLowerCase();
  if (/terminat|cancel|release/.test(n)) return 'termination';
  if (/assign/.test(n)) return 'assignment';
  if (/offer|loi|letter of intent/.test(n)) return 'offer';
  if (/amend|addend/.test(n)) return 'addendum';
  if (/purchase|psa|sale|agreement|contract/.test(n)) return 'psa';
  return 'other';
}

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function addressScore(docName: string, address: string | null | undefined): number {
  const a = fold(address ?? '');
  const n = fold(docName);
  if (!a || !n) return 0;
  if (n.includes(a) || a.includes(n)) return 4;
  const bits = a.split(' ').filter((w) => w.length > 2 && !/^(st|rd|dr|ave|ln|ct|blvd|tx|ok|street|road|drive)$/.test(w));
  const hits = bits.filter((w) => n.includes(w));
  if (hits.length >= 2) return 3;
  if (hits.length === 1) return 1;
  return 0;
}

export type PacketCandidate = {
  id: number;
  name: string;
  offer_id?: number | null;
  recipients?: { email?: string }[] | null;
};

export function pickPacket(doc: PdWebhookDoc, packets: PacketCandidate[]): PacketCandidate | null {
  const emails = new Set(recipientEmails(doc));
  const offerMeta = doc.metadata?.clozr_offer_id;
  let best: { c: PacketCandidate; score: number } | null = null;
  for (const c of packets) {
    let score = 0;
    if (offerMeta && c.offer_id != null && String(c.offer_id) === String(offerMeta)) score += 10;
    const recips = (c.recipients ?? []).map((r) => (r.email ?? '').trim().toLowerCase()).filter(Boolean);
    score += recips.filter((e) => emails.has(e)).length * 3;
    score += addressScore(doc.name ?? '', c.name);
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score >= 3 ? best.c : null;
}

export type PersonHit = {
  kind: 'seller' | 'buyer';
  id: number;
  workspace_id: number;
  deal_id?: number | null;
  address?: string | null;
  email: string;
};

export function pickPerson(doc: PdWebhookDoc, people: PersonHit[]): PersonHit | null {
  const emails = new Set(recipientEmails(doc));
  const hits = people.filter((p) => emails.has(p.email.trim().toLowerCase()));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const kind = guessKindFromName(doc.name ?? '');
  const prefer = kind === 'assignment' ? 'buyer' : 'seller';
  const scored = hits.map((p) => ({
    p,
    score: (p.kind === prefer ? 2 : 0) + addressScore(doc.name ?? '', p.address),
  })).sort((a, b) => b.score - a.score);
  if (scored[0].score > (scored[1]?.score ?? -1)) return scored[0].p;
  const top = scored.filter((s) => s.score === scored[0].score);
  return top.length === 1 ? top[0].p : null;
}

export function webhookFields(doc: PdWebhookDoc): {
  recipients: PdRecipient[];
  tokens: { name: string; value: string }[] | null;
  template_id: string | null;
  template_name: string | null;
} {
  const tokens = (doc.tokens ?? []).filter((t) => t.name).map((t) => ({ name: String(t.name), value: String(t.value ?? '') }));
  return {
    recipients: doc.recipients ?? [],
    tokens: tokens.length ? tokens : null,
    template_id: doc.template?.id ?? null,
    template_name: doc.template?.name ?? null,
  };
}
