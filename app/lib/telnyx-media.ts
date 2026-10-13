// Mid-call mic switch without going through Telnyx's setAudioInDevice.
//
// Telnyx WebRTC's setAudioInDevice reports failures as telnyx.rtc.mediaError,
// and the SDK's _onMediaError always hangups the browser leg
// (initiator: "sdk:media-error") while the conference stays up for the
// customer. replaceTrack on the live audio sender keeps the peer connection
// and never fires that path.

export type ReplaceInputOpts = {
  deviceId: string;
  /** Preserve mute: new track.enabled mirrors the previous sender track. */
  muted?: boolean;
  /** The call's local stream: its track is swapped too, so a transcriber started later hears the new mic. */
  local?: MediaStream | null;
  getUserMedia?: typeof navigator.mediaDevices.getUserMedia;
};

/**
 * Swap the outbound audio track on `pc` to `deviceId`.
 * Returns true when the sender was updated; false when there was nothing to do
 * or the switch failed (previous track left live).
 */
export async function replaceAudioInputTrack(
  pc: RTCPeerConnection | null | undefined,
  opts: ReplaceInputOpts,
): Promise<boolean> {
  if (!pc) return false;
  const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
  if (!sender) return false;
  // Already on that mic (the leg opened with it): nothing to swap.
  if (opts.deviceId && sender.track?.getSettings?.().deviceId === opts.deviceId) return false;

  const gum = opts.getUserMedia
    ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) : undefined);
  if (!gum) return false;

  const deviceId = opts.deviceId && opts.deviceId !== 'default' ? { ideal: opts.deviceId } : undefined;
  let stream: MediaStream;
  try {
    stream = await gum({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId } : {}),
      },
    });
  } catch {
    return false;
  }

  const next = stream.getAudioTracks()[0];
  if (!next) {
    stream.getTracks().forEach((t) => t.stop());
    return false;
  }

  const prev = sender.track;
  next.enabled = opts.muted != null ? !opts.muted : (prev ? prev.enabled : true);

  try {
    await sender.replaceTrack(next);
  } catch {
    next.stop();
    stream.getTracks().forEach((t) => { if (t !== next) t.stop(); });
    return false;
  }

  if (opts.local && prev && opts.local.getTracks().includes(prev)) {
    opts.local.removeTrack(prev);
    opts.local.addTrack(next);
  }
  prev?.stop();
  stream.getTracks().forEach((t) => { if (t !== next) t.stop(); });
  return true;
}
