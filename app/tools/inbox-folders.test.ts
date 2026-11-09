// lib/inbox-folders.ts: the Inbox's folders, suggested labels and thread filter.
// Run with:  npx tsx tools/inbox-folders.test.ts
import { EMPTY_FILTER, type FolderItem, areaCodeOf, ackOnly, automatedSender, closedBy, filterCount, folderCounts, foldersFor, inFolder, leftCampaign, matchesFilter, optedOutOf, quietOptOuts, suggestLabel } from '../lib/inbox-folders';

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
check("Talkr's unsubscribe confirmation leaves one campaign, not an opt-out", leftCampaign('You have been unsubscribed and will receive no more messages.') && !leftCampaign('You there?') && !optedOutOf(null, [], null));
check('a text they never answered is not awaiting', !inFolder(item({ theyLast: false, cold: true }), 'awaiting') && inFolder(item({ theyLast: false, cold: true }), 'all'));
check('a call is never unreplied or awaiting', !inFolder(item({ kind: 'call', theyLast: true }), 'unreplied') && !inFolder(item({ kind: 'call' }), 'awaiting'));
check('a missed call files under Missed calls and All', inFolder(item({ kind: 'call', missed: true }), 'missed') && inFolder(item({ kind: 'call', missed: true }), 'all'));
check('an archived thread is only in Archived', inFolder(item({ archived: true, unread: true }), 'archived') && !inFolder(item({ archived: true, unread: true }), 'all') && !inFolder(item({ archived: true, unread: true }), 'unread'));
check('e-sign envelopes are automated mail', automatedSender('dse_na4@docusign.net') && automatedSender('docs@email.pandadoc.net') && !automatedSender('jad@westbrookgroup.com'));
check('a bare acknowledgement owes no reply', ackOnly('No problem') && ackOnly('ok!') && ackOnly('Thanks 👍') && !ackOnly('ok what is your offer') && !ackOnly('How much?'));
check('opted out', inFolder(item({ optedOut: true }), 'optout'));
check('a pending scheduled text files under Scheduled', inFolder(item({ scheduled: true }), 'scheduled') && !inFolder(item({}), 'scheduled') && folderCounts([item({ scheduled: true }), item({})]).scheduled === 1);
const counts = folderCounts([item({ unread: true, theyLast: true }), item({}), item({ kind: 'call', missed: true, theyLast: true }), item({ archived: true })]);
check('counts', counts.all === 3 && counts.unread === 1 && counts.unreplied === 1 && counts.awaiting === 1 && counts.missed === 1 && counts.archived === 1, counts);

// ---- per-channel rail ----
const mixed = [item({ unread: true, theyLast: true }), item({ kind: 'email', unread: true, theyLast: true }), item({ kind: 'call', missed: true, theyLast: true }), item({ scheduled: true }), item({ kind: 'email', archived: true })];
const sms = folderCounts(mixed, 'sms');
check('SMS tab counts only texts', sms.all === 2 && sms.unread === 1 && sms.unreplied === 1 && sms.scheduled === 1 && sms.missed === 0 && sms.archived === 0, sms);
const mail = folderCounts(mixed, 'email');
check('Email tab counts only mail', mail.all === 1 && mail.unread === 1 && mail.archived === 1 && mail.optout === 0 && mail.missed === 0, mail);
const call = folderCounts(mixed, 'call');
check('Calls tab counts only calls, Missed included', call.all === 1 && call.missed === 1 && call.unread === 0 && call.unreplied === 0, call);
check('All tab counts everything as before', folderCounts(mixed).all === 4 && folderCounts(mixed, null).missed === 1);
check('folders hidden where they cannot apply', !foldersFor('sms').some((f) => f.id === 'missed') && !foldersFor('email').some((f) => f.id === 'optout' || f.id === 'missed') && foldersFor('call').map((f) => f.id).join() === 'all,missed,archived' && foldersFor(null).length === 8);

// ---- opted out ----
check('dnc status is opted out', optedOutOf('dnc', []));
check('an opt-out tag is opted out', optedOutOf('engaged', ['campaign-a', 'Opted Out']));
check('a plain tag is not', !optedOutOf('engaged', ['campaign-a', 'stopped-by-rep']) === false || !optedOutOf('engaged', ['campaign-a']));
check('a bare STOP text is opted out', optedOutOf('engaged', [], ' Stop. ') && optedOutOf(null, null, 'UNSUBSCRIBE'));
check('STOP inside a sentence is not', !optedOutOf('engaged', [], 'please stop by tomorrow at 5'));
check('opted out leaves Unread, Unreplied and Awaiting', !inFolder(item({ optedOut: true, unread: true, theyLast: true }), 'unread') && !inFolder(item({ optedOut: true, theyLast: true }), 'unreplied') && !inFolder(item({ optedOut: true }), 'awaiting') && inFolder(item({ optedOut: true }), 'all'));
check('Not interested or Wrong number closes a thread', closedBy(['Not interested']) && closedBy(['Lead', 'Wrong number']) && !closedBy(['Follow up']) && !closedBy(null));
check('a closed thread is off Unreplied and Awaiting, still on All', !inFolder(item({ closed: true, theyLast: true }), 'unreplied') && !inFolder(item({ closed: true }), 'awaiting') && inFolder(item({ closed: true }), 'all'));
check('closed and opted out drop the Unreplied count', folderCounts([item({ theyLast: true }), item({ theyLast: true, closed: true }), item({ theyLast: true, optedOut: true })]).unreplied === 1);
check('bounces and no-reply are automated', automatedSender('mailer-daemon@googlemail.com') && automatedSender('noreply@x.com') && automatedSender('no-reply@x.com') && !automatedSender('alex@yourcompany.com'));

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

// ---- opt-outs ask nothing: no unread ----
const stopConv = { id: 'a', unread_count: 2, contact_status: null, tags: [], last_message: { direction: 'inbound', body: 'STOP' } };
const realConv = { id: 'b', unread_count: 1, contact_status: null, tags: [], last_message: { direction: 'inbound', body: 'Send me details' } };
const dncConv = { id: 'c', unread_count: 1, contact_status: 'dnc', tags: [], last_message: { direction: 'inbound', body: 'ok' } };
const quiet = quietOptOuts({ conversations: [stopConv, realConv, dncConv], counts: { unread: 3 } });
check('a STOP thread is not unread', quiet.conversations[0].unread_count === 0);
check('a real reply stays unread', quiet.conversations[1].unread_count === 1);
check('a DNC contact is not unread', quiet.conversations[2].unread_count === 0);
check('the unread count drops with them', quiet.counts.unread === 1);
check('a STOP Talkr answered is not unread', quietOptOuts({ conversations: [{ id: 'd', unread_count: 1, contact_status: null, tags: [], last_message: { direction: 'outbound', body: 'You have been unsubscribed and will receive no more messages.' } }] }).conversations[0].unread_count === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
