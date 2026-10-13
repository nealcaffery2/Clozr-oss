/**
 * POST /brex-sync — the owner's bank feed for the Profitability report.
 *
 * Body: { workspace_id, action, token?, since? }
 *   status      → { ok, connected, source: 'workspace'|'secret'|null, last_synced_at, last_error }
 *   connect     { token } — checks the token against Brex (GET /v2/accounts/cash),
 *               stores it in bank_connections, then syncs. The token never
 *               comes back out: bank_connections has no client grant at all.
 *   disconnect  deletes the stored token (synced rows stay).
 *   sync        { since?: 'YYYY-MM-DD' } (default 90 days back) → { ok, accounts, transactions }
 *
 * Who: the caller's own JWT must hold owner or admin in workspace_id. The
 * service role is used only after that check.
 *
 * Token: bank_connections.api_token for the workspace, else the BREX_API_TOKEN
 * secret — but the secret only for the workspace named in BREX_WORKSPACE_ID, so
 * one company's bank never syncs into somebody else's workspace.
 *
 * Brex endpoints (Transactions API 1.0, https://api.brex.com, verified against
 * developer.brex.com/_bundle/openapi/transactions_api.json):
 *   GET /v2/accounts/cash                     Page<CashAccount>  { id, name, current_balance, available_balance, primary }
 *   GET /v2/accounts/card                     CardAccount[]      { id, current_balance, available_balance }
 *   GET /v2/transactions/cash/{id}            Page<CashTransaction> ?cursor&limit&posted_at_start
 *   GET /v2/transactions/card/primary         Page<CardTransaction> ?cursor&limit&posted_at_start
 *   Money = { amount: int64 minor units, signed; currency }. Page = { items, next_cursor }.
 * Sign: cash amounts are already from the account's side (negative = out). A
 * card PURCHASE is a positive charge on the card, so card amounts are negated
 * to keep bank_transactions.amount_cents "positive = money in".
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';

type Any = any;
const BREX = 'https://api.brex.com';

async function brex(token: string, path: string, params: Record<string, string> = {}): Promise<Any> {
  const u = new URL(BREX + path);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Brex ${path} → ${r.status}`);
  return r.json();
}

/** Every page of a Page<T> endpoint. */
async function all(token: string, path: string, params: Record<string, string>): Promise<Any[]> {
  const out: Any[] = [];
  let cursor = '';
  for (let i = 0; i < 50; i++) { // ponytail: 50 pages × 100 = 5k rows per call; widen if a quarter ever exceeds it
    const page = await brex(token, path, { ...params, limit: '100', cursor });
    out.push(...(page.items ?? []));
    cursor = page.next_cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

async function sync(admin: SupabaseClient, ws: number, token: string, since: string) {
  const postedStart = `${since}T00:00:00.000`;
  const cash = await all(token, '/v2/accounts/cash', {});
  const cards: Any[] = await brex(token, '/v2/accounts/card').catch(() => []); // card scope may not be granted

  const accountRows = [
    ...cash.map((a) => ({
      workspace_id: ws, provider: 'brex', external_id: a.id, kind: 'cash', name: a.name ?? 'Brex cash',
      current_balance_cents: a.current_balance?.amount ?? null, available_balance_cents: a.available_balance?.amount ?? null,
      currency: a.current_balance?.currency ?? 'USD', is_primary: !!a.primary, raw: { ...a, account_number: undefined, routing_number: undefined },
      synced_at: new Date().toISOString(),
    })),
    ...(Array.isArray(cards) ? cards : []).map((a) => ({
      workspace_id: ws, provider: 'brex', external_id: a.id, kind: 'card', name: 'Brex card',
      current_balance_cents: a.current_balance?.amount ?? null, available_balance_cents: a.available_balance?.amount ?? null,
      currency: a.current_balance?.currency ?? 'USD', is_primary: false, raw: a, synced_at: new Date().toISOString(),
    })),
  ];
  const { data: accts, error: aErr } = await admin.from('bank_accounts')
    .upsert(accountRows, { onConflict: 'workspace_id,provider,external_id' }).select('id,external_id,kind');
  if (aErr) throw aErr;
  const idOf = new Map((accts ?? []).map((a: Any) => [a.external_id, a.id]));
  const cardAccount = (accts ?? []).find((a: Any) => a.kind === 'card')?.id ?? null;

  const txRows: Any[] = [];
  for (const a of cash) {
    for (const t of await all(token, `/v2/transactions/cash/${encodeURIComponent(a.id)}`, { posted_at_start: postedStart })) {
      txRows.push({
        workspace_id: ws, provider: 'brex', external_id: 'cash:' + t.id, account_id: idOf.get(a.id) ?? null,
        posted_at: t.posted_at_date, amount_cents: t.amount?.amount ?? 0, currency: t.amount?.currency ?? 'USD',
        description: t.description ?? null, counterparty: null, category: t.type ?? null, raw: t, synced_at: new Date().toISOString(),
      });
    }
  }
  const cardTx = await all(token, '/v2/transactions/card/primary', { posted_at_start: postedStart }).catch(() => []);
  for (const t of cardTx) {
    txRows.push({
      workspace_id: ws, provider: 'brex', external_id: 'card:' + t.id, account_id: cardAccount,
      posted_at: t.posted_at_date, amount_cents: -(t.amount?.amount ?? 0), currency: t.amount?.currency ?? 'USD',
      description: t.description ?? null, counterparty: t.merchant?.raw_descriptor ?? null, category: t.type ?? null,
      raw: t, synced_at: new Date().toISOString(),
    });
  }
  // deal_id is not in the payload, so an upsert keeps a tag already made.
  for (let i = 0; i < txRows.length; i += 500) {
    const { error } = await admin.from('bank_transactions')
      .upsert(txRows.slice(i, i + 500), { onConflict: 'workspace_id,provider,external_id' });
    if (error) throw error;
  }
  return { accounts: accountRows.length, transactions: txRows.length };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'sign in first' }, 401);
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who.user) return json({ error: 'sign in first' }, 401);

  let body: { workspace_id?: number; action?: string; token?: string; since?: string };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const action = body.action ?? 'status';

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: me } = await admin.from('workspace_members').select('role')
    .eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return json({ error: 'only an owner or admin can see bank data' }, 403);

  const rl = await rateLimit(admin, `brex-sync:${who.user.id}`, 30, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const { data: conn } = await admin.from('bank_connections')
    .select('api_token,last_synced_at,last_error').eq('workspace_id', ws).maybeSingle();
  const secret = Deno.env.get('BREX_API_TOKEN');
  const secretWs = Number(Deno.env.get('BREX_WORKSPACE_ID'));
  const token: string | null = conn?.api_token ?? (secret && secretWs === ws ? secret : null);
  const source = conn?.api_token ? 'workspace' : token ? 'secret' : null;

  try {
    if (action === 'status') {
      return json({ ok: true, connected: !!token, source, last_synced_at: conn?.last_synced_at ?? null, last_error: conn?.last_error ?? null });
    }
    if (action === 'disconnect') {
      await admin.from('bank_connections').delete().eq('workspace_id', ws);
      return json({ ok: true, connected: source === 'secret' });
    }
    if (action === 'connect') {
      const t = (body.token ?? '').trim();
      if (t.length < 20) return json({ error: 'paste a Brex user token' }, 422);
      try { await brex(t, '/v2/accounts/cash'); } catch { return json({ error: 'Brex refused that token (it needs accounts.cash.readonly and transactions.cash.readonly)' }, 422); }
      const { error } = await admin.from('bank_connections')
        .upsert({ workspace_id: ws, provider: 'brex', api_token: t, connected_by: who.user.id, last_error: null }, { onConflict: 'workspace_id' });
      if (error) return serverError(CORS, 'brex-sync connect', error);
    }
    if (action === 'connect' || action === 'sync') {
      const useToken = action === 'connect' ? (body.token ?? '').trim() : token;
      if (!useToken) return json({ ok: false, connected: false, error: 'Brex is not connected' }, 409);
      const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since ?? '') ? body.since! : new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      try {
        const r = await sync(admin, ws, useToken, since);
        if (conn || action === 'connect') await admin.from('bank_connections').update({ last_synced_at: new Date().toISOString(), last_error: null }).eq('workspace_id', ws);
        return json({ ok: true, connected: true, ...r });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (conn) await admin.from('bank_connections').update({ last_error: message.slice(0, 300) }).eq('workspace_id', ws);
        console.error('brex-sync', message);
        return json({ ok: false, connected: true, error: message.startsWith('Brex') ? message : 'Sync failed' }, 502);
      }
    }
    return json({ error: 'action must be status, connect, disconnect or sync' }, 422);
  } catch (e) {
    return serverError(CORS, 'brex-sync', e);
  }
});
