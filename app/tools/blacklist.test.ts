// One predicate for "may we reach out": the secret blacklist tag, a buyer's
// blacklisted_at, a DNC tag. The Blacklist button writes only the tag.
// Run: npx tsx tools/blacklist.test.ts
import { BLACKLIST_MESSAGE, BLACKLIST_UNREAD, blockReason, isBlacklisted, isDoNotEngage, loadBlocked, textBlock, type BlacklistDb } from '../lib/blacklist';
import { decideRvm, hasDnc, type RvmFacts } from '../lib/rvm';
import { inTodayUniverse, type TodayPerson } from '../lib/today';
import { blockedTexts, textOne } from '../lib/sms';
import { talkr } from '../lib/talkr';
import { isDoNotEngage as voiceAgentDoNotEngage } from '../supabase/functions/_shared/voice-agent';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('message text', BLACKLIST_MESSAGE, 'blocked: on the blacklist');

// [label, row, isBlacklisted, blockReason]
const table: [string, Parameters<typeof isBlacklisted>[0], boolean, string | null][] = [
  ['null row', null, false, null],
  ['clean seller', { tags: ['hot'] }, false, null],
  ['no tags', {}, false, null],
  ['secret tag', { tags: ['secret-blacklist'] }, true, 'blacklisted'],
  ['secret tag, other case and padding', { tags: [' Secret-Blacklist '] }, true, 'blacklisted'],
  ['secret tag among others', { tags: ['cash', 'secret-blacklist'] }, true, 'blacklisted'],
  ['buyer blacklisted_at', { tags: [], blacklisted_at: '2026-01-01T00:00:00Z' }, true, 'blacklisted'],
  ['view-model boolean', { blacklisted: true }, true, 'blacklisted'],
  ['blacklisted false', { blacklisted: false, blacklisted_at: null }, false, null],
  ['dnc tag only', { tags: ['DNC'] }, false, 'do_not_call'],
  ['do-not-call tag only', { tags: ['do not call'] }, false, 'do_not_call'],
  ['dnc plus blacklist reads as blacklisted', { tags: ['dnc', 'secret-blacklist'] }, true, 'blacklisted'],
  ['near-miss tag', { tags: ['secret-blacklisted'] }, false, null],
];
for (const [label, row, bl, reason] of table) {
  eq(`isBlacklisted: ${label}`, isBlacklisted(row), bl);
  eq(`blockReason: ${label}`, blockReason(row), reason);
  eq(`isDoNotEngage: ${label}`, isDoNotEngage(row), reason !== null);
  // The voice agent's edge predicate must agree (plus its own number_dnc flag).
  eq(`voice agent agrees: ${label}`, voiceAgentDoNotEngage({ kind: 'seller', id: 1, name: 'x', ...row } as never), reason !== null);
}
eq('voice agent still honors number_dnc', voiceAgentDoNotEngage({ kind: 'buyer', id: 1, name: 'x', tags: [], number_dnc: true } as never), true);
eq('buyer behavior unchanged: hasDnc still ignores the blacklist', hasDnc(['secret-blacklist']), false);

// ---- RVM decision ----
const facts = (o: Partial<RvmFacts>): RvmFacts => ({
  phone: '+12105550100', dnc: false, now: new Date('2026-06-10T17:00:00Z'), timeZone: 'America/Chicago',
  window: { startHour: 8, endHour: 20 }, lastLiveTalkAt: null, lastDropAt: null, minDaysSinceTalk: 7, minDaysSinceDrop: 3,
  recordings: [{ id: 'a', name: 'A' }], history: [], ...o,
} as RvmFacts);
eq('decideRvm skips a blacklisted person', decideRvm(facts({ blacklisted: true })), { action: 'skip', reason: 'blacklisted' });
eq('decideRvm names the blacklist before dnc', decideRvm(facts({ blacklisted: true, dnc: true })), { action: 'skip', reason: 'blacklisted' });
eq('decideRvm still skips dnc', decideRvm(facts({ dnc: true })), { action: 'skip', reason: 'do_not_call' });

// ---- Today ----
const person = (tags: string[]): TodayPerson => ({
  id: 'p1', name: 'A', stage: 'Lead - No Contact', assigned: null, source: '', phone: '', lastComm: '', lastCommTs: null, created: '',
  tags, asking: '', offer: null, property: { addr: '', city: '', st: '', zip: '' },
});
eq('Today keeps a clean lead', inTodayUniverse(person([]), 'live'), true);
eq('Today drops a blacklisted lead', inTodayUniverse(person(['secret-blacklist']), 'live'), false);
eq('Today still drops dnc', inTodayUniverse(person(['dnc']), 'live'), false);

// ---- the database read (mocked) ----
const fakeDb = (rows: { sellers: unknown[]; buyers: unknown[] }, fail?: 'sellers' | 'buyers'): BlacklistDb & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    from: (table) => ({
      select: () => ({
        in: async (_c: string, ids: number[]) => {
          reads.push(`${table}:${ids.join(',')}`);
          if (fail === table) return { data: null, error: { message: 'boom' } };
          return { data: (rows[table] as { id: number }[]).filter((r) => ids.includes(r.id)), error: null };
        },
      }),
    }),
  };
};
const rows = {
  sellers: [{ id: 1, tags: ['secret-blacklist'] }, { id: 2, tags: ['hot'] }, { id: 3, tags: ['dnc'] }],
  buyers: [{ id: 7, tags: [], blacklisted_at: '2026-01-01' }, { id: 8, tags: ['secret-blacklist'], blacklisted_at: null }, { id: 9, tags: [], blacklisted_at: null }],
};
const got = await loadBlocked(fakeDb(rows), { sellerIds: [1, 2, 3, 1, null], buyerIds: [7, 8, 9, undefined] });
eq('loadBlocked sellers', got.ok && [...got.blocked.sellers], [1]);
eq('loadBlocked buyers', got.ok && [...got.blocked.buyers], [7, 8]);
const noIds = fakeDb(rows);
eq('loadBlocked with no ids reads nothing', (await loadBlocked(noIds, {})).ok && noIds.reads, []);
const bad = await loadBlocked(fakeDb(rows, 'buyers'), { sellerIds: [1], buyerIds: [7] });
eq('a failed read is an error, not "clear"', bad.ok, false);
const many = fakeDb(rows);
await loadBlocked(many, { sellerIds: Array.from({ length: 450 }, (_, i) => i + 1) });
eq('ids are read in chunks of 200', many.reads.map((r) => r.split(':')[1]!.split(',').length), [200, 200, 50]);

// ---- server texts (docs-flow textRecipient): a failed read holds the text, it is not "clear" and not a "no" ----
eq('textBlock: a blacklisted seller is a no', textBlock(got, { seller_id: 1 }), BLACKLIST_MESSAGE);
eq('textBlock: a blacklisted buyer is a no', textBlock(got, { buyer_id: 8 }), BLACKLIST_MESSAGE);
eq('textBlock: a clean seller and buyer may go', textBlock(got, { seller_id: 2, buyer_id: 9 }), null);
eq('textBlock: no record may go', textBlock(got, {}), null);
eq('textBlock: a failed read holds, with its own reason', textBlock(bad, { seller_id: 2 }), BLACKLIST_UNREAD);
eq('the hold reason text', BLACKLIST_UNREAD, 'could not check the blacklist');

// ---- one-to-one text: blocked before Talkr is ever called ----
let sent = 0;
const realSend = talkr.sendMessage;
talkr.sendMessage = (async () => { sent++; throw new Error('should not be reached in this test'); }) as typeof talkr.sendMessage;
const r = { sellerId: 1, name: 'Ann', phone: '(210) 555-0100' };
const out = await textOne(5, r, 'hi', {}, await blockedTexts([r], fakeDb(rows)));
eq('textOne blocks a blacklisted seller', [out.status, out.error], ['blocked', BLACKLIST_MESSAGE]);
const outBuyer = await textOne(5, { sellerId: null, buyerId: 7, name: 'Cash Co', phone: '(210) 555-0101' }, 'hi', {}, await blockedTexts([{ sellerId: null, buyerId: 7, name: 'x', phone: 'x' }], fakeDb(rows)));
eq('textOne blocks a blacklisted buyer', [outBuyer.status, outBuyer.error], ['blocked', BLACKLIST_MESSAGE]);
const outFail = await textOne(5, r, 'hi', {}, await blockedTexts([r], fakeDb(rows, 'sellers')));
eq('textOne refuses when the check failed', [outFail.status, /could not check/.test(outFail.error ?? '')], ['blocked', true]);
const viaDb = await textOne(5, r, 'hi', {}, { ok: true, blocked: { sellers: new Set([1]), buyers: new Set() } });
eq('textOne with a batch gate blocks without a read', viaDb.status, 'blocked');
eq('Talkr was never called for a blocked text', sent, 0);
talkr.sendMessage = realSend;

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
