// A seller's other numbers and the dial list a power-dialer session walks
// (lib/seller-phones.ts). Run: npx tsx tools/seller-phones.test.ts
import assert from 'node:assert/strict';
import {
  byPosition, dialNumbers, freshNumbers, isBadNumber, nextPositions, otherNumbers, peopleLeft, primaryFlag, readQueueDepth,
  spliceNumbers, walkKey, type DialNumber, type OtherPhone, type WalkRow,
} from '../lib/seller-phones';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
};

const ph = (id: number, phone: string, position: number | null, more: Partial<OtherPhone> = {}): OtherPhone => ({ id, phone, position, ...more });

// ---- order and badges -------------------------------------------------------
test('position order, unpositioned last, then the order added', () => {
  assert.deepEqual(byPosition([ph(4, 'a', null), ph(3, 'b', 3), ph(2, 'c', 2), ph(1, 'd', 3)]).map((r) => r.id), [2, 1, 3, 4]);
});
test('do not call, wrong, and a buyer number marked kind wrong are bad', () => {
  assert.equal(isBadNumber(ph(1, '+12105550101', 2, { is_dnc: true })), true);
  assert.equal(isBadNumber(ph(1, '+12105550101', 2, { is_wrong: true })), true);
  assert.equal(isBadNumber(ph(1, '+12105550101', 2, { kind: 'Wrong' })), true);
  assert.equal(isBadNumber(ph(1, '+12105550101', 2, { kind: 'mobile', is_dnc: false, is_wrong: false })), false);
});

// ---- the record's list ------------------------------------------------------
test('the record lists other numbers in order, never the primary again, bad ones kept', () => {
  const rows = [ph(1, '+12105550100', 2), ph(2, '+12105550102', 4, { is_dnc: true }), ph(3, '(210) 555-0101', 3), ph(4, '210.555.0101', 5)];
  assert.deepEqual(otherNumbers('(210) 555-0100', rows).map((r) => r.id), [3, 2]);
  assert.deepEqual(otherNumbers('—', rows).map((r) => r.id), [1, 3, 2]);
});

// ---- the dial list ----------------------------------------------------------
const extras = [
  ph(11, '+12105550103', 4),
  ph(10, '+12105550102', 3, { is_dnc: true }),
  ph(12, '+12105550101', 2),
  ph(13, '(210) 555-0100', 5), // the primary in another spelling
  ph(14, '12345', 6), // not a number
  ph(15, '+12105550104', 7, { is_wrong: true }),
  ph(16, '+12105550105', 8),
];
const nums = (xs: DialNumber[]) => xs.map((x) => `${x.phone}#${x.phoneId ?? 'own'}`);
test('primary first, then by position; DNC, wrong, broken and repeats left out', () => {
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', extras, 'all')), [
    '+12105550100#own', '+12105550101#12', '+12105550103#11', '+12105550105#16',
  ]);
});
test('depth cuts the list after the filtering', () => {
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', extras, 1)), ['+12105550100#own']);
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', extras, 2)), ['+12105550100#own', '+12105550101#12']);
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', extras, 3)), ['+12105550100#own', '+12105550101#12', '+12105550103#11']);
});
test('a blank or broken primary leaves their first good number as number 1', () => {
  assert.deepEqual(nums(dialNumbers('—', extras, 2)), ['+12105550101#12', '+12105550103#11']);
  assert.deepEqual(nums(dialNumbers(null, [], 'all')), []);
});
test('a number marked bad in one spelling is not rung in another', () => {
  const rows = [ph(1, '(210) 555-0107', 2, { kind: 'wrong' }), ph(2, '+12105550107', 3)];
  assert.deepEqual(nums(dialNumbers('+12105550100', rows, 'all')), ['+12105550100#own']);
});
test('the record\'s own phone is skipped once a copy of it is marked bad (main number found wrong, or on the DNC registry)', () => {
  assert.deepEqual(nums(dialNumbers('+12105550100', [ph(1, '+12105550100', 2, { is_dnc: true })], 'all')), []);
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', [ph(1, '+12105550100', 9, { is_wrong: true }), ph(2, '+12105550101', 2)], 'all')), ['+12105550101#2']);
  // So their next number is number 1, and depth counts from there.
  assert.deepEqual(nums(dialNumbers('(210) 555-0100', [ph(1, '+12105550100', 9, { is_wrong: true }), ph(2, '+12105550101', 2), ph(3, '+12105550102', 3)], 1)), ['+12105550101#2']);
});
test('how the main number stands', () => {
  assert.equal(primaryFlag('(210) 555-0100', [ph(1, '+12105550100', 9, { is_wrong: true })]), 'wrong');
  assert.equal(primaryFlag('(210) 555-0100', [ph(1, '+12105550100', 9, { is_dnc: true })]), 'dnc');
  assert.equal(primaryFlag('(210) 555-0100', [ph(1, '+12105550101', 2, { is_wrong: true })]), null);
  assert.equal(primaryFlag('—', []), null);
});

// ---- what a writer keeps ----------------------------------------------------
test('found numbers: E.164, not the primary, not on file, each once, flags kept', () => {
  const kept = freshNumbers('(210) 555-0100', [{ phone: '+12105550101' }], [
    { phone: '2105550100' }, { phone: '210-555-0101' }, { phone: '555-0102' }, { phone: null },
    { phone: '(210) 555-0103', kind: 'wireless', dnc: true }, { phone: '+1 210 555 0103' }, { phone: '12105550104' },
  ]);
  assert.deepEqual(kept, [{ phone: '+12105550103', kind: 'wireless', dnc: true }, { phone: '+12105550104' }]);
});
test('positions follow those on file; the first other number is 2', () => {
  assert.deepEqual(nextPositions([], 2), [2, 3]);
  assert.deepEqual(nextPositions([{ position: 2 }, { position: 5 }], 1), [6]);
  assert.deepEqual(nextPositions([{ position: null }], 1), [2]);
});

// ---- a session walking several numbers per person ---------------------------
type Row = WalkRow & { queueItemId?: string };
const row = (name: string, phone: string, ids: { personId?: string; buyerId?: string } = {}, more: Partial<Row> = {}): Row => ({
  target: { phone, ...ids }, ...more,
});
const lists: Record<string, DialNumber[]> = {
  'p:p1': [{ phone: '+12105550100', phoneId: null }, { phone: '+12105550101', phoneId: 12 }, { phone: '+12105550103', phoneId: 11 }],
  'p:p2': [{ phone: '+12105550200', phoneId: null }],
  'p:p3': [{ phone: '+12105550301', phoneId: 31 }],
  'p:p4': [],
  'b:b1': [{ phone: '+12105550400', phoneId: null }, { phone: '+12105550401', phoneId: 41 }],
};
const of = (r: Row) => { const k = walkKey(r.target); return k ? lists[k] : undefined; };
const show = (xs: Row[]) => xs.map((r) => `${r.target.personId ?? r.target.buyerId ?? 'vendor'} ${r.target.phone} ${r.n ?? '-'}/${r.of ?? '-'}${r.claim ? ' claim' : ''}${r.queueItemId ? ' q' + r.queueItemId : ''}`);

test('walk keys name the seller or buyer; a vendor row has none', () => {
  assert.equal(walkKey({ personId: 'p1' }), 'p:p1');
  assert.equal(walkKey({ buyerId: 'b1' }), 'b:b1');
  assert.equal(walkKey({}), null);
});
test('at the start every person gets a row per number, side by side; only the first row claims', () => {
  const list = [
    row('Ann', '(210) 555-0100', { personId: 'p1' }, { claim: true, queueItemId: '7' }),
    row('Vendor', '(210) 555-0900'),
    row('Bo', '(210) 555-0200', { personId: 'p2' }),
    row('Cy', '—', { personId: 'p3' }),
    row('Di', '—', { personId: 'p4' }),
    row('Ed', '(210) 555-0400', { buyerId: 'b1' }),
  ];
  assert.deepEqual(show(spliceNumbers(list, 0, of)), [
    'p1 +12105550100 1/3 claim q7', 'p1 +12105550101 2/3 q7', 'p1 +12105550103 3/3 q7',
    'vendor (210) 555-0900 -/-',
    'p2 +12105550200 1/1',
    'p3 +12105550301 1/1',
    'p4 — -/-',
    'b1 +12105550400 1/2', 'b1 +12105550401 2/2',
  ]);
  const spliced = spliceNumbers(list, 0, of);
  assert.equal(spliced[1]!.target.phoneId, 12);
  assert.equal(spliced[0]!.target.phoneId, null);
});
test('numbers read after the first call join behind the number that is ringing', () => {
  const list = [
    row('Zed', '(210) 555-0000', { personId: 'p0' }),
    row('Ann', '(210) 555-0100', { personId: 'p1' }, { claim: true }),
    row('Ed', '(210) 555-0400', { buyerId: 'b1' }),
  ];
  // Ann (index 1) was dialled, so pos is 2; Zed is behind the walk and stays as he was.
  assert.deepEqual(show(spliceNumbers(list, 2, of)), [
    'p0 (210) 555-0000 -/-',
    'p1 (210) 555-0100 1/3 claim', 'p1 +12105550101 2/3', 'p1 +12105550103 3/3',
    'b1 +12105550400 1/2', 'b1 +12105550401 2/2',
  ]);
});
test('a dialled person with nothing else, and a list already spliced, stay as they are', () => {
  const list = [row('Bo', '(210) 555-0200', { personId: 'p2' })];
  assert.deepEqual(show(spliceNumbers(list, 1, of)), ['p2 (210) 555-0200 -/-']);
  const once = spliceNumbers([row('Ann', '(210) 555-0100', { personId: 'p1' })], 0, of);
  assert.deepEqual(show(spliceNumbers(once, 0, of)), show(once));
});
test('people left: not started, less the one being walked and anyone reached', () => {
  const list = spliceNumbers([
    row('Ann', '(210) 555-0100', { personId: 'p1' }),
    row('Bo', '(210) 555-0200', { personId: 'p2' }),
    row('Vendor', '(210) 555-0900'),
    row('Ed', '(210) 555-0400', { buyerId: 'b1' }),
  ], 0, of);
  assert.equal(peopleLeft(list, 0, []), 4);
  assert.equal(peopleLeft(list, 1, ['p:p1']), 3); // on Ann's first number
  assert.equal(peopleLeft(list, 2, ['p:p1']), 3); // her second
  assert.equal(peopleLeft(list, 3, ['p:p1']), 3); // her last, rung
  assert.equal(peopleLeft(list, 4, ['p:p2']), 2); // on Bo
  assert.equal(peopleLeft(list, 1, ['p:p1', 'p:p2']), 2); // Bo reached already
  assert.equal(peopleLeft(list, list.length, []), 0);
});
test('with no browser storage the depth is 1, the record\'s own phone', () => {
  assert.equal(readQueueDepth(), 1);
});

console.log(`seller-phones: ${passed} checks passed`);
