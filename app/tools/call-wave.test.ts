// lib/call-wave.ts: the call player's speaker-coloured loudness bars.
// Run with:  npx tsx tools/call-wave.test.ts
import { levelsFromSamples, pace, ripple, speakerAt, waveBars } from '../lib/call-wave';
import type { CallSegment } from '../lib/call-media';

let failed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const segs: CallSegment[] = [
  { start: 0, end: 4, speaker: 'rep', text: 'Hi Kara it is Taylor with Acme Homes, is now still good' },
  { start: 5, end: 8, speaker: 'contact', text: 'Yes perfect' },
];

check('speaker at a moment', speakerAt(segs, 1)?.speaker === 'rep' && speakerAt(segs, 6)?.speaker === 'contact' && speakerAt(segs, 4.6) === null);
check('pace is words per second', Math.abs(pace(segs[1]!) - 2 / 3) < 1e-9);
check('ripple is stable and bounded', ripple(7) === ripple(7) && ripple(7) >= 0.55 && ripple(7) <= 1);

const bars = waveBars(segs, 10, 20);
check('one bar per slice, coloured by speaker', bars.length === 20 && bars[2]!.speaker === 'rep' && bars[12]!.speaker === 'contact' && bars[19]!.speaker === null);
check('silence is a floor, speech is taller', bars[19]!.level < bars[2]!.level && bars.every((b) => b.level > 0 && b.level <= 1));
check('the faster talker is taller without audio', bars[2]!.level > bars[12]!.level, [bars[2], bars[12]]);

const samples = new Float32Array(1000);
for (let i = 500; i < 1000; i++) samples[i] = 0.5;
const lv = levelsFromSamples(samples, 4);
check('RMS per slice, loudest scaled to 1', lv[0] === 0 && lv[1] === 0 && lv[2] === 1 && lv[3] === 1, lv);
const withAudio = waveBars(segs, 10, 4, lv);
check('decoded levels drive the height', withAudio[0]!.level < withAudio[3]!.level && withAudio[3]!.level === 1);
check('no duration, no bars', waveBars(segs, 0, 10).length === 0 && levelsFromSamples([], 3).every((v) => v === 0));

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
