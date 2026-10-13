// Call audio route. Run: npx tsx tools/call-route.test.ts
import { COMMUNICATIONS_SINK, pickOutputSink } from '../lib/call-route';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const android = [
  { deviceId: 'default', label: 'Default' },
  { deviceId: 'spk', label: 'Speakerphone' },
  { deviceId: 'ear', label: 'Headset earpiece' },
];

eq('named earpiece wins', pickOutputSink(android, 'earpiece'), 'ear');
eq('speakerphone wins for speaker', pickOutputSink(android, 'speaker'), 'spk');
eq('no list still asks for the communications device', pickOutputSink([], 'earpiece'), COMMUNICATIONS_SINK);
eq('no speaker name uses the media default', pickOutputSink([{ deviceId: 'default', label: 'Default' }], 'speaker'), '');
eq('communications id is the earpiece when unlabeled', pickOutputSink([{ deviceId: 'communications', label: '' }], 'earpiece'), 'communications');
eq('speakerphone is not treated as the earpiece', pickOutputSink([{ deviceId: 'spk', label: 'Default - Speakerphone' }], 'earpiece'), COMMUNICATIONS_SINK);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
