// People list keyboard. Run: npx tsx tools/people-keys.test.ts
import { SELLER_STAGE_LABELS } from '../lib/stages';
import {
  adjacentOpenRow, adjacentRecordId, adjacentStage, openRowId, submissionRowKey, buyersNavAction, confirmKey, isArchiveChord, isArchiveKey, isOpenKey, isSelectAllChord, isTypingTarget, listNavBlocked, peopleNavAction, recordNavBlocked, stepIndex, stepLabel,
} from '../lib/people-keys';
import { comprNote } from '../lib/compr-sync';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('wrap forward', stepIndex(2, 3, 1), 0);
eq('wrap back', stepIndex(0, 3, -1), 2);
eq('empty list', stepIndex(4, 0, 1), 0);
eq('next list', stepLabel('Hot Leads', ['My Leads', 'Hot Leads', 'New Leads'], 1), 'New Leads');
eq('enter list from outside', stepLabel('Vendors', ['My Leads', 'Hot Leads'], -1), 'Hot Leads');
eq('demo stage forward', adjacentStage('Qualified', 1, SELLER_STAGE_LABELS), 'Appointment');
eq('demo stage back stops', adjacentStage('New Lead', -1, SELLER_STAGE_LABELS), null);
eq('live stage forward', adjacentStage('Lead', 1, SELLER_STAGE_LABELS), 'Lead - No Contact');
eq('offer made skips the filler rows', adjacentStage('Offer Made', 1, SELLER_STAGE_LABELS), 'Offer Accepted');
eq('memo is not the next stage', adjacentStage('Under Contract - Buyer', 1, SELLER_STAGE_LABELS), 'Closed');
eq('unknown stage', adjacentStage('Something new', 1, SELLER_STAGE_LABELS), null);

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...extra });
eq('list right walks the list', peopleNavAction(key('ArrowRight'), 'list'), { type: 'in-list', dir: 1 });
eq('list left walks the list', peopleNavAction(key('ArrowLeft'), 'list'), { type: 'in-list', dir: -1 });
eq('list down walks the list', peopleNavAction(key('ArrowDown'), 'list'), { type: 'in-list', dir: 1 });
eq('list up walks the list', peopleNavAction(key('ArrowUp'), 'list'), { type: 'in-list', dir: -1 });
eq('list alt+down jumps smart lists', peopleNavAction(key('ArrowDown', { altKey: true }), 'list'), { type: 'smart-list', dir: 1 });
eq('list alt+up jumps smart lists', peopleNavAction(key('ArrowUp', { altKey: true }), 'list'), { type: 'smart-list', dir: -1 });
eq('list alt+right is not a move', peopleNavAction(key('ArrowRight', { altKey: true }), 'list'), null);
eq('list ctrl+alt+down is not a move', peopleNavAction(key('ArrowDown', { altKey: true, ctrlKey: true }), 'list'), null);
eq('list ctrl+right steps stage', peopleNavAction(key('ArrowRight', { ctrlKey: true }), 'list'), { type: 'stage', dir: 1 });
eq('list ctrl+left steps stage', peopleNavAction(key('ArrowLeft', { ctrlKey: true }), 'list'), { type: 'stage', dir: -1 });
eq('list ctrl+down is not a move', peopleNavAction(key('ArrowDown', { ctrlKey: true }), 'list'), null);
eq('list ignores meta', peopleNavAction(key('ArrowRight', { metaKey: true }), 'list'), null);
eq('list ignores a handled key', peopleNavAction(key('ArrowDown', { defaultPrevented: true }), 'list'), null);
eq('list blocked while typing', peopleNavAction(key('ArrowRight'), 'list', true), null);
eq('list ignores letters', peopleNavAction(key('c'), 'list'), null);

eq('buyers right walks the list', buyersNavAction(key('ArrowRight')), { type: 'in-list', dir: 1 });
eq('buyers left walks the list', buyersNavAction(key('ArrowLeft')), { type: 'in-list', dir: -1 });
eq('buyers down jumps lists', buyersNavAction(key('ArrowDown')), { type: 'list', dir: 1 });
eq('buyers up jumps lists', buyersNavAction(key('ArrowUp')), { type: 'list', dir: -1 });
eq('buyers ignores ctrl', buyersNavAction(key('ArrowRight', { ctrlKey: true })), null);
eq('buyers blocked while typing', buyersNavAction(key('ArrowRight'), true), null);

eq('record right opens the next person', peopleNavAction(key('ArrowRight'), 'record'), { type: 'in-list', dir: 1 });
eq('record left opens the previous person', peopleNavAction(key('ArrowLeft'), 'record'), { type: 'in-list', dir: -1 });
eq('record down opens the next person', peopleNavAction(key('ArrowDown'), 'record'), { type: 'in-list', dir: 1 });
eq('record up opens the previous person', peopleNavAction(key('ArrowUp'), 'record'), { type: 'in-list', dir: -1 });
eq('record ctrl+right steps the open stage', peopleNavAction(key('ArrowRight', { ctrlKey: true }), 'record'), { type: 'stage', dir: 1 });
eq('record ctrl+left steps the open stage', peopleNavAction(key('ArrowLeft', { ctrlKey: true }), 'record'), { type: 'stage', dir: -1 });
eq('record ctrl+up does not walk or step', peopleNavAction(key('ArrowUp', { ctrlKey: true }), 'record'), null);
eq('record typing is left alone', peopleNavAction(key('ArrowLeft'), 'record', true), null);
eq('record ignores alt', peopleNavAction(key('ArrowDown', { altKey: true }), 'record'), null);

const ids = ['a', 'b', 'c'];
eq('next person in the open list', adjacentRecordId(ids, 'b', 1), 'c');
eq('previous person wraps', adjacentRecordId(ids, 'a', -1), 'c');
eq('next person wraps', adjacentRecordId(ids, 'c', 1), 'a');
eq('record not on the list enters at the start', adjacentRecordId(ids, 'z', 1), 'a');
eq('record not on the list enters at the end', adjacentRecordId(ids, null, -1), 'c');
eq('one person stays put', adjacentRecordId(['a'], 'a', 1), 'a');
eq('empty list has no neighbor', adjacentRecordId([], 'a', 1), null);

eq('an input is typing', isTypingTarget({ tagName: 'INPUT' }), true);
eq('a textarea is typing', isTypingTarget({ tagName: 'textarea' }), true);
eq('a select is typing', isTypingTarget({ tagName: 'SELECT' }), true);
eq('contenteditable is typing', isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
eq('the page is not typing', isTypingTarget({ tagName: 'BODY' }), false);
eq('no target is not typing', isTypingTarget(null), false);

eq('list blocks a vendor list', listNavBlocked({ vendorList: true }), true);
eq('list blocks the search box', listNavBlocked({ typing: true }), true);
eq('list blocks a dialog', listNavBlocked({ dialogOrMenu: true }), true);
eq('list is free on the table', listNavBlocked({}), false);

const open = { onRecord: true };
eq('record is free when nothing else is up', recordNavBlocked(open), false);
eq('record blocks typing', recordNavBlocked({ ...open, typing: true }), true);
eq('record blocks the photo slideshow', recordNavBlocked({ ...open, photoShow: true }), true);
eq('record blocks quick compose', recordNavBlocked({ ...open, quickReach: true }), true);
eq('record blocks a dialog', recordNavBlocked({ ...open, dialogOrMenu: true }), true);
eq('record blocks the details sheet', recordNavBlocked({ ...open, detailsOpen: true }), true);
eq('record blocks the offer sheet', recordNavBlocked({ ...open, offerOpen: true }), true);
eq('record blocks the dialer', recordNavBlocked({ ...open, inDialer: true }), true);
eq('record nav does not run off the record', recordNavBlocked({ onRecord: false }), true);

eq('note carries the rest of the report', comprNote({ condition: 'C4', compCount: 6, arvLow: 190000, arvHigh: 210000 }).startsWith('COMPR · '), true);

eq('ctrl+a selects all on People', isSelectAllChord(key('a', { ctrlKey: true })), true);
eq('cmd+a selects all on People', isSelectAllChord(key('a', { metaKey: true })), true);
eq('ctrl+a while typing is the text', isSelectAllChord(key('a', { ctrlKey: true }), true), false);
eq('shift+delete archives', isArchiveKey(key('Delete', { shiftKey: true })), true);
eq('shift+backspace archives', isArchiveKey(key('Backspace', { shiftKey: true })), true);
eq('plain delete does not archive', isArchiveKey(key('Delete')), false);
eq('ctrl+a does not archive on People', isArchiveKey(key('a', { ctrlKey: true })), false);
eq('ctrl+shift+delete does not archive', isArchiveKey(key('Delete', { shiftKey: true, ctrlKey: true })), false);
eq('shift+delete while typing deletes text', isArchiveKey(key('Delete', { shiftKey: true }), true), false);
eq('ctrl+a archives on Buyers', isArchiveChord(key('a', { ctrlKey: true })), true);
eq('cmd+a archives on a Mac', isArchiveChord(key('a', { metaKey: true })), true);
eq('ctrl+A from the key code (other layouts)', isArchiveChord(key('ф', { ctrlKey: true, code: 'KeyA' })), true);
eq('plain a is not archive', isArchiveChord(key('a')), false);
eq('ctrl+shift+a is not archive', isArchiveChord(key('A', { ctrlKey: true, shiftKey: true })), false);
eq('ctrl+a while typing selects text', isArchiveChord(key('a', { ctrlKey: true }), true), false);
eq('enter opens', isOpenKey(key('Enter')), true);
eq('ctrl+enter does not open', isOpenKey(key('Enter', { ctrlKey: true })), false);
eq('enter while blocked does not open', isOpenKey(key('Enter'), true), false);
eq('right picks yes', confirmKey('ArrowRight', 'no'), { pick: 'yes' });
eq('left picks no', confirmKey('ArrowLeft', 'yes'), { pick: 'no' });
eq('tab flips', confirmKey('Tab', 'no'), { pick: 'yes' });
eq('enter answers with the pick', confirmKey('Enter', 'yes'), { answer: 'yes' });
eq('enter on the default is no', confirmKey('Enter', 'no'), { answer: 'no' });
eq('escape is no', confirmKey('Escape', 'yes'), { answer: 'no' });
eq('y answers yes', confirmKey('Y', 'no'), { answer: 'yes' });
eq('other keys are ignored', confirmKey('x', 'no'), null);

// Submission lists: the open record is the seller (s5) pinned to a house (d12).
const subs = ['sub:d10', 'sub:d12', 'sub:d12~4567', 'sub:d14'];
eq('a resubmission row is its house', submissionRowKey('sub:d12~4567'), 'sub:d12');
eq('a person id is itself', submissionRowKey('s5'), 's5');
eq('a pinned submission finds its row, not the seller', openRowId(subs, 's5', 'd12'), 'sub:d12');
eq('an unpinned record is its own id', openRowId(['s1', 's5'], 's5', null), 's5');
eq('a pin not on this list falls back to the person', openRowId(['s1', 's5'], 's5', 'd99'), 's5');
eq('next submission, skipping the repeat of this house', adjacentOpenRow(subs, 'sub:d12', 1), 'sub:d14');
eq('previous submission', adjacentOpenRow(subs, 'sub:d12', -1), 'sub:d10');
eq('back from the next house skips the repeat row', adjacentOpenRow(subs, 'sub:d14', -1), 'sub:d12~4567');
eq('a list of one house has nowhere to go', adjacentOpenRow(['sub:d12', 'sub:d12~1'], 'sub:d12', 1), null);
eq('people lists step as before', adjacentOpenRow(['a', 'b', 'c'], 'b', 1), 'c');
eq('a record off the list enters at the start', adjacentOpenRow(['a', 'b'], 'z', 1), 'a');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('people-keys: all passed');
