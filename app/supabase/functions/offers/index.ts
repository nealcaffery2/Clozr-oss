/**
 * POST /offers — generate an offer for a seller from the underwriting.
 *
 * Body: { workspace_id, origin, action: 'generate', seller_id, amount?, basis?, send?, expires_days?, message? }
 *   → { offer, contract, signers, amount, basis }
 *
 * The number comes from COMPR's MAO (or the workspace's rule in
 * settings.offers); the offers row makes the trigger write the deal. A sent
 * offer moves the seller and the submission to Offer Made. A draft leaves
 * both stages so opening the letter does not; sending it marks the offer
 * Sent, and that is when the submission moves (and writes back to Podio).
 * The offer letter is rendered by the contract
 * engine and, when `send` is set, goes out with a signing link.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS } from '../_shared/security.ts';
import { type Any, generateOffer, loadCompany, priceOffer } from '../_shared/docs.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id); const sellerId = Number(b.seller_id);
  if (!Number.isFinite(ws) || !Number.isFinite(sellerId)) return json({ error: 'workspace_id and seller_id are required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  // Partnerships (migration 158) makes offers on its partners' submissions too (migration 163).
  if (!['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'partnerships'].includes(member.role)) return json({ error: 'your role cannot make offers' }, 403);
  // The seller is read as the caller so RLS decides; the write uses the service role.
  const { data: seller } = await asCaller.from('sellers').select('id').eq('id', sellerId).eq('workspace_id', ws).maybeSingle();
  if (!seller) return json({ error: 'seller not found' }, 404);
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const origin = String(b.origin || req.headers.get('origin') || Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com');

  try {
    if (b.action === 'price') {
      const { settings } = await loadCompany(admin, ws);
      const { data: deal } = await admin.from('deals').select('arv, rehab, mao, offer_amount').eq('seller_id', sellerId).eq('workspace_id', ws).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return json({ ...priceOffer(deal, (settings.offers ?? {}) as Any), deal });
    }
    if (b.action !== 'generate') return json({ error: 'unknown action' }, 400);
    const out = await generateOffer(admin, {
      ws, sellerId, dealId: b.deal_id != null ? Number(b.deal_id) : null, userId: who.user.id, origin, amount: b.amount != null ? Number(b.amount) : null, basis: b.basis ?? null,
      send: typeof b.send === 'boolean' ? b.send : undefined, expiresDays: b.expires_days != null ? Number(b.expires_days) : null, message: b.message ?? null,
    });
    return json({ offer: out.offer, contract: out.contract?.contract ?? null, signers: out.contract?.signers ?? [], emailed: out.contract?.emailed ?? 0, amount: out.amount, basis: out.basis, note: out.note, provider: out.provider, delivery: out.delivery, sms_link: out.sms_link, seller: out.seller });
  } catch (e) {
    return json({ error: (e as Error).message }, 422);
  }
});
