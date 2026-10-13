// Signing order, recipient types and reminders.  Run:  npx tsx tools/signing-order.test.ts
import assert from 'node:assert/strict';
import { allSigned, appendTcCc, canSignNow, ccAddresses, fills, inSendingHours, isDone, needsApproval, pending, pendingApprovals, reminderDue, sendTo, signs, turn } from '../supabase/functions/_shared/signing-order';

const seller = { id: 1, sort: 1, status: 'pending', recipient_type: 'signer' };
const company = { id: 2, sort: 2, status: 'pending', recipient_type: 'signer' };
const tc = { id: 3, sort: 3, status: 'pending', recipient_type: 'cc' };
const lender = { id: 4, sort: 4, status: 'pending', recipient_type: 'viewer' };
const all = [company, seller, tc, lender];

// Parallel: both signers now; cc waits; the viewer gets a link.
assert.deepEqual(turn(all, 'parallel').map((r) => r.id), [1, 2]);
assert.deepEqual(sendTo(all, 'parallel').map((r) => r.id).sort(), [1, 2, 4]);
// Sequential: the seller first, the company only after.
assert.deepEqual(turn(all, 'sequential').map((r) => r.id), [1]);
assert.equal(canSignNow(all, 'sequential', 2), false);
const afterSeller = [{ ...seller, status: 'signed' }, company, tc, lender];
assert.equal(canSignNow(afterSeller, 'sequential', 2), true);
// CC and viewers never hold up completion.
assert.equal(allSigned(afterSeller), false);
assert.equal(allSigned([{ ...seller, status: 'signed' }, { ...company, status: 'signed' }, tc, lender]), true);
assert.equal(allSigned([tc, lender]), false, 'nothing to sign is not complete');
assert.deepEqual(pending(all).map((r) => r.id), [1, 2]);

// Form fillers (title typing in deal data): a turn like a signer, done when 'filled', never signs.
const title = { id: 5, sort: 1, status: 'pending', recipient_type: 'filler' };
const withFiller = [title, { ...seller, sort: 2 }, { ...company, sort: 3 }, tc];
assert.equal(signs(title), true, 'a filler takes a turn');
assert.equal(fills(title), true);
assert.equal(fills(seller), false);
assert.deepEqual(turn(withFiller, 'sequential').map((r) => r.id), [5], 'the filler goes first when listed first');
assert.equal(canSignNow(withFiller, 'sequential', 1), false);
const filled = [{ ...title, status: 'filled' }, { ...seller, sort: 2 }, { ...company, sort: 3 }, tc];
assert.equal(isDone(filled[0]), true);
assert.deepEqual(turn(filled, 'sequential').map((r) => r.id), [1], 'then the seller');
assert.deepEqual(sendTo(withFiller, 'parallel').map((r) => r.id).sort(), [1, 2, 5]);
// Everyone signed but the filler has not pressed Done: not complete.
assert.equal(allSigned([title, { ...seller, status: 'signed' }, { ...company, status: 'signed' }]), false);
assert.equal(allSigned([{ ...title, status: 'filled' }, { ...seller, status: 'signed' }, { ...company, status: 'signed' }]), true);
// 'filled' only finishes a filler; a signer is done only when signed.
assert.equal(isDone({ ...seller, status: 'filled' }), false);
assert.deepEqual(pending(filled).map((r) => r.id), [1, 2]);

// Reminders: 1 day, then every 2, up to the max; 0 turns them off.
const sent = '2026-09-28T15:00:00Z';
assert.equal(reminderDue(null, sent, null, 0, Date.parse('2026-09-29T14:00:00Z')), false);
assert.equal(reminderDue(null, sent, null, 0, Date.parse('2026-09-29T15:01:00Z')), true);
assert.equal(reminderDue(null, sent, '2026-09-29T15:01:00Z', 1, Date.parse('2026-09-30T15:00:00Z')), false);
assert.equal(reminderDue(null, sent, '2026-09-29T15:01:00Z', 1, Date.parse('2026-10-01T15:02:00Z')), true);
assert.equal(reminderDue({ first_after_days: 0 }, sent, null, 0, Date.parse('2026-10-09T00:00:00Z')), false);
assert.equal(reminderDue({ max: 2 }, sent, '2026-09-29T15:01:00Z', 2, Date.parse('2026-10-09T00:00:00Z')), false);

// 8am–8pm Central.
assert.equal(inSendingHours(new Date('2026-09-30T15:00:00Z')), true);
assert.equal(inSendingHours(new Date('2026-09-30T04:00:00Z')), false);

// Approvers (migration 114): internal sign-off gates sending; never a signatory.
const coo = { id: 5, sort: 0, status: 'pending', recipient_type: 'approver' };
const gated = [coo, company, seller, tc, lender];
assert.equal(signs(coo), false);
assert.equal(needsApproval(gated), true);
assert.deepEqual(sendTo(gated, 'parallel').map((r) => r.id), [5], 'only the approver hears first');
assert.deepEqual(sendTo(gated, 'sequential').map((r) => r.id), [5]);
assert.deepEqual(turn(gated, 'parallel'), [], 'nobody signs while approval is pending');
assert.equal(canSignNow(gated, 'parallel', 1), false);
assert.deepEqual(pending(gated).map((r) => r.id), [1, 2], 'an approver is never a pending signer');
const rejected = [{ ...coo, status: 'rejected' }, company, seller];
assert.equal(needsApproval(rejected), true, 'a rejection still gates');
const approved = [{ ...coo, status: 'approved' }, company, seller, tc, lender];
assert.equal(needsApproval(approved), false);
assert.deepEqual(pendingApprovals(approved), []);
assert.deepEqual(sendTo(approved, 'parallel').map((r) => r.id).sort(), [1, 2, 4], 'after approval: the normal send');
assert.deepEqual(sendTo(approved, 'sequential').map((r) => r.id).sort(), [1, 4]);
assert.equal(allSigned([{ ...coo, status: 'approved' }, { ...seller, status: 'signed' }, { ...company, status: 'signed' }]), true);
assert.equal(allSigned([coo, { ...seller, status: 'signed' }, { ...company, status: 'signed' }]), false, 'not complete without the approval');
const twoApprovers = [{ ...coo, status: 'approved' }, { id: 6, sort: 0, status: 'pending', recipient_type: 'approver' }, seller];
assert.deepEqual(sendTo(twoApprovers, 'parallel').map((r) => r.id), [6], 'only approvers still to answer');

// Delegation: the handed-off row is closed; the new one holds the place.
const handed = { ...seller, status: 'delegated' };
const delegate = { id: 7, sort: 1, status: 'pending', recipient_type: 'signer' };
const afterHandoff = [handed, delegate, company, tc];
assert.deepEqual(pending(afterHandoff).map((r) => r.id), [7, 2]);
assert.deepEqual(turn(afterHandoff, 'sequential').map((r) => r.id), [7]);
assert.equal(allSigned([handed, { ...delegate, status: 'signed' }, { ...company, status: 'signed' }]), true);
assert.deepEqual(sendTo([{ ...lender, status: 'delegated' }, company], 'parallel').map((r) => r.id), [2], 'a delegated viewer gets nothing');

assert.deepEqual(ccAddresses([{ email: 'TC@Home.com', recipient_type: 'cc' }, { email: 'tc@home.com', recipient_type: 'cc' }, { email: 'seller@x.com', recipient_type: 'signer' }]), ['tc@home.com']);
const copied = appendTcCc([{ email: 'seller@x.com', role: 'seller' }], [{ email: 'Casey@home.com', name: 'Casey' }]);
assert.equal(copied.length, 2);
assert.equal((copied[1] as { email?: string }).email, 'casey@home.com');
assert.equal((copied[1] as { recipient_type?: string }).recipient_type, 'cc');
assert.equal(appendTcCc(copied, [{ email: 'casey@home.com', name: 'Casey' }]).length, 2, 'already on the contract is not added twice');

console.log('signing-order ok');
