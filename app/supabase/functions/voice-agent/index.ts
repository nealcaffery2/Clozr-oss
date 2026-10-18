/**
 * ElevenLabs Agents webhooks. ElevenLabs calls these, not a browser, so the
 * function is deployed with verify_jwt = false and every route checks its
 * own credential. Setup: docs/voice-agent.md.
 *
 * POST /voice-agent/personalize
 *   Conversation initiation webhook (inbound, and outbound calls placed
 *   without initiation data). Header secret ELEVENLABS_PERSONALIZE_SECRET as
 *   `X-Voice-Agent-Secret` (or `Authorization: Bearer`). Body per
 *   https://elevenlabs.io/docs/eleven-agents/customization/personalization.md:
 *   { caller_id, called_number, agent_id, call_sid, conversation_id }. Answers
 *   conversation_initiation_client_data with every dynamic variable and a
 *   first_message override. Reads lead_memory only, never a model: the
 *   caller is hearing the ring while this runs, and a failed or slow webhook
 *   can stop the call from starting, so a database error answers the generic
 *   greeting rather than a 500.
 *
 * POST /voice-agent/tool/lead-context
 *   Server (webhook) tool the agent calls mid-call. Header secret
 *   ELEVENLABS_TOOL_SECRET. Body { caller_id, called_number, contact_name?,
 *   record_kind?, record_id?, record_token? }; configure caller_id and called_number as the
 *   {{system__caller_id}} / {{system__called_number}} dynamic variables. On a
 *   phone call an explicit record is honoured only when it is one of the
 *   records on the caller's number, so a caller cannot talk the agent into
 *   reading someone else's file. A browser test has no caller ID: there the
 *   record test_session picked is read, when its record_token checks out. https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools.md
 *
 * POST /voice-agent/tool/book-appointment
 * POST /voice-agent/tool/save-qualification
 * POST /voice-agent/tool/mark-do-not-contact
 * POST /voice-agent/tool/get-compr-offer       the COMPR range for the seller's house; COMPR starts underwriting when the call connects
 *   The write tools (migration 123), same secret and the same caller check
 *   as lead-context. book-appointment without starts_at answers open times
 *   inside the agent's call hours, clear of the record's rep's appointments;
 *   with starts_at it books an appointments row (synced to the rep's Google
 *   calendar like any other). save-qualification fills blank seller fields
 *   and lists what it kept. mark-do-not-contact tags the record DNC, flags a
 *   buyer's number and stops any AI follow-up plan. Each writes an activity
 *   line (kind ai_agent) and an ai_agent_actions row. A failure answers the
 *   agent with what to say instead, never a 500 mid-call.
 *
 * POST /voice-agent/post-call
 *   Post-call webhook, HMAC-signed with the webhook's shared secret
 *   (ELEVENLABS_WEBHOOK_SECRET), checked on the raw body before parsing.
 *   post_call_transcription is stored as one communications row keyed
 *   el:<conversation_id> (a retry is the same row) and the record's lead
 *   memory is refreshed right after the reply. Other event types answer 200
 *   and are ignored. https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks.md
 *
 * Secrets: each route's credential is checked against voice_agent_secrets
 * (migration 111, written by voice-agent-admin's Connect) first, then against
 * the env secrets above. A stored row names the workspace and replaces the
 * caller_lines lookup for that call; an env match keeps the old path: the
 * workspace whose caller_lines row holds our end of the call, with
 * VOICE_AGENT_WORKSPACE_ID for a number that is not in caller_lines. The
 * post-call HMAC is tried against every stored webhook secret.
 * The name and company in greetings come from the calling agent's live
 * settings, then VOICE_AGENT_NAME / VOICE_AGENT_COMPANY, then the workspace
 * name. The agent is the row whose agent_id the payload names (migration 111).
 *
 * The AI Sales Manager's roleplay line (migration 149) rides the same two
 * webhooks: when the payload's agent_id is a workspace's roleplay agent,
 * /personalize answers with the rep's armed persona and /post-call grades the
 * practice session (_shared/roleplay-run.ts). Neither files a call.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, rateLimit, serverError } from '../_shared/security.ts';
import { refreshLeadMemory } from '../_shared/lead-memory.ts';
import { emailRep } from '../_shared/rep-alert.ts';
import {
  browserLookup, buildInitiation, callLeg, checkTestRecordToken, isTestCall, matchSecret, parsePostCall, phoneKey, phoneKeyVariants, pickPersona, resolveCaller, secretConfigured, toE164, verifySignatureAny,
  type CallLeg, type Candidate, type Resolution,
} from '../_shared/voice-agent.ts';
import { initiationFor, loadAgentFor, loadCandidates, loadMemory, loadRep, loadSecretRows, loadTransferTarget, missingRelation, recordPhoneKey, type AgentRow } from '../_shared/voice-agent-db.ts';
import { agentSwitchedOff, offerRange, outboundAllowedNow } from '../_shared/voice-agent-calls.ts';
import { toolOn, type AgentSettings } from '../_shared/voice-agent-settings.ts';
import {
  DNC_TAG, MAX_BOOK_DAYS, REHAB_LEVELS, SLOT_MINUTES, appointmentRow, bookingProblem, openSlots, parseBooking, parseQualification, qualificationWrite, slotLabel, withDncTag,
  type Busy, type RehabLevel,
} from '../_shared/voice-agent-tools.ts';
import { hasDnc } from '../../../lib/rvm.ts';
import { roleplayInitiation, roleplayPostCall, roleplayWorkspaceFor } from '../_shared/roleplay-run.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Any = any;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

const notConfigured = (name: string) => json({ error: `voice-agent is not configured: set the ${name} secret on the Supabase project.` }, 503);

type Ctx = { ws: number; leg: CallLeg; wsName: string };

/**
 * Our end of the call, the workspace that owns it, and which way the call went.
 * `pinnedWs` is the workspace a stored secret matched (migration 111): it
 * replaces the caller_lines lookup for which workspace this is; the lines are
 * still read, for that workspace only, to tell inbound from outbound.
 */
async function context(admin: SupabaseClient, callerId: string | null, calledNumber: string | null, pinnedWs: number | null = null): Promise<Ctx | null> {
  const nums = [toE164(calledNumber), toE164(callerId)].filter((n): n is string => !!n);
  let q = nums.length ? admin.from('caller_lines').select('workspace_id, phone_e164').in('phone_e164', nums) : null;
  if (q && pinnedWs != null) q = q.eq('workspace_id', pinnedWs);
  const { data: lines } = q ? await q : { data: [] as Any[] };
  const rows = (lines ?? []) as { workspace_id: number; phone_e164: string }[];
  // Inbound first: the number they dialled is the strongest signal of whose line it is.
  const calledKey = phoneKey(calledNumber);
  const hit = rows.find((r) => phoneKey(r.phone_e164) === calledKey) ?? rows[0];
  const ws = pinnedWs ?? (hit ? Number(hit.workspace_id) : Number(Deno.env.get('VOICE_AGENT_WORKSPACE_ID') ?? NaN));
  if (!Number.isFinite(ws)) return null;
  const ours = new Set(rows.filter((r) => Number(r.workspace_id) === ws).map((r) => phoneKey(r.phone_e164)).filter((k): k is string => !!k));
  let leg = callLeg(callerId, calledNumber, ours);
  if (!leg) {
    // A number outside caller_lines (the fallback workspace): treat the caller as them.
    const theirs = phoneKey(callerId);
    if (!theirs) return null;
    leg = { direction: 'inbound', ours: calledKey ?? '', theirs };
  }
  const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
  return { ws, leg, wsName: String(w?.name ?? '') };
}

const envPersona = () => ({ name: Deno.env.get('VOICE_AGENT_NAME') || null, company: Deno.env.get('VOICE_AGENT_COMPANY') || null });

async function personalize(req: Request, admin: SupabaseClient): Promise<Response> {
  const rows = await loadSecretRows(admin);
  const secret = Deno.env.get('ELEVENLABS_PERSONALIZE_SECRET');
  if (!secretConfigured(rows, 'personalize_secret', secret)) return notConfigured('ELEVENLABS_PERSONALIZE_SECRET');
  const auth = matchSecret(req.headers, rows, 'personalize_secret', secret);
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({})) as { caller_id?: string; called_number?: string; conversation_id?: string; agent_id?: string };
  const env = envPersona();
  const generic = () => buildInitiation({ status: 'none' }, null, null, { ...pickPersona(null, env, null), repName: null });
  // The roleplay line: the caller is a rep practising, not a lead.
  const roleplayWs = await roleplayWorkspaceFor(admin, body.agent_id);
  // A secret that names a workspace must name this one.
  if (roleplayWs != null && (auth.workspaceId == null || auth.workspaceId === roleplayWs)) return json(await roleplayInitiation(admin, roleplayWs, body.caller_id ?? null, body.conversation_id ?? null));
  try {
    // Which agent is calling decides the persona, the rules and the offer range; its LIVE
    // settings, never a draft. No agent claims the call: exactly what it was before agents.
    const agent = await loadAgentFor(admin, body.agent_id, auth.workspaceId);
    const live = agent?.live_settings ?? null;
    const ctx = await context(admin, body.caller_id ?? null, body.called_number ?? null, auth.workspaceId ?? agent?.workspace_id ?? null);
    if (!ctx) return json(generic());
    const base = pickPersona(live ? { agent_name: live.identity.name, company: live.identity.company } : null, env, ctx.wsName);
    const rn = live?.rules.compliance.recording_notice;
    const persona = { ...base, introduceAs: live?.identity.introduce_as, recordingNotice: rn?.enabled ? rn.text : null };
    // An agent the owner switched off answers like a do-not-engage number: neutral greeting, no lead data, end the call.
    const off = agentSwitchedOff(agent);
    let res: Resolution = off ? { status: 'blocked', matches: [] } : resolveCaller(await loadCandidates(admin, ctx.ws, ctx.leg.theirs));
    // Outside its quiet or call hours the agent does not place a call: treated like a number it must not engage.
    if (live && ctx.leg.direction === 'outbound' && !outboundAllowedNow(live, Date.now())) res = { status: 'blocked', matches: [] };
    console.log('voice-agent personalize', { conversation: body.conversation_id, ws: ctx.ws, agent: agent?.agent_key ?? null, direction: ctx.leg.direction, status: res.status, off, via: auth.source });
    // An agent that quotes from COMPR starts the underwriting now, so the range is ready by the time the seller is.
    if (res.status === 'one' && res.match.kind === 'seller' && wantsComprOffer(live)) EdgeRuntime.waitUntil(ensureCompr(admin, ctx.ws, res.match.id).then(() => undefined));
    return json(await initiationFor(admin, ctx.ws, res, ctx.leg, persona, live));
  } catch (e) {
    // A 500 here can keep the call from connecting; the generic greeting cannot hurt.
    console.error('voice-agent personalize', String(e));
    return json(generic());
  }
}

type ToolBody = {
  caller_id?: string; called_number?: string; contact_name?: string; record_kind?: string; record_id?: number | string; record_token?: string; agent_id?: string; conversation_id?: string;
} & Record<string, unknown>;

/** `test`: a console test rung on a phone (isTestCall); `match` is then a stand-in with no record behind it (id 0). */
type ToolCaller = { ctx: Ctx; agent: AgentRow | null; match: Candidate; body: ToolBody; test?: boolean };

const TEST_PHONE_NOTE = 'This is a test call from our team, rung on their own phone. Nothing is looked up or saved on a test, so work from the brief you were given and play the call through as if it worked.';
/** Stands in for the caller on a phone test: no record, so nothing can be read or written through it. */
const TEST_STAND_IN: Candidate = { kind: 'seller', id: 0, name: '', tags: [] };

/** What each tool says on a phone test instead of reading or writing the tester's own record. */
type TestReply = Record<string, unknown>;

/**
 * Everything a mid-call tool needs before it reads or writes a record: the
 * tool secret, the workspace that owns our end of the call, a live agent that
 * is switched on, and exactly one person on the caller's number. An explicit
 * record or name is honoured only when it is one of the records on that
 * number, so a caller cannot talk the agent into reading or changing someone
 * else's file. Anything short of that is an answer for the agent, not an error.
 */
async function toolCaller(req: Request, admin: SupabaseClient, opts: { createNew?: boolean; browserTest?: boolean; testReply?: TestReply; allowTest?: boolean } = {}): Promise<ToolCaller | Response> {
  const rows = await loadSecretRows(admin);
  const secret = Deno.env.get('ELEVENLABS_TOOL_SECRET');
  if (!secretConfigured(rows, 'tool_secret', secret)) return notConfigured('ELEVENLABS_TOOL_SECRET');
  const auth = matchSecret(req.headers, rows, 'tool_secret', secret);
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({})) as ToolBody;
  const agent = await loadAgentFor(admin, body.agent_id, auth.workspaceId);
  // No caller ID: a browser test from Settings. Only the read tool (lead_context) answers it from the
  // record the test picked; the write tools keep refusing, so a test never books or changes a real lead.
  const browser = browserLookup(body);
  if (browser && opts.browserTest) {
    if (agentSwitchedOff(agent)) return json({ found: false, do_not_engage: true, note: 'This agent is switched off. End the call politely.' });
    return await testCaller(admin, auth.workspaceId ?? agent?.workspace_id ?? null, agent, browser, body);
  }
  const ctx = await context(admin, body.caller_id ?? null, body.called_number ?? null, auth.workspaceId ?? agent?.workspace_id ?? null);
  if (!ctx) return json({ found: false, note: 'No workspace owns this phone line.' });
  // Checked before any lead is read: a switched-off agent gets no context to talk from.
  if (agentSwitchedOff(agent)) return json({ found: false, do_not_engage: true, note: 'This agent is switched off. End the call politely.' });
  // A phone test has the tester's caller ID, which may be a real record: never resolve it.
  if (isTestCall(body.call_goal)) {
    if (opts.allowTest) return { ctx, agent, match: TEST_STAND_IN, body, test: true };
    return json({ test: true, ...(opts.testReply ?? {}), note: String(opts.testReply?.note ?? TEST_PHONE_NOTE) });
  }
  const all = await loadCandidates(admin, ctx.ws, ctx.leg.theirs);
  let res = resolveCaller(all);
  if (res.status === 'blocked') return json({ found: false, do_not_engage: true, note: 'This number is on a do-not-contact list. End the call politely.' });
  if (res.status === 'many') {
    const wantId = Number(body.record_id);
    const name = String(body.contact_name ?? '').trim().toLowerCase();
    const byName = name ? res.matches.filter((c) => String(c.name ?? '').toLowerCase().includes(name)) : [];
    const pick = res.matches.find((c) => c.id === wantId && (!body.record_kind || c.kind === body.record_kind))
      ?? (byName.length === 1 ? byName[0] : undefined);
    if (pick) res = { status: 'one', match: pick };
    else return json({ found: false, ambiguous: true, names: res.matches.map((c) => c.name).filter(Boolean), note: 'Several people share this number. Ask who is calling, then call again with contact_name.' });
  }
  if (res.status === 'none' && opts.createNew) {
    const made = await createCallerLead(admin, ctx, agent, body);
    if (made instanceof Response) return made;
    res = { status: 'one', match: made };
  }
  if (res.status !== 'one') return json({ found: false, note: NEW_CALLER_NOTE });
  return { ctx, agent, match: res.match, body };
}

const TEST_SAMPLE_NOTE = 'This is a test call with a made-up caller, so there is no record to look up. Work from the brief you were given.';
const TEST_NONE_NOTE = 'There is no caller ID on this call, so there is no record to look up. Work from the brief you were given.';

/**
 * lead_context on a browser test: the record test_session picked, read in the
 * agent's workspace only, and only with the token test_session signed for this
 * agent and record (the browser passes the variables on, so record_id alone
 * could be swapped). The record's own number still decides do-not-engage,
 * as it would on a real call from it.
 */
async function testCaller(admin: SupabaseClient, ws: number | null, agent: AgentRow | null, want: NonNullable<ReturnType<typeof browserLookup>>, body: ToolBody): Promise<ToolCaller | Response> {
  if (want.want === 'sample') return json({ found: false, sample: true, note: TEST_SAMPLE_NOTE });
  if (want.want === 'none' || ws == null) return json({ found: false, note: TEST_NONE_NOTE });
  const ok = await checkTestRecordToken(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', want.token, { ws, agentId: String(body.agent_id ?? ''), kind: want.kind, id: want.id });
  if (!ok) return json({ found: false, note: 'This test could not be matched to its record. Work from the brief you were given.' });
  const pk = await recordPhoneKey(admin, ws, want.kind, want.id);
  const all = pk ? await loadCandidates(admin, ws, pk) : [];
  const chosen = all.find((c) => c.kind === want.kind && c.id === want.id);
  if (!pk || !chosen) return json({ found: false, note: 'That record is no longer on file. Work from the brief you were given.' });
  if (resolveCaller(all).status === 'blocked') return json({ found: false, do_not_engage: true, note: 'This number is on a do-not-contact list. End the call politely.' });
  const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
  return { ctx: { ws, leg: { direction: 'inbound', ours: '', theirs: pk }, wsName: String(w?.name ?? '') }, agent, match: chosen, body };
}

async function leadContext(req: Request, admin: SupabaseClient): Promise<Response> {
  try {
    const t = await toolCaller(req, admin, { browserTest: true, testReply: { found: false } });
    if (t instanceof Response) return t;
    const { ctx, match: c } = t;
    const col = c.kind === 'seller' ? 'seller_id' : 'buyer_id';
    const now = new Date().toISOString();
    const [mem, offer, appt, deal, rec] = await Promise.all([
      loadMemory(admin, ctx.ws, c),
      admin.from('offers').select('amount, status, direction, sent_at').eq('workspace_id', ctx.ws).eq(col, c.id).order('sent_at', { ascending: false }).limit(1).maybeSingle(),
      admin.from('appointments').select('title, kind, starts_at, location').eq('workspace_id', ctx.ws).eq(col, c.id).gte('starts_at', now).is('deleted_at', null).order('starts_at').limit(1).maybeSingle(),
      admin.from('deals').select('stage, offer_amount, close_date').eq('workspace_id', ctx.ws).eq(col, c.id).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      c.kind === 'seller'
        ? admin.from('sellers').select('lead_stage').eq('id', c.id).maybeSingle()
        : admin.from('buyers').select('status').eq('id', c.id).maybeSingle(),
    ]);
    return json({
      found: true,
      record_kind: c.kind,
      name: c.name,
      brief: mem?.brief ?? '',
      facts: mem?.facts ?? null,
      memory_updated_at: mem?.updated_at ?? null,
      latest_offer: offer.data ?? null,
      next_appointment: appt.data ?? null,
      deal_stage: deal.data?.stage ?? null,
      lead_stage: (rec.data as Any)?.lead_stage ?? (rec.data as Any)?.status ?? null,
    });
  } catch (e) {
    return serverError({}, 'voice-agent lead-context', e);
  }
}

const NEW_CALLER_NOTE = "No record for this caller yet. Treat them as a new lead: ask their name and the property address, then call save_qualification (or book_appointment) with contact_name and property_address and their record is created.";

/**
 * A caller nobody has on file becomes a seller the moment the agent has their
 * name and the property: the caller's number, the address, tagged
 * "AI inbound", unassigned (lead routing or the owner picks the rep),
 * and the workspace owner is told. Only when no record at all is on the number.
 */
async function createCallerLead(admin: SupabaseClient, ctx: Ctx, agent: AgentRow | null, body: ToolBody): Promise<Candidate | Response> {
  const name = String(body.contact_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const address = String(body.property_address ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!name || !address) return json({ found: false, note: NEW_CALLER_NOTE });
  const agentName = agentLabel(agent);
  const conversation = convId(body);
  const row = {
    workspace_id: ctx.ws, name, phone: ctx.leg.theirs, property_address: address, lead_stage: 'New Submission',
    tags: ['AI inbound'], source: 'voice_agent', source_id: conversation ? `el:${conversation}` : null,
  };
  let { data, error } = await admin.from('sellers').insert(row).select('id').single();
  // A second tool call on the same call (sellers_phone_uniq): use the one already made.
  if (error && /duplicate key/i.test(error.message)) {
    ({ data, error } = await admin.from('sellers').select('id').eq('workspace_id', ctx.ws).in('phone_key', phoneKeyVariants(ctx.leg.theirs)).order('id').limit(1).single());
  }
  if (error || !data) {
    console.error('voice-agent new caller', error?.message);
    return json({ found: false, note: 'Their record could not be created. Keep going: take their details in the conversation and the team will add them from the call.' });
  }
  const c: Candidate = { kind: 'seller', id: Number((data as Any).id), name, tags: ['AI inbound'], archived_at: null, assigned_to: null, property_address: address };
  await logActivity(admin, ctx.ws, c, `AI agent ${agentName} created this lead on an inbound call`, `${name} called in from ${ctx.leg.theirs} about ${address}.`, conversation ? `el:${conversation}:created` : null, agent?.agent_key ?? null);
  const { data: w } = await admin.from('workspaces').select('owner_id').eq('id', ctx.ws).maybeSingle();
  if ((w as Any)?.owner_id) {
    await admin.from('notifications').insert({
      workspace_id: ctx.ws, user_id: (w as Any).owner_id, category: 'AI agent', seller_id: c.id,
      title: `${agentName} added a new lead: ${name}`.slice(0, 120), body: `Called in about ${address}. Not assigned to a rep yet.`.slice(0, 500),
    });
  }
  return c;
}

/** The agent's display name for activity lines: its live settings, else its key. */
const agentLabel = (a: AgentRow | null) => a?.live_settings?.identity.name || a?.agent_key?.replace(/_/g, ' ') || 'voice agent';

/** One line on the record's activity, so the People and Buyers timelines show what the agent did. A failure here never fails the tool. */
async function logActivity(admin: SupabaseClient, ws: number, c: Candidate, title: string, body: string, externalId: string | null, agentKey: string | null) {
  const row: Record<string, unknown> = { workspace_id: ws, entity_type: c.kind, entity_id: c.id, kind: 'ai_agent', title: title.slice(0, 200), body: body.slice(0, 4000), occurred_at: new Date().toISOString(), external_id: externalId, ai_agent_key: agentKey };
  const write = () => (externalId
    ? admin.from('activity').upsert(row, { onConflict: 'workspace_id,kind,external_id' })
    : admin.from('activity').insert(row));
  let { error } = await write();
  // Before migration 269: keep the line, lose only the agent's face.
  if (error && /ai_agent_key/.test(error.message)) { delete row.ai_agent_key; ({ error } = await write()); }
  if (error) console.error('voice-agent activity', error.message);
}

/**
 * The agent's own ledger (migration 123): every tool it ran, for the AI agents
 * report. Best effort: before the migration the tool still works.
 */
async function logAction(admin: SupabaseClient, ws: number, agent: AgentRow | null, c: Candidate, action: string, detail: Record<string, unknown>, conversationId: string | null) {
  const { error } = await admin.from('ai_agent_actions').insert({
    workspace_id: ws, agent_key: agent?.agent_key ?? 'unassigned', record_kind: c.kind, record_id: c.id, channel: 'call', action,
    status: 'done', detail, conversation_id: conversationId,
  });
  if (error && !missingRelation(error.message)) console.error('voice-agent action log', error.message);
}

const convId = (b: ToolBody) => (typeof b.conversation_id === 'string' && /^[A-Za-z0-9_-]{4,100}$/.test(b.conversation_id) ? b.conversation_id : null);

/** The window a booking must fit: the agent's live call hours, else 9 to 6 Central on weekdays. */
const bookingHours = (a: AgentRow | null) => a?.live_settings?.call_handling.call_hours ?? { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00', tz: 'America/Chicago' };

async function bookAppointment(req: Request, admin: SupabaseClient): Promise<Response> {
  try {
    const t = await toolCaller(req, admin, { createNew: true, testReply: { ok: true, booked: false, note: 'Test call: the calendar is not touched. Offer two times today that sound right, and when they pick one, tell them it is booked.' } });
    if (t instanceof Response) return t;
    const { ctx, agent, match: c, body } = t;
    const parsed = parseBooking(body);
    if (!parsed.ok) return json({ ok: false, booked: false, note: parsed.note });
    const input = parsed.input;
    const hours = bookingHours(agent);
    // Whose calendar: the record's rep (a buyer's is the dispo rep working them, loadCandidates).
    // A record with no rep books into the unassigned pool.
    const repId = c.assigned_to ?? null;
    const minutes = SLOT_MINUTES;
    const now = Date.now();
    let busyQ = admin.from('appointments').select('starts_at, ends_at').eq('workspace_id', ctx.ws).is('deleted_at', null)
      .gte('starts_at', new Date(now - 86_400_000).toISOString()).lte('starts_at', new Date(now + (MAX_BOOK_DAYS + 1) * 86_400_000).toISOString()).limit(2000);
    busyQ = repId ? busyQ.eq('assigned_to', repId) : busyQ.is('assigned_to', null);
    const { data: busyRows, error: busyErr } = await busyQ;
    if (busyErr) throw busyErr;
    const busy: Busy[] = ((busyRows ?? []) as Any[]).map((r) => {
      const start = Date.parse(r.starts_at);
      const end = r.ends_at ? Date.parse(r.ends_at) : start + SLOT_MINUTES * 60_000;
      return { start, end: Math.max(end, start + 60_000) };
    }).filter((b) => Number.isFinite(b.start));

    if (input.starts_at === null) {
      const slots = openSlots({ nowMs: now, hours, busy, day: input.day, minutes });
      if (!slots.length) return json({ ok: true, booked: false, open_times: [], note: input.day ? 'Nothing is open that day. Offer to check another day.' : 'Nothing is open in the next week. Agree a callback and say the team will confirm the time.' });
      return json({ ok: true, booked: false, time_zone: hours.tz, open_times: slots, note: 'Offer two of these by their label. When the caller picks one, call book_appointment again with its starts_at.' });
    }

    const problem = bookingProblem(input.starts_at, now, hours, busy, minutes);
    if (problem) {
      const slots = openSlots({ nowMs: now, hours, busy, count: 4, minutes });
      return json({ ok: false, booked: false, note: problem, open_times: slots, time_zone: hours.tz });
    }
    const name = agentLabel(agent);
    const appt = appointmentRow({ startMs: input.starts_at, kind: input.kind, name: c.name, agentName: name, notes: input.notes, best_phone: input.best_phone, minutes });
    const conversation = convId(body);
    const apptRow: Record<string, unknown> = {
      workspace_id: ctx.ws, seller_id: c.kind === 'seller' ? c.id : null, buyer_id: c.kind === 'buyer' ? c.id : null,
      ...appt, location: null, assigned_to: repId, created_by: null,
      // Migration 144: reporting counts what the agents booked.
      booked_by: 'ai_agent', ai_agent_key: agent?.agent_key ?? null,
    };
    let { data: made, error } = await admin.from('appointments').insert(apptRow).select('id').maybeSingle();
    if (error && /booked_by|ai_agent_key/.test(error.message)) {
      const { booked_by: _b, ai_agent_key: _k, ...older } = apptRow;
      ({ data: made, error } = await admin.from('appointments').insert(older).select('id').maybeSingle());
    }
    if (error) throw error;
    const label = slotLabel(input.starts_at, hours.tz);
    await afterBooking(admin, ctx.ws, agent, c, repId, appt, label);
    await logActivity(admin, ctx.ws, c, `AI agent ${name} booked: ${appt.title}`, `${label}.\n${appt.notes}`, conversation ? `el:${conversation}:book:${input.starts_at}` : null, agent?.agent_key ?? null);
    await logAction(admin, ctx.ws, agent, c, 'appointment_booked', { appointment_id: (made as Any)?.id ?? null, starts_at: appt.starts_at, kind: appt.kind }, conversation);
    // Who the call is with, so "who will I be speaking to?" gets a real name (null: no rep on the calendar).
    const withName = repId ? (await loadRep(admin, repId).catch(() => ({ name: null }))).name : null;
    return json({ ok: true, booked: true, starts_at: appt.starts_at, label, with_name: withName, say: `You're booked for ${label}${withName ? ` with ${withName}` : ''}.` });
  } catch (e) {
    console.error('voice-agent book-appointment', String(e));
    return json({ ok: false, booked: false, note: 'Booking did not go through. Do not say it is booked: agree the time and say the team will confirm it.' });
  }
}

/**
 * What a booking by the agent leaves for the team: a notification to the rep
 * whose calendar it is on (or the workspace owner when nobody owns the lead),
 * a task for the call at its time on a seller, and an AI Autopilot run on the
 * record finished as booked. Best effort: the booking already stands.
 */
async function afterBooking(admin: SupabaseClient, ws: number, agent: AgentRow | null, c: Candidate, repId: string | null, appt: { title: string; starts_at: string; kind: string; notes: string }, label: string) {
  try {
    let who = repId;
    if (!who) {
      const { data: w } = await admin.from('workspaces').select('owner_id').eq('id', ws).maybeSingle();
      who = ((w as Any)?.owner_id ?? null) as string | null;
    }
    const name = agentLabel(agent);
    if (who) {
      await admin.from('notifications').insert({
        workspace_id: ws, user_id: who, category: 'AI agent', title: `${name} booked ${c.name || 'a ' + c.kind}: ${label}`.slice(0, 120),
        body: `${appt.title}. ${appt.notes}`.slice(0, 500), seller_id: c.kind === 'seller' ? c.id : null, buyer_id: c.kind === 'buyer' ? c.id : null,
      });
    }
    await admin.from('tasks').insert({
      workspace_id: ws, seller_id: c.kind === 'seller' ? c.id : null, buyer_id: c.kind === 'buyer' ? c.id : null,
      title: `${appt.kind === 'Walkthrough' ? 'Walkthrough' : 'Call'} ${c.name || 'the ' + c.kind} (booked by AI)`.slice(0, 200), task_type: 'Call',
      priority: 'Urgent', due_at: appt.starts_at, assigned_to: who, created_by: who, notes: `${name} booked this on a call for ${label}.\n${appt.notes}`.slice(0, 2000),
    });
    await emailRep(admin, who, { subject: `${name} booked ${c.name || 'a ' + c.kind}: ${label}`, lines: [`${name} booked ${c.name || 'a ' + c.kind} for ${label}.`, appt.title, appt.notes].filter(Boolean), name: c.name || 'them', phone: null, kind: c.kind, id: c.id, key: `booked:${c.kind}:${c.id}:${appt.starts_at}` });
    // An autopilot run on this record has done its job.
    const { error } = await admin.from('ai_agent_enrollments').update({ status: 'done', stop_reason: 'booked: an appointment is on the calendar', stopped_at: new Date().toISOString(), next_action_at: null })
      .eq('workspace_id', ws).eq('record_kind', c.kind).eq('record_id', c.id).eq('status', 'active').not('program', 'is', null);
    if (error && !/program/.test(error.message)) console.error('voice-agent booking autopilot stop', error.message);
  } catch (e) {
    console.error('voice-agent after booking', String(e));
  }
}

async function saveQualification(req: Request, admin: SupabaseClient): Promise<Response> {
  try {
    const t = await toolCaller(req, admin, { createNew: true, testReply: { ok: true, saved: false, note: 'Test call: nothing is saved. Carry on as if it worked.' } });
    if (t instanceof Response) return t;
    const { ctx, agent, match: c, body } = t;
    const q = parseQualification(body);
    const cols = c.kind === 'seller' ? 'id, motivation, timeline, condition, occupancy, mortgage, decision_makers, email, asking_price, intake' : 'id';
    const { data: cur, error: readErr } = await admin.from(c.kind === 'seller' ? 'sellers' : 'buyers').select(cols).eq('id', c.id).eq('workspace_id', ctx.ws).maybeSingle();
    if (readErr) throw readErr;
    const name = agentLabel(agent);
    const w = qualificationWrite(c.kind, q, (cur ?? {}) as Record<string, unknown>, name);
    if (Object.keys(w.patch).length) {
      const { error } = await admin.from('sellers').update(w.patch).eq('id', c.id).eq('workspace_id', ctx.ws);
      if (error) throw error;
    }
    const conversation = convId(body);
    // One line per call: a second save on the same call replaces the first.
    await logActivity(admin, ctx.ws, c, w.title, w.body, conversation ? `el:${conversation}:qualification` : null, agent?.agent_key ?? null);
    await logAction(admin, ctx.ws, agent, c, 'qualification_saved', { outcome: q.outcome, fields: Object.keys(q.values), filled: Object.keys(w.patch), kept: w.kept.map((k) => k.label) }, conversation);
    // An outcome of do_not_contact is the same request as the tool: honour it either way.
    if (q.outcome === 'do_not_contact') await applyDnc(admin, ctx, agent, c, 'outcome do_not_contact on save_qualification', conversation);
    if (q.outcome === 'transferred') {
      await briefTransfer(admin, ctx.ws, c, name, q.values.notes ? `${q.values.notes}\n${w.body}` : w.body);
      return json({ ok: true, saved: true, note: 'Saved, and the person you are transferring to has the brief. Now tell the caller you are bringing them on and call transfer_to_number. If it does not connect, set a time instead and save again with the new outcome.' });
    }
    return json({ ok: true, saved: true, note: 'Saved. Say goodbye warmly.' });
  } catch (e) {
    console.error('voice-agent save-qualification', String(e));
    return json({ ok: false, saved: false, note: 'Saving failed, but the call is still logged for the team. Say goodbye warmly.' });
  }
}

/**
 * The warm half of a warm transfer. On a SIP trunk ElevenLabs cannot speak to
 * the person picking up (agent_message is Twilio-only), so the agent saves what
 * it learned with outcome "transferred" first and the person whose phone is
 * about to ring (loadTransferTarget: the rep, else the owner) gets it as a
 * notification. Best effort: the transfer goes ahead either way.
 */
async function briefTransfer(admin: SupabaseClient, ws: number, c: Candidate, agentName: string, brief: string) {
  try {
    const target = await loadTransferTarget(admin, ws, c.assigned_to);
    if (!target) return;
    const who = c.name || (c.kind === 'seller' ? 'a seller' : 'a buyer');
    await admin.from('notifications').insert({
      workspace_id: ws, user_id: target.userId, category: 'AI agent', seller_id: c.kind === 'seller' ? c.id : null, buyer_id: c.kind === 'buyer' ? c.id : null,
      title: `${agentName} is transferring ${who} to you now${c.property_address ? ` · ${c.property_address}` : ''}`.slice(0, 120),
      body: brief.slice(0, 500),
    });
  } catch (e) {
    console.error('voice-agent transfer brief', String(e));
  }
}

/** Tag the record DNC, flag the number, and stop any AI follow-up plan on it. Shared by mark_do_not_contact and save_qualification. */
async function applyDnc(admin: SupabaseClient, ctx: Ctx, agent: AgentRow | null, c: Candidate, reason: string, conversation: string | null): Promise<void> {
  const table = c.kind === 'seller' ? 'sellers' : 'buyers';
  const { data: rec, error: readErr } = await admin.from(table).select('tags').eq('id', c.id).eq('workspace_id', ctx.ws).maybeSingle();
  if (readErr) throw readErr;
  const tags = withDncTag((rec as Any)?.tags ?? [], hasDnc);
  if (tags) {
    const { error } = await admin.from(table).update({ tags }).eq('id', c.id).eq('workspace_id', ctx.ws);
    if (error) throw error;
  }
  if (c.kind === 'buyer') {
    await admin.from('buyer_phones').update({ is_dnc: true }).eq('workspace_id', ctx.ws).eq('buyer_id', c.id).in('phone_key', phoneKeyVariants(ctx.leg.theirs));
  }
  // Forever and on every record with this number (migration 228): contact_opt_outs tags them all DNC.
  const { error: optErr } = await admin.from('contact_opt_outs').insert({ workspace_id: ctx.ws, phone_key: ctx.leg.theirs, channel: 'call', said: reason, record_kind: c.kind, record_id: c.id });
  if (optErr && !/duplicate key|23505/.test(optErr.message) && !missingRelation(optErr.message)) console.error('voice-agent opt-out', optErr.message);
  // An AI plan on this person stops now: nothing else goes out to them.
  const { error: stopErr } = await admin.from('ai_agent_enrollments').update({ status: 'stopped', stop_reason: 'asked not to be contacted', stopped_at: new Date().toISOString(), next_action_at: null })
    .eq('workspace_id', ctx.ws).eq('record_kind', c.kind).eq('record_id', c.id).in('status', ['active', 'paused']);
  if (stopErr && !missingRelation(stopErr.message)) console.error('voice-agent dnc enrollment stop', stopErr.message);
  const name = agentLabel(agent);
  await logActivity(admin, ctx.ws, c, `AI agent ${name}: asked not to be contacted, tagged DNC`, `On a call, the person asked not to be contacted again (${reason}). Tagged ${DNC_TAG}${c.kind === 'buyer' ? ' and the number flagged do-not-call' : ''}; any AI follow-up plan was stopped.`, conversation ? `el:${conversation}:dnc` : null, agent?.agent_key ?? null);
  await logAction(admin, ctx.ws, agent, c, 'marked_dnc', { reason, already_tagged: !tags }, conversation);
}

async function markDoNotContact(req: Request, admin: SupabaseClient): Promise<Response> {
  try {
    const t = await toolCaller(req, admin, { testReply: { ok: true, marked: false, note: 'Test call: nothing is saved. Tell them you will make sure they are not contacted again, then end the call.' } });
    if (t instanceof Response) {
      // A number already on a do-not-contact list is exactly what was asked for.
      const peek = await t.clone().json().catch(() => ({}));
      if ((peek as Any)?.do_not_engage) return json({ ok: true, marked: true, say: "Absolutely, I'll make sure you're not contacted again." });
      return t;
    }
    const { ctx, agent, match: c, body } = t;
    const reason = String(body.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'asked on the call';
    await applyDnc(admin, ctx, agent, c, reason, convId(body));
    return json({ ok: true, marked: true, say: "Absolutely, I'll make sure you're not contacted again.", note: 'Now end the call politely.' });
  } catch (e) {
    console.error('voice-agent mark-do-not-contact', String(e));
    // The request still stands: the post-call classifier flags it for the team.
    return json({ ok: false, marked: false, note: 'Could not save it, but the call is flagged for the team. Tell them you will make sure they are not contacted again, then end the call.' });
  }
}

// ---- get_compr_offer: COMPR underwrites in the background, the agent quotes when it lands ----

/** The agent may quote and has the COMPR tool on. */
const wantsComprOffer = (live: AgentSettings | null | undefined): live is AgentSettings =>
  !!live && live.offer_authority.mode !== 'none' && toolOn(live, 'get_compr_offer');

/** The seller's latest deal and its COMPR ceiling. */
async function comprDeal(admin: SupabaseClient, ws: number, sellerId: number): Promise<{ id: number; mao: number | null } | null> {
  const { data } = await admin.from('deals').select('id, mao').eq('workspace_id', ws).eq('seller_id', sellerId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const m = Number((data as Any).mao);
  return { id: Number((data as Any).id), mao: Number.isFinite(m) && m > 0 ? m : null };
}

/**
 * The seller's COMPR ceiling, starting a COMPR run when there is none. One run
 * per seller every 10 minutes (rate_limit_hit), so the call's start and the
 * agent asking again do not underwrite the house twice. compr-underwrite owns
 * the key, the hourly cap and the write-back onto the deal (it opens a
 * Prospect deal for a seller without one).
 */
async function ensureCompr(admin: SupabaseClient, ws: number, sellerId: number): Promise<{ mao: number | null; started: boolean }> {
  try {
    const deal = await comprDeal(admin, ws, sellerId);
    if (deal?.mao) return { mao: deal.mao, started: false };
    const gate = await rateLimit(admin, `voice-compr:${ws}:${sellerId}`, 1, 600);
    if (!gate.allowed) return { mao: null, started: false };
    EdgeRuntime.waitUntil((async () => {
      try {
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/compr-underwrite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
          body: JSON.stringify({ workspace_id: ws, seller_id: sellerId, ...(deal ? { deal_id: deal.id } : {}) }),
        });
        if (!res.ok) console.error('voice-agent compr', { status: res.status, seller: sellerId, body: (await res.text()).slice(0, 300) });
      } catch (e) {
        console.error('voice-agent compr', { seller: sellerId, err: String(e) });
      }
    })());
    return { mao: null, started: true };
  } catch (e) {
    console.error('voice-agent compr', String(e));
    return { mao: null, started: false };
  }
}

const COMPR_WAIT_NOTE = 'COMPR is still underwriting the house (about a minute from when the call connected). Do not mention any price yet. Keep the conversation going: condition, repairs, occupancy, timeline, and the number they want. Call get_compr_offer again in about a minute.';

/**
 * A quote for a house the caller named, at the rehab level they described. The
 * hosted product prices it with a private valuation engine that is not part of
 * the open-source release (see compr-underwrite), so this build has no quote.
 */
async function quoteOffer(_admin: SupabaseClient, _ws: number, address: string, _level: RehabLevel | null): Promise<number | Response> {
  if (!address) return json({ ready: false, note: 'Ask for the full property address (street, city and state) and call get_compr_offer again with property_address and rehab_level.' });
  return json({ ready: false, note: 'The offer range is not available right now. Do not quote a price; say the team will firm up the number, and set the next step.' });
}

async function getComprOffer(req: Request, admin: SupabaseClient): Promise<Response> {
  try {
    const t = await toolCaller(req, admin, { allowTest: true });
    if (t instanceof Response) return t;
    const { ctx, agent, match: c, body } = t;
    const live = agent?.live_settings ?? null;
    if (!t.test && c.kind !== 'seller') return json({ ready: false, note: 'There is no COMPR offer for a buyer. Do not talk price.' });
    if (!wantsComprOffer(live)) return json({ ready: false, note: 'You do not quote prices on this line. Say the team will work out the number with them.' });
    const level = (REHAB_LEVELS as readonly string[]).includes(String(body.rehab_level ?? '')) ? body.rehab_level as RehabLevel : null;
    const said = typeof body.property_address === 'string' ? body.property_address.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    // The run that started when the call connected, priced from the record and its photos.
    let mao: number | null = null;
    if (!t.test && !said && !level) {
      const r = await ensureCompr(admin, ctx.ws, c.id);
      if (!r.mao) return json({ ready: false, underwriting: true, note: COMPR_WAIT_NOTE });
      mao = r.mao;
    } else {
      // A house the caller named, or the condition they described: a quote at that rehab level.
      const address = said || (t.test ? '' : String(c.property_address ?? '').trim());
      const q = await quoteOffer(admin, ctx.ws, address, level);
      if (q instanceof Response) return q;
      mao = q;
    }
    const range = offerRange(live.offer_authority, mao);
    return json({
      ready: true, ...range, quote_as: live.offer_authority.quote_as, ...(level ? { rehab_level: level } : {}),
      note: 'This is your approved range. Follow your offer rules: only once you know the basics, never above offer_high, and never say how it was worked out.',
    });
  } catch (e) {
    console.error('voice-agent get-compr-offer', String(e));
    return json({ ready: false, note: 'The offer range is not available right now. Do not quote a price; say the team will firm up the number, and set the next step.' });
  }
}

async function postCall(req: Request, admin: SupabaseClient): Promise<Response> {
  const rows = await loadSecretRows(admin);
  const secret = Deno.env.get('ELEVENLABS_WEBHOOK_SECRET');
  if (!secretConfigured(rows, 'webhook_secret', secret)) return notConfigured('ELEVENLABS_WEBHOOK_SECRET');
  const raw = await req.text();
  const sig = await verifySignatureAny(raw, req.headers.get('elevenlabs-signature'), rows, secret);
  if (!sig.ok) return json({ error: `signature ${sig.reason}` }, 401);
  let event: Any;
  try { event = JSON.parse(raw); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const pc = parsePostCall(event);
  if (!pc) return json({ ok: true, ignored: String(event?.type ?? 'unknown') });
  // A roleplay practice call is graded on its session, never filed as a call.
  const roleplayWs = await roleplayWorkspaceFor(admin, pc.agentId);
  if (roleplayWs != null && (sig.workspaceId == null || sig.workspaceId === roleplayWs)) {
    EdgeRuntime.waitUntil(roleplayPostCall(admin, roleplayWs, event?.data).catch((e) => console.error('voice-agent roleplay grade', String(e))));
    return json({ ok: true, roleplay: true });
  }

  try {
    const agent = await loadAgentFor(admin, pc.agentId, sig.workspaceId);
    const ctx = await context(admin, pc.direction === 'inbound' ? pc.theirNumber : pc.ourNumber, pc.direction === 'inbound' ? pc.ourNumber : pc.theirNumber, sig.workspaceId ?? agent?.workspace_id ?? null);
    // 200, not an error: a number we cannot place will not place itself on a retry.
    if (!ctx) return json({ ok: true, stored: false, reason: 'no workspace owns this phone line' });
    // A console test rung on the tester's phone is kept for review but filed on no record: its
    // made-up seller or buyer would otherwise be written into that number's real memory.
    const res = pc.test ? null : resolveCaller(await loadCandidates(admin, ctx.ws, ctx.leg.theirs));
    const filed = !res ? null : res.status === 'one' ? res.match : res.status === 'blocked' && res.matches.length === 1 ? res.matches[0] : null;
    const theirs = pc.theirNumber ?? toE164(ctx.leg.theirs);
    const ours = pc.ourNumber ?? toE164(ctx.leg.ours);
    const row: Record<string, unknown> = {
      workspace_id: ctx.ws,
      seller_id: filed?.kind === 'seller' ? filed.id : null,
      buyer_id: filed?.kind === 'buyer' ? filed.id : null,
      channel: 'call', direction: pc.direction, occurred_at: pc.occurredAt,
      from_phone: pc.direction === 'inbound' ? theirs : ours, to_phone: pc.direction === 'inbound' ? ours : theirs,
      summary: pc.summary, transcript: pc.transcript || null, transcript_status: pc.transcript ? 'completed' : null,
      duration_s: pc.durationS, status: pc.status, source: 'elevenlabs', source_id: 'el:' + pc.conversationId,
      transcript_segments: pc.segments, call_origin: 'ai_agent', ai_agent_key: agent?.agent_key ?? null,
    };
    let { error } = await admin.from('communications').upsert(row, { onConflict: 'workspace_id,source,source_id' });
    if (error && /ai_agent_key/.test(error.message)) {
      // Before migration 269: keep the call, lose only the agent's face on it.
      delete row.ai_agent_key;
      ({ error } = await admin.from('communications').upsert(row, { onConflict: 'workspace_id,source,source_id' }));
    }
    if (error && /transcript_segments|call_origin/.test(error.message)) {
      // Before migration 109: keep the call, lose only the timed segments and the AI badge.
      const { transcript_segments: _s, call_origin: _o, ...older } = row;
      ({ error } = await admin.from('communications').upsert(older, { onConflict: 'workspace_id,source,source_id' }));
    }
    if (error) return serverError({}, 'voice-agent post-call upsert', error);
    // What the call was, per agent, for the console's stats. Best effort: without migration 111 the call is still stored.
    const { error: callErr } = await admin.from('voice_agent_calls').upsert({
      workspace_id: ctx.ws, conversation_id: pc.conversationId, agent_key: agent?.agent_key ?? 'unassigned', agent_id: pc.agentId,
      direction: pc.direction, occurred_at: pc.occurredAt, duration_s: pc.durationS, status: pc.status,
      seller_id: row.seller_id, buyer_id: row.buyer_id,
      booked: pc.flags.booked, transferred: pc.flags.transferred, dnc_requested: pc.flags.dnc_requested, not_interested: pc.flags.not_interested,
      outcome: pc.flags.outcome, tools: pc.flags.tools,
    }, { onConflict: 'workspace_id,conversation_id' });
    if (callErr && !missingRelation(callErr.message)) console.error('voice-agent call log', callErr.message);
    if (filed) {
      EdgeRuntime.waitUntil(refreshLeadMemory(admin, ctx.ws, filed.kind, filed.id)
        .catch((e) => console.error('voice-agent memory refresh', String(e))));
    }
    return json({ ok: true, stored: true, filed: filed ? `${filed.kind}:${filed.id}` : null });
  } catch (e) {
    return serverError({}, 'voice-agent post-call', e);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  if (path.endsWith('/personalize')) return personalize(req, admin);
  if (path.endsWith('/tool/lead-context')) return leadContext(req, admin);
  if (path.endsWith('/tool/book-appointment')) return bookAppointment(req, admin);
  if (path.endsWith('/tool/save-qualification')) return saveQualification(req, admin);
  if (path.endsWith('/tool/mark-do-not-contact')) return markDoNotContact(req, admin);
  if (path.endsWith('/tool/get-compr-offer')) return getComprOffer(req, admin);
  if (path.endsWith('/post-call')) return postCall(req, admin);
  return json({ error: 'unknown route: use /personalize, /tool/lead-context, /tool/book-appointment, /tool/save-qualification, /tool/mark-do-not-contact, /tool/get-compr-offer or /post-call' }, 404);
});
