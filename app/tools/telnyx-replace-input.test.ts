// Mid-call mic switch. Run: npx tsx tools/telnyx-replace-input.test.ts
import { replaceAudioInputTrack } from '../lib/telnyx-media';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

type FakeTrack = MediaStreamTrack & { _stopped: boolean; _deviceId?: string };

function track(id: string, enabled = true): FakeTrack {
  return {
    id,
    kind: 'audio',
    enabled,
    stop() { this._stopped = true; },
    _stopped: false,
  } as FakeTrack;
}

function fakePc(senderTrack: FakeTrack | null): {
  pc: RTCPeerConnection;
  sender: { track: FakeTrack | null; replaced: FakeTrack | null; fail?: boolean };
} {
  const sender = {
    track: senderTrack,
    replaced: null as FakeTrack | null,
    fail: false,
    async replaceTrack(next: MediaStreamTrack | null) {
      if (sender.fail) throw new Error('replace failed');
      sender.replaced = next as FakeTrack | null;
      sender.track = next as FakeTrack | null;
    },
  };
  const pc = { getSenders: () => [sender] } as unknown as RTCPeerConnection;
  return { pc, sender };
}

async function run() {
  // Happy path: old track stopped, new track on the sender, ideal deviceId.
  {
    const seen: { c?: MediaStreamConstraints } = {};
    const prev = track('old');
    const { pc, sender } = fakePc(prev);
    const next = track('new');
    const ok = await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      muted: false,
      getUserMedia: async (c) => {
        seen.c = c;
        return { getAudioTracks: () => [next], getTracks: () => [next] } as unknown as MediaStream;
      },
    });
    eq('happy: ok', ok, true);
    eq('happy: replaced with new', sender.replaced?.id, 'new');
    eq('happy: old stopped', prev._stopped, true);
    eq('happy: new kept live', next._stopped, false);
    eq('happy: uses ideal not exact', (seen.c?.audio as MediaTrackConstraints)?.deviceId, { ideal: 'mic-2' });
    eq('happy: unmuted', next.enabled, true);
  }

  // Mute preserved.
  {
    const prev = track('old', false);
    const { pc } = fakePc(prev);
    const next = track('new');
    await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      muted: true,
      getUserMedia: async () => ({ getAudioTracks: () => [next], getTracks: () => [next] } as unknown as MediaStream),
    });
    eq('mute: new track disabled', next.enabled, false);
  }

  // replaceTrack failure: keep old, stop new.
  {
    const prev = track('old');
    const { pc, sender } = fakePc(prev);
    sender.fail = true;
    const next = track('new');
    const ok = await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      getUserMedia: async () => ({ getAudioTracks: () => [next], getTracks: () => [next] } as unknown as MediaStream),
    });
    eq('fail: returns false', ok, false);
    eq('fail: old still live', prev._stopped, false);
    eq('fail: new stopped', next._stopped, true);
    eq('fail: sender still old', sender.track?.id, 'old');
  }

  // No audio sender: no-op.
  {
    const pc = { getSenders: () => [{ track: null }] } as unknown as RTCPeerConnection;
    let gumCalled = false;
    const ok = await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      getUserMedia: async () => { gumCalled = true; return { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream; },
    });
    eq('no sender: false', ok, false);
    eq('no sender: no getUserMedia', gumCalled, false);
  }

  // Already on the requested mic: no getUserMedia, nothing replaced.
  {
    const prev = Object.assign(track('old'), { getSettings: () => ({ deviceId: 'mic-2' }) });
    const { pc, sender } = fakePc(prev);
    let gumCalled = false;
    const ok = await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      getUserMedia: async () => { gumCalled = true; return { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream; },
    });
    eq('same mic: false', ok, false);
    eq('same mic: no getUserMedia', gumCalled, false);
    eq('same mic: sender untouched', sender.track?.id, 'old');
  }

  // The call's local stream follows the sender, so a later transcriber hears the new mic.
  {
    const prev = track('old');
    const { pc } = fakePc(prev);
    const next = track('new');
    const tracks: MediaStreamTrack[] = [prev];
    const local = {
      getTracks: () => [...tracks],
      removeTrack: (t: MediaStreamTrack) => { tracks.splice(tracks.indexOf(t), 1); },
      addTrack: (t: MediaStreamTrack) => { tracks.push(t); },
    } as unknown as MediaStream;
    await replaceAudioInputTrack(pc, {
      deviceId: 'mic-2',
      local,
      getUserMedia: async () => ({ getAudioTracks: () => [next], getTracks: () => [next] } as unknown as MediaStream),
    });
    eq('local: holds the new track', tracks.map((t) => t.id), ['new']);
  }

  // Null pc: no-op.
  eq('null pc', await replaceAudioInputTrack(null, { deviceId: 'x', getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream) }), false);

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
}

void run();
