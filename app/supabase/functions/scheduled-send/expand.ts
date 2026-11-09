/**
 * Bulk SMS campaigns (migration 368): the expander the tick runs before it
 * sends. For each active campaign whose batch is due it takes the next
 * pending recipients, plans them (_shared/sms-campaign.ts: window in the
 * recipient's zone, line and template rotation, the per-line daily cap) and
 * writes one scheduled_messages row each; the tick then sends those rows the
 * same way as any scheduled text. It also applies the no-reply action once a
 * sent recipient has waited the campaign's N hours.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { everyRow } from '../_shared/every-row.ts';
import { planBatch, type CampaignPlanInput, type PendingRecipient } from '../_shared/sms-campaign.ts';

export const DEFAULT_DAILY_CAP = 600;
/** Rows one tick may schedule for one campaign, whatever "send all at once" asks. */
const TICK_MAX = 2000;

type CampaignRow = CampaignPlanInput & { workspace_id: number; created_by: string; status: string; reply_action: { hours?: number; label?: string; tag?: string } | null; total_count: number };

export async function expandCampaigns(admin: SupabaseClient): Promise<{ scheduled: number; completed: number; no_reply: number }> {
  const out = { scheduled: 0, completed: 0, no_reply: 0 };
  const now = new Date();
  const { data } = await admin.from('sms_campaigns').select('*').in('status', ['active', 'scheduled']).or(`next_batch_at.is.null,next_batch_at.lte.${now.toISOString()}`).limit(20);
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const c = raw as unknown as CampaignRow;
    if (c.start_at && Date.parse(c.start_at) > now.getTime()) continue;
    try {
      await one(admin, c, now, out);
    } catch (err) {
      console.error('sms campaign expand', c.id, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

async function one(admin: SupabaseClient, c: CampaignRow, now: Date, out: { scheduled: number; completed: number; no_reply: number }) {
  if (c.status === 'scheduled') await admin.from('sms_campaigns').update({ status: 'active' }).eq('id', c.id);
  await applyNoReply(admin, c, now, out);
  await repairStranded(admin, c, now);
  const want = c.send_all_at_once ? TICK_MAX : Math.min(TICK_MAX, c.batch_size);
  const { data: pend } = await admin.from('sms_campaign_recipients').select('id, seller_id, buyer_id, phone, state').eq('campaign_id', c.id).eq('status', 'pending').order('id').limit(want + 1);
  const pendingRows = (pend ?? []) as { id: number; seller_id: number | null; buyer_id: number | null; phone: string; state: string | null }[];
  if (!pendingRows.length) {
    // Nothing left to place: done once every scheduled row has gone out.
    const { count } = await admin.from('sms_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'scheduled');
    if (!count) { await admin.from('sms_campaigns').update({ status: 'completed', next_batch_at: null, updated_at: now.toISOString() }).eq('id', c.id); out.completed++; }
    else await admin.from('sms_campaigns').update({ next_batch_at: new Date(now.getTime() + 15 * 60_000).toISOString() }).eq('id', c.id);
    return;
  }
  const sellerIds = pendingRows.map((r) => r.seller_id).filter((x): x is number => x != null);
  const { data: sellers } = sellerIds.length ? await admin.from('sellers').select('id, name, property_address, property_id').in('id', sellerIds) : { data: [] };
  const propIds = (sellers ?? []).map((s) => s.property_id).filter((x): x is number => x != null);
  const { data: props } = propIds.length ? await admin.from('properties').select('id, line1, city, state, zip').in('id', propIds) : { data: [] };
  const propBy = new Map((props ?? []).map((p) => [p.id as number, p]));
  const sellerBy = new Map((sellers ?? []).map((s) => [s.id as number, s]));
  // A buyer campaign (migration 378): the buyer's name and company fill the same fields.
  const buyerIds = pendingRows.map((r) => r.buyer_id).filter((x): x is number => x != null);
  const { data: buyers } = buyerIds.length ? await admin.from('buyers').select('id, name, company, markets').in('id', buyerIds) : { data: [] };
  const buyerBy = new Map((buyers ?? []).map((b) => [b.id as number, b]));
  const { data: ws } = await admin.from('workspaces').select('name, settings').eq('id', c.workspace_id).maybeSingle();
  const settings = (ws?.settings ?? {}) as Record<string, unknown>;
  const cap = Number(settings.sms_campaign_daily_cap) > 0 ? Number(settings.sms_campaign_daily_cap) : DEFAULT_DAILY_CAP;
  const company = String(settings.company_name ?? ws?.name ?? '');
  const { data: rep } = await admin.from('profiles').select('full_name, phone').eq('id', c.created_by).maybeSingle();
  const repName = String(rep?.full_name ?? '').trim();
  const pending: PendingRecipient[] = pendingRows.map((r) => {
    const s = r.seller_id != null ? sellerBy.get(r.seller_id) : undefined;
    const b = r.buyer_id != null ? buyerBy.get(r.buyer_id) : undefined;
    const p = s?.property_id != null ? propBy.get(s.property_id) : undefined;
    const name = String(s?.name ?? b?.name ?? '').trim();
    const address = String(p?.line1 ?? s?.property_address ?? '').trim();
    const market = Array.isArray(b?.markets) ? String(b!.markets[0] ?? '') : '';
    return { id: r.id, seller_id: r.seller_id, buyer_id: r.buyer_id, phone: r.phone, state: (p?.state as string | null) ?? r.state, fields: {
      first_name: name.split(/\s+/)[0] ?? '', name, contact_name: name, address, city: String(p?.city ?? ''), state: String(p?.state ?? r.state ?? ''), zip: String(p?.zip ?? ''), postal_code: String(p?.zip ?? ''), phone: r.phone, company, org_name: company,
      their_company: String(b?.company ?? '').trim(), market,
      rep_name: repName, rep_first_name: repName.split(/\s+/)[0] ?? '', rep_phone: String(rep?.phone ?? ''),
    } };
  });
  const { data: tpl } = c.template_ids.length ? await admin.from('message_templates').select('id, body_text').in('id', c.template_ids) : { data: [] };
  const templates = (tpl ?? []).map((t) => ({ id: t.id as number, body: String(t.body_text ?? '') }));
  // ponytail: "today" is the last 24 hours per line, not the line's local calendar day; tighten if a cap is ever hit at midnight.
  // A failed count is not "nothing sent": planning on an empty tally would put a full batch on
  // lines already at their cap. The batch waits 15 minutes and the campaign says why. No line
  // means nothing to count; the pause below says so.
  let recent: { from_phone_number_id: string | null }[] = [];
  try {
    if (c.from_numbers.length) recent = await everyRow<{ from_phone_number_id: string | null }>(() => admin.from('scheduled_messages').select('from_phone_number_id').eq('workspace_id', c.workspace_id).in('from_phone_number_id', c.from_numbers)
      .gte('send_at', new Date(now.getTime() - 24 * 3_600_000).toISOString()).in('status', ['scheduled', 'sending', 'sent']).order('id'));
  } catch (err) {
    console.error('sms campaign expand', c.id, `could not count today's texts per line; batch waits 15 minutes: ${err instanceof Error ? err.message : err}`);
    await admin.from('sms_campaigns').update({ next_batch_at: new Date(now.getTime() + 15 * 60_000).toISOString(), updated_at: now.toISOString() }).eq('id', c.id);
    return;
  }
  const sentToday: Record<string, number> = {};
  for (const r of recent) if (r.from_phone_number_id) sentToday[r.from_phone_number_id] = (sentToday[r.from_phone_number_id] ?? 0) + 1;
  const batchPending = pending.slice(0, want);
  const plan = planBatch({ ...c, placed: c.total_count - pendingRows.length }, batchPending, templates, sentToday, cap, now);
  if (!templates.length || !c.from_numbers.length) {
    await admin.from('sms_campaigns').update({ status: 'paused', excluded: { ...(c as unknown as { excluded?: object }).excluded, reason: !templates.length ? 'No message template' : 'No line to send from' }, updated_at: now.toISOString() }).eq('id', c.id);
    return;
  }
  for (const row of plan.rows) {
    // Claim the recipient first: the kick fires every minute and a slow page overlaps the next tick,
    // which read the same pending rows. Only the tick that flips pending wins; the other sees no row.
    const { data: claimed } = await admin.from('sms_campaign_recipients').update({ status: 'scheduled', scheduled_for: row.send_at, template_id: row.template_id, from_number: row.from_number })
      .eq('id', row.recipient_id).eq('status', 'pending').select('id').maybeSingle();
    if (!claimed) continue;
    const { data: m, error } = await admin.from('scheduled_messages').insert({
      workspace_id: c.workspace_id, user_id: c.created_by, seller_id: row.seller_id, buyer_id: row.buyer_id, phone: row.phone, from_phone_number_id: row.from_number, body: row.body, send_at: row.send_at,
    }).select('id').single();
    if (error || !m) {
      console.error('sms campaign schedule', c.id, error?.message);
      await admin.from('sms_campaign_recipients').update({ status: 'pending', scheduled_for: null, template_id: null, from_number: null }).eq('id', row.recipient_id);
      continue;
    }
    await admin.from('sms_campaign_recipients').update({ scheduled_message_id: m.id }).eq('id', row.recipient_id);
    out.scheduled++;
  }
  // More behind this batch than the page showed: come back on the cadence.
  const more = pendingRows.length > want || plan.next_batch_at;
  const next = plan.next_batch_at ?? (more ? new Date(now.getTime() + c.batch_every_minutes * 60_000).toISOString() : new Date(now.getTime() + 15 * 60_000).toISOString());
  await admin.from('sms_campaigns').update({ next_batch_at: next, updated_at: now.toISOString() }).eq('id', c.id);
}

/**
 * A recipient claimed `scheduled` whose scheduled_message_id was never written
 * (the tick died between the claim and the insert, or between the insert and
 * the id write), once its send time is 10 minutes gone. Left as is, the
 * completion count never reached zero. If the message exists (same phone and
 * send time in the workspace) it is linked and the recipient takes its
 * terminal status, so no second text is planned for one that went; if not,
 * the recipient goes back to pending. A failed lookup waits for the next look.
 */
async function repairStranded(admin: SupabaseClient, c: CampaignRow, now: Date) {
  const { data } = await admin.from('sms_campaign_recipients').select('id, phone, scheduled_for').eq('campaign_id', c.id).eq('status', 'scheduled')
    .is('scheduled_message_id', null).lt('scheduled_for', new Date(now.getTime() - 10 * 60_000).toISOString()).limit(200);
  for (const r of (data ?? []) as { id: number; phone: string; scheduled_for: string }[]) {
    const { data: m, error } = await admin.from('scheduled_messages').select('id, status').eq('workspace_id', c.workspace_id).eq('phone', r.phone).eq('send_at', r.scheduled_for)
      .order('id', { ascending: false }).limit(1).maybeSingle();
    if (error) continue;
    const patch: Record<string, unknown> = m
      ? { scheduled_message_id: m.id, ...(m.status === 'sent' ? { status: 'sent', sent_at: now.toISOString() } : m.status === 'error' || m.status === 'cancelled' ? { status: m.status } : {}) }
      : { status: 'pending', scheduled_for: null, template_id: null, from_number: null };
    await admin.from('sms_campaign_recipients').update(patch).eq('id', r.id).eq('status', 'scheduled');
  }
}

/** After N hours with no reply: label the thread (for the sender) and tag the seller or buyer (the "list"). */
async function applyNoReply(admin: SupabaseClient, c: CampaignRow, now: Date, out: { no_reply: number }) {
  const hours = Number(c.reply_action?.hours);
  if (!(hours > 0)) return;
  const before = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const { data } = await admin.from('sms_campaign_recipients').select('id, seller_id, buyer_id, phone').eq('campaign_id', c.id).eq('status', 'sent').lte('sent_at', before).limit(500);
  const rows = (data ?? []) as { id: number; seller_id: number | null; buyer_id: number | null; phone: string }[];
  if (!rows.length) return;
  const tag = String(c.reply_action?.tag ?? '').trim();
  const label = String(c.reply_action?.label ?? '').trim();
  for (const r of rows) {
    const who = r.seller_id != null ? { table: 'sellers', id: r.seller_id } : r.buyer_id != null ? { table: 'buyers', id: r.buyer_id } : null;
    if (tag && who) {
      const { data: s } = await admin.from(who.table).select('tags').eq('id', who.id).maybeSingle();
      const tags: string[] = Array.isArray(s?.tags) ? s!.tags : [];
      if (!tags.includes(tag)) await admin.from(who.table).update({ tags: [...tags, tag] }).eq('id', who.id);
    }
    if (label) {
      const key = `sms:${r.phone}`;
      const { data: st } = await admin.from('inbox_item_state').select('labels').eq('workspace_id', c.workspace_id).eq('user_id', c.created_by).eq('item_key', key).maybeSingle();
      const labels: string[] = Array.isArray(st?.labels) ? st!.labels : [];
      if (!labels.includes(label)) await admin.from('inbox_item_state').upsert({ workspace_id: c.workspace_id, user_id: c.created_by, item_key: key, labels: [...labels, label], updated_at: now.toISOString() }, { onConflict: 'workspace_id,user_id,item_key' });
    }
    await admin.from('sms_campaign_recipients').update({ status: 'no_reply' }).eq('id', r.id);
    out.no_reply++;
  }
}
