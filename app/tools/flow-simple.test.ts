import assert from 'node:assert/strict';
import { DEFAULT_FLOW_SETTINGS, DEFAULT_SIMPLE_HOURS, describeSimple, fromFlow, simpleFlowError, starterFlow, toFlowDto, type SimpleFlow } from '../app/components/phone/flow-simple';
import type { CallFlowDto } from '../lib/talkr';

const morgan = { kind: 'user' as const, user_id: 't' };
const casey = { kind: 'user' as const, user_id: 'w' };

// Round trip: every simple shape comes back as itself.
const shapes: SimpleFlow[] = [
  starterFlow([morgan], 't'),
  { hours: DEFAULT_SIMPLE_HOURS, ring: { strategy: 'sequential', targets: [morgan, casey], timeout_seconds: 25 }, forward: null, voicemail_user_id: null },
  { hours: null, ring: { strategy: 'round_robin', targets: [{ kind: 'everyone' }], timeout_seconds: 15 }, forward: { e164: '+12105550100', timeout_seconds: 25 }, voicemail_user_id: 'w' },
];
for (const s of shapes) {
  const dto = toFlowDto(s, { ...DEFAULT_FLOW_SETTINGS, recording: false });
  assert.equal(dto.version, 2);
  assert.equal(dto.recording, false);
  assert.deepEqual(fromFlow(dto), s);
}

// Starter with nobody rings everyone.
assert.deepEqual(starterFlow([], null).ring.targets, [{ kind: 'everyone' }]);

// Anything richer than the simple shape opens in the full editor.
const menu: CallFlowDto = { version: 2, ...DEFAULT_FLOW_SETTINGS, start: 'm', nodes: { m: { type: 'menu', greeting: { tts: 'Press 1' }, options: { '1': null }, timeout_seconds: 6, repeat: 1, no_input: null } } };
assert.equal(fromFlow(menu), null);
assert.equal(fromFlow(null), null);
const greeted = toFlowDto(shapes[0]!, DEFAULT_FLOW_SETTINGS);
(greeted.nodes.vm as { greeting: unknown }).greeting = { tts: 'Leave a message' };
assert.equal(fromFlow(greeted), null);
const busy = toFlowDto(shapes[0]!, DEFAULT_FLOW_SETTINGS);
(busy.nodes.ring as { busy?: string | null }).busy = null;
assert.equal(fromFlow(busy), null);

// Validation.
assert.equal(simpleFlowError(shapes[0]!), null);
assert.equal(simpleFlowError({ ...shapes[0]!, ring: { ...shapes[0]!.ring, targets: [] } }), 'Pick who it rings');
assert.equal(simpleFlowError({ ...shapes[0]!, forward: { e164: '555', timeout_seconds: 20 } }), 'Enter the forward number in full');
assert.equal(simpleFlowError({ ...shapes[0]!, hours: { ...DEFAULT_SIMPLE_HOURS, schedule: {} } }), 'Open at least one day, or turn business hours off');

// Summary.
const name = (t: { kind: string; user_id?: string }) => (t.kind === 'user' ? (t.user_id === 't' ? 'Morgan' : 'Casey') : 'Everyone');
assert.equal(describeSimple(shapes[1]!, name), 'Hours → Ring Morgan, Casey in order · 25s → Voicemail');
assert.equal(describeSimple(shapes[2]!, name), 'Ring Everyone round-robin · 15s → Forward → Voicemail');

console.log('flow-simple ok');
