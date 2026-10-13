import { outcomeSummary } from '../lib/call-outcome-write';
import { eventFacts } from '../lib/talkr-events';
import { heartbeatStatus } from '../lib/talkr-presence';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

// One line per call: outcome, then the note, as the Talkr mirror writes it.
eq('outcome and note', outcomeSummary('Interested', 'wants 240 by spring'), 'Interested — wants 240 by spring');
eq('outcome only', outcomeSummary('No answer', null), 'No answer');
eq('note only', outcomeSummary(null, 'call back Tue'), 'Call note — call back Tue');
eq('outcome after a note keeps the note', outcomeSummary('Interested', null, outcomeSummary(null, 'call back Tue')), 'Interested — call back Tue');
eq('nothing', outcomeSummary(null, '  '), null);
eq('note keeps the mirror label', outcomeSummary(null, 'call back Tue', 'Callback'), 'Callback — call back Tue');
eq('outcome keeps the note', outcomeSummary('Appointment set', null, 'Callback — call back Tue'), 'Appointment set — call back Tue');
eq('same write twice is the same line', outcomeSummary('Interested', 'hot', outcomeSummary('Interested', 'hot')), 'Interested — hot');
eq('new note replaces the old', outcomeSummary(null, 'second', 'Interested — first'), 'Interested — second');

// What an event is about, wherever Talkr put the ids.
eq('facts nested', eventFacts({ type: 'message.received', data: { data: { conversationId: 'c1', userId: 'u1', to: '+1 (210) 555-0100' } } }),
  { userIds: ['u1'], conversationId: 'c1', callId: null, sessionId: null, numbers: ['2105550100'] });
eq('facts top level', eventFacts({ type: 'call.updated', data: { callId: 'k9', assignedUserId: 'u2', sessionId: 's3' } }),
  { userIds: ['u2'], conversationId: null, callId: 'k9', sessionId: 's3', numbers: [] });
eq('facts unreadable', eventFacts({ type: 'call.updated', data: null }),
  { userIds: [], conversationId: null, callId: null, sessionId: null, numbers: [] });

// Presence: the heartbeat never says Available over Away or Do not disturb.
eq('available and ready', heartbeatStatus('available', true), 'available');
eq('available, phone down', heartbeatStatus('available', false), 'away');
eq('dnd', heartbeatStatus('dnd', true), 'away');
eq('away', heartbeatStatus('away', true), 'away');
