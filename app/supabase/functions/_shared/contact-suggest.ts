/**
 * Agents, escrow officers and title reps in the team's mail who are not in
 * CLOZR yet (migration 259). Pure: google.ts reads the headers and writes the
 * rows; this decides who is worth suggesting and what they are.
 *
 * A person at a title company we already use (their address shares a domain
 * with a Title Company vendor) is `title` with that company's name, and the
 * sync adds them on its own. Anyone else is suggested only on a clear signal:
 * a brokerage or title domain, or real-estate words in the subject, the first
 * lines or the attachment names. Mailers and no-reply senders never are.
 */

export type SuggestKind = 'agent' | 'title';
export type Stranger = { email: string; name: string | null; kind: SuggestKind; company: string | null; known_company: boolean };

/** Personal mail domains: they say nothing about the company and never match a title company. */
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'att.net', 'sbcglobal.net', 'comcast.net', 'verizon.net', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'charter.net', 'cox.net', 'bellsouth.net', 'earthlink.net',
]);

/** Addresses that are machines, not people. */
const ROBOT = /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounce[s]?|alerts?|updates?|news(letter)?|marketing|support|billing|receipts?|calendar-notification)([+.\-_]|@)/i;

/** Brokerages and the listing tools agents send from. */
const AGENT_DOMAINS = [
  'kw.com', 'kwrealty.com', 'exprealty.com', 'exprealty.net', 'compass.com', 'remax.net', 'remax.com', 'century21.com',
  'coldwellbanker.com', 'cbrealty.com', 'bhhs.com', 'bhhsnw.com', 'redfin.com', 'sothebysrealty.com', 'realtyonegroup.com',
  'kellerwilliams.com', 'elliman.com', 'corcoran.com', 'weichert.com', 'era.com', 'c21.com', 'phyllisbrowning.com',
  'fathomrealty.com', 'lpthomes.com', 'lpt.com', 'realbroker.com', 'onereal.com', 'homesmart.com', 'unitedrealestate.com',
];
const AGENT_DOMAIN_WORD = /(realty|realtor|realestate|real-estate|properties|homes|brokerage|kwsa|remax|century21|coldwell|keller)/i;

/** National underwriters and the words title and escrow shops put in their domains. */
const TITLE_DOMAINS = [
  'stewart.com', 'firstam.com', 'fnf.com', 'ctt.com', 'chicagotitle.com', 'fidelitytitle.com', 'oldrepublictitle.com',
  'ortc.com', 'wfgnationaltitle.com', 'titleresourcesguaranty.com', 'independencetitle.com', 'alamotitle.com', 'qualitytitle.com',
];
const TITLE_DOMAIN_WORD = /(title|escrow|abstract|closings?|settlement)/i;

const AGENT_WORDS = /\b(realtor|listing agent|buyer'?s agent|seller'?s agent|mls|showing(s)?|listing|brokerage|broker|trec|cda|commission|co-?op)\b/i;
const TITLE_WORDS = /\b(escrow( officer)?|title (commitment|company|work|policy|insurance|search|exam)|closing disclosure|settlement statement|hud(-1)?|earnest money|emd|wire instructions|payoff|tax certs?|closing (date|package|docs?)|gf ?#?\d|file ?#\s*\d)\b/i;

export const domainOf = (email: string) => String(email ?? '').toLowerCase().split('@')[1]?.trim() ?? '';

const onList = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith('.' + d));

/** Each address in a header with the display name in front of it: "Doe, Jane" <j@x.com> → j@x.com → Jane Doe. */
export function namesOf(header: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:"([^"]*)"|([^,<>"]*?))\s*<\s*([^<>\s]+@[^<>\s]+)\s*>/g;
  for (let m = re.exec(header); m; m = re.exec(header)) {
    let name = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim();
    const email = m[3].toLowerCase();
    if (/^[^,]+,\s*[^,]+$/.test(name)) { const [last, first] = name.split(',').map((x) => x.trim()); name = `${first} ${last}`; }
    if (name && !name.includes('@') && !out.has(email)) out.set(email, name.slice(0, 120));
  }
  return out;
}

/** Title company names by mail domain, from the vendors we already use. Personal domains never count. */
export function titleDomains(vendors: { business_name: string | null; email: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of vendors) {
    const company = String(v.business_name ?? '').trim();
    if (!company) continue;
    for (const e of String(v.email ?? '').split(/[;,\s]+/)) {
      const d = domainOf(e);
      if (d && d.includes('.') && !FREEMAIL.has(d) && !out.has(d)) out.set(d, company);
    }
  }
  return out;
}

/**
 * What a person on a message is, or null when there is nothing to go on.
 * `text` is the subject, Gmail's snippet and the attachment names.
 */
export function classifyStranger(email: string, name: string | null, text: string, titles: Map<string, string>): Stranger | null {
  const e = String(email ?? '').toLowerCase().trim();
  if (!e.includes('@') || ROBOT.test(e)) return null;
  const domain = domainOf(e);
  const nm = name?.trim() || null;
  const known = titles.get(domain);
  if (known) return { email: e, name: nm, kind: 'title', company: known, known_company: true };
  const free = FREEMAIL.has(domain);
  const label = `${nm ?? ''} ${text}`;
  if (!free && (onList(domain, TITLE_DOMAINS) || TITLE_DOMAIN_WORD.test(domain.split('.')[0]))) {
    return { email: e, name: nm, kind: 'title', company: null, known_company: false };
  }
  if (!free && (onList(domain, AGENT_DOMAINS) || AGENT_DOMAIN_WORD.test(domain.split('.')[0]))) {
    return { email: e, name: nm, kind: 'agent', company: null, known_company: false };
  }
  if (TITLE_WORDS.test(label)) return { email: e, name: nm, kind: 'title', company: null, known_company: false };
  if (AGENT_WORDS.test(label)) return { email: e, name: nm, kind: 'agent', company: null, known_company: false };
  return null;
}
