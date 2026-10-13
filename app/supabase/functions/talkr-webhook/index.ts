/**
 * POST /talkr-webhook — Talkr's outbound webhooks, translated into CLOZR.
 *
 * Talkr can only post its own event shape, so the adapter has to live on this
 * side. That is the point of doing it here: Talkr needs no code change at all,
 * just a webhook subscription pointing at this URL. Everything still lands
 * through the same public.ingest_apply as every other source, so idempotency,
 * identity keys and the ledger are shared.
 *
 * Talkr's contract (its docs/public-api.md):
 *   headers  X-Talkr-Event, X-Talkr-Delivery,
 *            X-Talkr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *   signed   HMAC-SHA256(secret, `${t}.${rawBody}`)
 *   replay   reject when |now − t| > 5 minutes
 *   body     { id, type, occurredAt, data }
 *   delivery at-least-once and unordered, 8 attempts then dead-letter
 *
 * The event `id` is the dedupe key — Talkr's own docs tell consumers to dedupe
 * on it — so it becomes our source_id and a redelivery is a no-op.
 *
 * The signing secret is stored in the ingest_sources row for the `talkr` key,
 * under settings->>'signing_secret'.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { smsAutoReply } from '../_shared/sms-auto-reply.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

/** Replay window, matching what Talkr's own consumers are told to enforce. */
const MAX_SKEW_S = 300;

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent compare, so a wrong signature leaks no timing signal. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type TalkrEvent = { id?: string; type?: string; occurredAt?: string; data?: Record<string, any> };

/** Talkr's event names → the channel CLOZR files them under. */
const CHANNEL: Record<string, 'call' | 'sms' | 'voicemail' | 'email'> = {
  'call.completed': 'call',
  'call.missed': 'call',
  'call.no_answer': 'call',
  'call.busy': 'call',
  'call.failed': 'call',
  'call.voicemail': 'voicemail',
  'message.received': 'sms',
  'message.sent': 'sms',
  'message.delivered': 'sms',
  'message.failed': 'sms',
  'message.undelivered': 'sms',
  'message.status': 'sms',
};

/**
 * The carrier status an event carries, when it is about a message.
 *
 * Talkr's own status vocabulary (queued, sending, sent, delivered, undelivered,
 * failed, received) is what the column stores, so a status in the payload wins
 * and the event name is the fallback for a delivery receipt that carries none.
 */
function messageStatus(type: string, d: Record<string, any>): string | undefined {
  const given = pick(d, ['status', 'message.status', 'messageStatus']);
  if (given) return given.toLowerCase();
  const [head, tail] = type.split('.');
  if (head !== 'message' || !tail) return undefined;
  if (tail === 'received') return 'received';
  if (tail === 'status') return undefined;
  return tail;
}

/** First non-empty value at any of these paths. */
function pick(obj: any, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return undefined;
}

/**
 * Translate one Talkr event into the canonical envelope.
 *
 * The header and signature contract above came from Talkr's own docs, but the
 * inner shape of `data` did not — it is read defensively from the paths its
 * schema makes likely. Every event is stored verbatim in ingest_events.payload,
 * so when a real delivery shows the true field names, correct the paths here
 * and run public.ingest_replay('talkr') — no need to ask Talkr to re-send.
 */
function toEnvelope(ev: TalkrEvent, deliveryId: string) {
  const d = ev.data ?? {};
  const type = ev.type ?? 'unknown';
  const channel = CHANNEL[type];

  const direction = pick(d, ['direction', 'call.direction', 'message.direction']);
  const from = pick(d, ['from', 'fromNumber', 'from_number', 'call.from', 'counterparty']);
  const to = pick(d, ['to', 'toNumber', 'to_number', 'call.to']);

  // The prospect's number is whichever leg is not ours.
  const counterparty =
    pick(d, ['counterparty', 'contact.phone', 'lead.phone', 'contact.phoneNumber']) ??
    (direction === 'inbound' ? from : to);

  const line1 = pick(d, ['property.address', 'property.line1', 'lead.address', 'contact.address']);

  // Talkr's message id — the same one POST /v1/messages hands back when CLOZR
  // sends, so a receipt for a text CLOZR sent updates that very row.
  const messageId = channel === 'sms'
    ? pick(d, ['message.id', 'messageId', 'message_id', 'id', 'providerObjectId', 'provider_message_sid'])
    : undefined;
  const status = channel === 'sms' ? messageStatus(type, d) : undefined;
  // Talkr's call id: `data` of a call.* event is the call itself. Keyed
  // `call:<id>` like call-sync and lib/call-file.ts, so the webhook and the
  // two-minute mirror land on one row instead of filing every call twice.
  const callId = channel === 'call'
    ? pick(d, ['id', 'call.id', 'call_id', 'callId'])
    : channel === 'voicemail' ? pick(d, ['call_id', 'call.id', 'callId']) : undefined;

  return {
    source: 'talkr',
    // Talkr's docs tell consumers to dedupe on the event id; the delivery id is
    // the fallback when an event somehow arrives without one.
    source_id: ev.id ?? deliveryId,
    type,
    occurred_at: ev.occurredAt,
    ...(line1
      ? {
          property: {
            line1,
            city: pick(d, ['property.city', 'lead.city']),
            state: pick(d, ['property.state', 'lead.state']),
            zip: pick(d, ['property.zip', 'property.postalCode', 'lead.zip']),
          },
        }
      : {}),
    person: {
      // Name is deliberately optional: without one, ingest_apply matches an
      // existing person by phone and never invents a lead from a wrong number.
      name: pick(d, ['contact.name', 'lead.name', 'contact.fullName']),
      phone: counterparty,
    },
    ...(channel
      ? {
          communication: {
            channel,
            // Several events describe one message — sent, then delivered, then
            // perhaps failed. They share the message's id, so they land on one
            // row whose status advances, rather than stacking up as copies of
            // the same text on the record (migration 23). Calls share the
            // call's id the same way; anything else keeps the event's identity.
            ...(messageId ? { source_id: 'msg:' + messageId } : callId ? { source_id: 'call:' + callId } : {}),
            ...(status ? { status } : {}),
            direction,
            occurred_at: ev.occurredAt,
            from_phone: from,
            to_phone: to,
            body: pick(d, ['transcript.text', 'transcript', 'message.body', 'body', 'text']),
            summary: pick(d, ['notes.summary', 'aiNotes.summary', 'summary']),
            duration_s: Number(pick(d, ['durationSeconds', 'duration_seconds', 'duration_s', 'duration']) ?? '') || undefined,
            recording_url: pick(d, ['recording.url', 'recordingUrl', 'recording_url']),
          },
        }
      : {}),
    raw: ev,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // The signature covers the raw bytes, so read text before parsing.
  const raw = await req.text();
  const sigHeader = req.headers.get('x-talkr-signature') ?? '';
  const deliveryId = req.headers.get('x-talkr-delivery') ?? '';

  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
  if (!m) return json({ error: 'missing or malformed X-Talkr-Signature' }, 401);
  const [, tsStr, given] = m;

  if (Math.abs(Date.now() / 1000 - Number(tsStr)) > MAX_SKEW_S) {
    return json({ error: 'signature timestamp outside the replay window' }, 401);
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Signature checks cost an HMAC per candidate workspace; cap the rate at
  // which one address may make us do that.
  const rl = await rateLimit(db, `talkr-webhook:${clientIp(req)}`, 600, 60);
  if (!rl.allowed) return tooMany({}, rl);

  // Every active talkr key is a candidate: the signature says which workspace
  // this delivery belongs to, because only that workspace holds the secret.
  const { data: rows } = await db
    .from('ingest_sources')
    .select('id, workspace_id, settings, active')
    .eq('name', 'talkr')
    .eq('active', true);

  let workspaceId: number | null = null;
  for (const r of rows ?? []) {
    const secret = (r.settings as Record<string, string> | null)?.signing_secret;
    if (!secret) continue;
    if (safeEqual(await hmacHex(secret, `${tsStr}.${raw}`), given)) {
      workspaceId = r.workspace_id;
      break;
    }
  }
  if (workspaceId === null) return json({ error: 'signature did not verify' }, 401);

  let ev: TalkrEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const { data, error } = await db.rpc('ingest_apply', {
    p_workspace_id: workspaceId,
    p_envelope: toEnvelope(ev, deliveryId),
  });

  if (error) {
    // A non-2xx makes Talkr retry with backoff, which is what we want for a
    // transient failure — its queue gives us 8 attempts before dead-lettering.
    return serverError({}, `talkr ingest_apply failed event=${ev.id} type=${ev.type}`, error);
  }

  // A line's SMS flow may answer the texter (migration 200). Only after the
  // text is filed, never failing the delivery: a line with no flow is a no-op.
  if (ev.type === 'message.received') {
    const d = ev.data ?? {};
    const note = await smsAutoReply(db, workspaceId, {
      ref: ev.id ?? deliveryId,
      from: pick(d, ['from', 'fromNumber', 'from_number', 'message.from', 'counterparty']),
      to: pick(d, ['to', 'toNumber', 'to_number', 'message.to']),
      body: pick(d, ['message.body', 'body', 'text']),
    });
    if (note) console.log(`talkr-webhook event=${ev.id} ${note}`);
  }

  return json(data, 200);
});
