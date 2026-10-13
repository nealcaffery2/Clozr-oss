// Auto-map an uploaded PDF: find every blank on its pages and decide what it
// is — a signature, initials or date for one recipient, a value the record
// already has (seller.name, deal.purchase_price…), or something a recipient
// types — so the field editor opens with the document already set up, the
// way PandaDoc does it.
//
// Three cues on each page:
//   text     underscore or dot-leader blanks, checkbox glyphs, and captions
//            ("Seller Signature") printed under a drawn line
//   boxes    empty rectangles drawn where a value goes (PandaDoc and
//            DocuSign exports, the Acme Homes amendment)
//   rules    drawn horizontal lines with nothing written on them
// The words beside, above or under a blank are its label; the nearest party
// heading ("SELLER (TENANT):") or signature above it, in the same column, says
// whose it is.
//
// Pure: no DOM, no pdf.js (lib/pdf-shapes and the editor read the PDF). Output
// is FieldDef (supabase/functions/_shared/pdf-fields.ts), so it drops straight
// into the editor. Anything it gets wrong is one drag or one dropdown away,
// so it errs toward placing a field rather than skipping one.
//   npx tsx tools/pdf-autodetect.test.ts

import type { FieldDef, FieldType } from '../supabase/functions/_shared/pdf-fields';
import type { Shape } from './pdf-shapes';

/** One run of text as pdf.js reports it: points, top-left origin, `y` on the baseline. `page` is 1-based. */
export type TextItem = { page: number; str: string; x: number; y: number; w: number; h: number };
export type PageDim = { width: number; height: number };
export type Side = 'acquisition' | 'disposition';
/** A party in the document's own words. */
export type Who = 'seller' | 'seller2' | 'buyer' | 'assignor' | 'assignee' | 'company';
/** Who a recipient on the template is (lib/pdf-docs PdfRole.party). */
export type Party = 'seller' | 'seller2' | 'buyer' | 'company' | 'other';

/** A blank found on a page, before it is given to a recipient on the template. */
export type Found = {
  page: number; x: number; y: number; w: number; h: number;
  type: FieldType;
  who: Who | null;
  /** The printed-name line of a signature block: bound to that recipient's name. */
  printedName?: boolean;
  variable_key?: string | null;
  label?: string | null;
  required: boolean;
};

// ------------------------------------------------------------------ parties

const ROLE_WORDS: [RegExp, Who][] = [
  [/\b(co-?seller|second seller|seller\s*(?:#|no\.?\s*)?2|seller two)\b/, 'seller2'],
  [/\bassignor\b/, 'assignor'],
  [/\bassignee\b/, 'assignee'],
  [/\b(seller|owner|grantor|optionor|landlord|lessor)s?\b/, 'seller'],
  [/\b(buyer|purchaser|grantee|optionee|tenant|lessee|investor)s?\b/, 'buyer'],
  // Not bare "company": "Title Company" is a title company, not us.
  [/\b(acme homes|wholesaler)\b/, 'company'],
];

/**
 * The party a phrase names. Parenthesised roles are second names for the
 * same person — "Seller (Tenant)" is the seller, "Buyer (Landlord)" the
 * buyer — so the words outside the brackets decide.
 */
export function whoIn(text: string): Who | null {
  const t = text.toLowerCase();
  const outside = t.replace(/\([^)]*\)/g, ' ');
  for (const src of [outside, t]) for (const [re, who] of ROLE_WORDS) if (re.test(src)) return who;
  return null;
}

/** Which side of the deal the paper is: on a purchase agreement Acme Homes buys; on a dispo or assignment it sells. */
export function sideOf(name: string, kind: string): Side {
  return kind === 'assignment' || kind === 'novation' || kind === 'jv' || /dispo|assign|novation|end buyer|\bjv\b/i.test(name) ? 'disposition' : 'acquisition';
}

/** The party behind a document role on this side of the deal. */
export function partyOf(who: Who, side: Side): Party {
  switch (who) {
    case 'seller': return side === 'acquisition' ? 'seller' : 'company';
    case 'seller2': return 'seller2';
    case 'buyer': return side === 'acquisition' ? 'company' : 'buyer';
    case 'assignor': case 'company': return 'company';
    case 'assignee': return 'buyer';
  }
}

const PARTY_VARS: Record<Party, Partial<Record<'name' | 'email' | 'phone' | 'entity', string>>> = {
  seller: { name: 'seller.name', email: 'seller.email', phone: 'seller.phone' },
  seller2: { name: 'seller2.name', email: 'seller2.email' },
  buyer: { name: 'buyer.name', email: 'buyer.email', phone: 'buyer.phone', entity: 'buyer.entity' },
  company: { name: 'company.entity', email: 'company.email', phone: 'company.phone', entity: 'company.entity' },
  other: {},
};
/** The name a printed-name line takes, by party. */
const SIGNER_NAME: Record<Party, string | null> = { seller: 'seller.name', seller2: 'seller2.name', buyer: 'buyer.name', company: 'company.signer', other: null };

// ------------------------------------------------------------------- labels

type Rule = { re: RegExp; type: FieldType; v?: string | ((side: Side) => string); label?: string };

/**
 * Labels that mean a known value whoever signs. First match wins, so the
 * specific ("cash portion of sales price") sits above the general ("price").
 * A rule without `v` still names the field and gives it the right type.
 */
const RULES: Rule[] = [
  { re: /legal description/, type: 'text', v: 'property.legal_description', label: 'Legal description' },
  { re: /\b(apn|parcel|tax id)\b/, type: 'text', v: 'property.apn', label: 'Parcel number' },
  { re: /(property|premises|subject).*(address|located)|address of (the )?property|located at|know[n]? as$|^the property$|(property|premises|real estate) at$|concerning the property|street address|^address$|^property$/, type: 'text', v: 'property.address', label: 'Property address' },
  { re: /\bcounty\b/, type: 'text', v: 'property.county', label: 'County' },
  { re: /laws of the state of$|^state of$/, type: 'text', v: 'property.state_name', label: 'State' },
  { re: /\bzip\b|postal code/, type: 'text', v: 'property.zip', label: 'ZIP' },
  { re: /^city\b|city of$/, type: 'text', v: 'property.city', label: 'City' },
  { re: /\blot$/, type: 'text', label: 'Lot' },
  { re: /\bblock$/, type: 'text', label: 'Block' },
  // Leasebacks, holdbacks and amendments: named, typed, not on the record.
  { re: /daily rent/, type: 'currency', label: 'Daily rent' },
  { re: /total rent/, type: 'currency', label: 'Total rent due at closing' },
  { re: /security deposit/, type: 'currency', label: 'Security deposit' },
  { re: /per day|holdover/, type: 'currency', label: 'Holdover rent per day' },
  { re: /move-?\s?out/, type: 'date', label: 'Move-out date' },
  { re: /calendar days|within .*days|days follow|number of days/, type: 'number', label: 'Days' },
  { re: /hold ?back amount|amount of \$?$|the amount of/, type: 'currency', label: 'Amount' },
  { re: /cash portion/, type: 'currency', label: 'Cash portion of sales price' },
  { re: /sum of (all )?financing|financing described/, type: 'currency', label: 'Sum of financing' },
  { re: /assignment fee/, type: 'currency', v: 'deal.assignment_fee', label: 'Assignment fee' },
  { re: /waives?\b/, type: 'text', label: 'Waived (yes / no)' },
  { re: /option fee/, type: 'currency', label: 'Option fee' },
  { re: /option period|option days|end of the option/, type: 'date', v: 'deal.option_ends', label: 'Option period ends' },
  { re: /earnest|\bemd\b|escrow deposit/, type: 'currency', v: (s) => (s === 'acquisition' ? 'deal.inhouse_emd' : 'deal.buyer_emd'), label: 'Earnest money' },
  { re: /(purchase|sales?|contract|total) price|price of|consideration|\bprice\b|\bfor \$$/, type: 'currency', v: 'deal.purchase_price', label: 'Purchase price' },
  { re: /clos(ing|e) date|close of escrow|on or before|closing shall|date of closing|closing date/, type: 'date', v: 'deal.close_date', label: 'Closing date' },
  { re: /title (company|agent|insurer)|escrow (agent|company|holder)|closing agent/, type: 'text', v: 'title.company', label: 'Title company' },
  { re: /offer expires|acceptance deadline|expiration/, type: 'date', v: 'offer.expires', label: 'Offer expires' },
  { re: /executed (the|this) day|day of$/, type: 'date', v: 'doc.date', label: 'Date signed' },
  { re: /entered into on|made and entered/, type: 'date', v: 'doc.date', label: 'Date' },
  { re: /effective date|contract date|execution date|date of (this|the) (agreement|contract)|agreement dated|this agreement is (made|dated)|dated$/, type: 'date', v: 'deal.contract_date', label: 'Contract date' },
  { re: /\barv\b|after repair/, type: 'currency', v: 'deal.arv', label: 'ARV' },
  { re: /\b(begin|start|commence|end)s? on$|\bend on the date of$|\beffective on$/, type: 'date' },
  { re: /\$$|\bamount\b|\bfee\b|\bcost\b|\bdollars\b/, type: 'currency' },
  { re: /\bdate\b|\bdeadline\b/, type: 'date' },
  { re: /\bdays?\b/, type: 'number' },
];

/** On an amendment the price and dates are the new ones being agreed, not what the record holds. */
const KEEPS_RECORD_ON_AMENDMENT = new Set(['property.address', 'property.legal_description', 'property.apn', 'property.county', 'property.city', 'property.zip', 'title.company', 'deal.contract_date', 'doc.date']);

const SIGN_RE = /\bsign(ature|ed)?\b|signed by|^by$|^x$/;
const INITIAL_RE = /\binitial(s|ed)?\b/;
const DATE_RE = /^dated?$|\bdate\b/;
const NAME_RE = /print(ed)?\s*name|typed name|^name$|\bname\b/;

/** "1. Purchase Price: $" → "Purchase Price". Long sentence lead-ins keep their last few words. */
export function tidyLabel(s: string, keep: 'end' | 'start' = 'end'): string {
  let t = s.replace(/[_.…]{2,}/g, ' ').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(\(?[0-9a-z]{1,3}[.)]\s+)+/i, '').replace(/[:$#(\[\s]+$/, '').replace(/^[)\]:\s•●-]+/, '').trim();
  const words = t.split(' ');
  // Inline ("…for the sum of $____") the words nearest the blank matter; a caption over a box reads from its start.
  if (words.length > 8) t = keep === 'end' ? words.slice(-8).join(' ') : words.slice(0, 8).join(' ');
  return t;
}
const pretty = (s: string, keep: 'end' | 'start' = 'end') => {
  const t = tidyLabel(s, keep).replace(/\s*\(.*$/, '').trim();
  const words = t.split(' ');
  const short = words.length > 6 ? (keep === 'end' ? words.slice(-5) : words.slice(0, 6)).join(' ') : t;
  return short ? short.charAt(0).toUpperCase() + short.slice(1) : '';
};

/** The blank beside a signature or initials with nothing between: the same thing for a second person (null when there is no second one). */
function secondOf(prev: Classified, side: Side): Classified | null {
  if (prev.type !== 'initials' && prev.type !== 'signature') return null;
  if (prev.who === 'seller') return { type: prev.type, who: 'seller2' };
  // Acme Homes buys as one entity: a second buyer box stays empty.
  if (prev.who === 'buyer' && partyOf('buyer', side) === 'company') return null;
  return prev;
}

export type Classified =
  | { type: 'signature' | 'initials' | 'date_signed'; who: Who }
  | { type: 'text'; who: Who; printedName: true }
  | { type: FieldType; who: Who | null; variable_key: string | null; label: string };

/**
 * What one blank is, from the words around it. `ctx` is the party the block
 * around it is about; `inSignBlock` is true just under or beside a signature.
 */
export function classify(raw: string, o: { ctx: Who | null; inSignBlock: boolean; side: Side; kind: string; longBlank?: boolean; box?: boolean;
  /** The words right after the blank: "___ days" is a number whatever came before it. */
  after?: string;
  /** The label came from a bracketed party after the blank ("____ (Seller)"): it is that party's name. */
  named?: boolean;
  /** Past the opening of the document: a bare "Buyer: ____" up top names the party, down here it is where they sign. */
  late?: boolean }): Classified {
  const keep = o.box ? 'start' : 'end';
  const label = tidyLabel(raw, keep);
  const l = label.toLowerCase();
  const own = whoIn(l);
  const who = own ?? o.ctx;
  if (o.named && own) {
    const v = PARTY_VARS[partyOf(own, o.side)].name;
    if (v) return { type: 'text', who: null, variable_key: v, label: pretty(label) || label };
  }
  if (o.after && /^\s*((calendar|business)\b|days?\b)/i.test(o.after) && !INITIAL_RE.test(l)) return { type: 'number', who, variable_key: null, label: 'Days' };
  if (o.after && /^\s*per day\b/i.test(o.after)) return { type: 'currency', who, variable_key: null, label: /holdover/i.test(o.after) ? 'Holdover rent per day' : 'Per day' };
  if (/^print(ed)?( name)?$/.test(l) && who) return { type: 'text', who, printedName: true };
  if (INITIAL_RE.test(l)) return { type: 'initials', who: who ?? 'seller' };
  if (SIGN_RE.test(l) && !/date/.test(l)) return { type: 'signature', who: who ?? 'seller' };
  // A bare "Seller: ________" on a long line is where the seller signs.
  const bare = l.replace(/\([^)]*\)/g, '').replace(/['’]s?\b/g, '').replace(/[^a-z\s-]/g, '').trim();
  if (own && o.longBlank && !o.box && o.late !== false && bare.split(/\s+/).length <= 2 && whoIn(bare) === own && !/name|email|phone|address/.test(l) && !/tenant|landlord/.test(l)) return { type: 'signature', who: own };
  if (o.inSignBlock && who) {
    if (DATE_RE.test(l)) return { type: 'date_signed', who };
    if (NAME_RE.test(l) && !/company|entity|llc/.test(l)) return { type: 'text', who, printedName: true };
  }
  // "SELLER PRINT NAME": the seller's own name line, theirs in the editor too.
  if (own && /\bprint(ed)?\b/.test(l) && !/e-?mail|phone/.test(l)) return { type: 'text', who: own, printedName: true };
  // "Seller's email", "Buyer (Landlord): ____" — the record has it.
  if (own) {
    const party = partyOf(own, o.side);
    // Only a short label is about the party itself; "payable by Buyer at closing" is about money.
    // "Buyer is ___ / is not ___" is a choice, not a name.
    const short = bare.split(/\s+/).length <= 2 && !/\b(is|are|shall|will|agrees?|may|not)\b/.test(bare);
    const attr = /e-?mail/.test(l) ? 'email' : /phone|tel\b|mobile|cell/.test(l) ? 'phone' : /company|entity|llc/.test(l) && short ? 'entity' : NAME_RE.test(l) || (short && whoIn(bare) === own) ? 'name' : null;
    const v = attr ? PARTY_VARS[party][attr] : undefined;
    if (v) return { type: 'text', who: null, variable_key: v, label: pretty(label, keep) || label };
  }
  for (const r of RULES) {
    if (!r.re.test(l)) continue;
    let v = typeof r.v === 'function' ? r.v(o.side) : r.v ?? null;
    if (v && o.kind === 'amendment' && !KEEPS_RECORD_ON_AMENDMENT.has(v)) v = null;
    return { type: r.type, who: v ? null : who, variable_key: v, label: r.label && (v || !pretty(label, keep) || o.box) ? r.label : pretty(label, keep) || r.label || 'Value' };
  }
  return { type: 'text', who, variable_key: null, label: pretty(label, keep) || 'Text' };
}

// --------------------------------------------------------------------- PDF

type Line = { page: number; y: number; h: number; text: string; xs: number[]; endX: number; items: TextItem[] };

/** Group runs into lines (same page, baselines within a few points), left to right, with an x for every character. */
export function toLines(items: TextItem[]): Line[] {
  const sorted = items.filter((i) => i.str.length).slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.max(2.5, it.h * 0.35);
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= tol) last.items.push(it);
    else lines.push({ page: it.page, y: it.y, h: it.h, text: '', xs: [], endX: 0, items: [it] });
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let text = ''; const xs: number[] = []; let endX = 0;
    for (const it of ln.items) {
      if (text && it.x - endX > Math.max(1.5, it.h * 0.2) && !text.endsWith(' ')) { text += ' '; xs.push(endX); }
      const cw = it.w / Math.max(1, it.str.length);
      for (let i = 0; i < it.str.length; i++) { text += it.str[i]; xs.push(it.x + cw * i); }
      endX = Math.max(endX, it.x + it.w);
      ln.h = Math.max(ln.h, it.h);
    }
    ln.text = text; ln.xs = xs; ln.endX = endX;
  }
  return lines;
}

const BLANK = /_{3,}|\.{6,}|…{3,}/g;
const BOX = /[☐□❑▢]|\[\s?\]/g;
const SIGN_CAPTION = /^(.{0,30}\b)?signature\b|^signature of|^by:?$/i;

/**
 * Every blank on the document. `name` and `kind` (lib/contracts guessKind)
 * decide which side of the deal it is, and so who "Buyer" means.
 */
export function detectFields(items: TextItem[], pages: PageDim[], shapes: Shape[] = [], meta: { name?: string; kind?: string } = {}): { found: Found[]; side: Side } {
  const kind = meta.kind ?? 'other';
  const side = sideOf(meta.name ?? '', kind);
  const lines = toLines(items);
  const found: Found[] = [];
  const sigs: { page: number; x0: number; x1: number; y: number; who: Who }[] = [];
  const heads: { page: number; x: number; y: number; who: Who }[] = [];

  const add = (page: number, xPt: number, yTopPt: number, wPt: number, hPt: number, c: Classified) => {
    const p = pages[page - 1] ?? { width: 612, height: 792 };
    const w = Math.min(1, wPt / p.width), h = Math.min(1, hPt / p.height);
    const f: Found = {
      page, x: clamp(xPt / p.width, 0, 1 - w), y: clamp(yTopPt / p.height, 0, 1 - h), w, h,
      type: c.type, who: c.who,
      ...('printedName' in c ? { printedName: true, label: 'Printed name' } : {}),
      ...('variable_key' in c ? { variable_key: c.variable_key, label: c.label } : {}),
      required: c.type !== 'checkbox' && !('variable_key' in c && !c.variable_key && !c.who),
    };
    if (found.some((g) => g.page === f.page && overlap(g, f) > 0.45)) return;
    found.push(f);
    if (c.type === 'signature' && c.who) sigs.push({ page, x0: xPt, x1: xPt + wPt, y: yTopPt + hPt, who: c.who });
  };
  const sigAt = (page: number, x: number, y: number) => {
    let best: (typeof sigs)[number] | null = null;
    for (const g of sigs) {
      if (g.page !== page || y < g.y - 4 || y - g.y > 70 || x < g.x0 - 80 || x > g.x1 + 40) continue;
      if (!best || g.y > best.y) best = g;
    }
    return best;
  };
  const headAt = (page: number, x: number, y: number) => {
    let best: (typeof heads)[number] | null = null;
    for (const h of heads) {
      if (h.page !== page || h.y > y + 2 || y - h.y > 140 || h.x > x + 12) continue;
      if (!best || h.x > best.x + 20 || (Math.abs(h.x - best.x) <= 20 && h.y > best.y)) best = h;
    }
    return best;
  };
  // The nearer of the two wins: a "BUYER (LANDLORD):" heading under the seller's block starts the buyer's.
  const ctxAt = (page: number, x: number, y: number): Who | null => {
    const g = sigAt(page, x, y), h = headAt(page, x, y);
    if (g && h) return h.y > g.y - 2 ? h.who : g.who;
    return g?.who ?? h?.who ?? null;
  };
  const isLate = (page: number, y: number) => page > 1 || pages.length === 1 ? page === pages.length || y > (pages[page - 1]?.height ?? 792) * 0.5 : y > (pages[0]?.height ?? 792) * 0.55;

  // Text that sits inside a drawn box or on a drawn rule means that shape is filled in already (or is decoration).
  const textIn = (page: number, x0: number, y0: number, x1: number, y1: number) =>
    items.some((it) => it.page === page && it.str.trim() && !/^[_.…\s]+$/.test(it.str) && it.x + it.w / 2 > x0 && it.x + it.w / 2 < x1 && it.y - it.h * 0.3 > y0 && it.y - it.h * 0.3 < y1);

  const doLine = (li: number) => {
    const ln = lines[li];
    const below = lines[li + 1] && lines[li + 1].page === ln.page && lines[li + 1].y - ln.y < Math.max(26, ln.h * 2.6) ? lines[li + 1] : null;
    const trimmed = ln.text.trim();

    // Underscore blanks: the words before one (or the caption under it) are its label.
    const blanks = [...ln.text.matchAll(BLANK)];
    let prevEnd = 0;
    let prev: Classified | null = null;
    for (const [bi, m] of blanks.entries()) {
      const start = m.index!, end = start + m[0].length;
      const x0 = ln.xs[start] ?? 0;
      const x1 = end < ln.xs.length ? ln.xs[end] : ln.endX;
      let label = ln.text.slice(prevEnd, start);
      const after = ln.text.slice(end, blanks[bi + 1]?.index ?? ln.text.length);
      // "____ (Seller) and ____ (Buyer)": a party in brackets right after the blank names it.
      const tag = /^\s*\(([^)]{2,30})\)/.exec(after);
      const referred = /^\W*(hereinafter )?(referred to as|called)\s+["“']?([a-z ]{3,20})/i.exec(after);
      const named = !!(tag && whoIn(tag[1])) || !!(referred && whoIn(referred[3]));
      if (referred && whoIn(referred[3])) label = referred[3];
      else if (tag && (named || !tidyLabel(label))) label = tag[1];
      else if (!tidyLabel(label) && bi === blanks.length - 1) label = after.replace(BLANK, ' ');
      // Two blanks side by side with nothing between them ("Seller ____ ____"): the second is the first again, for a second person.
      const under = below ? textUnder(below, x0, x1) : '';
      if (!tidyLabel(label) && !tidyLabel(under) && prev && bi > 0 && (prev.type === 'initials' || prev.type === 'signature')) {
        const again = secondOf(prev, side);
        prevEnd = end;
        if (again) add(ln.page, x0, ln.y - (again.type === 'signature' ? 28 : 20), Math.max(24, x1 - x0), again.type === 'signature' ? 30 : 22, again);
        continue;
      }
      let caption = '';
      if (!tidyLabel(label) && below) caption = textUnder(below, x0, x1);
      let from = prevEnd;
      while (from < start && ln.text[from] === ' ') from++;
      const lx = Math.min(ln.xs[from] ?? x0, x0);
      prevEnd = end;
      const width = Math.max(24, x1 - x0);
      // On a row like "Seller: ____ Print: ____", the print name belongs to whoever signs just left of it.
      const rowSig = sigs.find((g) => g.page === ln.page && Math.abs(g.y - ln.y) < 8 && g.x1 <= x0 + 4);
      const c = classify(tidyLabel(label) ? label : caption, { ctx: (prev && prev.type === 'signature' ? prev.who : null) ?? rowSig?.who ?? ctxAt(ln.page, lx, ln.y), inSignBlock: !!sigAt(ln.page, lx, ln.y) || !!sigAt(ln.page, x0, ln.y) || !!rowSig || /sign/i.test(caption + label), side, kind, longBlank: width >= 150, late: isLate(ln.page, ln.y), after, named });
      prev = c;
      // Never taller than the gap to the line above, or it would swallow that line's blank.
      const room = li > 0 && lines[li - 1].page === ln.page ? ln.y - lines[li - 1].y - 1 : 40;
      const tall = Math.max(Math.min(ln.h * 1.25, room), Math.min(c.type === 'signature' ? 30 : c.type === 'initials' ? 22 : Math.max(12, ln.h * 1.25), room));
      add(ln.page, x0, ln.y - tall + 2, width, tall, c);
    }

    // Checkbox glyphs: the words after one are its label.
    for (const m of ln.text.matchAll(BOX)) {
      const at = m.index!;
      const x0 = ln.xs[at] ?? 0;
      const after = ln.text.slice(at + m[0].length).split(BOX)[0];
      const label = pretty(after).split(' ').slice(0, 6).join(' ') || 'Option';
      const size = Math.max(9, ln.h);
      add(ln.page, x0, ln.y - size + 1, size, size, { type: 'checkbox', who: ctxAt(ln.page, x0, ln.y), variable_key: null, label });
    }

    // A caption under a drawn signature line: "Seller Signature", "Signature of Buyer", "By:".
    if (!blanks.length && trimmed.length <= 60 && SIGN_CAPTION.test(trimmed) && !/date of signature/i.test(trimmed)) {
      const x0 = ln.items[0].x;
      const who = whoIn(trimmed) ?? ctxAt(ln.page, x0, ln.y) ?? 'seller';
      const di = trimmed.toLowerCase().lastIndexOf('date');
      const dx = di > 10 ? ln.xs[ln.text.indexOf(trimmed) + di] ?? null : null;
      // A drawn rule just under or above the caption is the line itself; otherwise the box sits above the caption.
      const rule = shapes.find((s) => s.page === ln.page && s.kind === 'rule' && s.x <= x0 + 20 && s.x + s.w >= x0 + 40 && s.y > ln.y - ln.h - 26 && s.y < ln.y + 44);
      if (/^by:?$/i.test(trimmed)) add(ln.page, ln.endX + 4, ln.y - 26, 200, 30, { type: 'signature', who });
      else if (rule && rule.y > ln.y) add(ln.page, Math.max(rule.x, x0), Math.max(ln.y + 2, rule.y - 30), Math.min(rule.w, 260), Math.min(29, rule.y - ln.y - 2), { type: 'signature', who });
      else add(ln.page, x0, ln.y - ln.h - 32, dx != null ? Math.max(90, Math.min(210, dx - x0 - 8)) : 210, 30, { type: 'signature', who });
      if (dx != null) add(ln.page, dx, ln.y - ln.h - 16, 110, 14, { type: 'date_signed', who });
    }
  };

  // Drawn boxes: an empty rectangle is a blank. Its label is the text just above it, or to its left.
  const doBox = (s: Shape) => {
    const p = pages[s.page - 1] ?? { width: 612, height: 792 };
    if (s.h >= 90 || s.y < p.height * 0.07 || s.w > p.width * 0.95) return;
    if (textIn(s.page, s.x, s.y, s.x + s.w, s.y + s.h)) return;
    const label = labelNear(lines, s, shapes);
    const c = classify(label, { ctx: ctxAt(s.page, s.x, s.y), inSignBlock: !!sigAt(s.page, s.x, s.y), side, kind, box: true });
    add(s.page, s.x + 1, s.y + 1, s.w - 2, s.h - 2, c);
  };

  // Drawn rules with nothing written on them, a row at a time so that a row of
  // initials ("Initialed by Buyer ___ ___ and Seller ___ ___") reads as one.
  type RowPrev = { s: Shape; c: Classified };
  let rowPrev = null as RowPrev | null;
  const doRule = (s: Shape) => {
    const p = pages[s.page - 1] ?? { width: 612, height: 792 };
    if (s.w > p.width * 0.9 || s.y < p.height * 0.025) return;
    if (textIn(s.page, s.x + 2, s.y - 14, s.x + s.w - 2, s.y + 1)) return;
    // A page-wide divider under a line that already has its own blank ("Original Contract Date: ____") is a separator, not a write-in line.
    if (s.w > p.width * 0.65 && !tidyLabel(leftOf(lines, s, shapes))) {
      const above = lines.filter((l) => l.page === s.page && l.y <= s.y && s.y - l.y < 36).sort((a, b) => b.y - a.y)[0];
      if (above && (/_{3,}/.test(above.text) || /[.!?]$/.test(above.text.trim()))) return;
    }
    const last: RowPrev | null = rowPrev;
    const sameRow: RowPrev | null = last && last.s.page === s.page && Math.abs(last.s.y - s.y) < 4 ? last : null;
    const left = leftOf(lines, s, shapes);
    const row = lines.find((l) => l.page === s.page && Math.abs(l.y - s.y) < Math.max(8, l.h))?.text ?? '';
    let c: Classified;
    if (sameRow && !tidyLabel(left) && (sameRow.c.type === 'initials' || sameRow.c.type === 'signature')) {
      const again = secondOf(sameRow.c, side);
      rowPrev = { s, c: sameRow.c };
      if (again) add(s.page, s.x, s.y - 22, s.w, 22, again);
      return;
    }
    if (INITIAL_RE.test(row.toLowerCase()) && s.w < 120) c = { type: 'initials', who: whoIn(left) ?? (sameRow?.c.who ?? null) ?? 'seller' };
    else {
      const right = rightOf(lines, s, shapes);
      const tag = /^\s*\(([^)]{2,30})\)/.exec(right) ?? /^\W*(?:hereinafter )?(?:referred to as|called)\s+["“']?([a-z ]{3,20})/i.exec(right);
      const rowSig = sigs.find((g) => g.page === s.page && Math.abs(g.y - s.y) < 8 && g.x1 <= s.x + 4);
      c = classify(tag && whoIn(tag[1]) ? tag[1] : labelNear(lines, s, shapes), { ctx: rowSig?.who ?? ctxAt(s.page, s.x, s.y), inSignBlock: !!sigAt(s.page, s.x, s.y) || !!rowSig, side, kind, longBlank: s.w >= 150, late: isLate(s.page, s.y), after: right, named: !!(tag && whoIn(tag[1])) });
    }
    rowPrev = { s, c };
    const tall = c.type === 'signature' ? 30 : c.type === 'initials' ? 22 : 14;
    add(s.page, s.x, s.y - tall, c.type === 'signature' ? Math.min(s.w, 300) : s.w, tall, c);
  };

  // Short heading-like runs naming a party ("SELLER (TENANT):", "BUYER:") set context for their column.
  for (const ln of lines) {
    const t = ln.text.trim();
    if (!whoIn(t) || t.length > 60 || /_{3,}/.test(t)) continue;
    for (const it of ln.items) { const w = whoIn(it.str); if (w && it.str.trim().length <= 34) heads.push({ page: ln.page, x: it.x, y: ln.y, who: w }); }
  }
  // Then every blank in reading order, so a signature drawn as a line is known before the "Print name" and "Date" under it.
  type Step = { page: number; y: number; x: number; run: () => void };
  const steps: Step[] = [
    ...lines.map((ln, li) => ({ page: ln.page, y: ln.y, x: ln.items[0]?.x ?? 0, run: () => doLine(li) })),
    ...shapes.filter((sh) => sh.kind === 'box').map((sh) => ({ page: sh.page, y: sh.y + Math.min(sh.h, 14), x: sh.x, run: () => doBox(sh) })),
    ...shapes.filter((sh) => sh.kind === 'rule').map((sh) => ({ page: sh.page, y: sh.y, x: sh.x, run: () => doRule(sh) })),
  ];
  // Rows a point or two apart are one row, read left to right.
  steps.sort((p, q) => p.page - q.page || (Math.abs(p.y - q.y) < 3 ? p.x - q.x : p.y - q.y));
  for (const st of steps) st.run();

  found.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return { found, side };
}

/** The words that name a drawn blank: on its line to the left, else just above it, else just under it. */
/** The words on a blank's own line, to its left, since the previous blank on that row ("Lot ___ Block ___"). */
function leftOf(lines: Line[], s: Shape, shapes: Shape[]): string {
  const mid = s.kind === 'rule' ? s.y : s.y + Math.min(s.h, 24) / 2;
  const fence = Math.max(0, ...shapes.filter((o) => o !== s && o.page === s.page && o.kind === s.kind && Math.abs(o.y - s.y) < 4 && o.x + o.w <= s.x + 2).map((o) => o.x + o.w));
  return lines.filter((l) => l.page === s.page && Math.abs(l.y - mid) < Math.max(8, l.h) && l.items.some((it) => it.x < s.x))
    .map((l) => l.items.filter((it) => it.x + it.w <= s.x + 4 && it.x >= fence - 2).map((it) => it.str).join(' ')).find((t) => tidyLabel(t)) ?? '';
}

/** The words on a blank's own line, to its right, up to the next blank on that row. */
function rightOf(lines: Line[], s: Shape, shapes: Shape[]): string {
  const mid = s.kind === 'rule' ? s.y : s.y + Math.min(s.h, 24) / 2;
  const end = s.x + s.w;
  const fence = Math.min(Infinity, ...shapes.filter((o) => o !== s && o.page === s.page && o.kind === s.kind && Math.abs(o.y - s.y) < 4 && o.x >= end - 2).map((o) => o.x));
  return (lines.filter((l) => l.page === s.page && Math.abs(l.y - mid) < Math.max(8, l.h))
    .map((l) => l.items.filter((it) => it.x >= end - 4 && it.x + it.w <= fence + 2).map((it) => it.str).join(' ').trim()).find(Boolean) ?? '');
}

function labelNear(lines: Line[], s: Shape, shapes: Shape[]): string {
  const onPage = lines.filter((l) => l.page === s.page);
  // A bracketed caption straight under the line, or right after it, names it outright: "(Address of Property)", "(Seller)".
  const bottom = s.kind === 'rule' ? s.y : s.y + s.h;
  const capLine = onPage.filter((l) => l.y > bottom && l.y - bottom < 14).sort((a, b) => a.y - b.y)[0];
  const cap = capLine ? textUnder(capLine, s.x, s.x + s.w) : '';
  if (/^\(.{3,40}\)/.test(cap)) return cap.replace(/^\((.*?)\).*$/, '$1');
  // A party name or "Date" printed under a bare line: the line is where they sign, or the date they do.
  if (s.kind === 'rule' && !tidyLabel(leftOf(lines, s, shapes))) {
    const c0 = cap.split(/\s{2,}/)[0].trim();
    if (c0 && c0.split(/\s+/).length <= 3 && whoIn(c0)) return `${c0} signature`;
    if (/^date\b/i.test(c0)) return 'Date';
  }
  const right = rightOf(lines, s, shapes);
  if (/^\(.{3,40}\)/.test(right)) return right.replace(/^\((.*?)\).*$/, '$1');
  let left = leftOf(lines, s, shapes);
  // "____ Addition": nothing before it on the row, so the words after it are its name.
  if (!/[a-z]{2}/i.test(left) && s.kind === 'rule' && /[a-z]{3}/i.test(right)) left = right.split(/[,.;]/)[0];
  if (left && s.kind === 'rule') return left;
  const above = onPage.filter((l) => l.y <= s.y + 2 && s.y - l.y < 34 && l.items.some((it) => it.x < s.x + s.w && it.x + it.w > s.x - 30)).sort((a, b) => b.y - a.y)[0];
  if (above) return above.text;
  if (left) return left;
  const under = onPage.filter((l) => l.y > s.y + s.h && l.y - (s.y + s.h) < 16 && l.items.some((it) => it.x < s.x + s.w && it.x + it.w > s.x)).sort((a, b) => a.y - b.y)[0];
  return under ? textUnder(under, s.x, s.x + s.w) : '';
}

function textUnder(line: Line, x0: number, x1: number): string {
  let s = '';
  for (let i = 0; i < line.text.length; i++) {
    const x = line.xs[i];
    if (x >= x0 - 6 && x <= x1 + 2) s += line.text[i];
  }
  return s.trim();
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function overlap(a: Found, b: Found): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

// ------------------------------------------------------------ recipients

export type TemplateRole = { role: string; label?: string | null; party?: string | null; recipient_type?: string | null };

/**
 * Give every found blank to a recipient on the template, as the editor's
 * FieldDef. A party in the document ("Seller", "Buyer (Landlord)") goes to the
 * template role for that party; a value the record fills, and anything nobody
 * is named for, goes to the side that prepares the paper (our company signer
 * when there is one), locked when it is bound to the record.
 */
export function assignRoles(found: Found[], roles: TemplateRole[], side: Side): FieldDef[] {
  if (!roles.length) return [];
  const signers = roles.filter((r) => r.recipient_type !== 'filler');
  const byParty = (p: Party) => roles.find((r) => r.party === p) ?? roles.find((r) => (r.role + ' ' + (r.label ?? '')).toLowerCase().includes(p === 'company' ? 'company' : p));
  const forWho = (w: Who): TemplateRole | undefined =>
    byParty(partyOf(w, side)) ?? roles.find((r) => whoIn(`${r.role} ${r.label ?? ''}`.replace(/_/g, ' ')) === w)
    // No second seller on the template: their boxes go to the seller, who can hand them on.
    ?? (w === 'seller2' ? byParty(partyOf('seller', side)) : undefined);
  const preparer = byParty('company') ?? roles[0];
  const out: FieldDef[] = [];
  for (const f of found) {
    const signs = f.type === 'signature' || f.type === 'initials' || f.type === 'date_signed';
    let r = f.who ? forWho(f.who) : undefined;
    if (!r) r = f.variable_key ? preparer : signs ? signers[0] ?? roles[0] : preparer;
    if (signs && r.recipient_type === 'filler') r = signers[0] ?? r;
    let variable = f.variable_key ?? null;
    if (f.printedName) {
      // The person the block is about decides the name, even when their boxes went to someone else (no Seller 2 role).
      const p = f.who ? partyOf(f.who, side) : ((r.party ?? 'other') as Party);
      variable = SIGNER_NAME[p] ?? null;
    }
    out.push({
      role: r.role, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
      required: signs ? f.type !== 'date_signed' : !variable && f.required,
      read_only: !!variable || f.type === 'date_signed',
      label: f.label ?? null, variable_key: variable,
    });
  }
  return out;
}
