// What happens when a new invite reaches this browser while the rep is
// already on a live call, and which words Talkr speaks when it drops a
// voicemail on a machine by itself.
//
// Never answered. This used to answer the new leg and play the rep's saved
// voicemail drop whenever a power session was running, meant for a second
// dialer line that picked up. Since every list runs as a Talkr parallel
// campaign (Clozr #687), Talkr bridges only the winner and abandons the rest
// server side, so the only invites left here are customers calling the team
// line. On 2026-11-05 three callers to the team line were answered by
// Morgan's browser mid-call, heard his voicemail drop and were hung up, and his
// live call broke. A busy rep now declines; the ring group moves on.

export const DEFAULT_AMD_TEXT = 'Hi, sorry I missed you. Please call me back when you have a minute.';

export type BusyAnswerAction = 'ignore' | 'decline';

/**
 * A new leg while a call is already up.
 * An invite from one of our own numbers is the carrier ringing this browser
 * back for the call we placed — leaving it alone is what keeps that call alive.
 * Anyone else is declined.
 */
export function busyAnswer(input: { ownNumber: boolean }): BusyAnswerAction {
  return input.ownNumber ? 'ignore' : 'decline';
}

/**
 * The script a predictive campaign asks Talkr to speak on a machine.
 * The rep's saved recording wins; otherwise the campaign's existing line;
 * otherwise a short callback.
 */
export function predictiveVoicemailText(existing: string | null | undefined, armedScript: string | null | undefined): string {
  const script = (armedScript ?? '').replace(/\s+/g, ' ').trim();
  if (script) return script.slice(0, 500);
  const prior = (existing ?? '').replace(/\s+/g, ' ').trim();
  if (prior) return prior;
  return DEFAULT_AMD_TEXT;
}
