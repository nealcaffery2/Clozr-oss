/**
 * The power dialer's rules, pure: modes, pacing against the abandonment cap,
 * what each line of a batch is doing, machines, and the session's numbers.
 *
 * Power waits. The rep presses Next when ready; a saved outcome, a no-answer
 * or a voicemail drop does not open the next batch. Predictive presses Next
 * for them and stops opening lines once the abandonment rate is over the cap.
 * Every session runs on Talkr's server (app/clozr/usePowerDialer.ts): this
 * browser carries one live line and never decides who to ring.
 *
 * Tests: tools/dial-amd.test.ts, tools/dial-rvm.test.ts.
 */

export type DialMode = 'power' | 'predictive';

export const DIAL_MODES: { id: DialMode; label: string; hint: string }[] = [
  { id: 'power', label: 'Power', hint: 'You press Next. Each press rings your lines at once; the first person to answer is put through to you. Nothing dials until you press.' },
  { id: 'predictive', label: 'Predictive', hint: 'Same lines, but the next batch dials itself a few seconds after each call, and it slows down before the abandonment cap.' },
];

/**
 * The rep's mode for a Talkr session. Talkr runs both of CLOZR's modes as a
 * `parallel` campaign, so the campaign's mode cannot say which the rep chose;
 * what this browser remembered at Start does. A session adopted from another
 * tab with nothing remembered reads Talkr's mode: a self-advancing one is
 * predictive, anything else is power.
 */
export function dialModeOf(remembered: DialMode | null | undefined, talkrMode: string | null | undefined): DialMode {
  if (remembered) return remembered;
  return talkrMode === 'progressive' || talkrMode === 'predictive' ? 'predictive' : 'power';
}

/** "Power · 3 lines", "Predictive · 1 line". */
export function dialModeLabel(mode: DialMode, lines: number): string {
  const n = clampLines(lines);
  return `${mode === 'predictive' ? 'Predictive' : 'Power'} · ${n} ${n === 1 ? 'line' : 'lines'}`;
}

/** Campaigns CLOZR builds for a list session carry this prefix: they are not for the campaign picker, and End archives them. */
export const LIST_CAMPAIGN_PREFIX = 'CLOZR list · ';
export const listCampaignName = (title: string): string => (LIST_CAMPAIGN_PREFIX + title).slice(0, 160);
export const isListCampaign = (name: string | null | undefined): boolean => !!name && name.startsWith(LIST_CAMPAIGN_PREFIX);

/** Fired after a voicemail drop hangs the line up, so the session can move on. */
export const VM_DROPPED_EVENT = 'clozr-vm-dropped';
/** Fired after an answering machine was hung up on with no recording to drop, so the session can move on. */
export const MACHINE_HANGUP_EVENT = 'clozr-machine-hangup';

// ── Answering machines on a browser-placed call ─────────────────────────────
//
// What BatchDialer, Mojo and CallTools do on a machine: the rep's own
// recording plays, the line hangs up, the next number dials, no press. The
// browser cannot hear a beep for itself; the carrier's machine detection
// runs on the seller's leg, which Talkr dials by REST
// (apps/server/src/services/conference-dial.ts, browser-leg.ts). Today Talkr
// passes `machineDetection` only on campaign dials (dial-sessions.ts, parallel
// mode) and acts on `AnsweredBy` only at /twiml/campaign-answer; a click-to-
// call's `AnsweredBy` is normalised (provider-telnyx normalize.ts
// `answeredBy`) and then dropped on the floor. Nothing reaches the browser:
// not on the SSE `call.updated` event (status only) and not on CallDto.
//
// What Talkr must add for this to light up, in order of least work:
//   1. `machineDetection: 'detect_message_end'` on the seller leg of a
//      browser call (conference-dial.ts customer dial), when the org or the
//      call asks for it (`POST /v1/calls` body `amd: true`, say).
//   2. At the seller leg's answer (its answerUrl / voice-status webhook), when
//      `AnsweredBy` is machine_* or fax, publish on the bus (routes/sse.ts)
//      `call.updated` with `answeredBy` beside `status`, or a dedicated
//      `call.amd` event `{ callId, answeredBy }`. Either shape is read below.
//   3. Optional, for a tab that lost the stream: `answered_by` on
//      `GET /v1/calls/:id` (serializeCall in routes/v1.ts, from raw.amdResult).
// Until 1 and 2 ship, the rep taps Drop VM (VmDropButton.tsx) as before.

/** Talkr's own rule (packages/core/src/dialer.ts): machine_start, machine_end_beep, machine_end_silence, machine_end_other, fax. */
export function isMachineAnsweredBy(answeredBy: string | null | undefined): boolean {
  if (!answeredBy) return false;
  return answeredBy === 'machine' || answeredBy.startsWith('machine_') || answeredBy === 'fax';
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The AMD verdict a Talkr stream event carries for the live call, or null.
 * Reads `call.updated` and `call.amd`, with `answeredBy` (or Talkr's
 * `raw.amdResult` spelling) on the event or under `data`, and only when the
 * event names the call this browser is on: a teammate's machine is not ours.
 */
export function machineFromEvent(e: { type: string; data: Record<string, unknown> | null }, liveCallId: string | null): string | null {
  if (!liveCallId || (e.type !== 'call.updated' && e.type !== 'call.amd')) return null;
  const top = e.data ?? {};
  const inner = (top.data && typeof top.data === 'object' ? top.data : {}) as Record<string, unknown>;
  const callId = str(inner.callId) ?? str(inner.call_id) ?? str(top.callId) ?? str(top.call_id);
  if (callId !== liveCallId) return null;
  const verdict = str(inner.answeredBy) ?? str(inner.answered_by) ?? str(inner.amdResult) ?? str(top.answeredBy) ?? str(top.answered_by) ?? str(top.amdResult);
  return isMachineAnsweredBy(verdict) ? verdict : null;
}

/**
 * What a running session does when a machine answers: the clip picked in the
 * session setup drops (the line hangs up after it and `clozr-vm-dropped`
 * moves on); with no clip, hang up (`clozr-machine-hangup` moves on). Outside
 * a session nothing happens by itself: Drop VM stays the rep's call.
 */
export function onMachine(input: { running: boolean; clipId: number | null }): 'drop' | 'hangup' | 'none' {
  if (!input.running) return 'none';
  return input.clipId ? 'drop' : 'hangup';
}

/**
 * Modes that open the next line by themselves. Progressive and parallel are
 * Talkr campaign modes; predictive is the one CLOZR starts. Power never does.
 */
export function autoAdvances(mode: string | null | undefined): boolean {
  return mode === 'predictive' || mode === 'progressive' || mode === 'parallel';
}

/**
 * Whether saving a call's outcome dials the next one in a running session.
 * Only the self-advancing modes. Power waits for Next: reps asked for the
 * pause between calls back (and every dial spends credit).
 */
export function advancesAfterSave(mode: string | null | undefined): boolean {
  return autoAdvances(mode);
}

/** Abandoned ÷ (connected + abandoned), one decimal. Zero when nothing has been answered or abandoned. */
export function abandonmentPercent(connected: number, abandoned: number): number {
  const n = connected + abandoned;
  if (n <= 0) return 0;
  return Math.round((abandoned / n) * 1000) / 10;
}

/**
 * A brand-new session is not paused because the first call was abandoned.
 * The cap applies once there is a real sample (20 answered-or-abandoned).
 */
export function overAbandonmentCap(connected: number, abandoned: number, capPercent: number): boolean {
  const n = connected + abandoned;
  if (n < 20) return false;
  return abandonmentPercent(connected, abandoned) >= capPercent;
}

/**
 * A drop hangs up and, in a self-advancing mode, the next number is dialled.
 * Power waits for Next after the rep taps Drop VM, but a machine the session
 * handled by itself (`auto`) moves on in power too: nobody pressed anything.
 */
export function afterVmDrop(mode: string | null | undefined, auto = false): { advance: boolean } {
  return { advance: auto || autoAdvances(mode) };
}

const ANSWERED_STATUS = /^(answered|in_progress|in-progress|active|bridged|connected)$/i;

/**
 * The line this browser answers when a session dials more than one.
 * Talkr bridges the first person who picks up and abandons the rest; if one
 * line is already answered, that is the one. Otherwise the first line.
 */
export function winnerLine<T extends { call: { status?: string | null } }>(
  lines: readonly T[] | null | undefined,
): T | null {
  if (!lines?.length) return null;
  return lines.find((line) => ANSWERED_STATUS.test(line.call.status ?? '')) ?? lines[0]!;
}

/**
 * The legal telemarketing cap is 3% of answered calls abandoned. The dialer
 * aims at 2% so a noisy sample still has room. Ten lines for one rep is the
 * most Talkr will ring (what Kixie and ReadyMode sell at the top), and the
 * rep picks how many of those to open; the abandonment rate pulls it back.
 */
export const ABANDON_CAP_PERCENT = 3;
export const ABANDON_BUFFER_PERCENT = 2;
export const MAX_LINES_PER_REP = 10; // Talkr clamps parallelLines to 10
export const STARTING_LINES = 3;

/** 1..10, or the default when the stored value is not a line count. */
export function clampLines(n: unknown, fallback = STARTING_LINES): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(MAX_LINES_PER_REP, Math.max(1, v));
}

export type Pace = { lines: number; pause: boolean; reason: 'warmup' | 'paced' | 'near_cap' | 'over_cap' };

/**
 * How many lines Talkr should ring for this one rep.
 * Under 20 answered-or-abandoned calls it rings what the rep asked for
 * (`maxLines`). After that it steps one line at a time toward 1 / connect-rate,
 * never above the rep's number, drops to a single line as abandonment nears
 * the cap, and pauses once the cap is crossed.
 */
export function paceLines(input: {
  answered: number;
  abandoned: number;
  machines?: number;
  currentLines: number;
  capPercent?: number;
  /** What the rep chose at setup; the pacing never opens more. */
  maxLines?: number;
}): Pace {
  const cap = input.capPercent ?? ABANDON_CAP_PERCENT;
  const most = clampLines(input.maxLines, MAX_LINES_PER_REP);
  const sample = input.answered + input.abandoned;
  if (sample >= 20 && overAbandonmentCap(input.answered, input.abandoned, cap)) {
    return { lines: 1, pause: true, reason: 'over_cap' };
  }
  if (sample >= 20 && abandonmentPercent(input.answered, input.abandoned) >= ABANDON_BUFFER_PERCENT) {
    return { lines: 1, pause: false, reason: 'near_cap' };
  }
  if (sample < 20) {
    return { lines: most, pause: false, reason: 'warmup' };
  }
  const attempts = input.answered + input.abandoned + (input.machines ?? 0);
  const connect = attempts > 0 ? input.answered / attempts : 0;
  const raw = connect > 0.02 ? 1 / connect : most;
  const target = Math.max(1, Math.min(most, Math.round(raw)));
  const current = Math.max(1, Math.min(most, input.currentLines || most));
  const lines = target > current ? current + 1 : target < current ? current - 1 : current;
  return { lines, pause: false, reason: 'paced' };
}

// ── The lines panel ─────────────────────────────────────────────────────────

/** One parallel line as the bar shows it, from dial to its outcome. */
export type LineState = 'dialing' | 'ringing' | 'talking' | 'machine' | 'abandoned' | 'no_answer' | 'busy' | 'failed' | 'canceled' | 'done';

export type DialLine = {
  callId: string;
  name: string;
  phone: string;
  state: LineState;
  /** When the line entered this state, so the panel can show how long it has been ringing. */
  since: number;
  /** The number this line dialed from, as the rep names it: "Upstate SC · (864) 555-8051". */
  from?: string;
  /** Who the server said the line is, for the page to show before the record loads. */
  card?: { contact: { display_name: string; phone: string | null } | null; property: { address_line1: string | null; city: string | null; state: string | null } | null } | null;
};

/**
 * Which of the org's lines a call went out on, by the label the rep gave it.
 * Talkr picks a different line per batch line (local area code first, then
 * the least used this week), so the panel shows each one; a number the org
 * does not list is shown as it came.
 */
export function lineFromLabel(
  from: string | null | undefined,
  lines: readonly { phone_e164: string; label?: string | null }[],
  format: (e164: string) => string = (s) => s,
): string | null {
  if (!from) return null;
  const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
  const hit = lines.find((l) => last10(l.phone_e164) === last10(from));
  const shown = format(from);
  return hit?.label ? `${hit.label} · ${shown}` : shown;
}

/** Talkr's call status words to a line state. Unknown words leave the line where it was (null). */
export function lineStateFromStatus(status: string | null | undefined): LineState | null {
  const s = (status ?? '').toLowerCase();
  if (!s || s === 'queued' || s === 'initiated') return 'dialing';
  if (s === 'ringing') return 'ringing';
  if (ANSWERED_STATUS.test(s)) return 'talking';
  if (s === 'completed') return 'done';
  if (s === 'no_answer' || s === 'no-answer') return 'no_answer';
  if (s === 'busy') return 'busy';
  if (s === 'failed') return 'failed';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  return null;
}

/** An outcome Talkr stamped (machine, abandoned) sticks: the hang-up after it does not overwrite it. */
export function nextLineState(current: LineState, incoming: LineState): LineState {
  if (current === 'machine' || current === 'abandoned') return current;
  return incoming;
}

/** What the rep reads on the line: what the person did, in plain words. */
export function lineStateLabel(state: LineState, drop: boolean): string {
  switch (state) {
    case 'dialing': return 'Dialing';
    case 'ringing': return 'Ringing';
    case 'talking': return 'On the line';
    case 'machine': return drop ? 'Machine, voicemail dropped' : 'Machine, hung up';
    case 'abandoned': return drop ? 'Answered while you were busy, heard your recording' : 'Answered while you were busy, heard the message';
    case 'no_answer': return 'No answer';
    case 'busy': return 'Busy';
    case 'failed': return 'Failed';
    case 'canceled': return 'Dropped, you were connected';
    case 'done': return 'Ended';
  }
}

/** A line still costing attention: not yet at an outcome. */
export function lineIsLive(state: LineState): boolean {
  return state === 'dialing' || state === 'ringing' || state === 'talking';
}

/**
 * Which line a stream event is about and what it says. `call.updated` carries
 * the call's status; `session.updated` names a batch outcome (`amd`, `abandoned`,
 * `bridged`) on `callId`. Null for anything else.
 */
export function lineEvent(e: { type: string; data: Record<string, unknown> | null }): { callId: string; state: LineState } | null {
  const top = e.data ?? {};
  const inner = (top.data && typeof top.data === 'object' ? top.data : {}) as Record<string, unknown>;
  const callId = str(inner.callId) ?? str(inner.call_id) ?? str(top.callId) ?? str(top.call_id);
  if (!callId) return null;
  if (e.type === 'session.updated') {
    const ev = str(inner.event) ?? str(top.event);
    if (ev === 'amd') return { callId, state: 'machine' };
    if (ev === 'abandoned') return { callId, state: 'abandoned' };
    // Talkr claimed this line for the rep and is ringing their browser with it.
    if (ev === 'bridged') return { callId, state: 'talking' };
    return null;
  }
  if (e.type === 'call.updated') {
    const state = lineStateFromStatus(str(inner.status) ?? str(top.status));
    return state ? { callId, state } : null;
  }
  return null;
}

// ── The session's numbers ───────────────────────────────────────────────────

export type SessionStats = {
  dialed: number;
  connected: number;
  abandoned: number;
  machines: number;
  /** Answered by a person, out of everything dialed. */
  contactRate: number | null;
  /** Abandoned out of answered-or-abandoned (the FTC measure). */
  abandonRate: number | null;
  talkSeconds: number;
  /** Talk time per call this browser carried, seconds. */
  avgTalkSeconds: number | null;
  /** Dials per hour since the session started. */
  dialsPerHour: number | null;
  elapsedSeconds: number;
  remaining: number | null;
};

/** Rates from the raw counters; null where there is nothing to divide by yet. */
export function sessionStats(input: {
  dialed: number; connected: number; abandoned: number; machines: number; talkSeconds: number;
  /** Calls this browser carried, for the average. */
  calls: number;
  startedAt: number | null; now: number; remaining: number | null;
}): SessionStats {
  const elapsed = input.startedAt != null && input.now > input.startedAt ? Math.round((input.now - input.startedAt) / 1000) : 0;
  const answered = input.connected + input.abandoned;
  return {
    dialed: input.dialed,
    connected: input.connected,
    abandoned: input.abandoned,
    machines: input.machines,
    contactRate: input.dialed > 0 ? Math.round((input.connected / input.dialed) * 1000) / 10 : null,
    abandonRate: answered > 0 ? abandonmentPercent(input.connected, input.abandoned) : null,
    talkSeconds: input.talkSeconds,
    avgTalkSeconds: input.calls > 0 ? Math.round(input.talkSeconds / input.calls) : null,
    dialsPerHour: elapsed >= 60 && input.dialed > 0 ? Math.round((input.dialed / elapsed) * 3600) : null,
    elapsedSeconds: elapsed,
    remaining: input.remaining,
  };
}

/** "1:04:09" or "4:09": a clock that fits in a stat. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export type HotkeyAction = 'next' | 'pause' | 'end' | 'mute' | 'drop';

/** The power dialer's keys, for the page and its legend. Letters only: digits belong to the outcome picker. */
export const HOTKEYS: { key: string; does: string; action: HotkeyAction }[] = [
  { key: 'n', does: 'Next batch', action: 'next' },
  { key: 'p', does: 'Pause or resume', action: 'pause' },
  { key: 'e', does: 'End session', action: 'end' },
  { key: 'm', does: 'Mute', action: 'mute' },
  { key: 'd', does: 'Drop voicemail', action: 'drop' },
];

/** The hotkey a keydown means, or null: never while typing, never with a modifier. */
export function hotkeyFor(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): HotkeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = (el?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return null;
  return HOTKEYS.find((h) => h.key === e.key.toLowerCase())?.action ?? null;
}
