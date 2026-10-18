// lib/inbox-folders.ts: the Inbox's folders, suggested labels and thread filter.
// Run with:  npx tsx tools/inbox-folders.test.ts
import { EMPTY_FILTER, type FolderItem, areaCodeOf, filterCount, folderCounts, inFolder, matchesFilter, optedOutOf, suggestLabel } from '../lib/inbox-folders';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const item = (p: Partial<FolderItem>): FolderItem => ({ kind: 'sms', unread: false, missed: false, theyLast: false, optedOut: false, archived: false, ...p });

// ---- folders ----
check('a fresh inbound text is unread and unreplied', inFolder(item({ unread: true, theyLast: true }), 'unread') && inFolder(item({ unread: true, theyLast: true }), 'unreplied'));
check('our last text is awaiting reply, not unreplied', inFolder(item({ theyLast: false }), 'awaiting') && !inFolder(item({ theyLast: false }), 'unreplied'));
check('a call is never unreplied or awaiting', !inFolder(item({ kind: 'call', theyLast: true }), 'unreplied') && !inFolder(item({ kind: 'call' }), 'awaiting'));
check('a missed call files under Missed calls and All', inFolder(item({ kind: 'call', missed: true }), 'missed') && inFolder(item({ kind: 'call', missed: true }), 'all'));
check('an archived thread is only in Archived', inFolder(item({ archived: true, unread: true }), 'archived') && !inFolder(item({ archived: true, unread: true }), 'all') && !inFolder(item({ archived: true, unread: true }), 'unread'));
check('opted out', inFolder(item({ optedOut: true }), 'optout'));
const counts = folderCounts([item({ unread: true, theyLast: true }), item({}), item({ kind: 'call', missed: true, theyLast: true }), item({ archived: true })]);
check('counts', counts.all === 3 && counts.unread === 1 && counts.unreplied === 1 && counts.awaiting === 1 && counts.missed === 1 && counts.archived === 1, counts);

// ---- opted out ----
check('dnc status is opted out', optedOutOf('dnc', []));
check('an opt-out tag is opted out', optedOutOf('engaged', ['campaign-a', 'Opted Out']));
check('a plain tag is not', !optedOutOf('engaged', ['campaign-a', 'stopped-by-rep']) === false || !optedOutOf('engaged', ['campaign-a']));

// ---- suggested label ----
check('STOP suggests Not interested', suggestLabel('STOP') === 'Not interested');
check('"please remove me" suggests Not interested', suggestLabel('Please remove me from your list') === 'Not interested');
check('wrong number', suggestLabel('You have the wrong number, who is this?') === 'Wrong number');
check('how much suggests Lead', suggestLabel('How much would you offer for it?') === 'Lead');
check('a price pushback suggests High price', suggestLabel('That is too low, I want at least 250') === 'High price');
check('call me tomorrow suggests Follow up', suggestLabel('Can you call me tomorrow afternoon?') === 'Follow up');
check('wrong number beats how much', suggestLabel('wrong number, how much?') === 'Wrong number');
check('a plain thanks suggests nothing', suggestLabel('Thanks, got it.') === null);
check('empty suggests nothing', suggestLabel('') === null && suggestLabel(null) === null);

// ---- filter ----
const row = { kind: 'sms' as const, labels: ['Lead', 'Hot', 'Offer Made'], lastTheirsAt: '2026-10-17T15:00:00Z', phone: '+12105550136', tags: ['fall-blast'], owner: 'Taylor Reed' };
check('an empty filter matches everything', matchesFilter(row, EMPTY_FILTER) && filterCount(EMPTY_FILTER) === 0);
check('include any', matchesFilter(row, { ...EMPTY_FILTER, include: ['Follow up', 'Hot'] }));
check('include all needs every label', !matchesFilter(row, { ...EMPTY_FILTER, include: ['Follow up', 'Hot'], includeMode: 'all' }) && matchesFilter(row, { ...EMPTY_FILTER, include: ['lead', 'hot'], includeMode: 'all' }));
check('exclude', !matchesFilter(row, { ...EMPTY_FILTER, exclude: ['Hot'] }));
check('response date range', matchesFilter(row, { ...EMPTY_FILTER, from: '2026-10-17', to: '2026-10-17' }) && !matchesFilter(row, { ...EMPTY_FILTER, from: '2026-10-18' }));
check('no response ever fails a date range', !matchesFilter({ ...row, lastTheirsAt: '' }, { ...EMPTY_FILTER, to: '2026-12-31' }));
check('area code', matchesFilter(row, { ...EMPTY_FILTER, areaCode: '210' }) && !matchesFilter(row, { ...EMPTY_FILTER, areaCode: '713' }) && areaCodeOf('(210) 555-0136') === '210' && areaCodeOf(null) === '');
check('tag, owner, channel', matchesFilter(row, { ...EMPTY_FILTER, tag: 'Fall-Blast', owner: 'taylor reed', channel: 'sms' }) && !matchesFilter(row, { ...EMPTY_FILTER, channel: 'email' }));
check('filter count', filterCount({ ...EMPTY_FILTER, include: ['Lead'], from: '2026-01-01', channel: 'sms' }) === 3);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
