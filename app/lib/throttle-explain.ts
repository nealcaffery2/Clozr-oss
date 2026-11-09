// Why a plan step has not gone out yet, in words a rep can act on. The plan
// tick writes a "Waiting: …" line on the step (supabase/functions/plan-tick);
// this turns that line, or a step simply not due yet, into what is holding it
// and what to do about it.

export type Throttle = { key: string; label: string; why: string; todo: string };

const RULES: { key: string; test: RegExp; label: string; why: string; todo: string }[] = [
  { key: 'hours', test: /sending hours|business hours|outside 8am|quiet hours/i, label: 'Outside sending hours',
    why: 'Texts and emails only go out inside the plan\'s sending hours, and calls and texts only 8am to 9pm in the lead\'s time zone.',
    todo: 'Nothing; it sends when the window opens. To send later in the day, widen Sending hours in the plan settings.' },
  { key: 'line_cap', test: /text line is at its daily cap|line held by Talkr/i, label: 'Text lines at today\'s cap',
    why: 'Each text line sends at most 600 texts a day so carriers do not label it spam.',
    todo: 'It continues tomorrow. To send more today, add text lines in Talkr and turn on Rotate lines in the plan settings.' },
  { key: 'inbox', test: /warmed inbox has room|no cold campaign|warmed list/i, label: 'No warmed inbox room',
    why: 'Cold email goes out from warmed inboxes, each with a daily ramp, so the domains stay out of spam.',
    todo: 'It continues as inboxes free up. To send more, add warmed inboxes in Deliverability.' },
  { key: 'resend', test: /Resend/i, label: 'Email sender not set up',
    why: 'Relationship email goes out through Resend, and this workspace has no working sender.',
    todo: 'Set up the sender in Settings › Email.' },
  { key: 'merge', test: /merge field with no value/i, label: 'Missing merge field',
    why: 'The message uses a field (like {{first_name}}) this person has no value for, and "Hi {{first_name}}" would go out as written.',
    todo: 'Fill the field on the record, or take it out of the step.' },
  { key: 'paused_number', test: /number (is )?paused|sending number is paused/i, label: 'Sending number paused',
    why: 'Number guard paused a line after too many hang-ups or blocks, to keep it from being labelled spam.',
    todo: 'Check the number in Talkr › Numbers; it resumes when the guard clears it.' },
  { key: 'cold', test: /cold number|not opted in or replied|No channel is open/i, label: 'Cold number, no consent',
    why: 'This workspace only reaches people who opted in or replied, unless outreach without consent is switched on.',
    todo: 'The owner can switch on outreach without consent for Compr.' },
  { key: 'slop', test: /^slop:/i, label: 'Wording held (old rule)',
    why: 'An earlier version held messages with bold or em dashes for six hours.',
    todo: 'Nothing now; those are fixed automatically and sent.' },
  { key: 'auto_send', test: /auto.?send/i, label: 'Auto-send is off',
    why: 'This plan is set to make tasks for a rep rather than send on its own.',
    todo: 'Turn on Auto-send in the plan settings.' },
  { key: 'retry', test: /failed|refused|could not|error/i, label: 'Retrying after an error',
    why: 'The last attempt failed; it is tried again in 15 minutes.',
    todo: 'If it keeps failing, open the person and check the number or email.' },
];

const SCHEDULED: Throttle = {
  key: 'scheduled', label: 'Scheduled',
  why: 'This step is not due yet: it follows the delay set on the step.',
  todo: 'Nothing; it goes out when it comes due.',
};

const OTHER = (text: string): Throttle => ({ key: 'other', label: 'Waiting', why: text, todo: 'Open the person to see their timeline.' });

/** What holds one waiting step: from its "Waiting: …" reason, else not due yet. */
export function explainWait(reason: string | null | undefined, dueAt: string | null | undefined, now = Date.now()): Throttle {
  const r = (reason ?? '').replace(/^Waiting:\s*/i, '').trim();
  if (r) {
    const hit = RULES.find((x) => x.test.test(r));
    return hit ? { key: hit.key, label: hit.label, why: hit.why, todo: hit.todo } : OTHER(r);
  }
  if (dueAt && Date.parse(dueAt) > now) return SCHEDULED;
  return { key: 'due', label: 'Due now', why: 'It is due and goes out on the next send, within a minute or two.', todo: 'Nothing.' };
}

/** Waiting steps grouped by what holds them, biggest first. */
export function groupWaits<T extends { reason: string | null; at: string | null }>(rows: readonly T[], now = Date.now()): { t: Throttle; n: number }[] {
  const m = new Map<string, { t: Throttle; n: number }>();
  for (const row of rows) {
    const t = explainWait(row.reason, row.at, now);
    const k = t.key === 'other' ? `other:${t.why}` : t.key;
    const cur = m.get(k);
    if (cur) cur.n++; else m.set(k, { t, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** The limits in force, for "Why is this throttled?". Kept beside the numbers they describe. */
export const LIMITS: { what: string; limit: string }[] = [
  { what: 'Texts per line', limit: '600 a day' },
  { what: 'AI texts per number', limit: '60 an hour' },
  { what: 'AI calls per number', limit: '300 a day' },
  { what: 'Calls, texts, voicemail', limit: '8am to 9pm in the lead\'s time zone' },
  { what: 'Cold email per warmed inbox', limit: 'its daily ramp (5 to 20 a day)' },
  { what: 'Opted-out people', limit: 'never contacted again' },
];
