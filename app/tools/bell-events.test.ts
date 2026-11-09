// Bell rows from communications. Run: npx tsx tools/bell-events.test.ts
import { bellFromComms, isMissedCall, phoneTail } from '../lib/bell-events';
import { ringSource, DEFAULT_AUDIO_PREFS } from '../lib/phone-audio';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const base = { party: 'Kara', time: '9:31 AM', preview: 'Call me', personId: 's1', ts: 10 };
eq('missed status', isMissedCall({ channel: 'call', dir: 'in', status: 'no_answer' }), true);
eq('answered has duration', isMissedCall({ channel: 'call', dir: 'in', status: 'completed', dur: '2m 0s' }), false);
eq('outbound is not a miss', isMissedCall({ channel: 'call', dir: 'out', status: 'no_answer' }), false);
eq('voicemail', isMissedCall({ channel: 'voicemail', dir: 'in' }), true);

const rows = bellFromComms([
  { ...base, id: 'c1', channel: 'call', dir: 'in', status: 'no_answer', ts: 30 },
  { ...base, id: 'c2', channel: 'sms', dir: 'in', preview: 'Can you call?', ts: 5 },
  // Older than both: they were before the call and the text, so neither is handled.
  { ...base, id: 'c3', channel: 'call', dir: 'out', status: 'completed', ts: 50 },
  { ...base, id: 'c4', channel: 'sms', dir: 'out', ts: 60 },
]);
eq('bell cats', rows.map((r) => r.cat), ['SMS', 'Call']);
eq('sms text', rows[0].text, 'Text from Kara — Can you call?');
eq('missed text', rows[1].text, 'Missed call from Kara');
eq('opens the person on Calls', rows[1].link, { screen: 'person', id: 's1', tab: 'Calls' });

// One row per person and kind, the newest, with how many.
const many = bellFromComms([
  { ...base, id: 't1', channel: 'sms', dir: 'in', preview: 'Hello?', ts: 40 },
  { ...base, id: 't2', channel: 'sms', dir: 'in', preview: 'Still there?', ts: 20 },
  { ...base, id: 't3', channel: 'sms', dir: 'in', preview: 'Call me', ts: 8 },
  { ...base, id: 'k1', channel: 'call', dir: 'in', status: 'no_answer', ts: 9 },
  { ...base, id: 'r1', personId: 's2', party: 'Ronald', channel: 'sms', dir: 'in', preview: 'Yes', ts: 3 },
]);
eq('collapsed rows', many.map((r) => r.id), ['bell-sms-r1', 'bell-sms-t3', 'bell-call-k1']);
eq('count in the text', many[1].text, '3 texts from Kara — Call me');
eq('count on the row', many[1].count, 3);
eq('one is not counted', many[0].count, undefined);

// Handled: anything out to them after it clears the row.
const handled = bellFromComms([
  { ...base, id: 'a1', channel: 'sms', dir: 'in', ts: 30 },
  { ...base, id: 'a2', channel: 'call', dir: 'in', status: 'no_answer', ts: 25 },
  { ...base, id: 'a3', channel: 'call', dir: 'out', status: 'completed', ts: 10 },
  { ...base, id: 'a4', channel: 'sms', dir: 'in', preview: 'Thanks', ts: 4 },
  { ...base, id: 'b1', personId: 's2', channel: 'sms', dir: 'in', ts: 12 },
  { ...base, id: 'b2', personId: 's2', channel: 'note', dir: 'out', ts: 2 },
]);
eq('only what came after the call back', handled.map((r) => r.id), ['bell-sms-a4', 'bell-sms-b1']);
eq('a note is not a reply', handled[1].id, 'bell-sms-b1');
eq('same minute: the timestamp decides', bellFromComms([
  { ...base, id: 'm1', channel: 'sms', dir: 'in', ts: 1, at: '2026-10-08T15:00:10Z' },
  { ...base, id: 'm2', channel: 'sms', dir: 'out', ts: 1, at: '2026-10-08T15:00:40Z' },
]).length, 0);
eq('the number rides along', bellFromComms([{ ...base, id: 'p1', channel: 'sms', dir: 'in', ts: 1, phone: '+15125550134' }])[0].phone, '+15125550134');
eq('phone tail', phoneTail('(512) 555-0134'), phoneTail('+15125550134'));
// Talkr closes an unanswered inbound call as "completed" with no talk time.
eq('completed with no talk time is missed', isMissedCall({ channel: 'call', dir: 'in', status: 'completed' }), true);
eq('completed with talk time is answered', isMissedCall({ channel: 'call', dir: 'in', status: 'completed', dur: '2:10' }), false);
// A caller with no record still rings the bell, keyed and cleared by number.
const stranger = bellFromComms([
  { ...base, id: 'n1', personId: undefined, channel: 'call', dir: 'in', status: 'missed', ts: 9, phone: '+12105550111' },
  { ...base, id: 'n2', personId: undefined, channel: 'voicemail', dir: 'in', ts: 3, phone: '+12105550199' },
  { ...base, id: 'n3', personId: undefined, channel: 'call', dir: 'out', status: 'completed', ts: 1, phone: '+12105550199' },
]);
eq('unknown caller missed call shows, called-back one clears', stranger.map((r) => [r.id, r.link.screen, r.link.id]), [['bell-call-n1', 'inboxSms', '+12105550111']]);
eq('voicemail says voicemail', bellFromComms([{ ...base, id: 'v1', channel: 'voicemail', dir: 'in', ts: 1 }])[0].text.startsWith('Voicemail from'), true);

eq('inbound default is a ringtone', ringSource(DEFAULT_AUDIO_PREFS).ringtone, 'marimba');
eq('outbound default is ringback', ringSource(DEFAULT_AUDIO_PREFS, true).ringtone, 'classic');
eq('outbound does not follow a custom incoming tone', ringSource({ ...DEFAULT_AUDIO_PREFS, ringtone: 'pulse' }, true).ringtone, 'classic');
eq('a chosen outbound tone is ignored', ringSource({ ...DEFAULT_AUDIO_PREFS, outgoingRingtone: 'marimba' }, true).ringtone, 'classic');
eq('an uploaded outbound MP3 is ignored', ringSource({ ...DEFAULT_AUDIO_PREFS, outgoingCustomRingtoneUrl: 'idb:x:ringback#1' }, true).url, null);
eq('old classic default rings inbound as a ringtone', ringSource({ ...DEFAULT_AUDIO_PREFS, ringtone: 'classic' }).ringtone, 'marimba');
eq('an explicit classic choice stays', ringSource({ ...DEFAULT_AUDIO_PREFS, ringtone: 'classic', incomingRingChosen: true }).ringtone, 'classic');


// Outbound ringback plays where the call does (the speaker); an incoming ring on the ringtone device.
import { ringDeviceFor } from '../lib/phone-audio';
import { lineGroups } from '../lib/line-names';
const devs = { ...DEFAULT_AUDIO_PREFS, outputDeviceId: 'headset', ringDeviceId: 'laptop' };
eq('outbound ringback on the speaker', ringDeviceFor(devs, true), 'headset');
eq('incoming ring on the ringtone device', ringDeviceFor(devs, false), 'laptop');
const lines = [
  { id: 'a', phone_e164: '+12105550003', assigned_user_id: null },
  { id: 'b', phone_e164: '+12105550002', assigned_user_id: 'u2' },
  { id: 'c', phone_e164: '+12105550001', assigned_user_id: 'me' },
  { id: 'd', phone_e164: '+17265555755', assigned_user_id: null, label: 'AI · Riley (lead manager)' },
];
eq('number picker: mine, then team, then shared, never an AI agent line', lineGroups(lines, 'me').map((g) => [g.label, g.lines.map((l) => l.id)]), [['Your lines', ['c']], ['Team lines', ['b']], ['Shared lines', ['a']]]);

import { lineText } from '../lib/line-names';
eq('label does not repeat the owner', lineText({ phone_e164: '+12105550001', label: 'Alex · Compr · Upstate SC 2', assigned_user_id: 'me' }, 'me'), '(210) 555-0001 · Yours · Alex · Compr · Upstate SC 2');
eq('label equal to the owner is dropped', lineText({ phone_e164: '+12105550002', label: 'Yours', assigned_user_id: 'me' }, 'me'), '(210) 555-0002 · Yours');

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
