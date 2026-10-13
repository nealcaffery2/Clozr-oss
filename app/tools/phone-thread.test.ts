// The Inbox thread with a number's smrtPhone texts merged in.  Run: npx tsx tools/phone-thread.test.ts
import { mergeThread } from '../lib/crm';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};
const talkr = [{ dir: 'in' as const, body: 'Yes still interested', at: '2026-10-02T16:05:00Z', note: '' }];
const other = [
  { dir: 'out' as const, body: 'Hi Ivey, still looking to sell 12 Elm?', at: '2026-10-02T16:00:00Z' },
  { dir: 'in' as const, body: 'Yes still interested', at: '2026-10-02T16:05:30Z' },
  { dir: 'out' as const, body: 'Great, calling you now', at: '2026-10-02T16:07:00Z' },
];
const m = mergeThread(talkr, other);
check('ours added, the reply both logged shown once, oldest first',
  JSON.stringify(m.map((x) => x.dir + ':' + x.body)) === JSON.stringify(['out:Hi Ivey, still looking to sell 12 Elm?', 'in:Yes still interested', 'out:Great, calling you now']), m);
check('the Talkr copy is the one kept', 'note' in m[1]);
console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
