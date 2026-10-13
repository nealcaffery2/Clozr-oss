/**
 * POST /ingest — the one door into CLOZR.
 *
 * CLOZR ships as a static export, so it has no server of its own. This edge
 * function is the whole server surface: Deal Machine, Talkr, COMPR and buyr all
 * post the same envelope here and a thin adapter on their side maps their shape
 * into it. Adding a sixth source should be a day, not a project.
 *
 * Auth is an API key, not a user JWT — the callers are machines, and a Chrome
 * extension has no Supabase session. `verify_jwt` is therefore off and this
 * file owns authentication: bearer token, SHA-256, constant-time compare
 * against ingest_sources.key_hash.
 *
 * Idempotency lives in the database (public.ingest_apply), keyed on
 * (workspace, source, source_id). Talkr's fan-out is explicitly at-least-once
 * and unordered, and an extension retries on its own, so a redelivery returns
 * the first delivery's result with deduped:true rather than writing again.
 *
 * Flat sources (`zapier`, `jotform`) post one flat object instead — or Jotform's
 * multipart form — which _shared/flat.ts maps and public.ingest_apply_flat
 * applies against the same ingest_events ledger. They may pass the key as
 * ?key= because Jotform's webhook cannot set headers. A flat submission id the
 * ledger already has comes back deduped when its content is unchanged, and
 * patches its record when it changed (an edited Jotform submission re-posted:
 * empty fields filled, tags added, notes appended, nothing blanked) with
 * {updated: true} (migration 132).
 *
 * Deploy:  supabase functions deploy ingest --no-verify-jwt
 * Contract: docs/ingest.md, docs/webhooks.md
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, clientIp, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { type Flat, buyBoxFromFlat, fillOnly, flatToEnvelope, jotAnswersFromRaw, jotformToFlat } from '../_shared/flat.ts';
import { dealColumns, dealLinks, hasDealFacts, ilikeExact, nameIsAddress } from '../_shared/ingest-deal.ts';
import { hasRoundRobin, roundRobinLead } from '../_shared/round-robin.ts';
import { mergedIntoId, pickLiveSeller, type SellerMatchRow } from '../_shared/seller-match.ts';

const FLAT_SOURCES = new Set(['zapier', 'jotform']);

function createsOf(settings: { creates?: string } | null): 'seller' | 'buyer' | 'wholesaler' {
  const c = settings?.creates;
  return c === 'buyer' || c === 'wholesaler' ? c : 'seller';
}

/** JSON, multipart (Jotform) or urlencoded — flattened to one object. */
async function readBody(req: Request): Promise<Flat> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await req.formData();
    const out: Flat = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
    return out;
  }
  return await req.json();
}

const CORS = {
  // The senders are servers and extensions, which are not origin-bound; the
  // browser preflight still has to be answered for the extension case.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, ...HARDENING, 'Content-Type': 'application/json' },
  });

/** Hex SHA-256, matching what the key-issuing SQL stores. */
async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type Envelope = {
  source?: string;
  source_id?: string;
  type?: string;
  occurred_at?: string;
  property?: Record<string, unknown>;
  person?: Record<string, unknown>;
  deal?: Record<string, unknown>;
  /** A buyer on its own (no property, no person): applied like a flat buyer, deduped by phone or email. */
  buyer?: Record<string, unknown>;
  /** `run_compr`: underwrite a deal this delivery created (also needs the key's `auto_compr` not 'off'). */
  options?: { run_compr?: boolean };
  raw?: unknown;
};

type Db = SupabaseClient;

/** Supabase's edge runtime keeps the isolate alive for this promise after the response. */
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SELLER_MATCH_COLS = 'id, phone, archived_at, tags, lead_stage, notes';

/** Follow merged-into pointers so the map holds every row resolveLiveSeller needs. */
async function loadMergeChain(db: Db, ws: number, seeds: SellerMatchRow[]): Promise<Map<number, SellerMatchRow>> {
  const byId = new Map<number, SellerMatchRow>();
  const queue: number[] = [];
  const push = (row: SellerMatchRow) => {
    if (byId.has(row.id)) return;
    byId.set(row.id, row);
    const next = mergedIntoId(row);
    if (next != null) queue.push(next);
  };
  for (const row of seeds) push(row);
  let fetched = 0;
  while (queue.length && fetched < 8) {
    const id = queue.shift()!;
    if (byId.has(id)) continue;
    fetched++;
    const { data } = await db.from('sellers').select(SELLER_MATCH_COLS).eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (data) push(data as SellerMatchRow);
  }
  return byId;
}

/**
 * A partner with no phone is still one contact across many deals: find them
 * by email, then by name, before ingest_apply would make a new contact per
 * property. An archived or merged seller is never the contact: a merged-into
 * pointer is followed to the live seller. Returns that contact, if any.
 */
async function findPartner(db: Db, ws: number, person: Record<string, unknown>): Promise<{ id: number; phone: string | null } | null> {
  const email = typeof person.email === 'string' ? person.email.trim() : '';
  const name = typeof person.name === 'string' ? person.name.trim() : '';
  for (const [col, v] of [['email', email], ['name', name]] as const) {
    if (!v) continue;
    const { data } = await db.from('sellers').select(SELLER_MATCH_COLS).eq('workspace_id', ws)
      .ilike(col, ilikeExact(v))
      .order('archived_at', { ascending: true, nullsFirst: true })
      .order('id')
      .limit(20);
    const seeds = (data ?? []) as SellerMatchRow[];
    if (!seeds.length) continue;
    const byId = await loadMergeChain(db, ws, seeds);
    const liveId = pickLiveSeller(seeds.map((r) => r.id), byId);
    if (liveId == null) continue;
    return { id: liveId, phone: byId.get(liveId)?.phone ?? null };
  }
  return null;
}

/**
 * The `deal` section onto a deal row: one deal per (workspace, source,
 * source_id), found again on a redelivery, so this is safe to run on every
 * delivery including deduped ones. New deals start as Prospect (kept out of
 * totals until someone works them). Photo and listing links already on the
 * deal are skipped.
 */
async function applyDeal(db: Db, ws: number, src: string, e: Envelope, propertyId: number, sellerId: number | null) {
  const cols = dealColumns(e.deal);
  const { data: found } = await db.from('deals').select('id, seller_id')
    .eq('workspace_id', ws).eq('source', src).eq('source_id', e.source_id!).order('id').limit(1);
  let dealId: number;
  let created = false;
  if (found?.length) {
    dealId = found[0].id as number;
    const patch = { ...cols, ...(found[0].seller_id ? {} : { seller_id: sellerId }), updated_at: new Date().toISOString() };
    const { error } = await db.from('deals').update(patch).eq('id', dealId);
    if (error) throw error;
  } else {
    const { data, error } = await db.from('deals').insert({
      workspace_id: ws, property_id: propertyId, seller_id: sellerId, stage: 'Prospect', source: src, source_id: e.source_id,
      submitted_at: e.occurred_at ?? new Date().toISOString(), ...cols,
    }).select('id').single();
    if (error) throw error;
    dealId = data.id as number;
    created = true;
  }
  const links = dealLinks(e.deal);
  let added = 0;
  if (links.length) {
    const { data: have } = await db.from('deal_files').select('url').eq('deal_id', dealId).not('url', 'is', null);
    const known = new Set((have ?? []).map((r) => r.url as string));
    const rows = links.filter((l) => !known.has(l.url)).map((l) => ({ workspace_id: ws, deal_id: dealId, source: src, ...l }));
    if (rows.length) {
      const { error } = await db.from('deal_files').insert(rows);
      if (error) throw error;
      added = rows.length;
    }
  }
  return { dealId, created, added };
}

/**
 * Shape check only. Anything semantic — does this address resolve, is this
 * phone real — belongs in SQL beside the keys it produces, not here.
 */
function invalid(e: Envelope): string | null {
  if (!e || typeof e !== 'object') return 'body must be a JSON object';
  if (!e.source || typeof e.source !== 'string') return 'source is required';
  if (!e.source_id || typeof e.source_id !== 'string') return 'source_id is required';
  if (e.source.length > 64) return 'source is too long';
  if (e.source_id.length > 256) return 'source_id is too long';
  if (e.occurred_at && Number.isNaN(Date.parse(e.occurred_at))) {
    return 'occurred_at must be an ISO 8601 timestamp';
  }
  for (const k of ['property', 'person', 'deal', 'buyer', 'options'] as const) {
    const v = e[k];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      return `${k} must be an object`;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  // ?key= is for senders that cannot set headers (Jotform, some Zapier apps).
  // ponytail: a key in a URL can land in the sender's logs; disable and reissue if one leaks.
  const key = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (new URL(req.url).searchParams.get('key') ?? '').trim();
  if (!key) return json({ error: 'missing bearer token or ?key=' }, 401);

  // Service role: the senders are trusted machines and RLS has no session to
  // scope. The workspace comes from the key, never from the request body, so a
  // stolen Deal Machine key still cannot write into another workspace.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Guessing keys is the attack here: a per-address ceiling on failed lookups
  // makes a 192-bit key search pointless rather than merely slow.
  const ip = clientIp(req);
  const { data: src } = await db
    .from('ingest_sources')
    .select('id, workspace_id, name, active, settings')
    .eq('key_hash', await sha256(key))
    .maybeSingle();

  if (!src) {
    const rl = await rateLimit(db, `ingest:badkey:${ip}`, 30, 600);
    if (!rl.allowed) return tooMany(CORS, rl);
    return json({ error: 'unknown key' }, 401);
  }
  if (!src.active) return json({ error: 'key is disabled' }, 403);
  // The TV dashboard's key only reads (GET /leaderboard); it cannot write a lead.
  if (src.name === 'dashboard') return json({ error: 'a dashboard key is read-only' }, 403);

  // Per key: generous for a real fan-out, low enough that a runaway sender
  // cannot write faster than the database can be read.
  const perKey = await rateLimit(db, `ingest:key:${src.id}`, 600, 60);
  if (!perKey.allowed) return tooMany(CORS, perKey);

  if (FLAT_SOURCES.has(src.name)) {
    let flat: Flat;
    try {
      flat = await readBody(req);
    } catch {
      return json({ error: 'body is not valid JSON or form data' }, 400);
    }
    if (!flat || typeof flat !== 'object' || Array.isArray(flat)) return json({ error: 'body must be a JSON object' }, 422);
    if (src.name === 'zapier' && !flat.event && !flat.Event) {
      const creates = createsOf(src.settings as { creates?: string } | null);
      flat = {
        ...flat,
        event: creates === 'buyer' ? 'buyer.create' : creates === 'wholesaler' ? 'wholesaler.create' : 'lead.create',
      };
    }
    if (src.name === 'jotform') {
      if (!flat.submissionID) return json({ error: 'not a Jotform webhook: submissionID is missing' }, 422);
      flat = jotformToFlat(jotAnswersFromRaw(flat.rawRequest), {
        submissionId: String(flat.submissionID),
        formTitle: flat.formTitle ? String(flat.formTitle) : undefined,
        creates: createsOf(src.settings as { creates?: string } | null),
      });
    }
    // No external_id: a hash of the body, so a Zap that replays a step dedupes.
    const sourceId = flat.external_id ? String(flat.external_id) : `sha:${await sha256(JSON.stringify(flat))}`;
    const envelope = flatToEnvelope(src.name, flat, sourceId);
    if ('error' in envelope) return json({ ok: false, error: envelope.error }, 422);

    const { data, error } = await db.rpc('ingest_apply_flat', { p_workspace_id: src.workspace_id, p_envelope: envelope });
    if (error) return serverError(CORS, `ingest_apply_flat failed source=${src.name} source_id=${sourceId}`, error);
    void db.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', src.id);
    // Settings → Round robin: a new seller lead goes to the next rep on this key's rotation.
    // An edited submission sent again patches its record ({updated: true}, migration 132): not a new lead, no new rep.
    const applied = data as { deduped?: boolean; updated?: boolean; kind?: string; id?: number } | null;
    // A buy-box form (the website's buyers list) also fills the buyer's criteria columns, never over what is there.
    if (applied?.kind === 'buyer' && applied.id) {
      const box = buyBoxFromFlat(flat);
      if (Object.keys(box).length) {
        const { data: row } = await db.from('buyers').select(Object.keys(box).join(',')).eq('id', applied.id).eq('workspace_id', src.workspace_id).maybeSingle();
        const patch = row ? fillOnly(row as Record<string, unknown>, box) : {};
        if (Object.keys(patch).length) {
          const { error: boxErr } = await db.from('buyers').update(patch).eq('id', applied.id).eq('workspace_id', src.workspace_id);
          if (boxErr) console.error('ingest buy box', { buyer: applied.id, error: boxErr.message });
        }
      }
    }
    if (hasRoundRobin(src.settings) && applied && !applied.deduped && !applied.updated && applied.kind === 'seller') {
      const rr = await roundRobinLead(db, src.id, applied.id);
      if (rr?.assigned) return json({ ...applied, assigned_to: rr.user_id }, 200);
    }
    return json(data, 200);
  }

  let body: Envelope;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  // A sender's "Test connection": the key checked above, nothing written.
  if (body && typeof body === 'object' && body.type === 'ping') return json({ ok: true, source: src.name }, 200);

  const bad = invalid(body);
  if (bad) return json({ error: bad }, 422);

  // The key decides who you are; claiming a different source in the body is a
  // mistake worth failing loudly rather than silently rewriting.
  if (body.source !== src.name) {
    return json({ error: `key is for source "${src.name}", body says "${body.source}"` }, 422);
  }

  const ws = src.workspace_id as number;
  // Hygiene stamp: best-effort, never awaited into the response path.
  const touch = () => void db.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', src.id);

  // A buyer on its own goes through the flat buyer path: phone/email dedupe, merge, a note on a repeat.
  if (body.buyer && !body.property && !body.person) {
    const { data, error } = await db.rpc('ingest_apply_flat', { p_workspace_id: ws, p_envelope: { ...body, mode: 'buyer' } });
    if (error) return serverError(CORS, `ingest_apply_flat(buyer) failed source=${src.name} source_id=${body.source_id}`, error);
    touch();
    return json(data, 200);
  }

  // The contact: never named after the address, and a phoneless partner is
  // merged into their existing contact instead of one new contact per property.
  const line1 = body.property?.line1;
  const person = body.person ? { ...body.person } : undefined;
  let partnerId: number | null = null;
  if (person) {
    if (nameIsAddress(person.name, line1)) person.name = nameIsAddress(person.company, line1) ? undefined : person.company;
    if (!person.phone) {
      const partner = await findPartner(db, ws, person);
      if (partner?.phone) person.phone = partner.phone; // ingest_apply merges on the phone key
      else if (partner) {
        partnerId = partner.id;
        delete person.name; // ingest_apply then creates no contact; the partner is attached below
      }
    }
  }

  const { data, error } = await db.rpc('ingest_apply', {
    p_workspace_id: ws,
    p_envelope: person ? { ...body, person } : body,
  });

  if (error) {
    return serverError(CORS, `ingest_apply failed source=${src.name} source_id=${body.source_id}`, error);
  }

  const applied = data as { deduped?: boolean; property_id?: number | null; seller_id?: number | null };
  const sellerId = applied.seller_id ?? partnerId;
  if (partnerId && !applied.seller_id && !applied.deduped) {
    await db.from('ingest_events').update({ seller_id: partnerId })
      .eq('workspace_id', ws).eq('source', src.name).eq('source_id', body.source_id!);
  }

  const extra: Record<string, unknown> = sellerId !== applied.seller_id ? { seller_id: sellerId } : {};
  if (applied.property_id && hasDealFacts(body.deal)) {
    try {
      const d = await applyDeal(db, ws, src.name, body, applied.property_id, sellerId);
      Object.assign(extra, { deal_id: d.dealId, deal_created: d.created, files_added: d.added });
      // COMPR only for a deal this delivery created, so a redelivery never bills twice.
      // ponytail: a delivery that created the deal but failed on its files is retried
      // without COMPR; Run COMPR from the record covers that rare case.
      const autoCompr = (src.settings as { auto_compr?: string } | null)?.auto_compr !== 'off';
      if (d.created && body.options?.run_compr === true && autoCompr && sellerId && line1 && body.property?.state) {
        EdgeRuntime.waitUntil(queueCompr(ws, sellerId, d.dealId));
        extra.compr = 'queued';
      }
    } catch (e) {
      // The lead is applied and ledgered; the deal step is idempotent and reruns on the sender's retry.
      return serverError(CORS, `ingest deal step failed source=${src.name} source_id=${body.source_id}`, e);
    }
  }

  if (hasRoundRobin(src.settings) && !applied.deduped && applied.seller_id) {
    const rr = await roundRobinLead(db, src.id, applied.seller_id);
    if (rr?.assigned) extra.assigned_to = rr.user_id;
  }

  touch();
  return json({ ...(data as Record<string, unknown>), ...extra }, 200);
});

/**
 * Underwrite a new ingested deal through compr-underwrite, which owns the
 * COMPR key, the per-workspace hourly cap and the write-back. Runs after the
 * response (EdgeRuntime.waitUntil); failures only reach the log.
 */
async function queueCompr(ws: number, sellerId: number, dealId: number) {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/compr-underwrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ workspace_id: ws, seller_id: sellerId, deal_id: dealId }),
    });
    if (!res.ok) console.error('ingest compr', { status: res.status, deal: dealId, body: (await res.text()).slice(0, 300) });
  } catch (e) {
    console.error('ingest compr', { deal: dealId, err: (e as Error).message });
  }
}
