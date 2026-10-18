// lib/sms-receipt.ts: a text stuck in queued or sending stops saying "Sending…" after ten minutes.
// Run with:  npx tsx tools/sms-receipt.test.ts
import { SENDING_STALE_MS, smsPending, smsReceiptLabel, smsShownStatus } from '../lib/sms-receipt';

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
check('a failure is never hidden', smsReceiptLabel('failed', ago(60 * 60_000), now) === 'Not delivered');
check('no time to go on keeps it sending', smsReceiptLabel('sending', null, now) === 'Sending…');
check('an unknown status is shown as it is', smsReceiptLabel('accepted', ago(0), now) === 'accepted');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
