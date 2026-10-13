// A line's SMS flow (migration 200, line_sms_flows): who its texts notify and
// whether a texter gets an automatic reply. The app edits it; talkr-webhook
// decides each auto-reply with autoReplyFor. No imports, so the edge function
// can load this file as is.

export type SmsDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const SMS_DAYS: SmsDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Open hours in one zone; a day that is missing is closed all day. */
export type SmsHours = { timezone: string; days: Partial<Record<SmsDay, [string, string]>> };

export type SmsFlow = {
  phone_e164: string;
  talkr_number_id: string | null;
  notify_user_ids: string[];
  auto_reply_enabled: boolean;
  auto_reply_body: string | null;
  auto_reply_when: 'always' | 'after_hours';
  hours: SmsHours | null;
  cooldown_hours: number;
};

export const DEFAULT_HOURS: SmsHours = {
  timezone: 'America/Chicago',
  days: { mon: ['09:00', '17:00'], tue: ['09:00', '17:00'], wed: ['09:00', '17:00'], thu: ['09:00', '17:00'], fri: ['09:00', '17:00'] },
};

export function blankSmsFlow(phone: string, talkrNumberId: string | null = null): SmsFlow {
  return {
    phone_e164: phone, talkr_number_id: talkrNumberId, notify_user_ids: [], auto_reply_enabled: false,
    auto_reply_body: 'Thanks for your text! We will get right back to you.', auto_reply_when: 'always', hours: null, cooldown_hours: 24,
  };
}

/** Words that opt a texter out or back in. Never auto-reply to them; the carrier and Talkr answer those. */
const KEYWORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'start', 'unstop', 'subscribe', 'help', 'info']);
export const isKeyword = (body: string | null | undefined) => KEYWORDS.has(String(body ?? '').trim().toLowerCase());

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Weekday and minutes past midnight of `at` in `timeZone`. */
function localClock(at: Date, timeZone: string): { day: SmsDay; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: get('weekday').slice(0, 3).toLowerCase() as SmsDay, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True inside the open hours. No hours at all reads as always open. */
export function isOpen(hours: SmsHours | null | undefined, at: Date): boolean {
  if (!hours) return true;
  let clock: { day: SmsDay; minutes: number };
  try {
    clock = localClock(at, hours.timezone);
  } catch {
    return true;
  }
  const range = hours.days[clock.day];
  if (!range) return false;
  const [from, to] = range;
  return clock.minutes >= mins(from) && clock.minutes < mins(to);
}

export type AutoReply = { send: true; body: string } | { send: false; reason: string };

/**
 * Whether a text that just arrived gets the line's auto-reply. `lastReplyAt`
 * is the last auto-reply this line sent this texter, if any.
 */
export function autoReplyFor(flow: Pick<SmsFlow, 'auto_reply_enabled' | 'auto_reply_body' | 'auto_reply_when' | 'hours' | 'cooldown_hours'> | null | undefined, input: { body: string | null | undefined; at: Date; lastReplyAt?: Date | string | null }): AutoReply {
  if (!flow?.auto_reply_enabled) return { send: false, reason: 'off' };
  const body = String(flow.auto_reply_body ?? '').trim();
  if (!body) return { send: false, reason: 'no message' };
  if (isKeyword(input.body)) return { send: false, reason: 'keyword' };
  if (flow.auto_reply_when === 'after_hours' && isOpen(flow.hours, input.at)) return { send: false, reason: 'open' };
  if (input.lastReplyAt) {
    const last = new Date(input.lastReplyAt).getTime();
    if (Number.isFinite(last) && input.at.getTime() - last < Math.max(0, flow.cooldown_hours) * 3_600_000) return { send: false, reason: 'cooldown' };
  }
  return { send: true, body };
}

/** The flow as it is saved, or the first thing wrong with it. */
export function cleanSmsFlow(f: SmsFlow): { ok: true; flow: SmsFlow } | { ok: false; error: string } {
  const body = (f.auto_reply_body ?? '').trim();
  if (f.auto_reply_enabled && !body) return { ok: false, error: 'Write the auto-reply' };
  if (body.length > 480) return { ok: false, error: 'Keep the auto-reply under 480 characters' };
  const cooldown = Math.round(Number(f.cooldown_hours));
  if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 720) return { ok: false, error: 'Cooldown is 0 to 720 hours' };
  let hours: SmsHours | null = null;
  if (f.auto_reply_enabled && f.auto_reply_when === 'after_hours') {
    if (!f.hours) return { ok: false, error: 'Set the business hours' };
    const days: SmsHours['days'] = {};
    for (const d of SMS_DAYS) {
      const r = f.hours.days[d];
      if (!r) continue;
      if (!HHMM.test(r[0]) || !HHMM.test(r[1]) || mins(r[0]) >= mins(r[1])) return { ok: false, error: `Check ${d[0]!.toUpperCase()}${d.slice(1)}'s hours` };
      days[d] = [r[0], r[1]];
    }
    hours = { timezone: f.hours.timezone || DEFAULT_HOURS.timezone, days };
  } else if (f.hours) {
    hours = f.hours;
  }
  return {
    ok: true,
    flow: { ...f, notify_user_ids: [...new Set(f.notify_user_ids)], auto_reply_body: body || null, cooldown_hours: cooldown, hours },
  };
}

/** "Texts → Morgan · auto-reply after hours" for a line's row. */
export function smsSummary(flow: Pick<SmsFlow, 'notify_user_ids' | 'auto_reply_enabled' | 'auto_reply_when'> | null | undefined, nameOf: (id: string) => string | null): string {
  if (!flow) return 'Default';
  const who = flow.notify_user_ids.map(nameOf).filter((n): n is string => Boolean(n));
  const to = who.length === 0 ? 'Default' : who.length <= 2 ? who.join(', ') : `${who[0]} +${who.length - 1}`;
  if (!flow.auto_reply_enabled) return to;
  return `${to} · auto-reply${flow.auto_reply_when === 'after_hours' ? ' after hours' : ''}`;
}
