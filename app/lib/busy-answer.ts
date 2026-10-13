// What happens when a power or predictive session reaches someone while the
// rep is already on a live call, and which words Talkr speaks when it drops
// a voicemail on a machine by itself.
//
// The browser holds one call. A second answered line that arrives here can
// hear the saved recording (lib/vm-playback.ts playDropOnLeg) and then hang
// up, so the person is not cut off. A line Talkr never offers to this browser
// is still abandoned on the Talkr server — that playback is not an endpoint
// Clozr has.

export const DEFAULT_AMD_TEXT = 'Hi, sorry I missed you. Please call me back when you have a minute.';

export type BusyAnswerAction = 'ignore' | 'drop' | 'decline';

/**
 * A new leg while a call is already up.
 * An invite from one of our own numbers is the carrier ringing this browser
 * back for the call we placed — leaving it alone is what keeps that call alive.
 * With a saved recording, the new leg hears it. Without one, the leg is declined.
 */
export function busyAnswer(input: { ownNumber: boolean; hasDrop: boolean }): BusyAnswerAction {
  if (input.ownNumber) return 'ignore';
  if (input.hasDrop) return 'drop';
  return 'decline';
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
