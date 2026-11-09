/**
 * Bulk SMS campaigns (migration 368), the pure half: which pending
 * recipients go in the next batch, when each text is due in the recipient's
 * own time zone, which template and which line it gets, and when the batch
 * after it is due. No network, no Deno. Imported by scheduled-send (the
 * expander) and by tools/sms-campaign.test.ts.
 */
import { nextRecipientWindow, zoneForState, type ColdWindow } from './cold-campaign.ts';

export type CampaignPlanInput = {
  id: number;
  tz: string;
  start_at: string | null;
  send_all_at_once: boolean;
  batch_size: number;
  batch_every_minutes: number;
  window_start: number;
  window_end: number;
  window_days: number[];
  template_ids: number[];
  from_numbers: string[];
  /** Recipients already placed, so rotation carries on where it left off. */
  placed: number;
};

export type PendingRecipient = { id: number; seller_id: number | null; buyer_id?: number | null; phone: string; state: string | null; fields: Record<string, string> };
export type Template = { id: number; body: string };

export type PlannedSend = {
  recipient_id: number; seller_id: number | null; buyer_id: number | null; phone: string; from_number: string; template_id: number; body: string; send_at: string;
};
export type BatchPlan = {
  rows: PlannedSend[];
  /** Recipients skipped this batch because every line is at its daily cap; they stay pending. */
  capped: number;
  /** When the expander should look again: null when nothing is pending. */
  next_batch_at: string | null;
};

/** {{first_name}} or {first_name}; an unknown field is left as typed (same rule as lib/sms renderMerge). */
export function renderMerge(body: string, fields: Record<string, string>): string {
  return body.replace(/\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g, (whole, name: string) => {
    const v = fields[name.toLowerCase()];
    return v === undefined ? whole : v;
  }).replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

/** The {{fields}} a body names that no recipient has. */
export function unknownFields(body: string, known: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g)) if (!known.includes(m[1].toLowerCase())) out.add(m[1]);
  return [...out];
}

export const windowOf = (c: Pick<CampaignPlanInput, 'window_start' | 'window_end' | 'window_days'>): ColdWindow =>
  ({ start: c.window_start, end: c.window_end, days: c.window_days.length ? c.window_days : [0, 1, 2, 3, 4, 5, 6] });

/** The first moment at or after `after` inside the window, in the recipient's zone. */
export function dueAt(after: Date, c: CampaignPlanInput, state: string | null): Date | null {
  return nextRecipientWindow(after, zoneForState(state, c.tz), windowOf(c));
}

/**
 * The next batch. Lines rotate per recipient, templates rotate per
 * recipient, both continuing from how many were placed before. A line that
 * has reached `cap` today is skipped; when every line is capped the rest
 * waits for the next look (an hour on).
 */
export function planBatch(c: CampaignPlanInput, pending: PendingRecipient[], templates: Template[], sentToday: Record<string, number>, cap: number, now: Date): BatchPlan {
  const lines = c.from_numbers.filter(Boolean);
  const tpls = c.template_ids.map((id) => templates.find((t) => t.id === id)).filter((t): t is Template => !!t);
  if (!lines.length || !tpls.length) return { rows: [], capped: pending.length, next_batch_at: null };
  const start = c.start_at ? new Date(Math.max(now.getTime(), Date.parse(c.start_at))) : now;
  const used = { ...sentToday };
  const take = c.send_all_at_once ? pending : pending.slice(0, c.batch_size);
  const rows: PlannedSend[] = [];
  let capped = 0;
  let latest = start;
  for (const r of take) {
    const n = c.placed + rows.length;
    // The first line under its cap, starting from the one whose turn it is.
    let line: string | null = null;
    for (let k = 0; k < lines.length; k++) {
      const cand = lines[(n + k) % lines.length];
      if ((used[cand] ?? 0) < cap) { line = cand; break; }
    }
    if (!line) { capped++; continue; }
    const when = dueAt(start, c, r.state);
    if (!when) { capped++; continue; }
    used[line] = (used[line] ?? 0) + 1;
    const t = tpls[n % tpls.length];
    if (when > latest) latest = when;
    rows.push({ recipient_id: r.id, seller_id: r.seller_id, buyer_id: r.buyer_id ?? null, phone: r.phone, from_number: line, template_id: t.id, body: renderMerge(t.body, r.fields), send_at: when.toISOString() });
  }
  const left = pending.length - rows.length;
  let next: string | null = null;
  if (left > 0) {
    next = capped && !rows.length
      ? new Date(now.getTime() + 60 * 60_000).toISOString()
      : new Date(latest.getTime() + c.batch_every_minutes * 60_000).toISOString();
  } else if (take.length < pending.length) {
    next = new Date(latest.getTime() + c.batch_every_minutes * 60_000).toISOString();
  }
  return { rows, capped, next_batch_at: next };
}

/** How long the whole list takes at this cadence: "about 3 hours", "about 2 days". */
export function estimateSpan(total: number, c: Pick<CampaignPlanInput, 'batch_size' | 'batch_every_minutes' | 'send_all_at_once' | 'window_start' | 'window_end'>): string {
  if (c.send_all_at_once || total <= c.batch_size) return 'within the first window';
  const batches = Math.ceil(total / c.batch_size) - 1;
  const minutes = batches * c.batch_every_minutes;
  const perDay = Math.max(1, c.window_end - c.window_start) * 60;
  if (minutes < 60) return `about ${minutes} minutes`;
  if (minutes < perDay) return `about ${Math.round(minutes / 60)} hours`;
  return `about ${Math.ceil(minutes / perDay)} days`;
}
