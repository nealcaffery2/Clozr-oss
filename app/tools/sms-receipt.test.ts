// lib/sms-receipt.ts: the iPhone receipt line under a sent text. A text stuck in
// queued or sending stops saying "Sending…" after ten minutes; "Read" shows only
// when the status says read; the status never moves back.
// Run with:  npx tsx tools/sms-receipt.test.ts
import {
  SENDING_STALE_MS, readStamp, smsLaterStatus, smsPending, smsReceipt, smsReceiptLabel, smsShownStatus, smsStatusRank,
} from '../lib/sms-receipt';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const now = Date.parse('2026-10-14T18:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

check('a text sent a minute ago is still sending', smsReceiptLabel('sending', ago(60_000), now) === 'Sending…');
check('…and drawn as pending', smsPending('queued', ago(60_000), now));
check('a text queued 11 minutes ago reads Sent', smsReceiptLabel('queued', ago(11 * 60_000), now) === 'Sent');
check('…and is not drawn as pending', !smsPending('queued', ago(11 * 60_000), now));
check('…its shown status is sent', smsShownStatus('sending', ago(SENDING_STALE_MS), now) === 'sent');
check('a real receipt wins', smsReceiptLabel('delivered', ago(60 * 60_000), now) === 'Delivered');
check('a failure is never hidden', smsReceiptLabel('failed', ago(60 * 60_000), now) === 'Not Delivered');
check('undelivered reads the same', smsReceiptLabel('undelivered', ago(60 * 60_000), now) === 'Not Delivered');
check('no time to go on keeps it sending', smsReceiptLabel('sending', null, now) === 'Sending…');
check('an unknown status is shown as it is', smsReceiptLabel('accepted', ago(0), now) === 'accepted');

// Read: local times, so the day math matches the machine's zone.
const local = new Date(2026, 9, 21, 15, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const label = (readAt: string | null, status = 'read') => smsReceiptLabel(status, at(21, 9), local, readAt);
check('read today shows the time', label(at(21, 14, 14)) === 'Read 2:14 PM', label(at(21, 14, 14)));
check('read yesterday', label(at(20, 22)) === 'Read Yesterday', label(at(20, 22)));
check('read this week shows the weekday', label(at(17, 10)) === 'Read Saturday', label(at(17, 10)));
check('read long ago shows the date', label(at(2, 10)) === 'Read 10/2/26', label(at(2, 10)));
check('read with no time says Read', label(null) === 'Read');
check('read_at alone never makes a delivered text Read', label(at(21, 10), 'delivered') === 'Delivered');
check('a bad read time is no time', readStamp('nope', local) === null);
const r = smsReceipt('read', at(21, 9), at(21, 14, 14), local);
check('receipt parts for read', r.word === 'Read' && r.time === '2:14 PM' && !r.failed, r);
const f = smsReceipt('failed', at(21, 9), null, local);
check('receipt parts for a failure', f.word === 'Not Delivered' && f.time === null && f.failed, f);

// Rank: mirrors comm_status_rank (migration 398).
check('read outranks delivered', smsStatusRank('read') > smsStatusRank('delivered'));
check('read outranks a failure', smsStatusRank('read') > smsStatusRank('failed'));
check('delivered outranks sent, sent outranks sending', smsStatusRank('delivered') > smsStatusRank('sent') && smsStatusRank('sent') > smsStatusRank('sending'));
check('rank ignores case', smsStatusRank('READ') === 5);
check('an unknown status ranks 0', smsStatusRank('received') === 0);
check('a late delivered does not undo read', smsLaterStatus('read', 'delivered') === 'read');
check('read lands on delivered', smsLaterStatus('delivered', 'read') === 'read');
check('a late sent does not undo delivered', smsLaterStatus('delivered', 'sent') === 'delivered');
check('no new status keeps the old', smsLaterStatus('sent', null) === 'sent');
check('a first status lands', smsLaterStatus(null, 'queued') === 'queued');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
