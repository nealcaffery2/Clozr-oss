// Records why a rep stops hearing the far end mid-call.
//
// The live transcript is fed server side, so it keeps running when the
// seller's audio never reaches the rep's tab. The playback watchdog in
// softphone-engine.ts fixes a detached, paused or muted element, but not audio
// that stops arriving (Wi-Fi drop, ICE disconnect). This watch reads the peer's
// inbound-rtp packet count every tick and writes one client_errors row
// (kind 'softphone') when packets stop for STALL_TICKS ticks, and one when they
// come back, with ICE/connection state, track and element state and the
// browser's network estimate. Read with:
//   select * from client_errors_recent where kind = 'softphone' limit 50

export const STALL_TICKS = 2; // 2 ticks x 2 s = audio silent for ~4 s

export type FlowState = { packets: number | null; still: number; stalledAt: number | null };
export type FlowEvent = { type: 'stall' } | { type: 'resume'; silentMs: number } | null;

/** Pure rule: given the last state and this tick's packet count, the new state and what to report. */
export function nextFlow(prev: FlowState, packets: number | null, now: number): { state: FlowState; event: FlowEvent } {
  if (packets == null) return { state: prev, event: null };
  if (prev.packets == null) return { state: { packets, still: 0, stalledAt: null }, event: null };
  if (packets > prev.packets) {
    const event: FlowEvent = prev.stalledAt != null ? { type: 'resume', silentMs: now - prev.stalledAt } : null;
    return { state: { packets, still: 0, stalledAt: null }, event };
  }
  const still = prev.still + 1;
  if (still === STALL_TICKS && prev.stalledAt == null) {
    return { state: { packets, still, stalledAt: now }, event: { type: 'stall' } };
  }
  return { state: { packets, still, stalledAt: prev.stalledAt }, event: null };
}

async function inboundAudioPackets(pc: RTCPeerConnection): Promise<number | null> {
  try {
    const stats = await pc.getStats();
    let total: number | null = null;
    stats.forEach((r: { type?: string; kind?: string; mediaType?: string; packetsReceived?: number }) => {
      if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'audio' && typeof r.packetsReceived === 'number') {
        total = (total ?? 0) + r.packetsReceived;
      }
    });
    return total;
  } catch {
    return null;
  }
}

export class AudioFlowWatch {
  private state: FlowState = { packets: null, still: 0, stalledAt: null };
  private readonly started = Date.now();
  private boundPc: RTCPeerConnection | null = null;
  private stopped = false;
  /** One snapshot per call, ~6 s in: proves whether the far end arrives and where it plays. */
  private snapped = false;

  private readonly peer: () => RTCPeerConnection | null;
  private readonly el: HTMLAudioElement | null;
  private readonly callId: string;
  private readonly report: (message: string, where: string) => void;

  constructor(
    peer: () => RTCPeerConnection | null,
    el: HTMLAudioElement | null,
    callId: string,
    report: (message: string, where: string) => void,
  ) {
    this.peer = peer;
    this.el = el;
    this.callId = callId;
    this.report = report;
  }

  private onIce = () => {
    const pc = this.boundPc;
    if (!pc || this.stopped) return;
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      this.report(`softphone ice ${pc.iceConnectionState} at ${this.secs()}s · ${this.context(pc)}`, this.where());
    }
  };

  private secs() {
    return Math.round((Date.now() - this.started) / 1000);
  }

  private where() {
    return `softphone call ${this.callId}`.slice(0, 200);
  }

  private context(pc: RTCPeerConnection | null): string {
    const track = pc?.getReceivers().find((r) => r.track?.kind === 'audio')?.track ?? null;
    const net = (navigator as { connection?: { effectiveType?: string; rtt?: number; downlink?: number } }).connection;
    const el = this.el;
    return [
      `ice=${pc?.iceConnectionState ?? 'none'}`,
      `conn=${pc?.connectionState ?? 'none'}`,
      `track=${track ? `${track.readyState}${track.muted ? '/muted' : ''}` : 'none'}`,
      `el=${el ? `${el.paused ? 'paused' : 'playing'}${el.muted ? '/muted' : ''}${el.srcObject ? '' : '/nosrc'}` : 'none'}`,
      `sink=${(el as (HTMLAudioElement & { sinkId?: string }) | null)?.sinkId || 'default'}`,
      `vol=${el ? el.volume : '?'}`,
      `tab=${document.visibilityState}`,
      `online=${navigator.onLine}`,
      net ? `net=${net.effectiveType ?? '?'} rtt=${net.rtt ?? '?'} down=${net.downlink ?? '?'}` : 'net=?',
    ].join(' ');
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const pc = this.peer();
    if (pc && pc !== this.boundPc) {
      this.boundPc?.removeEventListener('iceconnectionstatechange', this.onIce);
      pc.addEventListener('iceconnectionstatechange', this.onIce);
      this.boundPc = pc;
    }
    if (!pc) return;
    const packets = await inboundAudioPackets(pc);
    const { state, event } = nextFlow(this.state, packets, Date.now());
    this.state = state;
    if (!this.snapped && Date.now() - this.started >= 6_000) {
      this.snapped = true;
      const out = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
      const sinkId = (this.el as (HTMLAudioElement & { sinkId?: string }) | null)?.sinkId || 'default';
      const label = out.find((d) => d.kind === 'audiooutput' && d.deviceId === sinkId)?.label ?? '?';
      this.report(`softphone snapshot at ${this.secs()}s packets=${packets ?? 'none'} out="${label}" · ${this.context(pc)}`, this.where());
    }
    if (event?.type === 'stall') this.report(`softphone audio stalled at ${this.secs()}s · ${this.context(pc)}`, this.where());
    if (event?.type === 'resume') {
      this.report(`softphone audio resumed at ${this.secs()}s after ${Math.round(event.silentMs / 1000)}s · ${this.context(pc)}`, this.where());
    }
  }

  stop(): void {
    this.stopped = true;
    this.boundPc?.removeEventListener('iceconnectionstatechange', this.onIce);
    this.boundPc = null;
  }
}
