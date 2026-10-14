/**
 * POST /investorbase-import — pull the buyers InvestorBase already found
 * for one address into this workspace's buyer list.
 *
 * The key is the workspace's InvestorBase subscriber key (Account →
 * Integrations there, saved here by set_investorbase_key) or, if that is
 * empty, the INVESTORBASE_API_KEY project secret. The browser never sees it.
 *
 * Body: { workspace_id, deal_id? | address?, city?, state?, zip?, latitude?, longitude?,
 *         radius_miles?, lookback_years?, buyer_types?, property_types?,
 *         min_bedrooms?, max_bedrooms?, min_bathrooms?, max_bathrooms?,
 *         min_purchase_price?, max_purchase_price?,
 *         hide_non_arms_length?, hide_hedge_fund?, hide_no_phone? }
 * Returns: { created, existing, buyers, address }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';
import { buyersFromSearch, searchBody, type IbPurchase } from '../_shared/investorbase.ts';

const API = 'https://api.investorbase.com';

type Any = Record<string, unknown>;

class IbError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

async function apiKey(admin: SupabaseClient, ws: number): Promise<string> {
  const { data } = await admin.from('workspace_integration_secrets').select('investorbase_api_key').eq('workspace_id', ws).maybeSingle();
  const saved = String((data as { investorbase_api_key?: string } | null)?.investorbase_api_key ?? '').trim();
  const key = saved || (Deno.env.get('INVESTORBASE_API_KEY') ?? '').trim();
  if (!key) throw new IbError('InvestorBase is not connected. An owner pastes the API key under Settings → Integrations.', 422);
  return key;
}

async function ib(key: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-api-key': key, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(50_000),
  });
}

async function fail(res: Response): Promise<never> {
  let message = `InvestorBase answered ${res.status}.`;
  try {
    const j = await res.json() as { error?: string };
    if (j?.error) message = j.error;
  } catch { /* the status line is enough */ }
  const status = res.status === 401 || res.status === 403 ? 422 : res.status === 429 ? 429 : res.status === 404 ? 404 : 502;
  throw new IbError(message, status);
}

async function search(key: string, body: Record<string, unknown>): Promise<IbPurchase[]> {
  const res = await ib(key, '/v1/buyer-search', { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 504) {
    const started = await ib(key, '/v1/buyer-search', { method: 'POST', body: JSON.stringify({ ...body, async: true }) });
    if (started.status !== 202) await fail(started);
    const pending = await started.json() as { search_id?: string };
    const id = pending.search_id;
    if (!id) throw new IbError('InvestorBase started the search without a search id.');
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const got = await ib(key, `/v1/buyer-search?search_id=${encodeURIComponent(id)}`);
      if (got.status === 200) {
        const data = await got.json();
        if (data == null) continue;
        if (!Array.isArray(data)) throw new IbError('InvestorBase returned a result we could not read.');
        return data as IbPurchase[];
      }
      if (got.status !== 404) await fail(got);
    }
    throw new IbError('InvestorBase is still searching. Try this address again in a minute.', 504);
  }
  if (!res.ok) await fail(res);
  const data = await res.json();
  if (!Array.isArray(data)) throw new IbError('InvestorBase returned a result we could not read.');
  return data as IbPurchase[];
}

async function dealAddress(db: SupabaseClient, ws: number, dealId: number): Promise<string> {
  const { data: deal } = await db.from('deals').select('id, property_id, seller_id').eq('id', dealId).eq('workspace_id', ws).maybeSingle();
  if (!deal) throw new IbError('Deal not found.', 404);
  const sellerId = (deal as Any).seller_id as number | null;
  let propId = (deal as Any).property_id as number | null;
  const seller: Any = sellerId
    ? (await db.from('sellers').select('property_address, property_id').eq('id', sellerId).maybeSingle()).data
    : null;
  propId = propId ?? seller?.property_id ?? null;
  const prop: Any = propId ? (await db.from('properties').select('line1, city, state, zip').eq('id', propId).maybeSingle()).data : null;
  const line1 = String(prop?.line1 || seller?.property_address || '');
  if (!line1) throw new IbError('The deal needs a property address first.', 422);
  const city = [prop?.city, prop?.state, prop?.zip].filter(Boolean).join(' ');
  return [line1, city].filter(Boolean).join(', ');
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  if (!['owner', 'admin', 'dispositions', 'sdr', 'tc', 'member'].includes(member.role)) return json({ error: 'your role cannot import buyers' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `investorbase:${who.user.id}`, 12, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    const key = await apiKey(admin, ws);
    let address = [b.address, [b.city, b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (b.deal_id) address = await dealAddress(asCaller, ws, Number(b.deal_id));
    const body = searchBody({ ...b, address: address || null });
    if (!body.address && body.latitude == null) return json({ error: 'Give an address or pick a deal.' }, 422);

    const found = await search(key, body);
    const drafts = buyersFromSearch(found, String(body.address ?? 'this property'));
    let created = 0;
    let existing = 0;
    let writeError: string | null = null;
    const ids: number[] = [];

    for (const d of drafts) {
      let row: { id: number; notes: string | null; tags: string[] | null; status: string | null } | null = null;
      if (d.phoneKey) {
        const hit = await admin.from('buyers').select('id, notes, tags, status').eq('workspace_id', ws).eq('phone_key', d.phoneKey).limit(1).maybeSingle();
        row = (hit.data as typeof row) ?? null;
      }
      if (!row && d.email) {
        const hit = await admin.from('buyers').select('id, notes, tags, status').eq('workspace_id', ws).eq('email', d.email).limit(1).maybeSingle();
        row = (hit.data as typeof row) ?? null;
      }
      if (row) {
        existing++;
        ids.push(row.id);
        const tags = Array.from(new Set([...(row.tags ?? []), 'investorbase']));
        const header = d.notes.split('\n')[0];
        const notes = (row.notes ?? '').includes(header) ? row.notes : [row.notes, d.notes].filter(Boolean).join('\n\n');
        await admin.from('buyers').update({ tags, notes, updated_at: new Date().toISOString() }).eq('id', row.id).eq('workspace_id', ws);
        continue;
      }
      const { data: inserted, error } = await admin.from('buyers').insert({
        workspace_id: ws, created_by: who.user.id, status: 'Prospect',
        name: d.name, company: d.company, phone: d.phone, email: d.email,
        buyer_type: d.buyer_type, entity_type: d.entity_type,
        tags: d.tags, source: d.source, notes: d.notes, buy_box: d.buy_box,
        criteria: d.criteria,
        min_purchase_price: d.criteria.price.min, max_purchase_price: d.criteria.price.max,
      }).select('id').single();
      if (error || !inserted) { writeError = error?.message ?? 'Could not save a buyer.'; continue; }
      created++;
      ids.push((inserted as { id: number }).id);
      if (d.phone) {
        await admin.from('buyer_phones').insert({
          workspace_id: ws, buyer_id: (inserted as { id: number }).id, phone: d.phone, position: 1, kind: 'wireless', source: 'investorbase',
        });
      }
      await admin.from('activity').insert({
        workspace_id: ws, entity_type: 'buyer', entity_id: (inserted as { id: number }).id,
        kind: 'buyer', title: 'Buyer prospect added', body: d.buy_box, actor_id: who.user.id,
      });
    }

    if (created === 0 && existing === 0 && writeError) throw new IbError(writeError);
    return json({ created, existing, buyers: ids, address: body.address ?? null, scanned: found.length });
  } catch (e) {
    const err = e as IbError;
    return json({ error: err.message || 'InvestorBase import failed.' }, err.status || 500);
  }
});
