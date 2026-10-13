// Message templates CLOZR owns (migration 37): SMS and email, per audience,
// private to their author until shared.
//
// Email templates are built from blocks — heading, paragraph, button, image,
// divider, spacer, signature, property card — and the HTML that goes out is
// generated from them here: one 600px table, every style inline, no <style>
// block, no web fonts, because that is what survives Gmail, Outlook and a
// phone's mail app alike. The blocks are what gets edited; body_html and the
// plain-text part are regenerated on every save.
//
// Merge fields are {{snake_case}} and render through lib/sms.ts renderMerge,
// the same grammar the SMS composer and action plans already use. Values put
// into HTML are escaped first.

import { supabase } from './supabase';
import { renderMerge } from './sms';
import type { MessageTemplateRow } from './database.types';

export type MessageTemplate = MessageTemplateRow;
export type Channel = MessageTemplate['channel'];
export type Audience = MessageTemplate['audience'];

export const AUDIENCES: Audience[] = ['seller', 'buyer', 'tc', 'general'];
export const AUDIENCE_LABEL: Record<Audience, string> = { seller: 'Seller', buyer: 'Buyer', tc: 'TC', general: 'General' };

/** The fields a template can use, in the order the chips show them. */
export const MERGE_FIELDS: Array<{ token: string; label: string }> = [
  { token: '{{first_name}}', label: 'First name' },
  { token: '{{name}}', label: 'Full name' },
  { token: '{{address}}', label: 'Address' },
  { token: '{{city}}', label: 'City' },
  { token: '{{state}}', label: 'State' },
  { token: '{{zip}}', label: 'Zip' },
  { token: '{{asking_price}}', label: 'Asking' },
  { token: '{{offer}}', label: 'Offer' },
  { token: '{{close_date}}', label: 'Close date' },
  { token: '{{title_company}}', label: 'Title co.' },
  { token: '{{beds}}', label: 'Beds' },
  { token: '{{baths}}', label: 'Baths' },
  { token: '{{photo_url}}', label: 'Photo URL' },
  { token: '{{rep_name}}', label: 'Rep name' },
  { token: '{{rep_phone}}', label: 'Rep phone' },
  { token: '{{rep_email}}', label: 'Rep email' },
  { token: '{{company}}', label: 'Company' },
  // Dispo: what a buyer blast says about the deal (filled from the deal in Buyers → Send marketing).
  { token: '{{full_address}}', label: 'Full address' },
  { token: '{{cash_price}}', label: 'Cash price' },
  { token: '{{arv}}', label: 'ARV' },
  { token: '{{sqft}}', label: 'Sq ft' },
  { token: '{{year_built}}', label: 'Year built' },
  { token: '{{garage}}', label: 'Garage' },
  { token: '{{headline}}', label: 'Headline' },
  { token: '{{description}}', label: 'Description' },
  { token: '{{deal_link}}', label: 'Deal page link' },
  { token: '{{marketing_link}}', label: 'View Full Deal (COMPR)' },
  { token: '{{photos_link}}', label: 'Photos (COMPR set)' },
  { token: '{{comps_link}}', label: 'Comps & underwriting (CMA PDF)' },
  { token: '{{property_type}}', label: 'Property type' },
  // Dispo campaigns, per buyer (supabase/functions/_shared/dispo-rules.ts): real or blank, never guessed.
  { token: '{{rep_first_name}}', label: 'Rep first name' },
  { token: '{{last_purchase_address}}', label: 'Last purchase' },
  { token: '{{last_purchase_ago}}', label: 'Bought … ago' },
  { token: '{{last_purchase_type}}', label: 'Flip / rental' },
  { token: '{{deal_distance}}', label: 'Distance to deal' },
  { token: '{{similar_size}}', label: 'Similar-size line' },
  { token: '{{purchase_note}}', label: 'Last purchase + distance (sentence)' },
  { token: '{{purchase_count}}', label: 'Purchases on file' },
];

/** Stand-in values for the preview, per audience, so a buyer blast does not preview as a seller letter. */
export const SAMPLE_FIELDS: Record<Audience, Record<string, string>> = (() => {
  const house = {
    address: '1418 Oak Hollow Dr', city: 'San Antonio', state: 'TX', zip: '78209',
    asking_price: '$245,000', offer: '$212,000', close_date: 'Oct 18', title_company: 'Northvale Title',
    beds: '3', baths: '2', full_address: '1418 Oak Hollow Dr, San Antonio, TX 78209', cash_price: '$189,000', arv: '$280,000', sqft: '1,420', year_built: '1958', garage: '2',
    headline: 'Fairview Terrace flip, well below list', description: 'Solid bones, big lot, detached 2-car garage.', marketing_link: 'https://example.com/deal/buyer-report', photos_link: 'https://thecompr.com/v/buyer-report#photos', comps_link: 'https://thecompr.com/v/buyer-cma.pdf', deal_link: 'https://clozr.app/deal?s=oak-hollow',
    photo_url: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=1200',
    rep_name: 'Taylor Reyes', rep_first_name: 'Taylor', rep_phone: '(210) 555-0142', rep_email: 'taylor@yourcompany.com', company: 'Acme Homes',
  };
  // What a campaign knows about one buyer (dispo-rules dispoBuyerFields), so a
  // buyer template previews with its purchase line filled rather than blank.
  const bought = {
    last_purchase_address: '2210 W Fairview Ave', last_purchase_ago: '3 months', last_purchase_type: 'flip', deal_distance: '0.8 miles',
    similar_size: " It's a similar size to your last one.", purchase_note: "It's 0.8 miles from the flip you did at 2210 W Fairview Ave 3 months ago.", purchase_count: '3',
  };
  return {
    seller: { ...house, first_name: 'Kara', name: 'Kara Mitchell' },
    buyer: { ...house, ...bought, first_name: 'Chris', name: 'Chris Anderson', asking_price: '$189,000' },
    tc: { ...house, first_name: 'Dana', name: 'Dana Fields' },
    general: { ...house, first_name: 'Jordan', name: 'Jordan Blake' },
  };
})();

/** The {{fields}} a body uses, deduped, for `merge_fields`. */
export function fieldsUsed(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(/\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}/g)) out.add(m[1].toLowerCase());
  return Array.from(out);
}

// ---- blocks -------------------------------------------------------------------

export type Block =
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'button'; label: string; url: string }
  | { id: string; type: 'image'; url: string; alt: string }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size: number }
  | { id: string; type: 'signature' }
  | { id: string; type: 'property' };

export type BlockType = Block['type'];

export const BLOCK_LABEL: Record<BlockType, string> = {
  heading: 'Heading', paragraph: 'Paragraph', button: 'Button', image: 'Image',
  divider: 'Divider', spacer: 'Spacer', signature: 'Signature', property: 'Property card',
};

const uid = () => globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);

export function newBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'heading': return { id, type, text: 'A quick update on {{address}}' };
    case 'paragraph': return { id, type, text: 'Hi {{first_name}},\n\n' };
    case 'button': return { id, type, label: 'See the details', url: 'https://' };
    case 'image': return { id, type, url: '{{photo_url}}', alt: '{{address}}' };
    case 'divider': return { id, type };
    case 'spacer': return { id, type, size: 16 };
    case 'signature': return { id, type };
    case 'property': return { id, type };
  }
}

/** Anything the AI or an old row hands back, made into blocks the editor can hold. */
export function toBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return raw.flatMap((b): Block[] => {
    const t = (b as { type?: string })?.type;
    const o = b as Record<string, unknown>;
    const id = str(o.id) || uid();
    switch (t) {
      case 'heading': case 'paragraph': return [{ id, type: t, text: str(o.text) }];
      case 'button': return [{ id, type: t, label: str(o.label), url: str(o.url) }];
      case 'image': return [{ id, type: t, url: str(o.url), alt: str(o.alt) }];
      case 'spacer': return [{ id, type: t, size: Math.min(64, Math.max(4, Number(o.size) || 16)) }];
      case 'divider': case 'signature': case 'property': return [{ id, type: t }];
      default: return [];
    }
  });
}

export const ACCENT = '#0A8560';
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
/** An href that is a web or mail link, or a merge field that will become one; anything else is dropped. */
const safeUrl = (u: string) => (/^(https?:|mailto:|tel:|\{\{)/i.test(u.trim()) ? esc(u.trim()) : '#');
const FONT = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const row = (inner: string, pad = '0 32px') => `<tr><td style="padding:${pad}">${inner}</td></tr>`;

/**
 * Blocks → email-client-safe HTML and its plain-text twin. Merge tokens are
 * left in; `renderEmail` fills them per recipient.
 */
export function blocksToEmail(blocks: Block[]): { html: string; text: string } {
  const html: string[] = [];
  const text: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        html.push(row(`<h1 style="margin:0;padding:8px 0;${FONT};font-size:24px;line-height:1.25;font-weight:700;color:#18181b">${esc(b.text)}</h1>`));
        text.push(b.text.toUpperCase());
        break;
      case 'paragraph':
        html.push(row(`<p style="margin:0;padding:8px 0;${FONT};font-size:15px;line-height:1.6;color:#27272a">${esc(b.text).replace(/\r?\n/g, '<br>')}</p>`));
        text.push(b.text);
        break;
      case 'button':
        html.push(row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0"><tr><td bgcolor="${ACCENT}" style="border-radius:8px"><a href="${safeUrl(b.url)}" target="_blank" style="display:inline-block;padding:12px 22px;${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(b.label)}</a></td></tr></table>`));
        text.push(`${b.label}: ${b.url}`);
        break;
      case 'image':
        if (b.url.trim()) html.push(row(`<img src="${safeUrl(b.url)}" alt="${esc(b.alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px;margin:8px 0">`));
        break;
      case 'divider':
        html.push(row('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7;font-size:0;line-height:0;padding:0">&nbsp;</td></tr></table>', '12px 32px'));
        text.push('—————');
        break;
      case 'spacer':
        html.push(`<tr><td style="height:${b.size}px;font-size:0;line-height:0">&nbsp;</td></tr>`);
        break;
      case 'signature':
        html.push(row(`<p style="margin:0;padding:12px 0 4px;${FONT};font-size:14px;line-height:1.5;color:#27272a"><strong>{{rep_name}}</strong><br><span style="color:#71717a">{{company}}</span><br><a href="tel:{{rep_phone}}" style="color:${ACCENT};text-decoration:none">{{rep_phone}}</a> · <a href="mailto:{{rep_email}}" style="color:${ACCENT};text-decoration:none">{{rep_email}}</a></p>`));
        text.push('{{rep_name}}\n{{company}}\n{{rep_phone}} · {{rep_email}}');
        break;
      case 'property':
        html.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0;border:1px solid #e4e4e7;border-radius:12px;border-collapse:separate;overflow:hidden"><tr><td style="padding:0"><img src="{{photo_url}}" alt="{{address}}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0"></td></tr><tr><td style="padding:14px 16px;${FONT}"><div style="font-size:16px;font-weight:700;color:#18181b">{{address}}</div><div style="font-size:13px;color:#71717a;padding-top:2px">{{city}}, {{state}} {{zip}}</div><div style="font-size:14px;color:#27272a;padding-top:8px"><strong style="color:${ACCENT}">{{asking_price}}</strong> &nbsp;·&nbsp; {{beds}} bd &nbsp;·&nbsp; {{baths}} ba</div></td></tr></table>`));
        text.push('{{address}}, {{city}}, {{state}} {{zip}}\n{{asking_price}} · {{beds}} bd · {{baths}} ba');
        break;
    }
  }
  return {
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px"><tr><td style="height:24px;font-size:0;line-height:0">&nbsp;</td></tr>${html.join('')}<tr><td style="height:24px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table></body></html>`,
    text: text.join('\n\n'),
  };
}

/** A template (or anything with merge tokens) for one recipient. HTML values are escaped. */
export function renderEmail(t: { subject: string | null; body_html: string | null; body_text: string }, fields: Record<string, string>) {
  const escaped = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, esc(v)]));
  return {
    subject: renderMerge(t.subject ?? '', fields),
    html: t.body_html ? tidyHtml(renderMerge(t.body_html, escaped)) : null,
    text: renderMerge(t.body_text, fields),
  };
}

/**
 * What a blank merge field leaves behind in HTML: an image with no source (a
 * deal with no photo showed a broken-image icon) and a paragraph that held
 * only the field (a buyer with no purchase note got an empty line). Neither
 * is ever wanted in what goes out.
 */
const tidyHtml = (html: string) => html
  .replace(/<img\b[^>]*\bsrc=(?:""|'')[^>]*>/gi, '')
  .replace(/<p\b[^>]*>(?:\s|&nbsp;)*<\/p>/gi, '');

// ---- the table ---------------------------------------------------------------

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const NO_DB: Result<never> = { ok: false, message: 'Templates run on a signed-in workspace.' };

export async function listTemplates(workspaceId: number): Promise<Result<MessageTemplate[]>> {
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.from('message_templates').select('*')
    .eq('workspace_id', workspaceId).is('archived_at', null).order('name');
  return error ? { ok: false, message: error.message } : { ok: true, data: (data ?? []) as MessageTemplate[] };
}

export type TemplateDraft = Pick<MessageTemplate, 'name' | 'channel' | 'audience' | 'category' | 'subject' | 'body_text' | 'body_html' | 'blocks' | 'shared'> & { id?: number };

/** Create or update. body_html/body_text for an email come from its blocks, so they are regenerated here. */
export async function saveTemplate(workspaceId: number, d: TemplateDraft): Promise<Result<MessageTemplate>> {
  if (!supabase) return NO_DB;
  const email = d.channel === 'email' && Array.isArray(d.blocks) ? blocksToEmail(d.blocks as Block[]) : null;
  const row = {
    name: d.name.trim() || 'Untitled', channel: d.channel, audience: d.audience,
    category: d.category?.trim() || null, subject: d.channel === 'email' ? (d.subject ?? '') : null,
    body_text: email ? email.text : d.body_text, body_html: email ? email.html : null,
    blocks: d.channel === 'email' ? d.blocks : null, shared: d.shared,
    merge_fields: fieldsUsed(d.subject, email ? email.text : d.body_text),
  };
  const q = d.id
    ? supabase.from('message_templates').update(row).eq('id', d.id).select('*').single()
    : supabase.from('message_templates').insert({ ...row, workspace_id: workspaceId }).select('*').single();
  const { data, error } = await q;
  return error ? { ok: false, message: error.message } : { ok: true, data: data as MessageTemplate };
}

/** "Delete" retires the row: RLS already limits who can, and a sent message can still name it. */
export async function archiveTemplate(id: number): Promise<Result<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('message_templates').update({ archived_at: new Date().toISOString() }).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

/** One-shot copy of Talkr's SMS templates; a name already here is skipped, so pressing it twice is harmless. */
export async function importTalkrTemplates(
  workspaceId: number, existing: MessageTemplate[], talkr: Array<{ name: string; body: string; category: string | null }>,
): Promise<Result<number>> {
  if (!supabase) return NO_DB;
  const have = new Set(existing.filter((t) => t.channel === 'sms').map((t) => t.name.trim().toLowerCase()));
  const rows = talkr.filter((t) => t.body.trim() && !have.has(t.name.trim().toLowerCase())).map((t) => ({
    workspace_id: workspaceId, name: t.name.trim().slice(0, 120) || 'Talkr template', channel: 'sms' as const,
    audience: 'general' as const, category: t.category, body_text: t.body, shared: true, merge_fields: fieldsUsed(t.body),
  }));
  if (!rows.length) return { ok: true, data: 0 };
  const { error } = await supabase.from('message_templates').insert(rows);
  return error ? { ok: false, message: error.message } : { ok: true, data: rows.length };
}

/** "Write this template": the goal and tone in, a subject and blocks (or an SMS body) out. */
export async function draftTemplate(
  workspaceId: number, input: { channel: Channel; audience: Audience; goal: string; tone: string },
): Promise<Result<{ name: string; subject: string | null; blocks: Block[]; body_text: string }>> {
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.functions.invoke('draft-template', { body: { workspace_id: workspaceId, ...input } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const d = data as { name?: string; subject?: string | null; blocks?: unknown; body_text?: string };
  return { ok: true, data: { name: String(d.name ?? ''), subject: d.subject ?? null, blocks: toBlocks(d.blocks), body_text: String(d.body_text ?? '') } };
}
