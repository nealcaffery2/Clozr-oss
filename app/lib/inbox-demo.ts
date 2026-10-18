// The Inbox on sample data (/demo): three reps' texts, calls and email, so
// the owner switcher, the "Viewed" receipt on a text with a signing link and
// the "Opened" receipt on an email can be seen without Talkr or Gmail.
//
// Talkr reads are answered by `demoTalkr` (installed through
// lib/talkr-web/api setTalkrDemo, only when the Inbox runs on sample data);
// email rows and receipts are handed to the Email tab directly. Nothing here
// leaves the browser. Times are relative to now, so "Today" stays today.

import type {
  ConversationDto, HistoryItemDto, MeDto, MessageDto, TeamMemberDto,
} from './talkr-web/api';
import type { LinkView } from './link-views';

const MIN = 60_000;
const ago = (min: number, now = Date.now()) => new Date(now - min * MIN).toISOString();

/** The demo's signing link token (48 hex), shared with the record's sample timeline. */
export const DEMO_SIGN_TOKEN = '8f2bc0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';
export const DEMO_SIGN_URL = `https://clozr.link/sign/?t=${DEMO_SIGN_TOKEN}`;
/** A second offer link, sent by a teammate and not opened yet. */
const DEMO_SIGN_TOKEN_2 = 'c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b';

/** The offer link on Kara's record (lib/clozr-data timeline), sent the day before. */
const DEMO_RECORD_SIGN_TOKEN = '5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
export const DEMO_RECORD_SIGN_URL = `https://clozr.link/sign/?t=${DEMO_RECORD_SIGN_TOKEN}`;

/** Opens of the demo's tracked links, by lib/link-views key. */
export function demoLinkViews(now = Date.now()): Map<string, LinkView> {
  return new Map([
    [`sign:${DEMO_SIGN_TOKEN}`, { firstAt: ago(46, now), views: 2, seconds: 95 }],
    [`sign:${DEMO_RECORD_SIGN_TOKEN}`, { firstAt: ago(23 * 60, now), views: 3, seconds: 160 }],
  ]);
}

const LINES = [
  { id: 'line-taylor', phone_e164: '+12105550400', label: 'Taylor', area_code: '210', assigned_user_id: 'taylor', provider: 'telnyx' },
  { id: 'line-diego', phone_e164: '+17135550401', label: 'Diego', area_code: '713', assigned_user_id: 'diego', provider: 'telnyx' },
  { id: 'line-main', phone_e164: '+15125550402', label: 'Main', area_code: '512', assigned_user_id: null, provider: 'telnyx' },
];

export const DEMO_TALKR_ME: MeDto = {
  id: 'taylor', display_name: 'Taylor Reed', email: 'taylor@yourcompany.com', role: 'agent',
  org: { id: 'demo', name: 'Acme Homes', slug: 'acme-homes' },
  timezone: 'America/Chicago', city: 'San Antonio', title: 'Acquisitions',
  numbers: [{ id: 'line-taylor', phone_e164: '+12105550400', label: 'Taylor' }],
  org_numbers: LINES,
  default_phone_number_id: 'line-taylor',
  caller_id_mode: 'dedicated',
};

const member = (id: string, display_name: string, title: string, is_self = false): TeamMemberDto => ({
  id, display_name, role: 'agent', title, timezone: 'America/Chicago', city: null, presence: 'available', last_seen_at: null, is_self,
});
export const DEMO_TEAM: TeamMemberDto[] = [
  member('taylor', 'Taylor Reed', 'Acquisitions', true),
  member('diego', 'Diego Ortiz', 'Acquisitions'),
  member('sam', 'Sam Carter', 'Owner'),
];

type Thread = {
  id: string; our: string; their: string; name: string; assigned: string | null; type: ConversationDto['contact_type'];
  temp: ConversationDto['temperature']; unread: number;
  msgs: { dir: 'inbound' | 'outbound'; body: string; min: number; status?: string }[];
};

const THREADS: Thread[] = [
  {
    id: 'demo-kara', our: '+12105550400', their: '+12105550136', name: 'Kara Mitchell', assigned: 'taylor', type: 'seller', temp: 'hot', unread: 1,
    msgs: [
      { dir: 'outbound', body: 'Hi Kara, this is Taylor with Acme Homes. Thanks for the time on the phone today.', min: 1460, status: 'delivered' },
      { dir: 'inbound', body: 'Thanks Taylor. Send the offer over when it is ready.', min: 1450 },
      { dir: 'outbound', body: `Kara, here is the written offer we discussed: ${DEMO_SIGN_URL} No obligation. Happy to walk through it whenever.`, min: 52, status: 'delivered' },
      { dir: 'inbound', body: 'Got it, reading it now with my brother.', min: 3 },
    ],
  },
  {
    id: 'demo-marvin', our: '+12105550400', their: '+15125550109', name: 'Marvin Cole', assigned: 'taylor', type: 'seller', temp: 'warm', unread: 0,
    msgs: [
      { dir: 'inbound', body: 'Title called. They said we are clear to close Friday?', min: 190 },
      { dir: 'outbound', body: 'Yes, Friday at 10 at Alamo Title. I will text you the address in the morning.', min: 185, status: 'delivered' },
    ],
  },
  {
    id: 'demo-gary', our: '+12105550400', their: '+12815550170', name: 'Gary Whitfield', assigned: 'taylor', type: 'seller', temp: 'warm', unread: 0,
    msgs: [{ dir: 'outbound', body: 'Gary, the offer is good through Tuesday. Want to talk through the numbers today?', min: 2900, status: 'delivered' }],
  },
  {
    id: 'demo-ronald', our: '+17135550401', their: '+17135550192', name: 'Ronald Moore', assigned: 'diego', type: 'seller', temp: 'hot', unread: 2,
    msgs: [
      { dir: 'outbound', body: `Ronald, your offer for the Westheimer house is here: https://clozr.link/sign/?t=${DEMO_SIGN_TOKEN_2}`, min: 240, status: 'delivered' },
      { dir: 'inbound', body: 'Can you do 190?', min: 21 },
      { dir: 'inbound', body: 'My wife wants to close before Thanksgiving.', min: 20 },
    ],
  },
  {
    id: 'demo-teresa', our: '+17135550401', their: '+19725550133', name: 'Teresa Vance', assigned: 'diego', type: 'seller', temp: 'cold', unread: 0,
    msgs: [{ dir: 'outbound', body: 'Teresa, calling you back at 4 like you asked.', min: 300, status: 'delivered' }],
  },
  {
    id: 'demo-main', our: '+15125550402', their: '+18175550117', name: 'John Smith', assigned: null, type: 'seller', temp: null, unread: 1,
    msgs: [{ dir: 'inbound', body: 'Saw your mailer. Do you buy houses in Arlington?', min: 75 }],
  },
];

function messagesOf(t: Thread, now: number): MessageDto[] {
  return t.msgs.map((m, i) => ({
    id: `${t.id}-${i}`, conversation_id: t.id, direction: m.dir, status: m.status ?? 'received', body: m.body, media_urls: [],
    error_code: null, failure_class: 'none', is_auto_reply: false, created_at: ago(m.min, now), sent_at: ago(m.min, now),
    delivered_at: m.dir === 'outbound' ? ago(m.min - 0.2, now) : null, failed_at: null,
  }));
}

const REP_NAME: Record<string, string> = { taylor: 'Taylor Reed', diego: 'Diego Ortiz', sam: 'Sam Carter' };

export function demoConversations(now = Date.now()): ConversationDto[] {
  return THREADS.map((t) => {
    const last = t.msgs[t.msgs.length - 1]!;
    return {
      id: t.id, our_number: t.our, their_number: t.their, contact_id: null, lead_id: null, contact_name: t.name,
      lead_status: null, lead_city: null, lead_state: null, assigned_user_id: t.assigned,
      last_message_at: ago(last.min, now),
      last_message: { direction: last.dir, body: last.body, media_count: 0, status: last.status ?? 'received' },
      unread_count: t.unread, created_at: ago(t.msgs[0]!.min, now),
      contact_type: t.type, contact_status: null, temperature: t.temp, temperature_score: t.temp === 'hot' ? 88 : t.temp === 'warm' ? 64 : t.temp === 'cold' ? 22 : null,
      tags: [], assigned_user_name: t.assigned ? REP_NAME[t.assigned] ?? null : null,
    };
  }).sort((a, b) => Date.parse(b.last_message_at!) - Date.parse(a.last_message_at!));
}

const call = (id: string, dir: 'inbound' | 'outbound', min: number, user: string | null, from: string, to: string, name: string, extra: Partial<HistoryItemDto> = {}): HistoryItemDto => ({
  kind: 'call', id, direction: dir, status: extra.status ?? 'completed', at: ago(min), duration_seconds: extra.duration_seconds ?? null,
  from_number: from, to_number: to, contact_name: name, address: null, user_id: user, user_name: user ? REP_NAME[user] ?? null : null,
  disposition_slug: null, disposition_label: extra.disposition_label ?? null, note: null, has_recording: extra.has_recording ?? false,
  body: null, media_count: 0, lead_id: null, contact_id: null, conversation_id: null,
});

export function demoCalls(): HistoryItemDto[] {
  return [
    call('demo-c1', 'outbound', 42, 'taylor', '+12105550400', '+12105550136', 'Kara Mitchell', { duration_seconds: 412, disposition_label: 'Interested', has_recording: true }),
    call('demo-c2', 'inbound', 130, null, '+12815550170', '+12105550400', 'Gary Whitfield', { status: 'no_answer' }),
    call('demo-c3', 'outbound', 65, 'diego', '+17135550401', '+17135550192', 'Ronald Moore', { duration_seconds: 188, disposition_label: 'Callback' }),
    call('demo-c4', 'inbound', 95, null, '+18175550117', '+15125550402', 'John Smith', { status: 'no_answer', has_recording: true, duration_seconds: 31 }),
  ];
}

/**
 * Talkr's answer to a read on sample data, or undefined for a path it does not
 * play. A send is accepted and appended to the thread, so the composer works.
 */
const sent: Record<string, MessageDto[]> = {};
export function demoTalkr(path: string, init: RequestInit = {}): unknown {
  const now = Date.now();
  const [route, qs = ''] = path.split('?');
  const q = new URLSearchParams(qs);
  const method = (init.method ?? 'GET').toUpperCase();
  if (route === '/v1/me') return DEMO_TALKR_ME;
  if (route === '/v1/team') return { members: DEMO_TEAM };
  if (route === '/v1/numbers') return { numbers: LINES.map((l) => ({ ...l, status: 'active', forward_to_e164: null, capabilities: { voice: true, sms: true } })) };
  if (route === '/v1/message-templates') return { templates: [] };
  if (route === '/v1/conversations') {
    let list = demoConversations(now);
    const number = q.get('number_id');
    if (number) { const line = LINES.find((l) => l.id === number); list = list.filter((c) => c.our_number === line?.phone_e164); }
    const user = q.get('user_id');
    if (user) list = list.filter((c) => c.assigned_user_id === user);
    const needle = (q.get('q') ?? '').toLowerCase();
    if (needle) list = list.filter((c) => [c.contact_name, c.their_number].some((v) => v?.toLowerCase().includes(needle)));
    if (q.get('unread') === 'true') list = list.filter((c) => c.unread_count > 0);
    const limit = Number(q.get('limit') ?? 50);
    return { conversations: list.slice(0, limit), total: list.length, counts: { unread: list.filter((c) => c.unread_count > 0).length, by_type: {}, by_temperature: {} } };
  }
  const thread = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(route ?? '');
  if (thread) {
    const t = THREADS.find((x) => x.id === thread[1]);
    return { conversation_id: thread[1], messages: [...(t ? messagesOf(t, now) : []), ...(sent[thread[1]!] ?? [])] };
  }
  if (/^\/v1\/conversations\/[^/]+\/read$/.test(route ?? '')) {
    const t = THREADS.find((x) => route === `/v1/conversations/${x.id}/read`);
    if (t) t.unread = 0;
    return { ok: true };
  }
  if (route === '/v1/history') return { items: demoCalls(), total: 4, kpis: null };
  if (route === '/v1/messages' && method === 'POST') {
    const b = JSON.parse(String(init.body ?? '{}')) as { conversation_id?: string; body?: string };
    const id = b.conversation_id ?? 'demo-new';
    const m: MessageDto = {
      id: `demo-sent-${now}`, conversation_id: id, direction: 'outbound', status: 'delivered', body: b.body ?? '', media_urls: [],
      error_code: null, failure_class: 'none', is_auto_reply: false, created_at: new Date(now).toISOString(), sent_at: new Date(now).toISOString(), delivered_at: null, failed_at: null,
    };
    (sent[id] ??= []).push(m);
    return { message: m, conversation_id: id };
  }
  return undefined;
}

/** Email rows for the Email and All tabs on sample data (the shape app/components/inbox/data.ts reads). */
export function demoEmailRows(now = Date.now()) {
  const row = (id: number, direction: 'inbound' | 'outbound', min: number, subject: string, from: string, to: string, body: string, seller: number | null) => ({
    id, seller_id: seller, buyer_id: null, deal_id: null, direction, occurred_at: ago(min, now), subject, body, preview: body.slice(0, 300),
    from_email: from, to_email: to, status: direction === 'outbound' ? 'sent' : 'received', source: 'gmail', source_id: `<demo-${id}@yourcompany.com>`, rep_id: null,
  });
  return [
    row(900001, 'outbound', 1340, 'Your cash offer for 1803 Cypress Lane', 'taylor@yourcompany.com', 'kara.mitchell@gmail.com',
      'Hi Kara,\n\nAs promised, here is our written cash offer for 1803 Cypress Lane: $186,000, as-is, no repairs, no commissions, and we cover the closing costs.\n\nYou pick the closing date. Reply here or call me with any questions.\n\nTaylor Reed\nAcme Homes', 1),
    row(900002, 'inbound', 1100, 'Re: Your cash offer for 1803 Cypress Lane', 'kara.mitchell@gmail.com', 'taylor@yourcompany.com',
      'Hi Taylor,\n\nMy brother and I read through the offer tonight and we are both comfortable with the price, but we would need a closing date after September 15.\n\nThanks,\nKara', 1),
    row(900003, 'outbound', 35, 'Closing date for 1803 Cypress Lane', 'taylor@yourcompany.com', 'kara.mitchell@gmail.com',
      'Hi Kara,\n\nSeptember 18 works on our side. I updated the agreement; it is the same link as before.\n\nTaylor', 1),
    row(900004, 'outbound', 300, 'Repair breakdown for 7712 Aspen Ct', 'taylor@yourcompany.com', 'derek.ross@outlook.com',
      'Derek,\n\nAttached is the repair breakdown behind our number. The roof and the foundation are most of it.\n\nTaylor', 4),
  ];
}

/** Read receipts for those rows (email_tracking's shape). */
export function demoEmailReceipts(now = Date.now()) {
  return new Map([
    [900001, { communication_id: 900001, opens: 4, clicks: 1, first_opened_at: ago(1320, now), last_opened_at: ago(1110, now), last_clicked_at: ago(1115, now) }],
    [900003, { communication_id: 900003, opens: 1, clicks: 0, first_opened_at: ago(12, now), last_opened_at: ago(12, now), last_clicked_at: null }],
    [900004, { communication_id: 900004, opens: 0, clicks: 0, first_opened_at: null, last_opened_at: null, last_clicked_at: null }],
  ]);
}
