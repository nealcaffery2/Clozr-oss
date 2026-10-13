// Postmaster domain verification: the Site Verification client, the DNS
// writers (InboxKit, Vercel), and the one-domain flow.
// Run with:  npx tsx tools/site-verification.test.ts
import assert from 'node:assert/strict';
import type { FetchLike } from '../supabase/functions/_shared/instantly';
import type { InboxkitClient, InboxkitDnsRecord } from '../supabase/functions/_shared/inboxkit';
import {
  SITE_VERIFICATION_API, VERCEL_API, apexOf, autoVerifyDomain, inboxkitDns, readVerifiedSites, siteVerificationClient, vercelDns,
  type DnsWriter, type SiteVerificationClient,
} from '../supabase/functions/_shared/site-verification';

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function fakeFetch(answer: (call: Call) => { status?: number; body: unknown }): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const a = answer(call);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
  };
  return { fetchFn, calls };
}

async function main() {
  assert.deepEqual(apexOf('thecompr.com'), { apex: 'thecompr.com', host: '' });
  assert.deepEqual(apexOf('deals.thecompr.ai'), { apex: 'thecompr.ai', host: 'deals' });
  assert.deepEqual(apexOf('A.B.Example.com.'), { apex: 'example.com', host: 'a.b' });

  assert.deepEqual([...readVerifiedSites({ items: [
    { id: 'dns%3A%2F%2Fgetcompr.com', site: { type: 'INET_DOMAIN', identifier: 'GetCompr.com' } },
    { id: 'https://x.com/', site: { type: 'SITE', identifier: 'https://x.com/' } },
  ] })], ['getcompr.com'], 'only INET_DOMAIN sites count, lowercased');
  assert.equal(readVerifiedSites(null).size, 0);

  // Google's client: token, verify (400 means DNS has not caught up), list.
  {
    const { fetchFn, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/token')) return { body: { method: 'DNS_TXT', token: 'google-site-verification=abc' } };
      if (c.url.includes('/webResource?verificationMethod=DNS_TXT')) {
        return (c.body as { site: { identifier: string } }).site.identifier === 'slow.com'
          ? { status: 400, body: { error: { message: 'The necessary verification token could not be found on your site.' } } }
          : { body: { id: 'dns%3A%2F%2Fok.com' } };
      }
      return { body: { items: [] } };
    });
    const g = siteVerificationClient('tok', fetchFn);
    assert.equal(await g.token('ok.com'), 'google-site-verification=abc');
    assert.deepEqual(calls[0].body, { site: { type: 'INET_DOMAIN', identifier: 'ok.com' }, verificationMethod: 'DNS_TXT' });
    assert.equal(calls[0].url, `${SITE_VERIFICATION_API}/token`);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok');
    assert.equal(await g.verify('ok.com'), true);
    assert.equal(await g.verify('slow.com'), false);
    assert.equal((await g.verifiedDomains()).size, 0);
  }

  // Vercel writes the TXT under the apex with the subdomain as the name, once.
  {
    const records: { name: string; type: string; value: string }[] = [];
    const { fetchFn, calls } = fakeFetch((c) => {
      if (c.url.includes('/domains/notmine.com/')) return { status: 404, body: {} };
      if (c.method === 'POST') { records.push(c.body as never); return { body: { uid: 'rec_1' } }; }
      return { body: { records } };
    });
    const v = vercelDns('vt', 'team_1', fetchFn);
    assert.equal(await v.hosts('notmine.com'), false);
    assert.equal(await v.hosts('deals.thecompr.ai'), true);
    assert.equal(await v.ensureTxt('deals.thecompr.ai', 'google-site-verification=abc'), 'added');
    assert.equal(await v.ensureTxt('deals.thecompr.ai', 'google-site-verification=abc'), 'present');
    const post = calls.find((c) => c.method === 'POST')!;
    assert.equal(post.url, `${VERCEL_API}/v2/domains/thecompr.ai/records?teamId=team_1`);
    assert.deepEqual(post.body, { name: 'deals', type: 'TXT', value: 'google-site-verification=abc', ttl: 60 });
  }

  // InboxKit finds the workspace that holds the domain and skips a TXT already there.
  {
    const added: string[] = [];
    const client = (has: Record<string, InboxkitDnsRecord[]>): InboxkitClient => ({
      listMailboxes: async () => [], appPassword: async () => null, mailboxesHealth: async () => [],
      dnsRecords: async (d) => has[d] ?? null,
      addDnsRecord: async (d, r) => { added.push(`${d} ${r.host} ${r.value}`); },
    });
    const w = inboxkitDns([client({}), client({ 'getcompr.com': [{ host: '@', type: 'TXT', value: '"google-site-verification=old"', status: 'propagated' }] })]);
    assert.equal(await w.hosts('thecompr.com'), false);
    assert.equal(await w.hosts('getcompr.com'), true);
    assert.equal(await w.ensureTxt('getcompr.com', 'google-site-verification=old'), 'present', 'a quoted TXT matches its value');
    assert.equal(await w.ensureTxt('getcompr.com', 'google-site-verification=new'), 'added');
    assert.deepEqual(added, ['getcompr.com @ google-site-verification=new']);
  }

  // The flow.
  {
    const google = (verifies: boolean, opts: { tokenFails?: number } = {}): SiteVerificationClient & { tokens: number } => {
      const g = {
        tokens: 0,
        verifiedDomains: async () => new Set<string>(),
        token: async () => {
          g.tokens++;
          if (opts.tokenFails) throw Object.assign(new Error('Forbidden'), { name: 'GoogleVerifyError', status: opts.tokenFails });
          return 'google-site-verification=t';
        },
        verify: async () => verifies,
      };
      return g;
    };
    const writer = (hosts: boolean): DnsWriter & { wrote: string[] } => {
      const w = { name: 'inboxkit' as const, wrote: [] as string[], hosts: async () => hosts, ensureTxt: async (d: string, v: string) => { w.wrote.push(`${d}=${v}`); return 'added' as const; } };
      return w;
    };

    const already = await autoVerifyDomain('getcompr.com', { google: google(false), verified: new Set(['getcompr.com']), writers: [writer(true)] });
    assert.equal(already.status, 'verified', 'verified for the account already (InboxKit put the TXT there): nothing written');

    const kit = writer(true);
    const done = await autoVerifyDomain('trycompr.com', { google: google(true), verified: new Set(), writers: [writer(false), kit] });
    assert.deepEqual([done.status, done.dns_host, done.token], ['verified', 'inboxkit', 'google-site-verification=t']);
    assert.deepEqual(kit.wrote, ['trycompr.com=google-site-verification=t']);

    const slow = await autoVerifyDomain('usecompr.com', { google: google(false), verified: new Set(), writers: [writer(true)] });
    assert.equal(slow.status, 'pending', 'TXT written, Google cannot see it yet');

    const reuse = google(false);
    await autoVerifyDomain('usecompr.com', { google: reuse, verified: new Set(), writers: [writer(true)], knownToken: 'google-site-verification=saved' });
    assert.equal(reuse.tokens, 0, 'a stored token is reused on the retry');

    const nowhere = await autoVerifyDomain('elsewhere.com', { google: google(false), verified: new Set(), writers: [writer(false)] });
    assert.deepEqual([nowhere.status, nowhere.token], ['needs_dns', 'google-site-verification=t'], 'no writable DNS host: show the record');

    const refused = await autoVerifyDomain('x.com', { google: google(false, { tokenFails: 403 }), verified: new Set(), writers: [] });
    assert.equal(refused.status, 'error');
  }

  console.log('site-verification: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
