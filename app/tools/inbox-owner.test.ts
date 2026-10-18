// lib/inbox-owner.ts: whose inbox a thread or call is in, and the switcher's options.
// Run with:  npx tsx tools/inbox-owner.test.ts
import {
  EVERYONE, UNASSIGNED, callOwner, eventTouches, inInbox, lineOwners, linesFor, mergeOwnerThreads, ownerChoices, ownerTitle, threadOwner, unreadThreads,
} from '../lib/inbox-owner';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const LINES = [
  { id: 'n1', phone_e164: '+12105550400', assigned_user_id: 'taylor' },
  { id: 'n2', phone_e164: '+17135550401', assigned_user_id: 'diego' },
  { id: 'n3', phone_e164: '+15125550402', assigned_user_id: null, label: 'Main' },
];
const owners = lineOwners(LINES);

// ---- threads ----
check('a thread on my line is mine', threadOwner({ our_number: '+12105550400', assigned_user_id: null }, owners) === 'taylor');
check('the line wins over the assignee', threadOwner({ our_number: '+12105550400', assigned_user_id: 'diego' }, owners) === 'taylor');
check('a shared line goes to the assignee', threadOwner({ our_number: '+15125550402', assigned_user_id: 'diego' }, owners) === 'diego');
check('a shared line with nobody assigned is unowned', threadOwner({ our_number: '+15125550402', assigned_user_id: null }, owners) === null);
check('formatting does not matter', threadOwner({ our_number: '(210) 555-0400', assigned_user_id: null }, owners) === 'taylor');
check('a line the org no longer has goes to the assignee', threadOwner({ our_number: '+19995550000', assigned_user_id: 'morgan' }, owners) === 'morgan');

// ---- calls ----
check('a call is whoever handled it', callOwner({ direction: 'inbound', user_id: 'diego', from_number: '+1', to_number: '+12105550400' }, owners) === 'diego');
check('a missed call is the owner of the line it rang', callOwner({ direction: 'inbound', user_id: null, from_number: '+18175550117', to_number: '+12105550400' }, owners) === 'taylor');
check('an outbound call with no user is the owner of the line it left from', callOwner({ direction: 'outbound', user_id: null, from_number: '+17135550401', to_number: '+18175550117' }, owners) === 'diego');
check('a voicemail on the main line is unowned', callOwner({ direction: 'inbound', user_id: null, from_number: '+1', to_number: '+15125550402' }, owners) === null);

// ---- which inbox ----
check('mine in my inbox', inInbox('taylor', 'me', 'taylor'));
check('a teammate’s not in mine', !inInbox('diego', 'me', 'taylor'));
check('a teammate’s in theirs', inInbox('diego', 'diego', 'taylor'));
check('mine not in a teammate’s', !inInbox('taylor', 'diego', 'taylor'));
check('unowned only under Unassigned', inInbox(null, UNASSIGNED, 'taylor') && !inInbox(null, 'me', 'taylor'));
check('nothing is mine before Talkr says who I am', !inInbox(null, 'me', null) && !inInbox('taylor', 'me', null));
check('my lines', linesFor('me', 'taylor', LINES).map((l) => l.id).join() === 'n1');
check('a teammate’s lines', linesFor('diego', 'taylor', LINES).map((l) => l.id).join() === 'n2');
check('the shared lines', linesFor(UNASSIGNED, 'taylor', LINES).map((l) => l.id).join() === 'n3');
check('no lines before Talkr says who I am', linesFor('me', null, LINES).length === 0);

// ---- merging the per-line reads ----
const t = (id: string, our: string, at: string, unread = 0, assigned: string | null = null, temp: number | null = null) =>
  ({ id, our_number: our, assigned_user_id: assigned, last_message_at: at, unread_count: unread, temperature_score: temp });
const byLine = [t('a', '+12105550400', '2026-10-14T10:00:00Z'), t('b', '+12105550400', '2026-10-14T12:00:00Z', 2)];
const byUser = [t('b', '+12105550400', '2026-10-14T12:00:00Z', 2), t('c', '+15125550402', '2026-10-14T11:00:00Z', 0, 'taylor', 90), t('d', '+17135550401', '2026-10-14T13:00:00Z', 1, 'taylor')];
const merged = mergeOwnerThreads([byLine, byUser], 'me', 'taylor', owners);
check('each thread once, newest first, a teammate’s line dropped', merged.map((c) => c.id).join() === 'b,c,a', merged.map((c) => c.id));
check('oldest first', mergeOwnerThreads([byLine, byUser], 'me', 'taylor', owners, 'oldest').map((c) => c.id).join() === 'a,c,b');
check('unread first', mergeOwnerThreads([byLine, byUser], 'me', 'taylor', owners, 'unread')[0]!.id === 'b');
check('hottest first', mergeOwnerThreads([byLine, byUser], 'me', 'taylor', owners, 'temperature')[0]!.id === 'c');
check('the teammate gets the thread on their line', mergeOwnerThreads([byUser], 'diego', 'taylor', owners).map((c) => c.id).join() === 'd');
check('unread counts only the inbox shown', unreadThreads(merged) === 1);

// ---- live events ----
const onScreen = new Set(['b']);
const mine = linesFor('me', 'taylor', LINES);
check('an event naming me re-reads', eventTouches({ userIds: ['taylor'], numbers: [], conversationId: null }, 'me', 'taylor', mine, onScreen));
check('an event on my line re-reads', eventTouches({ userIds: [], numbers: ['2105550400'], conversationId: null }, 'me', 'taylor', mine, onScreen));
check('an event on a thread on screen re-reads', eventTouches({ userIds: [], numbers: [], conversationId: 'b' }, 'me', 'taylor', mine, onScreen));
check('a teammate’s call does not', !eventTouches({ userIds: ['diego'], numbers: ['7135550401'], conversationId: 'zz' }, 'me', 'taylor', mine, onScreen));
// Talkr's real text events: { conversationId, messageId } and nothing else (apps/server/src/services/messages.ts).
const bare = { userIds: [], numbers: [], conversationId: 'new1' };
check('a first text on a thread not listed re-reads', eventTouches(bare, 'me', 'taylor', mine, onScreen, 'message.received'));
check('…and so does a send that opened one', eventTouches(bare, 'me', 'taylor', mine, onScreen, 'conversation.updated'));
check('a receipt on a thread not listed does not', !eventTouches(bare, 'me', 'taylor', mine, onScreen, 'message.updated'));
check('a call event with no thread does not', !eventTouches({ userIds: [], numbers: [], conversationId: null }, 'me', 'taylor', mine, new Set(), 'call.updated'));
check('a text that names a teammate does not', !eventTouches({ userIds: ['diego'], numbers: [], conversationId: 'new1' }, 'me', 'taylor', mine, onScreen, 'message.received'));
check('…unless their inbox is the one shown', eventTouches({ userIds: ['diego'], numbers: [], conversationId: null }, 'diego', 'taylor', linesFor('diego', 'taylor', LINES), new Set()));

// ---- the switcher ----
const team = [
  { id: 'taylor', display_name: 'Taylor Reed', is_self: true },
  { id: 'sam', display_name: 'Sam Carter' },
  { id: 'diego', display_name: 'Diego Ortiz' },
];
const choices = ownerChoices('taylor', team, LINES);
check('my inbox first, teammates by name, shared lines, then everyone', choices.map((c) => c.value).join() === `me,diego,sam,unassigned,${EVERYONE}`, choices);
check('everyone is the last option', choices[choices.length - 1].label === 'Everyone');
check('alone on the team: no everyone option', !ownerChoices('taylor', [team[0]], LINES.slice(0, 2)).some((c) => c.value === EVERYONE));
check('no shared lines, no Unassigned', !ownerChoices('taylor', team, LINES.slice(0, 2)).some((c) => c.value === UNASSIGNED));
check('titles', ownerTitle('me', choices) === 'My inbox' && ownerTitle('diego', choices) === 'Diego Ortiz’s inbox' && ownerTitle(UNASSIGNED, choices) === 'Unassigned lines' && ownerTitle(EVERYONE, choices) === 'Everyone');

// ---- everyone ----
check('everyone keeps a teammate’s thread', inInbox('diego', EVERYONE, 'taylor'));
check('everyone keeps a thread on a shared line nobody is assigned', inInbox(null, EVERYONE, 'taylor'));
check('everyone reads every line', linesFor(EVERYONE, 'taylor', LINES).length === LINES.length);
check('any event re-reads everyone’s inbox', eventTouches({ userIds: ['diego'], numbers: [], conversationId: null }, EVERYONE, 'taylor', LINES, new Set(), 'call.updated'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
