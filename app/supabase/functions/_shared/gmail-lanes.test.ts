// The Gmail lanes' pure pieces. Run: npx tsx tools/gmail-lanes.test.ts
import { emptyLink } from './gmail-match.ts';
import { FAST_LOCK_S, HISTORY_PAGES, HISTORY_TYPES, MOVED_FULL_PER_RUN, MOVED_PER_RUN, SLOW_LOCK_S, type Moved, addedMail, cmpHistory, lendThreads, firstPending, historyBefore, historyCut, laneOf, movedIntoView, quickVerdict, stampPoint, upkeepDue, upkeepMark } from './gmail-lanes.ts';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// history.list: what counts as mail arriving.
const added = (id: string, labelIds: string[]) => ({ message: { id, threadId: 't' + id, labelIds } });
eq('no history means nothing arrived', addedMail([{ historyId: '9' }]), []);
eq('a read or a label change is not mail', addedMail([{ history: [{ id: '1', labelsRemoved: [{ message: { id: 'a' }, labelIds: ['UNREAD'] }] }] }]), []);
eq('inbox and sent mail count', addedMail([{ history: [{ messagesAdded: [added('a', ['INBOX', 'UNREAD']), added('b', ['SENT'])] }] }]), ['a', 'b']);
eq('drafts, chats, spam and trash do not', addedMail([{ history: [{ messagesAdded: [added('d', ['DRAFT']), added('c', ['CHAT']), added('s', ['SPAM']), added('t', ['TRASH'])] }] }]), []);
eq('one id once across pages', addedMail([{ history: [{ messagesAdded: [added('a', ['INBOX'])] }] }, { history: [{ messagesAdded: [added('a', ['INBOX'])] }] }]), ['a']);
eq('a message with no labels counts', addedMail([{ history: [{ messagesAdded: [{ message: { id: 'x' } }] }] }]), ['x']);
eq('junk entries are skipped', addedMail([null, { history: [null, { messagesAdded: [null, { message: null }] }] }]), []);

// Mail moved into view: out of spam, out of trash, into the inbox.
const moved = (id: string, labelIds: string[], now: string[]) => ({ message: { id, threadId: 't' + id, labelIds: now }, labelIds });
const ids = (xs: Moved[]) => xs.map((x) => x.id);
eq('the fast lane asks history for label moves too', HISTORY_TYPES, ['messageAdded', 'labelAdded', 'labelRemoved']);
eq('spam moved to the inbox is read, once, at its first record', movedIntoView([{ history: [{ id: '101', labelsAdded: [moved('s1', ['INBOX'], ['INBOX'])], labelsRemoved: [moved('s1', ['SPAM'], ['INBOX'])] }] }]), [{ id: 's1', at: '101' }]);
eq('spam marked not-spam without the inbox is read', ids(movedIntoView([{ history: [{ id: '1', labelsRemoved: [moved('s2', ['SPAM'], ['CATEGORY_UPDATES'])] }] }])), ['s2']);
eq('restored from trash is read', ids(movedIntoView([{ history: [{ id: '1', labelsRemoved: [moved('t1', ['TRASH'], ['SENT'])] }] }])), ['t1']);
eq('archived mail moved back to the inbox is read', ids(movedIntoView([{ history: [{ id: '1', labelsAdded: [moved('a1', ['INBOX'], ['INBOX', 'UNREAD'])] }] }])), ['a1']);
eq('a read or a star is not a move', movedIntoView([{ history: [{ id: '1', labelsRemoved: [moved('r', ['UNREAD'], ['INBOX'])], labelsAdded: [moved('st', ['STARRED'], ['INBOX', 'STARRED'])] }] }]), []);
eq('moved to spam or trash is not read', movedIntoView([{ history: [{ id: '1', labelsRemoved: [moved('x', ['INBOX'], ['SPAM'])], labelsAdded: [moved('y', ['INBOX'], ['INBOX', 'TRASH'])] }] }]), []);
eq('a label move is not an arrival', addedMail([{ history: [{ id: '1', labelsAdded: [moved('a1', ['INBOX'], ['INBOX'])] }] }]), []);
eq('moves come back in history order across pages', ids(movedIntoView([{ history: [{ id: '30', labelsAdded: [moved('c', ['INBOX'], ['INBOX'])] }] }, { history: [{ id: '9', labelsAdded: [moved('a', ['INBOX'], ['INBOX'])] }] }])), ['a', 'c']);

// A parent restored from spam and its reply in the window, linked in one pass.
{
  const parent = { threadId: 'T', link: { ...emptyLink(), seller_id: 7, deal_id: 3, property_id: 9 } };
  const reply = { threadId: 'T', link: emptyLink() };
  const other = { threadId: 'U', link: emptyLink() };
  const together = lendThreads([reply, other, parent]);
  eq('the window reply files on its moved parent\'s seller and deal', [together[0].seller_id, together[0].deal_id, together[0].property_id], [7, 3, 9]);
  eq('another thread lends nothing', together[1], emptyLink());
  eq('linked apart, the reply would be left unfiled', lendThreads([reply, other])[0], emptyLink());
}

// History ids as numbers of any length.
eq('history ids compare as numbers', [cmpHistory('9', '10') < 0, cmpHistory('18446744073709551616', '18446744073709551615') > 0, cmpHistory('7', '7')], [true, true, 0]);
eq('the id before a long history id', historyBefore('18446744073709551616'), '18446744073709551615');

// The cursor never passes moved mail still to read, or history not yet read.
eq('nothing pending keeps the profile id', stampPoint({ profileId: '500', pendingAt: null, truncatedAt: null }), '500');
eq('a pending move stops the cursor just before it', stampPoint({ profileId: '500', pendingAt: '120', truncatedAt: null }), '119');
eq('history cut short stops the cursor at the last record read', stampPoint({ profileId: '500', pendingAt: null, truncatedAt: '300' }), '300');
eq('the earlier of the two wins', stampPoint({ profileId: '500', pendingAt: '320', truncatedAt: '300' }), '300');
eq('every page read: no cut', historyCut([{ history: [{ id: '200' }] }], false, '100'), null);
eq('more pages: cut at the last record read', historyCut([{ history: [{ id: '150' }, { id: '200' }] }, { history: [{ id: '250' }] }], true, '100'), '250');
eq('more pages and no records: the cursor stays', historyCut([{}], true, '100'), '100');
eq('first pending in history order', firstPending([{ id: 'a', at: '10' }, { id: 'b', at: '11' }, { id: 'c', at: '12' }], new Set(['a', 'c'])), '11');
eq('all settled: nothing pending', firstPending([{ id: 'a', at: '10' }], new Set(['a'])), null);

// Whole runs, simulated: per-run limits on moved mail never skip any of it,
// and every run moves the cursor, so the minute lane is not redispatched forever.
type Box = { profile: number; moves: Moved[]; storedId: number; stored: Set<string> };
// One fast run: reads history from storedId (HISTORY_PAGES pages of `perPage` records),
// then up to MOVED_PER_RUN moved by headers, of which `crm` ones go in full up to MOVED_FULL_PER_RUN.
const run = (b: Box, perPage: number, crm: (id: string) => boolean) => {
  const after = b.moves.filter((m) => Number(m.at) > b.storedId);
  const records = after.slice(0, HISTORY_PAGES * perPage);
  const more = after.length > records.length;
  const pages = [{ history: records.map((m) => ({ id: m.at })) }];
  const visible = records;
  const settled = new Set<string>();
  let full = 0;
  for (const m of visible.slice(0, MOVED_PER_RUN)) {
    if (!crm(m.id)) { settled.add(m.id); continue; }
    if (full >= MOVED_FULL_PER_RUN) continue;
    full++;
    b.stored.add(m.id);
    settled.add(m.id);
  }
  const point = Number(stampPoint({ profileId: String(b.profile), pendingAt: firstPending(visible, settled), truncatedAt: historyCut(pages, more, String(b.storedId)) }));
  const progressed = point > b.storedId;
  b.storedId = point;
  return progressed;
};
const drain = (n: number, perPage: number, crm: (id: string) => boolean) => {
  const moves = Array.from({ length: n }, (_, i) => ({ id: 'm' + i, at: String(1001 + i) }));
  const b: Box = { profile: 1000 + n, moves, storedId: 1000, stored: new Set() };
  let runs = 0;
  let stuck = 0;
  while (b.storedId < b.profile && runs < 500) { runs++; if (!run(b, perPage, crm)) stuck++; }
  const want = moves.filter((m) => crm(m.id)).map((m) => m.id);
  return { done: b.storedId === b.profile, allStored: want.every((id) => b.stored.has(id)), stuck, runs };
};
{
  const r = drain(MOVED_PER_RUN * 3 + 5, 500, () => false);
  eq('more moved mail than MOVED_PER_RUN: all read over several runs, none skipped', [r.done, r.allStored, r.stuck, r.runs], [true, true, 0, 4]);
}
{
  const r = drain(30, 2, () => true);
  eq('moves past HISTORY_PAGES: the cursor stops at the last record read and the rest follow', [r.done, r.allStored, r.stuck], [true, true, 0]);
}
{
  const r = drain(MOVED_FULL_PER_RUN * 2 + 3, 500, () => true);
  eq('more CRM mail than MOVED_FULL_PER_RUN: the rest stays pending and is stored next run', [r.done, r.allStored, r.stuck, r.runs], [true, true, 0, 3]);
}
{
  const r = drain(25, 500, (id) => Number(id.slice(1)) % 2 === 0);
  eq('a mix of CRM and other mail drains with every CRM message stored', [r.done, r.allStored, r.stuck], [true, true, 0]);
}

// One minute's verdict.
eq('same id on a current mailbox is quiet', quickVerdict({ profileId: '50', storedId: '50', current: true }), 'quiet');
eq('a moved id asks history', quickVerdict({ profileId: '51', storedId: '50', current: true }), 'history');
eq('no stored id reads the window', quickVerdict({ profileId: '51', storedId: null, current: true }), 'read');
eq('a failed profile read reads the window', quickVerdict({ profileId: null, storedId: '50', current: true }), 'read');
eq('a mailbox an hour behind reads the window even when the id matches', quickVerdict({ profileId: '50', storedId: '50', current: false }), 'read');

// Upkeep follows what the fast lane stored (gmail_history_id), not the live mailbox.
eq('upkeep runs when the fast lane stored through a newer id', upkeepDue({ readId: '51', upkeepId: '50', hourlyAllowed: false }), true);
eq('upkeep waits when nothing new was stored', upkeepDue({ readId: '50', upkeepId: '50', hourlyAllowed: false }), false);
eq('upkeep runs hourly regardless', upkeepDue({ readId: '50', upkeepId: '50', hourlyAllowed: true }), true);
eq('upkeep runs when it has never run (or before migration 273)', upkeepDue({ readId: '50', upkeepId: null, hourlyAllowed: false }), true);
eq('upkeep runs when the fast lane has never read through', upkeepDue({ readId: null, upkeepId: '50', hourlyAllowed: false }), true);
eq('a partial fast run marks upkeep due without moving readId', upkeepDue({ readId: '50', upkeepId: upkeepMark(), hourlyAllowed: false }), true);
eq('each mark is unique, so a slow run in flight cannot stamp over a newer one', upkeepMark(1) !== upkeepMark(1), true);
// The finding: mail arrived (live id 52) while the fast lane's lock was busy,
// so it has stored through 50 only. Upkeep runs now on what is stored and
// stamps 50, not 52; when the fast lane stores through 52, upkeep is due again
// on the next tick instead of waiting for the hourly run.
{
  const stamped = '50';
  eq('upkeep after the fast lane stores the late mail is due at once', upkeepDue({ readId: '52', upkeepId: stamped, hourlyAllowed: false }), true);
}

// Lanes and locks.
eq('fast only when asked by name', [laneOf('fast'), laneOf('slow'), laneOf(undefined), laneOf('FAST')], ['fast', 'slow', 'slow', 'slow']);
eq('the fast lock frees before the next minute tick', FAST_LOCK_S < 60, true);
eq('the slow lock frees before the next five-minute tick', SLOW_LOCK_S < 300 && SLOW_LOCK_S > FAST_LOCK_S, true);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
