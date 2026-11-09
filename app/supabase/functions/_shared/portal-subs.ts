/**
 * Chris's portal and partner submissions → flat ingest rows (portal-submissions function).
 *
 * Pure (no Deno, no network) so tools/portal-subs.test.ts runs it directly.
 * A sheet is a 2D array of strings: a CSV attachment, an xlsx tab, or a
 * Google Sheet exported as CSV. The header row is found by looking for an
 * address column; every other column the mapping does not know becomes a
 * "Header: value" line in the deal notes, so nothing a partner sends is lost.
 */

export type Submission = {
  source: string; // label shown on the deal: "Offerpad", "Mark Spain TX"
  external_id: string;
  address: string; city?: string; state?: string; zip?: string;
  beds?: number; baths?: number; sqft?: number; year_built?: number; property_type?: string;
  asking_price?: number; arv?: number; listing_url?: string;
  notes: string[];
};

/** Partner senders by email domain, or by full address when the domain is shared (an eXp agent, not all of eXp). Anything else is reported, never imported (a stray spreadsheet is not a deal). */
export const SENDERS: Record<string, string> = {
  'offerpad.com': 'Offerpad',
  'markspain.com': 'Mark Spain',
  'ifinderoffers.com': 'iFinder',
  'easystreetoffers.com': 'Easy Street',
  'orchard.com': 'Orchard',
  'orchardoffers.com': 'Orchard',
  'zoodealio.com': 'Express Offers',
  'zoodealioinvestors.com': 'Express Offers',
  'blankethomes.com': 'EXP Off Market',
  'placeinstitutional.com': 'Place',
  'keystonesfr.com': 'Keystone SFR',
  'privatepartnersgrp.com': 'Private Partners Group',
  'jeff.holloway@brokerage.example': 'eXp Cash Offers',
};

/** The partner label for a From header, or null for a sender not on the list. `extra` is "domain=Label,…" from config. */
export function senderLabel(from: string, extra = ''): string | null {
  const address = (from.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? '').toLowerCase();
  const domain = address.split('@')[1] ?? '';
  if (!domain) return null;
  const known: Record<string, string> = { ...SENDERS };
  for (const pair of extra.split(',')) {
    const [d, l] = pair.split('=').map((s) => s?.trim());
    if (d && l) known[d.toLowerCase()] = l;
  }
  for (const [d, label] of Object.entries(known)) if (d.includes('@') ? address === d : domain === d || domain.endsWith('.' + d)) return label;
  return null;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** `=HYPERLINK("url","label")` → url. Anything else is returned trimmed. */
export function unwrapHyperlink(v: string): string {
  const m = v.trim().match(/^=?HYPERLINK\(\s*"([^"]*)"/i);
  return m ? m[1] : v.trim();
}

export function money(v: string | undefined): number | undefined {
  const s = (v ?? '').replace(/[$,\s]/g, '');
  if (!s) return undefined;
  const n = Number(s.replace(/k$/i, '')) * (/k$/i.test(s) ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type Field = 'address' | 'city' | 'state' | 'zip' | 'beds' | 'baths' | 'sqft' | 'year_built' | 'property_type' | 'asking_price' | 'arv' | 'link' | 'id';
const ALIASES: Record<Field, string[]> = {
  address: ['address', 'property address', 'street', 'street address', 'property', 'address line 1'],
  city: ['city'],
  state: ['state', 'st'],
  zip: ['zip', 'zip code', 'zipcode', 'postal', 'postal code'],
  beds: ['beds', 'bedrooms', 'bed', 'br'],
  baths: ['baths', 'bathrooms', 'bath', 'ba'],
  sqft: ['sqft', 'sq ft', 'square feet', 'living area', 'square footage', 'gla'],
  year_built: ['year built', 'yr built', 'year'],
  property_type: ['property type', 'type', 'build type'],
  asking_price: ['price', 'asking', 'asking price', 'list price', 'purchase price', 'list'],
  arv: ['arv', 'suggested value', 'estimated value', 'value'],
  link: ['link', 'property link', 'url', 'listing', 'listing url', 'listing link'],
  id: ['id', 'listing id', 'property id'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fieldOf = (h: string): Field | null => {
  const n = norm(h);
  for (const [f, names] of Object.entries(ALIASES)) if (names.includes(n)) return f as Field;
  return null;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const keyPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A sheet's rows → submissions, or null when no header row in the first ten
 * has an address column (an unknown layout: reported, not an error).
 * `source` is the label; `idPrefix` keys the ledger ("offerpad", "markspain:tx").
 */
export function sheetToSubmissions(rows: string[][], source: string, idPrefix: string): Submission[] | null {
  const at = rows.slice(0, 10).findIndex((r) => r.some((h) => fieldOf(h) === 'address'));
  if (at < 0) return null;
  const header = rows[at];
  const fields = header.map(fieldOf);
  const out: Submission[] = [];
  for (const r of rows.slice(at + 1)) {
    const get = (f: Field) => {
      const i = fields.indexOf(f);
      return i < 0 ? undefined : unwrapHyperlink(r[i] ?? '') || undefined;
    };
    const address = get('address');
    if (!address || !/\d/.test(address)) continue;
    const num = (f: Field) => { const n = Number((get(f) ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : undefined; };
    const link = get('link');
    const notes: string[] = [];
    if (link) notes.push(`${source}: ${link}`);
    header.forEach((h, i) => {
      const v = unwrapHyperlink(r[i] ?? '');
      if (fields[i] || !v) return;
      // Offerpad's last column has no header; it is the sale type ("First Look", "Buy It Now").
      notes.push(`${h.trim() || 'Sale type'}: ${v}`);
    });
    const zip = get('zip')?.match(/\d{5}/)?.[0];
    const own = get('id') ?? link?.match(UUID)?.[0];
    out.push({
      source,
      external_id: `${idPrefix}:${own ? keyPart(own) : `${keyPart(address)}:${zip ?? keyPart(get('city') ?? '')}`}`,
      address, city: get('city'), state: get('state')?.toUpperCase(), zip,
      beds: num('beds'), baths: num('baths'), sqft: num('sqft'), year_built: num('year_built'),
      property_type: get('property_type'),
      asking_price: money(get('asking_price')), arv: money(get('arv')),
      listing_url: link && /^https?:\/\//i.test(link) ? link : undefined,
      notes,
    });
  }
  return out;
}

/** A submission as a flat wholesaler.create (docs/webhooks.md), so it lands on New Submission (migration 387). */
export function submissionToFlat(s: Submission): Record<string, unknown> {
  return {
    event: 'wholesaler.create',
    external_id: s.external_id,
    // The partner is the wholesaler on the deal and the contact, as the Podio imports filed them ("Place", "iFinder").
    company: s.source,
    address: s.address, city: s.city, state: s.state, zip: s.zip,
    beds: s.beds, baths: s.baths, sqft: s.sqft, year_built: s.year_built, property_type: s.property_type,
    asking_price: s.asking_price,
    // The portal's own number is a reference; COMPR sets its own ARV.
    arv: s.arv,
    tags: `Portal, ${s.source}`,
    subject: `New submission from ${s.source}`,
    lead_source: s.source,
    notes: s.notes.join('\n') || undefined,
  };
}

/**
 * Rows a portal worker POSTs (Felix's browser pull: Express Offers, Orchard, Place) → submissions.
 * The body is untrusted: strings are trimmed and capped, numbers must be positive, a row needs
 * external_id, source and address or it is rejected by index. At most POSTED_MAX rows per call.
 */
export const POSTED_MAX = 500;
export function postedSubmissions(rows: unknown): { subs: Submission[]; rejected: string[] } {
  const out = { subs: [] as Submission[], rejected: [] as string[] };
  if (!Array.isArray(rows)) { out.rejected.push('submissions is not an array'); return out; }
  if (rows.length > POSTED_MAX) out.rejected.push(`only the first ${POSTED_MAX} of ${rows.length} rows were read`);
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const pos = (v: unknown) => { const n = typeof v === 'string' ? money(v) : typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined; return n; };
  rows.slice(0, POSTED_MAX).forEach((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const external_id = str(r.external_id, 120), source = str(r.source, 60), address = str(r.address);
    if (!external_id || !source || !address) { out.rejected.push(`row ${i}: needs external_id, source and address`); return; }
    const rawUrl = str(r.listing_url, 500);
    const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
    const notes = [
      url && `Listing: ${url}`,
      str(r.posted_at, 40) && `Posted: ${str(r.posted_at, 40)}`,
      str(r.offer_deadline, 40) && `Offer deadline: ${str(r.offer_deadline, 40)}`,
      str(r.notes, 2000),
    ].filter((x): x is string => !!x);
    out.subs.push({
      source, external_id, address,
      city: str(r.city, 80), state: str(r.state, 20)?.toUpperCase(), zip: str(r.zip, 10),
      beds: pos(r.beds), baths: pos(r.baths), sqft: pos(r.sqft), year_built: pos(r.year_built),
      property_type: str(r.property_type, 60), asking_price: pos(r.asking_price), arv: pos(r.arv),
      listing_url: url, notes,
    });
  });
  return out;
}

/** PORTAL_STATES ("TX,GA") limits which states get imported; empty means every state. */
export function inMarkets(state: string | undefined, allowed: string): boolean {
  const list = allowed.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  return !list.length || (!!state && list.includes(state.toUpperCase()));
}

/** Mail from markspain.com carries no state in the sender; the subject or a sheet link usually does ("MSRE Investor Sheet TX"). */
export function markSpainLabel(label: string, subject: string): string {
  if (label !== 'Mark Spain') return label;
  const st = subject.match(/\b(TX|NC|FL|Texas|North Carolina|Florida)\b/i)?.[1]?.toUpperCase();
  const code = st === 'TEXAS' ? 'TX' : st === 'NORTH CAROLINA' ? 'NC' : st === 'FLORIDA' ? 'FL' : st;
  return code ? `${label} ${code}` : label;
}

/**
 * The only addresses the summary may ever go to, as a draft or a send. Not
 * config: nothing outside Acme Homes gets this mail, whatever the env says.
 */
export const SUMMARY_ALLOW = ['sam@yourcompany.com'] as const;
export function summaryRecipient(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return (SUMMARY_ALLOW as readonly string[]).includes(e) ? e : null;
}

/** Zero rows today from a source that had rows before, and the two runs before today were empty too: three days quiet. */
export function quietThreeDays(found: number, previous: number[]): boolean {
  return found === 0 && previous.length >= 3 && previous[0] === 0 && previous[1] === 0 && previous.some((n) => n > 0);
}

export type SourceReport = { source: string; found: number; created: number; existing: number; deduped: number; failed: number; lines: string[]; error?: string };
/** The summary mail (spec section 9): subject and plain text body. Pure, so the test reads it. */
export function summaryMail(opts: {
  date: Date; live: boolean; assignee: string; report: SourceReport[]; unknown: string[];
  compr: { queued: number; done: number; failed: string[] }; link?: string;
}): { subject: string; text: string } {
  const { report, compr } = opts;
  const sum = (k: 'created' | 'existing') => report.reduce((n, r) => n + r[k], 0);
  const failedSources = report.filter((r) => r.error);
  const mdy = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric' }).format(opts.date);
  const subject = `Submissions ${mdy}${opts.live ? '' : ' (dry run)'}: ${sum('created')} new, ${sum('existing')} already in Clozr`
    + (failedSources.length ? `, ${failedSources.length} source${failedSources.length > 1 ? 's' : ''} failed` : '');
  const addresses = (r: SourceReport) => {
    const a = r.lines.filter((l) => /^(added|would add): /.test(l)).map((l) => l.replace(/^(added|would add): /, '').trim()).filter(Boolean);
    return a.length ? ` (${a.slice(0, 3).join(', ')}${a.length > 3 ? ' ...' : ''})` : '';
  };
  const text = [
    'Morning Sam,',
    '',
    `New in Clozr (New Submission, ${opts.assignee}):`,
    ...(report.some((r) => r.created) ? report.filter((r) => r.created).map((r) => `- ${r.source}: ${r.created}${addresses(r)}`) : ['- none']),
    '',
    `Already in Clozr, skipped: ${sum('existing')}`,
    `Sent to Compr: ${compr.queued}, underwritten: ${compr.done}.`,
    ...(failedSources.length || opts.unknown.length || compr.failed.length ? ['', 'Needs you:'] : []),
    ...failedSources.map((r) => `- ${r.source}: ${r.error}`),
    ...compr.failed.map((f) => `- Compr: ${f}`),
    ...opts.unknown.map((u) => `- ${u}`),
    ...(opts.link ? ['', `Full list: ${opts.link}`] : []),
  ].join('\n');
  return { subject, text };
}

/** True at 8 AM in Chicago on a weekday. The cron fires at 13:00 and 14:00 UTC; this keeps the one that is 8 AM across DST. */
export function isEightAmCentral(d: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return hour === 8 && !['Sat', 'Sun'].includes(day);
}
