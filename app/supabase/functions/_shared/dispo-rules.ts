/**
 * Dispo campaigns and buyer automations, the pure half: no network, no
 * database, no Deno, no imports.
 *
 * Imported by the edge functions (`dispo-intro`, `dispo-campaign-tick`) as
 * `../_shared/dispo-rules.ts` and by the browser (lib/dispo-campaign.ts,
 * components/DispoCampaign.tsx), so the facts the AI is allowed to use, the
 * level on a buyer card and the fallback a template takes are one definition.
 * Tests: npx tsx tools/dispo-rules.test.ts
 *
 * Everything here works from real rows. Where a fact is not on file the answer
 * is null or '' — never a guess.
 */

// ------------------------------------------------------------------ facts
export type PurchaseType = 'flip' | 'rental';

/** One past purchase, from wherever CLOZR learned about it. */
export type PurchaseSource = {
  address: string;
  city?: string | null;
  zip?: string | null;
  /** ISO date; null when the source has none (a Podio "Buyer Bought Address"). */
  date: string | null;
  lat?: number | null;
  lng?: number | null;
  sqft?: number | null;
  /** Miles to THIS deal when the source measured it (a Genius run for this deal). */
  distanceMi?: number | null;
  kind?: PurchaseType | null;
  from: 'clozr_deal' | 'genius' | 'podio';
};

export type DealFacts = {
  address: string; city: string | null; zip: string | null;
  lat: number | null; lng: number | null; sqft: number | null;
  beds: number | null; baths: number | null; propertyType: string | null;
};

export type BuyerFacts = {
  firstName: string;
  lastPurchase: {
    address: string; ago: string | null; type: PurchaseType | null;
    distanceMi: number | null; similarSize: boolean; sameArea: boolean; from: PurchaseSource['from'];
  } | null;
  strategy: PurchaseType | null;
  /** Purchases on file with an address, from every source (closed with us, Genius, Podio). */
  purchaseCount: number;
};

const clean = (s: string | null | undefined) => String(s ?? '').trim();

export function firstName(name: string | null | undefined): string {
  const n = clean(name);
  // A company ("Harbor Capital LLC") has no first name worth greeting.
  if (!n || /\b(llc|inc|corp|trust|lp|llp|holdings|properties|investments|homes|capital|group|partners|ventures|realty|rentals|solutions|enterprises|fund|company|co\.)\b/i.test(n)) return '';
  const w = n.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, '');
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

/** properties.property_type → the word a text uses. '' when unknown. */
export function propertyTypeLabel(raw: string | null | undefined): string {
  const t = clean(raw).toLowerCase();
  if (!t || /^https?:/.test(t)) return '';
  if (/mobile|manufactured/.test(t)) return 'mobile home';
  if (/single|sfh|sfr|house|detached/.test(t)) return 'SFH';
  if (/duplex|triplex|fourplex|quad|multi|2-4|units?/.test(t)) return 'multifamily';
  if (/condo/.test(t)) return 'condo';
  if (/town/.test(t)) return 'townhouse';
  if (/land|lot/.test(t)) return 'lot';
  return t.replace(/_/g, ' ');
}

/** Flip vs rental from the buy box strategies, the buyer type, or what Genius saw them do. */
export function strategyOf(strategies: string[] | null | undefined, buyerType: string | null | undefined): PurchaseType | null {
  const s = (strategies ?? []).map((x) => x.toLowerCase());
  const flip = s.some((x) => /flip|wholetail/.test(x)) || /flip/i.test(clean(buyerType));
  const rent = s.some((x) => /hold|brrrr|rental|short_term/.test(x)) || /landlord|rental/i.test(clean(buyerType));
  if (flip && !rent) return 'flip';
  if (rent && !flip) return 'rental';
  return null;
}

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** "3 weeks", "2 months", "1 year". Null without a date or for a date in the future. */
export function agoLabel(iso: string | null | undefined, now: Date): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t > now.getTime()) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (days < 14) return unit(Math.max(1, days), 'day');
  if (days < 60) return unit(Math.round(days / 7), 'week');
  if (days < 365) return unit(Math.round(days / 30), 'month');
  return unit(Math.round(days / 365), 'year');
}

/** "0.4 miles", "3 miles". '' when not measured. */
export function distanceLabel(mi: number | null | undefined): string {
  if (mi == null || !Number.isFinite(mi)) return '';
  if (mi < 0.1) return 'less than a tenth of a mile';
  if (mi < 10) return `${Number(mi.toFixed(1))} mile${Number(mi.toFixed(1)) === 1 ? '' : 's'}`;
  return `${Math.round(mi)} miles`;
}

/**
 * The buyer's most recent purchase and how it relates to this deal. Dated
 * sources win (newest first); an undated Podio address is used only when
 * nothing dated is on file. Distance is measured only when both ends have
 * coordinates, or taken from a Genius run that measured against this deal.
 */
export function buyerFacts(
  buyer: { name: string; strategies?: string[] | null; buyerType?: string | null },
  purchases: PurchaseSource[], deal: DealFacts, now: Date,
): BuyerFacts {
  const strategy = strategyOf(buyer.strategies, buyer.buyerType);
  const usable = purchases.filter((p) => clean(p.address));
  const dated = usable.filter((p) => p.date && Number.isFinite(Date.parse(p.date))).sort((a, b) => Date.parse(b.date!) - Date.parse(a.date!));
  const p = dated[0] ?? usable.find((x) => !x.date) ?? null;
  if (!p) return { firstName: firstName(buyer.name), lastPurchase: null, strategy, purchaseCount: 0 };
  let distanceMi: number | null = p.distanceMi ?? null;
  if (distanceMi == null && p.lat != null && p.lng != null && deal.lat != null && deal.lng != null) {
    distanceMi = Number(milesBetween({ lat: p.lat, lng: p.lng }, { lat: deal.lat, lng: deal.lng }).toFixed(2));
  }
  const similarSize = !!(p.sqft && deal.sqft && Math.abs(p.sqft - deal.sqft) / deal.sqft <= 0.2);
  const sameArea = (!!p.zip && !!deal.zip && clean(p.zip).slice(0, 5) === clean(deal.zip).slice(0, 5))
    || (!!p.city && !!deal.city && clean(p.city).toLowerCase() === clean(deal.city).toLowerCase())
    || (distanceMi != null && distanceMi <= 5);
  return {
    firstName: firstName(buyer.name),
    strategy,
    purchaseCount: usable.length,
    lastPurchase: { address: clean(p.address), ago: agoLabel(p.date, now), type: p.kind ?? strategy, distanceMi, similarSize, sameArea, from: p.from },
  };
}

/** "Past purchase: 123 Main St" lines the Podio buyer import writes into notes. */
export function podioPurchases(notes: string | null | undefined): PurchaseSource[] {
  return clean(notes).split(/\r?\n/).flatMap((l) => {
    const m = /^\s*Past purchase:\s*(.+)$/i.exec(l);
    return m ? [{ address: m[1].trim(), date: null, from: 'podio' as const }] : [];
  });
}

export type ClosedDealRow = { buyer_id: number; line1: string | null; city: string | null; zip: string | null; lat: number | null; lng: number | null; sqft: number | null; closed_on: string | null };
type GeniusPurchase = {
  address: string; city?: string; zip?: string; date?: string | null; sqft?: number | null;
  lat?: number | null; lng?: number | null; distance_mi?: number | null;
};
type GeniusCandidate = {
  owner_name?: string | null; people?: string[] | null; kind?: string; matched_buyer_id?: number | null;
  purchases?: GeniusPurchase[];
};
export type GeniusRunRow = { deal_id: number | null; candidates: unknown };

const nameKey = (s: string | null | undefined) => clean(s).toLowerCase();

/**
 * Does this Genius candidate belong to the buyer. The run's buyer link wins.
 * A buyer Genius or Buyr filed is also theirs when the owner or a person on
 * the candidate is their name or their company — Genius stores the LLC as the
 * owner and the person behind it separately, and the buyer row splits the
 * same way.
 */
export function geniusBuyerMatch(
  buyer: { id: number; name: string; company?: string | null; source: string | null },
  c: { matched_buyer_id?: number | null; owner_name?: string | null; people?: string[] | null },
): boolean {
  if (c.matched_buyer_id === buyer.id) return true;
  if (buyer.source !== 'genius' && buyer.source !== 'buyr') return false;
  const keys = [buyer.name, buyer.company].map(nameKey).filter((n) => n.length > 2);
  if (!keys.length) return false;
  const owner = nameKey(c.owner_name);
  const people = (c.people ?? []).map(nameKey);
  return keys.some((n) => n === owner || people.includes(n));
}

/**
 * Every purchase on file for one buyer: deals they closed with us, what Genius
 * saw them buy, and Podio's past-purchase notes. Coordinates always come
 * along so the distance to THIS deal can be measured. A Genius distance is
 * kept as-is only when that run measured against this deal.
 */
export function purchasesFor(
  buyer: { id: number; name: string; company?: string | null; notes: string | null; source: string | null },
  closed: ClosedDealRow[], runs: GeniusRunRow[], dealId: number,
): PurchaseSource[] {
  const out: PurchaseSource[] = closed.filter((d) => d.buyer_id === buyer.id && d.line1).map((d) => ({
    address: d.line1 as string, city: d.city, zip: d.zip, date: d.closed_on, lat: d.lat, lng: d.lng, sqft: d.sqft, from: 'clozr_deal' as const,
  }));
  for (const run of runs) {
    const cands = Array.isArray(run.candidates) ? (run.candidates as GeniusCandidate[]) : [];
    for (const c of cands) {
      if (!geniusBuyerMatch(buyer, c)) continue;
      const kind: PurchaseType | null = c.kind === 'flipper' ? 'flip' : c.kind === 'landlord' ? 'rental' : null;
      for (const p of c.purchases ?? []) {
        if (!clean(p.address)) continue;
        out.push({
          address: p.address, city: p.city ?? null, zip: p.zip ?? null, date: p.date ?? null,
          lat: p.lat ?? null, lng: p.lng ?? null, sqft: p.sqft ?? null, kind, from: 'genius',
          distanceMi: run.deal_id === dealId ? p.distance_mi ?? null : null,
        });
      }
    }
  }
  return out.concat(podioPurchases(buyer.notes));
}

/** The facts an AI intro may use, as plain labelled lines. Nothing else is given to the model. */
export function factsText(f: BuyerFacts, deal: DealFacts, repFirst: string): string {
  const lp = f.lastPurchase;
  return [
    `buyer_first_name: ${f.firstName || '(unknown - do not use a name)'}`,
    `rep_first_name: ${repFirst || '(unknown)'}`,
    `deal_address: ${clean(deal.address) || '(unknown - do not name a street)'}`,
    `deal_property_type: ${propertyTypeLabel(deal.propertyType) || '(unknown)'}`,
    `deal_city: ${deal.city || '(unknown)'}`,
    deal.beds ? `deal_beds: ${deal.beds}` : '', deal.baths ? `deal_baths: ${deal.baths}` : '',
    f.strategy ? `buyer_strategy: ${f.strategy}` : '',
    lp ? `last_purchase_address: ${lp.address}` : 'last_purchase: none on file',
    lp?.ago ? `last_purchase_ago: ${lp.ago}` : '',
    lp?.type ? `last_purchase_type: ${lp.type}` : '',
    f.purchaseCount >= 2 ? `purchases_on_file: ${f.purchaseCount} (properties we know they bought; not necessarily near this deal)` : '',
    lp?.distanceMi != null ? `distance_to_deal: ${distanceLabel(lp.distanceMi)}` : lp?.sameArea ? 'distance_to_deal: same area (no exact distance - say "nearby")' : '',
    lp?.similarSize ? 'size: similar size to their last purchase' : '',
    offerAsk(f, deal.address) ? `required_hook: ${offerAsk(f, deal.address)}` : 'required_hook: none (no purchase on file - do not invent one)',
  ].filter(Boolean).join('\n');
}

/**
 * The sentence an AI intro has to land: the street they bought, how far it
 * sits from this deal's street, and an offer ask. Built only from facts on
 * file, so a model that writes the same generic line for every buyer can be
 * replaced with this and still be specific to that buyer.
 */
export function offerAsk(f: BuyerFacts, dealAddress: string): string {
  const lp = f.lastPurchase;
  if (!lp) return '';
  const ago = lp.ago ? ` about ${lp.ago} ago` : '';
  const dist = distanceLabel(lp.distanceMi);
  const ours = clean(dealAddress);
  let where = '';
  if (dist && ours) where = `, ${dist} from our property on ${ours}`;
  else if (dist) where = `, ${dist} from this one`;
  else if (lp.sameArea && ours) where = `, in the same area as our property on ${ours}`;
  else if (ours) where = `. Our property is ${ours}`;
  const tail = where.startsWith('.') ? '' : '.';
  return `I saw you bought ${lp.address}${ago}${where}${tail} Looks like it fits your criteria. Want to make an offer?`;
}

/** True when the text actually names that street (its house number, else a distinctive word). */
export function citesAddress(text: string, address: string): boolean {
  const num = clean(address).match(/\d{2,}/)?.[0];
  if (num) return text.includes(num);
  const skip = new Set(['street', 'avenue', 'drive', 'road', 'lane', 'court', 'place', 'blvd', 'boulevard', 'circle', 'trail', 'way', 'north', 'south', 'east', 'west']);
  const word = clean(address).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).find((w) => w.length > 3 && !skip.has(w));
  return !!word && text.toLowerCase().includes(word);
}

/**
 * The one sentence every dispo text can carry about the buyer: their most
 * recent purchase and how far it is from this deal. A complete sentence with
 * no leading space, built only from what is on file — the distance when it was
 * measured, "same area" when only the zip or city matches, and just the
 * purchase when nothing relates it to this deal. '' with no purchase on file,
 * so a template can use {{purchase_note}} anywhere and never leave a hole.
 */
export function purchaseNote(f: BuyerFacts): string {
  const lp = f.lastPurchase;
  if (!lp) return '';
  const ago = lp.ago ? ` ${lp.ago} ago` : '';
  const dist = distanceLabel(lp.distanceMi);
  // What they bought, as a phrase that already carries its verb.
  const what = lp.type === 'flip' ? `the flip you did at ${lp.address}${ago}`
    : lp.type === 'rental' ? `your rental at ${lp.address}${ago ? `, which you picked up${ago}` : ''}`
    : ago ? `${lp.address}, which you picked up${ago}` : `your purchase at ${lp.address}`;
  if (dist) return `It's ${dist} from ${what}.`;
  if (lp.sameArea) return `It's in the same area as ${what}.`;
  // Nothing ties it to this deal: the purchase is still worth calling out.
  return lp.type === 'flip' ? `I saw you did a flip at ${lp.address}${ago}.`
    : lp.type === 'rental' ? `I saw you picked up a rental at ${lp.address}${ago}.`
    : `I saw you picked up ${lp.address}${ago}.`;
}

/**
 * The merge fields a campaign adds per buyer. Every value is real or ''.
 * {{purchase_note}} is the sentence above; {{purchase_count}} how many
 * purchases are on file; the rest are its parts, for templates that phrase
 * it their own way (those fall back to the generic intro when a part is
 * missing — see chooseIntro).
 */
export function dispoBuyerFields(f: BuyerFacts): Record<string, string> {
  const lp = f.lastPurchase;
  return {
    last_purchase_address: lp?.address ?? '',
    last_purchase_ago: lp?.ago ?? '',
    last_purchase_type: lp?.type ?? '',
    deal_distance: distanceLabel(lp?.distanceMi),
    similar_size: lp?.similarSize ? " It's a similar size to your last one." : '',
    purchase_note: purchaseNote(f),
    purchase_count: f.purchaseCount ? String(f.purchaseCount) : '',
  };
}

// ------------------------------------------------------------- templates
/** Tokens that make an intro personal; a template using any of them needs all of its own filled. */
export const PERSONAL_FIELDS = ['first_name', 'last_purchase_address', 'last_purchase_ago', 'last_purchase_type', 'deal_distance'];

/**
 * The intro a buyer gets when a template's personal facts are not on file. It
 * still carries {{purchase_note}}: a buyer with a purchase on file but no date
 * for it (so the dated templates fall back here) is still told how close it is.
 */
export const GENERIC_INTRO = "Hey {{first_name}} - it's {{rep_first_name}}. I've got a {{property_type}} deal in {{city}} that looks like a fit for what you buy. {{purchase_note}} Want more details?";
export const GENERIC_INTRO_NO_NAME = "Hi - it's {{rep_first_name}}. I've got a {{property_type}} deal in {{city}} that looks like a fit for what you buy. {{purchase_note}} Want more details?";

const tokens = (body: string) => Array.from(body.matchAll(/\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g)).map((m) => m[1].toLowerCase());

/**
 * Which body to render for this buyer: the template when every personal field
 * it uses is filled, else the generic intro — never a sentence with a hole
 * ("wrapped up a flip on  about  ago").
 */
export function chooseIntro(template: string, fields: Record<string, string>): { body: string; fallback: boolean; missing: string[] } {
  const used = tokens(template).filter((t) => PERSONAL_FIELDS.includes(t));
  const missing = Array.from(new Set(used.filter((t) => !clean(fields[t]))));
  if (!missing.length) return { body: template, fallback: false, missing };
  return { body: clean(fields.first_name) ? GENERIC_INTRO : GENERIC_INTRO_NO_NAME, fallback: true, missing };
}

export type Frequency = 'never' | 'sometimes' | 'frequently';

/** Small stable hash, so "sometimes" picks the same buyers on every render. */
export function seedOf(s: string | number): number {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/**
 * Split an intro into one or two texts at the sentence boundary nearest the
 * middle. never → one; sometimes → about half the buyers; frequently → every
 * intro with two or more sentences.
 */
export function splitIntro(text: string, mode: Frequency, seed: string | number): string[] {
  const t = clean(text);
  if (!t || mode === 'never' || (mode === 'sometimes' && seedOf(seed) >= 0.5)) return t ? [t] : [];
  const cuts: number[] = [];
  for (const m of t.matchAll(/[.!?](\s+)(?=\S)/g)) cuts.push((m.index ?? 0) + 1);
  if (!cuts.length) return [t];
  const mid = t.length / 2;
  const cut = cuts.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const a = t.slice(0, cut).trim(); const b = t.slice(cut).trim();
  return a && b ? [a, b] : [t];
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}\u{200D}]/gu;
export const stripEmoji = (t: string) => t.replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').trim();

/** Avoided keywords found in a message (case-insensitive, whole words or phrases). */
export function avoidedIn(text: string, avoid: string[]): string[] {
  return avoid.map((w) => clean(w)).filter(Boolean).filter((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(text));
}

/**
 * Numbers in an AI message that the facts do not contain. Anything returned is
 * an invented figure and the message is thrown away.
 */
export function inventedNumbers(text: string, facts: string): string[] {
  const norm = (s: string) => s.replace(/,/g, '');
  const known = new Set((norm(facts).match(/\d+(?:\.\d+)?/g) ?? []));
  return (norm(text).match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !known.has(n));
}

export const rotate = <T,>(list: T[], i: number): T | undefined => (list.length ? list[((i % list.length) + list.length) % list.length] : undefined);

// ------------------------------------------------------------ the buyer
export type BuyerStats = {
  /** Deals sent to them (deal_buyer_matches.sent_at). */
  dealsSent: number;
  /** Of those, deals they replied to (replied_at). */
  dealsReplied: number;
  /** Distinct deals they made an inbound offer on. */
  dealsOffered: number;
  /** Our deals they closed (deals.buyer_id with a close). */
  closed: number;
  /** Purchases on file from any source (closed with us, Genius, Podio). */
  purchases: number;
  vip: boolean;
  vetted: boolean;
  /** Best match score for the deal in hand, when matched. */
  score: number | null;
};

export const LEVEL_LABEL = ['', 'New', 'Contacted', 'Engaged', 'Offering', 'Closer'];

/**
 * Buyer level, 1–5, from what they have actually done with us:
 *   L1 New        nothing sent yet
 *   L2 Contacted  sent at least one deal
 *   L3 Engaged    replied to at least one deal
 *   L4 Offering   made at least one offer
 *   L5 Closer     closed a deal with us
 * VIP adds one level (capped at 5). Vetted is shown beside the level, not in it.
 */
export function levelOf(s: BuyerStats): { level: number; label: string } {
  let level = s.closed > 0 ? 5 : s.dealsOffered > 0 ? 4 : s.dealsReplied > 0 ? 3 : s.dealsSent > 0 ? 2 : 1;
  if (s.vip) level = Math.min(5, level + 1);
  return { level, label: LEVEL_LABEL[level] };
}

/**
 * Probability to buy this deal, percent, or null when there is too little
 * history to say (fewer than two deals sent and no offer or close on file).
 *   35% × match score/100
 * + 25% × reply rate   (deals replied / deals sent)
 * + 30% × offer rate   (deals offered / deals sent)
 * + 10% × closed with us before
 * capped at 95.
 */
export function probabilityToBuy(s: BuyerStats): number | null {
  if (s.dealsSent < 2 && s.dealsOffered === 0 && s.closed === 0) return null;
  const base = Math.max(1, s.dealsSent, s.dealsOffered);
  const p = 0.35 * ((s.score ?? 0) / 100) + 0.25 * Math.min(1, s.dealsReplied / base) + 0.3 * Math.min(1, s.dealsOffered / base) + 0.1 * (s.closed > 0 ? 1 : 0);
  return Math.min(95, Math.round(p * 100));
}

export const dealCountLabel = (purchases: number) => (purchases >= 2 ? 'Multi deal' : purchases === 1 ? 'Single deal' : 'No purchases on file');

// ---------------------------------------------------------- scheduling
export function localHM(d: Date, tz: string): { hour: number; minute: number; weekday: number; date: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
  } catch {
    return localHM(d, 'UTC');
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday: wd < 0 ? 0 : wd, date: `${get('year')}-${get('month')}-${get('day')}` };
}

/** The campaign sending window: 9:00–20:00 in the campaign's time zone, every day. */
export const WINDOW = { start: 9, end: 20 };

export const inSendWindow = (d: Date, tz: string) => { const h = localHM(d, tz).hour; return h >= WINDOW.start && h < WINDOW.end; };

/** `d` if it is inside the window, else the next window opening (to the minute, in 1-minute steps from the next quarter hour). */
export function intoWindow(d: Date, tz: string): Date {
  if (inSendWindow(d, tz)) return d;
  let t = Math.ceil(d.getTime() / 900_000) * 900_000;
  for (let i = 0; i < 96 * 3; i++, t += 900_000) {
    const at = new Date(t);
    const p = localHM(at, tz);
    if (p.hour === WINDOW.start && p.minute === 0) return at;
    if (inSendWindow(at, tz)) return at;
  }
  return d;
}

/**
 * The hour (and weekday, when there is enough to say) a buyer answers most,
 * from the times of their inbound texts and emails. Null under three replies.
 */
export function bestReplyTime(inbound: string[], tz: string): { hour: number; weekday: number | null } | null {
  const ds = inbound.map((s) => new Date(s)).filter((d) => Number.isFinite(d.getTime()));
  if (ds.length < 3) return null;
  const byHour = new Map<number, number>(); const byWeekHour = new Map<string, number>();
  for (const d of ds) {
    const p = localHM(d, tz);
    if (p.hour < WINDOW.start || p.hour >= WINDOW.end) continue;
    byHour.set(p.hour, (byHour.get(p.hour) ?? 0) + 1);
    byWeekHour.set(`${p.weekday}:${p.hour}`, (byWeekHour.get(`${p.weekday}:${p.hour}`) ?? 0) + 1);
  }
  if (!byHour.size) return null;
  const top = <K,>(m: Map<K, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  const [wk, wkN] = top(byWeekHour);
  if (wkN >= 3) { const [w, h] = String(wk).split(':').map(Number); return { hour: h, weekday: w }; }
  return { hour: top(byHour)[0], weekday: null };
}

/**
 * Smart follow-up timing: the first moment at or after `fixed` that falls in
 * the buyer's best hour (and weekday, when known), searched up to 7 days out;
 * `fixed` itself when there is no history or nothing matches.
 */
export function smartTime(fixed: Date, best: { hour: number; weekday: number | null } | null, tz: string): Date {
  if (!best) return fixed;
  let t = Math.ceil(fixed.getTime() / 900_000) * 900_000;
  for (let i = 0; i < 96 * 7; i++, t += 900_000) {
    const at = new Date(t); const p = localHM(at, tz);
    if (p.hour === best.hour && (best.weekday == null || p.weekday === best.weekday)) return at;
  }
  return fixed;
}

/** Spacing between buyers' first sends, in seconds, for the "send frequency" choice. */
export function staggerSeconds(freq: 'sometimes' | 'frequently', seed: string | number): number {
  const r = seedOf(seed);
  return freq === 'frequently' ? 30 + Math.round(r * 30) : 90 + Math.round(r * 120);
}

// ------------------------------------------------------ trigger events
export type SentDeal = { dealId: number; sentAt: string; repliedAt: string | null; status: string };
const lastN = (sent: SentDeal[], n: number) => sent.filter((s) => s.sentAt).sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)).slice(0, n);

/** Interest as the matcher's per-deal status records it (set by a rep, a reply classified as a pass, or an offer). */
export const INTERESTED = ['interested', 'offered', 'under_contract', 'closed'];
export const NO_STATUS = ['matched', 'sent', 'viewed'];

export const noResponseLastN = (sent: SentDeal[], n: number) => { const l = lastN(sent, n); return n > 0 && l.length === n && l.every((s) => !s.repliedAt); };
export const notInterestedLastN = (sent: SentDeal[], n: number) => { const l = lastN(sent, n); return n > 0 && l.length === n && l.every((s) => s.status === 'not_interested'); };
export const respondingNoStatusLastN = (sent: SentDeal[], n: number, offeredDeals: Set<number>) => {
  const l = lastN(sent, n);
  return n > 0 && l.length === n && l.every((s) => !!s.repliedAt && NO_STATUS.includes(s.status) && !offeredDeals.has(s.dealId));
};
export const notSentInDays = (sent: SentDeal[], days: number, now: Date) => !sent.some((s) => s.sentAt && Date.parse(s.sentAt) >= now.getTime() - days * 86_400_000);
export const activeAgainWithin = (activeAgainAt: string | null, days: number, now: Date) => {
  const t = activeAgainAt ? Date.parse(activeAgainAt) : NaN;
  return Number.isFinite(t) && t > now.getTime() && t <= now.getTime() + days * 86_400_000;
};
/** Their last N offers were each at or under pct% of our asking price. */
export function lowballStreak(offers: { amount: number | null; asking: number | null; at: string }[], n: number, pct: number): boolean {
  const l = offers.filter((o) => o.amount != null && o.asking).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n);
  return n > 0 && l.length === n && l.every((o) => (o.amount as number) <= (o.asking as number) * (pct / 100));
}
