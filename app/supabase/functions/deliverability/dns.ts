/**
 * The DNS half of a domain check: DNS-over-HTTPS (JSON) against Cloudflare,
 * then Google, and the checks that need answers. The rules that turn answers
 * into pass/fail and a score are in ../_shared/deliverability-rules.ts.
 */
import {
  type Check, FREE_MAIL, evaluateDkim, evaluateDmarc, evaluateSpf, healthScore, joinTxt, spfLookups,
} from '../_shared/deliverability-rules.ts';

type Answer = { type: number; data: string };
type Result = { status: number; answers: Answer[] };

const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const TYPE: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16 };

async function ask(base: string, name: string, type: string): Promise<Result | null> {
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const b = await res.json() as { Status: number; Answer?: Answer[] };
    return { status: b.Status, answers: (b.Answer ?? []).filter((a) => a.type === TYPE[type]) };
  } catch {
    return null;
  }
}

/** The first resolver that answers. SERVFAIL (2) is treated as no answer and the next one is tried. */
export async function resolve(name: string, type: 'A' | 'NS' | 'CNAME' | 'MX' | 'TXT'): Promise<Result | null> {
  for (const base of RESOLVERS) {
    const r = await ask(base, name, type);
    if (r && r.status !== 2) return r;
  }
  return null;
}

const txt = async (name: string) => ((await resolve(name, 'TXT'))?.answers ?? []).map((a) => joinTxt(a.data));

// -------------------------------------------------------------- blocklists
/**
 * Each list is asked through one resolver, and first about its own test
 * point — a name the list always reports as listed. If the test point does
 * not come back listed, that resolver is refused or filtered (Spamhaus answers
 * 127.255.255.254 to queries from public resolvers like Cloudflare's, and
 * Google's resolver returns NXDOMAIN for everything), so the answer about
 * your domain means nothing and the check says "couldn't check" instead of
 * "clean".
 *
 * When every public resolver is refused, askDirect asks the list's own
 * nameservers instead.
 *
 * ponytail: direct queries can still be refused from cloud IPs. The upgrade path
 * is a free Spamhaus DQS key (spamhaus.com/free-trial/free-data-query-service):
 * query `<domain>.<DQS_KEY>.dbl.dq.spamhaus.net` and `<ip>.<DQS_KEY>.zen.dq.spamhaus.net`
 * through the same resolve(), with the same test points.
 */
const LISTS = [
  { key: 'bl_dbl', label: 'Spamhaus DBL', zone: 'dbl.spamhaus.org', on: 'domain', test: 'dbltest.com' },
  { key: 'bl_uribl', label: 'URIBL', zone: 'multi.uribl.com', on: 'domain', test: 'test.uribl.com' },
  { key: 'bl_zen', label: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', on: 'ip', test: '127.0.0.2' },
  { key: 'bl_spamcop', label: 'SpamCop', zone: 'bl.spamcop.net', on: 'ip', test: '127.0.0.2' },
] as const;

/** A real listing: 127.0.x.y, but not the "refused" answers (127.255.255.x, URIBL's 127.0.0.1). */
const listedIn = (r: Result | null) => (r?.answers ?? []).some((a) => /^127\.0\.\d+\.\d+$/.test(a.data) && a.data !== '127.0.0.1');
const reverse = (ip: string) => ip.split('.').reverse().join('.');

/**
 * Ask the list's own nameservers over plain DNS (Deno.resolveDns), which the
 * lists answer for low-volume callers that are not public resolvers. Same
 * test-point rule: the test name must come back listed or the answer is
 * unknown. A runtime without resolveDns, or one the list also refuses, is unknown.
 */
async function askDirect(zone: string, name: string): Promise<Result | null> {
  // deno-lint-ignore no-explicit-any
  const resolveDns = (globalThis as any).Deno?.resolveDns as ((n: string, t: string, o?: unknown) => Promise<string[]>) | undefined;
  if (!resolveDns) return null;
  let ns: string[] = [];
  // The list zone is usually delegated; when it is not, its parent's servers answer for it.
  for (const z of [zone, zone.split('.').slice(1).join('.')]) {
    ns = (await resolve(z, 'NS'))?.answers.map((a) => a.data.replace(/\.$/, '')) ?? [];
    if (ns.length) break;
  }
  for (const host of ns.slice(0, 3)) {
    const ip = (await resolve(host, 'A'))?.answers[0]?.data;
    if (!ip) continue;
    try {
      const answers = await resolveDns(name, 'A', { nameServer: { ipAddr: ip, port: 53 } });
      return { status: 0, answers: answers.map((data) => ({ type: 1, data })) };
    } catch (err) {
      if (err instanceof Error && /NotFound|NXDOMAIN|no record/i.test(`${err.name} ${err.message}`)) return { status: 3, answers: [] };
    }
  }
  return null;
}

async function lookupList(list: typeof LISTS[number], target: string): Promise<'listed' | 'clean' | 'unknown'> {
  const q = (t: string) => `${list.on === 'ip' ? reverse(t) : t}.${list.zone}`;
  for (const base of RESOLVERS) {
    if (!listedIn(await ask(base, q(list.test), 'A'))) continue;
    const r = await ask(base, q(target), 'A');
    if (!r) continue;
    if (listedIn(r)) return 'listed';
    if (r.status === 3) return 'clean';
  }
  if (listedIn(await askDirect(list.zone, q(list.test)))) {
    const r = await askDirect(list.zone, q(target));
    if (listedIn(r)) return 'listed';
    if (r?.status === 3 || (r && !r.answers.length)) return 'clean';
  }
  return 'unknown';
}

async function blocklists(domain: string, ips: string[]): Promise<Check[]> {
  const out: Check[] = [];
  for (const list of LISTS) {
    const targets = list.on === 'domain' ? [domain] : ips.slice(0, 5);
    if (!targets.length) continue;
    const results = await Promise.all(targets.map(async (t) => [t, await lookupList(list, t)] as const));
    const listed = results.filter(([, s]) => s === 'listed').map(([t]) => t);
    if (listed.length) out.push({ key: list.key, label: list.label, status: 'fail', blocking: true, points: 30, detail: `${listed.join(', ')} is listed. Mail from a listed ${list.on} is rejected or filtered by many receivers; request delisting on ${list.label}'s site after fixing the cause.` });
    else if (results.some(([, s]) => s === 'unknown')) out.push({ key: list.key, label: list.label, status: 'unknown', points: 0, detail: `Couldn't check — ${list.label} refuses lookups from the public DNS resolvers CLOZR can use. Not the same as clean.` });
    else out.push({ key: list.key, label: list.label, status: 'pass', points: 0, detail: `${targets.join(', ')} not listed.` });
  }
  if (!ips.length) out.push({ key: 'bl_ips', label: 'Sending IPs', status: 'info', points: 0, detail: 'Your SPF names no servers of your own, so mail goes out through your provider\'s IPs (Google\'s, for Gmail) and their IP reputation is the provider\'s to keep. Domain reputation is yours — see Postmaster.' });
  return out;
}

// ------------------------------------------------------------------- check
export type DomainOptions = { dkim_selectors: string[]; tracking_domain: string | null; uses_resend: boolean; google_hint: boolean };

export async function checkDomain(domain: string, o: DomainOptions): Promise<{ checks: Check[]; score: number; blocking: string[]; provider: string; checked_at: string }> {
  const checks: Check[] = [];
  if (FREE_MAIL.has(domain)) {
    checks.push({ key: 'free', label: 'Free mailbox domain', status: 'warn', points: 0, detail: `${domain} belongs to the mail provider, not you: no SPF, DKIM or DMARC of your own, and bulk mail from it is judged harshly. Send from your company domain.` });
    return { checks, score: 0, blocking: [`${domain} is not a domain you control.`], provider: 'free', checked_at: new Date().toISOString() };
  }

  const [mx, root] = await Promise.all([resolve(domain, 'MX'), txt(domain)]);
  const mxHosts = (mx?.answers ?? []).map((a) => a.data.split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase());
  const google = o.google_hint || mxHosts.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h));
  const provider = google ? 'google' : mxHosts.some((h) => /outlook\.com$/.test(h)) ? 'microsoft' : mxHosts[0] ?? 'unknown';

  if (!mx) checks.push({ key: 'mx', label: 'MX', status: 'unknown', points: 0, detail: 'DNS did not answer. Try again.' });
  else if (!mxHosts.length && o.uses_resend) checks.push({ key: 'mx', label: 'MX', status: 'info', points: 0, detail: `${domain} is a send-only Resend domain. Replies go to the campaign Reply-To, so it does not need an MX.` });
  else if (!mxHosts.length) checks.push({ key: 'mx', label: 'MX', status: 'fail', blocking: true, points: 10, detail: `${domain} cannot receive mail, so replies and bounce notices are lost — and receivers distrust a sender that cannot be answered.`, fix: { type: 'MX', host: '@', value: '1 smtp.google.com', note: 'Google Workspace\'s mail server. Remove other MX records.' } });
  else checks.push({ key: 'mx', label: 'MX', status: 'pass', points: 10, detail: mxHosts.slice(0, 3).join(', ') });

  const lookups = await spfLookups(domain, txt);
  checks.push(...evaluateSpf(domain, root, lookups, google ? ['_spf.google.com'] : []));

  if (o.uses_resend) {
    // Resend sends with a send.<domain> return path, so its SPF lives there.
    const sub = `send.${domain}`;
    const subTxt = await txt(sub);
    const s = evaluateSpf(sub, subTxt, await spfLookups(sub, txt), ['amazonses.com'])[0];
    checks.push({ ...s, key: 'spf_resend', label: 'SPF (Resend)', fix: s.fix && { ...s.fix, host: 'send' } });
  }

  const probe = ['google', 'selector1', 'selector2', 'default', 's1', 'k1'];
  const selectors = [...new Set([...(google ? ['google'] : []), ...(o.uses_resend ? ['resend'] : []), ...o.dkim_selectors.map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9._-]{1,63}$/.test(s))])];
  const chosen = selectors.length ? selectors : probe;
  const found = await Promise.all(chosen.map(async (selector) => ({ selector, txts: await txt(`${selector}._domainkey.${domain}`) })));
  checks.push(...evaluateDkim(domain, found, { google, resend: o.uses_resend }).filter((c) => selectors.length || c.status !== 'info'));

  let dmarcTxt = await txt(`_dmarc.${domain}`);
  // A sending subdomain inherits the org-domain DMARC when it has none of its own.
  if (!dmarcTxt.length && domain.split('.').length > 2) {
    const parent = domain.split('.').slice(1).join('.');
    dmarcTxt = await txt(`_dmarc.${parent}`);
  }
  checks.push(...evaluateDmarc(domain, dmarcTxt));

  const [bimi, sts, tlsrpt] = await Promise.all([txt(`default._bimi.${domain}`), txt(`_mta-sts.${domain}`), txt(`_smtp._tls.${domain}`)]);
  checks.push(bimi.some((t) => /^v=BIMI1/i.test(t))
    ? { key: 'bimi', label: 'BIMI (optional)', status: 'pass', points: 0, detail: 'Brand logo record published.' }
    : { key: 'bimi', label: 'BIMI (optional)', status: 'info', points: 0, detail: 'Shows your logo beside mail in Gmail. Needs DMARC at quarantine or reject and a verified mark certificate — worth it later, not now.' });
  checks.push(sts.some((t) => /^v=STSv1/i.test(t))
    ? { key: 'mta_sts', label: 'MTA-STS (optional)', status: 'pass', points: 0, detail: 'Published.' }
    : { key: 'mta_sts', label: 'MTA-STS (optional)', status: 'info', points: 0, detail: 'Makes other servers use TLS when sending to you. Needs a policy file hosted at https://mta-sts.' + domain + '/.well-known/mta-sts.txt as well as this record.', fix: { type: 'TXT', host: '_mta-sts', value: `v=STSv1; id=${new Date().toISOString().slice(0, 10).replace(/-/g, '')}` } });
  checks.push(tlsrpt.some((t) => /^v=TLSRPTv1/i.test(t))
    ? { key: 'tls_rpt', label: 'TLS-RPT (optional)', status: 'pass', points: 0, detail: 'Published.' }
    : { key: 'tls_rpt', label: 'TLS-RPT (optional)', status: 'info', points: 0, detail: 'Daily reports of TLS failures delivering to you.', fix: { type: 'TXT', host: '_smtp._tls', value: `v=TLSRPTv1; rua=mailto:tlsrpt@${domain}` } });

  if (o.tracking_domain) {
    const host = o.tracking_domain.trim().toLowerCase();
    const cname = await resolve(host, 'CNAME');
    checks.push(cname?.answers.length
      ? { key: 'tracking', label: 'Link domain', status: 'pass', points: 0, detail: `${host} → ${cname.answers[0].data.replace(/\.$/, '')}` }
      : { key: 'tracking', label: 'Link domain', status: 'warn', points: 5, detail: `${host} has no CNAME, so tracked links would point at a shared domain whose reputation is not yours.`, fix: { type: 'CNAME', host: host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : host, value: '<the host your link-tracking provider gives you>' } });
  }

  checks.push(...await blocklists(domain, lookups.ips));
  const { score, blocking } = healthScore(checks);
  return { checks, score, blocking, provider, checked_at: new Date().toISOString() };
}
