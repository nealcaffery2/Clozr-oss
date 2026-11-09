// lib/inbox-reply.ts: which reply box a thread opened on the Inbox's All tab gets.
// Run with:  npx tsx tools/inbox-reply.test.ts
import { allReplyFor, headerTextLabel, openInLabel } from '../lib/inbox-reply';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const text = { kind: 'sms' as const, convId: 'c1', phone: '+15125550134' };
const mail = { kind: 'email' as const, thread: { key: 't1' }, phone: null };
const mailWithPhone = { ...mail, phone: '+15125550134' };
const call = { kind: 'call' as const, phone: '+15125550134' };

check('a text thread gets the SMS tab composer', allReplyFor(text) === 'sms');
check('an email thread gets the Email tab composer', allReplyFor(mail) === 'email');
check('a call gets no inline composer', allReplyFor(call) === null);
check('a voicemail with no number gets none either', allReplyFor({ kind: 'call', phone: null }) === null);
check('a text row without a Talkr conversation has no inline composer', allReplyFor({ kind: 'sms', phone: '+15125550134' }) === null);
check('an email row without its thread has no inline composer', allReplyFor({ kind: 'email', phone: null }) === null);

check('no header Text button over the SMS composer', headerTextLabel(text) === null);
check('a text row Talkr gave no id still offers Reply', headerTextLabel({ kind: 'sms', phone: '+15125550134' }) === 'Reply');
check('an email from a contact with a number offers Text', headerTextLabel(mailWithPhone) === 'Text');
check('an email with no number offers no Text', headerTextLabel(mail) === null);
check('a call keeps its Text button', headerTextLabel(call) === 'Text');
check('a call with no number has none', headerTextLabel({ kind: 'call', phone: null }) === null);

check('the More menu names the tab', openInLabel('sms') === 'Open in SMS' && openInLabel('email') === 'Open in Email' && openInLabel('call') === 'Open in Calls');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
