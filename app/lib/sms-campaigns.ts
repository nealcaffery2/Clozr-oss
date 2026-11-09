// Bulk SMS campaigns (migration 368): the rows, the reads and writes the
// Campaigns screens make, and the audience a campaign is built from. Delivery
// is the scheduled-send tick (supabase/functions/scheduled-send/expand.ts);
// nothing here sends. The /demo sample has no workspace and shows DEMO_ROWS.
'use client';

import type { PeoplePageSpec } from './people-page';
import { supabase } from './supabase';
import { estimateSpan, unknownFields } from '../supabase/functions/_shared/sms-campaign';

export type CampaignStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed';
export const STATUS_LABEL: Record<CampaignStatus, string> = { draft: 'Draft', scheduled: 'Scheduled', active: 'Active', paused: 'Paused', completed: 'Completed' };

/** Who the campaign texts. `label` and `count` are what the editor shows; ids are resolved at Schedule time. */
export type Audience =
  | { kind: 'ids'; ids: number[]; label: string }
  | { kind: 'filter'; spec: PeoplePageSpec; label: string; count: number }
  | { kind: 'smart_list'; list: string; label: string; count: number }
  | { kind: 'followup'; campaign_id: number; label: string; count: number }
  | { kind: 'none' };

export type ReplyAction = { hours?: number; label?: string; tag?: string };

/** Who a campaign texts: People (sellers) or the Buyers list, which is Compr's contacts (migration 378). */
export type ContactKind = 'seller' | 'buyer';

export type SmsCampaign = {
  id: number; workspace_id: number; created_by: string; name: string; status: CampaignStatus;
  contact_kind: ContactKind;
  /** Buyer campaigns: only buyers with opted_in_at get a text. */
  opted_in_only: boolean;
  audience: Audience; template_ids: number[]; from_numbers: string[]; tz: string;
  start_at: string | null; send_all_at_once: boolean; batch_size: number; batch_every_minutes: number;
  window_start: number; window_end: number; window_days: number[];
  reply_action: ReplyAction; parent_id: number | null; next_batch_at: string | null;
  total_count: number; sent_count: number; failed_count: number; responded_count: number;
  excluded: Record<string, number>; last_sent_at: string | null; created_at: string; updated_at: string;
};

export type Draft = Omit<SmsCampaign, 'id' | 'workspace_id' | 'created_by' | 'next_batch_at' | 'total_count' | 'sent_count' | 'failed_count' | 'responded_count' | 'excluded' | 'last_sent_at' | 'created_at' | 'updated_at'>;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DEFAULT_DAILY_CAP = 200;

export function newDraft(audience: Audience = { kind: 'none' }, contact: ContactKind = 'seller'): Draft {
  return {
    name: `Texts ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, status: 'draft', audience,
    contact_kind: contact, opted_in_only: false,
    template_ids: [], from_numbers: [], tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
    start_at: null, send_all_at_once: false, batch_size: 100, batch_every_minutes: 30,
    window_start: 9, window_end: 20, window_days: [1, 2, 3, 4, 5, 6], reply_action: {}, parent_id: null,
  };
}

/** The fields the expander fills for a seller; anything else in a template is flagged. */
export const CAMPAIGN_FIELDS = ['first_name', 'name', 'contact_name', 'address', 'city', 'state', 'zip', 'postal_code', 'phone', 'company', 'org_name', 'rep_name', 'rep_first_name', 'rep_phone', 'their_company', 'market'];
export const badFields = (body: string) => unknownFields(body, CAMPAIGN_FIELDS);

/** GSM-7 segments (160, then 153 each); any non-GSM character makes it UCS-2 (70, then 67). */
export function segments(body: string): { segments: number; chars: number } {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€]*$/.test(body);
  const n = body.length;
  if (!n) return { segments: 0, chars: 0 };
  const one = gsm ? 160 : 70; const each = gsm ? 153 : 67;
  return { segments: n <= one ? 1 : Math.ceil(n / each), chars: n };
}

export { estimateSpan };

export const audienceCount = (a: Audience) => (a.kind === 'ids' ? a.ids.length : a.kind === 'none' ? 0 : a.count);
export const audienceLabel = (a: Audience) => (a.kind === 'none' ? 'Nobody yet' : a.label);

// ---- reads and writes ----------------------------------------------------------

const T = 'sms_campaigns' as never;
type Row = Record<string, unknown>;

function fromRow(r: Row): SmsCampaign {
  return {
    ...(r as unknown as SmsCampaign),
    audience: (r.audience && typeof r.audience === 'object' && 'kind' in (r.audience as object) ? r.audience : { kind: 'none' }) as Audience,
    contact_kind: r.contact_kind === 'buyer' ? 'buyer' : 'seller', opted_in_only: r.opted_in_only === true,
    template_ids: (r.template_ids as number[] | null) ?? [], from_numbers: (r.from_numbers as string[] | null) ?? [],
    window_days: (r.window_days as number[] | null) ?? [], reply_action: (r.reply_action as ReplyAction | null) ?? {}, excluded: (r.excluded as Record<string, number> | null) ?? {},
  };
}

export async function listCampaigns(workspaceId: number | null): Promise<SmsCampaign[]> {
  if (!supabase || !workspaceId) return DEMO_ROWS;
  const { data, error } = await supabase.from(T).select('*').eq('workspace_id' as never, workspaceId as never).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map(fromRow);
}

export async function saveCampaign(workspaceId: number | null, d: Draft, id?: number): Promise<SmsCampaign> {
  if (!supabase || !workspaceId) throw new Error('Sign in to a workspace to save campaigns.');
  const q = id
    ? supabase.from(T).update({ ...d, updated_at: new Date().toISOString() } as never).eq('id' as never, id as never)
    : supabase.from(T).insert({ ...d, workspace_id: workspaceId } as never);
  const { data, error } = await q.select('*').single();
  if (error) throw new Error(error.message);
  return fromRow(data as Row);
}

export async function patchCampaign(id: number, patch: Partial<SmsCampaign>): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from(T).update({ ...patch, updated_at: new Date().toISOString() } as never).eq('id' as never, id as never);
  if (error) throw new Error(error.message);
}

export async function deleteCampaign(id: number): Promise<void> {
  if (!supabase) return;
  await supabase.rpc('sms_campaign_cancel_pending' as never, { p_campaign: id } as never);
  const { error } = await supabase.from(T).delete().eq('id' as never, id as never);
  if (error) throw new Error(error.message);
}

export type FillCounts = { added?: number; no_phone?: number; dnc?: number; blacklisted?: number; opted_out?: number; wrong_number?: number; landline?: number; duplicate?: number; not_opted_in?: number };
export const EXCLUSION_LABEL: Record<Exclude<keyof FillCounts, 'added'>, string> = {
  no_phone: 'no number', dnc: 'do not call', blacklisted: 'blacklisted', opted_out: 'opted out', wrong_number: 'wrong number', landline: 'landline', duplicate: 'duplicate number', not_opted_in: 'never opted in',
};

/** Recipients from seller or buyer ids, with the exclusions counted. `dry` only counts. */
export async function fillCampaign(campaignId: number, ids: number[], dry: boolean, contact: ContactKind = 'seller'): Promise<FillCounts> {
  if (!supabase) return { added: ids.length };
  const out: FillCounts = {};
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    const { data, error } = contact === 'buyer'
      ? await supabase.rpc('sms_campaign_fill_buyers' as never, { p_campaign: campaignId, p_buyer_ids: chunk, p_dry: dry } as never)
      : await supabase.rpc('sms_campaign_fill' as never, { p_campaign: campaignId, p_seller_ids: chunk, p_dry: dry } as never);
    if (error) throw new Error(error.message);
    for (const [k, v] of Object.entries((data ?? {}) as Record<string, number>)) out[k as keyof FillCounts] = (out[k as keyof FillCounts] ?? 0) + Number(v);
  }
  return out;
}

/** Everything that has not gone out comes back to pending; the campaign pauses. */
export async function pauseCampaign(id: number): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc('sms_campaign_cancel_pending' as never, { p_campaign: id } as never);
  if (error) throw new Error(error.message);
  await patchCampaign(id, { status: 'paused', next_batch_at: null });
}

export async function resumeCampaign(id: number): Promise<void> {
  await patchCampaign(id, { status: 'active', next_batch_at: new Date().toISOString() });
}

/** The ids behind an audience, read now. */
export async function resolveAudience(workspaceId: number | null, a: Audience, specForList: (list: string) => PeoplePageSpec | null): Promise<number[]> {
  if (a.kind === 'ids') return a.ids;
  if (a.kind === 'none') return [];
  if (!supabase || !workspaceId) return [];
  if (a.kind === 'followup') {
    const { data, error } = await supabase.from('sms_campaign_recipients' as never).select('seller_id, buyer_id, status').eq('campaign_id' as never, a.campaign_id as never).in('status' as never, ['sent', 'no_reply', 'error'] as never);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { seller_id: number | null; buyer_id: number | null }[]).map((r) => r.seller_id ?? r.buyer_id).filter((x): x is number => x != null);
  }
  const spec = a.kind === 'filter' ? a.spec : specForList(a.list);
  if (!spec) throw new Error(`${a.label} has a filter the server cannot run; open the list, select all and push from there.`);
  const { data, error } = await supabase.rpc('people_page' as never, { p_ws: workspaceId, p_filters: { ...spec.filters, ids_only: true }, p_sort: spec.sort, p_dir: spec.dir, p_lim: 50, p_off: 0 } as never);
  if (error) throw new Error(error.message);
  return ((data as { ids?: number[] } | null)?.ids ?? []);
}

/** Recipients as rows for a CSV export. */
export async function exportRecipients(c: SmsCampaign): Promise<string> {
  const head = 'name,phone,status,sent_at,responded_at,error';
  if (!supabase) return head + '\n';
  const { data } = await supabase.from('sms_campaign_recipients' as never).select('seller_id, buyer_id, phone, status, sent_at, responded_at, error').eq('campaign_id' as never, c.id as never).order('id');
  const rows = (data ?? []) as { seller_id: number | null; buyer_id: number | null; phone: string; status: string; sent_at: string | null; responded_at: string | null; error: string | null }[];
  const who = (r: (typeof rows)[number]) => r.seller_id ?? r.buyer_id ?? -1;
  const ids = rows.map(who).filter((x) => x > 0);
  const names = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const { data: s } = await supabase.from(c.contact_kind === 'buyer' ? 'buyers' : 'sellers').select('id, name').in('id', ids.slice(i, i + 1000));
    for (const x of (s ?? []) as { id: number; name: string | null }[]) names.set(x.id, x.name ?? '');
  }
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [head, ...rows.map((r) => [names.get(who(r)) ?? '', r.phone, r.status, r.sent_at ?? '', r.responded_at ?? '', r.error ?? ''].map(q).join(','))].join('\n') + '\n';
}

// ---- the sample -------------------------------------------------------------------

const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const demo = (n: Partial<SmsCampaign>): SmsCampaign => ({
  id: 0, workspace_id: 0, created_by: '', name: '', status: 'draft', contact_kind: 'seller', opted_in_only: false, audience: { kind: 'none' }, template_ids: [-1, -2], from_numbers: ['demo-1', 'demo-2'], tz: 'America/Chicago',
  start_at: null, send_all_at_once: false, batch_size: 100, batch_every_minutes: 30, window_start: 9, window_end: 20, window_days: [1, 2, 3, 4, 5, 6], reply_action: { hours: 48, label: 'Follow up', tag: 'No reply Oct' },
  parent_id: null, next_batch_at: null, total_count: 0, sent_count: 0, failed_count: 0, responded_count: 0, excluded: {}, last_sent_at: null, created_at: ago(1), updated_at: ago(1), ...n,
});
export const DEMO_ROWS: SmsCampaign[] = [
  demo({ id: 1, name: 'Oct 18 Tarrant absentee', status: 'active', audience: { kind: 'smart_list', list: 'Absentee TX', label: 'Absentee TX', count: 2859 }, start_at: ago(0.2), total_count: 2814, sent_count: 940, responded_count: 61, failed_count: 3, excluded: { dnc: 22, opted_out: 14, wrong_number: 6, landline: 3 }, last_sent_at: ago(0.01), next_batch_at: new Date(Date.now() + 12 * 60_000).toISOString() }),
  demo({ id: 2, name: 'Oct 15 High equity Dallas', status: 'completed', audience: { kind: 'filter', spec: { filters: {}, sort: 'touch', dir: 'desc' }, label: 'People filter: Source Deal Machine, No contact 7 days', count: 1690 }, start_at: ago(3), total_count: 1662, sent_count: 1662, responded_count: 118, failed_count: 9, excluded: { dnc: 18, opted_out: 9, landline: 1 }, last_sent_at: ago(2.1), created_at: ago(3.2) }),
  demo({ id: 3, name: 'Oct 12 Follow-up: no reply', status: 'paused', parent_id: 2, audience: { kind: 'followup', campaign_id: 2, label: 'Oct 15 High equity Dallas, no reply', count: 1544 }, start_at: ago(1), total_count: 1544, sent_count: 402, responded_count: 17, excluded: {}, last_sent_at: ago(0.9), created_at: ago(1.1) }),
  demo({ id: 4, name: 'Oct 20 SFR Detroit', status: 'draft', audience: { kind: 'ids', ids: Array.from({ length: 412 }, (_, i) => i + 1), label: '412 selected people' }, created_at: ago(0.1) }),
];
