// The campaign plan: every message for every buyer, in order, with its send
// time. Pure — the builder renders it for review, and launch sends exactly it.

import { fieldsFor, renderMerge, type SendContext } from './sms';
import { renderEmail } from './message-templates';
import type { CampaignBuyer, CampaignData, PlannedMessage, PlannedRecipient } from './dispo-campaign';
import { profileOf } from './dispo-campaign';
import {
  type Frequency, bestReplyTime, chooseIntro, dispoBuyerFields, intoWindow, levelOf, noResponseLastN, probabilityToBuy,
  rotate, smartTime, splitIntro, staggerSeconds,
} from '../supabase/functions/_shared/dispo-rules';
import { isBuyerProspect } from './prospect-lists';
import { isSecretBlacklisted } from './secret-list';

export type Unit = 'minutes' | 'hours';
const ms = (n: number, u: Unit) => Math.max(0, n) * (u === 'hours' ? 3_600_000 : 60_000);

export type Filters = {
  minScore: number; radiusMi: string; city: string; zip: string; priceBandPct: string; strategy: string;
  vipOnly: boolean; excludeTags: string[]; excludeSent: boolean;
};
export const DEFAULT_FILTERS: Filters = { minScore: 55, radiusMi: '', city: '', zip: '', priceBandPct: '', strategy: '', vipOnly: false, excludeTags: [], excludeSent: true };

export type Settings = {
  intro: { mode: 'ai' | 'own' | 'none'; templateBody: string; split: Frequency; emoji: Frequency; instructions: string; tone: string; avoid: string[] };
  variations: { useImage: boolean; imageUrl: string; reserveLevel: number; frequency: 'sometimes' | 'frequently' };
  brief: { order: 'sms' | 'email'; wait: number; waitUnit: Unit; sms: boolean; smsBody: string; email: boolean; emailSubject: string; emailBody: string; emailHtml: string | null; rvm?: boolean; rvmBody?: string;
    /** The voicemail recorded for this push (lib/rvm-recording.ts). Every drop in the push plays it; null drops the script. */
    rvmRecording?: { libraryId: number; path: string; variantGroup: string; seconds: number } | null };
  followups: {
    after: number; afterUnit: Unit; order: 'sms' | 'email'; wait: number; waitUnit: Unit; smart: boolean;
    sms: boolean; smsAi: boolean; smsList: string[]; email: boolean; emailAi: boolean; emailList: { subject: string; body: string }[];
    pauseUnengaged: boolean; unengagedN: number;
  };
  timezone: string;
  startAt: string; // ISO; '' = now
  /**
   * The dispo SOP's first 24 hours: VIP and A-list buyers (vetted VIPs, and
   * anyone who has offered on or closed a deal with us) hear first; the rest
   * of the list starts `hours` later. Off or missing: everyone starts at once.
   */
  vipFirst?: { on: boolean; hours: number };
};

/** A buyer who gets the head start: a VIP, or level 4+ (has offered or closed with us). */
export const isFirstLook = (r: Pick<BuyerRow, 'level'> & { b: Pick<CampaignBuyer, 'vip'> }) => !!r.b.vip || r.level >= 4;

/** Why a buyer does not get a channel (or anything). Null = they do. A hand-picked Genius buyer is on the list because someone added them. */
export function skipWhy(b: CampaignBuyer, channel: 'sms' | 'email' | 'any', handPicked = false): string | null {
  if (b.blacklisted || isSecretBlacklisted(b.tags)) return 'blacklisted';
  if (/inactive/i.test(b.status)) return 'inactive';
  // The AI agent owns a buyer while it is on; the database leaves them out of a launch too.
  if (b.onAgent) return 'on an AI agent';
  if (!handPicked && !b.vetted && !b.vip && isBuyerProspect(b.tags, b.status, b.source)) return 'buyer prospect';
  if (b.tags.some((t) => /^(dnc|do[\s-]?not[\s-]?contact)$/i.test(t))) return 'do not contact';
  if (channel === 'sms') {
    if (!b.phone) return 'no phone';
    if (b.preferredChannel === 'email_only') return 'prefers email only';
  }
  if (channel === 'email') {
    if (!b.email) return 'no email';
    if (b.preferredChannel === 'sms_only') return 'prefers SMS only';
  }
  return null;
}

export type BuyerRow = ReturnType<typeof buyerRow>;
export function buyerRow(b: CampaignBuyer, data: CampaignData) {
  const p = profileOf(b, data);
  const lv = levelOf(p.stats);
  return { b, ...p, level: lv.level, levelLabel: lv.label, probability: probabilityToBuy(p.stats) };
}

/** The filter on the matched list. Returns why a buyer is out, or null. */
export function filteredOut(r: BuyerRow, f: Filters, dealPrice: number | null): string | null {
  if (f.vipOnly && !r.b.vip) return 'not VIP';
  const tags = r.b.tags.map((t) => t.toLowerCase());
  const hit = f.excludeTags.find((t) => tags.includes(t.toLowerCase()));
  if (hit) return `tagged ${hit}`;
  if (f.excludeSent && r.lastSentThisDeal) return 'already sent this deal';
  if (f.strategy && !r.b.strategies.includes(f.strategy)) return 'different strategy';
  if (f.city && ![...r.b.cities, ...r.b.markets].some((c) => c.toLowerCase() === f.city.trim().toLowerCase())) return 'not in that city';
  if (f.zip && !r.b.zips.some((z) => z.startsWith(f.zip.trim()))) return 'not in that zip';
  const radius = Number(f.radiusMi);
  if (f.radiusMi && radius > 0) {
    const d = r.facts.lastPurchase?.distanceMi;
    if (d == null) return 'no location on file';
    if (d > radius) return `last purchase ${d} mi away`;
  }
  const band = Number(f.priceBandPct);
  if (f.priceBandPct && band >= 0 && dealPrice) {
    if (r.b.priceMax != null && r.b.priceMax < dealPrice * (1 - band / 100)) return 'price ceiling below the deal';
    if (r.b.priceMin != null && r.b.priceMin > dealPrice * (1 + band / 100)) return 'price floor above the deal';
  }
  return null;
}

/**
 * A deal brief always carries the deal's page. One written without any link
 * gets {{deal_link}} on the end; renderMerge drops it again for a buyer with
 * no link, so nothing dangles.
 */
export function withDealLink(body: string, sep: string): string {
  if (!body.trim() || /https?:\/\/|\{\{?\s*(deal_link|listing_url|marketing_link|photos_link)\s*\}?\}/i.test(body)) return body;
  return body.replace(/\s+$/, '') + sep + '{{deal_link}}';
}

export type AiText = { intro?: string | null; followSms?: string | null; followEmail?: string | null };

/**
 * `links` maps a buyer id to their signed listing URL (lib/dispo.ts,
 * mintBuyerLinks). A buyer with no link gets an empty {{listing_url}}, which
 * renderMerge closes up rather than leaving a hole — so a template using the
 * tag degrades to a sentence without a link instead of a broken one.
 */
export function fieldsForBuyer(
  r: BuyerRow, dealFields: Record<string, string>, ctx: SendContext, links: Record<string, string> = {},
): Record<string, string> {
  return fieldsFor({
    sellerId: null, name: r.b.name, phone: r.b.phone, email: r.b.email ?? undefined,
    extra: {
      ...dealFields, ...dispoBuyerFields(r.facts), listing_url: links[String(r.b.id)] ?? '',
      // {{deal_link}}: the same page, tracked to this buyer when they have a link.
      deal_link: links[String(r.b.id)] || dealFields.deal_link || '',
    },
  }, ctx, r.b.phone ?? '');
}

/** Does this buyer get an individually written AI intro. */
export const aiIntroFor = (s: Settings, r: BuyerRow) => s.intro.mode === 'ai' && (s.variations.reserveLevel <= 0 || r.level >= s.variations.reserveLevel);

export function buildPlan(
  rows: BuyerRow[], s: Settings, dealFields: Record<string, string>, ctx: SendContext, data: CampaignData,
  ai: Record<number, AiText>, overrides: Record<string, { body: string; subject?: string }>, now: Date,
  links: Record<string, string> = {},
  handPicked: number[] = [],
): { recipients: (PlannedRecipient & { row: BuyerRow })[]; skipped: { name: string; why: string }[] } {
  const tz = s.timezone;
  const picked = new Set(handPicked);
  const why = (b: CampaignBuyer, channel: 'sms' | 'email' | 'any') => skipWhy(b, channel, picked.has(b.id));
  const start = Math.max(now.getTime(), s.startAt ? Date.parse(s.startAt) : 0);
  // No VIP or A-list buyer on the list: nobody to go first, so nobody waits.
  const headStart = s.vipFirst?.on && s.vipFirst.hours > 0 && rows.some(isFirstLook) ? s.vipFirst.hours * 3_600_000 : 0;
  // Two lanes: VIP and A-list from the start, everyone else after the head start.
  const clocks = { first: start, rest: start + headStart };
  const skipped: { name: string; why: string }[] = [];
  const recipients: (PlannedRecipient & { row: BuyerRow })[] = [];
  rows.forEach((r, i) => {
    const whyAny = why(r.b, 'any');
    if (whyAny) { skipped.push({ name: r.b.name, why: whyAny }); return; }
    const canSms = !why(r.b, 'sms');
    const canEmail = !why(r.b, 'email');
    const f = fieldsForBuyer(r, dealFields, ctx, links);
    const msgs: PlannedMessage[] = [];
    const key = (m: Pick<PlannedMessage, 'kind' | 'channel' | 'seq'>) => `${r.b.id}:${m.kind}:${m.channel}:${m.seq}`;
    const push = (m: PlannedMessage) => {
      const o = overrides[key(m)];
      msgs.push(o ? { ...m, body: o.body, subject: o.subject ?? m.subject, body_html: o.body !== m.body ? null : m.body_html } : m);
    };
    const at = (t: number) => intoWindow(new Date(t), tz);
    const lane: keyof typeof clocks = headStart && isFirstLook(r) ? 'first' : 'rest';
    const t0 = at(clocks[lane]).getTime();
    let cursor = t0;

    // Intro (texts only).
    if (s.intro.mode !== 'none' && canSms) {
      let text: string;
      const written = aiIntroFor(s, r) ? ai[r.b.id]?.intro : null;
      if (written) text = written;
      else text = renderMerge(chooseIntro(s.intro.templateBody, f).body, f);
      const parts = splitIntro(text, s.intro.split, r.b.id);
      parts.forEach((p, j) => push({
        channel: 'sms', kind: 'intro', seq: j, subject: null, body: p, body_html: null,
        media_urls: j === 0 && s.variations.useImage && s.variations.imageUrl ? [s.variations.imageUrl] : [],
        send_at: new Date(cursor + j * 30_000).toISOString(), only_if_no_reply: false,
      }));
      if (parts.length) cursor += 5 * 60_000;
    }

    // Deal brief: first channel, then the other after the wait.
    const briefs: ('sms' | 'email')[] = (s.brief.order === 'sms' ? ['sms', 'email'] : ['email', 'sms'])
      .filter((c) => (c === 'sms' ? s.brief.sms && canSms : s.brief.email && canEmail)) as ('sms' | 'email')[];
    let lastBrief = cursor;
    briefs.forEach((c, j) => {
      const when = at(cursor + (j ? ms(s.brief.wait, s.brief.waitUnit) : 0)).getTime();
      lastBrief = when;
      if (c === 'sms') push({ channel: 'sms', kind: 'brief', seq: 0, subject: null, body: renderMerge(withDealLink(s.brief.smsBody, ' '), f), body_html: null, media_urls: [], send_at: new Date(when).toISOString(), only_if_no_reply: false });
      else {
        const e = renderEmail({ subject: s.brief.emailSubject, body_html: s.brief.emailHtml, body_text: s.brief.emailHtml ? s.brief.emailBody : withDealLink(s.brief.emailBody, '\n\n') }, f);
        push({ channel: 'email', kind: 'brief', seq: 0, subject: e.subject, body: e.text, body_html: e.html, media_urls: [], send_at: new Date(when).toISOString(), only_if_no_reply: false });
      }
    });

    // Follow-ups, only after no reply.
    const sentDeals = data.matches.filter((m) => m.buyer_id === r.b.id && m.sent_at).map((m) => ({ dealId: m.deal_id, sentAt: m.sent_at as string, repliedAt: m.replied_at, status: m.status }));
    const unengaged = s.followups.pauseUnengaged && noResponseLastN(sentDeals, s.followups.unengagedN);
    if (r.b.wantsFollowUps && !unengaged) {
      const best = s.followups.smart ? bestReplyTime(data.inbound.filter((x) => x.buyer_id === r.b.id).map((x) => x.occurred_at), tz) : null;
      const fus: ('sms' | 'email')[] = (s.followups.order === 'sms' ? ['sms', 'email'] : ['email', 'sms'])
        .filter((c) => (c === 'sms' ? s.followups.sms && canSms && s.followups.smsList.some((x) => x.trim()) : s.followups.email && canEmail && s.followups.emailList.some((x) => x.body.trim()))) as ('sms' | 'email')[];
      let base = lastBrief + ms(s.followups.after, s.followups.afterUnit);
      fus.forEach((c, j) => {
        if (j) base += ms(s.followups.wait, s.followups.waitUnit);
        const when = at(smartTime(new Date(base), best, tz).getTime()).getTime();
        if (c === 'sms') {
          const tpl = rotate(s.followups.smsList.filter((x) => x.trim()), i) ?? '';
          const body = (s.followups.smsAi && ai[r.b.id]?.followSms) || renderMerge(tpl, f);
          push({ channel: 'sms', kind: 'followup', seq: 0, subject: null, body, body_html: null, media_urls: [], send_at: new Date(when).toISOString(), only_if_no_reply: true });
        } else {
          const tpl = rotate(s.followups.emailList.filter((x) => x.body.trim()), i) ?? { subject: '', body: '' };
          const e = renderEmail({ subject: tpl.subject || 'Following up: {{address}}', body_html: null, body_text: tpl.body }, f);
          const body = (s.followups.emailAi && ai[r.b.id]?.followEmail) || e.text;
          push({ channel: 'email', kind: 'followup', seq: 0, subject: e.subject, body, body_html: null, media_urls: [], send_at: new Date(when).toISOString(), only_if_no_reply: true });
        }
      });
    }

    if (!msgs.length) { skipped.push({ name: r.b.name, why: !canSms && !canEmail ? `${why(r.b, 'sms')} / ${why(r.b, 'email')}` : 'no channel switched on for them' }); return; }
    msgs.sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
    recipients.push({ row: r, buyer_id: r.b.id, level: r.level, probability: r.probability, messages: msgs });
    if (canSms && (s.intro.mode !== 'none' || s.brief.sms)) clocks[lane] = t0 + staggerSeconds(s.variations.frequency, r.b.id) * 1000;
  });
  return { recipients, skipped };
}

export const messageKey = (buyerId: number, m: Pick<PlannedMessage, 'kind' | 'channel' | 'seq'>) => `${buyerId}:${m.kind}:${m.channel}:${m.seq}`;
