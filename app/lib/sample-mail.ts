// The sample graph's email with one person, as the rows the Gmail-style views
// read (app/components/inbox/data.ts EmailRow). The demo has no Gmail sync, so
// the dialer's Email tab builds its history from what the sample record
// already says: the timeline's full emails where it has them (Kara Mitchell's),
// otherwise the one-line email entries on the record. Pure, so it is tested
// (tools/sample-mail.test.ts).

import type { Communication, TimelineEntry } from './clozr-types';

/** The fields of an EmailRow this builds; the type itself lives with the inbox. */
export type SampleEmailRow = {
  id: number; seller_id: number | null; buyer_id: number | null; deal_id: number | null;
  direction: 'inbound' | 'outbound'; occurred_at: string;
  subject: string | null; body: string | null; preview: string | null;
  from_email: string | null; to_email: string | null; status: string | null;
  source: string; source_id: string;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A sample stamp ("Today 9:42 AM", "Yesterday 3:52 PM", "Aug 23 · 10:04 AM",
 * "Sept 2 · 9:15 AM") as an ISO time, read against `now`. A month-day later
 * than today is last year's. Anything else falls back to `now`.
 */
export function sampleStampIso(label: string, now: Date = new Date()): string {
  const t = label.trim();
  const clock = (h: string, m: string, ap: string) => {
    let hour = Number(h) % 12;
    if (/pm/i.test(ap)) hour += 12;
    return [hour, Number(m)] as const;
  };
  const rel = /^(today|yesterday)\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (rel) {
    const d = new Date(now);
    if (/yesterday/i.test(rel[1]!)) d.setDate(d.getDate() - 1);
    const [h, m] = clock(rel[2]!, rel[3]!, rel[4]!);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  const abs = /^([a-z]+)\.?\s+(\d{1,2})\s*(?:·|,)?\s*(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (abs) {
    const month = MONTHS.indexOf(abs[1]!.slice(0, 3).toLowerCase());
    if (month >= 0) {
      const [h, m] = clock(abs[3]!, abs[4]!, abs[5]!);
      const d = new Date(now.getFullYear(), month, Number(abs[2]), h, m);
      if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
      return d.toISOString();
    }
  }
  return now.toISOString();
}

/**
 * The person's sample email, newest first. `timeline` carries full messages
 * (subject, both addresses, the body); `comms` are the record's one-line email
 * entries, used when the timeline has none, with `ts` as minutes ago.
 */
export function sampleEmailRows(
  who: { email: string; sellerId?: number | null; buyerId?: number | null; mine?: string },
  timeline: readonly TimelineEntry[],
  comms: readonly Communication[],
  now: Date = new Date(),
): SampleEmailRow[] {
  const mine = who.mine ?? 'you@yourcompany.com';
  const them = who.email.trim().toLowerCase();
  const base = { seller_id: who.sellerId ?? null, buyer_id: who.buyerId ?? null, deal_id: null, status: 'sent', source: 'sample' };
  const full = timeline.filter((t) => t.email && (t.email.from.toLowerCase() === them || t.email.to.some((a) => a.toLowerCase() === them)));
  const rows: SampleEmailRow[] = full.length
    ? full.map((t, i) => {
      const e = t.email!;
      return {
        ...base, id: -(i + 1), direction: e.inbound ? 'inbound' : 'outbound', occurred_at: sampleStampIso(t.time, now),
        subject: e.subject, body: e.body, preview: null,
        from_email: e.from, to_email: e.to.join(', '), source_id: `sample:${t.id}`,
      };
    })
    : comms.filter((c) => c.channel === 'email').map((c, i) => {
      const inbound = c.dir === 'in';
      // The entry is one line: a quoted title when it has one, else the line itself.
      const quoted = /^"([^"]+)"/.exec(c.preview)?.[1];
      const re = /^(re:\s*[^—-]+)[—-]/i.exec(c.preview)?.[1]?.trim();
      const subject = quoted ?? re ?? c.preview.split(/[—.]/)[0]!.trim();
      return {
        ...base, id: -(i + 1), direction: inbound ? 'inbound' : 'outbound',
        occurred_at: new Date(now.getTime() - c.ts * 60_000).toISOString(),
        subject, body: c.preview, preview: c.preview,
        from_email: inbound ? them : mine, to_email: inbound ? mine : them, source_id: `sample:${c.id}`,
      };
    });
  return rows.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
}
