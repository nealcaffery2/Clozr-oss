// Who someone is, and where a buyer stands, each in one colour everywhere.
//
// Contact type: a seller is green and a buyer is blue, so the two sides of a
// deal read apart at a glance on a record, in the lists, in notifications and
// on the TC file. The vendor kinds each get their own hue.
//
// Buyer status: the pill on the Buyers table and the buyer record, coloured
// by what the status means for dispo — VIP gold, vetted cyan, active green,
// follow-up orange, inactive grey, blacklisted red.

export type Tone = { fg: string; bg: string; line: string };

const tone = (fg: string, bg: string, line: string): Tone => ({ fg, bg, line });
const GREY = tone('var(--muted, #52525b)', 'var(--surface-2, #f4f4f5)', 'var(--divider, #e4e4e7)');

const TYPE: Record<string, Tone> = {
  seller: tone('var(--tx-green, #15803d)', 'var(--positive-soft, #dcfce7)', 'var(--tint-green-3, #bbf7d0)'),
  buyer: tone('var(--tx-blue, #1d4ed8)', 'var(--tint-blue-2, #dbeafe)', '#bfdbfe'),
  agent: tone('#7c3aed', 'var(--tint-violet, #ede9fe)', '#ddd6fe'),
  wholesaler: tone('var(--tx-orange, #c2410c)', 'var(--tint-orange-2, #ffedd5)', 'var(--tint-orange-3, #fed7aa)'),
  lender: tone('#0e7490', '#cffafe', '#a5f3fc'),
  title: tone('var(--tx-amber, #b45309)', 'var(--caution-soft, #fef3c7)', 'var(--tint-amber-2, #fde68a)'),
  partner: tone('#be185d', '#fce7f3', 'var(--c-lane-line, #fbcfe8)'),
  vendor: tone('#475569', '#f1f5f9', '#e2e8f0'),
  contractor: tone('var(--tx-orange-deep, #9a3412)', 'var(--tint-orange-2, #ffedd5)', 'var(--tint-orange-3, #fed7aa)'),
  insurance: tone('var(--tx-teal, #0f766e)', '#ccfbf1', '#99f6e4'),
  survey: tone('#4d7c0f', '#ecfccb', '#d9f99d'),
  notary: tone('#4338ca', '#e0e7ff', '#c7d2fe'),
  attorney: tone('#334155', '#e2e8f0', '#cbd5e1'),
  photography: tone('#a21caf', '#fae8ff', '#f5d0fe'),
};

/**
 * The colour for a contact type, from any of the ways the app names one:
 * "Seller", "Sellers", "Acquisitions", "Buyer", "Title Company", "Lender",
 * "Institutional seller" (a partner), a vendor's service type …
 */
export function typeTone(kind: string | null | undefined): Tone {
  const k = (kind ?? '').toLowerCase();
  if (!k) return GREY;
  if (/institutional seller|partner/.test(k)) return TYPE.partner;
  if (/seller|acquisition|coseller|co-seller|owner/.test(k)) return TYPE.seller;
  if (/buyer|dispo/.test(k)) return TYPE.buyer;
  if (/agent|realtor/.test(k)) return TYPE.agent;
  if (/wholesal/.test(k)) return TYPE.wholesaler;
  if (/lender|loan|mortgage/.test(k)) return TYPE.lender;
  if (/title|escrow|closing/.test(k)) return TYPE.title;
  if (/contractor|roof|foundation|junk|plumb|electric|hvac|rehab|construction/.test(k)) return TYPE.contractor;
  if (/insur/.test(k)) return TYPE.insurance;
  if (/survey|inspect|apprais/.test(k)) return TYPE.survey;
  if (/notary/.test(k)) return TYPE.notary;
  if (/attorney|legal|lawyer/.test(k)) return TYPE.attorney;
  if (/photo|media|video/.test(k)) return TYPE.photography;
  return TYPE.vendor;
}

const STATUS: Record<string, Tone> = {
  vip: tone('var(--tx-amber, #b45309)', 'var(--caution-soft, #fef3c7)', 'var(--tint-amber-2, #fde68a)'),
  vetted: tone('#0e7490', '#cffafe', '#a5f3fc'),
  institutional: tone('var(--tx-violet, #6d28d9)', 'var(--tint-violet, #ede9fe)', '#ddd6fe'),
  active: tone('var(--tx-green, #15803d)', 'var(--positive-soft, #dcfce7)', 'var(--tint-green-3, #bbf7d0)'),
  prospect: tone('var(--tx-violet, #6d28d9)', 'var(--tint-violet, #ede9fe)', '#ddd6fe'),
  'follow-up': tone('var(--tx-orange, #c2410c)', 'var(--tint-orange-2, #ffedd5)', 'var(--tint-orange-3, #fed7aa)'),
  inactive: tone('var(--muted, #52525b)', 'var(--surface-2, #f4f4f5)', 'var(--divider, #e4e4e7)'),
  blacklisted: tone('var(--tx-red, #b91c1c)', 'var(--negative-soft, #fee2e2)', 'var(--tint-red-2, #fecaca)'),
  // Compr stages (migration 417), same colours as their Buyers rail dots.
  'not-contacted': tone('var(--muted, #52525b)', 'var(--surface-2, #f4f4f5)', 'var(--divider, #e4e4e7)'),
  contacted: tone('#0f766e', '#ccfbf1', '#99f6e4'),
  interested: tone('var(--tx-green, #15803d)', 'var(--positive-soft, #dcfce7)', 'var(--tint-green-3, #bbf7d0)'),
  'not-interested': tone('var(--tx-red, #b91c1c)', 'var(--negative-soft, #fee2e2)', 'var(--tint-red-2, #fecaca)'),
};

/** The pill colour for a buyer status (VIP, Vetted, Active, Follow-up …). */
export function buyerStatusTone(status: string | null | undefined): Tone {
  const k = (status ?? '').toLowerCase().replace(/\s+/g, '-');
  return STATUS[k] ?? (k.startsWith('follow') ? STATUS['follow-up'] : GREY);
}
