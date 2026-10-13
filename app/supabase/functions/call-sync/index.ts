/**
 * POST /call-sync — every Talkr call onto the record, with what was said.
 *
 * Runs every two minutes from pg_cron (migration 67, public.call_sync_kick),
 * and on demand from Settings as a workspace admin. Two passes per workspace:
 *
 *   1. Mirror. Talkr's call history for the last two days (GET /v1/history,
 *      as the workspace owner, whose token sees the whole org) is upserted
 *      into communications keyed `call:<talkr id>`, filed on the seller or
 *      buyer whose number is on the other end — or kept unfiled until such a
 *      record exists, then re-linked. Same key lib/talkr-sync.ts uses from
 *      the browser, so the two never duplicate a call. A call already filed
 *      on a record (by the dialer, or by hand) keeps that record.
 *   2. Intel. For every call that has not been finished yet, read the
 *      transcript (GET /v1/calls/:id/transcript): text, AI summary and notes;
 *      the coaching score (GET /v1/calls/:id/score, queued with POST when the
 *      transcript is done and no score exists); the native scorecard
 *      (lib/call-coaching.ts, written to coaching_review once the transcript
 *      is in, replacing a hang-up card that was graded off the live lines);
 *      and the recording, copied
 *      into the private call-recordings bucket as <ws>/<call id>.mp3 so the
 *      record plays it without a Talkr session. A call is finished when the
 *      transcript is terminal and either a score exists or scoring is not
 *      configured; Talkr still processing is retried next tick, at most
 *      INTEL_MAX_ATTEMPTS times.
 *
 * Auth to Talkr: a five-minute HS256 token signed with
 * TALKR_PARTNER_JWT_SECRET (the same secret Talkr holds as
 * PARTNER_JWT_SECRET), as dispo-campaign-tick does. Without it the function
 * records `configured: false` in call_sync_state and does nothing else.
 *
 * Caller auth: deployed with verify_jwt, so the gateway checks the bearer's
 * signature; a service_role token is the cron, any other token is a signed-in
 * workspace admin with {"action":"run","workspace_id":N}.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import { coachTranscript } from '../_shared/coach-run.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED, talkrOrgFromPayload } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';
import { CONVERSATION_MIN_SECONDS, firstName, isConversation, isVoicemailDrop, measureTalkSplit, shouldRefreshCoaching } from '../../../lib/call-coaching.ts';
import { segmentsForPrompt, type CallSegment } from '../../../lib/call-media.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const HISTORY_DAYS = 2;
const HISTORY_LIMIT = 200;
const INTEL_PER_TICK = 20;
const INTEL_MAX_ATTEMPTS = 40; // ~80 minutes of two-minute ticks for a slow transcript
const INTEL_WINDOW_DAYS = 14;
/** How long a call with no recording yet is waited on before it counts as unrecorded. */
const RECORDING_GRACE_MS = 15 * 60_000;
const BUCKET = 'call-recordings';

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function partnerToken(user: { id: string; email: string | null }): Promise<string | null> {
  const secret = Deno.env.get('TALKR_PARTNER_JWT_SECRET');
  if (!secret || !user.email) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({
    iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + 300,
  })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

type TalkrResult = { ok: boolean; status: number; body: Any };
async function talkr(base: string, token: string, path: string, init: RequestInit = {}): Promise<TalkrResult> {
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'unreachable' } };
  }
}

/** The last ten digits of a North American number; how sellers.phone_key and buyers.phone_key are compared. */
function phoneKey(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.slice(-10);
}

/** The key sellers.phone_key and buyers.phone_key hold: public.normalize_phone (E.164, +1 for a bare US number). */
function normalizedPhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
}

type HistoryItem = {
  kind: 'call' | 'sms'; id: string; direction: 'inbound' | 'outbound'; status: string; at: string;
  duration_seconds: number | null; from_number: string; to_number: string; disposition_label: string | null;
  note: string | null; has_recording: boolean; body: string | null; user_id: string | null;
};

type Pending = {
  id: number; source_id: string; recording_id: string | null; recording_url: string | null;
  transcript_status: string | null; call_score: Any; intel_attempts: number; occurred_at: string;
  seller_id: number | null; buyer_id: number | null; rep_id: string | null; coaching_review: unknown; duration_s: number | null;
  direction?: string | null; summary?: string | null;
};

type Tally = { workspaces: number; calls_seen: number; calls_written: number; unfiled: number; relinked: number; intel_checked: number; intel_done: number; audio_copied: number; errors: string[] };

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number };

  // Who is asking: cron with the service key, or an admin of one workspace.
  // service_role is exactly the env key or the cron's vault key (they can be
  // different issues); anything else is a signed-in person, checked below.
  const role = (await isServiceCaller(admin, bearer)) ? 'service_role' : 'person';
  let onlyWorkspace: number | null = null;
  if (role !== 'service_role') {
    if (!bearer) return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user) return json({ error: 'sign in' }, 401);
    const ws = Number(input.workspace_id);
    if (!Number.isFinite(ws)) return json({ error: 'workspace_id required' }, 400);
    const { data: m } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(String(m.role))) return json({ error: 'admins only' }, 403);
    onlyWorkspace = ws;
  } else if (Number.isFinite(Number(input.workspace_id))) {
    onlyWorkspace = Number(input.workspace_id);
  }

  const configured = !!Deno.env.get('TALKR_PARTNER_JWT_SECRET');

  // Support: what Talkr answers for one workspace — the history the owner's
  // token sees (scope, count, the newest rows) and, given call_id, the raw
  // transcript and score payloads. Service role only; nothing is written.
  if (input.action === 'inspect') {
    if (role !== 'service_role') return json({ error: 'service role only' }, 403);
    const ws = Number(input.workspace_id);
    const { data: w } = await admin.from('workspaces').select('id, owner_id, settings').eq('id', ws).maybeSingle();
    if (!w) return json({ error: 'no such workspace' }, 404);
    const inspectBinding = activeTalkrBinding(w, (await loadTalkrConnections(admin, [ws]))[0] ?? null);
    if (!inspectBinding) return json({ error: TALKR_NOT_CONNECTED, configured });
    const base = String(w.settings?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const token = await tokenFor(admin, w.owner_id);
    if (!token) return json({ error: 'no token (secret or owner email missing)', configured }, 200);
    const from = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    const hist = await talkr(base, token, `/v1/history?type=calls&from=${encodeURIComponent(from)}&limit=10`);
    const out: Record<string, unknown> = {
      history: { status: hist.status, scope: hist.body?.scope, total: hist.body?.total, range: hist.body?.range,
        items: (hist.body?.items ?? []).slice(0, 10).map((h: Any) => ({ id: h.id, at: h.at, status: h.status, direction: h.direction, from: h.from_number, to: h.to_number, user: h.user_name, rec: h.has_recording, dur: h.duration_seconds })) },
    };
    const callId = String((input as Any).call_id ?? '');
    if (callId) {
      const t = await talkr(base, token, `/v1/calls/${encodeURIComponent(callId)}/transcript`);
      const sc = await talkr(base, token, `/v1/calls/${encodeURIComponent(callId)}/score`);
      out.transcript = { status: t.status, body: t.body };
      out.score = { status: sc.status, body: sc.body };
      const recId = t.body?.recording?.id;
      if (recId) {
        const a = await fetch(`${base}/v1/recordings/${encodeURIComponent(recId)}/audio`, { headers: { authorization: `Bearer ${token}` } });
        out.audio = { status: a.status, type: a.headers.get('content-type'), length: a.headers.get('content-length') };
        if (!a.ok) out.audio_body = (await a.text()).slice(0, 300);
      }
    }
    return json(out);
  }

  const tally: Tally = { workspaces: 0, calls_seen: 0, calls_written: 0, unfiled: 0, relinked: 0, intel_checked: 0, intel_done: 0, audio_copied: 0, errors: [] };

  // Cron walks talkr_connections, not every workspace of the owner. An
  // explicit workspace_id that is unbound still gets last_error recorded.
  const connections = await loadTalkrConnections(admin, onlyWorkspace !== null ? [onlyWorkspace] : undefined);
  const connBy = new Map(connections.map((c) => [c.workspace_id, c]));
  let workspaces: { id: number; owner_id: string; settings: Any }[] = [];
  if (onlyWorkspace !== null) {
    const { data, error: wsErr } = await admin.from('workspaces').select('id, owner_id, settings').eq('id', onlyWorkspace);
    if (wsErr) return json({ error: wsErr.message }, 500);
    workspaces = data ?? [];
  } else if (connections.length) {
    const { data, error: wsErr } = await admin.from('workspaces').select('id, owner_id, settings').in('id', connections.map((c) => c.workspace_id));
    if (wsErr) return json({ error: wsErr.message }, 500);
    workspaces = data ?? [];
  }

  for (const ws of workspaces) {
    const binding = activeTalkrBinding(ws, connBy.get(ws.id) ?? null);
    if (!binding) {
      if (onlyWorkspace !== null) {
        tally.errors.push(`ws ${ws.id}: ${TALKR_NOT_CONNECTED}`);
        await admin.from('call_sync_state').upsert({
          workspace_id: ws.id, last_run_at: new Date().toISOString(), configured, last_error: TALKR_NOT_CONNECTED,
        }, { onConflict: 'workspace_id' });
      }
      continue;
    }
    tally.workspaces++;
    const started = new Date().toISOString();
    const state: Record<string, unknown> = { workspace_id: ws.id, last_run_at: started, configured };
    try {
      if (!configured) throw new Error('TALKR_PARTNER_JWT_SECRET is not set on this project, so the server cannot read Talkr.');
      const base = String(ws.settings?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
      const token = await tokenFor(admin, ws.owner_id);
      if (!token) throw new Error('The workspace owner has no email on their profile, so no Talkr token can be minted.');

      const r = await syncWorkspace(admin, base, token, ws.id, tally, binding.orgId);
      Object.assign(state, r, { last_ok_at: new Date().toISOString(), last_error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      state.last_error = msg;
      tally.errors.push(`ws ${ws.id}: ${msg}`);
    }
    await admin.from('call_sync_state').upsert(state, { onConflict: 'workspace_id' });
  }

  return json({ ok: tally.errors.length === 0, configured, ...tally });
});

async function tokenFor(admin: SupabaseClient, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data: p } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle();
  return partnerToken({ id: userId, email: p?.email ?? null });
}

async function syncWorkspace(admin: SupabaseClient, base: string, token: string, wsId: number, tally: Tally, boundOrgId: string) {
  // ---- 1. Mirror the call history onto the records --------------------------
  const from = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  const hist = await talkr(base, token, `/v1/history?type=calls&from=${encodeURIComponent(from)}&limit=${HISTORY_LIMIT}`);
  if (!hist.ok) throw new Error(`Talkr history ${hist.status}: ${hist.body?.error ?? hist.body?.message ?? 'refused'}`);
  const items: HistoryItem[] = (hist.body?.items ?? []).filter((h: HistoryItem) => h.kind === 'call');

  // Who dialled: Talkr's user id on the call → the member with that email
  // (Talkr links reps by email). Read once per tick; a rep not on Talkr, or
  // not yet in CLOZR, leaves rep_id null and the board falls back to the
  // seller's assigned rep (migration 85).
  const repByTalkrUser = new Map<string, string>();
  let teamBody: unknown = null;
  try {
    const team = await talkr(base, token, '/v1/team/members');
    teamBody = team.body;
    const { data: roster } = await admin.from('workspace_members').select('user_id, profiles(email)').eq('workspace_id', wsId);
    const byEmail = new Map<string, string>();
    for (const m of (roster ?? []) as Any[]) {
      const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
      if (p?.email) byEmail.set(String(p.email).toLowerCase(), String(m.user_id));
    }
    for (const tm of (team.body?.members ?? []) as Any[]) {
      const uid = byEmail.get(String(tm.email ?? '').toLowerCase());
      if (tm.id && uid) repByTalkrUser.set(String(tm.id), uid);
    }
  } catch { /* attribution is best-effort; the mirror must still run */ }

  // The token sees a Talkr org. It has to be the org bound to this workspace
  // before any communications row or recording is written.
  let observed = talkrOrgFromPayload(hist.body) ?? talkrOrgFromPayload(teamBody);
  if (!observed) observed = await readTalkrOrg((path) => talkr(base, token, path));
  const gate = gateTalkrWrite({ binding: { orgId: boundOrgId }, observedOrgId: observed });
  if (!gate.ok) throw new Error(gate.error);
  tally.calls_seen += items.length;

  if (items.length) {
    // Unfiled calls from the last 30 days, re-linked below once their number
    // has become a record. Read first so their numbers join the lookup.
    const { data: loose } = await admin.from('communications').select('id, direction, from_phone, to_phone')
      .eq('workspace_id', wsId).eq('source', 'talkr').in('channel', ['call', 'voicemail'])
      .is('seller_id', null).is('buyer_id', null).gte('occurred_at', new Date(Date.now() - 30 * 86_400_000).toISOString()).limit(500);

    // Only the numbers this run has in hand, by the indexed phone_key
    // ((workspace_id, phone_key) on both tables). Every seller and every buyer
    // in the workspace (270k buyers) was read every two minutes.
    const theirNumbers = [
      ...items.map((h) => (h.direction === 'outbound' ? h.to_number : h.from_number)),
      ...(loose ?? []).map((c) => (c.direction === 'outbound' ? c.to_phone : c.from_phone)),
    ];
    const lookupKeys = [...new Set(theirNumbers.map(normalizedPhone).filter((k): k is string => !!k))];
    const sellerBy = new Map<string, number>();
    const buyerBy = new Map<string, number>();
    for (let i = 0; i < lookupKeys.length; i += 150) {
      const chunk = lookupKeys.slice(i, i + 150);
      const [sellers, buyers] = await Promise.all([
        admin.from('sellers').select('id, phone, phone_key').eq('workspace_id', wsId).is('archived_at', null).in('phone_key', chunk).order('id'),
        admin.from('buyers').select('id, phone, phone_key').eq('workspace_id', wsId).in('phone_key', chunk).order('id'),
      ]);
      if (sellers.error) throw new Error(`sellers by phone: ${sellers.error.message}`);
      if (buyers.error) throw new Error(`buyers by phone: ${buyers.error.message}`);
      for (const s of sellers.data ?? []) { const k = phoneKey(s.phone_key ?? s.phone); if (k && !sellerBy.has(k)) sellerBy.set(k, s.id); }
      for (const b of buyers.data ?? []) { const k = phoneKey(b.phone_key ?? b.phone); if (k && !buyerBy.has(k)) buyerBy.set(k, b.id); }
    }

    // A call already filed keeps its filing. The dialer files a call on the
    // record the rep actually dialled (a buyer who shares a number with a
    // seller, a record moved by hand), and matching the number again here
    // would move it back onto whichever seller has that number.
    const filed = new Map<string, { seller_id: number | null; buyer_id: number | null }>();
    const keys = items.map((h) => 'call:' + h.id);
    for (let i = 0; i < keys.length; i += 100) {
      const { data: have } = await admin.from('communications').select('source_id, seller_id, buyer_id')
        .eq('workspace_id', wsId).eq('source', 'talkr').in('source_id', keys.slice(i, i + 100));
      for (const r of (have ?? []) as { source_id: string; seller_id: number | null; buyer_id: number | null }[]) {
        if (r.seller_id !== null || r.buyer_id !== null) filed.set(r.source_id, r);
      }
    }

    const rows: Record<string, unknown>[] = [];
    for (const h of items) {
      const theirs = phoneKey(h.direction === 'outbound' ? h.to_number : h.from_number);
      if (!theirs) continue;
      const kept = filed.get('call:' + h.id);
      const sellerId = kept ? kept.seller_id : (sellerBy.get(theirs) ?? null);
      const buyerId = kept ? kept.buyer_id : sellerId === null ? (buyerBy.get(theirs) ?? null) : null;
      // A number with no CLOZR record behind it is not a lead, so no record is
      // invented for it; the call is still kept (unfiled) so its transcript and
      // score accumulate, and the moment a seller or buyer with that number is
      // added the re-link below puts the history on them.
      if (sellerId === null && buyerId === null) tally.unfiled++;
      rows.push({
        workspace_id: wsId, seller_id: sellerId, buyer_id: buyerId,
        channel: h.status === 'voicemail' ? 'voicemail' : 'call',
        direction: h.direction, occurred_at: h.at, from_phone: h.from_number, to_phone: h.to_number,
        body: h.body,
        // Only when Talkr has one: the dialer writes the outcome on the call
        // the moment it is saved (lib/call-outcome-write), and a mirror run
        // before Talkr has the disposition must not blank it.
        ...(h.disposition_label || h.note ? { summary: [h.disposition_label, h.note].filter(Boolean).join(' — ') } : {}),
        duration_s: h.duration_seconds, status: h.status, source: 'talkr', source_id: 'call:' + h.id,
        talkr_user_id: h.user_id ?? null,
        // Only set when known: a null here on a redelivery would erase a rep already credited.
        ...(h.user_id && repByTalkrUser.get(String(h.user_id)) ? { rep_id: repByTalkrUser.get(String(h.user_id)) } : {}),
      });
    }
    if (rows.length) {
      // Only the columns the mirror owns: an existing row keeps its transcript, notes and score.
      // Rows go up grouped by shape (with or without rep_id, with or without a
      // summary): PostgREST takes the column list from the first object of a
      // batch, so mixing shapes would either drop a column or null it out.
      const shapes = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        const shape = Object.keys(r).sort().join(',');
        shapes.set(shape, [...(shapes.get(shape) ?? []), r]);
      }
      for (const batch of shapes.values()) {
        if (!batch.length) continue;
        const { error } = await admin.from('communications').upsert(batch, { onConflict: 'workspace_id,source,source_id' });
        if (error) throw new Error(`communications upsert: ${error.message}`);
      }
      tally.calls_written += rows.length;
    }

    // Re-link: unfiled calls whose number has since become a record.
    for (const c of loose ?? []) {
      const theirs = phoneKey(c.direction === 'outbound' ? c.to_phone : c.from_phone);
      if (!theirs) continue;
      const sellerId = sellerBy.get(theirs) ?? null;
      const buyerId = sellerId === null ? (buyerBy.get(theirs) ?? null) : null;
      if (sellerId === null && buyerId === null) continue;
      await admin.from('communications').update({ seller_id: sellerId, buyer_id: buyerId }).eq('id', c.id);
      tally.relinked++;
    }
  }

  // ---- 2. Transcript, notes, score, recording -------------------------------
  const since = new Date(Date.now() - INTEL_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: pending, error: pErr } = await admin.from('communications')
    .select('id, source_id, recording_id, recording_url, transcript_status, call_score, intel_attempts, occurred_at, seller_id, buyer_id, rep_id, coaching_review, duration_s, direction, summary')
    .eq('workspace_id', wsId).eq('source', 'talkr').in('channel', ['call', 'voicemail'])
    .is('intel_synced_at', null).lt('intel_attempts', INTEL_MAX_ATTEMPTS).gte('occurred_at', since)
    .like('source_id', 'call:%').order('occurred_at', { ascending: false }).limit(INTEL_PER_TICK);
  if (pErr) throw new Error(`pending calls: ${pErr.message}`);

  let done = 0;
  for (const c of (pending ?? []) as Pending[]) {
    tally.intel_checked++;
    try {
      if (await intelFor(admin, base, token, wsId, c, tally)) done++;
    } catch (e) {
      tally.errors.push(`call ${c.source_id}: ${e instanceof Error ? e.message : String(e)}`);
      await admin.from('communications').update({ intel_attempts: c.intel_attempts + 1 }).eq('id', c.id);
    }
  }
  tally.intel_done += done;

  const { count } = await admin.from('communications').select('id', { count: 'exact', head: true })
    .eq('workspace_id', wsId).eq('source', 'talkr').in('channel', ['call', 'voicemail']).is('intel_synced_at', null)
    .lt('intel_attempts', INTEL_MAX_ATTEMPTS).gte('occurred_at', since);
  return { calls_seen: items.length, intel_done: done, intel_pending: count ?? 0 };
}

/** One call's intel. Returns true when the row is finished (nothing more to wait for). */
async function intelFor(admin: SupabaseClient, base: string, token: string, wsId: number, c: Pending, tally: Tally): Promise<boolean> {
  const callId = c.source_id.slice(5);
  const patch: Record<string, unknown> = { intel_attempts: c.intel_attempts + 1 };

  // An outbound call the rep logged as a voicemail, or too short to be a
  // conversation, is not transcribed, recorded into our bucket or scored:
  // there is nothing to coach and every step costs.
  if (c.direction === 'outbound' && (isVoicemailDrop({ outcome: c.summary }) || (c.duration_s != null && c.duration_s < CONVERSATION_MIN_SECONDS))) {
    patch.transcript_status = 'skipped';
    patch.coaching_review = c.coaching_review ?? { status: 'skipped', error: 'Voicemail or no conversation: not transcribed or scored.', scored_at: new Date().toISOString() };
    patch.intel_synced_at = new Date().toISOString();
    const { error } = await admin.from('communications').update(patch).eq('id', c.id);
    if (error) throw new Error(`update: ${error.message}`);
    return true;
  }

  const t = await talkr(base, token, `/v1/calls/${encodeURIComponent(callId)}/transcript`);
  if (t.status === 404) {
    // Talkr no longer has the call: nothing will ever arrive.
    patch.transcript_status = 'no_recording'; patch.intel_synced_at = new Date().toISOString();
    await admin.from('communications').update(patch).eq('id', c.id);
    return true;
  }
  if (!t.ok) throw new Error(`transcript ${t.status}: ${t.body?.error ?? t.body?.message ?? 'refused'}`);

  const rec = t.body?.recording ?? null;
  const tr = t.body?.transcript ?? null;
  let transcriptTerminal = false;
  // The timed lines, for the scorecard's insights ("at 3:04 you said...").
  let timeline: string | null = null;

  if (rec?.status === 'deleted' || ((!rec || rec.status === 'absent') && Date.now() - Date.parse(c.occurred_at) > RECORDING_GRACE_MS)) {
    patch.transcript_status = 'no_recording'; transcriptTerminal = true;
  } else if (!rec || rec.status === 'absent') {
    // The carrier posts the recording a minute or so after hang-up; this tick
    // can be earlier than that. Wait rather than give up on it for good.
    patch.transcript_status = 'processing';
  } else if (!t.body?.configured) {
    patch.transcript_status = 'not_configured'; transcriptTerminal = true;
  } else if (tr?.status === 'completed') {
    const text = tr.full_text
      || (tr.segments ?? []).map((g: Any) => (g.speaker === 'rep' ? 'Rep: ' : g.speaker === 'contact' ? 'Contact: ' : '') + g.text).join('\n')
      || null;
    patch.transcript = text;
    patch.transcript_status = 'completed';
    patch.ai_notes = { summary: tr.summary ?? null, ...(tr.ai ?? {}), model: tr.ai_model ?? null };
    transcriptTerminal = true;
    // The timed segments drive the call player's synced transcript. Their own
    // update, so a project without migration 106 still stores everything else.
    const segments = (tr.segments ?? []).filter((g: Any) => typeof g?.start === 'number' && String(g?.text ?? '').trim())
      .map((g: Any) => ({ start: g.start, end: typeof g.end === 'number' ? g.end : g.start, speaker: g.speaker === 'rep' || g.speaker === 'contact' ? g.speaker : 'unknown', text: String(g.text).trim() }));
    if (segments.length) {
      timeline = segmentsForPrompt(segments as CallSegment[], 24_000);
      const { error: segErr } = await admin.from('communications').update({ transcript_segments: segments }).eq('id', c.id);
      if (segErr && !/transcript_segments/.test(segErr.message)) tally.errors.push(`segments ${callId}: ${segErr.message}`);
    }
  } else if (tr?.status === 'failed') {
    // Talkr's own failure reason travels with the row, so the record can say why.
    patch.transcript_status = 'failed'; patch.ai_notes = { error: tr.error ?? 'Transcription failed on Talkr.' }; transcriptTerminal = true;
  } else if (rec.status === 'failed') {
    patch.transcript_status = 'failed'; patch.ai_notes = { error: 'The recording failed on Talkr.' }; transcriptTerminal = true;
  } else {
    // queued / processing, or the recording is still being written
    patch.transcript_status = 'processing';
    if (rec.status === 'completed' && !tr) {
      // A finished recording nobody asked to transcribe: ask once.
      await talkr(base, token, `/v1/recordings/${encodeURIComponent(rec.id)}/transcribe`, { method: 'POST', body: JSON.stringify({ force: false }) });
    }
  }
  if (rec?.id) patch.recording_id = rec.id;

  // A transcript that is a voicemail greeting and the rep's message: no copy of
  // the audio, no scorecard and no Talkr score.
  const voicemail = patch.transcript_status === 'completed' && typeof patch.transcript === 'string'
    && isVoicemailDrop({ transcript: patch.transcript, durationS: c.duration_s });
  if (voicemail) {
    patch.score_overall = null;
    if (!c.coaching_review) patch.coaching_review = { status: 'skipped', error: 'Voicemail: not scored.', scored_at: new Date().toISOString() };
  }

  // The recording itself, copied once into our bucket.
  if (rec?.status === 'completed' && !c.recording_url && !voicemail) {
    try {
      const res = await fetch(`${base}/v1/recordings/${encodeURIComponent(rec.id)}/audio`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`audio ${res.status}`);
      {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
        const ext = type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : type.includes('mp4') ? 'm4a' : 'mp3';
        const path = `${wsId}/${callId}.${ext}`;
        const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) throw new Error(up.error.message);
        patch.recording_url = `storage:${BUCKET}/${path}`;
        tally.audio_copied++;
      }
    } catch (e) {
      tally.errors.push(`audio ${callId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Native scorecard off the finished transcript. A hang-up card (source live)
  // was graded on what the browser heard; the recording transcript replaces it.
  // A failure is stored so the next tick does not spend another model call.
  // Talkr's own score, below, stays on call_score.
  // A voicemail or quick hang-up is not coached: no card, and no model call.
  if (!voicemail && patch.transcript_status === 'completed' && typeof patch.transcript === 'string' && patch.transcript.trim().length >= 40 && shouldRefreshCoaching(c.coaching_review, 'recording')) {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    const names = apiKey ? await coachingNames(admin, c) : null;
    if (!apiKey) {
      if (!c.coaching_review) patch.coaching_review = { status: 'not_configured', error: 'ANTHROPIC_API_KEY is not set.', scored_at: new Date().toISOString() };
    } else if (names && !isConversation(patch.transcript, { repName: names.rep, prospectName: names.prospect, durationS: c.duration_s })) {
      if (!c.coaching_review) patch.coaching_review = { status: 'skipped', error: 'No two-sided conversation to coach.', scored_at: new Date().toISOString() };
    } else if (names) {
      try {
        const review = await coachTranscript({
          apiKey, transcript: patch.transcript, repName: names.rep, prospectName: names.prospect, source: 'recording',
          talk: measureTalkSplit(patch.transcript, names.rep, names.prospect),
          timeline, durationS: c.duration_s, sellerCall: c.buyer_id == null,
        });
        patch.coaching_review = review;
        patch.score_overall = review.overall;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        tally.errors.push(`coaching ${callId}: ${msg}`);
        patch.coaching_review = { status: 'failed', error: msg.slice(0, 300), scored_at: new Date().toISOString() };
      }
    }
  }

  // Talkr's coaching score: read it; queue it when the transcript is done and none exists.
  let scoreTerminal = false;
  if (voicemail) {
    scoreTerminal = true;
  } else if (patch.transcript_status === 'completed') {
    const s = await talkr(base, token, `/v1/calls/${encodeURIComponent(callId)}/score`);
    if (s.ok) {
      const score = s.body?.score ?? null;
      if (!s.body?.configured) scoreTerminal = true;
      else if (score?.status === 'completed') {
        patch.call_score = score;
        // The native card owns the grade on the record. Talkr's number fills in only when we have no card.
        if (typeof patch.score_overall !== 'number') patch.score_overall = typeof score.overall === 'number' ? Math.round(score.overall) : null;
        scoreTerminal = true;
      } else if (score?.status === 'failed') {
        patch.call_score = score; scoreTerminal = true;
      } else if (!score) {
        await talkr(base, token, `/v1/calls/${encodeURIComponent(callId)}/score`, { method: 'POST', body: JSON.stringify({ force: false }) });
      }
    } else if (s.status === 404 || s.status === 403) {
      scoreTerminal = true; // no scoring on this Talkr, or not ours to read
    }
  } else if (transcriptTerminal) {
    scoreTerminal = true; // no transcript ever → no score ever
  }

  // Audio that will not download (three tries) does not hold the row open forever.
  const audioSettled = voicemail || rec?.status !== 'completed' || !!(patch.recording_url ?? c.recording_url) || c.intel_attempts + 1 >= 3;
  const finished = transcriptTerminal && scoreTerminal && audioSettled;
  if (finished) patch.intel_synced_at = new Date().toISOString();
  const { error } = await admin.from('communications').update(patch).eq('id', c.id);
  if (error) throw new Error(`update: ${error.message}`);
  return finished;
}

async function coachingNames(admin: SupabaseClient, c: Pending): Promise<{ rep: string; prospect: string }> {
  let prospect = '';
  let rep = '';
  if (c.seller_id) {
    const { data } = await admin.from('sellers').select('name').eq('id', c.seller_id).maybeSingle();
    prospect = firstName((data as { name?: string } | null)?.name, '');
  }
  if (!prospect && c.buyer_id) {
    const { data } = await admin.from('buyers').select('name').eq('id', c.buyer_id).maybeSingle();
    prospect = firstName((data as { name?: string } | null)?.name, '');
  }
  if (c.rep_id) {
    const { data } = await admin.from('profiles').select('full_name').eq('id', c.rep_id).maybeSingle();
    rep = firstName((data as { full_name?: string } | null)?.full_name, '');
  }
  return { rep: rep || 'Rep', prospect: prospect || 'Prospect' };
}
