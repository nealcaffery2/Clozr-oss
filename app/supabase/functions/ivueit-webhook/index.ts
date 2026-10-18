/**
 * POST /ivueit-webhook?w=<workspace>&t=<token>&e=<type>&vue=<vueId> — iVueit's
 * VueCompleted, VueCanceled and VueEscalated webhooks (registered by ivueit setup;
 * a URL without `e` is VueCompleted). No JWT: the token is the
 * workspace's ivueit_hook_token (migration 255), compared in constant time.
 * Answers at once; the photos copy onto the deal in the background.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sameSecret } from '../_shared/security.ts';
import { type PhotoOrder, checkOrder, closeCanceledOrder, hookTypeOf, ivueitCreds, ivueitLogin, noteEscalation } from '../_shared/ivueit.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'POST only' }, 405);
  const q = new URL(req.url).searchParams;
  const ws = Number(q.get('w'));
  const token = q.get('t') ?? '';
  let vue = q.get('vue') ?? '';
  if (!vue && req.method === 'POST') {
    try { vue = String(((await req.json()) as { vueId?: string }).vueId ?? ''); } catch { /* the query had it or nothing did */ }
  }
  if (!Number.isFinite(ws) || !token || !/^[A-Za-z0-9-]{8,80}$/.test(vue)) return json({ error: 'bad request' }, 400);
  const type = hookTypeOf(q.get('e'));
  if (!type) return json({ error: 'unknown webhook type' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: sec } = await admin.from('workspace_integration_secrets').select('ivueit_hook_token').eq('workspace_id', ws).maybeSingle();
  const want = String((sec as { ivueit_hook_token?: string } | null)?.ivueit_hook_token ?? '');
  if (!want || !sameSecret(token, want)) return json({ error: 'bad token' }, 401);

  const { data: order } = await admin.from('photo_orders').select('id, workspace_id, deal_id, vue_id, status, created_at, address, ordered_by')
    .eq('workspace_id', ws).eq('provider', 'ivueit').eq('vue_id', vue).maybeSingle();
  // A Vue ordered outside CLOZR: nothing to do, and iVueit should not retry.
  if (!order) return json({ ok: true, matched: false });

  EdgeRuntime.waitUntil((async () => {
    try {
      if (type === 'VueCanceled') { await closeCanceledOrder(admin, order as PhotoOrder); return; }
      if (type === 'VueEscalated') { await noteEscalation(admin, order as PhotoOrder); return; }
      const c = await ivueitCreds(admin, ws);
      await checkOrder(admin, c, await ivueitLogin(c), order as PhotoOrder);
    } catch (e) {
      console.error('ivueit-webhook', { order: (order as PhotoOrder).id, type, err: String(e) });
    }
  })());
  return json({ ok: true, matched: true });
});
