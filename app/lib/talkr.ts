// Talkr Platform — the phone layer behind the dialer, the Talkr screen and
// the phone settings.
//
// CLOZR is a static export with no server, so the browser talks to Talkr's
// API directly. Identity is the rep's own Supabase session: Talkr is
// configured to trust this project's tokens (PARTNER_JWKS_URL /
// PARTNER_JWT_SECRET on the Talkr server) and links the rep by email to their
// Talkr user on first sight. No Talkr credential ever reaches this bundle —
// the carrier, Deepgram and Anthropic keys all stay on Talkr's server, which is
// also where suppression, quiet hours and recording consent are enforced.
//
// Every method here is a thin, typed wrapper over one Talkr endpoint. Shapes
// mirror Talkr's apps/web/lib/api.ts so a field name here is a field name
// there.

import type { VoiceTokenDto } from './softphone-engine';
import { supabase } from './supabase';
import { isReadOnly, isTalkrWrite, readOnlyResponse } from './read-only';

/** The production Platform API. A workspace can point elsewhere in Settings → Integrations. */
export const TALKR_DEFAULT_URL = 'https://talkr.example.com';

let override: string | null = null;

/** Set from workspace settings (`talkr_url`); null goes back to the default. */
export function setTalkrUrl(url: string | null | undefined): void {
  const trimmed = (url ?? '').trim().replace(/\/$/, '');
  override = trimmed || null;
}

export function talkrUrl(): string {
  return override ?? (process.env.NEXT_PUBLIC_TALKR_API_URL || TALKR_DEFAULT_URL).replace(/\/$/, '');
}

export class TalkrError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** The rep's Supabase access token, which Talkr accepts as a partner-issued identity. */
export async function talkrToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function parseError(res: Response): Promise<TalkrError> {
  let code = 'error';
  let message = res.statusText || `HTTP ${res.status}`;
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
    else if (code !== 'error') message = code.replace(/_/g, ' ');
  } catch {
    /* non-JSON */
  }
  if (res.status === 401) {
    code = 'unlinked';
    message = 'Talkr does not recognise this sign-in yet. Ask a Talkr admin to add your email to the team.';
  }
  return new TalkrError(res.status, code, message, body);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A read-only preview (lib/read-only.ts) sends no changes to Talkr either.
  if (isReadOnly() && isTalkrWrite(path, init.method)) throw await parseError(readOnlyResponse(path, 'read_only'));
  const token = await talkrToken();
  let res: Response;
  try {
    res = await fetch(`${talkrUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new TalkrError(0, 'unreachable', `Can't reach Talkr at ${talkrUrl()}.`);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- shapes -----------------------------------------------------------------

export type CallerIdMode = 'dedicated' | 'local_presence';

export type MeDto = {
  id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  timezone: string | null;
  city: string | null;
  org: { id: string; name: string; slug: string } | null;
  /** Lines assigned to me. */
  numbers: Array<{ id: string; phone_e164: string; label: string | null }>;
  /** Every active line in the org: the caller-ID picker's options. */
  org_numbers: Array<{ id: string; phone_e164: string; label: string | null; area_code: string | null; assigned_user_id: string | null; provider?: string | null }>;
  default_phone_number_id: string | null;
  caller_id_mode: CallerIdMode;
  /** My own voicemail greeting; null → the line's or the workspace's. */
  voicemail_greeting?: FlowGreeting | null;
};

export type PhoneNumberDto = {
  id: string;
  phone_e164: string;
  label: string | null;
  status: string;
  area_code: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  forward_to_e164: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  provider?: string;
  purchased_at?: string | null;
  /** flow · menu (older digit menu) · queue · default (owner → team → forward → voicemail). */
  routing_mode?: 'flow' | 'menu' | 'queue' | 'default';
  /** Active but routing to nobody: no owner, team, queue, forward or flow. */
  standby?: boolean;
  is_company_line?: boolean;
  /** Step types in the number's flow, for the list's routing summary. */
  flow_steps?: string[];
  /** Ring the rep who last reached out to the caller first, then the number's own routing. */
  route_callbacks_to_last_contact?: boolean;
};

export type CarrierNumberDto = { phone_e164: string; provider_number_id: string; status: string | null; attached: boolean };

/** Talkr's admin roster (GET /v1/team/members): every status, plus phone fields. */
export type TalkrMemberDto = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  default_phone_number_id: string | null;
  personal_phone_e164: string | null;
  voicemail_greeting: FlowGreeting | null;
  presence: string;
};

// ---- call flows (Talkr packages/core/src/call-flow.ts) -----------------------

export type FlowGreeting = { tts: string } | { audio_url: string };
export type FlowTarget = { kind: 'user'; user_id: string } | { kind: 'team'; team_id: string } | { kind: 'everyone' } | { kind: 'lead_owner' }
  /** The rep who last reached out to the caller (a call, text, RVM or blast email), within `within_days`. */
  | { kind: 'last_contact'; within_days?: number };
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type FlowNode =
  | { type: 'hours'; label?: string; timezone: string; schedule: Partial<Record<DayKey, Array<[string, string]>>>; holidays: string[]; open: string | null; closed: string | null }
  | { type: 'ring'; label?: string; strategy: 'all' | 'sequential' | 'round_robin'; targets: FlowTarget[]; timeout_seconds: number; no_answer: string | null; busy?: string | null }
  | { type: 'menu'; label?: string; greeting: FlowGreeting; options: Record<string, string | null>; timeout_seconds: number; repeat: number; no_input: string | null }
  | { type: 'forward'; label?: string; to: { kind: 'e164'; e164: string } | { kind: 'personal'; user_id: string }; timeout_seconds: number; no_answer: string | null }
  | { type: 'number_flow'; label?: string; phone_number_id: string }
  | { type: 'voicemail'; label?: string; greeting?: FlowGreeting | null; user_id?: string | null }
  | { type: 'hangup'; label?: string; message?: string | null };
export type CallFlowDto = {
  version: 2;
  start: string;
  nodes: Record<string, FlowNode>;
  recording: boolean;
  announce?: string | null;
  whisper?: string | null;
  voicemail_greeting?: FlowGreeting | null;
  missed_call_text?: { enabled: boolean; body: string; cooldown_hours: number } | null;
};
export type FlowSimulationDto = {
  valid: boolean;
  errors: string[];
  outcome: 'answered' | 'forwarded' | 'voicemail' | 'hangup' | 'default_routing' | null;
  path: Array<{ node: string | null; type: string; detail: string }>;
  missed_call_text: string | null;
};

export type AvailableNumberDto = {
  phone_e164: string;
  locality: string | null;
  region: string | null;
  area_code: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
};

export type TeamMemberDto = {
  id: string;
  display_name: string;
  email?: string | null;
  role: string;
  presence?: string;
  timezone?: string | null;
  city?: string | null;
};

/** Talkr's note on why an inbound call rang who it did. `last_contact` = the rep who last reached out (CLOZR posts RVM and blast email to /v1/outreach). */
export type CallRoutingDto = {
  reason: 'last_contact' | string;
  last_contact?: { user_id: string | null; channel: 'rvm' | 'email' | 'other' | 'call' | 'sms' | string; occurred_at: string; ref: string | null } | null;
};

export type CallDto = {
  id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  user_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  from_number: string;
  to_number: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  disposition_id: string | null;
  contact_name: string | null;
  created_at: string;
  /** Inbound only: why it rang who it did. */
  routing?: CallRoutingDto | null;
};

export type DispositionDto = { slug: string; name: string; requires_follow_up: boolean; adds_suppression: boolean };

export type ParticipantDto = {
  id: string;
  role: 'agent' | 'customer' | 'participant' | string;
  state: string;
  hold: boolean;
  provider_participant_id: string | null;
  display: string | null;
};

export type ConversationDto = {
  id: string;
  our_number: string;
  their_number: string;
  contact_id: string | null;
  lead_id: string | null;
  contact_name: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  last_message_at: string | null;
  last_message: { direction: 'outbound' | 'inbound'; body: string; media_count: number; status: string } | null;
  unread_count: number;
  temperature: string | null;
  tags: string[];
};

export type MessageDto = {
  id: string;
  conversation_id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  body: string;
  media_urls: string[];
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
};

export type HistoryItemDto = {
  kind: 'call' | 'sms';
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  at: string;
  duration_seconds: number | null;
  from_number: string;
  to_number: string;
  contact_name: string | null;
  user_name: string | null;
  disposition_label: string | null;
  note: string | null;
  has_recording: boolean;
  body: string | null;
  conversation_id: string | null;
};

export type TranscriptResponseDto = {
  transcript: {
    status: string;
    full_text: string | null;
    summary: string | null;
    ai: {
      seller_motivation?: string | null;
      timeline?: string | null;
      asking_price?: string | null;
      objections?: string[];
      next_step?: string | null;
      sentiment?: string | null;
      rep_talk_ratio?: number | null;
    };
  } | null;
  recording: { id: string; status: string; duration_seconds: number | null } | null;
  call: { disposition: string | null; disposition_note: string | null; follow_up_at: string | null };
  configured: boolean;
  summary_configured: boolean;
};

export type IntelTurn = { speaker: 'rep' | 'seller'; text: string };

export type IntelContext = {
  contact_name?: string | null;
  address?: string | null;
  stage?: string | null;
  notes?: string | null;
  mao?: string | null;
};

export type LiveIntelDto = {
  mode: 'live';
  talk_ratio: { rep: number; seller: number } | null;
  motivation: string | null;
  timeline: string | null;
  price_expectation: string | null;
  objection: string | null;
  condition: string | null;
  suggested_response: string;
  next_best_question: string;
  coaching: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
};

export type SummaryIntelDto = {
  mode: 'summary';
  talk_ratio: { rep: number; seller: number } | null;
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  motivation: string | null;
  timeline: string | null;
  price_expectation: string | null;
  objection: string | null;
  condition: string | null;
  follow_up: string | null;
  suggested_task: string | null;
};

// ---- the client -------------------------------------------------------------

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const talkr = {
  /** Who Talkr thinks I am. 401 → not linked yet. */
  me: () => request<MeDto>('/v1/me'),
  updateMe: (patch: { caller_id_mode?: CallerIdMode; default_phone_number_id?: string | null; timezone?: string | null; city?: string | null; voicemail_greeting?: FlowGreeting | null }) =>
    request<MeDto>('/v1/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  team: () => request<{ members: TeamMemberDto[] }>('/v1/team'),
  heartbeat: (status: 'available' | 'away' | 'offline') =>
    request<{ ok: boolean }>('/v1/presence', { method: 'POST', body: JSON.stringify({ status }) }),

  // numbers
  numbers: () => request<{ numbers: PhoneNumberDto[] }>('/v1/numbers'),
  searchNumbers: (q: { area_code?: string; contains?: string; limit?: number }) =>
    request<{ numbers: AvailableNumberDto[] }>(`/v1/numbers/available${qs(q)}`),
  buyNumber: (input: { phone_e164: string; assigned_user_id?: string | null; label?: string | null }) =>
    request<{ number: PhoneNumberDto }>('/v1/numbers', { method: 'POST', body: JSON.stringify(input) }),
  updateNumber: (id: string, patch: { assigned_user_id?: string | null; label?: string | null; forward_to_e164?: string; route_callbacks_to_last_contact?: boolean }) =>
    request<{ number: PhoneNumberDto }>(`/v1/numbers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  releaseNumber: (id: string) => request<void>(`/v1/numbers/${id}`, { method: 'DELETE' }),
  /** Numbers on the carrier account that Talkr does not have yet. */
  carrierNumbers: () => request<{ numbers: CarrierNumberDto[] }>('/v1/numbers/carrier'),
  /** Adopt a carrier-owned number (idempotent). */
  importNumber: (input: { phone_e164: string; assigned_user_id?: string | null; label?: string | null }) =>
    request<{ number: PhoneNumberDto; already_imported: boolean }>('/v1/numbers/import', { method: 'POST', body: JSON.stringify(input) }),
  setCompanyLine: (id: string, on: boolean) =>
    request<{ number: PhoneNumberDto }>(`/v1/numbers/${id}`, { method: 'PATCH', body: JSON.stringify({ is_company_line: on }) }),
  routing: (id: string) => request<{ flow: CallFlowDto | null; legacy_ivr: unknown; is_company_line: boolean }>(`/v1/numbers/${id}/routing`),
  /** Save (or clear with null). A 400 carries `errors`. */
  saveRouting: (id: string, flow: CallFlowDto | null) =>
    request<{ flow: CallFlowDto | null }>(`/v1/numbers/${id}/routing`, { method: 'PUT', body: JSON.stringify({ flow }) }),
  simulateRouting: (id: string, input: { flow?: CallFlowDto; at?: string; from?: string; digits?: string; answered_by?: string | null; unavailable_user_ids?: string[] }) =>
    request<FlowSimulationDto>(`/v1/numbers/${id}/routing/simulate`, { method: 'POST', body: JSON.stringify(input) }),
  /** Admin roster with phone fields. */
  teamMembers: () => request<{ members: TalkrMemberDto[] }>('/v1/team/members'),
  /** Put a CLOZR teammate on Talkr (admin). They link by email on first Clozr
   * sign-in via the partner JWT — do not email a Talkr auth invite (that opens
   * talkrdialer.com). `send_auth_invite: false` asks Talkr to skip that mail. */
  createTeamMember: (input: {
    email: string;
    display_name: string;
    role: 'admin' | 'manager' | 'rep';
    title?: string | null;
    /** When false, Talkr should not email a talkrdialer.com invite. Default false from Clozr. */
    send_auth_invite?: boolean;
  }) =>
    request<{ member: TalkrMemberDto }>('/v1/team/members', {
      method: 'POST',
      body: JSON.stringify({ send_auth_invite: false, ...input }),
    }),
  updateTeamMember: (id: string, patch: { default_phone_number_id?: string | null; personal_phone_e164?: string | null; voicemail_greeting?: FlowGreeting | null; status?: 'active' | 'disabled' }) =>
    request<{ member: TalkrMemberDto }>(`/v1/team/members/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Upload a file (greetings: MP3/WAV); the returned url is public and immutable. */
  uploadMedia: (input: { content_type: string; data_base64: string; filename?: string }) =>
    request<{ id: string; url: string; content_type: string; byte_size: number }>('/v1/media', { method: 'POST', body: JSON.stringify(input) }),

  // voice
  /** A browser credential plus which carrier SDK to load and who opens the outbound leg (lib/softphone-engine.ts). */
  voiceToken: () => request<VoiceTokenDto>('/v1/voice/token', { method: 'POST', body: '{}' }),
  /** Server-leg carriers (Telnyx): have the carrier ring this browser for a call the server created. */
  ringBrowserLeg: (callId: string) =>
    request<{ mode: 'client' | 'server'; provider_call_id: string | null }>(`/v1/calls/${callId}/browser-leg`, { method: 'POST', body: '{}' }),
  /** End a call the browser could not join, so the carrier leg does not sit open. */
  hangupCall: (id: string) => request<{ ok?: boolean }>(`/v1/calls/${id}/hangup`, { method: 'POST', body: '{}' }),
  createCall: (input: { to_number?: string; contact_id?: string; lead_id?: string; from_phone_number_id?: string }) =>
    request<{ call: CallDto }>('/v1/calls', { method: 'POST', body: JSON.stringify(input) }),
  calls: () => request<{ calls: CallDto[] }>('/v1/calls'),
  call: (id: string) => request<{ call: CallDto }>(`/v1/calls/${id}`),
  dispositions: () => request<{ dispositions: DispositionDto[] }>('/v1/dispositions'),
  setDisposition: (id: string, input: { disposition: string; note?: string; follow_up_at?: string }) =>
    request<{ call: CallDto }>(`/v1/calls/${id}/disposition`, { method: 'POST', body: JSON.stringify(input) }),
  hold: (id: string, hold: boolean) => request<{ ok: boolean }>(`/v1/calls/${id}/hold`, { method: 'POST', body: JSON.stringify({ hold }) }),
  participants: (id: string) => request<{ participants: ParticipantDto[] }>(`/v1/calls/${id}/participants`),
  addParticipant: (id: string, input: { user_id?: string; to_number?: string; consult?: boolean }) =>
    request<{ participant: ParticipantDto }>(`/v1/calls/${id}/participants`, { method: 'POST', body: JSON.stringify(input) }),
  merge: (id: string) => request<{ ok: boolean }>(`/v1/calls/${id}/merge`, { method: 'POST', body: '{}' }),
  transfer: (id: string, input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) =>
    request<{ ok: boolean }>(`/v1/calls/${id}/transfer`, { method: 'POST', body: JSON.stringify(input) }),
  completeTransfer: (id: string) => request<{ ok: boolean }>(`/v1/calls/${id}/transfer/complete`, { method: 'POST', body: '{}' }),
  history: (q: { type?: 'calls' | 'sms' | 'all'; limit?: number } = {}) =>
    request<{ items: HistoryItemDto[] }>(`/v1/history${qs({ type: q.type ?? 'calls', limit: q.limit ?? 30 })}`),

  // the smart surface
  transcriptionToken: () =>
    request<{ key: string; expires_at: string; ttl_seconds: number }>('/v1/transcription/token', { method: 'POST', body: '{}' }),
  intel: <M extends 'live' | 'summary'>(
    callId: string,
    input: { mode: M; turns: IntelTurn[]; context?: IntelContext; elapsed_seconds?: number },
  ) =>
    request<M extends 'live' ? LiveIntelDto : SummaryIntelDto>(`/v1/calls/${callId}/intel`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  transcript: (callId: string) => request<TranscriptResponseDto>(`/v1/calls/${callId}/transcript`),

  // messaging
  conversations: (q: { unread?: boolean; limit?: number } = {}) =>
    request<{ conversations: ConversationDto[]; total: number; counts: { unread: number } }>(
      `/v1/conversations${qs({ unread: q.unread ? 1 : undefined, limit: q.limit ?? 50 })}`,
    ),
  messages: (conversationId: string) =>
    request<{ conversation_id: string; messages: MessageDto[] }>(`/v1/conversations/${conversationId}/messages`),
  markRead: (conversationId: string) =>
    request<{ ok: boolean }>(`/v1/conversations/${conversationId}/read`, { method: 'POST', body: '{}' }),
  sendMessage: (input: { conversation_id?: string; to_number?: string; body: string; from_phone_number_id?: string; media_urls?: string[] }) =>
    request<{ message: MessageDto; conversation_id: string }>('/v1/messages', { method: 'POST', body: JSON.stringify(input) }),
};

/** Realtime: Talkr's SSE fan-out. EventSource cannot set headers, so the token rides in the query. */
export function eventStreamUrl(token: string): string {
  return `${talkrUrl()}/v1/events/stream?access_token=${encodeURIComponent(token)}`;
}

/**
 * Talkr's event stream, kept open past the session's token. EventSource
 * reconnects with the URL it was opened with, and the token in that URL is the
 * Supabase session's, which expires within the hour; after that every
 * reconnect was a 401 and the browser stopped trying, so texts and calls
 * stopped arriving live. This reopens the stream with a fresh URL when
 * Supabase refreshes the session, and after the browser gives up (backing off
 * to a minute). `attach` adds the listeners to each stream it opens. Returns
 * the cleanup.
 */
export function keepEventStream(urlFor: () => Promise<string | null>, attach: (es: EventSource) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let seq = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = async () => {
    if (retry) { clearTimeout(retry); retry = null; }
    const mine = ++seq;
    const url = await urlFor().catch(() => null);
    if (stopped || mine !== seq || !url) return;
    es?.close();
    let next: EventSource;
    try {
      next = new EventSource(url);
    } catch {
      es = null;
      return;
    }
    es = next;
    next.addEventListener('open', () => { failures = 0; });
    next.addEventListener('error', () => {
      // A dropped connection the browser is retrying stays CONNECTING; CLOSED
      // means it gave up, which is what a 401 on an expired token does.
      if (stopped || es !== next || next.readyState !== EventSource.CLOSED) return;
      failures += 1;
      retry = setTimeout(() => void open(), Math.min(60_000, 2_000 * 2 ** (failures - 1)));
    });
    attach(next);
  };
  void open();
  // Supabase asks that nothing awaits its client inside this callback, so the
  // reopen (which reads the session) runs on the next tick.
  const sub = supabase?.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED') setTimeout(() => void open(), 0);
  });
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    es?.close();
    sub?.data.subscription.unsubscribe();
  };
}

// ---- formatting helpers shared by the dialer and settings --------------------

/** "(210) 555-0100" for a US E.164; anything else unchanged. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Loose digits → E.164 for US numbers; passes an already-formatted +… through. Null when not a number. */
export function toE164(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^\+\d{7,15}$/.test(t)) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

/** City for a US area code, for the caller-ID line. Only the markets Acme Homes dials. */
const AREA_CITY: Record<string, string> = {
  '210': 'San Antonio', '726': 'San Antonio', '512': 'Austin', '737': 'Austin', '214': 'Dallas', '469': 'Dallas',
  '972': 'Dallas', '817': 'Fort Worth', '682': 'Fort Worth', '713': 'Houston', '281': 'Houston', '832': 'Houston',
  '346': 'Houston', '915': 'El Paso', '361': 'Corpus Christi', '956': 'McAllen', '806': 'Lubbock', '325': 'Abilene',
  '432': 'Midland', '979': 'College Station', '254': 'Waco', '903': 'Morgan', '430': 'Morgan', '936': 'Huntsville',
  '409': 'Beaumont', '830': 'New Braunfels',
};
export function areaCity(e164: string | null | undefined): string | null {
  const m = /^\+1(\d{3})/.exec(e164 ?? '');
  return m ? AREA_CITY[m[1]!] ?? null : null;
}
