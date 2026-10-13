// Where a task opens. Run: npx tsx tools/task-record.test.ts
import assert from 'node:assert/strict';
import { taskRecordOf } from '../lib/task-record';

const look = {
  hasPerson: (id: string) => id === 's10' || id === 's20',
  sellerOfDeal: (dealId: string) => (dealId === 'd5' ? 's10' : dealId === 'd9' ? 's99' : null),
  hasBuyer: (id: string) => id === 'b3',
};

assert.deepEqual(
  taskRecordOf({ personId: 's10', dealId: 'd5' }, look),
  { kind: 'person', id: 's10', dealId: 'd5' },
);
assert.deepEqual(
  taskRecordOf({ personId: '', dealId: 'd5' }, look),
  { kind: 'person', id: 's10', dealId: 'd5' },
  'checklist task: deal_id alone opens that deal\'s seller',
);
assert.deepEqual(
  taskRecordOf({ personId: '', dealId: '', buyerId: 'b3' }, look),
  { kind: 'buyer', id: 'b3' },
);
assert.equal(taskRecordOf({ personId: '', dealId: '', buyerId: '' }, look), null);
assert.deepEqual(
  taskRecordOf({ personId: 's20' }, look),
  { kind: 'person', id: 's20', dealId: null },
);
assert.deepEqual(
  taskRecordOf({ personId: '', dealId: 'd9' }, look),
  { kind: 'person', id: '', dealId: 'd9' },
  'deal whose seller is not loaded still opens the deal sheet',
);

console.log('task-record: ok');
