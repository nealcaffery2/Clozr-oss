/**
 * Entity names, deed index rows and assignment contract parties, the rules with
 * no I/O. Used by contracts, deed search and the records agent.
 */
import { type Any, type Candidate, type Hit, type Purchase, addressKey, daysBetween, isEntity, isNonBuyer, miles, ownerFrom, ownerKey } from './property-data.ts';

const str = (v: unknown) => (v == null ? '' : String(v).trim());

export type DeedTransaction = {
  grantor: string; grantee: string; address: string | null; county: string; state: string;
  date: string | null; price: number | null; doc_type: string | null; instrument: string | null; source_url: string;
};

/** publicsearch.us (GovOS) search JSON → transactions. Grantor defaults to the name searched when the parties block is thin. */
export function parsePublicSearch(json: Any, searched: string, county: string, state: string, base: string): DeedTransaction[] {
  const hits: Any[] = Array.isArray(json?.hits) ? json.hits : Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];
  const out: DeedTransaction[] = [];
  for (const d of hits) {
    const parties: Any[] = Array.isArray(d?.parties) ? d.parties : [];
    const of = (t: string) => parties.filter((p) => str(p?.type ?? p?.partyType ?? p?.role).toUpperCase().startsWith(t)).map((p) => str(p?.name ?? p?.partyName)).filter(Boolean);
    const grantors = of('GRANTOR'); const grantees = of('GRANTEE');
    const grantor = grantors[0] ?? str(d?.grantor ?? d?.grantors?.[0]) ?? searched;
    for (const grantee of grantees.length ? grantees : [str(d?.grantee ?? d?.grantees?.[0])]) {
      if (!grantee) continue;
      const price = Number(d?.salePrice ?? d?.docAmount ?? d?.consideration);
      out.push({
        grantor: grantor || searched, grantee, address: str(d?.propertyAddress ?? d?.legalDescription ?? d?.legal) || null,
        county, state, date: str(d?.fileDate ?? d?.recordedDate ?? d?.recordDate).slice(0, 10) || null,
        price: Number.isFinite(price) && price > 0 ? price : null, doc_type: str(d?.docType ?? d?.documentType) || null,
        instrument: str(d?.instrumentNumber ?? d?.docNumber ?? d?.id) || null, source_url: `${base}/doc/${encodeURIComponent(str(d?.id ?? d?.docNumber ?? ''))}`,
      });
    }
  }
  return out;
}

/** True for the deeds that move title, not a lien, release, affidavit or plat. */
export const isConveyance = (docType: string | null | undefined) => {
  const t = str(docType).toLowerCase();
  if (!t) return true;
  if (/release|lien|affidavit|plat|easement|power of attorney|notice|lis pendens|assumed name|ucc|judgment|abstract/.test(t)) return false;
  return /deed|conveyance|assignment|contract/.test(t);
};

/** "Acme Holdings, LLC", "ACME HOLDINGS LLC" and "Acme Holdings L.L.C." are one entity. */
export const entityKey = (name: string | null | undefined) => ownerKey(name, true);

/**
 * Brands that trade through many LLCs. A name that carries the brand, or a
 * shell on this list, rolls up to the family. Workspace rows (parent_id) add
 * to this; the list is the floor.
 */
export const WHOLESALER_FAMILIES: { family: string; match: RegExp }[] = [
  { family: 'Opendoor', match: /opendoor/i },
  { family: 'Offerpad', match: /offerpad/i },
]

export function familyOf(name: string | null | undefined): string | null {
  const n = str(name);
  for (const f of WHOLESALER_FAMILIES) if (f.match.test(n)) return f.family;
  return null;
}

/** What one assignment PDF says, as the harvester stores it. */
export type ContractParties = {
  assignor: string | null; assignee: string | null; original_seller: string | null;
  assignor_person: string | null; assignee_person: string | null;
  assignor_email: string | null; assignee_email: string | null; assignor_phone: string | null; assignee_phone: string | null;
  property: string | null; purchase_price: number | null; assignment_fee: number | null; total_price: number | null;
  contract_date: string | null; closing_date: string | null; title_company: string | null;
  template: 'operator' | 'new_western' | 'other';
};

const moneyOf = (s: string | null | undefined): number | null => { const n = Number(str(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n >= 500 ? n : null; };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const dateOf = (s: string | null | undefined): string | null => {
  const t = str(s);
  let m = /(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/.exec(t);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0];
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(t);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
};

const SUFFIX = /\b(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|lp|llp|ltd\.?|pllc)\b/i;

const ENTITY_RE = /\b((?:[A-Za-z][A-Za-z0-9&'.-]*,?\s+){1,5})(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|lp|llp|ltd\.?|pllc)\b\.?/gi;

/** Words that mean the "entity" is a sentence fragment, not a company. */
const NOT_A_NAME = /\b(estate|agreement|assignment|contract|purchase|sale|page|document|assignor|assignee|buyer|seller|entity|company|the|of|and|for|between|dated|this|is|made|real|property|signature|title|abstract|escrow|associates|western|acme homes|form|clear)\b/i;

const SUFFIX_CASE: Record<string, string> = { llc: 'LLC', 'l.l.c': 'LLC', 'l.l.c.': 'LLC', inc: 'Inc', 'inc.': 'Inc', corp: 'Corp', 'corp.': 'Corp', corporation: 'Corporation', lp: 'LP', llp: 'LLP', ltd: 'Ltd', 'ltd.': 'Ltd', pllc: 'PLLC' };

/** "ACME HOLDINGS, LLC." / "rapid home buyers llc" / "NCNP, Inc." → "Acme Holdings LLC" / "Rapid Home Buyers LLC" / "NCNP Inc". */
export function entityDisplay(raw: string): string {
  const t = str(raw).replace(/[.,\s]+$/, '').replace(/\s+/g, ' ');
  const m = /^(.*?)[,\s]*\s(\S+)$/.exec(t);
  if (!m) return t;
  const body = m[1].replace(/,\s*$/, '').trim();
  const suffix = SUFFIX_CASE[m[2].toLowerCase()] ?? m[2];
  const allCaps = body === body.toUpperCase();
  const allLower = body === body.toLowerCase();
  // An acronym stays one: "NCNP Inc", not "Ncnp Inc".
  const acronym = allCaps && !/\s/.test(body) && body.length <= 5;
  const words = (allCaps || allLower) && !acronym ? body.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : body;
  return `${words} ${suffix}`.replace(/\s+/g, ' ').trim();
}

/** Company names in a block of contract text, in order of appearance, each once (by entityKey). */
export function entitiesIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ENTITY_RE)) {
    // Walk back from the suffix: keep the capitalised run right before it, stop at a fragment word.
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/,$/, ''));
    const keep: string[] = [];
    // One name is set in one case: "DISBURSEMENT AUTHORIZATION Rapid Home Buyers LLC" stops where the capitals start.
    const style = (w: string) => (w === w.toUpperCase() ? 'caps' : w === w.toLowerCase() ? 'lower' : 'title');
    const want = style(words[words.length - 1] ?? '');
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!w || NOT_A_NAME.test(w) || !/^[A-Za-z0-9&'.-]+$/.test(w)) break;
      if (style(w) !== want && !/^(?:&|of|and|de|la)$/i.test(w) && !/^\d/.test(w)) break;
      keep.unshift(w);
    }
    if (!keep.length) continue;
    const name = entityDisplay(`${keep.join(' ')} ${m[2]}`);
    if (NOT_A_NAME.test(name.replace(SUFFIX, '')) && !/holdings|investments|capital|homes|buyers|properties|group/i.test(name)) continue;
    const k = entityKey(name);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(name);
  }
  return out;
}

const cap = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

const personLine = (line: string): string | null => {
  const t = line.trim().replace(/\s+(COO|CEO|CFO|Owner|Manager|Member|Managing Member|President|MGR|as MGR|Dispo|dispo)$/i, '').trim();
  if (!/^[A-Za-z][A-Za-z'.-]+(?:\s+[A-Za-z][A-Za-z'.-]+){1,2}$/.test(t)) return null;
  if (SUFFIX.test(t) || NOT_A_NAME.test(t) || /^(?:Clear Form|Document Ref|Signed with)/i.test(t)) return null;
  return cap(t);
};

/**
 * The parties off an assignment's text, by rule, for the two templates the
 * Drive holds (Acme Homes' own, and New Western's) and a fair guess at any
 * other. Claude reads the PDF for the real pass (dispo-contracts); this is
 * the fallback when the key is missing, and the test of what a parse must
 * carry. Where it reads from:
 *   - the parties: the signature block at the end, where each form prints
 *     the two entities in a fixed order (Acme Homes: assignor then assignee;
 *     New Western: assignee then assignor)
 *   - the people: the line under each entity in that block, or PandaDoc's
 *     signer list (name, EMAIL, PHONE)
 *   - the money: labelled blanks (New Western) or the row of filled blanks
 *     Acme Homes' form prints after page one (price, fee, deposit, total)
 */
export function parseAssignmentText(text: string): ContractParties {
  const t = text.replace(/\\_/g, '_').replace(/_{2,}/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const lines = t.split('\n').map((l) => l.trim());
  const nw = /New Western/i.test(t);
  const hp = /Acme Homes 4266 Example|Assignor \(Wholesaler\)|Assignee \(Buyer\)|Assignor \(Seller\)/i.test(t);
  const out: ContractParties = {
    assignor: null, assignee: null, original_seller: null, assignor_person: null, assignee_person: null,
    assignor_email: null, assignee_email: null, assignor_phone: null, assignee_phone: null,
    property: null, purchase_price: null, assignment_fee: null, total_price: null, contract_date: null, closing_date: null, title_company: null,
    template: hp ? 'operator' : nw ? 'new_western' : 'other',
  };

  // The parties, from the signature block.
  const sigAt = Math.max(t.lastIndexOf('IN WITNESS WHEREOF'), t.lastIndexOf('SIGNATURES'), t.lastIndexOf('Signatures on next page'));
  const sig = sigAt >= 0 ? t.slice(sigAt) : t.slice(-3000);
  const sigEntities = entitiesIn(sig);
  const all = entitiesIn(t);
  const ordered = sigEntities.length >= 2 ? sigEntities : all;
  const [first, second] = ordered;
  if (nw) { out.assignee = first ?? null; out.assignor = second ?? null; }
  else { out.assignor = first ?? null; out.assignee = second ?? null; }
  // Acme Homes' AB form names the counterparty "Assignor (Wholesaler)"; when the block order put Acme Homes there, swap.
  const ours = (n: string | null) => !!n && /acme holdings|acme homes/i.test(n);
  if (/Assignor \(Wholesaler\)/i.test(t) && ours(out.assignor) && !ours(out.assignee)) { const a = out.assignor; out.assignor = out.assignee; out.assignee = a; }
  if (/Assignor \(Seller\)/i.test(t) && ours(out.assignee) && !ours(out.assignor)) { const a = out.assignor; out.assignor = out.assignee; out.assignee = a; }

  // The person under each entity in the signature block.
  const sigLines = sig.split('\n').map((l) => l.trim()).filter(Boolean);
  const personUnder = (entity: string | null): string | null => {
    if (!entity) return null;
    const k = entityKey(entity);
    for (let i = 0; i < sigLines.length; i++) {
      if (!entitiesIn(sigLines[i]).some((e) => entityKey(e) === k)) continue;
      for (let j = i + 1; j < Math.min(sigLines.length, i + 4); j++) { const p = personLine(sigLines[j]); if (p) return p; }
    }
    return null;
  };
  out.assignor_person = personUnder(out.assignor);
  out.assignee_person = personUnder(out.assignee);

  // PandaDoc's signer list: NAME / EMAIL x / PHONE y. Acme Homes' own signer is one side; the other signer is the counterparty.
  const signers = Array.from(t.matchAll(/\n([A-Z][A-Z .'-]{3,40})\n+EMAIL ([^\s]+@[^\s]+)\n+(?:PHONE (\+?\d[\d\s()-]{8,}))?/g)).map((m) => ({ name: cap(m[1].trim()), email: m[2].toLowerCase(), phone: m[3]?.replace(/\s+/g, '') ?? null }));
  const isOurs = (s: { email: string }) => /yourcompany\.com|acmehomes/i.test(s.email);
  const them = signers.find((s) => !isOurs(s)) ?? null;
  const us = signers.find(isOurs) ?? null;
  const weAssign = ours(out.assignor);
  const put = (side: 'assignor' | 'assignee', s: { name: string; email: string; phone: string | null }) => {
    if (side === 'assignor') { out.assignor_person = out.assignor_person ?? s.name; out.assignor_email = s.email; out.assignor_phone = s.phone; }
    else { out.assignee_person = out.assignee_person ?? s.name; out.assignee_email = s.email; out.assignee_phone = s.phone; }
  };
  if (them) put(weAssign ? 'assignee' : 'assignor', them);
  if (us) put(weAssign ? 'assignor' : 'assignee', us);

  // The property: the labelled line (New Western), else the first address line that is not Acme Homes' own office.
  const labelled = /(?:regarding the property located at:?)\s*([^\n]{6,120})/i.exec(t)?.[1];
  const addrLine = (l: string) => /^\d{2,6}[A-Za-z]?\s+[A-Za-z0-9]/.test(l) && /\b\d{5}(?:-\d{4})?\b/.test(l) && !/your company llc/i.test(l) && l.length < 110;
  const line = labelled ?? lines.find(addrLine) ?? null;
  out.property = line ? line.replace(/\s+/g, ' ').replace(/^(\d+[A-Za-z]?)\s*,\s*/, '$1 ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[.,\s]+$/, '').trim() : null;

  // Money: labelled blanks first.
  const grab = (re: RegExp) => moneyOf(re.exec(t)?.[1] ?? null);
  out.purchase_price = grab(/(?:Property Purchase Price\.?\s*\$\s?|for the amount of \$\s?|Purchase Price:?\s*\$\s?)([\d,]+(?:\.\d{2})?)/i);
  out.assignment_fee = grab(/(?:Assignment Fee\.?\s*\$\s?|assignment fee in the amount of \$\s?|Assignment Fee:?\s*\$\s?)([\d,]+(?:\.\d{2})?)/i);
  out.total_price = grab(/(?:Total (?:Purchase )?Price\.?\s*\$\s?|plus the Assignment Fee shall be \$\s?|equals \$\s?)([\d,]+(?:\.\d{2})?)/i);
  if (!out.purchase_price && !out.total_price) {
    // Acme Homes' form prints the filled blanks after page one: price, fee, deposit, total. Phone numbers and refs never carry a comma or cents.
    const row = Array.from(t.matchAll(/(?<![\d+$.])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{3,6}\.\d{2})(?![\d])/g)).map((m) => moneyOf(m[1])).filter((n): n is number => n !== null && n >= 1000);
    const big = Array.from(new Set(row)).sort((a, b) => b - a);
    if (big.length) {
      out.total_price = big[0];
      // A second figure near the total is the purchase price; a small one is the deposit, not a price.
      const price = big.find((n) => n < big[0] && n >= big[0] * 0.5) ?? null;
      out.purchase_price = price;
      if (price) out.assignment_fee = big[0] - price;
    }
  }
  if (out.total_price && out.purchase_price && !out.assignment_fee && out.total_price > out.purchase_price) out.assignment_fee = out.total_price - out.purchase_price;
  if (out.purchase_price && out.assignment_fee && !out.total_price) out.total_price = out.purchase_price + out.assignment_fee;

  // Dates.
  const closeAt = t.search(/Closing (?:Date|shall occur|is to take place)/i);
  const afterClose = closeAt >= 0 ? t.slice(closeAt, closeAt + 400) : '';
  out.closing_date = dateOf(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/.exec(afterClose)?.[1]) ?? dateOf(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i.exec(afterClose)?.[1]);
  out.contract_date = dateOf(/(?:Assignment dated|Agreement dated|is dated|entered into as of)\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i.exec(t)?.[1])
    ?? dateOf(lines.find((l) => /^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(l)) ?? null);

  // The title company: a short line naming one, not a clause about title.
  const titleLine = lines.find((l) => l.length <= 70 && /\b(title|abstract|escrow)\b/i.test(l) && !/\b(shall|must|clear|marketable|insurable|company shall|agent|restriction|commitment|contingent|disclosure|interest|rights|hold|legal|owns|paragraph|following|chosen)\b/i.test(l) && !/^\d/.test(l) && !/\(/.test(l));
  out.title_company = titleLine ? titleLine.split(/\s+-\s+|\s+in\s+/i)[0].replace(/[.,\s]+$/, '').trim() : null;

  // The original seller: labelled (New Western), else the first person line after the property (Acme Homes' value row).
  const nwSeller = /with ([A-Z][A-Za-z ,'.\n-]{2,60}?) as seller/.exec(t)?.[1];
  if (nwSeller) out.original_seller = nwSeller.replace(/[,\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  else if (line) {
    const at = lines.indexOf(line);
    for (let j = at + 1; j < Math.min(lines.length, at + 6); j++) { const p = personLine(lines[j]); if (p && p !== out.assignor_person && p !== out.assignee_person) { out.original_seller = p; break; } }
  }
  return out;
}

/** Which leg of the daisy chain a Acme Homes contract is: AB when Acme Homes buys the contract, BC when it sells it on. */
export function legOf(p: ContractParties, ours = /your company llc/i): 'AB' | 'BC' | 'AA' | 'unknown' {
  const a = ours.test(str(p.assignor)); const b = ours.test(str(p.assignee));
  if (a && b) return 'AA';
  if (a) return 'BC';
  if (b) return 'AB';
  return 'unknown';
}

/** The address pieces a contract's property line gives: "3377 Ashby Pl, Oklahoma City, OK 73111-6230", or "109 N WATER LN NEW BRAUNFELS TX 78130". */
export function splitProperty(line: string | null | undefined): { address: string | null; city: string | null; state: string | null; zip: string | null } {
  const t = str(line).replace(/\s+/g, ' ');
  if (!t) return { address: null, city: null, state: null, zip: null };
  const abbr: Record<string, string> = { texas: 'TX', oklahoma: 'OK', florida: 'FL', georgia: 'GA', 'north carolina': 'NC', 'south carolina': 'SC', tennessee: 'TN', missouri: 'MO', indiana: 'IN', arkansas: 'AR', alabama: 'AL', ohio: 'OH', kentucky: 'KY', 'new york': 'NY', pennsylvania: 'PA', oregon: 'OR', arizona: 'AZ', colorado: 'CO' };
  const STATES = 'Texas|Oklahoma|Florida|Georgia|North Carolina|South Carolina|Tennessee|Missouri|Indiana|Arkansas|Alabama|Ohio|Kentucky|New York|Pennsylvania|Oregon|Arizona|Colorado';
  const st = (s: string) => (s.length === 2 ? s.toUpperCase() : abbr[s.toLowerCase()] ?? null);
  let m = new RegExp(`^(.+?),\\s*([A-Za-z .'-]+?),?\\s*([A-Za-z]{2}|${STATES})\\.?,?\\s*(\\d{5})(?:-\\d{4})?\\s*$`, 'i').exec(t);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: st(m[3]), zip: m[4] };
  // No commas: the street type ends the address.
  m = new RegExp(`^(\\d+[A-Za-z]?\\s+.+?\\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|pl|place|way|cir|circle|trl|trail|pkwy|loop|hwy|ter|terrace|cv|cove|bnd|bend|run|path|pass|xing)\\b\\.?(?:\\s+(?:apt|unit|#)\\s*\\S+)?)\\s+(.+?)\\s+([A-Za-z]{2}|${STATES}),?\\s+(\\d{5})(?:-\\d{4})?\\s*$`, 'i').exec(t);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: st(m[3]), zip: m[4] };
  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(t)?.[1] ?? null;
  const state = /\b([A-Z]{2})\b,?\s*\d{5}/.exec(t)?.[1] ?? null;
  return { address: t.split(',')[0]?.trim() || null, city: t.split(',')[1]?.trim() || null, state, zip };
}

/** Same house: the street and the zip, however the two lines spelled the rest. */
export const sameHouse = (a: string | null | undefined, b: string | null | undefined) => {
  const A = splitProperty(a); const B = splitProperty(b);
  return !!A.address && !!B.address && addressKey(A.address) === addressKey(B.address) && (!A.zip || !B.zip || A.zip === B.zip);
};

/** Where a buyer prospect came from, for tags and campaign filters. */
export type Method = 'contract' | 'dealmachine' | 'facebook';
export const METHOD_LABEL: Record<Method, string> = { contract: 'Contract', dealmachine: 'Deal Machine', facebook: 'Facebook' };
export const METHOD_TAG: Record<Method, string> = { contract: 'contract-buyer', dealmachine: 'deal-machine', facebook: 'fb-comment' };
