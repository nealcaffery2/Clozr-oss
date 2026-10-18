/**
 * Email deliverability, the pure half: no network, no database, no Deno.
 *
 * Imported by the edge functions (`deliverability`, `google-sync`) as
 * `./deliverability-rules.ts` and by the browser through lib/deliverability.ts,
 * so the score a rep sees in the composer is the score the server enforces.
 * Tests: npx tsx tools/deliverability.test.ts
 *
 * Nothing here can promise the Primary tab. Gmail decides that per recipient.
 * What it does is measure the signals that decide it — authentication,
 * reputation, volume, bounces, content — and refuse the sends that would
 * damage them.
 */

// ------------------------------------------------------------------ types
export type Status = 'pass' | 'warn' | 'fail' | 'unknown' | 'info';
/**
 * A record to add, exactly as a DNS host's form wants it. `host` starts out
 * relative to the domain being checked; {@link placeDnsFixes} rewrites it
 * relative to the zone the DNS host manages (`deals` on thecompr.ai, never a
 * bare `@` for a subdomain) and fills in `fqdn`. `paste: false` means
 * `value` is an instruction, not something to copy into DNS.
 */
export type DnsFix = { type: 'TXT' | 'CNAME' | 'MX'; host: string; value: string; note?: string; fqdn?: string; paste?: false };
export type Check = {
  key: string; label: string; status: Status; detail: string;
  /** Deducted from 100 when this check is not a pass. */
  points: number;
  /** A fail here stops bulk sending (OutboundOS launch rules). */
  blocking?: boolean;
  fix?: DnsFix;
};

export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);

/** Day-one bulk volume. The ramp climbs from here; a brand-new address does not open at the full cap. */
export const WARMUP_START = 50;

/** Who emails buyers, and therefore gets from-addresses on the blast domain. */
export const BUYER_SEND_ROLES = ['owner', 'admin', 'dispositions', 'sdr'] as const;

/**
 * Addresses on the blast domain for one rep. Ten at 100/day is 1,000 once
 * warm. Day one is still {@link WARMUP_START} per address.
 */
export const ADDRESSES_PER_REP = 10;
export const PER_ADDRESS_TARGET = 100;

export const domainOf = (email: string) => (email.split('@')[1] ?? '').trim().toLowerCase();

/** Local part safe to put on the blast domain: letters and digits only, 2–40. */
export function repLocalPart(email: string): string | null {
  const local = (email.split('@')[0] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z0-9]{2,40}$/.test(local) ? local : null;
}

/**
 * A rep's blast address: the local part of their real inbox on the sending
 * domain. `jamie@yourcompany.com` on `deals.yourcompany.com` is
 * `jamie@deals.yourcompany.com`. Replies still go to the real inbox.
 */
export function repBlastAddress(email: string, domain: string): string | null {
  const local = (email.split('@')[0] ?? '').trim().toLowerCase();
  const host = domain.trim().toLowerCase();
  if (!isDomain(host)) return null;
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local)) return null;
  const addr = `${local}@${host}`;
  return addr.length <= 254 ? addr : null;
}

/**
 * The rep's numbered pool: `morgan1@domain` … `morgan10@domain`. Buyers see one
 * person; the CRM tells the addresses apart by the number and by `user_id`.
 */
export function repBlastAddresses(email: string, domain: string, count = ADDRESSES_PER_REP): string[] {
  const local = repLocalPart(email);
  const host = domain.trim().toLowerCase();
  if (!local || !isDomain(host)) return [];
  const out: string[] = [];
  for (let n = 1; n <= count; n++) {
    const addr = `${local}${n}@${host}`;
    if (addr.length > 254) break;
    out.push(addr);
  }
  return out;
}

/**
 * The addresses a campaign may send from. A rep's blast stays on that rep's
 * rows. When nobody owns a row yet (only the shared deals@ sender), the whole
 * list is the pool. A launcher with no rows of their own falls back to every
 * owned address so mail still goes out.
 */
/** Most addresses one rep may have per blast domain (settings.blast_addresses_per_rep). */
export const MAX_ADDRESSES_PER_REP = 25;

/**
 * Every domain blasts go out on: the workspace's blast sender domain first
 * (settings.blast_from, else the project's MAIL_FROM_BLASTS), then its extra
 * ones (settings.blast_domains), each verified on Resend
 * (Settings → Outbound OS → add the domain, then "Set up on Resend").
 * Duplicates and anything that is not a domain are dropped.
 */
export function blastDomains(primary: string | null | undefined, extra: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const d of [primary, ...(extra ?? [])]) {
    const host = String(d ?? '').trim().toLowerCase().replace(/^.*@/, '');
    if (host && isDomain(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

/** Addresses per rep per domain, from the workspace setting, within 1..MAX_ADDRESSES_PER_REP. */
export function addressesPerRep(setting: unknown): number {
  const n = Math.floor(Number(setting));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_ADDRESSES_PER_REP) : ADDRESSES_PER_REP;
}

/**
 * Where a reply to a Resend blast should go: an inbox CLOZR actually reads,
 * so the reply is filed on the buyer, seller or vendor and marks the campaign
 * recipient replied. The sender's own Reply-To when that mailbox is synced,
 * else a synced mailbox of the same rep, else the campaign's own Gmail, else
 * the sender's Reply-To as before (unsynced: the reply reaches the rep but
 * not CLOZR).
 */
export function pickReplyTo(
  sender: { reply_to?: string | null; user_id?: string | null },
  synced: readonly { email: string; user_id?: string | null }[],
  campaignMailbox?: string | null,
): string | null {
  const norm = (e: string | null | undefined) => String(e ?? '').trim().toLowerCase();
  const read = new Set(synced.map((s) => norm(s.email)).filter(Boolean));
  const own = norm(sender.reply_to);
  if (own && read.has(own)) return own;
  const repBox = sender.user_id ? synced.find((s) => s.user_id === sender.user_id && norm(s.email)) : undefined;
  if (repBox) return norm(repBox.email);
  const camp = norm(campaignMailbox);
  if (camp && read.has(camp)) return camp;
  return own || camp || null;
}

export function repSenderPool<T extends { user_id?: string | null }>(senders: T[], userId: string | null): T[] {
  const owned = senders.filter((s) => s.user_id);
  if (!owned.length) return senders;
  if (!userId) return owned;
  const mine = owned.filter((s) => s.user_id === userId);
  return mine.length ? mine : owned;
}

/**
 * Round-robin across the addresses that are still allowed to send.
 * `cursor` is the campaign message id, so the next buyer starts on the next
 * address instead of every message hitting the first one.
 */
export function cycleOrder<T extends { id: number; paused?: boolean }>(members: T[], cursor: number): T[] {
  const open = members.filter((m) => !m.paused);
  if (open.length <= 1) return open;
  const n = open.length;
  const start = ((Math.trunc(cursor) % n) + n) % n;
  return open.slice(start).concat(open.slice(0, start));
}
export const isDomain = (d: string) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);

/** TXT answers come back as `"part one" "part two"`; a record is its parts joined. */
export const joinTxt = (data: string) => {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\"/g, '"')).join('') : data;
};

// -------------------------------------------------------------------- SPF
export const spfRecords = (txts: string[]) => txts.map((t) => t.trim()).filter((t) => /^v=spf1(\s|$)/i.test(t));

export type SpfTerm = { qualifier: string; mech: string; value: string };
export function parseSpf(record: string): SpfTerm[] {
  return record.trim().split(/\s+/).slice(1).map((raw) => {
    const signed = /^[+\-~?]/.test(raw);
    const q = signed ? raw[0] : '+';
    const body = signed ? raw.slice(1) : raw;
    const m = /^([a-z0-9]+)(?:[:=/](.*))?$/i.exec(body) ?? [body, body, ''];
    return { qualifier: q, mech: m[1].toLowerCase(), value: (m[2] ?? '').toLowerCase() };
  });
}

const LOOKUP_TERMS = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);

/**
 * RFC 7208 §4.6.4: include, a, mx, ptr, exists and redirect each cost a DNS
 * lookup, recursively, and more than ten is a permanent error — the receiver
 * treats the whole SPF record as broken. `ips` are the literal ip4 addresses
 * at the top level: the servers this domain says send its mail itself.
 */
export async function spfLookups(domain: string, txt: (name: string) => Promise<string[]>, seen = new Set<string>()): Promise<{ count: number; ips: string[]; errors: string[] }> {
  const out = { count: 0, ips: [] as string[], errors: [] as string[] };
  seen.add(domain);
  const recs = spfRecords(await txt(domain));
  if (!recs.length) { if (seen.size > 1) out.errors.push(`${domain} has no SPF record`); return out; }
  if (recs.length > 1) out.errors.push(`${domain} has ${recs.length} SPF records`);
  for (const t of parseSpf(recs[0])) {
    if (!LOOKUP_TERMS.has(t.mech)) {
      if (t.mech === 'ip4' && seen.size === 1 && /^\d+\.\d+\.\d+\.\d+(\/32)?$/.test(t.value)) out.ips.push(t.value.replace('/32', ''));
      continue;
    }
    out.count++;
    if ((t.mech === 'include' || t.mech === 'redirect') && t.value) {
      if (seen.has(t.value)) { out.errors.push(`SPF loops back to ${t.value}`); continue; }
      if (out.count > 20) break; // already far past the limit; stop asking DNS
      const sub = await spfLookups(t.value, txt, seen);
      out.count += sub.count;
      out.errors.push(...sub.errors);
    }
  }
  return out;
}

/**
 * The zone a DNS host manages for `domain`: the last two labels, or three
 * under a two-letter country code with a short second level (example.co.uk).
 */
export function zoneOf(domain: string): string {
  const labels = domain.trim().toLowerCase().replace(/\.$/, '').split('.');
  const n = labels.length >= 3 && labels[labels.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-n).join('.');
}

/**
 * Fix hosts rewritten for the DNS host's form. A check's host is relative to
 * the domain checked, but the form is relative to the zone: `@` on
 * deals.thecompr.ai is `deals` in the thecompr.ai zone, and entering `@`
 * there lands the record on thecompr.ai.
 */
export function placeDnsFixes(checks: Check[], domain: string): Check[] {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  const zone = zoneOf(d);
  return checks.map((c) => {
    if (!c.fix) return c;
    const fqdn = (c.fix.fqdn ?? (c.fix.host === '@' ? d : `${c.fix.host}.${d}`)).toLowerCase();
    const host = fqdn === zone ? '@' : fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -zone.length - 1) : fqdn;
    return { ...c, fix: { ...c.fix, host, fqdn } };
  });
}

/** The existing record with an include added before its `all`, ending ~all if it ended in nothing safe. */
export function withInclude(record: string | null, include: string): string {
  const terms = (record ?? 'v=spf1').trim().split(/\s+/).slice(1).filter((t) => t.toLowerCase() !== `include:${include}`);
  const all = terms.findIndex((t) => /^[+\-~?]?all$/i.test(t));
  const tail = all >= 0 && /^[-~]all$/i.test(terms[all]) ? terms[all] : '~all';
  const body = terms.filter((_, i) => i !== all && !/^redirect=/i.test(terms[i]));
  return ['v=spf1', ...body, `include:${include}`, tail].join(' ');
}

export function evaluateSpf(domain: string, txts: string[], lookups: { count: number; errors: string[] }, want: string[]): Check[] {
  const recs = spfRecords(txts);
  const fixFor = (rec: string | null): DnsFix => ({
    type: 'TXT', host: '@', value: want.reduce((r, inc) => withInclude(r, inc), rec ?? 'v=spf1 ~all'),
    note: rec ? 'Edit the SPF record you have to this value. Do not add a second one: a name may have only one.' : 'Add this record. If this name already has a TXT record starting v=spf1, edit that one instead: a name may have only one.',
  });
  // Knowing no sender, the only record we could offer is v=spf1 ~all, which authorises nobody.
  if (!recs.length) return [{ key: 'spf', label: 'SPF', status: 'fail', blocking: true, points: 25, detail: `${domain} publishes no SPF record, so receivers cannot tell your mail from forged mail.${want.length ? '' : ' Add one that lists every service that sends as this domain.'}`, fix: want.length ? fixFor(null) : undefined }];
  if (recs.length > 1) return [{ key: 'spf', label: 'SPF', status: 'fail', blocking: true, points: 25, detail: `${recs.length} SPF records — receivers treat that as a permanent error. Merge them into one.`, fix: fixFor(recs[0]) }];
  const rec = recs[0];
  const terms = parseSpf(rec);
  const out: Check[] = [];
  const missing = want.filter((inc) => !terms.some((t) => t.mech === 'include' && t.value === inc));
  out.push(missing.length
    ? { key: 'spf', label: 'SPF', status: 'fail', blocking: true, points: 25, detail: `The SPF record does not authorise ${missing.join(' or ')}, which sends your mail.`, fix: fixFor(rec) }
    : { key: 'spf', label: 'SPF', status: 'pass', points: 25, detail: rec });
  out.push(lookups.count > 10
    ? { key: 'spf_lookups', label: 'SPF lookups', status: 'fail', blocking: true, points: 15, detail: `${lookups.count} DNS lookups (limit 10). Receivers stop and fail SPF. Remove includes you no longer use.` }
    : { key: 'spf_lookups', label: 'SPF lookups', status: lookups.count >= 9 ? 'warn' : 'pass', points: 3, detail: `${lookups.count} of 10 DNS lookups${lookups.count >= 9 ? ' — one more include breaks SPF' : ''}.` });
  if (lookups.errors.length) out.push({ key: 'spf_errors', label: 'SPF includes', status: 'warn', points: 5, detail: lookups.errors.join('; ') });
  const all = terms.find((t) => t.mech === 'all');
  const redirect = terms.some((t) => t.mech === 'redirect');
  out.push(all && (all.qualifier === '-' || all.qualifier === '~')
    ? { key: 'spf_all', label: 'SPF ending', status: 'pass', points: 5, detail: `Ends ${all.qualifier}all.` }
    : redirect && !all
      ? { key: 'spf_all', label: 'SPF ending', status: 'pass', points: 5, detail: 'Ends in a redirect.' }
      : { key: 'spf_all', label: 'SPF ending', status: all?.qualifier === '+' ? 'fail' : 'warn', blocking: all?.qualifier === '+', points: all?.qualifier === '+' ? 20 : 5, detail: all ? `Ends ${all.qualifier}all, which lets anyone send as ${domain}.` : 'No "all" at the end, so mail from anywhere is neutral.', fix: fixFor(rec) });
  return out;
}

// ------------------------------------------------------------------- DKIM
/** Key size of a DKIM TXT record: RSA bits estimated from the DER length, 'ed25519', 0 if revoked, null if not DKIM. */
export function dkimKeyBits(record: string): number | 'ed25519' | null {
  const tags = tagsOf(record);
  if (!('p' in tags)) return null;
  if ((tags.k ?? '').toLowerCase() === 'ed25519') return 'ed25519';
  const p = tags.p.replace(/\s+/g, '');
  if (!p) return 0;
  let len = 0;
  try { len = atob(p).length; } catch { return null; }
  // SubjectPublicKeyInfo for RSA: ~38 bytes of framing around the modulus.
  return len <= 100 ? 512 : len <= 170 ? 1024 : len <= 300 ? 2048 : len <= 430 ? 3072 : 4096;
}

export function evaluateDkim(domain: string, found: { selector: string; txts: string[] }[], opts: { google: boolean; resend: boolean }): Check[] {
  const out: Check[] = [];
  let good = 0;
  for (const f of found) {
    const rec = f.txts.find((t) => /(^|;)\s*p=/i.test(t));
    const bits = rec ? dkimKeyBits(rec) : null;
    const host = `${f.selector}._domainkey`;
    if (bits === null) {
      const needed = (f.selector === 'google' && opts.google) || (f.selector === 'resend' && opts.resend);
      if (needed) {
        out.push({
          key: `dkim_${f.selector}`, label: `DKIM (${f.selector})`, status: 'fail', points: 0, detail: `No DKIM key at ${host}.${domain}.`,
          fix: f.selector === 'google'
            ? { type: 'TXT', host, paste: false, value: 'Copy the value Google generates. It starts v=DKIM1; k=rsa; p=', note: 'Google Admin → Apps → Google Workspace → Gmail → Authenticate email → Generate new record (2048-bit), add it here, wait an hour, then press Start authentication. The key is unique to your domain, so it has to come from that screen.' }
            : { type: 'TXT', host, paste: false, value: `Copy the DKIM value from Resend → Domains → ${domain}. It starts p=MIGf`, note: 'This is a public key Resend generates for the domain. It is not your Resend API key (re_…): never put an API key in DNS.' },
        });
      } else {
        out.push({ key: `dkim_${f.selector}`, label: `DKIM (${f.selector})`, status: 'info', points: 0, detail: `Nothing at ${host}.` });
      }
      continue;
    }
    if (bits === 0) { out.push({ key: `dkim_${f.selector}`, label: `DKIM (${f.selector})`, status: 'fail', points: 0, detail: `The key at ${host} is empty (revoked).` }); continue; }
    good++;
    if (bits === 'ed25519' || bits >= 2048) out.push({ key: `dkim_${f.selector}`, label: `DKIM (${f.selector})`, status: 'pass', points: 0, detail: `${bits === 'ed25519' ? 'Ed25519' : `${bits}-bit RSA`} key published.` });
    else out.push({ key: `dkim_${f.selector}`, label: `DKIM (${f.selector})`, status: bits < 1024 ? 'fail' : 'warn', points: bits < 1024 ? 15 : 5, detail: `${bits}-bit key. Generate a 2048-bit key and rotate to it.` });
  }
  out.unshift(good
    ? { key: 'dkim', label: 'DKIM', status: 'pass', points: 25, detail: `Signed mail from ${domain} can be verified (${good} selector${good > 1 ? 's' : ''}). DKIM with d=${domain} is also what aligns for DMARC.` }
    : { key: 'dkim', label: 'DKIM', status: 'fail', blocking: true, points: 25, detail: `No working DKIM key found for ${domain}. Gmail and Yahoo require DKIM for bulk senders, and without it DMARC cannot align.` });
  return out;
}

// ------------------------------------------------------------------ DMARC
function tagsOf(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

export type Dmarc = { p: 'none' | 'quarantine' | 'reject' | null; sp: string | null; pct: number; rua: string[]; ruf: string[]; adkim: 'r' | 's'; aspf: 'r' | 's' };

/** A DMARC record, or null if it is not one (v=DMARC1 has to come first). */
export function parseDmarc(record: string): Dmarc | null {
  if (!/^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(record)) return null;
  const t = tagsOf(record);
  const p = (t.p ?? '').toLowerCase();
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pct = Number(t.pct ?? 100);
  return {
    p: p === 'none' || p === 'quarantine' || p === 'reject' ? p : null,
    sp: t.sp?.toLowerCase() ?? null,
    pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 100,
    rua: list(t.rua), ruf: list(t.ruf),
    adkim: t.adkim?.toLowerCase() === 's' ? 's' : 'r',
    aspf: t.aspf?.toLowerCase() === 's' ? 's' : 'r',
  };
}

export function evaluateDmarc(domain: string, txts: string[]): Check[] {
  const recs = txts.filter((t) => /^\s*v\s*=\s*DMARC1/i.test(t));
  const starter: DnsFix = { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r`, note: 'Start at p=none and read the reports for two weeks, then move to p=quarantine. Create the dmarc@ mailbox (or use a free DMARC report service address).' };
  if (!recs.length) return [{ key: 'dmarc', label: 'DMARC', status: 'fail', blocking: true, points: 20, detail: `No DMARC record at _dmarc.${domain}. Gmail and Yahoo require one for anyone sending in volume.`, fix: starter }];
  if (recs.length > 1) return [{ key: 'dmarc', label: 'DMARC', status: 'fail', blocking: true, points: 20, detail: 'More than one DMARC record — receivers ignore both.', fix: starter }];
  const d = parseDmarc(recs[0]);
  if (!d || !d.p) return [{ key: 'dmarc', label: 'DMARC', status: 'fail', blocking: true, points: 20, detail: `The DMARC record has no valid policy: ${recs[0]}`, fix: starter }];
  const out: Check[] = [];
  const stronger = recs[0].replace(/p\s*=\s*none/i, 'p=quarantine');
  out.push(d.p === 'none'
    ? { key: 'dmarc', label: 'DMARC', status: 'warn', points: 5, detail: 'p=none: monitoring only. Enough to send, but a quarantine policy is a stronger reputation signal once reports look clean.', fix: { type: 'TXT', host: '_dmarc', value: stronger, note: 'Only after two clean weeks of reports.' } }
    : { key: 'dmarc', label: 'DMARC', status: 'pass', points: 20, detail: `p=${d.p}${d.pct < 100 ? ` on ${d.pct}% of mail` : ''}.` });
  if (!d.rua.length) out.push({ key: 'dmarc_rua', label: 'DMARC reports', status: 'warn', points: 3, detail: 'No rua= address, so nobody sees who is sending as your domain.', fix: { type: 'TXT', host: '_dmarc', value: `${recs[0].replace(/;?\s*$/, '')}; rua=mailto:dmarc@${domain}` } });
  else out.push({ key: 'dmarc_rua', label: 'DMARC reports', status: 'pass', points: 3, detail: `Reports go to ${d.rua.join(', ')}.` });
  out.push({ key: 'dmarc_align', label: 'Alignment', status: 'info', points: 0, detail: `DKIM ${d.adkim === 's' ? 'strict' : 'relaxed'}, SPF ${d.aspf === 's' ? 'strict' : 'relaxed'}. Gmail sending from ${domain} aligns when the DKIM key above is live.` });
  return out;
}

// -------------------------------------------------------------- the score
/**
 * 100 minus the points of everything that is not a pass (warns cost their
 * points too — they are smaller). Launch-blocking: any blocking fail, or a
 * score under 70, per the OutboundOS rules.
 */
export function healthScore(checks: Check[]): { score: number; blocking: string[] } {
  const lost = checks.reduce((n, c) => n + (c.status === 'fail' || c.status === 'warn' ? c.points : 0), 0);
  const score = Math.max(0, Math.min(100, 100 - lost));
  const blocking = checks.filter((c) => c.blocking && c.status === 'fail').map((c) => `${c.label}: ${c.detail}`);
  if (score < 70) blocking.push(`Domain health ${score}/100 is below 70.`);
  return { score, blocking };
}

// --------------------------------------------------------- local time
export type LocalParts = { date: string; hour: number; minute: number; weekday: number };
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(d: Date, tz: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
  } catch {
    return localParts(d, 'UTC');
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday: WEEKDAY[get('weekday')] ?? 0 };
}

/** Midnight of the local day `d` falls in, as an instant. Off by the DST shift on the two transition days a year, which a daily cap can live with. */
export function dayStartUtc(d: Date, tz: string): Date {
  const p = localParts(d, tz);
  const [y, m, day] = p.date.split('-').map(Number);
  const offset = Date.UTC(y, m - 1, day, p.hour, p.minute) - Math.floor(d.getTime() / 60_000) * 60_000;
  return new Date(Date.UTC(y, m - 1, day) - offset);
}

// ---------------------------------------------------- mailbox protection
export type MailboxSettings = {
  daily_cap: number; hourly_cap: number; min_gap_seconds: number;
  window_start: number; window_end: number; window_days: number[]; timezone: string;
  ramp_enabled: boolean; ramp_start: number; ramp_increase_pct: number; ramp_target: number; ramp_started_on: string;
  paused: boolean; paused_reason: string | null;
};
export type SendKind = 'one_to_one' | 'bulk' | 'transactional';

/** What the stored verification flags for one address say. A true anywhere is safe. */
export type EmailSafety = 'safe' | 'unsafe' | 'unverified';

/**
 * Known-bad means there is at least one row and every one of them has
 * email_safe_to_send false. A true anywhere is safe. No rows, or a null that
 * is not outvoted by a true, is unverified.
 */
export function emailSafety(flags: readonly (boolean | null)[]): EmailSafety {
  if (flags.some((f) => f === true)) return 'safe';
  if (flags.length > 0 && flags.every((f) => f === false)) return 'unsafe';
  return 'unverified';
}

/**
 * bulk and one_to_one refuse a known-bad address. Null still sends, unless
 * this is bulk and the workspace requires a verified address. Transactional
 * mail and allowUnverified never refuse. Cold campaigns call this with
 * kind 'bulk'.
 */
export function blockUnverified(safety: EmailSafety, kind: SendKind, opts: { allowUnverified?: boolean; requireVerified?: boolean }): boolean {
  if (kind === 'transactional' || opts.allowUnverified) return false;
  if (kind !== 'bulk' && kind !== 'one_to_one') return false;
  if (safety === 'unsafe') return true;
  return safety === 'unverified' && kind === 'bulk' && opts.requireVerified === true;
}

const daysBetween = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

/** 0 on the day the ramp starts. */
export const rampDay = (m: Pick<MailboxSettings, 'ramp_started_on'>, today: string) => daysBetween(m.ramp_started_on, today);

/** Today's ceiling: the daily cap, or less while warming — start × (1 + increase%)^day, never above the target. */
export function dailyAllowance(m: MailboxSettings, today: string): number {
  if (!m.ramp_enabled) return m.daily_cap;
  const ramp = Math.floor(m.ramp_start * Math.pow(1 + m.ramp_increase_pct / 100, rampDay(m, today)));
  return Math.max(1, Math.min(m.daily_cap, m.ramp_target, ramp));
}

export const inWindow = (m: MailboxSettings, at: Date) => {
  const p = localParts(at, m.timezone);
  return m.window_days.includes(p.weekday) && p.hour >= m.window_start && p.hour < m.window_end;
};

/** The first quarter-hour inside the sending window after `after` — on a later local day when `nextDay`. */
export function nextWindowStart(m: MailboxSettings, after: Date, nextDay = false): Date | null {
  const today = localParts(after, m.timezone).date;
  let t = Math.ceil(after.getTime() / 900_000) * 900_000;
  for (let i = 0; i < 4 * 24 * 9; i++, t += 900_000) {
    const at = new Date(t);
    if (nextDay && localParts(at, m.timezone).date === today) continue;
    if (inWindow(m, at)) return at;
  }
  return null;
}

/** The limits the database claim is checked against, by kind of send. 1:1 mail keeps the caps but not the window or the gap: a rep answering two sellers a minute apart is normal. */
export function limitsFor(m: MailboxSettings, kind: SendKind, now: Date) {
  const today = localParts(now, m.timezone).date;
  if (kind === 'transactional') return { daily: 1_000_000, hourly: 1_000_000, gap: 0, dayStart: dayStartUtc(now, m.timezone), allowance: dailyAllowance(m, today) };
  return { daily: dailyAllowance(m, today), hourly: m.hourly_cap, gap: kind === 'bulk' ? m.min_gap_seconds : 0, dayStart: dayStartUtc(now, m.timezone), allowance: dailyAllowance(m, today) };
}

export type Refusal = { code: 'paused' | 'window' | 'gap' | 'daily_cap' | 'hourly_cap'; message: string; next_at: string | null };

const when = (d: Date | null, tz: string) => d
  ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d)
  : 'later';

/** Checks that need no counts: paused, and the window for bulk. */
export function preflight(m: MailboxSettings, kind: SendKind, now: Date): Refusal | null {
  if (kind === 'transactional') return null;
  if (m.paused) return { code: 'paused', message: `This mailbox is paused to protect its reputation: ${m.paused_reason ?? 'paused by an admin'}. An admin can resume it in Settings → Outbound OS.`, next_at: null };
  if (kind === 'bulk' && !inWindow(m, now)) {
    const next = nextWindowStart(m, now);
    return { code: 'window', message: `Outside this mailbox's sending window. Not sent — the task stays open; the window opens ${when(next, m.timezone)}.`, next_at: next?.toISOString() ?? null };
  }
  return null;
}

/** Why the claim was refused, from what the database counted. */
export function refusal(m: MailboxSettings, kind: SendKind, usage: { today: number; last_hour: number; hour_oldest: string | null; last_sent_at: string | null }, recipients: number, now: Date): Refusal {
  const l = limitsFor(m, kind, now);
  const tz = m.timezone;
  if (usage.today + recipients > l.daily) {
    const next = nextWindowStart(m, now, true);
    const ramp = m.ramp_enabled && l.daily < m.daily_cap ? ` (warm-up day ${rampDay(m, localParts(now, tz).date) + 1})` : '';
    return { code: 'daily_cap', message: `Daily limit reached: ${usage.today} of ${l.daily} sent today${ramp}. Not sent — the task stays open; sending resumes ${when(next, tz)}.`, next_at: next?.toISOString() ?? null };
  }
  if (usage.last_hour + recipients > l.hourly) {
    const next = usage.hour_oldest ? new Date(Date.parse(usage.hour_oldest) + 3_600_000) : new Date(now.getTime() + 3_600_000);
    return { code: 'hourly_cap', message: `Hourly limit reached: ${usage.last_hour} of ${l.hourly} in the last hour. Not sent — try again ${when(next, tz)}.`, next_at: next.toISOString() };
  }
  const next = usage.last_sent_at ? new Date(Date.parse(usage.last_sent_at) + l.gap * 1000) : now;
  return { code: 'gap', message: `Spacing sends ${l.gap}s apart so they do not arrive as a burst. Try again ${when(next, tz)}.`, next_at: next.toISOString() };
}

/**
 * OutboundOS auto-pause thresholds, on the data CLOZR actually has. Bounces
 * come from Gmail sync reading mailer-daemon notices; unsubscribes from the
 * one-click link. Spam complaints are not visible from a mailbox — Gmail
 * reports them only in aggregate through Postmaster Tools — so that rule is
 * checked against Postmaster's spam rate on the dashboard, not here.
 */
export function autoPauseReason(s: { sent7d: number; bounced7d: number; hardInLast50: number; bulk30d: number; unsub30d: number }): string | null {
  if (s.hardInLast50 >= 3) return `${s.hardInLast50} hard bounces in the last 50 sends (limit 3)`;
  if (s.sent7d >= 20 && s.bounced7d / s.sent7d > 0.05) return `bounce rate ${(100 * s.bounced7d / s.sent7d).toFixed(1)}% over 7 days (limit 5%)`;
  if (s.bulk30d >= 25 && s.unsub30d / s.bulk30d > 0.04) return `unsubscribe rate ${(100 * s.unsub30d / s.bulk30d).toFixed(1)}% over 30 days (limit 4%)`;
  return null;
}

// ---------------------------------------------------------------- bounces
/**
 * A delivery status notification, read from the Gmail message that carries
 * it. Hard when the SMTP status is 5.x.x, or, without one, when the words say
 * the address does not exist. A 4.x.x "still trying" notice is not a bounce.
 */
export function parseBounce(from: string, headers: Record<string, string>, text: string): { recipient: string; hard: boolean; status: string | null } | null {
  if (!/mailer-daemon|postmaster@|mail delivery (subsystem|system)/i.test(from)) return null;
  const addr = (s: string | undefined | null) => (s ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
  const recipient = addr(headers['x-failed-recipients']?.split(',')[0])
    || addr(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+)/i.exec(text)?.[1])
    || addr(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+)/i.exec(text)?.[1])
    || addr(/(?:wasn't|was not|couldn't be) delivered to\s+<?([^\s<>@]+@[^\s<>]+?)>?[\s.,]/i.exec(text)?.[1]);
  if (!recipient.includes('@')) return null;
  const status = /Status:\s*([245]\.\d{1,3}\.\d{1,3})/i.exec(text)?.[1] ?? /\b([45]\.\d\.\d{1,3})\b/.exec(text)?.[1] ?? null;
  if (status) return { recipient, hard: status.startsWith('5'), status };
  if (/delay|temporar|will (retry|try again)|still trying/i.test(text)) return { recipient, hard: false, status: null };
  return { recipient, hard: /not found|couldn't be found|does(n't| not) exist|no such (user|mailbox)|user unknown|unknown user|address rejected|invalid recipient|mailbox unavailable/i.test(text), status: null };
}

// ------------------------------------------------------------- spam risk
export type SpamInput = { subject: string; html?: string | null; text?: string | null; recipients?: number; attachments?: number; kind?: 'one_to_one' | 'bulk' };
export type SpamFinding = { key: string; label: string; points: number; detail: string };

const TRIGGERS = ['act now', 'apply now', 'call now', 'buy now', 'order now', 'click here', 'click below', '100% free', 'free money', 'risk-free', 'risk free', 'no obligation', 'guaranteed', 'winner', 'congratulations', 'limited time', 'once in a lifetime', 'urgent', 'exclusive deal', 'special promotion', 'lowest price', 'cheap', 'no credit check', 'double your', 'make money', 'earn extra', 'extra income', 'work from home', 'this is not spam', "this isn't spam", 'dear friend', 'cash bonus', 'miracle', '$$$', 'viagra', 'casino', 'crypto'];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc|lnkd\.in|rb\.gy)\//i;

const visibleText = (html: string) => html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, 'x').replace(/\s+/g, ' ').trim();
const hostOf = (u: string) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/**
 * A 0–100 risk estimate for one email and the reasons behind it. These are
 * the content signals filters are known to weigh; a low score is not a
 * promise of the inbox, and a high one is a reason to rewrite before sending.
 */
export function spamRisk(i: SpamInput): { score: number; level: 'low' | 'medium' | 'high'; findings: SpamFinding[] } {
  const f: SpamFinding[] = [];
  const add = (key: string, label: string, points: number, detail: string) => f.push({ key, label, points, detail });
  const html = i.html ?? '';
  const text = (i.text ?? '').trim() || (html ? visibleText(html) : '');
  const all = `${i.subject}\n${text}`;
  const lower = all.toLowerCase();

  if (!i.subject.trim()) add('subject', 'No subject', 10, 'Mail with an empty subject is filtered more often.');
  const hits = TRIGGERS.filter((w) => lower.includes(w));
  if (hits.length) add('triggers', 'Spam-trigger phrases', Math.min(24, hits.length * 6), hits.slice(0, 6).map((h) => `“${h}”`).join(', '));

  const letters = all.replace(/[^A-Za-z]/g, '');
  const caps = letters.length ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
  if (letters.length >= 20 && caps > 0.3) add('caps', 'Too much ALL CAPS', 15, `${Math.round(caps * 100)}% of letters are capitals.`);
  else if ((i.subject.match(/\b[A-Z]{3,}\b/g) ?? []).length >= 2) add('caps', 'Shouting subject', 8, 'Two or more ALL-CAPS words in the subject.');

  const bangs = (all.match(/!/g) ?? []).length;
  if (/!!/.test(all) || bangs > 3 || i.subject.includes('!')) add('exclaim', 'Exclamation marks', i.subject.includes('!') && bangs > 3 ? 10 : 5, `${bangs} exclamation mark${bangs === 1 ? '' : 's'}${i.subject.includes('!') ? ', one in the subject' : ''}.`);

  const anchors = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], label: visibleText(m[2]) }));
  const bare = html ? [] : [...text.matchAll(/https?:\/\/[^\s<>)"]+/gi)].map((m) => ({ href: m[0], label: '' }));
  const links = [...anchors, ...bare].filter((l) => /^https?:/i.test(l.href));
  if (links.length > (i.kind === 'bulk' ? 5 : 3)) add('links', 'Many links', links.length > 8 ? 15 : 8, `${links.length} links. A personal email rarely has more than one or two.`);
  const mismatched = anchors.filter((a) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(a.label) && hostOf(a.label) && hostOf(a.label) !== hostOf(a.href));
  if (mismatched.length) add('mismatch', 'Link text shows a different address', 20, `“${mismatched[0].label}” goes to ${hostOf(mismatched[0].href)} — the classic phishing pattern.`);
  if (links.some((l) => SHORTENERS.test(`${l.href}/`)) || SHORTENERS.test(`${text} `)) add('shortener', 'URL shortener', 20, 'Shortened links hide the destination and are shared by spammers. Link to your own domain.');

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const pixel = imgs.find((t) => /\b(width|height)\s*=\s*["']?[01]["'\s>]|(width|height)\s*:\s*[01]px|display\s*:\s*none/i.test(t) || /src=["'][^"']*(track|pixel|open\.|beacon)/i.test(t));
  if (pixel) add('pixel', 'Open-tracking pixel', 15, 'A 1×1 tracking image is a marketing-mail signal and pushes 1:1 mail toward Promotions. CLOZR never adds one.');
  const content = imgs.length - (pixel ? 1 : 0);
  if (content > 0 && text.length < 200) add('images', 'Mostly images', 20, `${content} image${content > 1 ? 's' : ''} and only ${text.length} characters of text. Filters cannot read images.`);
  else if (content > 0 && text.length / content < 400) add('images', 'Image-heavy', 8, 'Aim for at least ~400 characters of text per image.');

  if ((i.attachments ?? 0) > 0) add('attachments', 'Attachments', 10, 'Attachments on a first or bulk email are a risk signal. Link to the document instead.');
  if (html && !(i.text ?? '').trim()) add('plaintext', 'No plain-text version', 10, 'Send a text part alongside the HTML. (CLOZR builds one automatically when it sends.)');
  const unfilled = [...new Set(all.match(/\{\{?\s*[a-z_]+\s*\}?\}/gi) ?? [])];
  if (unfilled.length) add('merge', 'Unfilled merge fields', 25, `${unfilled.slice(0, 4).join(' ')} would go out literally.`);
  const n = i.recipients ?? 1;
  if (n > 1) add('recipients', 'Several recipients', n > 5 ? 20 : 8, `${n} addresses on one message. Send individually.`);
  if (html.length > 102_000) add('size', 'Too large', 10, 'Gmail clips messages over 102 KB, hiding the end of the email.');

  const score = Math.min(100, f.reduce((s, x) => s + x.points, 0));
  return { score, level: score < 20 ? 'low' : score < 45 ? 'medium' : 'high', findings: f };
}

// ------------------------------------------------------ postmaster v2
/** One day of Gmail Postmaster numbers, as the Signals panel draws it. v2 has no domain reputation, so it is always null. */
export type PostmasterDayV2 = { date: string; reputation: null; spam: number | null; spf: number | null; dkim: number | null; dmarc: number | null; errors: number; error_types: string[] };

/**
 * The metrics asked of domains.domainStats:query (Postmaster Tools v2). The
 * names come back on each DomainStat as `metric`.
 */
export const POSTMASTER_V2_METRICS = [
  { name: 'spam', baseMetric: { standardMetric: 'SPAM_RATE' } },
  { name: 'spf', baseMetric: { standardMetric: 'AUTH_SUCCESS_RATE' }, filter: 'auth_type = "spf"' },
  { name: 'dkim', baseMetric: { standardMetric: 'AUTH_SUCCESS_RATE' }, filter: 'auth_type = "dkim"' },
  { name: 'dmarc', baseMetric: { standardMetric: 'AUTH_SUCCESS_RATE' }, filter: 'auth_type = "dmarc"' },
  { name: 'errors', baseMetric: { standardMetric: 'DELIVERY_ERROR_RATE' } },
] as const;

/** A v2 rate as a 0–1 ratio. Google documents these as rates; a value over 1 is read as a percent. */
function v2Rate(value: unknown): number | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const raw = v.doubleValue ?? v.floatValue ?? v.intValue ?? v.stringValue;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? Math.min(1, n / 100) : n;
}

/** domainStats:query rows (DAILY) folded into one row per date, oldest first. */
export function postmasterDaysV2(stats: unknown[]): PostmasterDayV2[] {
  const days = new Map<string, PostmasterDayV2>();
  for (const s of stats ?? []) {
    const row = (s ?? {}) as { metric?: string; value?: unknown; date?: { year?: number; month?: number; day?: number } };
    const d = row.date;
    if (!d?.year || !d.month || !d.day) continue;
    const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    const day = days.get(date) ?? { date, reputation: null, spam: null, spf: null, dkim: null, dmarc: null, errors: 0, error_types: [] };
    const rate = v2Rate(row.value);
    if (row.metric === 'spam') day.spam = rate;
    else if (row.metric === 'spf') day.spf = rate;
    else if (row.metric === 'dkim') day.dkim = rate;
    else if (row.metric === 'dmarc') day.dmarc = rate;
    else if (row.metric === 'errors') day.errors = rate ?? 0;
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
