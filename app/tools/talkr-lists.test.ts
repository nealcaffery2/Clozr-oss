// A re-read of Talkr's lists that changed nothing keeps the same phone data.
// Run: npx tsx tools/talkr-lists.test.ts
import { foldLists, sameRows, type PhoneLists } from '../lib/talkr-lists';
import type { CallDto, ConversationDto, HistoryItemDto } from '../lib/talkr';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const conv = (id: string, at: string, unread = 0): ConversationDto => ({
  id, our_number: '+12105550100', their_number: '+12105550111', contact_id: null, lead_id: null, contact_name: null,
  assigned_user_id: null, assigned_user_name: null, last_message_at: at,
  last_message: { direction: 'inbound', body: 'hi', media_count: 0, status: 'received' }, unread_count: unread, temperature: null, tags: [],
});
const call = (id: string, status: string, dur: number | null = null): CallDto => ({
  id, direction: 'outbound', status, user_id: 'u', lead_id: null, contact_id: null, from_number: '+1', to_number: '+2',
  answered_at: null, ended_at: null, duration_seconds: dur, disposition_id: null, contact_name: null, created_at: '2026-10-14T10:00:00Z',
});
const hist = (id: string, status: string, label: string | null = null): HistoryItemDto => ({
  kind: 'call', id, direction: 'outbound', status, at: '2026-10-14T10:00:00Z', duration_seconds: null, from_number: '+1', to_number: '+2',
  contact_name: null, user_name: null, disposition_label: label, note: null, has_recording: false, body: null, conversation_id: null,
});

type Data = PhoneLists & { status: string };
const base: Data = {
  status: 'ok',
  convs: [conv('c1', '2026-10-14T10:00:00Z', 1), conv('c2', '2026-10-14T09:00:00Z')],
  unread: 1,
  recent: [call('k1', 'completed', 40), call('k2', 'no_answer')],
  history: [hist('h1', 'completed')],
};
// The same rows as fresh objects, as a re-read hands them back.
const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

eq('same rows', sameRows(base.recent, copy(base.recent)), true);
eq('a different length', sameRows(base.recent, base.recent.slice(1)), false);
eq('a status moved', sameRows(base.recent, [call('k1', 'in_progress', 40), call('k2', 'no_answer')]), false);
eq('reordered', sameRows(base.recent, [base.recent[1]!, base.recent[0]!]), false);

const fresh = { convs: copy(base.convs), unread: 1, recent: copy(base.recent), history: copy(base.history) };
eq('nothing changed: the same object back', foldLists(base, fresh) === base, true);
eq('every list failed to read: the same object back', foldLists(base, {}) === base, true);

const newText = foldLists(base, { ...fresh, convs: [conv('c1', '2026-10-14T11:00:00Z', 2), conv('c2', '2026-10-14T09:00:00Z')], unread: 2 });
eq('a new text: a new object', newText === base, false);
eq('its threads and unread move', [newText.convs[0]!.last_message_at, newText.unread], ['2026-10-14T11:00:00Z', 2]);
eq('the calls that did not move keep their identity', [newText.recent === base.recent, newText.history === base.history], [true, true]);

const ended = foldLists(base, { ...fresh, recent: [call('k3', 'completed', 12), ...copy(base.recent)] });
eq('a new call: Recent moves', ended.recent.map((c) => c.id), ['k3', 'k1', 'k2']);
eq('threads keep their identity', ended.convs === base.convs, true);

const dispo = foldLists(base, { ...fresh, history: [hist('h1', 'completed', 'Callback')] });
eq('a disposition landing on a history row is a change', dispo.history[0]!.disposition_label, 'Callback');

const unreadOnly = foldLists(base, { ...fresh, unread: 0 });
eq('only the unread count moved', [unreadOnly === base, unreadOnly.unread, unreadOnly.convs === base.convs], [false, 0, true]);

eq('other fields ride along untouched', foldLists(base, { ...fresh, unread: 3 }).status, 'ok');

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
