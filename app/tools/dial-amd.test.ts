// Answering machines on a browser-placed session call: the machine verdict
// read off Talkr's stream, and what the session does with it.
// Run: npx tsx tools/dial-amd.test.ts
import assert from 'node:assert/strict';
import { MACHINE_HANGUP_EVENT, VM_DROPPED_EVENT, afterVmDrop, isMachineAnsweredBy, lineEvent, lineFromLabel, lineStateLabel, machineFromEvent, nextLineState, onMachine } from '../lib/power-dialer';

// ---- Talkr's verdicts
assert.equal(isMachineAnsweredBy('machine_end_beep'), true);
assert.equal(isMachineAnsweredBy('machine_start'), true);
assert.equal(isMachineAnsweredBy('fax'), true);
assert.equal(isMachineAnsweredBy('machine'), true, 'Telnyx plain verdict');
assert.equal(isMachineAnsweredBy('human'), false);
assert.equal(isMachineAnsweredBy('unknown'), false);
assert.equal(isMachineAnsweredBy(null), false);

// ---- reading the stream
const live = 'call-1';
assert.equal(machineFromEvent({ type: 'call.updated', data: { callId: live, status: 'answered', answeredBy: 'machine_end_beep' } }, live), 'machine_end_beep', 'answeredBy beside status on call.updated');
assert.equal(machineFromEvent({ type: 'call.amd', data: { callId: live, answeredBy: 'machine_start' } }, live), 'machine_start', 'a dedicated call.amd event');
assert.equal(machineFromEvent({ type: 'call.updated', data: { data: { call_id: live, amdResult: 'machine_end_silence' } } }, live), 'machine_end_silence', 'under data, snake_case, raw.amdResult spelling');
assert.equal(machineFromEvent({ type: 'call.updated', data: { callId: live, status: 'answered', answeredBy: 'human' } }, live), null, 'a person is not a machine');
assert.equal(machineFromEvent({ type: 'call.updated', data: { callId: live, status: 'answered' } }, live), null, 'no verdict, no machine');
assert.equal(machineFromEvent({ type: 'call.updated', data: { callId: 'call-2', answeredBy: 'machine_end_beep' } }, live), null, "a teammate's machine is not ours");
assert.equal(machineFromEvent({ type: 'call.updated', data: { callId: live, answeredBy: 'machine_end_beep' } }, null), null, 'no live call, nothing to act on');
assert.equal(machineFromEvent({ type: 'message.received', data: { callId: live, answeredBy: 'machine_end_beep' } }, live), null, 'only call events');
assert.equal(machineFromEvent({ type: 'call.updated', data: null }, live), null, 'an unreadable body');

// ---- the transitions: machine -> drop -> advance; machine, no clip -> hang up -> advance
assert.equal(onMachine({ running: true, clipId: 7 }), 'drop', 'a clip picked in the setup sheet drops');
assert.equal(onMachine({ running: true, clipId: null }), 'hangup', 'no clip: hang up and move on');
assert.equal(onMachine({ running: false, clipId: 7 }), 'none', 'outside a session the rep decides');
assert.equal(onMachine({ running: false, clipId: null }), 'none');
// The drop ends in clozr-vm-dropped and the hang-up in clozr-machine-hangup
// (lib/softphone.ts); both move a power or predictive session on.
assert.notEqual(VM_DROPPED_EVENT, MACHINE_HANGUP_EVENT);
assert.equal(afterVmDrop('power', true).advance, true, 'power dials on after a machine the session handled');
assert.equal(afterVmDrop('power').advance, false, 'a Drop VM tap in power still waits for Next');
assert.equal(afterVmDrop('predictive').advance, true);
assert.equal(afterVmDrop(null).advance, false, 'no session, no next call');



// ---- the lines panel: each parallel line read off the stream
assert.deepEqual(lineEvent({ type: 'call.updated', data: { callId: 'c1', status: 'ringing' } }), { callId: 'c1', state: 'ringing' });
assert.deepEqual(lineEvent({ type: 'call.updated', data: { data: { call_id: 'c1', status: 'in_progress' } } }), { callId: 'c1', state: 'talking' }, 'under data, snake_case');
assert.deepEqual(lineEvent({ type: 'session.updated', data: { sessionId: 's1', event: 'amd', callId: 'c2' } }), { callId: 'c2', state: 'machine' });
assert.deepEqual(lineEvent({ type: 'session.updated', data: { sessionId: 's1', event: 'abandoned', callId: 'c3' } }), { callId: 'c3', state: 'abandoned' });
assert.deepEqual(lineEvent({ type: 'session.updated', data: { sessionId: 's1', event: 'bridged', callId: 'c4' } }), { callId: 'c4', state: 'talking' }, 'the bridged line is the one the rep is on');
assert.equal(lineEvent({ type: 'session.updated', data: { sessionId: 's1', event: 'dialed', callIds: ['c1'] } }), null, 'a batch event names no single line');
assert.equal(lineEvent({ type: 'call.updated', data: { callId: 'c1', status: 'something_new' } }), null, 'an unknown status leaves the line alone');
assert.equal(lineEvent({ type: 'message.received', data: { callId: 'c1' } }), null);
assert.equal(nextLineState('machine', 'done'), 'machine', 'the hang-up after a machine keeps the machine verdict');
assert.equal(nextLineState('abandoned', 'done'), 'abandoned');
assert.equal(nextLineState('ringing', 'talking'), 'talking');
assert.equal(lineStateLabel('abandoned', true), 'Answered while you were busy, heard your recording');
assert.equal(lineStateLabel('machine', false), 'Machine, hung up');
console.log('dial-amd: ok');

// ---- power and predictive are both multi-line on Talkr; what the rep sees
{
  const { dialModeOf, dialModeLabel, isListCampaign, listCampaignName } = await import('../lib/power-dialer');
  assert.equal(dialModeOf('power', 'parallel'), 'power', 'what the rep picked wins over Talkr parallel');
  assert.equal(dialModeOf(null, 'parallel'), 'power', 'an adopted parallel session waits for Next');
  assert.equal(dialModeOf(null, 'progressive'), 'predictive');
  assert.equal(dialModeLabel('power', 3), 'Power · 3 lines');
  assert.equal(dialModeLabel('predictive', 1), 'Predictive · 1 line');
  assert.equal(isListCampaign(listCampaignName('Call queue')), true);
  assert.equal(isListCampaign('Cold leads Q4'), false);
}

// ---- which line a call went out on
{
  const org = [{ phone_e164: '+18645558051', label: 'Alex · Upstate SC' }, { phone_e164: '+12105558073', label: null }];
  const fmt = (s: string) => `(${s.slice(2, 5)}) ${s.slice(5, 8)}-${s.slice(8)}`;
  assert.equal(lineFromLabel('+18645558051', org, fmt), 'Alex · Upstate SC · (864) 555-8051', 'labelled line');
  assert.equal(lineFromLabel('+12105558073', org, fmt), '(210) 555-8073', 'a line with no label is just the number');
  assert.equal(lineFromLabel('+13145550100', org, fmt), '(314) 555-0100', 'a number the org does not list is shown as it came');
  assert.equal(lineFromLabel(null, org, fmt), null);
}
