// The deterministic buyer score: what buyer-score stores when AI is off or
// fails, and the counts Claude starts from when it is on. No I/O, so it runs
// under Deno and under node --experimental-strip-types for the test.

// deno-lint-ignore no-explicit-any
type Any = any;

export type History = {
  buyer: { name?: string; company?: string | null; status?: string; buyer_type?: string | null; created_at?: string; vip?: boolean; vetted_at?: string | null };
  comms: { channel?: string; direction?: string; occurred_at?: string; body?: string | null; summary?: string | null; subject?: string | null; status?: string | null }[];
  offers: { amount?: number | null; status?: string | null; sent_at?: string | null; direction?: string | null; responded_at?: string | null }[];
  deals: { stage?: string; closed_on?: string | null; close_date?: string | null; sold_price?: number | null }[];
  matches: { status?: string | null; sent_at?: string | null; viewed_at?: string | null; replied_at?: string | null }[];
};

export type RuleScore = { response_rate: number | null; score: number; reason: string; stats: Record<string, Any> };

const WINDOW_MS = 7 * 864e5;
/** Opt-outs and bounces are not answers. */
const NOT_AN_ANSWER = /^\s*(stop|unsubscribe|end|quit|cancel|stopall)\b|wrong number/i;

const t = (s: string | null | undefined) => Date.parse(s ?? '');

/** Rows that never reach the buyer: a note is the team writing to itself, not a touch. */
const NOT_A_TOUCH = /^(note|task|system|activity)$/i;

export function ruleScore(h: History, now = Date.now()): RuleScore {
  const real = h.comms.filter((c) => !NOT_A_TOUCH.test(String(c.channel ?? '')));
  const out = real.filter((c) => c.direction === 'outbound' && Number.isFinite(t(c.occurred_at)));
  const answers = real.filter((c) => c.direction === 'inbound' && Number.isFinite(t(c.occurred_at))
    && !NOT_AN_ANSWER.test(String(c.body ?? '')));
  const inboundAt = answers.map((c) => t(c.occurred_at)).sort((a, b) => a - b);
  // A touch counts as answered when the buyer wrote or called back within 7 days.
  const answered = (at: number) => inboundAt.some((x) => x > at && x - at <= WINDOW_MS);
  const touches = out.map((c) => t(c.occurred_at));
  const sends = h.matches.filter((m) => Number.isFinite(t(m.sent_at)));
  let touchCount = touches.length;
  let answeredCount = touches.filter(answered).length;
  for (const m of sends) {
    touchCount++;
    if (m.replied_at || answered(t(m.sent_at))) answeredCount++;
  }
  const response_rate = touchCount ? Math.round((answeredCount / touchCount) * 100) : null;
  const offers = h.offers.length;
  const closed = h.deals.filter((d) => /closed/i.test(d.stage ?? '')).length;
  const lastReply = inboundAt.length ? inboundAt[inboundAt.length - 1] : null;
  const daysSince = lastReply ? Math.floor((now - lastReply) / 864e5) : null;

  const recency = daysSince == null ? 0 : daysSince <= 30 ? 10 : daysSince <= 90 ? 5 : 0;
  const score = Math.max(0, Math.min(100, Math.round(
    (response_rate ?? 0) * 0.4 + Math.min(offers, 5) * 5 + Math.min(closed, 3) * (25 / 3) + recency,
  )));

  const bits: string[] = [];
  bits.push(touchCount ? `Answered ${answeredCount} of ${touchCount} touches` : 'Nothing sent yet');
  if (offers) bits.push(`${offers} offer${offers === 1 ? '' : 's'}`);
  if (closed) bits.push(`${closed} closed deal${closed === 1 ? '' : 's'}`);
  if (daysSince != null) bits.push(`last reply ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}`);
  return {
    response_rate,
    score,
    reason: bits.join(', ') + '.',
    stats: { touches: touchCount, answered: answeredCount, deal_sends: sends.length, inbound: answers.length, offers, closed, days_since_reply: daysSince },
  };
}
