// lib/talkr-events.ts: what an event says about a text, so a reply draws the moment it arrives.
// Run with:  npx tsx tools/talkr-events.test.ts
import { eventFacts, messageFromEvent, withEventMessage } from '../lib/talkr-events';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

// The message nested under `message`, ids beside it.
const nested = { type: 'message.received', data: { conversationId: 'c1', userId: 'u1', message: { id: 'm9', direction: 'inbound', body: 'Can you do 190?', created_at: '2026-10-14T19:00:00Z' } } };
const m = messageFromEvent(nested);
check('a nested message is read', m?.id === 'm9' && m.conversation_id === 'c1' && m.direction === 'inbound' && m.body === 'Can you do 190?', m);
check('…and its status defaults to received', m?.status === 'received');

// Under the bus envelope's own `data`.
const enveloped = { type: 'message.received', data: { type: 'message.received', data: { conversation_id: 'c2', message: { id: 'm1', body: 'Yes', media_urls: [] } } } };
const e2 = messageFromEvent(enveloped);
check('an enveloped message is read, inbound from the event type', e2?.id === 'm1' && e2.conversation_id === 'c2' && e2.direction === 'inbound', e2);

// Flat: the event is the message.
const flat = { type: 'message.received', data: { id: 'm2', conversation_id: 'c3', direction: 'inbound', body: 'Hi' } };
check('a flat message is read', messageFromEvent(flat)?.id === 'm2');

// A photo with no words is still a message.
const photo = { type: 'message.received', data: { conversationId: 'c4', message: { id: 'm3', media_urls: ['https://x/y.jpg'] } } };
check('an MMS with no words is a message', messageFromEvent(photo)?.media_urls.length === 1);

// Nudges and receipts carry no message.
check('a bare nudge is not', messageFromEvent({ type: 'conversation.updated', data: { conversationId: 'c1' } }) === null);
check('a receipt with no body is not', messageFromEvent({ type: 'message.updated', data: { conversationId: 'c1', message: { id: 'm9', status: 'delivered' } } }) === null);
check('a message with no thread is not', messageFromEvent({ type: 'message.received', data: { message: { id: 'm9', body: 'x' } } }) === null);
check('an unreadable event is not', messageFromEvent({ type: 'message.received', data: null }) === null);
check('an updated message with no direction is not guessed', messageFromEvent({ type: 'message.updated', data: { conversationId: 'c1', message: { id: 'm9', body: 'x' } } }) === null);

// Folding into the open thread.
const list = [
  { id: 'a', created_at: '2026-10-14T18:00:00Z', sent_at: null },
  { id: 'b', created_at: '2026-10-14T19:30:00Z', sent_at: null },
];
const make = (x: NonNullable<typeof m>) => ({ id: x.id, created_at: x.created_at, sent_at: x.sent_at });
const folded = withEventMessage(list, m, 'c1', make);
check('the reply lands in time order', folded.map((x) => x.id).join() === 'a,m9,b', folded.map((x) => x.id));
check('another thread’s reply is ignored', withEventMessage(list, m, 'c2', make) === list);
check('a reply already there is not doubled', withEventMessage([...list, { id: 'm9', created_at: 'x', sent_at: null }], m, 'c1', make).length === 3);
check('nothing open, nothing added', withEventMessage(list, m, null, make) === list);

// eventFacts still reads the same ids.
const f = eventFacts(nested);
check('eventFacts reads the thread and the rep', f.conversationId === 'c1' && f.userIds.includes('u1'), f);

// What Talkr's stream sends today (packages/db/src/event-bus.ts): the bus event as-is.
const real = { type: 'message.received', data: { type: 'message.received', orgId: 'o1', data: { conversationId: 'c9', messageId: 'm7' } } };
const rf = eventFacts(real);
check('a real bus event names its thread and nobody else', rf.conversationId === 'c9' && !rf.userIds.length && !rf.numbers.length, rf);
check('…and carries no message to draw', messageFromEvent(real) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
