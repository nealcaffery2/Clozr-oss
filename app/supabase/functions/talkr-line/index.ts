/**
 * POST /talkr-line — assign a Talkr line to a CLOZR teammate (admin or service role).
 *
 *   { action: 'assign', workspace_id, phone_e164, user_id, set_default?: boolean, label?: string }
 *
 * A line CLOZR tracks that Talkr has not adopted yet (a number on the carrier
 * account, as every Podio-era line is) is imported on the way: Talkr's
 * POST /v1/numbers/import is idempotent and takes the assignee, so one call
 * here leaves the number on Talkr, owned by the teammate, and (set_default)
 * dialing and texting as their default. Migration 290 calls this from a
 * trigger whenever rep_phone_numbers gains or moves an owner, so what Settings
 * → Numbers shows and what Talkr dials from never drift again.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, isServiceCaller, jsonWith } from '../_shared/security.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';
import { partnerToken, TALKR_DEFAULT_URL } from '../_shared/talkr-outreach.ts';
import { normalizePhone } from '../_shared/tendlc.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as {
    action?: string; workspace_id?: number; phone_e164?: string; user_id?: string; set_default?: boolean; label?: string; area_code?: string;
  };

  // assign: a line CLOZR knows, onto a teammate's Talkr seat (imported from the carrier first when Talkr lacks it).
  // buy: a new line in an area code, bought through Talkr, assigned, written to rep_phone_numbers and put on the 10DLC campaign.
  const action = input.action === 'buy' ? 'buy' : input.action === 'assign' ? 'assign' : null;
  if (!action) return json({ error: 'unknown action' }, 400);
  const wsId = Number(input.workspace_id);
  let phone = normalizePhone(String(input.phone_e164 ?? ''));
  const userId = String(input.user_id ?? '').trim();
  const areaCode = String(input.area_code ?? '').replace(/\D/g, '');
  if (!wsId || !userId) return json({ error: 'workspace_id and user_id required' }, 400);
  if (action === 'assign' && !phone) return json({ error: 'phone_e164 required' }, 400);
  if (action === 'buy' && !/^\d{3}$/.test(areaCode)) return json({ error: 'area_code (3 digits) required' }, 400);

  const isService = await isServiceCaller(admin, bearer);
  if (!isService) {
    if (!bearer) return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: auth } = await asCaller.auth.getUser();
    if (!auth.user) return json({ error: 'sign in' }, 401);
    const { data: mem } = await admin.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', auth.user.id).maybeSingle();
    if (!mem || !['owner', 'admin'].includes(String(mem.role))) return json({ error: 'admin only' }, 403);
  }

  const { data: ws } = await admin.from('workspaces').select('id, owner_id, settings').eq('id', wsId).maybeSingle();
  if (!ws) return json({ error: 'workspace not found' }, 404);
  const binding = activeTalkrBinding(ws, (await loadTalkrConnections(admin, [wsId]))[0] ?? null);
  if (!binding) return json({ error: TALKR_NOT_CONNECTED }, 422);

  const { data: ownerProfile } = await admin.from('profiles').select('email').eq('id', ws.owner_id).maybeSingle();
  const token = await partnerToken({ id: ws.owner_id, email: (ownerProfile?.email as string | null) ?? null });
  if (!token) return json({ error: 'Talkr partner token unavailable' }, 503);

  const base = String((ws.settings as { talkr_url?: string } | null)?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  const observed = await readTalkrOrg(async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  });
  if (!gateTalkrWrite({ binding, observedOrgId: observed }).ok) return json({ error: TALKR_NOT_CONNECTED }, 422);

  const { data: targetProfile } = await admin.from('profiles').select('email, full_name').eq('id', userId).maybeSingle();
  const targetEmail = String(targetProfile?.email ?? '').trim().toLowerCase();
  if (!targetEmail) return json({ error: 'assignee has no email on their profile' }, 422);

  const membersRes = await fetch(`${base}/v1/team/members`, { headers: { authorization: `Bearer ${token}` } });
  const membersBody = await membersRes.json().catch(() => ({})) as Any;
  if (!membersRes.ok) return json({ error: 'Talkr team read failed', detail: membersBody }, 502);
  const members: Any[] = Array.isArray(membersBody.members) ? membersBody.members : [];
  let talkrMember = members.find((m) => String(m.email ?? '').toLowerCase() === targetEmail);
  if (!talkrMember && targetProfile?.full_name) {
    const name = String(targetProfile.full_name).trim().toLowerCase();
    const hits = members.filter((m) => String(m.display_name ?? '').trim().toLowerCase() === name);
    if (hits.length === 1) talkrMember = hits[0];
  }
  if (!talkrMember?.id) return json({ error: 'That person is not on the Talkr team yet' }, 422);
  if (talkrMember.status && talkrMember.status !== 'active') {
    const act = await fetch(`${base}/v1/team/members/${encodeURIComponent(talkrMember.id)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    if (!act.ok) return json({ error: 'Talkr seat is not active', detail: await act.json().catch(() => ({})) }, 502);
  }

  const talkrHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let line: Any = null;
  let imported = false;
  let bought = false;

  if (action === 'buy') {
    // Carrier inventory in the area code; the first line that can both call and text.
    const avail = await fetch(`${base}/v1/numbers/available?area_code=${areaCode}&limit=10`, { headers: { authorization: `Bearer ${token}` } });
    const availBody = await avail.json().catch(() => ({})) as Any;
    if (!avail.ok) return json({ error: 'Talkr could not search the carrier', detail: availBody }, 502);
    const options: Any[] = Array.isArray(availBody.numbers) ? availBody.numbers : [];
    const pick = options.find((n) => n?.capabilities?.voice !== false && n?.capabilities?.sms !== false) ?? options[0];
    if (!pick?.phone_e164) return json({ error: `No numbers for sale in area code ${areaCode} right now` }, 404);
    const buy = await fetch(`${base}/v1/numbers`, {
      method: 'POST', headers: talkrHeaders,
      body: JSON.stringify({ phone_e164: pick.phone_e164, assigned_user_id: talkrMember.id, label: input.label?.trim() || `${targetProfile?.full_name ?? targetEmail} · ${areaCode}` }),
    });
    const buyBody = await buy.json().catch(() => ({})) as Any;
    if (!buy.ok) return json({ error: 'Talkr could not buy the number', detail: buyBody }, 502);
    line = buyBody.number ?? null;
    if (!line?.id) return json({ error: 'Talkr bought the number but returned no id', detail: buyBody }, 502);
    phone = normalizePhone(String(line.phone_e164 ?? pick.phone_e164)) ?? pick.phone_e164;
    bought = true;
    // CLOZR's number book: owned by the teammate, their caller ID when asked.
    // Migration 290's trigger posts back here with `assign`; that call finds the line and changes nothing.
    const { error: bookErr } = await admin.from('rep_phone_numbers').upsert({
      workspace_id: wsId, phone_e164: phone, user_id: userId, label: String(line.label ?? input.label ?? '').trim() || `${targetProfile?.full_name ?? 'Line'} · ${areaCode}`,
      is_caller_id: input.set_default !== false, updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,phone_e164' });
    if (bookErr) console.error('talkr-line: rep_phone_numbers not written', bookErr.message);
  } else {
    const numbersRes = await fetch(`${base}/v1/numbers`, { headers: { authorization: `Bearer ${token}` } });
    const numbersBody = await numbersRes.json().catch(() => ({})) as Any;
    if (!numbersRes.ok) return json({ error: 'Talkr numbers read failed', detail: numbersBody }, 502);
    const numbers: Any[] = Array.isArray(numbersBody.numbers) ? numbersBody.numbers : [];
    line = numbers.find((n) => normalizePhone(String(n.phone_e164 ?? '')) === phone) ?? null;
  }
  if (!line?.id) {
    // Not on Talkr yet: adopt it from the carrier account, assigned as it lands.
    const imp = await fetch(`${base}/v1/numbers/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ phone_e164: phone, assigned_user_id: talkrMember.id, ...(input.label?.trim() ? { label: input.label.trim() } : {}) }),
    });
    const impBody = await imp.json().catch(() => ({})) as Any;
    if (imp.status === 404) return json({ error: 'That number is not on Talkr and not on the carrier account either', detail: impBody }, 404);
    if (!imp.ok) return json({ error: 'Talkr could not import that number from the carrier', detail: impBody }, 502);
    line = impBody.number ?? null;
    imported = true;
    if (!line?.id) return json({ error: 'Talkr imported the number but returned no id', detail: impBody }, 502);
  }

  // An import or a purchase lands assigned; a line Talkr already had is moved to the teammate.
  if ((!imported && !bought) || String(line.assigned_user_id ?? '') !== String(talkrMember.id)) {
    const patch: Record<string, unknown> = { assigned_user_id: talkrMember.id };
    if (input.label?.trim()) patch.label = input.label.trim();
    const upd = await fetch(`${base}/v1/numbers/${encodeURIComponent(line.id)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const updBody = await upd.json().catch(() => ({}));
    if (!upd.ok) return json({ error: 'Talkr refused the assignment', detail: updBody }, 502);
  }

  if (input.set_default !== false) {
    await fetch(`${base}/v1/team/members/${encodeURIComponent(talkrMember.id)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ default_phone_number_id: line.id }),
    });
  }

  // A new or newly adopted line texts only once it is on the 10DLC campaign
  // (ten-dlc-register `attach`, which waits on its own when the campaign is
  // not approved yet). Service call to our own function; a refusal is reported, not fatal.
  let campaign: unknown = null;
  if (bought || imported) {
    campaign = await fetch(`${url}/functions/v1/ten-dlc-register`, {
      method: 'POST', headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attach', workspace_id: wsId, phones: [phone] }),
    }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({})) as Record<string, unknown>) })).catch((e) => ({ error: String(e) }));
  }

  return json({
    ok: true,
    imported,
    bought,
    campaign,
    phone_e164: phone,
    talkr_number_id: line.id,
    talkr_user_id: talkrMember.id,
    assignee: targetProfile?.full_name ?? targetEmail,
  });
});
