// supabase/functions/_shared/talkr-elsewhere.ts: another workspace's calls and texts stay out of this one.
// Run with:  npx tsx tools/talkr-elsewhere.test.ts
import {
  NOWHERE_ELSE, conversationElsewhere, elsewhereFromRows, elsewhereIds, homeFor, keepConversations, keepHistory, phoneKey, theirNumber,
} from '../supabase/functions/_shared/talkr-elsewhere';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), { got, want });

// settings.talkr.elsewhere
same('reads the ids', elsewhereIds({ talkr: { org_id: 'x', elsewhere: [13] } }, 11), [13]);
same('accepts numeric strings, drops junk and duplicates', elsewhereIds({ talkr: { elsewhere: ['13', 13, 'compr', 0, -2, 1.5] } }, 11), [13]);
same('never the workspace itself', elsewhereIds({ talkr: { elsewhere: [11, 13] } }, 11), [13]);
same('nothing set is nothing', elsewhereIds({ talkr: { enabled: true } }, 11), []);
same('no settings at all', elsewhereIds(null), []);
same('not an array', elsewhereIds({ talkr: { elsewhere: 13 } }), []);

// phone keys match public.normalize_phone
same('bare US number', phoneKey('(213) 555-0516'), '+12135550516');
same('11-digit US', phoneKey('12135550516'), '+12135550516');
same('international kept', phoneKey('+201026949614'), '+201026949614');
same('too short is nothing', phoneKey('5551'), null);
same('outbound: who was dialled', theirNumber({ direction: 'outbound', from_number: '+12105550385', to_number: '+12135550516' }), '+12135550516');
same('inbound: who rang in', theirNumber({ direction: 'inbound', from_number: '+12135550516', to_number: '+12105550385' }), '+12135550516');

// talkr_elsewhere rows
const away = elsewhereFromRows([
  { kind: 'number', key: '+19175550483', workspace_id: 13 }, // a Compr-only buyer
  { kind: 'source', key: 'msg:a1b2c3d4', workspace_id: 13 }, // a text to Dana, filed in Compr
  { kind: 'source', key: 'call:filed-in-13', workspace_id: 13 },
  { kind: 'number', key: '', workspace_id: 13 },
  { kind: 'other', key: '+1', workspace_id: 13 },
]);
same('rows split into numbers and ids', [[...away.numbers], [...away.sources]], [[['+19175550483', 13]], [['msg:a1b2c3d4', 13], ['call:filed-in-13', 13]]]);

// Where a mirrored call or text goes
same('a Compr-only number goes to Compr', homeFor({ sourceId: 'call:a', their: '+19175550483', away }), 13);
same('someone who is a contact here stays here', homeFor({ sourceId: 'call:b', their: '+12135550516', away }), 'here');
same('a text Compr already filed goes to Compr, even to a seller here', homeFor({ sourceId: 'msg:a1b2c3d4', their: '+12135550516', away }), 13);
same('filed in Compr wins over a mirror copy filed here', homeFor({ sourceId: 'call:filed-in-13', their: '+12135550516', filedHere: true, away }), 13);
same('filed here and not in Compr stays here', homeFor({ sourceId: 'call:c', their: '+19175550483', filedHere: true, away }), 'here');
same('no number, no id: here', homeFor({ sourceId: 'call:d', their: null, away }), 'here');
same('nothing configured: here', homeFor({ sourceId: 'msg:a1b2c3d4', their: '+19175550483', away: NOWHERE_ELSE }), 'here');

// Inbox and dialer lists
const convs = [
  { id: 'c1', their_number: '+19175550483' },
  { id: 'c2', their_number: '(213) 555-0516' },
  { id: 'c3', their_number: '9175550483' },
];
check('a thread owned by the other workspace is elsewhere', conversationElsewhere(convs[0], away));
same("the Inbox keeps this workspace's threads, in any format", keepConversations(convs, away).map((c) => c.id), ['c2']);
same('nothing configured keeps every thread', keepConversations(convs, NOWHERE_ELSE).map((c) => c.id), ['c1', 'c2', 'c3']);
const calls = [
  { id: 'a', kind: 'call', direction: 'outbound', from_number: '+12105550752', to_number: '+19175550483' },
  { id: 'filed-in-13', kind: 'call', direction: 'outbound', from_number: '+12105550125', to_number: '+12135550516' },
  { id: 'b', kind: 'call', direction: 'inbound', from_number: '+12135550516', to_number: '+12105550385' },
  { id: 'a1b2c3d4', kind: 'sms', direction: 'outbound', from_number: '+12105550125', to_number: '+12135550516' },
];
same('call history drops Compr calls by number and by id', keepHistory(calls, away).map((h) => h.id), ['b']);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
