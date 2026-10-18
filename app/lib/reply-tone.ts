// Whether a reply is worth a rep's attention: a yes, a question, a time to
// talk (good); a no, a stop, a wrong number (bad); or a phone's canned
// "can't talk right now" (auto). The bell's Important view shows only the
// good ones among replies, and only those chime. Pure, so it is tested
// (tools/reply-tone.test.ts).

export type ReplyTone = 'good' | 'bad' | 'auto' | null;

const AUTO = [
  /\bsorry,? i can'?t talk right now\b/,
  /^\s*(in (a )?)?meeting\.?\s*$/,
  /\bi'?m driving\b/,
  /\b(we|i) (just )?missed your call\b/,
  /\bthank you for (contacting|calling|reaching out to)\b/,
  /\bauto(matic|mated)?[- ]?(reply|response|message)\b/,
  /\bout of (the )?office\b/,
  /\bis currently out of office\b/,
  /\breply stop to (unsubscribe|opt out)\b/,
  /\bjust a reminder,? you have an upcoming\b/,
  /^\s*(liked|loved|emphasized|laughed at|disliked) [“"]/,
  /^delivery status notification/,
];

const BAD = [
  /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|remove)\s*[.!]*\s*$/,
  /\bnot interested\b/,
  /\bno,? thank(s| you)\b/,
  /\bno thanks\b/,
  /\b(don'?t|do not|didn'?t|never) (text|call|contact|email|message)\b/,
  /\bstop (texting|calling|contacting|emailing|messaging)\b/,
  /\b(remove|take) me off\b/,
  /\bremove (me|my number)\b/,
  /\bunsubscribe\b/,
  /\bwrong (number|person)\b/,
  /\bleave me alone\b/,
  /\blose (my|this) number\b/,
  /\bi didn'?t sign up\b/,
  /\bnot for sale\b/,
  /\bno longer (interested|in the business|investing|buying)\b/,
  /\b(fuck|f\*+k|scam|spam)\b/,
  /\bwho (is|'?s) this\b/,
  /\bplease don'?t\b/,
  /\bnot (a )?(good )?fit\b/,
  /\bpass\b\.?\s*$/,
  /^\s*no\s*[.!]*\s*$/,
];

const GOOD = [
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely|of course|sounds good|perfect|great)\b/,
  /\bsounds (good|great)\b/,
  /\b(i'?m|i am|we'?re|we are|very) interested\b/,
  /\binterested\b(?!.*\bnot\b)/,
  /\b(call|text|email) me\b/,
  /\b(give me a call|let'?s (talk|chat|connect|do it|set it up))\b/,
  /\bwhen (can|are|is|would)\b/,
  /\bwhat time\b/,
  /\b(schedule|book|set up|setup) (a |the )?(call|demo|time|meeting)\b/,
  /\b(demo|walkthrough|walk-through)\b/,
  /\btell me more\b/,
  /\bsend (me )?(the |some |more )?(info|details|link|report|address|it)\b/,
  /\bhow (much|does it work|do i)\b/,
  /\bplease (text|call|send)\b/,
  /\bi'?m (free|available)\b/,
  /\b(tomorrow|monday|tuesday|wednesday|thursday|friday) (at|works|is good)\b/,
  /^accepted:/,
  /\bhas accepted this invitation\b/,
  /\bi would like\b/,
  /\bcan you (send|call|text)\b/,
];

/** The tone of a reply's words (an SMS body, an email's subject and first lines). */
export function replyTone(text: string | null | undefined): ReplyTone {
  const t = String(text ?? '').toLowerCase().replace(/[’‘]/g, "'").trim();
  if (!t || t === '—') return null;
  if (AUTO.some((r) => r.test(t))) return 'auto';
  if (BAD.some((r) => r.test(t))) return 'bad';
  if (GOOD.some((r) => r.test(t))) return 'good';
  return null;
}

/** Bell categories that are a reply from the other side. */
const REPLY_CATS = new Set(['inbound_sms', 'SMS', 'Email reply']);
export const isReplyCat = (cat: string) => REPLY_CATS.has(cat);

/** Bell categories that are bookkeeping, not something to act on. */
const QUIET_CATS = new Set(['Number health', 'Skip trace', 'RVM', 'System']);

/**
 * The Important view: a reply only when it is a good one; anything else that
 * names you or your work (a mention, a task, a missed call, a contract), not
 * the bookkeeping.
 */
export function isImportant(n: { cat: string; tone?: ReplyTone }): boolean {
  if (isReplyCat(n.cat)) return n.tone === 'good';
  return !QUIET_CATS.has(n.cat);
}
