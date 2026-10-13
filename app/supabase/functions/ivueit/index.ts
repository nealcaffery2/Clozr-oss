/**
 * POST /ivueit — order iVueit photos of a deal's house and bring them back.
 *
 * Body { action, workspace_id, ... }:
 *   status   { deal_id }                          connected?, the address, the templates, this deal's orders
 *   order    { deal_id, template_id?, notes?, urgent? }   creates the Vue; the photos land on the deal when it is shot
 *   check    { order_id }                         reads the Vue now; copies the photos if it is done
 *   cancel   { order_id, reason? }
 *   setup    (owner/admin)                        tests the saved key, lists templates, points iVueit's VueCompleted webhook here
 *   sweep    (service role, the cron in migration 255)   checks the workspace's open orders
 *
 * The key and secret are the workspace's (Settings → Integrations,
 * set_ivueit_keys). The browser never sees them.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, corsFor, isServiceCaller, jsonWith, memberRole, rateLimit, tooMany } from '../_shared/security.ts';
import {
  type PhotoOrder, type VueAddress, IvueitError, checkOrder, createVue, ivu, ivueitCreds, ivueitLogin, ivueitTemplates, pickTemplate,
} from '../_shared/ivueit.ts';

type Any = Record<string, unknown>;

const ORDER_COLS = 'id, workspace_id, deal_id, vue_id, status, address, notes, urgent, photo_count, cost, error, created_at, checked_at, completed_at, ordered_by';
const WRITERS = ['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'member', 'partnerships'];

async function dealAddress(db: SupabaseClient, ws: number, dealId: number): Promise<VueAddress & { label: string }> {
  const { data: deal } = await db.from('deals').select('id, property_id, seller_id').eq('id', dealId).eq('workspace_id', ws).maybeSingle();
  if (!deal) throw new IvueitError('Deal not found.', 404);
  const sellerId = (deal as Any).seller_id as number | null;
  const seller: Any | null = sellerId
    ? (await db.from('sellers').select('property_address, property_id').eq('id', sellerId).maybeSingle()).data
    : null;
  const propId = ((deal as Any).property_id as number | null) ?? (seller?.property_id as number | null) ?? null;
  const prop: Any | null = propId ? (await db.from('properties').select('line1, city, state, zip').eq('id', propId).maybeSingle()).data : null;
  const a = {
    line1: String(prop?.line1 || seller?.property_address || '').trim(),
    city: String(prop?.city ?? '').trim(),
    state: String(prop?.state ?? '').trim(),
    zip: String(prop?.zip ?? '').trim(),
  };
  return { ...a, label: [a.line1, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const action = String(b.action ?? 'status');
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);

  // The cron's sweep: every open order in the workspace older than five minutes.
  if (action === 'sweep') {
    if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service only' }, 403);
    try {
      const { data } = await admin.from('photo_orders').select(ORDER_COLS).eq('workspace_id', ws).eq('status', 'ordered')
        .lt('created_at', new Date(Date.now() - 5 * 60_000).toISOString()).order('checked_at', { ascending: true, nullsFirst: true }).limit(20);
      const open = (data ?? []) as PhotoOrder[];
      if (!open.length) return json({ checked: 0 });
      const c = await ivueitCreds(admin, ws);
      const token = await ivueitLogin(c);
      let done = 0;
      for (const o of open) {
        try { if ((await checkOrder(admin, c, token, o)).status === 'completed') done++; } catch (e) { console.error('ivueit sweep', { order: o.id, err: String(e) }); }
      }
      return json({ checked: open.length, completed: done });
    } catch (e) {
      const err = e as IvueitError;
      return json({ error: err.message }, err.status || 500);
    }
  }

  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const role = await memberRole(asCaller, ws, who.user.id);
  if (!role) return json({ error: 'not a member of that workspace' }, 403);
  const rl = await rateLimit(admin, `ivueit:${who.user.id}`, 30, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  const orderOf = async (id: unknown): Promise<PhotoOrder> => {
    const { data } = await asCaller.from('photo_orders').select(ORDER_COLS).eq('id', Number(id)).eq('workspace_id', ws).maybeSingle();
    if (!data) throw new IvueitError('That photo order is not on this workspace.', 404);
    return data as PhotoOrder;
  };

  try {
    if (action === 'status') {
      const dealId = Number(b.deal_id);
      if (!Number.isFinite(dealId)) return json({ error: 'deal_id is required' }, 422);
      const [{ data: settings }, addr, { data: orders }] = await Promise.all([
        asCaller.rpc('ivueit_settings', { p_workspace_id: ws }),
        dealAddress(asCaller, ws, dealId),
        asCaller.from('photo_orders').select(ORDER_COLS).eq('deal_id', dealId).eq('workspace_id', ws).order('created_at', { ascending: false }).limit(10),
      ]);
      const s = (settings ?? {}) as { connected?: boolean; template_id?: string | null; base_url?: string | null };
      let templates: Awaited<ReturnType<typeof ivueitTemplates>> = [];
      let problem: string | null = null;
      if (s.connected) {
        try {
          const c = await ivueitCreds(admin, ws);
          templates = await ivueitTemplates(c, await ivueitLogin(c));
        } catch (e) { problem = (e as Error).message; }
      }
      return json({
        connected: !!s.connected, staging: !!s.base_url && !/prod\.data\.ivueit\.network/i.test(s.base_url),
        template_id: s.template_id ?? null, templates, problem,
        address: addr.label, address_ok: !!(addr.line1 && addr.city && addr.state && addr.zip),
        orders: orders ?? [],
      });
    }

    if (!WRITERS.includes(role)) return json({ error: 'your role cannot order photos' }, 403);

    if (action === 'order') {
      const dealId = Number(b.deal_id);
      if (!Number.isFinite(dealId)) return json({ error: 'deal_id is required' }, 422);
      const addr = await dealAddress(asCaller, ws, dealId);
      if (!addr.line1 || !addr.city || !addr.state || !addr.zip) {
        return json({ error: 'iVueit needs the full address: street, city, state and ZIP. Fix it on the record, then order.' }, 422);
      }
      const { data: open } = await asCaller.from('photo_orders').select('id').eq('deal_id', dealId).eq('status', 'ordered').limit(1);
      if ((open ?? []).length && b.again !== true) return json({ error: 'Photos are already on order for this house.', open: true }, 409);

      const c = await ivueitCreds(admin, ws);
      const token = await ivueitLogin(c);
      const templateId = await pickTemplate(c, token, b.template_id ? String(b.template_id) : null);
      const notes = String(b.notes ?? '').trim().slice(0, 2000);
      const urgent = b.urgent === true;
      const { data: row, error } = await admin.from('photo_orders').insert({
        workspace_id: ws, deal_id: dealId, address: addr.label, template_id: templateId, notes: notes || null, urgent, ordered_by: who.user.id,
      }).select('id').single();
      if (error || !row) throw new IvueitError(error?.message ?? 'Could not save the order.', 500);
      const orderId = (row as { id: number }).id;
      try {
        const v = await createVue(c, token, {
          templateId, addr, urgent, notes,
          name: `${addr.line1}, ${addr.city} (CLOZR deal ${dealId})`,
          meta: { clozr_workspace: String(ws), clozr_deal: String(dealId), clozr_order: String(orderId) },
        });
        await admin.from('photo_orders').update({ vue_id: v.vueId }).eq('id', orderId);
      } catch (e) {
        await admin.from('photo_orders').update({ status: 'failed', error: (e as Error).message.slice(0, 500) }).eq('id', orderId);
        throw e;
      }
      await admin.from('activity').insert({
        workspace_id: ws, entity_type: 'deal', entity_id: dealId, kind: 'photos', actor_id: who.user.id,
        title: 'iVueit photos ordered', body: `${addr.label}${urgent ? ' · rush' : ''}${notes ? ' · ' + notes : ''}`,
      });
      const { data: orders } = await asCaller.from('photo_orders').select(ORDER_COLS).eq('deal_id', dealId).order('created_at', { ascending: false }).limit(10);
      return json({ ok: true, order_id: orderId, orders: orders ?? [] });
    }

    if (action === 'check') {
      const o = await orderOf(b.order_id);
      const c = await ivueitCreds(admin, ws);
      const r = await checkOrder(admin, c, await ivueitLogin(c), o);
      return json({ ok: true, ...r });
    }

    if (action === 'cancel') {
      const o = await orderOf(b.order_id);
      if (o.status !== 'ordered') return json({ error: 'Only an open order can be canceled.' }, 409);
      const c = await ivueitCreds(admin, ws);
      if (o.vue_id) {
        await ivu(c, await ivueitLogin(c), `/api/v1/vue/cancel/${encodeURIComponent(o.vue_id)}`, {
          method: 'PUT', body: { id: o.vue_id, reason: String(b.reason ?? 'Canceled from CLOZR').slice(0, 200) },
        });
      }
      await admin.from('photo_orders').update({ status: 'canceled', checked_at: new Date().toISOString() }).eq('id', o.id);
      await admin.from('activity').insert({
        workspace_id: ws, entity_type: 'deal', entity_id: o.deal_id, kind: 'photos', actor_id: who.user.id,
        title: 'iVueit photo order canceled', body: null,
      });
      return json({ ok: true });
    }

    if (action === 'setup') {
      if (!['owner', 'admin'].includes(role)) return json({ error: 'only an owner or admin can set up iVueit' }, 403);
      const c = await ivueitCreds(admin, ws);
      const token = await ivueitLogin(c);
      const templates = await ivueitTemplates(c, token);
      // iVueit calls this when a Vue is completed. One active VueCompleted
      // webhook per company: update it when one exists.
      let webhook = 'not set';
      if (c.hookToken) {
        const hook = {
          webhookType: 'VueCompleted', active: true, httpMethod: 'POST',
          uri: `${url}/functions/v1/ivueit-webhook`,
          queryParams: `?w=${ws}&t=${c.hookToken}&vue={{vueId}}`,
          requestBody: '{"vueId":"{{vueId}}"}',
          headers: '{}',
        };
        try {
          await ivu(c, token, '/api/v1/webhook/create', { method: 'POST', body: hook });
          webhook = 'created';
        } catch {
          try {
            const list = await ivu(c, token, '/api/v1/webhooks');
            const all = (Array.isArray(list.webhooks) ? list.webhooks : Array.isArray(list) ? list : []) as Any[];
            const mine = all.find((w) => String(w.webhookType ?? w.type ?? '') === 'VueCompleted');
            if (mine?.id) {
              await ivu(c, token, '/api/v1/webhook/update', { method: 'PUT', body: { ...hook, id: mine.id } });
              webhook = 'updated';
            }
          } catch (e) {
            console.error('ivueit webhook', String(e));
          }
        }
      }
      return json({ ok: true, templates, template_id: c.templateId, webhook, staging: !/prod\.data\.ivueit\.network/i.test(c.base) });
    }

    return json({ error: `unknown action ${action}` }, 400);
  } catch (e) {
    const err = e as IvueitError;
    if (!(err instanceof IvueitError)) console.error('ivueit', err);
    return json({ error: err.message || 'iVueit failed.' }, err instanceof IvueitError ? err.status : 500);
  }
});
