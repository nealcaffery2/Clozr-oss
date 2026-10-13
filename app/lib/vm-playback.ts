/**
 * Play a recording into the live call, in place of the microphone, then
 * put the microphone back. The far end hears the file. The rep's mic is
 * silent for the length of it.
 */

export function peerFromCall(call: unknown): RTCPeerConnection | null {
  if (!call || typeof call !== 'object') return null;
  const c = call as {
    peer?: { instance?: RTCPeerConnection | null };
    _mediaHandler?: { pc?: RTCPeerConnection | null };
    getRTCPeerConnection?: () => RTCPeerConnection | null;
  };
  return c.peer?.instance ?? c._mediaHandler?.pc ?? c.getRTCPeerConnection?.() ?? null;
}

/**
 * Replace every audio sender's track with the recording. Resolves when the
 * file ends. Restores the previous tracks either way.
 */
export async function playUrlOnPeer(peer: RTCPeerConnection, url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('The recording could not be loaded.');
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(audio);
  const dest = ctx.createMediaStreamDestination();
  source.connect(dest);
  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    URL.revokeObjectURL(objectUrl);
    await ctx.close();
    throw new Error('This browser could not play that recording into the call.');
  }
  const senders = peer.getSenders().filter((s) => !s.track || s.track.kind === 'audio');
  const previous = senders.map((s) => s.track);
  try {
    await Promise.all(senders.map((s) => s.replaceTrack(track)));
    await audio.play();
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('The recording stopped before it finished.'));
    });
  } finally {
    await Promise.all(senders.map((s, i) => s.replaceTrack(previous[i] ?? null).catch(() => undefined)));
    track.stop();
    audio.pause();
    URL.revokeObjectURL(objectUrl);
    await ctx.close().catch(() => undefined);
  }
}

/** A second answered line: accept it, play the drop, hang it up. The live call is a different peer and is left alone. */
export type DropLeg = {
  accept(): void;
  disconnect(): void;
  peerConnection(): RTCPeerConnection | null;
  remoteStream(): MediaStream | null;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Play `url` to the person on `leg`, then hang that leg up.
 * Remote audio on the leg is silenced so it does not play over the call the rep is already on.
 * Throws when the leg never gets an audio sender — the caller declines it.
 */
export async function playDropOnLeg(leg: DropLeg, url: string): Promise<void> {
  leg.accept();
  const quiet = () => leg.remoteStream()?.getAudioTracks().forEach((t) => { t.enabled = false; });
  const started = Date.now();
  let peer: RTCPeerConnection | null = null;
  while (Date.now() - started < 4000) {
    quiet();
    const next = leg.peerConnection();
    const senders = next?.getSenders().filter((s) => !s.track || s.track.kind === 'audio') ?? [];
    if (next && next.connectionState !== 'closed' && senders.length) {
      peer = next;
      break;
    }
    await wait(100);
  }
  if (!peer) {
    leg.disconnect();
    throw new Error('The other line never connected, so the voicemail could not play.');
  }
  const quietTimer = setInterval(quiet, 200);
  try {
    await playUrlOnPeer(peer, url);
  } finally {
    clearInterval(quietTimer);
    leg.disconnect();
  }
}
