/**
 * POST /pandadoc — contracts through PandaDoc, from a seller or a deal.
 *
 * The API key is a project secret (PANDADOC_API_KEY); the browser never sees
 * it. The caller's session decides what they may touch (RLS on sellers,
 * deals, buyers, contracts); the contract row is written with the service
 * role once PandaDoc has answered.
 *
 * Body: { workspace_id, action, ... }
 *   templates  { q? }                              → { templates: [{ id, name }] }
 *   template   { template_id }                     → { roles: [], tokens: [] }
 *   create     { template_id, template_name?, kind, seller_id?, deal_id?, buyer_id?, name?, recipients: [{ email, first_name?, last_name?, role? }], tokens?: [{ name, value }], send?: { subject?, message? } }
 *   send       { contract_id, subject?, message? }
 *   preview    { contract_id, recipient? }         → { url }   (a signing session link)
 *   refresh    { contract_id }                     → { contract }
 *   void       { contract_id }
 *   pdf        { contract_id }                     → application/pdf
 *
 * Signed: a completed PSA moves the seller to Under Contract - Seller (the
 * database opens the deal), a completed assignment moves the deal to Buyer
 * Under Contract, a completed termination terminates it.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS } from '../_shared/security.ts';
import { PdError, pd, status } from '../_shared/pandadoc.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Token values from the records. Templates use [Token.Name] merge fields; unknown names are ignored by PandaDoc. */
function tokens(deal: Record<string, unknown> | null, seller: Record<string, unknown> | null, prop: Record<string, unknown> | null, buyer: Record<string, unknown> | null, signer: { name?: string | null; email?: string | null; phone?: string | null }) {
  const money = (n: unknown) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
  const date = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
  const str = (v: unknown) => (v == null ? '' : String(v));
  const address = str(prop?.line1 || seller?.property_address);
  const city = str(prop?.city); const state = str(prop?.state); const zip = str(prop?.zip);
  const full = [address, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');
  const sellerName = str(seller?.name); const [sFirst, ...sRest] = sellerName.split(/\s+/);
  const buyerName = str(buyer?.name); const [bFirst, ...bRest] = buyerName.split(/\s+/);
  const price = deal?.offer_amount; const sold = deal?.sold_price;
  const pairs: Record<string, string> = {
    'Property.Address': address, 'Property.City': city, 'Property.State': state, 'Property.Zip': zip, 'Property.FullAddress': full, 'Property.County': str(prop?.county),
    'Property.Beds': str(prop?.beds), 'Property.Baths': str(prop?.baths), 'Property.Sqft': str(prop?.sqft), 'Property.YearBuilt': str(prop?.year_built), 'Property.APN': str(prop?.apn),
    'Seller.Name': sellerName, 'Seller.FullName': sellerName, 'Seller.FirstName': sFirst ?? '', 'Seller.LastName': sRest.join(' '), 'Seller.Email': str(seller?.email), 'Seller.Phone': str(seller?.phone),
    'Buyer.Name': buyerName, 'Buyer.FullName': buyerName, 'Buyer.FirstName': bFirst ?? '', 'Buyer.LastName': bRest.join(' '), 'Buyer.Company': str(buyer?.company), 'Buyer.Email': str(buyer?.email), 'Buyer.Phone': str(buyer?.phone),
    'Deal.PurchasePrice': money(price), 'Deal.ContractPrice': money(price), 'Deal.SoldPrice': money(sold), 'Deal.AssignmentPrice': money(sold ?? (price != null ? Number(price) + Number(deal?.assignment_fee ?? 0) : null)),
    'Deal.AssignmentFee': money(deal?.assignment_fee), 'Deal.EMD': money(deal?.earnest_money), 'Deal.ARV': money(deal?.arv), 'Deal.Repairs': money(deal?.rehab), 'Deal.MAO': money(deal?.mao),
    'Deal.ContractDate': date(deal?.contract_date), 'Deal.ClosingDate': date(deal?.close_date), 'Deal.OptionEnds': date(deal?.option_ends_on),
    'Deal.TitleContact': str(deal?.title_contact), 'Deal.TitlePhone': str(deal?.title_phone), 'Deal.TitleEmail': str(deal?.title_email),
    'Company.Name': Deno.env.get('COMPANY_NAME') ?? 'Acme Homes', 'Company.Signer': str(signer.name), 'Company.Email': str(signer.email), 'Company.Phone': str(signer.phone),
    'Date.Today': date(new Date().toISOString()),
  };
  return Object.entries(pairs).filter(([, v]) => v !== '').map(([name, value]) => ({ name, value }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  if (!['owner', 'admin', 'acquisitions', 'dispositions', 'tc'].includes(member.role)) return json({ error: 'your role cannot send contracts' }, 403);

  const loadContract = async (id: number) => {
    const { data } = await asCaller.from('contracts').select('*').eq('id', id).eq('workspace_id', ws).maybeSingle();
    return data as Record<string, any> | null;
  };
  const apply = async (row: Record<string, any>, st: string, source: string) => {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: st, last_event: { status: st, source, at: now } };
    if (st === 'sent' && !row.sent_at) patch.sent_at = now;
    if (st === 'viewed' && !row.viewed_at) patch.viewed_at = now;
    if (st === 'completed' && !row.completed_at) patch.completed_at = now;
    await admin.from('contracts').update(patch).eq('id', row.id);
    await admin.from('contract_events').insert({ workspace_id: ws, contract_id: row.id, event: st, payload: { source } });
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
    return { ...row, ...patch };
  };

  try {
    switch (b.action) {
      case 'templates': {
        const q = new URLSearchParams({ count: '100' }); if (b.q) q.set('q', String(b.q));
        const r = await pd<{ results: { id: string; name: string; date_modified: string }[] }>('GET', `/templates?${q}`);
        return json({ templates: (r.results ?? []).map((t) => ({ id: t.id, name: t.name, modified: t.date_modified })) });
      }
      case 'template': {
        const t = await pd<{ id: string; name: string; roles?: { name: string }[]; tokens?: { name: string }[] }>('GET', `/templates/${encodeURIComponent(String(b.template_id))}/details`);
        return json({ id: t.id, name: t.name, roles: (t.roles ?? []).map((r) => r.name), tokens: (t.tokens ?? []).map((x) => x.name) });
      }
      case 'create': {
        const recipients = (Array.isArray(b.recipients) ? b.recipients : []).filter((r: any) => r?.email).map((r: any) => ({ email: String(r.email).trim().toLowerCase(), first_name: r.first_name || undefined, last_name: r.last_name || undefined, role: r.role || undefined }));
        if (!b.template_id) return json({ error: 'template_id is required' }, 422);
        if (!recipients.length) return json({ error: 'at least one recipient with an email is required' }, 422);
        const kind = ['psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'other'].includes(b.kind) ? b.kind : 'other';
        const sellerId = b.seller_id ? Number(b.seller_id) : null; const dealId = b.deal_id ? Number(b.deal_id) : null; const buyerId = b.buyer_id ? Number(b.buyer_id) : null;
        const [{ data: seller }, { data: deal0 }, { data: buyer0 }, { data: profile }] = await Promise.all([
          sellerId ? asCaller.from('sellers').select('*').eq('id', sellerId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
          dealId ? asCaller.from('deals').select('*').eq('id', dealId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
          buyerId ? asCaller.from('buyers').select('*').eq('id', buyerId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
          asCaller.from('profiles').select('full_name, email, phone').eq('id', who.user.id).maybeSingle(),
        ]);
        // A seller implies their live deal; a deal implies its seller and buyer.
        const deal = deal0 ?? (seller ? (await asCaller.from('deals').select('*').eq('seller_id', seller.id).order('created_at', { ascending: false }).limit(1).maybeSingle()).data : null);
        const sellerRow = seller ?? (deal?.seller_id ? (await asCaller.from('sellers').select('*').eq('id', deal.seller_id).maybeSingle()).data : null);
        const buyer = buyer0 ?? (deal?.buyer_id ? (await asCaller.from('buyers').select('*').eq('id', deal.buyer_id).maybeSingle()).data : null);
        const prop = (deal?.property_id ?? sellerRow?.property_id) ? (await asCaller.from('properties').select('*').eq('id', deal?.property_id ?? sellerRow?.property_id).maybeSingle()).data : null;
        if (!sellerRow && !deal && !buyer) return json({ error: 'seller, deal or buyer not found' }, 404);
        const auto = tokens(deal, sellerRow, prop, buyer, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
        const overrides = new Map<string, string>((Array.isArray(b.tokens) ? b.tokens : []).filter((t: any) => t?.name).map((t: any) => [String(t.name), String(t.value ?? '')]));
        const toks = [...auto.filter((t) => !overrides.has(t.name)), ...Array.from(overrides, ([name, value]) => ({ name, value }))].filter((t) => t.value !== '');
        const address = String(prop?.line1 || sellerRow?.property_address || '');
        const name = String(b.name || `${b.template_name || kind.toUpperCase()} - ${address}`).slice(0, 200);
        const { data: row, error } = await admin.from('contracts').insert({
          workspace_id: ws, deal_id: deal?.id ?? null, seller_id: sellerRow?.id ?? null, buyer_id: buyer?.id ?? null, kind, provider: 'pandadoc',
          template_id: String(b.template_id), template_name: b.template_name ?? null,
          name, status: 'draft', recipients, tokens: toks, created_by: who.user.id,
        }).select('*').single();
        if (error) return json({ error: error.message }, 500);
        try {
          const doc = await pd<{ id: string; status: string }>('POST', '/documents', { name, template_uuid: b.template_id, recipients, tokens: toks, metadata: { clozr_contract_id: String(row.id), clozr_workspace_id: String(ws) }, tags: ['clozr', kind] });
          let cur = doc;
          for (let i = 0; i < 10 && status(cur.status) === 'uploaded'; i++) { await new Promise((r) => setTimeout(r, 1000 + i * 500)); cur = await pd('GET', `/documents/${doc.id}`); }
          await admin.from('contracts').update({ pandadoc_id: doc.id, status: status(cur.status) }).eq('id', row.id);
          let out = { ...row, pandadoc_id: doc.id, status: status(cur.status) };
          if (b.send) {
            const sent = await pd<{ status: string }>('POST', `/documents/${doc.id}/send`, { subject: b.send.subject, message: b.send.message, silent: false });
            out = await apply(out, status(sent.status) === 'draft' ? 'sent' : status(sent.status), 'send');
          } else {
            await admin.from('contract_events').insert({ workspace_id: ws, contract_id: row.id, event: 'created', payload: { pandadoc_id: doc.id } });
          }
          return json({ contract: out });
        } catch (e) {
          await admin.from('contracts').update({ status: 'error', last_event: { error: String((e as Error).message).slice(0, 300) } }).eq('id', row.id);
          throw e;
        }
      }
      case 'send': {
        const row = await loadContract(Number(b.contract_id)); if (!row?.pandadoc_id) return json({ error: 'contract not found' }, 404);
        const sent = await pd<{ status: string }>('POST', `/documents/${row.pandadoc_id}/send`, { subject: b.subject, message: b.message, silent: false });
        return json({ contract: await apply(row, status(sent.status) === 'draft' ? 'sent' : status(sent.status), 'send') });
      }
      case 'preview': {
        const row = await loadContract(Number(b.contract_id)); if (!row?.pandadoc_id) return json({ error: 'contract not found' }, 404);
        const recipient = b.recipient || (row.recipients as { email: string }[])[0]?.email;
        if (!recipient) return json({ error: 'no recipient to open a session for' }, 422);
        const s = await pd<{ id: string; expires_at: string }>('POST', `/documents/${row.pandadoc_id}/session`, { recipient, lifetime: 3600 });
        return json({ url: `https://app.pandadoc.com/s/${s.id}`, expires_at: s.expires_at });
      }
      case 'refresh': {
        const row = await loadContract(Number(b.contract_id)); if (!row?.pandadoc_id) return json({ error: 'contract not found' }, 404);
        const doc = await pd<{ status: string }>('GET', `/documents/${row.pandadoc_id}`);
        const st = status(doc.status);
        return json({ contract: st !== row.status ? await apply(row, st, 'refresh') : row });
      }
      case 'void': {
        const row = await loadContract(Number(b.contract_id)); if (!row?.pandadoc_id) return json({ error: 'contract not found' }, 404);
        await pd('POST', `/documents/${row.pandadoc_id}/status`, { status: 'document.voided' }).catch(() => undefined);
        return json({ contract: await apply(row, 'voided', 'void') });
      }
      case 'import_template': {
        // A PandaDoc template becomes a CLOZR PDF template: PandaDoc renders a
        // blank copy, we keep its PDF and signer roles, and the copy is
        // deleted. Fields are placed once in CLOZR (Contracts → Templates →
        // Fields); from then on CLOZR fills and sends it, no PandaDoc.
        if (!['owner', 'admin'].includes(member.role)) return json({ error: 'only an owner or admin can add templates' }, 403);
        const tid = String(b.template_id ?? '');
        if (!tid) return json({ error: 'template_id is required' }, 422);
        const t = await pd<{ id: string; name: string; roles?: { name: string }[] }>('GET', `/templates/${encodeURIComponent(tid)}/details`);
        const doc = await pd<{ id: string; status: string }>('POST', '/documents', { name: `${t.name} (CLOZR import)`, template_uuid: tid, recipients: [], metadata: { clozr_import: 'template', clozr_workspace_id: String(ws) } });
        let cur = doc;
        for (let i = 0; i < 12 && status(cur.status) === 'uploaded'; i++) { await new Promise((r) => setTimeout(r, 1000 + i * 500)); cur = await pd('GET', `/documents/${doc.id}`); }
        if (status(cur.status) === 'uploaded') return json({ error: 'PandaDoc is still preparing that template. Try again in a minute.' }, 503);
        const pdf = new Uint8Array(await pd<ArrayBuffer>('GET', `/documents/${doc.id}/download`, undefined, true));
        await pd('DELETE', `/documents/${doc.id}`).catch(() => undefined);
        const safe = t.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'template';
        const path = `ws/${ws}/templates/${crypto.randomUUID()}-${safe}.pdf`;
        const up = await admin.storage.from('doc-sources').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
        if (up.error) return json({ error: up.error.message }, 500);
        const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'signer';
        const party = (n: string) => (/seller|owner|grantor|assignor/i.test(n) ? 'seller' : /buyer|assignee|purchaser|investor/i.test(n) ? 'buyer' : 'company');
        // A PandaDoc CC / copy / TC / coordinator role is copied here too, never made a signer.
        const copied = (n: string) => /\bcc\b|copy|coordinator|\btc\b/i.test(n);
        const roles = (t.roles ?? []).map((r) => ({ role: slug(r.name), label: r.name, party: party(r.name), ...(copied(r.name) ? { recipient_type: 'cc' } : {}) }));
        const kind = /terminat|cancel|release/i.test(t.name) ? 'termination' : /assign/i.test(t.name) ? 'assignment' : /amend/i.test(t.name) ? 'amendment'
          : /option/i.test(t.name) ? 'option' : /novation/i.test(t.name) ? 'novation' : /joint|\bjv\b/i.test(t.name) ? 'jv' : /disclos/i.test(t.name) ? 'disclosure'
          : /addend/i.test(t.name) ? 'addendum' : /psa|purchase/i.test(t.name) ? 'psa' : 'other';
        const { data: row, error } = await admin.from('doc_templates').insert({
          workspace_id: ws, key: `pd_${tid.slice(0, 20)}_${Date.now().toString(36)}`, name: t.name, kind, body_md: '',
          signers: roles.length ? roles : [{ role: 'seller', label: 'Seller', party: 'seller' }], sort: 140, active: true, mode: 'pdf', pdf_path: path, created_by: who.user.id,
        }).select('id, name').single();
        if (error) return json({ error: error.message }, 500);
        return json({ template: row });
      }
      case 'pdf': {
        const row = await loadContract(Number(b.contract_id)); if (!row?.pandadoc_id) return json({ error: 'contract not found' }, 404);
        const buf = await pd<ArrayBuffer>('GET', `/documents/${row.pandadoc_id}/download`, undefined, true);
        return new Response(buf, { headers: { ...CORS, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${String(row.name).replace(/[^\w.-]+/g, '_')}.pdf"` } });
      }
      case 'sync': {
        // Pull documents created in PandaDoc (or status-changed there) into CLOZR.
        const r = await pd<{ results: { id: string; name: string; status: string; date_created?: string; metadata?: Record<string, string> }[] }>('GET', '/documents?count=100');
        let upserted = 0;
        for (const d of r.results ?? []) {
          const st = status(d.status);
          let { data: existing } = await admin.from('contracts').select('*').eq('workspace_id', ws).eq('pandadoc_id', d.id).maybeSingle();
          if (!existing && d.metadata?.clozr_contract_id) {
            existing = (await admin.from('contracts').select('*').eq('id', Number(d.metadata.clozr_contract_id)).eq('workspace_id', ws).maybeSingle()).data;
          }
          if (existing) {
            if (existing.status !== st) await apply(existing, st, 'sync');
            else if (!existing.pandadoc_id) await admin.from('contracts').update({ pandadoc_id: d.id, provider: 'pandadoc' }).eq('id', existing.id);
            upserted++;
            continue;
          }
          const kind = /terminat|cancel|release/i.test(d.name) ? 'termination'
            : /assign/i.test(d.name) ? 'assignment'
              : /offer|loi|letter of intent/i.test(d.name) ? 'offer'
                : /amend/i.test(d.name) ? 'amendment'
                  : /purchase|psa|sale|agreement|contract/i.test(d.name) ? 'psa' : 'other';
          const { error } = await admin.from('contracts').insert({
            workspace_id: ws, kind, provider: 'pandadoc', pandadoc_id: d.id, name: d.name, status: st,
            created_by: who.user.id, last_event: { status: st, source: 'sync', at: new Date().toISOString() },
          });
          if (!error) upserted++;
        }
        return json({ upserted });
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    const status_ = e instanceof PdError ? e.status : 502;
    return json({ error: (e as Error).message }, status_);
  }
});
