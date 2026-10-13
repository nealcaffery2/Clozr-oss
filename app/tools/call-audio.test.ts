// Phone wait-music and hangup decisions. Run: npx tsx tools/call-audio.test.ts
import { isBenignHangupError, remoteHasLiveAudio, yieldLocalRingToCarrier } from '../lib/phone-audio';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('clean hangup is not a device error', isBenignHangupError('Failed to hang up cleanly'), true);
eq('setup hangup is not a device error', isBenignHangupError('Call was closed during setup'), true);
eq('the wording from the phone', isBenignHangupError('failed to hang up early'), true);
eq('a real device error stays', isBenignHangupError('Microphone is blocked or unavailable in this browser.'), false);

eq('phone yields when the carrier is already playing', yieldLocalRingToCarrier({ touch: true, remoteAudio: true, customWaitMusic: false }), true);
eq('a chosen mp3 stays on the phone', yieldLocalRingToCarrier({ touch: true, remoteAudio: true, customWaitMusic: true }), false);
eq('desk keeps its own ringback', yieldLocalRingToCarrier({ touch: false, remoteAudio: true, customWaitMusic: false }), false);
eq('no carrier audio, phone keeps ringback', yieldLocalRingToCarrier({ touch: true, remoteAudio: false, customWaitMusic: false }), false);

const live = { getAudioTracks: () => [{ readyState: 'live' }] };
const ended = { getAudioTracks: () => [{ readyState: 'ended' }] };
eq('live remote audio', remoteHasLiveAudio(live), true);
eq('ended remote audio', remoteHasLiveAudio(ended), false);
eq('no stream', remoteHasLiveAudio(null), false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
