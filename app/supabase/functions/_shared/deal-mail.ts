/**
 * Deal mail: wholesaler blasts and assignment / e-sign mail read off a synced
 * Gmail, turned into LLC rows for wholesaler_entities (source 'gmail',
 * migration 441) so the end-buyer chase and Deal Machine see the wholesalers
 * who mail us before any deed names them.
 *
 * Rules only. A shared deals@ inbox takes hundreds of blasts a day, and an
 * LLM per message would cost more than the leads are worth; a regex miss is
 * one LLC the next blast from the same sender names again.
 *
 * Pure, no I/O: google.ts calls it and writes the rows. Test:
 * npx tsx tools/deal-mail.test.ts
 */
import { entityKey } from './podio-keys.ts';

export type DealMailKind = 'blast' | 'assignment';

export type DealMailInput = {
  /** Sender address, lower case or not. */
  from: string;
  /** The display name off the From header, when there is one. */
  fromName?: string | null;
  subject: string;
  /** Plain body text, or the snippet when only headers were read. */
  text: string;
};

/** Hosts whose mail is an e-sign envelope: the assignment or contract itself. */
const ESIGN_HOSTS = /(^|\.)(docusign\.net|docusign\.com|dotloop\.com|pandadoc\.net|pandadoc\.com|hellosign\.com|dropboxsign\.com|signnow\.com|adobesign\.com|echosign\.com)$/i;
const ASSIGNMENT_WORDS = /\b(assignment(?: of (?:contract|purchase))?|assignment fee|assignor|assignee|double close|purchase (?:and sale )?agreement|PSA|please docusign|completed:|signed contract|fully executed|executed contract)\b/i;
/** Words that only a deal blast uses together. Two of them, or one with a price and a street. */
const BLAST_WORDS = /\b(arv|off[- ]market|wholesale|wholesaling|cash buyers?|investor special|motivated seller|fixer(?:[- ]upper)?|flip|rehab|repairs?|price (?:drop|reduced|reduction)|new deal|deal alert|hot deal|exclusive|emd|asking|under contract|comps|cash only|as[- ]is|buy box)\b/gi;
const PRICE = /\$\s?\d{2,3}(?:,\d{3}|k\b)/i;

const host = (email: string) => String(email).toLowerCase().split('@')[1] ?? '';

/** 'assignment' for an e-sign envelope or an assignment contract, 'blast' for a wholesaler's deal email, else null. */
export function dealMailKind(m: DealMailInput): DealMailKind | null {
  const all = `${m.subject}\n${m.text}`;
  if (ESIGN_HOSTS.test(host(m.from))) return 'assignment';
  if (ASSIGNMENT_WORDS.test(m.subject) || (ASSIGNMENT_WORDS.test(all) && /\b(assign|wholesal)/i.test(all))) return 'assignment';
  const words = new Set((all.match(BLAST_WORDS) ?? []).map((w) => w.toLowerCase().replace(/[- ]/g, '')));
  if (words.size >= 2) return 'blast';
  if (words.size === 1 && PRICE.test(all) && streetAddresses(all).length) return 'blast';
  return null;
}

// ---------------------------------------------------------------- entities

/** Each suffix in the cases mail writes it: Title, UPPER, and the dotted LLC. */
const SUFFIXES = ['LLC', 'Inc', 'Holdings', 'Investments', 'Properties', 'Group', 'Capital', 'Ventures', 'Homes', 'Acquisitions'];
const SUFFIX_RE = SUFFIXES.flatMap((s) => [s, s.toUpperCase()]).concat(['L\\.L\\.C\\.?', 'Llc', 'INC\\.?', 'Inc\\.']).join('|');
/** One word of a name: capitalised, a number, or an initial; "&" and "of" may sit between them. */
const WORD = "(?:[A-Z][A-Za-z0-9'’.-]*|\\d+[A-Za-z]*|&|of|and|the)";
const ENTITY = new RegExp(`(?<![A-Za-z0-9])((?:${WORD}[ \\t]+){0,5}${WORD}),?[ \\t]+(${SUFFIX_RE})(?:,?[ \\t]+(LLC|L\\.L\\.C\\.?|Inc\\.?|INC\\.?))?(?![A-Za-z])`, 'g');

/** Words a signature or a sentence puts in front of a name. Peeled off the front. */
const LEAD = new Set(['thanks', 'thank', 'regards', 'best', 'sincerely', 'cheers', 'from', 'by', 'with', 'at', 'for', 'to', 'and', 'the', 'of', 'via', 'signed',
  'sent', 'contact', 'call', 'text', 'email', 'reply', 'team', 'our', 'your', 'my', 'this', 'that', 'new', 'hot', 'deal', 'deals', 'alert', 're', 'fw', 'fwd',
  'investor', 'special', 'off', 'market', 'cash', 'buyers', 'buyer', 'wholesale', 'available', 'now', 'all', 'more', 'view', 'see', 'other', 'similar',
  'featured', 'exclusive', 'list', 'here', 'click', 'please', 'dear', 'hi', 'hello', 'hey', 'is', 'are', 'a', 'an', 'in', 'on', 'llc', 'inc']);
/** Brands every inbox carries, never a wholesaler. Keys as entityKey makes them. */
const NOT_WHOLESALERS = new Set(['docusign', 'dotloop', 'google', 'microsoft', 'zillow', 'opendoor', 'offerpad', 'redfin', 'realtor', 'pandadoc',
  'dropbox', 'adobe', 'intuit', 'facebook', 'meta', 'apple', 'amazon', 'linkedin', 'mailchimp', 'hubspot', 'podio', 'investorlift', 'propstream',
  'batchdata', 'dealmachine', 'compr', 'clozr', 'yahoo', 'zoom', 'calendly', 'stripe', 'paypal', 'intercom', 'constantcontact', 'sendgrid']);

const cap = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "THANKS, ACME HOLDINGS LLC" → "ACME HOLDINGS LLC"; null when nothing but filler is left. */
function trimName(words: string[], suffix: string, tail: string | undefined): string | null {
  const w = [...words];
  while (w.length && LEAD.has(w[0].toLowerCase().replace(/[^a-z]/g, ''))) w.shift();
  while (w.length && /^(&|of|and|the)$/i.test(w[w.length - 1])) w.pop();
  if (!w.length) return null;
  // "Properties" and "Group" alone after one ordinary word are usually prose ("Rental Properties").
  const bare = !tail && /^(properties|group|homes|capital|ventures|investments|acquisitions)$/i.test(suffix);
  if (bare && w.length === 1 && /^[A-Z][a-z]+$/.test(w[0]) && COMMON.has(w[0].toLowerCase())) return null;
  return cap([...w, suffix, tail].filter(Boolean).join(' '));
}
/** Ordinary words that read as prose before "Properties" / "Group" / "Homes". */
const COMMON = new Set(['rental', 'investment', 'distressed', 'vacant', 'sold', 'listed', 'multiple', 'single', 'family', 'these', 'those', 'some', 'many',
  'local', 'great', 'top', 'best', 'cheap', 'flip', 'commercial', 'residential', 'income', 'similar', 'nearby', 'other', 'focus', 'facebook', 'support', 'age']);

export type EntityMention = { name: string; role: 'wholesaler' | 'buyer' };

/** Words just before an LLC that put it on the buying side: "Assignee:", "the end buyer, Acme Holdings LLC". */
const BUYER_BEFORE = /\b(assignee|end[- ]buyer|buyer|purchaser)\b[\s:,-]*(?:is\s+)?$/i;

/** LLC / Inc / Holdings / Investments / Properties / Group names in a body or signature, in order, once each, with the side the line puts them on. */
export function entityMentions(text: string): EntityMention[] {
  const out = new Map<string, EntityMention>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    ENTITY.lastIndex = 0;
    for (let m = ENTITY.exec(line); m; m = ENTITY.exec(line)) {
      const role = BUYER_BEFORE.test(line.slice(Math.max(0, m.index - 40), m.index)) ? 'buyer' : 'wholesaler';
      const name = trimName(m[1].split(/[ \t]+/), m[2], m[3]);
      if (!name) continue;
      const key = entityKey(name);
      if (!key || key.length < 3 || NOT_WHOLESALERS.has(key) || /^\d+$/.test(key)) continue;
      if (!out.has(key)) out.set(key, { name, role });
    }
  }
  return [...out.values()];
}

export const entityNames = (text: string): string[] => entityMentions(text).map((e) => e.name);

// --------------------------------------------------------------- addresses

const STREET = '(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Pl|Place|Way|Pkwy|Parkway|Ter|Terrace|Trl|Trail|Hwy|Highway|Loop|Pike|Sq|Square|Cv|Cove|Xing|Crossing|Row|Run|Pass|Path|Point|Pt)';
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const ADDRESS = new RegExp(
  `(?<![\\w#$])(\\d{2,6}[ \\t]+(?:[NSEW]\\.?[ \\t]+|(?:North|South|East|West)[ \\t]+)?(?:[A-Z0-9][A-Za-z0-9'.]*[ \\t]+){0,3}?${STREET}\\b\\.?(?:[ \\t]+(?:NE|NW|SE|SW|N|S|E|W)\\b)?)` +
  `(?:,?[ \\t]+((?:[A-Z][A-Za-z.'-]*[ \\t]?){1,3}),?[ \\t]+(${STATES})\\b(?:[ \\t]+(\\d{5}))?)?`,
  'g');

export type StreetAddress = { line1: string; city: string | null; state: string | null; zip: string | null };

/** US street addresses: "123 Main St, Memphis, TN 38104". City, state and zip when they follow the street. */
export function streetAddresses(text: string): StreetAddress[] {
  const out = new Map<string, StreetAddress>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    ADDRESS.lastIndex = 0;
    for (let m = ADDRESS.exec(line); m; m = ADDRESS.exec(line)) {
      const line1 = cap(m[1]).replace(/\.$/, '');
      const key = line1.toLowerCase();
      if (!out.has(key)) out.set(key, { line1, city: m[2] ? cap(m[2]) : null, state: m[3] ?? null, zip: m[4] ?? null });
    }
  }
  return [...out.values()];
}

// -------------------------------------------------------------------- rows

export type WholesalerRow = {
  workspace_id: number; name: string; name_key: string; kind: 'wholesaler' | 'buyer'; source: 'gmail';
  state: string | null; contact_name: string | null; email: string | null;
  first_seen: string | null; last_seen: string | null;
  meta: { from: 'gmail'; mail: DealMailKind; subject: string; addresses: string[]; sender: string | null };
};

/**
 * One wholesaler_entities row per LLC a deal email names, kind 'buyer' when
 * the words just before it call it the assignee or the (end) buyer, else
 * 'wholesaler'. The sender's
 * own address goes on a wholesaler row only when it is the sender's mail (a
 * blast); an e-sign envelope comes from DocuSign, whose address names nobody.
 * `ours` is every name_key the workspace itself goes by, so our own LLC in a
 * reply's quoted signature is never filed as a competitor.
 */
export function wholesalerRows(ws: number, m: DealMailInput & { at?: string | null }, ours: ReadonlySet<string> = new Set()): WholesalerRow[] {
  const kind = dealMailKind(m);
  if (!kind) return [];
  const all = `${m.subject}\n${m.text}`;
  const addresses = streetAddresses(all);
  const state = addresses.find((a) => a.state)?.state ?? null;
  const fromName = cap(String(m.fromName ?? '').replace(/^"|"$/g, ''));
  const esign = ESIGN_HOSTS.test(host(m.from));
  const names = entityMentions(`${fromName}\n${all}`);
  const day = m.at ? String(m.at).slice(0, 10) : null;
  const rows: WholesalerRow[] = [];
  for (const { name, role } of names.slice(0, 5)) {
    const key = entityKey(name);
    if (!key || ours.has(key)) continue;
    // The sender's address and name belong to the wholesaler side only.
    const theirs = !esign && role === 'wholesaler';
    rows.push({
      workspace_id: ws, name, name_key: key, kind: role, source: 'gmail', state,
      contact_name: !theirs || !fromName || entityKey(fromName) === key ? null : fromName.slice(0, 120),
      email: theirs ? String(m.from).toLowerCase() || null : null,
      first_seen: day, last_seen: day,
      meta: { from: 'gmail', mail: kind, subject: m.subject.slice(0, 200), addresses: addresses.slice(0, 5).map((a) => [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ')), sender: esign ? null : String(m.from).toLowerCase() || null },
    });
  }
  return rows;
}
