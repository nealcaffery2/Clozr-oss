// Gesture-mic release. Run: npx tsx tools/mic-release.test.ts
import { probeTracksToStop } from '../lib/mic-release';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

function stream(ids: string[]): MediaStream {
  return { getTracks: () => ids.map((id) => ({ id }) as MediaStreamTrack) } as MediaStream;
}

const probe = stream(['shared', 'extra']);
eq('call up keeps the carrier track', probeTracksToStop(probe, stream(['shared']), true).map((t) => t.id), ['extra']);
eq('call over stops the whole probe', probeTracksToStop(probe, stream(['shared']), false).map((t) => t.id), ['shared', 'extra']);
eq('no leg stops the whole probe', probeTracksToStop(probe, null, true).map((t) => t.id), ['shared', 'extra']);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
