// The one-screen campaign: pick who, pick the channels, pick a recipe, read
// the copy, launch. The plan is built here, pure, from a preset's steps
// (migration 192 dispo_campaign_presets), so tools/quick-campaign.test.ts can
// run it; the screen (components/dispo-campaign/QuickCampaign.tsx) only
// renders and launches. Text and email go out exactly as the full builder's
// would (same merge fields, same send window, same stagger); a voicemail and
// an AI call are two more steps the tick knows how to send.

import { renderMerge, type SendContext } from './sms';
import { renderEmail } from './message-templates';
import type { CampaignData, PlannedMessage, PlannedRecipient } from './dispo-campaign';
import { type AiText, type BuyerRow, fieldsForBuyer, skipWhy, withDealLink } from './dispo-plan';
import { intoWindow, staggerSeconds } from '../supabase/functions/_shared/dispo-rules';
import { supabase } from './supabase';

export type Channel = 'sms' | 'email' | 'rvm' | 'ai_call';
export const CHANNELS: Channel[] = ['sms', 'email', 'rvm', 'ai_call'];
export const CHANNEL_LABEL: Record<Channel, string> = { sms: 'Text', email: 'Email', rvm: 'Voicemail', ai_call: 'AI call' };

export type Step = { channel: Channel; kind: 'intro' | 'brief' | 'followup'; after_hours: number; only_if_no_reply?: boolean };
export type Preset = { key: string; name: string; blurb: string; steps: Step[]; builtin: boolean };

/** The recipes migration 192 seeds, so the screen works before the table is applied. */
export const BUILTIN_PRESETS: Preset[] = [
  { key: 'machine', name: 'Full machine', blurb: 'Text, email, voicemail and an AI call over four days. Stops the moment they reply.', builtin: true, steps: [
    { channel: 'sms', kind: 'intro', after_hours: 0 }, { channel: 'email', kind: 'brief', after_hours: 0.1 }, { channel: 'sms', kind: 'brief', after_hours: 1 },
    { channel: 'rvm', kind: 'brief', after_hours: 3, only_if_no_reply: true }, { channel: 'sms', kind: 'followup', after_hours: 22, only_if_no_reply: true },
    { channel: 'ai_call', kind: 'followup', after_hours: 26, only_if_no_reply: true }, { channel: 'email', kind: 'followup', after_hours: 48, only_if_no_reply: true },
  ] },
  { key: 'blast', name: 'Quick blast', blurb: 'One text and one email now, one text follow-up tomorrow.', builtin: true, steps: [
    { channel: 'sms', kind: 'brief', after_hours: 0 }, { channel: 'email', kind: 'brief', after_hours: 0.1 }, { channel: 'sms', kind: 'followup', after_hours: 24, only_if_no_reply: true },
  ] },
  { key: 'email', name: 'Email only', blurb: 'The deal by email, then one follow-up email after two days.', builtin: true, steps: [
    { channel: 'email', kind: 'brief', after_hours: 0 }, { channel: 'email', kind: 'followup', after_hours: 48, only_if_no_reply: true },
  ] },
  { key: 'calls', name: 'Voice first', blurb: 'Voicemail now, AI call after an hour, text the link, email the details.', builtin: true, steps: [
    { channel: 'rvm', kind: 'brief', after_hours: 0 }, { channel: 'ai_call', kind: 'brief', after_hours: 1, only_if_no_reply: true },
    { channel: 'sms', kind: 'brief', after_hours: 1.5, only_if_no_reply: true }, { channel: 'email', kind: 'brief', after_hours: 2 },
  ] },
];

const isChannel = (v: unknown): v is Channel => typeof v === 'string' && (CHANNELS as string[]).includes(v);
const isKind = (v: unknown): v is Step['kind'] => v === 'intro' || v === 'brief' || v === 'followup';

/** A preset row's steps, every bound enforced. */
export function parseSteps(v: unknown): Step[] {
  const list = Array.isArray(v) ? v : [];
  const out: Step[] = [];
  for (const x of list) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (!isChannel(o.channel) || !isKind(o.kind)) continue;
    const after = Number(o.after_hours);
    out.push({ channel: o.channel, kind: o.kind, after_hours: Number.isFinite(after) ? Math.min(24 * 30, Math.max(0, after)) : 0, only_if_no_reply: o.only_if_no_reply === true || (o.only_if_no_reply !== false && o.kind === 'followup') });
    if (out.length >= 20) break;
  }
  return out;
}

export async function loadPresets(workspaceId: number): Promise<Preset[]> {
  if (!supabase) return BUILTIN_PRESETS;
  const { data, error } = await supabase.from('dispo_campaign_presets').select('key, name, blurb, steps, workspace_id, position').or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order('position');
  if (error || !data?.length) return BUILTIN_PRESETS;
  const rows = data.map((r) => ({ key: String(r.key), name: String(r.name), blurb: String(r.blurb ?? ''), steps: parseSteps(r.steps), builtin: r.workspace_id == null })).filter((p) => p.steps.length);
  // A workspace recipe with a built-in's key replaces it.
  const byKey = new Map<string, Preset>();
  for (const p of rows) if (!byKey.has(p.key) || !p.builtin) byKey.set(p.key, p);
  return byKey.size ? [...byKey.values()] : BUILTIN_PRESETS;
}

/** What goes out on each channel. Edited inline on the screen; merge fields as in the full builder. */
export type QuickCopy = {
  intro: string; sms: string; emailSubject: string; email: string; emailHtml: string | null;
  rvm: string; call: string; followSms: string; followEmailSubject: string; followEmail: string;
};

const SMS_BRIEF = 'Hi {{first_name}}, new deal: {{address}}, {{city}} at {{price}}. {{purchase_note}} Photos and numbers: {{deal_link}} Reply YES for details.';
const INTRO = 'Hey {{first_name}}, it\'s {{rep_first_name}} with {{company}}. {{purchase_note}} We just got one near there, ok if I send it over?';
const EMAIL_SUBJECT = 'New deal: {{address}} · {{price}}';
const EMAIL_BRIEF = 'Hi {{first_name}},\n\nWe just got {{address}}, {{city}} under contract at {{price}} ({{beds}} bd / {{baths}} ba). {{purchase_note}}\n\nPhotos, numbers and the offer form: {{deal_link}}\n\nReply if you want the details or a walkthrough.';
const RVM = 'Hi {{first_name}}, this is {{rep_first_name}} with {{company}}. We just picked up a deal at {{address}} in {{city}}, {{beds}} bed {{baths}} bath, asking {{price}}. I texted you the photos and numbers. Call me back when you have a minute.';
const CALL = 'We just got {{address}}, {{city}} under contract at {{price}} ({{beds}} bed, {{baths}} bath). {{purchase_note}} Ask if they want the photos and numbers texted over, whether they would like to walk it, and if they are buying right now. If they are interested, say the dispo rep will call them back today with the details.';
const FOLLOW_SMS = 'Hey {{first_name}}, {{rep_first_name}} again. Still have {{address}} available. Want the numbers? {{deal_link}}';
const FOLLOW_EMAIL = 'Hi {{first_name}},\n\nFollowing up on {{address}}, {{city}}: it is still available at {{price}}. The photos and numbers are here: {{deal_link}}\n\nHappy to set up a walkthrough.';

/** The copy a workspace's templates give, the same picks the full builder makes, with these fallbacks. */
export function defaultCopy(templates: CampaignData['templates']): QuickCopy {
  const by = (name: string) => templates.find((t) => t.name === name);
  const intros = templates.filter((t) => t.category === 'dispo-intro' && t.channel === 'sms');
  const intro = intros.find((t) => /purchase_note/.test(t.body_text)) ?? intros[0];
  const sms = by('Dispo · New deal text');
  const emails = templates.filter((t) => t.channel === 'email' && (t.category === 'dispo-blast' || t.category === 'dispo'))
    .sort((a, b) => (a.category === 'dispo-blast' ? (/acme homes/i.test(a.name) ? 0 : 1) : 2) - (b.category === 'dispo-blast' ? (/acme homes/i.test(b.name) ? 0 : 1) : 2));
  const email = emails[0];
  const fs = templates.find((t) => t.category === 'dispo-followup' && t.channel === 'sms');
  const fe = templates.find((t) => t.category === 'dispo-followup' && t.channel === 'email');
  return {
    intro: intro?.body_text ?? INTRO, sms: sms?.body_text ?? SMS_BRIEF,
    emailSubject: email?.subject ?? EMAIL_SUBJECT, email: email?.body_text ?? EMAIL_BRIEF, emailHtml: email?.body_html ?? null,
    rvm: RVM, call: CALL, followSms: fs?.body_text ?? FOLLOW_SMS, followEmailSubject: fe?.subject ?? 'Following up: {{address}}', followEmail: fe?.body_text ?? FOLLOW_EMAIL,
  };
}

export type QuickInput = {
  rows: BuyerRow[]; preset: Preset; channels: Record<Channel, boolean>; copy: QuickCopy;
  dealFields: Record<string, string>; ctx: SendContext; data: CampaignData; links: Record<string, string>;
  ai: Record<number, AiText>; aiIntro: boolean; tz: string; now: Date; startAt?: string | null; handPicked?: number[];
};

/** Why a buyer does not get a voicemail or a call. Null = they do. */
export function skipVoice(b: BuyerRow['b']): string | null {
  if (!b.phone) return 'no phone';
  if (b.preferredChannel === 'email_only') return 'prefers email only';
  return null;
}

/**
 * The plan: every buyer, every step the recipe has and the channels allow,
 * timed from the start into the send window with the same stagger the full
 * builder uses. A step a buyer cannot take (no email, email only, no phone)
 * is dropped for them; a buyer with no step at all is skipped and says why.
 */
export function buildQuickPlan(i: QuickInput): { recipients: (PlannedRecipient & { row: BuyerRow })[]; skipped: { name: string; why: string }[]; steps: Step[] } {
  const steps = i.preset.steps.filter((s) => i.channels[s.channel]);
  const picked = new Set(i.handPicked ?? []);
  let clock = Math.max(i.now.getTime(), i.startAt ? Date.parse(i.startAt) : 0);
  const recipients: (PlannedRecipient & { row: BuyerRow })[] = [];
  const skipped: { name: string; why: string }[] = [];
  i.rows.forEach((r) => {
    const whyAny = skipWhy(r.b, 'any', picked.has(r.b.id));
    if (whyAny) { skipped.push({ name: r.b.name, why: whyAny }); return; }
    const can: Record<Channel, string | null> = { sms: skipWhy(r.b, 'sms', true), email: skipWhy(r.b, 'email', true), rvm: skipVoice(r.b), ai_call: skipVoice(r.b) };
    const f = fieldsForBuyer(r, i.dealFields, i.ctx, i.links);
    const t0 = intoWindow(new Date(clock), i.tz).getTime();
    const msgs: PlannedMessage[] = [];
    const seq: Record<string, number> = {};
    for (const s of steps) {
      if (can[s.channel]) continue;
      if (s.kind === 'followup' && !r.b.wantsFollowUps) continue;
      const when = intoWindow(new Date(t0 + s.after_hours * 3_600_000), i.tz).toISOString();
      const k = `${s.kind}:${s.channel}`; const n = seq[k] ?? 0; seq[k] = n + 1;
      const base = { kind: s.kind, seq: n, send_at: when, only_if_no_reply: s.only_if_no_reply === true, media_urls: [] as string[], body_html: null as string | null, subject: null as string | null };
      if (s.channel === 'sms') {
        const text = s.kind === 'intro' ? ((i.aiIntro && i.ai[r.b.id]?.intro) || renderMerge(i.copy.intro, f)) : s.kind === 'brief' ? renderMerge(withDealLink(i.copy.sms, ' '), f) : ((i.aiIntro && i.ai[r.b.id]?.followSms) || renderMerge(withDealLink(i.copy.followSms, ' '), f));
        msgs.push({ ...base, channel: 'sms', body: text });
      } else if (s.channel === 'email') {
        const e = s.kind === 'followup'
          ? renderEmail({ subject: i.copy.followEmailSubject || 'Following up: {{address}}', body_html: null, body_text: withDealLink(i.copy.followEmail, '\n\n') }, f)
          : renderEmail({ subject: i.copy.emailSubject, body_html: i.copy.emailHtml, body_text: i.copy.emailHtml ? i.copy.email : withDealLink(i.copy.email, '\n\n') }, f);
        msgs.push({ ...base, channel: 'email', subject: e.subject, body: e.text, body_html: e.html });
      } else if (s.channel === 'rvm') {
        msgs.push({ ...base, channel: 'rvm', body: renderMerge(i.copy.rvm, f) });
      } else {
        msgs.push({ ...base, channel: 'ai_call', body: renderMerge(i.copy.call, f) });
      }
    }
    if (!msgs.length) { skipped.push({ name: r.b.name, why: steps.length ? [can.sms, can.email, can.rvm].filter(Boolean)[0] ?? 'no channel for them' : 'no channel switched on' }); return; }
    msgs.sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
    recipients.push({ row: r, buyer_id: r.b.id, level: r.level, probability: r.probability, messages: msgs });
    // Texts, voicemails and calls are spaced out buyer to buyer; an email-only recipe goes out together.
    if (msgs.some((m) => m.channel !== 'email')) clock = t0 + staggerSeconds('sometimes', r.b.id) * 1000;
  });
  return { recipients, skipped, steps };
}

/** "3 texts, 2 emails, a voicemail and an AI call over 2 days" for the recipe card. */
export function recipeWords(steps: Step[]): string {
  const n = (ch: Channel) => steps.filter((s) => s.channel === ch).length;
  const parts: string[] = [];
  if (n('sms')) parts.push(`${n('sms')} text${n('sms') === 1 ? '' : 's'}`);
  if (n('email')) parts.push(`${n('email')} email${n('email') === 1 ? '' : 's'}`);
  if (n('rvm')) parts.push(n('rvm') === 1 ? 'a voicemail' : `${n('rvm')} voicemails`);
  if (n('ai_call')) parts.push(n('ai_call') === 1 ? 'an AI call' : `${n('ai_call')} AI calls`);
  const span = Math.max(0, ...steps.map((s) => s.after_hours));
  const over = span >= 48 ? `${Math.round(span / 24)} days` : span >= 24 ? 'a day and a bit' : span >= 2 ? `${Math.round(span)} hours` : span > 0 ? 'the first hour' : 'right now';
  if (!parts.length) return 'Nothing switched on';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${list} over ${over}`;
}
