/**
 * POST /telnyx-billing — the Telnyx account's balance, and topping it up from
 * CLOZR so a 10DLC filing (or anything else Telnyx bills before it acts) does
 * not stall on "Your account must have at least $6.00".
 *
 *   { action: 'balance', workspace_id }            → { balance, available, … }
 *   { action: 'add',     workspace_id, amount }    → charge the card on file
 *
 * `add` charges the payment method already stored on the Telnyx account
 * (POST /v2/payment/stored_payment_transactions). CLOZR never sees a card
 * number; with no card on file Telnyx refuses and the error says so. It is
 * owner/admin only, $10–$500 a time and three times an hour per workspace,
 * because it spends real money. A successful top-up re-runs ten-dlc-register
 * straight away when the filing was waiting on funds, so the campaign files
 * without waiting for the morning check.
 *
 * Env: TELNYX_API_KEY or Vault telnyx_api_key, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, rateLimit } from '../_shared/security.ts';
import { readBalance, topupAmount } from '../_shared/telnyx-billing.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const TELNYX = 'https://api.telnyx.com/v2';

function jwtRole(token: string): string {
  try {
    const part = token.split('.')[1] ?? '';
    const pad = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    return String(JSON.parse(atob(pad)).role ?? '');
  } catch {
    return '';
  }
}

async function telnyx(key: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Any }> {
  try {
    const res = await fetch(`${TELNYX}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : 'unreachable' } };
  }
}

const errOf = (json: Any, status: number) => String(json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? json?.error ?? json?.message ?? `HTTP ${status}`);

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number; amount?: unknown };
  const action = String(input.action ?? 'balance');
  if (!['balance', 'add'].includes(action)) return json({ error: 'action must be balance or add' }, 400);
  const wsId = Number(input.workspace_id);
  if (!Number.isFinite(wsId)) return json({ error: 'workspace_id required' }, 400);

  // Money: a signed-in owner or admin of this workspace, never a bare service call.
  if (!bearer || jwtRole(bearer) !== 'authenticated') return json({ error: 'sign in' }, 401);
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in' }, 401);
  const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', who.user.id).maybeSingle();
  if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'Only an owner or admin can see or add Telnyx funds.' }, 403);

  const key = await telnyxSetting(admin, 'TELNYX_API_KEY');
  if (!key) return json({ error: 'No Telnyx API key on CLOZR (the TELNYX_API_KEY secret or Vault telnyx_api_key), so the balance cannot be read.' }, 503);

  const readNow = async () => {
    const r = await telnyx(key, 'GET', '/balance');
    return r.ok ? readBalance(r.json?.data) : null;
  };

  if (action === 'balance') {
    const r = await telnyx(key, 'GET', '/balance');
    if (!r.ok) return json({ error: `Telnyx balance: ${errOf(r.json, r.status)}` }, 502);
    const b = readBalance(r.json?.data);
    if (!b) return json({ error: 'Telnyx returned no balance.' }, 502);
    return json({ ok: true, ...b });
  }

  // ---- add funds ------------------------------------------------------------
  const parsed = topupAmount(input.amount);
  if ('error' in parsed) return json({ error: parsed.error }, 422);

  const limit = await rateLimit(admin, `telnyx-billing:${wsId}`, 3, 3600);
  if (!limit.allowed) return json({ error: 'Three top-ups an hour is the limit from CLOZR. Try again later, or add funds at portal.telnyx.com → Billing.' }, 429);

  const charge = await telnyx(key, 'POST', '/payment/stored_payment_transactions', { amount: parsed.amount });
  if (!charge.ok) {
    const why = errOf(charge.json, charge.status);
    console.error('telnyx-billing charge refused', { wsId, status: charge.status, why });
    return json({ error: `Telnyx did not take the payment: ${why}. Check the card on file at portal.telnyx.com → Billing.` }, charge.status === 422 ? 422 : 502);
  }
  const tx = charge.json?.data ?? {};
  console.log('telnyx-billing charged', { wsId, by: who.user.id, amount: parsed.amount, tx: tx.id, status: tx.processor_status });

  // A 10DLC filing that stalled for want of funds goes again now.
  let filing: string | null = null;
  const { data: reg } = await admin.from('ten_dlc_registrations').select('status, last_error, submitted_at').eq('workspace_id', wsId).maybeSingle();
  if (reg?.submitted_at && String(reg.last_error ?? '').startsWith('funds:')) {
    const kicked = await fetch(`${url.replace(/\/$/, '')}/functions/v1/ten-dlc-register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'register', workspace_id: wsId }),
    }).catch(() => null);
    const body = await kicked?.json().catch(() => ({})) as Any;
    filing = body?.ok ? (body.message ?? 'The 10DLC campaign was filed.') : String(body?.error ?? 'The 10DLC filing will retry at the next morning check.');
  }

  return json({
    ok: true,
    charged: parsed.amount,
    transaction: { id: tx.id ?? null, status: tx.processor_status ?? null },
    balance: await readNow(),
    filing,
  });
});
