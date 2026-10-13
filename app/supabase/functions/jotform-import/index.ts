/**
 * POST /jotform-import — backfill past Jotform submissions through the ingest path.
 *
 * Body: { workspace_id, key_id, action, form_id?, offset? }
 *   forms   → { ok, forms: [{ id, title, count }] }
 *   import  { form_id, offset } → one page of 100: { ok, created, deduped, updated, skipped, next_offset|null }
 *           The browser loops pages so no single call outlives the edge timeout.
 *
 * Who: the caller's JWT must be owner/admin in workspace_id. The Jotform API key
 * is read with the service role from ingest_sources.settings.jotform_api_key —
 * set write-only from Settings (set_ingest_setting) — on this key or any other
 * Jotform key in the workspace. `creates` comes from the chosen key.
 *
 * sync (service role only, from pg_cron's jotform_sync_kick every five
 *   minutes, migration 121) → for every active Jotform key with
 *   settings.sync_form, pull that form's newest 50 submissions and its 50 most
 *   recently edited (orderby updated_at), apply the ones the ledger has not
 *   seen or has seen at an older updated_at (ingest_events.source_updated_at,
 *   migration 132), and deal new recent ones to the key's round robin.
 *   { ok, keys, created, updated, failed }
 *
 * Each submission goes through the same mapper (_shared/flat.ts) and
 * ingest_apply_flat as the live webhook, keyed on source='jotform' +
 * submission id: an unchanged re-run writes nothing twice, and a submission
 * edited in Jotform patches its record (fill empty fields, add tags, append
 * notes; never blank anything) instead of answering deduped.
 *
 * Deploy: supabase functions deploy jotform-import
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import { flatToEnvelope, jotAnswersFromApi, jotformToFlat } from '../_shared/flat.ts';
import { hasRoundRobin, roundRobinLead } from '../_shared/round-robin.ts';
import { jotIso, needsApply } from '../_shared/jotform-sync.ts';

// ponytail: US data centre only; EU accounts use eu-api.jotform.com, HIPAA hipaa-api.jotform.com.
const JOTFORM = 'https://api.jotform.com';

async function jot(apiKey: string, path: string, params: Record<string, string> = {}) {
  const u = new URL(JOTFORM + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { APIKEY: apiKey, Accept: 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body.responseCode && body.responseCode !== 200)) {
    throw new Error(`Jotform ${path} → ${body.message ?? r.status}`);
  }
  return body;
}

const SYNC_PAGE = 50;
// Older than this and a synced submission is history: filed, but not dealt to a rep.
const ROUND_ROBIN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

type SyncKey = { id: number; workspace_id: number; settings: Record<string, string> | null };
type JotSub = { id: string; status: string; created_at?: string; updated_at?: string | null; answers: Record<string, never> };

/**
 * One key's form: the newest 50 submissions and the 50 most recently edited,
 * applied like the webhook. New ones are created (and dealt to the round
 * robin when recent); edited ones patch their record with the "Add new info"
 * rule (fill empty fields, add tags, append notes — never blank anything).
 */
async function syncKey(admin: SupabaseClient, k: SyncKey, apiKey: string) {
  const formId = String(k.settings?.sync_form ?? '');
  const creates = k.settings?.creates === 'buyer' ? 'buyer' : k.settings?.creates === 'wholesaler' ? 'wholesaler' : 'seller';
  const [form, newest, edited] = await Promise.all([
    jot(apiKey, `/form/${formId}`),
    jot(apiKey, `/form/${formId}/submissions`, { limit: String(SYNC_PAGE), orderby: 'created_at' }),
    jot(apiKey, `/form/${formId}/submissions`, { limit: String(SYNC_PAGE), orderby: 'updated_at' }),
  ]);
  const byId = new Map<string, JotSub>();
  for (const x of [...(newest.content ?? []), ...(edited.content ?? [])] as JotSub[]) if (x.status === 'ACTIVE') byId.set(x.id, x);
  const subs = [...byId.values()];
  if (!subs.length) return { created: 0, updated: 0, failed: 0 };

  const { data: seen } = await admin.from('ingest_events').select('*')
    .eq('workspace_id', k.workspace_id).eq('source', 'jotform').in('source_id', subs.map((x) => x.id));
  const known = new Map((seen ?? []).map((r: { source_id: string; source_updated_at?: string | null }) => [r.source_id, { source_updated_at: r.source_updated_at ?? null }]));

  let created = 0, updated = 0, failed = 0;
  for (const x of subs) {
    if (!needsApply(x, known.get(x.id))) continue;
    const createdAt = jotIso(x.created_at);
    const flat = jotformToFlat(jotAnswersFromApi(x.answers), { submissionId: x.id, formTitle: form.content?.title, creates, createdAt });
    const envelope = flatToEnvelope('jotform', flat, x.id);
    if ('error' in envelope) { failed++; continue; }
    const { data, error } = await admin.rpc('ingest_apply_flat', { p_workspace_id: k.workspace_id, p_envelope: envelope });
    if (error) { failed++; console.error('jotform sync apply failed', k.id, x.id, error.message); continue; }
    const upd = jotIso(x.updated_at);
    if (upd) {
      await admin.from('ingest_events').update({ source_updated_at: upd })
        .eq('workspace_id', k.workspace_id).eq('source', 'jotform').eq('source_id', x.id).then(() => null, () => null);
    }
    if (data?.updated) { updated++; continue; }
    if (data?.deduped) continue;
    created++;
    const fresh = !createdAt || Date.now() - Date.parse(createdAt) < ROUND_ROBIN_MAX_AGE_MS;
    if (fresh && data?.kind === 'seller' && hasRoundRobin(k.settings)) await roundRobinLead(admin, k.id, data.id);
  }
  if (created || updated) await admin.from('ingest_sources').update({ last_used_at: new Date().toISOString() }).eq('id', k.id);
  return { created, updated, failed };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'sign in first' }, 401);

  // The five-minute auto-sync: pg_cron with the service role, every workspace at once.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const bearer = authHeader.slice(7).trim();
  if (await isServiceCaller(createClient(url, serviceKey, { auth: { persistSession: false } }), bearer)) {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: all } = await admin.from('ingest_sources').select('id, workspace_id, settings')
      .eq('name', 'jotform').eq('active', true);
    const keys = (all ?? []) as SyncKey[];
    const syncing = keys.filter((k) => /^\d+$/.test(String(k.settings?.sync_form ?? '')));
    const t = { keys: syncing.length, created: 0, updated: 0, failed: 0 };
    for (const k of syncing) {
      const apiKey = k.settings?.jotform_api_key
        ?? keys.find((o) => o.workspace_id === k.workspace_id && o.settings?.jotform_api_key)?.settings?.jotform_api_key;
      if (!apiKey) continue;
      try {
        const r = await syncKey(admin, k, apiKey);
        t.created += r.created; t.updated += r.updated; t.failed += r.failed;
      } catch (e) {
        t.failed++;
        console.error('jotform sync failed', k.id, e instanceof Error ? e.message : e);
      }
    }
    return json({ ok: true, ...t });
  }
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who.user) return json({ error: 'sign in first' }, 401);

  let body: { workspace_id?: number; key_id?: number; action?: string; form_id?: string; offset?: number };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id);
  const keyId = Number(body.key_id);
  if (!Number.isFinite(ws) || !Number.isFinite(keyId)) return json({ error: 'workspace_id and key_id are required' }, 422);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: me } = await admin.from('workspace_members').select('role')
    .eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return json({ error: 'only an owner or admin can import' }, 403);

  const rl = await rateLimit(admin, `jotform-import:${who.user.id}`, 120, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const { data: keys } = await admin.from('ingest_sources').select('id, settings')
    .eq('workspace_id', ws).eq('name', 'jotform');
  const chosen = (keys ?? []).find((k) => k.id === keyId);
  if (!chosen) return json({ error: 'that Jotform key is not in this workspace' }, 404);
  const apiKey: string | undefined = chosen.settings?.jotform_api_key
    ?? (keys ?? []).find((k) => k.settings?.jotform_api_key)?.settings.jotform_api_key;
  if (!apiKey) return json({ error: 'add your Jotform API key first' }, 422);
  const creates = chosen.settings?.creates === 'buyer' ? 'buyer' : chosen.settings?.creates === 'wholesaler' ? 'wholesaler' : 'seller';

  try {
    if (body.action === 'forms') {
      const r = await jot(apiKey, '/user/forms', { limit: '1000', filter: JSON.stringify({ status: 'ENABLED' }) });
      const forms = (r.content ?? []).map((f: { id: string; title: string; count: string }) => ({
        id: f.id, title: f.title, count: Number(f.count) || 0,
      }));
      return json({ ok: true, forms });
    }

    if (body.action === 'import') {
      const formId = String(body.form_id ?? '');
      if (!/^\d+$/.test(formId)) return json({ error: 'form_id is required' }, 422);
      const offset = Math.max(0, Number(body.offset) || 0);
      const [form, page] = await Promise.all([
        jot(apiKey, `/form/${formId}`),
        jot(apiKey, `/form/${formId}/submissions`, { limit: '100', offset: String(offset), orderby: 'created_at' }),
      ]);
      const subs: { id: string; status: string; created_at?: string; answers: Record<string, never> }[] = page.content ?? [];
      let created = 0, deduped = 0, updated = 0, skipped = 0;
      for (const s of subs) {
        if (s.status !== 'ACTIVE') { skipped++; continue; }
        const flat = jotformToFlat(jotAnswersFromApi(s.answers), {
          submissionId: s.id,
          formTitle: form.content?.title,
          creates,
          // Jotform returns account-local "YYYY-MM-DD HH:MM:SS"; close enough for a historical timestamp.
          createdAt: s.created_at ? s.created_at.replace(' ', 'T') + 'Z' : undefined,
        });
        const envelope = flatToEnvelope('jotform', flat, s.id);
        if ('error' in envelope) { skipped++; continue; }
        const { data, error } = await admin.rpc('ingest_apply_flat', { p_workspace_id: ws, p_envelope: envelope });
        if (error) { skipped++; console.error('jotform-import apply failed', s.id, error.message); continue; }
        if (data?.updated) updated++; else if (data?.deduped) deduped++; else created++;
      }
      return json({ ok: true, created, deduped, updated, skipped, next_offset: subs.length === 100 ? offset + 100 : null });
    }

    return json({ error: 'action must be forms or import' }, 422);
  } catch (e) {
    // Jotform's own message ("Invalid API key") is what the owner needs to see.
    if (e instanceof Error && e.message.startsWith('Jotform ')) return json({ ok: false, error: e.message }, 502);
    return serverError(CORS, 'jotform-import', e, 502);
  }
});
