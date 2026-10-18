// Run: npx tsx tools/bell-sound.test.ts
import { bellNotifEvent, bellSoundDedupeKey } from '../lib/bell-sound';

const eq = (label: string, got: unknown, want: unknown) => {
  if (got !== want) throw new Error(`${label}: got ${String(got)} want ${String(want)}`);
};

eq('sms', bellNotifEvent({ cat: 'SMS', text: 'x', link: { screen: 'person', id: 's1', tab: 'Texts' } }), 'sms');
eq('missed', bellNotifEvent({ cat: 'Call', text: 'Missed call', link: { screen: 'person', id: 's1', tab: 'Calls' } }), 'missed');
eq('vm', bellNotifEvent({ cat: 'Call', text: 'voicemail', link: { screen: 'person', id: 's1' } }), 'voicemail');
eq('dedupe phone', bellSoundDedupeKey({ id: 'bell-sms-a', cat: 'SMS', phone: '+12105550100' }, 'sms'), 'sms:2105550100');

console.log('bell-sound ok');
