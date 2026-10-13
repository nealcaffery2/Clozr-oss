/**
 * The tap that starts a call opens the mic so iOS will show the permission
 * prompt. Chrome often hands that same live track to the carrier SDK. Stopping
 * it while the call is still up makes Twilio treat the input as lost and open
 * a new capture, and that one stays on after hangup when the rep chose Always.
 *
 * While the call is up, leave any probe track the carrier stream still holds.
 * Everything else — and the whole probe once the call is over — can stop.
 */
export function probeTracksToStop(probe: MediaStream, leg: MediaStream | null, callLive: boolean): MediaStreamTrack[] {
  const tracks = probe.getTracks();
  if (!callLive || !leg) return tracks;
  const shared = new Set(leg.getTracks().map((t) => t.id));
  return tracks.filter((t) => !shared.has(t.id));
}
