// The Marketing tab's arithmetic, kept pure so it can be tested
// (tools/dispo-campaign.test.ts): who is in the audience and who is left out,
// what a plan sends, how it is said on the launch button, what a merge field
// will leave behind, and the results funnel. No React, no network.

import type { CampaignResults } from '@/lib/dispo-campaign';
import { type BuyerRow, type Filters, type Settings, filteredOut } from '@/lib/dispo-plan';
import type { PlannedRecipient } from '@/lib/dispo-campaign';
import { localHM } from '@/supabase/functions/_shared/dispo-rules';

// ------------------------------------------------------------------ audience
export type AudienceView = {
  matched: BuyerRow[];
  others: BuyerRow[];
  /** Everyone in the campaign, best first: level, then score (the builder's order). */
  audience: BuyerRow[];
  /** Matched buyers the filters leave out, by reason ("already sent this deal": 243). */
  filtered: [string, number][];
  /** Buyers ticked or unticked by hand. */
  byHand: number;
};

const scoreOf = (r: BuyerRow) => r.match?.score ?? 0;

export function audienceView(rows: BuyerRow[], f: Filters, include: Record<number, boolean>, dealPrice: number | null): AudienceView {
  const isMatched = (r: BuyerRow) => scoreOf(r) >= f.minScore && !!r.match;
  const matched = rows.filter(isMatched);
  const others = rows.filter((r) => !isMatched(r));
  const inAudience = (r: BuyerRow) => include[r.b.id] ?? (isMatched(r) && !filteredOut(r, f, dealPrice));
  const audience = rows.filter(inAudience).sort((a, b) => b.level - a.level || scoreOf(b) - scoreOf(a));
  const counts = new Map<string, number>();
  for (const r of matched) {
    if (include[r.b.id] !== undefined) continue;
    const why = filteredOut(r, f, dealPrice);
    if (why) counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return {
    matched, others, audience,
    filtered: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
    byHand: Object.keys(include).length,
  };
}

// ----------------------------------------------------------------- the plan
/** SMS segments a carrier bills for this body: GSM-7 160/153, anything else UCS-2 70/67. */
export function smsSegments(text: string): number {
  if (!text) return 0;
  const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
  if (GSM.test(text)) {
    const len = Array.from(text).reduce((n, ch) => n + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0);
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  const len = Array.from(text).length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

export type PlanSummary = {
  buyers: number; smsBuyers: number; emailBuyers: number;
  messages: number; texts: number; emails: number; segments: number;
  /** Skipped buyers by reason, most first. */
  skipped: [string, number][];
  skippedTotal: number;
  firstSend: number | null;
  /** Buyers who get a follow-up at all. */
  followupBuyers: number;
};

export function planSummary(plan: { recipients: PlannedRecipient[]; skipped: { why: string }[] }): PlanSummary {
  const msgs = plan.recipients.flatMap((p) => p.messages);
  const texts = msgs.filter((m) => m.channel === 'sms');
  const reasons = new Map<string, number>();
  for (const s of plan.skipped) reasons.set(s.why, (reasons.get(s.why) ?? 0) + 1);
  const times = msgs.map((m) => Date.parse(m.send_at)).filter(Number.isFinite);
  return {
    buyers: plan.recipients.length,
    smsBuyers: plan.recipients.filter((p) => p.messages.some((m) => m.channel === 'sms')).length,
    emailBuyers: plan.recipients.filter((p) => p.messages.some((m) => m.channel === 'email')).length,
    messages: msgs.length, texts: texts.length, emails: msgs.filter((m) => m.channel === 'email').length,
    segments: texts.reduce((n, m) => n + smsSegments(m.body), 0),
    skipped: Array.from(reasons.entries()).sort((a, b) => b[1] - a[1]),
    skippedTotal: plan.skipped.length,
    firstSend: times.length ? Math.min(...times) : null,
    followupBuyers: plan.recipients.filter((p) => p.messages.some((m) => m.kind === 'followup')).length,
  };
}

// ------------------------------------------------------------------- words
const ZONES: Record<string, string> = {
  'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain',
  'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii',
};
/** "Central", or the zone's own short name ("GMT+1") when it is not a US zone. */
export function tzLabel(tz: string): string {
  if (ZONES[tz]) return ZONES[tz];
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch { return tz; }
}

const clock = (t: number, tz: string) => {
  try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }); } catch { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
};

/** "now", "9:00 AM", "tomorrow 9:00 AM", "Thu 9:00 AM" or "Oct 2, 9:00 AM" — in the campaign's zone. */
export function whenLabel(t: number | null, tz: string, now: Date): string {
  if (t == null) return 'now';
  if (t - now.getTime() < 90_000) return 'now';
  const a = localHM(now, tz).date; const b = localHM(new Date(t), tz).date;
  const days = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
  if (days <= 0) return clock(t, tz);
  if (days === 1) return `tomorrow ${clock(t, tz)}`;
  if (days < 7) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][localHM(new Date(t), tz).weekday]} ${clock(t, tz)}`;
  return `${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}, ${clock(t, tz)}`;
}

export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The channel phrase: "by text and email", "by text", "by email". */
export function channelWords(sms: number, email: number): string {
  return sms && email ? 'by text and email' : sms ? 'by text' : email ? 'by email' : '';
}

/** Exactly what the launch button will do: "Send to 60 buyers by text and email, starting 9:00 AM Central". */
export function launchSentence(s: Pick<PlanSummary, 'buyers' | 'smsBuyers' | 'emailBuyers' | 'firstSend'>, tz: string, now: Date): string {
  if (!s.buyers) return 'Nobody to send to';
  const when = whenLabel(s.firstSend, tz, now);
  return `Send to ${plural(s.buyers, 'buyer')} ${channelWords(s.smsBuyers, s.emailBuyers)}, starting ${when === 'now' ? 'now' : `${when} ${tzLabel(tz)}`}`;
}

const span = (n: number, u: 'minutes' | 'hours') => (n === 0 ? 'right away' : `${plural(n, u === 'hours' ? 'hour' : 'minute')}`);

/** "Text after 1 hour with no reply, then email 23 hours later", or why there are none. */
export function cadenceLabel(s: Settings): string {
  const f = s.followups;
  const chans = (f.order === 'sms' ? ['sms', 'email'] : ['email', 'sms'])
    .filter((c) => (c === 'sms' ? f.sms && f.smsList.some((x) => x.trim()) : f.email && f.emailList.some((x) => x.body.trim())));
  if (!chans.length) return 'No follow-ups';
  const word = (c: string) => (c === 'sms' ? 'text' : 'email');
  const first = `${word(chans[0])[0].toUpperCase()}${word(chans[0]).slice(1)} ${f.after === 0 ? 'right away' : `after ${span(f.after, f.afterUnit)}`} with no reply`;
  return chans[1] ? `${first}, then ${word(chans[1])} ${f.wait === 0 ? 'right after' : `${span(f.wait, f.waitUnit)} later`}` : first;
}

// ------------------------------------------------------------- merge fields
const TOKEN = /\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g;
/**
 * What a template's merge fields will do: `unknown` are sent exactly as typed
 * (renderMerge leaves a field nobody knows alone), `blank` are deal fields this
 * deal has no value for, so the words around them close up.
 */
export function mergeCheck(body: string, known: Record<string, string>, dealFields: Record<string, string>): { unknown: string[]; blank: string[] } {
  const names = Array.from(body.matchAll(TOKEN)).map((m) => m[1].toLowerCase());
  const uniq = Array.from(new Set(names));
  return {
    unknown: uniq.filter((n) => known[n] === undefined),
    blank: uniq.filter((n) => dealFields[n] !== undefined && !String(dealFields[n]).trim()),
  };
}

/** The merge field a typo most likely meant: two letters off at most, or the same word without its underscores. */
export function closestField(name: string, known: string[]): string | null {
  const flat = (s: string) => s.replace(/_/g, '');
  const dist = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: [string, number] | null = null;
  for (const k of known) {
    const d = flat(k) === flat(name) ? 0 : dist(name, k);
    if (d <= 2 && (!best || d < best[1])) best = [k, d];
  }
  return best?.[0] ?? null;
}

const tokenRe = (name: string, lead = '') => new RegExp(`${lead}\\{\\{?\\s*${name}\\s*\\}?\\}`, 'gi');
/** A template with a merge field taken out, and the space in front of it. */
export const dropToken = (text: string, name: string) => text.replace(tokenRe(name, '[ \\t]*'), '');
/** An email's HTML with a merge field taken out, and any link that pointed at it, so no dead link goes out. */
export function dropTokenHtml(html: string, name: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => { if (tokenRe(name).test(a.getAttribute('href') ?? '')) a.remove(); });
  return dropToken(htmlLike(html, doc), name);
}
/** A parsed email written back in the shape it came in: a whole document with its doctype, or a fragment. */
export function htmlLike(html: string, doc: Document): string {
  if (!/<html[\s>]/i.test(html)) return doc.head.innerHTML + doc.body.innerHTML;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].trim();
  return (doctype ? `${doctype}\n` : '') + doc.documentElement.outerHTML;
}
/** A template with one merge field swapped for another. */
export const swapToken = (text: string, from: string, to: string) => text.replace(tokenRe(from), `{{${to}}}`);

// ------------------------------------------------------------------ results
export type Funnel = { sent: number; delivered: number; viewed: number | null; replied: number; offers: number; interested: number; optedOut: number };
export type ChannelRow = { ch: 'sms' | 'email' | 'rvm' | 'ai_call'; sent: number; delivered: number | null; replied: number; queued: number; failed: number };
export const CHANNEL_WORD: Record<ChannelRow['ch'], string> = { sms: 'text', email: 'email', rvm: 'voicemail', ai_call: 'AI call' };

/** One campaign's (or every campaign's) funnel, counted in buyers. */
export function funnel(r: Pick<CampaignResults, 'recipients' | 'messages'>, offers: number, viewed: number | null, campaignId?: number): Funnel {
  const rs = campaignId == null ? r.recipients : r.recipients.filter((x) => x.campaign_id === campaignId);
  const ms = campaignId == null ? r.messages : r.messages.filter((x) => x.campaign_id === campaignId);
  const who = (f: (m: CampaignResults['messages'][number]) => boolean) => new Set(ms.filter(f).map((m) => m.recipient_id)).size;
  return {
    sent: who((m) => m.status === 'sent' || m.status === 'delivered'),
    delivered: who((m) => m.status === 'delivered'),
    viewed,
    replied: rs.filter((x) => x.replied_at).length,
    offers,
    interested: rs.filter((x) => ['interested', 'offered'].includes(x.status)).length,
    optedOut: rs.filter((x) => x.status === 'opted_out').length,
  };
}

/** The per-channel table the old results showed, same counting. */
export function channelRows(r: Pick<CampaignResults, 'recipients' | 'messages'>): ChannelRow[] {
  const replied = r.recipients.filter((x) => x.replied_at);
  // Voicemail and AI call rows only when a campaign used them (migration 192).
  const used = new Set(r.messages.map((m) => m.channel));
  return (['sms', 'email', 'rvm', 'ai_call'] as const).filter((ch) => ch === 'sms' || ch === 'email' || used.has(ch)).map((ch) => {
    const mine = r.messages.filter((m) => m.channel === ch);
    const sent = mine.filter((m) => m.status === 'sent' || m.status === 'delivered');
    return {
      ch, queued: mine.filter((m) => m.status === 'queued').length, sent: new Set(sent.map((m) => m.recipient_id)).size,
      delivered: ch === 'sms' ? new Set(mine.filter((m) => m.status === 'delivered').map((m) => m.recipient_id)).size : null,
      replied: replied.filter((x) => x.replied_channel === ch).length, failed: mine.filter((m) => m.status === 'failed').length,
    };
  });
}

export type AddressRow = { from: string; sent: number; failed: number; replied: number };

/**
 * Email results per sending address: buyers each address reached, failures,
 * and email replies credited to the address that sent that buyer's first
 * email. Messages without a known address (before the send was filed) are left out.
 */
export function addressRows(r: Pick<CampaignResults, 'recipients' | 'messages'>): AddressRow[] {
  const rows = new Map<string, AddressRow & { buyers: Set<number> }>();
  const firstFrom = new Map<number, string>();
  const ordered = r.messages.filter((m) => m.channel === 'email' && m.from_email).slice().sort((a, b) => (a.sent_at ?? a.send_at).localeCompare(b.sent_at ?? b.send_at));
  for (const m of ordered) {
    const from = m.from_email!.toLowerCase();
    const row = rows.get(from) ?? { from, sent: 0, failed: 0, replied: 0, buyers: new Set<number>() };
    if (m.status === 'sent' || m.status === 'delivered') {
      row.buyers.add(m.recipient_id);
      if (!firstFrom.has(m.recipient_id)) firstFrom.set(m.recipient_id, from);
    }
    if (m.status === 'failed') row.failed++;
    rows.set(from, row);
  }
  for (const x of r.recipients) {
    if (!x.replied_at || x.replied_channel !== 'email') continue;
    const from = firstFrom.get(x.id);
    const row = from ? rows.get(from) : undefined;
    if (row) row.replied++;
  }
  return [...rows.values()].map(({ buyers, ...row }) => ({ ...row, sent: buyers.size })).sort((a, b) => b.sent - a.sent || a.from.localeCompare(b.from));
}

/** Buyers who answered, newest first, one row per buyer (their latest campaign). */
export function repliedBuyers(r: Pick<CampaignResults, 'recipients'>): CampaignResults['recipients'] {
  const seen = new Set<number>();
  return r.recipients.filter((x) => x.replied_at).sort((a, b) => Date.parse(b.replied_at!) - Date.parse(a.replied_at!))
    .filter((x) => (seen.has(x.buyer_id) ? false : (seen.add(x.buyer_id), true)));
}

export const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
