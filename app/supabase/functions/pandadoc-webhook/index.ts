/**
 * POST /pandadoc-webhook?signature=<hmac> — PandaDoc status changes.
 *
 * Subscribe it in PandaDoc (Settings → Integrations → Webhooks) to
 * document_state_changed, recipient_completed, document_updated and
 * document_deleted. Tick Tokens and Fields on the subscription so we store
 * what Casey filled. Put the shared key in PANDADOC_WEBHOOK_KEY.
 *
 * No PandaDoc API is required. A document sent from the PandaDoc UI is
 * attached to the Clozr packet (or the matching seller/buyer) by metadata,
 * recipient email, or property address. Recipients include shared_link —
 * that is the signing URL without an API call.
 *
 * A completed PSA puts the seller under contract; a completed assignment
 * puts the buyer under contract; a completed termination terminates the deal.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { guessKindFromName, pickPacket, pickPerson, recipientEmails, webhookFields, type PdWebhookDoc, type PersonHit } from '../_shared/pandadoc-match.ts';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function verify(raw: string, sig: string | null): Promise<boolean> {
  const key = (Deno.env.get('PANDADOC_WEBHOOK_KEY') ?? '').trim();
  if (!key || !sig) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw)));
  if (expected.length !== sig.trim().length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.trim().charCodeAt(i);
  return diff === 0;
}
const status = (s: string | undefined) => (s ?? '').replace(/^document\./, '') || 'draft';

type Row = Record<string, unknown> & { id: number; workspace_id: number; seller_id: number | null; buyer_id: number | null; deal_id: number | null; offer_id: number | null; kind: string; name: string; status: string; sent_at: string | null; viewed_at: string | null; completed_at: string | null };

function metaNum(doc: PdWebhookDoc, key: string): number | null {
  const n = Number(doc.metadata?.[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function attachPatch(doc: PdWebhookDoc, existingTokens?: unknown): Record<string, unknown> {
  const f = webhookFields(doc);
  const patch: Record<string, unknown> = {
    pandadoc_id: doc.id,
    provider: 'pandadoc',
    last_event: { status: status(doc.status), source: 'webhook:attach', at: new Date().toISOString(), grand_total: doc.grand_total ?? null },
  };
  if (doc.name) patch.name = doc.name;
  if (f.recipients.length) patch.recipients = f.recipients;
  if (f.tokens) patch.tokens = f.tokens;
  else if (existingTokens) patch.tokens = existingTokens;
  if (f.template_id) patch.template_id = f.template_id;
  if (f.template_name) patch.template_name = f.template_name;
  return patch;
}

async function peopleForEmails(admin: SupabaseClient, emails: string[], ws: number | null): Promise<PersonHit[]> {
  if (!emails.length) return [];
  const or = emails.map((e) => `email.ilike.${e}`).join(',');
  const sellersQ = admin.from('sellers').select('id, workspace_id, email, property_address').or(or);
  const buyersQ = admin.from('buyers').select('id, workspace_id, email').or(or);
  const [{ data: sellers }, { data: buyers }] = await Promise.all([
    ws ? sellersQ.eq('workspace_id', ws) : sellersQ,
    ws ? buyersQ.eq('workspace_id', ws) : buyersQ,
  ]);
  const hits: PersonHit[] = [];
  for (const s of sellers ?? []) {
    if (!s.email) continue;
    const { data: deal } = await admin.from('deals').select('id').eq('seller_id', s.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    hits.push({ kind: 'seller', id: s.id, workspace_id: s.workspace_id, deal_id: deal?.id ?? null, address: s.property_address, email: String(s.email).toLowerCase() });
  }
  for (const b of buyers ?? []) {
    if (!b.email) continue;
    const { data: deal } = await admin.from('deals').select('id').eq('buyer_id', b.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    hits.push({ kind: 'buyer', id: b.id, workspace_id: b.workspace_id, deal_id: deal?.id ?? null, email: String(b.email).toLowerCase() });
  }
  return hits;
}

async function findOrCreate(admin: SupabaseClient, doc: PdWebhookDoc): Promise<Row | null> {
  const docId = doc.id;
  if (!docId) return null;
  // A blank copy made to import a template into CLOZR (pandadoc import_template): not a contract.
  if (doc.metadata?.clozr_import) return null;
  let { data: row } = await admin.from('contracts').select('*').eq('pandadoc_id', docId).maybeSingle();
  if (row) return row as Row;

  const contractId = metaNum(doc, 'clozr_contract_id');
  if (contractId) {
    row = (await admin.from('contracts').select('*').eq('id', contractId).maybeSingle()).data;
    if (row) {
      await admin.from('contracts').update(attachPatch(doc, row.tokens)).eq('id', row.id);
      return { ...row, ...attachPatch(doc, row.tokens), id: row.id } as Row;
    }
  }

  const offerId = metaNum(doc, 'clozr_offer_id');
  if (offerId) {
    const { data: byOffer } = await admin.from('contracts').select('*').eq('offer_id', offerId).eq('provider', 'pandadoc').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (byOffer) {
      await admin.from('contracts').update(attachPatch(doc, byOffer.tokens)).eq('id', byOffer.id);
      return { ...byOffer, ...attachPatch(doc, byOffer.tokens), id: byOffer.id } as Row;
    }
    const { data: offer } = await admin.from('offers').select('id, workspace_id, seller_id, deal_id, buyer_id').eq('id', offerId).maybeSingle();
    if (offer) {
      const kind = guessKindFromName(doc.name ?? '') || 'offer';
      const { data: created, error } = await admin.from('contracts').insert({
        workspace_id: offer.workspace_id, deal_id: offer.deal_id, seller_id: offer.seller_id, buyer_id: offer.buyer_id,
        offer_id: offer.id, kind, provider: 'pandadoc', name: doc.name || `PandaDoc ${docId}`, status: status(doc.status),
        ...attachPatch(doc),
      }).select('*').single();
      if (!error && created) return created as Row;
    }
  }

  const ws = metaNum(doc, 'clozr_workspace_id');
  let packetsQ = admin.from('contracts').select('id, workspace_id, name, offer_id, recipients, tokens, seller_id, buyer_id, deal_id, kind, status, sent_at, viewed_at, completed_at')
    .eq('provider', 'pandadoc').is('pandadoc_id', null).order('created_at', { ascending: false }).limit(80);
  if (ws) packetsQ = packetsQ.eq('workspace_id', ws);
  const { data: packets } = await packetsQ;
  const hit = pickPacket(doc, (packets ?? []).map((p) => ({ id: p.id, name: p.name, offer_id: p.offer_id, recipients: p.recipients as { email?: string }[] })));
  if (hit) {
    const existing = (packets ?? []).find((p) => p.id === hit.id);
    if (existing) {
      await admin.from('contracts').update(attachPatch(doc, existing.tokens)).eq('id', existing.id);
      return { ...existing, ...attachPatch(doc, existing.tokens), id: existing.id } as Row;
    }
  }

  const emails = recipientEmails(doc);
  const people = await peopleForEmails(admin, emails, ws);
  const person = pickPerson(doc, people);
  if (!person) return null;
  const kind = guessKindFromName(doc.name ?? '');
  const sellerId = person.kind === 'seller' ? person.id : (people.find((p) => p.kind === 'seller' && p.workspace_id === person.workspace_id)?.id ?? null);
  const buyerId = person.kind === 'buyer' ? person.id : (people.find((p) => p.kind === 'buyer' && p.workspace_id === person.workspace_id)?.id ?? null);
  const { data: created, error } = await admin.from('contracts').insert({
    workspace_id: person.workspace_id, deal_id: person.deal_id ?? null, seller_id: sellerId, buyer_id: buyerId,
    kind, provider: 'pandadoc', name: doc.name || `PandaDoc ${docId}`, status: status(doc.status),
    ...attachPatch(doc),
  }).select('*').single();
  if (error || !created) return null;
  return created as Row;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const raw = await req.text();
  const sig = new URL(req.url).searchParams.get('signature');
  if (!(await verify(raw, sig))) return json({ error: 'bad signature' }, 401);
  let events: Array<{ event: string; data?: PdWebhookDoc }>;
  try { const p = JSON.parse(raw); events = Array.isArray(p) ? p : [p]; } catch { return json({ error: 'bad json' }, 400); }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  let handled = 0;
  for (const ev of events) {
    const doc = ev?.data;
    if (!doc?.id) continue;
    const row = await findOrCreate(admin, doc);
    if (!row) continue;
    const note = async (title: string, body?: string | null) => {
      const rows = [
        row.seller_id ? { entity_type: 'seller', entity_id: row.seller_id } : null,
        row.buyer_id ? { entity_type: 'buyer', entity_id: row.buyer_id } : null,
        row.deal_id ? { entity_type: 'deal', entity_id: row.deal_id } : null,
      ].filter((r): r is { entity_type: string; entity_id: number } => !!r)
        .map((r) => ({ workspace_id: row.workspace_id, ...r, kind: 'contract', title, body: body ?? null }));
      if (rows.length) await admin.from('activity').insert(rows);
    };
    const st = ev.event === 'document_deleted' ? 'voided' : status(doc.status);
    const extras = webhookFields(doc);
    if (ev.event === 'recipient_completed' && st !== 'completed') {
      await admin.from('contract_events').insert({ workspace_id: row.workspace_id, contract_id: row.id, event: 'recipient_completed', payload: { recipients: doc.recipients ?? null } });
      if (extras.recipients.length) await admin.from('contracts').update({ recipients: extras.recipients }).eq('id', row.id);
      const rcpt = extras.recipients.find((r) => r.has_completed) ?? null;
      const who = rcpt ? [rcpt.first_name, rcpt.last_name].filter(Boolean).join(' ') || rcpt.email || 'A recipient' : 'A recipient';
      await note(`${who} signed ${row.name}`, 'PandaDoc · waiting on the other signers');
      handled++; continue;
    }
    if (st === row.status) {
      if (extras.recipients.length || extras.tokens) {
        const patch: Record<string, unknown> = {};
        if (extras.recipients.length) patch.recipients = extras.recipients;
        if (extras.tokens) patch.tokens = extras.tokens;
        if (Object.keys(patch).length) await admin.from('contracts').update(patch).eq('id', row.id);
      }
      handled++; continue;
    }
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: st, last_event: { status: st, source: `webhook:${ev.event}`, at: now, grand_total: doc.grand_total ?? null } };
    if (extras.recipients.length) patch.recipients = extras.recipients;
    if (extras.tokens) patch.tokens = extras.tokens;
    if (extras.template_name) patch.template_name = extras.template_name;
    if (st === 'sent' && !row.sent_at) patch.sent_at = now;
    if (st === 'viewed' && !row.viewed_at) patch.viewed_at = now;
    if (st === 'completed' && !row.completed_at) patch.completed_at = now;
    await admin.from('contracts').update(patch).eq('id', row.id);
    await admin.from('contract_events').insert({ workspace_id: row.workspace_id, contract_id: row.id, event: st, payload: { source: ev.event } });
    const verb: Record<string, string> = {
      sent: 'sent for signature', viewed: 'viewed by a recipient', completed: 'signed by everyone',
      voided: 'voided', declined: 'declined', paid: 'paid', approved: 'approved', rejected: 'rejected', expired: 'expired',
    };
    await note(`${row.name} ${verb[st] ?? st}`, 'PandaDoc');
    if (st === 'sent') {
      const { applySent } = await import('../_shared/docs.ts');
      await applySent(admin, row);
    }
    if (st === 'completed') {
      const { applyCompletion, applySignedDeal } = await import('../_shared/docs.ts');
      const done = { ...row, ...patch };
      await applyCompletion(admin, done);
      try { await applySignedDeal(admin, done); } catch (e) { console.error('deal sheet', (e as Error).message); }
    }
    handled++;
  }
  return json({ ok: true, handled });
});
