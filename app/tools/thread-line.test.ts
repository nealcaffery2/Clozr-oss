import { replyLine } from '../lib/thread-line';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error('FAIL', name, '\n got ', got, '\n want', want); process.exitCode = 1; }
  else console.log('ok', name);
}

const casey = {
  id: 'u-casey',
  numbers: [{ id: 'n-casey' }],
  default_phone_number_id: 'n-casey',
  org_numbers: [
    { id: 'n-casey', phone_e164: '+12105550186', assigned_user_id: 'u-casey' },
    { id: 'n-chris', phone_e164: '+15550001111', assigned_user_id: 'u-chris' },
    { id: 'n-main', phone_e164: '+15550009999', assigned_user_id: null },
  ],
};

eq('TC on the rep\'s thread sends from her own line', replyLine(casey, '+15550001111', true), 'n-casey');
eq('anyone else stays on the thread\'s line', replyLine(casey, '+15550001111', false), 'n-chris');
eq('a shared company line stays', replyLine(casey, '+15550009999', true), 'n-main');
eq('her own thread stays on her line', replyLine(casey, '+12105550186', true), 'n-casey');
eq('a new thread starts on her default', replyLine(casey, null, true), 'n-casey');
eq('TC with no line of her own keeps the thread\'s', replyLine({ ...casey, numbers: [], default_phone_number_id: null }, '+15550001111', true), 'n-chris');
eq('a line the org no longer has sends nothing', replyLine(casey, '+15550007777', true), null);
