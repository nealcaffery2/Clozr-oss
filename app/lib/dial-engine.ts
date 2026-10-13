/**
 * Power and predictive dialing, as the rep's session decides it.
 *
 * Power waits. The rep presses Next, and a saved outcome does not open the
 * next line. Predictive opens the next line the moment this one is free —
 * including the moment a voicemail drop finishes — and it stops opening lines
 * once the abandonment rate is over the cap.
 *
 * A browser can carry one live line. Dialling a second number while the rep
 * is already talking is the server's job (a Talkr campaign in predictive
 * mode). This module only answers "should the browser open a line now?"
 */

export type DialMode = 'power' | 'predictive';

export const DIAL_MODES: { id: DialMode; label: string; hint: string }[] = [
  { id: 'power', label: 'Power', hint: 'You press Next. Nothing dials until you do.' },
  { id: 'predictive', label: 'Predictive', hint: 'Dials ahead of you, drops voicemail on a machine, and slows down before the abandonment cap.' },
];

/** Fired after a voicemail drop hangs the line up, so the session can move on. */
export const VM_DROPPED_EVENT = 'clozr-vm-dropped';

/**
 * Modes that open the next line by themselves. Progressive and parallel are
 * Talkr campaign modes; predictive is the one CLOZR starts. Power never does.
 */
export function autoAdvances(mode: string | null | undefined): boolean {
  return mode === 'predictive' || mode === 'progressive' || mode === 'parallel';
}

/**
 * Whether saving a call's outcome dials the next one in a running session.
 * The self-advancing modes always did. Power does too: Next is the press
 * that starts the first call, and after that Save is the decision, the way
 * CLOZR's own power list goes on after Save. Asking for Save and then Next
 * on every lead was two presses for one choice.
 */
export function advancesAfterSave(mode: string | null | undefined): boolean {
  return mode === 'power' || autoAdvances(mode);
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
 * How many lines the browser should open right now. Always 0 or 1: a second
 * line while this one is up is not something the browser can answer.
 */
export function browserLinesToOpen(mode: DialMode, onCall: boolean, overCap: boolean): number {
  if (onCall || overCap) return 0;
  if (mode === 'power') return 0;
  return 1;
}

/** A drop hangs up and, in a self-advancing mode, the next number is dialled. */
export function afterVmDrop(mode: string | null | undefined): { advance: boolean } {
  return { advance: autoAdvances(mode) };
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
 * aims at 2% so a noisy sample still has room, and it never opens more than
 * four lines for one rep. JustCall will go to ten; that ratio blows the cap
 * on any list people actually answer.
 */
export const ABANDON_CAP_PERCENT = 3;
export const ABANDON_BUFFER_PERCENT = 2;
export const MAX_LINES_PER_REP = 4;
export const STARTING_LINES = 2;

export type Pace = { lines: number; pause: boolean; reason: 'warmup' | 'paced' | 'near_cap' | 'over_cap' };

/**
 * How many lines Talkr should ring for this one rep.
 * Under 20 answered-or-abandoned calls it stays at the starting ratio.
 * After that it steps one line at a time toward 1 / connect-rate, drops to a
 * single line as abandonment nears the cap, and pauses once the cap is crossed.
 */
export function paceLines(input: {
  answered: number;
  abandoned: number;
  machines?: number;
  currentLines: number;
  capPercent?: number;
}): Pace {
  const cap = input.capPercent ?? ABANDON_CAP_PERCENT;
  const sample = input.answered + input.abandoned;
  if (sample >= 20 && overAbandonmentCap(input.answered, input.abandoned, cap)) {
    return { lines: 1, pause: true, reason: 'over_cap' };
  }
  if (sample >= 20 && abandonmentPercent(input.answered, input.abandoned) >= ABANDON_BUFFER_PERCENT) {
    return { lines: 1, pause: false, reason: 'near_cap' };
  }
  if (sample < 20) {
    const lines = Math.min(MAX_LINES_PER_REP, Math.max(input.currentLines || STARTING_LINES, STARTING_LINES));
    return { lines, pause: false, reason: 'warmup' };
  }
  const attempts = input.answered + input.abandoned + (input.machines ?? 0);
  const connect = attempts > 0 ? input.answered / attempts : 0;
  const raw = connect > 0.02 ? 1 / connect : MAX_LINES_PER_REP;
  const target = Math.max(1, Math.min(MAX_LINES_PER_REP, Math.round(raw)));
  const current = Math.max(1, input.currentLines || STARTING_LINES);
  const lines = target > current ? current + 1 : target < current ? current - 1 : current;
  return { lines, pause: false, reason: 'paced' };
}
