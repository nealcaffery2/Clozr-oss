// The RVM number pool, callback attribution, Talkr outreach and blast results.
// Run: npx tsx tools/rvm-pool.test.ts
import {
  DEFAULT_RVM_RAMP, NEIGHBORS, attributeCallback, callbackLine, lineUsable, marketState, pickPoolLine, rampCap, rampDay,
  stateOfAreaCode, stateOfPhone, suggestPool, worseRisk, type PoolLine,
} from '../lib/rvm-pool';
import { TALKR_OUTREACH, batchRejections, outreachItem, outreachRequests } from '../lib/talkr-outreach';
import { blastSummaries } from '../lib/rvm-blasts';
import { liveLines, nextCallerId, sameStateDialerLines } from '../lib/caller-spin';
import { addressesPerRep, blastDomains, pickReplyTo } from '../supabase/functions/_shared/deliverability-rules';
import { addressRows } from '../components/dispo-campaign/logic';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// ---- warm-up ramp
const now = new Date('2026-10-03T15:00:00Z');
eq('ramp day 0 on the start date', rampDay('2026-10-03', now), 0);
eq('ramp day 13 two weeks in', rampDay('2026-09-20', now), 13);
eq('no ramp start is warm', rampDay(null, now), null);
eq('day 1 cap is 25', rampCap(0), 25);
eq('day 7 cap', rampCap(6), DEFAULT_RVM_RAMP[6]);
eq('day 14 reaches 300', rampCap(13), 300);
eq('past the schedule holds the last step', rampCap(40), 300);
eq('warm line gets the ceiling', rampCap(null), 300);
eq('line cap below the ramp wins', rampCap(13, null, 120), 120);
eq('line cap above the ramp does not raise it', rampCap(0, null, 500), 25);
eq('custom ramp and ceiling', rampCap(1, { ramp: [10, 20, 40], ceiling: 30 }), 20);
eq('custom ceiling clips the ramp', rampCap(5, { ramp: [10, 20, 40], ceiling: 30 }), 30);
eq('garbage ramp falls back to the default', rampCap(0, { ramp: [-1, 'x' as unknown as number] }), 25);

// ---- health
eq('paused line is out', lineUsable({ paused: true }), false);
eq('at-risk grade is out', lineUsable({ grade: 'at_risk' }), false);
eq('high spam risk is out', lineUsable({ spam_risk: 'high' }), false);
eq('watch grade stays in', lineUsable({ grade: 'watch' }), true);
eq('no health row stays in', lineUsable(null), true);

// ---- geography
eq('803 is SC', stateOfAreaCode('803'), 'SC');
eq('864 is SC', stateOfPhone('+18645551234'), 'SC');
eq('713 is TX', stateOfPhone('(713) 555-1234'), 'TX');
eq('404 is GA', stateOfPhone('4045551234'), 'GA');
eq('unknown area code', stateOfAreaCode('999'), null);
eq('SC neighbours', NEIGHBORS.SC, ['GA', 'NC']);
eq('buyer market "Columbia, SC"', marketState(['Columbia, SC']), 'SC');
eq('buyer market bare state', marketState(['', 'tx']), 'TX');
eq('buyer market county', marketState(['Greenville County, SC']), 'SC');
eq('buyer market none', marketState(['Somewhere']), null);

// ---- picking a line
const SC1 = '+18035550001', SC2 = '+18645550002', GA1 = '+14045550003', TX1 = '+17135550004', NC1 = '+17045550005';
const pool: PoolLine[] = [
  { e164: SC1, state: 'SC', cap: 25 },
  { e164: SC2, state: 'SC', cap: 25 },
  { e164: GA1, state: 'GA', cap: 25 },
  { e164: TX1, state: 'TX', cap: 25 },
];
eq('SC lead gets an SC line', pickPoolLine(pool, { state: 'SC', phone: '+18435559999' }, {}), { ok: true, e164: SC1, tier: 'state' });
eq('least used SC line first', pickPoolLine(pool, { state: 'SC' }, { [SC1]: 5, [SC2]: 2 }), { ok: true, e164: SC2, tier: 'state' });
eq('ties rotate with seq', pickPoolLine(pool, { state: 'SC' }, {}, 1), { ok: true, e164: SC2, tier: 'state' });
eq('SC lines full: neighbour GA', pickPoolLine(pool, { state: 'SC' }, { [SC1]: 25, [SC2]: 25 }), { ok: true, e164: GA1, tier: 'neighbor' });
eq('NC lead with no NC line: least-used neighbour (SC)', pickPoolLine(pool, { state: 'NC' }, { [GA1]: 1 }), { ok: true, e164: SC1, tier: 'neighbor' });
eq('no state: their own area code', pickPoolLine(pool, { phone: '+17135551111' }, {}), { ok: true, e164: TX1, tier: 'area_code' });
eq('no state, no local area code: the phone\'s state', pickPoolLine(pool, { phone: '+12145551111' }, {}), { ok: true, e164: TX1, tier: 'state' });
eq('recipient\'s area code beats another line in the state', pickPoolLine(pool, { state: 'SC', phone: '+18645559999' }, {}), { ok: true, e164: SC2, tier: 'area_code' });
eq('SC property, Atlanta phone: the local 404 line', pickPoolLine(pool, { state: 'SC', phone: '+14045559999' }, {}), { ok: true, e164: GA1, tier: 'area_code' });
eq('SC property, Houston-area phone with no 832 line: SC first', pickPoolLine(pool, { state: 'SC', phone: '+18325559999' }, {}), { ok: true, e164: SC1, tier: 'state' });
eq('SC property, SC lines full, TX phone: the phone\'s state', pickPoolLine(pool, { state: 'SC', phone: '+18325559999' }, { [SC1]: 25, [SC2]: 25 }), { ok: true, e164: TX1, tier: 'phone_state' });
eq('CA lead: any line, least used', pickPoolLine(pool, { state: 'CA' }, { [SC1]: 3, [SC2]: 3, [GA1]: 1, [TX1]: 2 }), { ok: true, e164: GA1, tier: 'any' });
eq('every line at cap: pool full', pickPoolLine(pool, { state: 'SC' }, { [SC1]: 25, [SC2]: 25, [GA1]: 25, [TX1]: 25 }), { ok: false, reason: 'pool_full' });
eq('unusable lines skipped', pickPoolLine([{ e164: SC1, state: 'SC', cap: 25, usable: false }, { e164: TX1, state: 'TX', cap: 25 }], { state: 'SC' }, {}), { ok: true, e164: TX1, tier: 'any' });
eq('all unusable: no pool', pickPoolLine([{ e164: SC1, state: 'SC', cap: 25, usable: false }], { state: 'SC' }, {}), { ok: false, reason: 'no_pool' });
eq('line state from area code when unset', pickPoolLine([{ e164: NC1, cap: 5 }, { e164: TX1, cap: 5 }], { state: 'NC' }, {}), { ok: true, e164: NC1, tier: 'state' });
eq('zero cap line never used', pickPoolLine([{ e164: SC1, state: 'SC', cap: 0 }, { e164: TX1, state: 'TX', cap: 5 }], { state: 'SC' }, {}), { ok: true, e164: TX1, tier: 'any' });

// ---- suggested pool
const mix = { SC: 359, TX: 82, GA: 64, FL: 35, TN: 35, AL: 15, NC: 15, VA: 3 };
const ten = suggestPool(mix, 10);
eq('10 lines add up', ten.reduce((n, r) => n + r.lines, 0), 10);
eq('SC capped at half', ten.find((r) => r.state === 'SC')?.lines, 5);
eq('TX gets 2', ten.find((r) => r.state === 'TX')?.lines, 2);
eq('GA, FL and TN get one each', ['GA', 'FL', 'TN'].map((s) => ten.find((r) => r.state === s)?.lines), [1, 1, 1]);
eq('one state takes all', suggestPool({ SC: 10 }, 3), [{ state: 'SC', lines: 3, leads: 10 }]);
eq('nothing to suggest', suggestPool({}, 10), []);
eq('zero lines', suggestPool(mix, 0), []);

// ---- callback attribution
const touches = [
  { id: 1, at: '2026-09-20T15:00:00Z', kind: 'rvm' as const, rep_id: 'a' },
  { id: 2, at: '2026-09-30T15:00:00Z', kind: 'rvm' as const, rep_id: 'b' },
  { id: 3, at: '2026-10-04T15:00:00Z', kind: 'rvm' as const, rep_id: 'c' },
];
eq('latest drop inside 7 days', attributeCallback(touches, '2026-10-03T15:00:00Z')?.id, 2);
eq('a drop after the call does not count', attributeCallback(touches, '2026-10-01T00:00:00Z')?.id, 2);
eq('8 days later: nothing', attributeCallback(touches.slice(0, 2), '2026-10-08T16:00:00Z'), null);
eq('exactly 7 days still counts', attributeCallback(touches.slice(1, 2), '2026-10-07T15:00:00Z')?.id, 2);
eq('custom window', attributeCallback(touches.slice(0, 1), '2026-10-03T15:00:00Z', 30)?.id, 1);
eq('callback line, mine', callbackLine({ at: '2026-10-02T15:00:00Z', kind: 'rvm' }, true, null, 'UTC'), 'Calling back about your RVM from Oct 2');
eq('callback line, a teammate', callbackLine({ at: '2026-10-02T15:00:00Z', kind: 'email' }, false, 'Morgan', 'UTC'), "Calling back about Morgan's email from Oct 2");

// ---- Talkr outreach
const it1 = outreachItem({ phone: '(803) 555-0101', userId: 'u1', channel: 'rvm', at: '2026-10-03T15:00:00Z', ref: 'rvm:1' });
eq('item normalises the phone and drops nothing', it1, { phone_e164: '+18035550101', user_id: 'u1', channel: 'rvm', occurred_at: '2026-10-03T15:00:00.000Z', ref: 'rvm:1' });
eq('no phone: no item', outreachItem({ phone: '12', userId: 'u1', channel: 'rvm', at: new Date(), ref: 'x' }), null);
eq('no rep: no item', outreachItem({ phone: '8035550101', userId: null, channel: 'rvm', at: new Date(), ref: 'x' }), null);
const it2 = outreachItem({ phone: '8035550102', userId: 'u1', channel: 'rvm', at: '2026-10-03T15:01:00Z', ref: 'rvm:2' });
const it3 = outreachItem({ phone: '8035550103', userId: 'u2', channel: 'email', at: '2026-10-03T15:02:00Z', ref: 'email:9' });
const reqs = outreachRequests([it1, it2, it3, null, it1]);
eq('two reps, two requests', reqs.length, 2);
eq('u1 batch goes to the batch path as a bare array without user_id', [reqs[0]!.path, Array.isArray(reqs[0]!.body), (reqs[0]!.body as unknown[]).length, 'user_id' in (reqs[0]!.body as object[])[0]!], [TALKR_OUTREACH.batchPath, true, 2, false]);
eq('u2 single goes to the single path', [reqs[1]!.path, (reqs[1]!.body as { ref: string }).ref], [TALKR_OUTREACH.path, 'email:9']);
const many = Array.from({ length: 501 }, (_, i) => outreachItem({ phone: `803555${String(1000 + i).slice(-4)}`, userId: 'u1', channel: 'rvm', at: now, ref: `rvm:${i}` }));
eq('batches cap at 500', outreachRequests(many).map((r) => (Array.isArray(r.body) ? r.body.length : 1)), [500, 1]);
eq('batch rejections by ref', [...batchRejections({ results: [{ ref: 'rvm:1', status: 'created' }, { ref: 'rvm:2', status: 'rejected', error: 'invalid_phone' }] })], [['rvm:2', 'invalid_phone']]);

// ---- blast results
const sums = blastSummaries([
  { id: 1, blast_id: 'b1', created_by: 'u1', created_at: '2026-10-01T15:00:00Z', status: 'dropped', from_e164: SC1, callback_at: '2026-10-02T10:00:00Z' },
  { id: 2, blast_id: 'b1', created_by: 'u1', created_at: '2026-10-01T15:00:01Z', status: 'dropped', from_e164: SC2 },
  { id: 3, blast_id: 'b1', created_by: 'u1', created_at: '2026-10-01T15:00:02Z', status: 'failed', from_e164: SC1 },
  { id: 4, blast_id: 'b1', created_by: 'u1', created_at: '2026-10-01T15:00:03Z', status: 'queued', from_e164: null },
  { id: 5, enrollment_id: 7, created_by: 'u2', created_at: '2026-10-02T15:00:00Z', status: 'skipped', from_e164: null },
], 0.05);
const b1 = sums.find((s) => s.key === 'blast:b1')!;
eq('blast totals', [b1.total, b1.delivered, b1.failed, b1.pending, b1.callbacks], [4, 2, 1, 1, 1]);
eq('blast callback rate and cost', [b1.callbackRate, b1.cost], [0.5, 0.1]);
eq('per line', b1.lines.map((l) => [l.line, l.sent, l.delivered, l.failed, l.callbacks]), [[SC1, 2, 1, 1, 1], [SC2, 1, 1, 0, 0]]);
eq('plan drops are their own group, newest first', sums.map((s) => s.kind), ['plan', 'blast']);
{
  const tiers = blastSummaries([
    { id: 1, blast_id: 'b2', created_by: 'u1', created_at: '2026-10-03T15:00:00Z', status: 'dropped', from_e164: SC1, pool_tier: 'area_code' },
    { id: 2, blast_id: 'b2', created_by: 'u1', created_at: '2026-10-03T15:00:01Z', status: 'dropped', from_e164: SC1, pool_tier: 'state' },
    { id: 3, blast_id: 'b2', created_by: 'u1', created_at: '2026-10-03T15:00:02Z', status: 'dropped', from_e164: GA1, pool_tier: 'neighbor' },
    { id: 4, blast_id: 'b2', created_by: 'u1', created_at: '2026-10-03T15:00:03Z', status: 'queued', from_e164: null },
  ])[0]!;
  eq('local caller ID share counts the drops with a tier', [tiers.local, tiers.tiered], [2, 3]);
}

// ---- dialer pool
const lines = [
  { id: 'a', phone_e164: '+18035550001' }, { id: 'b', phone_e164: '+17135550002' }, { id: 'c', phone_e164: '+14045550003' },
];
const pools = { '+18035550001': { pool: 'dialer', state: 'SC' }, '+17135550002': { pool: 'rvm', state: 'TX' }, '+14045550003': { pool: 'dialer', state: null } };
eq('rvm-pool lines stay off live calls', liveLines(lines, pools).map((l) => l.id), ['a', 'c']);
eq('only rvm lines: keep them', liveLines([lines[1]!], pools).map((l) => l.id), ['b']);
eq('same-state dialer lines', sameStateDialerLines(lines, 'GA', pools).map((l) => l.id), ['c']);
eq('SC lead (non-local number) gets the SC dialer line', nextCallerId([lines[0]!, lines[2]!], {}, '+12125550000', 0, { destState: 'SC', pools })?.id, 'a');
eq('area code match still wins over state', nextCallerId([lines[0]!, lines[2]!], {}, '+14045559999', 0, { destState: 'SC', pools })?.id, 'c');
eq('no state: unchanged rotation', nextCallerId([lines[0]!, lines[2]!], { a: 3, c: 1 }, '+12125550000', 0)?.id, 'c');

// ---- email capacity and replies
eq('blast domains: primary first, deduped, junk dropped', blastDomains('deals.example.com', ['offers.example.com', 'deals.example.com', 'not a domain', 'x@more.example.com']), ['deals.example.com', 'offers.example.com', 'more.example.com']);
eq('addresses per rep default', addressesPerRep(undefined), 10);
eq('addresses per rep capped at 25', addressesPerRep(80), 25);
const synced = [{ email: 'morgan@co.com', user_id: 'u1' }, { email: 'avery@co.com', user_id: 'u2' }];
eq('reply-to: own synced inbox', pickReplyTo({ reply_to: 'Morgan@co.com', user_id: 'u1' }, synced, null), 'morgan@co.com');
eq('reply-to: rep has another synced inbox', pickReplyTo({ reply_to: 'morgan@personal.com', user_id: 'u1' }, synced, null), 'morgan@co.com');
eq('reply-to: campaign mailbox when the rep has none', pickReplyTo({ reply_to: 'x@y.com', user_id: 'u9' }, synced, 'avery@co.com'), 'avery@co.com');
eq('reply-to: unchanged when nothing is synced', pickReplyTo({ reply_to: 'x@y.com', user_id: 'u9' }, [], null), 'x@y.com');

const res = {
  recipients: [
    { id: 1, replied_at: '2026-10-02T00:00:00Z', replied_channel: 'email' },
    { id: 2, replied_at: null, replied_channel: null },
    { id: 3, replied_at: '2026-10-02T00:00:00Z', replied_channel: 'sms' },
  ],
  messages: [
    { id: 1, recipient_id: 1, channel: 'email', status: 'sent', send_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', from_email: 'morgan1@deals.co' },
    { id: 2, recipient_id: 1, channel: 'email', status: 'sent', send_at: '2026-10-02T00:00:00Z', sent_at: '2026-10-02T00:00:00Z', from_email: 'morgan2@deals.co' },
    { id: 3, recipient_id: 2, channel: 'email', status: 'failed', send_at: '2026-10-01T00:00:00Z', sent_at: null, from_email: 'morgan2@deals.co' },
    { id: 4, recipient_id: 3, channel: 'email', status: 'delivered', send_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z', from_email: 'morgan2@deals.co' },
  ],
} as unknown as Parameters<typeof addressRows>[0];
eq('per-address email results', addressRows(res), [
  { from: 'morgan2@deals.co', sent: 2, failed: 1, replied: 0 },
  { from: 'morgan1@deals.co', sent: 1, failed: 0, replied: 1 },
]);

// ---- two spam verdicts: Talkr's and the carrier's; the worse one counts
eq('carrier high beats Talkr low', worseRisk('low', 'HIGH'), 'high');
eq('one verdict is that verdict', worseRisk(null, 'medium'), 'medium');
eq('no verdict is none', worseRisk(undefined, '', 'unknown'), null);
eq('a line the carrier flags high is not usable', lineUsable({ spam_risk: worseRisk('low', 'high') }), false);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
