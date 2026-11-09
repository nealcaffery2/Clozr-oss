// lib/inbox-blast-tags.ts and the Deal blasted part of lib/inbox-folders.
// Run with:  npx tsx tools/inbox-blast-tags.test.ts
import { type BlastRow, blastedAbout, dealOptions, missingKeys, phoneKeyOf, tagOf, tagsFromRows } from '../lib/inbox-blast-tags';
import { EMPTY_FILTER, filterCount, matchesFilter, withDefaults } from '../lib/inbox-folders';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const row = (p: Partial<BlastRow>): BlastRow => ({ phone_key: '+12105550271', email: null, buyer_id: 5, buyer_status: 'Active', deal_id: 1, line1: '5323 Sage Hill Road', last_sent_at: '2026-10-29T10:00:00Z', ...p });

// ---- keys ----
check('phone keys match normalize_phone()', phoneKeyOf('(210) 555-0271') === '+12105550271' && phoneKeyOf('12105550271') === '+12105550271' && phoneKeyOf('+44 20 7946 0958') === '+442079460958' && phoneKeyOf('555') === null);

// ---- tags ----
const map = tagsFromRows([
  row({}),
  row({ deal_id: 2, line1: '6890 Saddle Dr', last_sent_at: '2026-10-30T09:00:00Z' }),
  row({ deal_id: 1, last_sent_at: '2026-10-28T10:00:00Z' }),
  row({ phone_key: '+18325550144', buyer_id: 9, buyer_status: 'prospect', deal_id: 2, line1: '6890 Saddle Dr' }),
  row({ phone_key: null, email: 'Jordan@NorthlineHomes.com', buyer_id: 2, deal_id: 1 }),
]);
const priya = tagOf(map, '(210) 555-0271', null);
check('most recent blast first', priya?.deals.map((d) => d.dealId).join() === '2,1', priya);
check('a deal blasted twice is one entry, at its newest send', priya?.deals.find((d) => d.dealId === 1)?.lastSentAt === '2026-10-29T10:00:00Z', priya);
check('Prospect status, any case, is a prospect', tagOf(map, '+18325550144', null)?.prospect === true && priya?.prospect === false);
check('an email-only recipient is found by address, any case', tagOf(map, null, 'jordan@northlinehomes.com')?.deals[0]?.dealId === 1);
check('nobody blasted is null', tagOf(map, '+15125550000', 'x@y.com') === null);
check('number and address both blasted: deals merge', tagOf(map, '+18325550144', 'jordan@northlinehomes.com')?.deals.length === 2);
check('blastedAbout', blastedAbout(priya, 2) && !blastedAbout(priya, 3) && !blastedAbout(null, 2));

// ---- deal picker ----
const opts = dealOptions([priya, tagOf(map, '+18325550144', null), null, tagOf(map, null, 'jordan@northlinehomes.com')]);
check('deal options carry thread counts, most first', opts.length === 2 && opts[0]!.count === 2 && opts[1]!.count === 2 && opts.every((o) => o.line1), opts);

// ---- cache ----
check('only stale or unasked keys are fetched', missingKeys(['a', 'b', 'c', 'a'], new Map([['a', 1000], ['b', 0]]), 2000, 1500).join() === 'b,c');

// ---- filter ----
const item = { kind: 'sms' as const, labels: [], lastTheirsAt: '', phone: null, tags: [], owner: null };
check('Deal blasted keeps only threads that blast reached', matchesFilter({ ...item, deals: [1, 2] }, { ...EMPTY_FILTER, deal: '2' }) && !matchesFilter({ ...item, deals: [1] }, { ...EMPTY_FILTER, deal: '2' }) && !matchesFilter(item, { ...EMPTY_FILTER, deal: '2' }));
check('no deal set lets every thread through', matchesFilter(item, EMPTY_FILTER));
check('the deal counts as one filter', filterCount({ ...EMPTY_FILTER, deal: '5366' }) === 1);
check('a saved filter from before the deal part reads it unset', withDefaults({ tag: 'x' } as never).deal === '' && withDefaults({ tag: 'x' } as never).tag === 'x');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
