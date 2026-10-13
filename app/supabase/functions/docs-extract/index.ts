/**
 * POST /docs-extract — Claude reads a signed contract (or any PDF on a deal)
 * and pulls out its terms: parties, price, fee, earnest money, option period,
 * dates, title company, property, special terms. Each lands in
 * contract_extractions with a confidence and page; the deal is never written
 * until a person applies a row.
 *
 * Callers: completeContract (service role, fire and forget) and the app
 * (a member's JWT, for "Read terms" / "Re-run" and Apply / Dismiss).
 *
 * Body: { action, ... }
 *   extract { contract_id } | { deal_file_id }   → { ok, fields, diff }
 *           Replaces the rows nobody applied yet. Logs `extracted` and
 *           publishes contract.extracted.
 *   review  { contract_id } | { deal_file_id }   → { extractions, diff, deal_id, status }
 *   apply   { extraction_ids: number[] }         → { applied: number[], patch }
 *           Writes the deal column each row maps to (extract-diff.ts),
 *           stamps applied_to_deal_at / applied_by, logs `extraction_applied`.
 *   dismiss { extraction_ids: number[] }         → { dismissed: number[] }
 *
 * Env: ANTHROPIC_API_KEY (and ANTHROPIC_WORKSPACE_ID when the key spans
 * workspaces), SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, UNTRUSTED_RULE, isServiceCaller } from '../_shared/security.ts';
import { CLAUDE_MODEL } from '../_shared/models.ts';
import { type Any, logContractFeed, logEvent } from '../_shared/docs.ts';
import { publishContract } from '../_shared/contract-webhooks.ts';
import { cleanExtraction, dealDiff, EXTRACT_FIELDS, type Extraction, FIELD_KEYS, patchFor } from '../_shared/extract-diff.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const WRITERS = ['owner', 'admin', 'acquisitions', 'dispositions', 'tc'];
/** Base64 grows a file by a third; the API takes 32 MB a request. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const SYSTEM = `You read real-estate contracts for a wholesaling CRM: purchase agreements, assignments, amendments, addenda, TREC forms, commission agreements. Extract the terms listed below from the attached PDF.

Rules:
- Only report what the document actually says. Never infer, never compute a value the document does not state (an option period given only in days is option_period_days, not option_period_end).
- value is the term as printed, trimmed: money with its $ and commas, dates as written, names as written.
- Where an amendment or a later page changes a term, report the value in force and list it first.
- confidence is 0 to 1: how sure you are that this is the value and the right term (1 = printed plainly in a labelled blank; 0.5 = handwritten, ambiguous or inferred from context).
- page is the 1-based PDF page the value is on. bbox is [x, y, width, height] as fractions of the page from its top-left corner, or null when you cannot place it.
- Parties: seller, buyer and assignee once per person or company; entity for any LLC, trust or company named as a party that is not already one of those.
- special_term: up to 8 short one-line summaries of non-standard terms (seller financing, leaseback, as-is waivers, contingencies, who pays closing costs when unusual).
- Leave out anything the document does not contain. An empty list is a fine answer.

Terms:
${EXTRACT_FIELDS.map((f) => `- ${f.key}: ${f.label}${f.many ? ' (may repeat)' : ''}`).join('\n')}
${UNTRUSTED_RULE} The PDF is such data.`;

const SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: FIELD_KEYS },
          value: { type: 'string' },
          confidence: { type: 'number' },
          page: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          bbox: { anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }] },
        },
        required: ['key', 'value', 'confidence', 'page', 'bbox'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields'],
  additionalProperties: false,
};

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** One Messages API call over fetch: the PDF as a document block, the answer held to SCHEMA. */
async function askClaude(apiKey: string, pdf: Uint8Array, title: string): Promise<unknown> {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) }, title: title.slice(0, 200) },
        { type: 'text', text: 'Extract the terms from this contract.' },
      ],
    }],
  };
  const send = (withFallback: boolean) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      ...(ws ? { 'anthropic-workspace-id': ws } : {}),
      // A request the model's safeguards decline is retried on a fallback model server-side.
      ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify(withFallback ? { ...body, fallbacks: 'default' } : body),
  });
  let res = await send(true);
  let text = await res.text();
  // An account without the fallback beta still gets its answer.
  if (res.status === 400 && /fallback/i.test(text)) { res = await send(false); text = await res.text(); }
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* raw */ }
    throw new Error(res.status === 401 ? 'the ANTHROPIC_API_KEY secret is invalid' : `Claude ${res.status}: ${msg}`);
  }
  const out = JSON.parse(text) as { stop_reason?: string; content?: { type: string; text?: string }[] };
  if (out.stop_reason === 'refusal') throw new Error('Claude declined to read this document');
  if (out.stop_reason === 'max_tokens') throw new Error('the document has more terms than one read can hold');
  const answer = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  try { return JSON.parse(answer); } catch { throw new Error('Claude returned something other than the terms'); }
}

type Source = {
  ws: number; dealId: number | null; kind: string; title: string;
  contract: Record<string, Any> | null; file: Record<string, Any> | null;
  bucket: string | null; path: string | null;
};

async function loadSource(admin: SupabaseClient, b: Any): Promise<Source | null> {
  if (b.contract_id) {
    const { data: c } = await admin.from('contracts').select('*').eq('id', Number(b.contract_id)).maybeSingle();
    if (!c) return null;
    let bucket: string | null = c.pdf_path ? 'contracts' : null;
    let path: string | null = c.pdf_path ?? null;
    let file: Record<string, Any> | null = null;
    // PandaDoc and uploaded contracts keep their PDF on the deal's Files card instead.
    if (!path) {
      const { data: f } = await admin.from('deal_files').select('*').eq('contract_id', c.id).not('storage_path', 'is', null).order('created_at', { ascending: false }).limit(1);
      file = f?.[0] ?? null;
      if (file) { bucket = 'deal-files'; path = file.storage_path; }
    }
    return { ws: c.workspace_id, dealId: c.deal_id ?? null, kind: String(c.kind ?? 'other'), title: String(c.name ?? 'Contract'), contract: c, file, bucket, path };
  }
  if (b.deal_file_id) {
    const { data: f } = await admin.from('deal_files').select('*').eq('id', Number(b.deal_file_id)).maybeSingle();
    if (!f) return null;
    const kind = f.category === 'assignment' ? 'assignment' : f.category === 'addendum' ? 'addendum' : 'psa';
    return { ws: f.workspace_id, dealId: f.deal_id, kind, title: String(f.name ?? 'Document'), contract: null, file: f, bucket: f.storage_path ? 'deal-files' : null, path: f.storage_path ?? null };
  }
  return null;
}

const isPdf = (s: Source) => !s.file || /pdf/i.test(String(s.file.content_type ?? '')) || /\.pdf$/i.test(String(s.file.name ?? s.path ?? ''));

async function extractionsFor(admin: SupabaseClient, s: Source): Promise<Extraction[]> {
  const q = admin.from('contract_extractions').select('*').order('id');
  const { data } = s.contract ? await q.eq('contract_id', s.contract.id) : await q.eq('deal_file_id', s.file!.id);
  return (data ?? []) as Extraction[];
}

/** The deal and what it says about the terms that are not columns of their own. */
async function dealContext(admin: SupabaseClient, s: Source) {
  if (!s.dealId) return { deal: null, context: {}, roles: [] as string[] };
  const { data: deal } = await admin.from('deals').select('*').eq('id', s.dealId).maybeSingle();
  const [{ data: vendor }, { data: prop }, { data: signers }] = await Promise.all([
    deal?.title_vendor_id ? admin.from('vendors').select('business_name').eq('id', deal.title_vendor_id).maybeSingle() : Promise.resolve({ data: null }),
    deal?.property_id ? admin.from('properties').select('line1').eq('id', deal.property_id).maybeSingle() : Promise.resolve({ data: null }),
    s.contract ? admin.from('contract_signers').select('role').eq('contract_id', s.contract.id) : Promise.resolve({ data: [] }),
  ]);
  return {
    deal: deal as Record<string, unknown> | null,
    context: { titleCompany: vendor?.business_name ?? null, propertyAddress: prop?.line1 ?? null },
    roles: ((signers ?? []) as { role: string }[]).map((r) => String(r.role)),
  };
}

async function diffFor(admin: SupabaseClient, s: Source, rows?: Extraction[]) {
  const [x, d] = await Promise.all([rows ? Promise.resolve(rows) : extractionsFor(admin, s), dealContext(admin, s)]);
  return { extractions: x, deal: d.deal, diff: dealDiff({ extractions: x, deal: d.deal, kind: s.kind, roles: d.roles, context: d.context }) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const service = await isServiceCaller(admin, bearer);
  let userId: string | null = null;
  if (!service) {
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in first' }, 401);
    userId = who.user.id;
  }

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  /** A member of that workspace, and for anything but review, one who can change contracts. */
  const allowed = async (ws: number, write: boolean): Promise<Response | null> => {
    if (service) return null;
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', userId!).maybeSingle();
    if (!m) return json({ error: 'not a member of that workspace' }, 403);
    if (write && !WRITERS.includes(String(m.role))) return json({ error: 'your role cannot change contracts or deals' }, 403);
    return null;
  };
  const who = service ? { actor_type: 'system' as const } : { actor_type: 'user' as const, actor_id: userId };

  try {
    switch (b.action) {
      case 'extract': {
        const s = await loadSource(admin, b);
        if (!s) return json({ error: 'contract or file not found' }, 404);
        const denied = await allowed(s.ws, true);
        if (denied) return denied;
        if (!s.path || !s.bucket) return json({ error: 'There is no PDF to read on this contract yet.' }, 404);
        if (!isPdf(s)) return json({ error: 'Only PDFs can be read.' }, 422);
        const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!apiKey) return json({ error: 'Reading terms is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);
        const mark = (patch: Record<string, unknown>) => s.contract ? admin.from('contracts').update(patch).eq('id', s.contract.id) : Promise.resolve(null);
        await mark({ extract_status: 'running', extract_error: null });
        try {
          const { data: blob, error: dl } = await admin.storage.from(s.bucket).download(s.path);
          if (dl || !blob) throw new Error('could not open the PDF');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('the PDF is over 20 MB');
          const rows = cleanExtraction(await askClaude(apiKey, bytes, s.title));
          // A re-run replaces what nobody acted on; applied rows stay as the record of what was applied.
          const del = admin.from('contract_extractions').delete().is('applied_to_deal_at', null);
          const { error: delErr } = s.contract ? await del.eq('contract_id', s.contract.id) : await del.eq('deal_file_id', s.file!.id);
          if (delErr) throw new Error(delErr.message);
          const now = new Date().toISOString();
          const { data: saved, error: insErr } = rows.length ? await admin.from('contract_extractions').insert(rows.map((r) => ({
            workspace_id: s.ws, contract_id: s.contract?.id ?? null, deal_file_id: s.contract ? (s.file?.id ?? null) : s.file!.id, deal_id: s.dealId,
            field_key: r.field_key, value: r.value, confidence: r.confidence, page: r.page, bbox: r.bbox, model: CLAUDE_MODEL,
          }))).select('*') : { data: [], error: null };
          if (insErr) throw new Error(insErr.message);
          await mark({ extract_status: 'done', extracted_at: now, extract_error: null });
          const { diff } = await diffFor(admin, s);
          const keys = [...new Set(rows.map((r) => r.field_key))];
          if (s.contract) {
            await logEvent(admin, s.contract, 'extracted', { model: CLAUDE_MODEL, fields: rows.length, keys, differs: diff.map((d) => d.field_key), source: s.file ? 'deal_file' : 'contract_pdf' }, who);
            publishContract(admin, s.contract, 'contract.extracted', { fields: keys, occurredAt: now });
            if (diff.length) await logContractFeed(admin, s.contract, `${s.contract.name}: the PDF and the deal disagree`, diff.map((d) => `${d.label}: PDF says ${d.pdf_display}, deal says ${d.deal_display}`).join('\n'));
          } else if (s.dealId && diff.length) {
            await admin.from('activity').insert({ workspace_id: s.ws, entity_type: 'deal', entity_id: s.dealId, kind: 'contract', title: `${s.title}: the PDF and the deal disagree`, body: diff.map((d) => `${d.label}: PDF says ${d.pdf_display}, deal says ${d.deal_display}`).join('\n') });
          }
          return json({ ok: true, fields: saved ?? [], diff });
        } catch (e) {
          const msg = (e as Error).message.slice(0, 300);
          await mark({ extract_status: 'failed', extract_error: msg });
          if (s.contract) await logEvent(admin, s.contract, 'extract_failed', { error: msg }, who);
          console.error('docs-extract', s.contract?.id ?? s.file?.id, msg);
          return json({ error: `Could not read the terms: ${msg}` }, 502);
        }
      }
      case 'review': {
        const s = await loadSource(admin, b);
        if (!s) return json({ error: 'contract or file not found' }, 404);
        const denied = await allowed(s.ws, false);
        if (denied) return denied;
        const { extractions, diff } = await diffFor(admin, s);
        return json({
          extractions, diff, deal_id: s.dealId, has_pdf: !!s.path && isPdf(s),
          status: s.contract?.extract_status ?? null, extracted_at: s.contract?.extracted_at ?? null, error: s.contract?.extract_error ?? null,
        });
      }
      case 'apply':
      case 'dismiss': {
        const ids = (Array.isArray(b.extraction_ids) ? b.extraction_ids : []).map(Number).filter(Number.isFinite).slice(0, 100);
        if (!ids.length) return json({ error: 'extraction_ids is required' }, 422);
        const { data: picked } = await admin.from('contract_extractions').select('*').in('id', ids).is('applied_to_deal_at', null).is('dismissed_at', null);
        const rows = (picked ?? []) as (Extraction & { workspace_id: number; contract_id: number | null; deal_file_id: number | null; deal_id: number | null })[];
        if (!rows.length) return json({ error: 'nothing left to change — it was already applied or dismissed' }, 409);
        const first = rows[0];
        // One contract (or file) per call, so its checks and audit trail are one place.
        const one = rows.every((r) => r.contract_id === first.contract_id && r.deal_file_id === first.deal_file_id);
        if (!one) return json({ error: 'apply one contract at a time' }, 422);
        const s = await loadSource(admin, first.contract_id ? { contract_id: first.contract_id } : { deal_file_id: first.deal_file_id });
        if (!s) return json({ error: 'contract or file not found' }, 404);
        const denied = await allowed(s.ws, true);
        if (denied) return denied;
        const now = new Date().toISOString();

        if (b.action === 'dismiss') {
          await admin.from('contract_extractions').update({ dismissed_at: now }).in('id', rows.map((r) => r.id));
          if (s.contract) await logEvent(admin, s.contract, 'extraction_dismissed', { fields: rows.map((r) => r.field_key) }, who);
          return json({ dismissed: rows.map((r) => r.id) });
        }

        if (!s.dealId) return json({ error: 'This contract is not on a deal, so there is nothing to apply to.' }, 409);
        // The diff is worked out again here, from the deal as it is now.
        const { diff } = await diffFor(admin, s, rows);
        const patch: Record<string, string | number> = {};
        const applied: number[] = [];
        const lines: string[] = [];
        for (const d of diff) {
          const p = patchFor(d);
          if (!p) continue;
          Object.assign(patch, p);
          applied.push(d.extraction_id);
          lines.push(`${d.label}: ${d.deal_display} → ${d.pdf_display}`);
        }
        if (!applied.length) return json({ error: 'The deal already matches, or these terms have no place on the deal sheet.' }, 409);
        const { error: upErr } = await admin.from('deals').update({ ...patch, updated_at: now }).eq('id', s.dealId).eq('workspace_id', s.ws);
        if (upErr) return json({ error: upErr.message }, 500);
        // The TC file carries its own copy of the two clocks (same as a signed contract).
        const tx: Record<string, unknown> = {};
        if ('close_date' in patch) tx.close_date = patch.close_date;
        if ('option_ends_on' in patch) tx.option_ends_on = patch.option_ends_on;
        if (Object.keys(tx).length) await admin.from('transactions').update({ ...tx, updated_at: now }).eq('deal_id', s.dealId);
        await admin.from('contract_extractions').update({ applied_to_deal_at: now, applied_by: userId }).in('id', applied);
        if (s.contract) {
          await logEvent(admin, s.contract, 'extraction_applied', { fields: diff.filter((d) => applied.includes(d.extraction_id)).map((d) => d.field_key), patch }, who);
          await logContractFeed(admin, s.contract, 'Deal sheet updated from the signed PDF', lines.join('\n'));
        } else {
          await admin.from('activity').insert({ workspace_id: s.ws, entity_type: 'deal', entity_id: s.dealId, kind: 'contract', title: `Deal sheet updated from ${s.title}`, body: lines.join('\n'), actor_id: userId });
        }
        return json({ applied, patch });
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
