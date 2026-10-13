// Ends an outbound call the seller's side has already given up on.
//
// On Telnyx the rep's browser joins the call's conference room first, and the
// seller is dialled into that room. When the seller's phone rings out (no
// answer, busy, a dial that failed) Talkr marks the call over, but nothing
// hangs up the rep: the browser sat in an empty room with the clock running.
// Alex, 1 Oct: the seller's line rang 29 s and went no-answer, and his side
// stayed up 75 s longer. On another call the seller was never dialled at all
// (no seller leg exists) and he waited 73 s on nothing.
//
// The browser cannot tell from Talkr when the seller picks up (the call is
// "answered" the moment the rep's own leg joins), but it can tell when the
// seller's leg is over, and when no seller leg ever appeared.
//
// Pure, so tools/ring-guard.test.ts can pin it.

/** How often the browser re-reads the call while it is watching. */
export const RING_GUARD_POLL_MS = 2_000;
/** Talkr dials the seller about a second after the rep joins, and retries 5 s later. Past this, nobody is coming. */
export const NEVER_DIALED_AFTER_MS = 15_000;
/**
 * Stop watching once the call has been up this long. Telnyx gives up on a
 * ringing phone at 30 s, so by a minute the call is a conversation or a
 * voicemail greeting the rep is handling.
 */
export const RING_GUARD_WINDOW_MS = 60_000;

export type RingOutReason = 'no_answer' | 'busy' | 'failed' | 'canceled' | 'never_dialed';
export type RingVerdict = { reason: RingOutReason; message: string };

const MESSAGES: Record<RingOutReason, string> = {
  no_answer: 'No answer. The line rang out, so the call was hung up for you.',
  busy: 'The line was busy, so the call was hung up for you.',
  failed: 'The call did not go through, so it was hung up for you.',
  canceled: 'The carrier cancelled the call before anyone answered, so it was hung up for you.',
  never_dialed: 'The seller’s number never started ringing, so the call was hung up. Try again.',
};

/** Talkr's call statuses that mean the seller's side is over without a conversation. */
export function ringOutReason(status: string | null | undefined): Exclude<RingOutReason, 'never_dialed'> | null {
  const s = (status ?? '').toLowerCase().replace(/[-\s]/g, '_');
  if (s === 'no_answer' || s === 'busy' || s === 'failed' || s === 'canceled') return s;
  if (s === 'cancelled') return 'canceled';
  return null;
}

export type RosterRow = { role: string; state: string };

/**
 * Whether to hang up the rep's leg now.
 *
 * `roster` is null when it was not read (or could not be). An empty roster
 * means the call is not running in a conference room (Twilio, bridge mode),
 * where "no seller row" says nothing, so only a roster with the rep in it
 * and no one else can mean the seller was never dialled.
 */
export function ringVerdict(input: { status: string | null | undefined; roster: RosterRow[] | null; upForMs: number }): RingVerdict | null {
  const over = ringOutReason(input.status);
  if (over) return { reason: over, message: MESSAGES[over] };
  if (input.roster && input.upForMs >= NEVER_DIALED_AFTER_MS) {
    const rep = input.roster.some((p) => p.role === 'agent');
    const anyoneElse = input.roster.some((p) => p.role !== 'agent');
    if (rep && !anyoneElse) return { reason: 'never_dialed', message: MESSAGES.never_dialed };
  }
  return null;
}
