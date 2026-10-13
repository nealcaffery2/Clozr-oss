/**
 * The opt-out line every first text has to carry.
 *
 * CTIA's messaging principles and every 10DLC campaign we file say the same
 * thing: the first message to a recipient tells them how to stop. Until now
 * only the email path added one (dispo-campaign-tick appends an unsubscribe
 * footer), so texts went out without it and did not match the samples filed
 * with the carriers — which is itself grounds for a campaign to be pulled.
 *
 * Appending here rather than in the message builder keeps it out of the
 * model's hands: dispo-intro is told to write under 240 characters and never
 * sees this line, so it cannot spend its budget on it, drop it, or reword it.
 */

/** What we append. Matches sample1–3 on the filed campaign, word for word. */
export const OPT_OUT_SUFFIX = 'Reply STOP to opt out.';

/**
 * True when the body already tells the reader how to stop, so we do not say it
 * twice. Matches STOP as a word, so "stopped by the property" does not count.
 */
export function hasOptOut(body: string): boolean {
  return /\bSTOP\b/i.test(body) || /\bunsubscribe\b/i.test(body);
}

/**
 * The body as it should go out. Idempotent: a body that already carries an
 * opt-out comes back untouched, so a retry or a hand-written message that says
 * it its own way is left alone.
 */
export function withOptOut(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || hasOptOut(trimmed)) return trimmed;
  return `${trimmed} ${OPT_OUT_SUFFIX}`;
}

/**
 * GSM-03.38 segment count, for the log line that tells a rep why one text cost
 * two. Anything outside the GSM alphabet forces UCS-2, where the limits are 70
 * and 67 instead of 160 and 153.
 */
export function segments(body: string): number {
  // deno-lint-ignore no-control-regex
  const gsm = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\u000c^{}\\[~\]|€]*$/;
  const unicode = !gsm.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const len = [...body].length;
  if (len <= single) return len === 0 ? 0 : 1;
  return Math.ceil(len / multi);
}
