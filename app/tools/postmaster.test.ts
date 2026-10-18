// Postmaster v2: the client (paged list, add, verify) and adding a domain
// for the user, including Google refusing the Developer Preview methods.
// Run with:  npx tsx tools/postmaster.test.ts
import assert from 'node:assert/strict';
import type { FetchLike } from '../supabase/functions/_shared/instantly';
import type { DnsWriter } from '../supabase/functions/_shared/site-verification';
import {
  MANUAL_ADD, POSTMASTER_API, mapLimit, pmReadable, postmasterClient, registerDomain,
  type PostmasterClient,
} from '../supabase/functions/_shared/postmaster';

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

const gErr = (code: number, status: string, message: string) => ({ status: code, body: { error: { code, status, message } } });

function writer(hosted: string[], log: string[]): DnsWriter {
  return {
    name: 'inboxkit',
    async hosts(d) { return hosted.includes(d); },
    async ensureTxt(d, v) { log.push(`${d}=${v}`); return 'added'; },
  };
}

function fakePm(o: { create?: (d: string) => { state: 'VERIFIED' | 'UNVERIFIED' } | Error; verify?: (d: string, n: number) => boolean }): PostmasterClient & { log: string[] } {
  const log: string[] = [];
  const tries = new Map<string, number>();
  return {
    log,
    async listDomains() { return []; },
    async createDomain(d) {
      log.push(`create ${d}`);
      const r = o.create?.(d) ?? { state: 'UNVERIFIED' as const };
      if (r instanceof Error) throw r;
      return { domain: d, state: r.state };
    },
    async verificationToken(d) { log.push(`token ${d}`); return `pm-token-${d}`; },
    async verifyDomain(d) {
      const n = (tries.get(d) ?? 0) + 1;
      tries.set(d, n);
      log.push(`verify ${d}`);
      return o.verify?.(d, n) ?? false;
    },
    async queryStats() { return {}; },
  };
}

async function main() {
  // Paged list, names stripped and lowercased, states kept.
  {
    const { fetchFn, calls } = fakeFetch((c) => c.url.includes('pageToken=p2')
      ? { body: { domains: [{ name: 'domains/TheCompr.com', verificationState: 'UNVERIFIED' }] } }
      : { body: { domains: [{ name: 'domains/getcompr.com', verificationState: 'VERIFIED' }, { name: 'domains/old.com' }], nextPageToken: 'p2' } });
    const pm = postmasterClient('tok', fetchFn);
    const list = await pm.listDomains();
    assert.deepEqual(list, [
      { domain: 'getcompr.com', state: 'VERIFIED' },
      { domain: 'old.com', state: 'VERIFICATION_STATE_UNSPECIFIED' },
      { domain: 'thecompr.com', state: 'UNVERIFIED' },
    ]);
    assert.equal(calls.length, 2, 'follows nextPageToken');
    assert.equal(calls[0].url, `${POSTMASTER_API}/domains?pageSize=200`);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok');
    assert.equal(pmReadable(list[0]), true);
    assert.equal(pmReadable(list[1]), true, 'a v1-era domain without a state still reads');
    assert.equal(pmReadable(list[2]), false);
    assert.equal(pmReadable(undefined), false);
  }

  // Create, ALREADY_EXISTS, token and verify on the wire.
  {
    const { fetchFn, calls } = fakeFetch((c) => {
      if (c.method === 'POST' && c.url.endsWith('/domains')) {
        return (c.body as { domainId: string }).domainId === 'dup.com'
          ? gErr(409, 'ALREADY_EXISTS', 'Domain already exists.')
          : { body: { name: 'domains/new.com', verificationState: 'UNVERIFIED' } };
      }
      if (c.url.includes('/verificationToken')) return { body: { token: 'google-site-verification=xyz' } };
      if (c.url.endsWith(':verify')) return c.url.includes('slow.com') ? gErr(400, 'FAILED_PRECONDITION', 'TXT not found') : { body: {} };
      return { body: {} };
    });
    const pm = postmasterClient('tok', fetchFn);
    assert.deepEqual(await pm.createDomain('new.com'), { domain: 'new.com', state: 'UNVERIFIED' });
    assert.deepEqual(calls[0].body, { domainId: 'new.com' });
    assert.deepEqual(await pm.createDomain('dup.com'), { domain: 'dup.com', state: 'UNVERIFIED' }, 'already there is not a failure');
    assert.equal(await pm.verificationToken('new.com'), 'google-site-verification=xyz');
    assert.ok(calls.at(-1)!.url.endsWith('/domains/new.com/verificationToken?verificationMethod=TXT'));
    assert.equal(await pm.verifyDomain('new.com'), true);
    assert.deepEqual(calls.at(-1)!.body, { verificationMethod: 'TXT' });
    assert.equal(await pm.verifyDomain('slow.com'), false, 'a missing record is not an error');
  }

  // Already listed and verified: nothing to do.
  {
    const pm = fakePm({});
    const out = await registerDomain('a.com', { pm, writers: [], listed: { domain: 'a.com', state: 'VERIFIED' }, blocked: { reason: null } });
    assert.equal(out.postmaster, 'ready');
    assert.deepEqual(pm.log, []);
  }

  // Added, and Site Verification already counts: verified on the first ask, no DNS write.
  {
    const pm = fakePm({ verify: () => true });
    const dns: string[] = [];
    const out = await registerDomain('getcompr.com', { pm, writers: [writer(['getcompr.com'], dns)], blocked: { reason: null } });
    assert.equal(out.postmaster, 'ready');
    assert.deepEqual(pm.log, ['create getcompr.com', 'verify getcompr.com']);
    assert.deepEqual(dns, []);
  }

  // Added, needs Postmaster's own TXT: written at the DNS host, verified on the second ask.
  {
    const pm = fakePm({ verify: (_d, n) => n >= 2 });
    const dns: string[] = [];
    const out = await registerDomain('trycompr.com', { pm, writers: [writer(['trycompr.com'], dns)], blocked: { reason: null } });
    assert.equal(out.postmaster, 'ready');
    assert.deepEqual(dns, ['trycompr.com=pm-token-trycompr.com']);
  }

  // Added, DNS has not reached Google: added, waiting.
  {
    const pm = fakePm({});
    const out = await registerDomain('slow.com', { pm, writers: [writer(['slow.com'], [])], blocked: { reason: null } });
    assert.equal(out.postmaster, 'added');
    assert.match(out.detail, /Waiting for DNS/);
  }

  // No DNS host CLOZR can write: added, verifies once the record is there.
  {
    const pm = fakePm({});
    const out = await registerDomain('elsewhere.com', { pm, writers: [], blocked: { reason: null } });
    assert.equal(out.postmaster, 'added');
  }

  // Google refuses domains.create (project not in the Developer Preview): manual, and the rest skip the call.
  {
    const { fetchFn } = fakeFetch(() => gErr(403, 'PERMISSION_DENIED', 'The caller does not have permission'));
    const pm = postmasterClient('tok', fetchFn);
    const blocked = { reason: null as string | null };
    const first = await registerDomain('one.com', { pm, writers: [], blocked });
    assert.equal(first.postmaster, 'manual');
    assert.ok(first.detail.startsWith(MANUAL_ADD));
    assert.match(first.detail, /does not have permission/, 'Google\'s own words are shown');
    const spy = fakePm({});
    const second = await registerDomain('two.com', { pm: spy, writers: [], blocked });
    assert.equal(second.postmaster, 'manual');
    assert.deepEqual(spy.log, [], 'no second create once Google said no');
  }

  // Other failures are errors, never thrown.
  {
    const pm = fakePm({ create: () => Object.assign(new Error('backend error'), {}) });
    const out = await registerDomain('x.com', { pm, writers: [], blocked: { reason: null } });
    assert.equal(out.postmaster, 'error');
    assert.match(out.detail, /backend error/);
  }

  // mapLimit: order kept, at most `limit` running, nothing started after the deadline.
  {
    let running = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
    assert.equal(peak, 4);
    let clock = 0;
    const timed = await mapLimit([1, 2, 3, 4], 1, async (n) => { clock += 10; return n; }, 15, () => clock);
    assert.deepEqual(timed, [1, 2, undefined, undefined], 'items left for the next load');
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  }

  console.log('postmaster tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
