// Local presence numbers for the AI agents (migration 150, docs/voice-agent.md).
//
// The workspace keeps a pool of AI caller numbers, one per market. Every AI
// call goes out from the one local to the lead (pickLocalNumber). Publish
// wires the pool end to end, so nobody has to touch the Telnyx or ElevenLabs
// consoles:
//   1. the workspace's CLOZR AI SIP connection in Telnyx: an FQDN connection to
//      sip.rtc.elevenlabs.io (TCP 5060) with digest credentials ElevenLabs uses
//      to place calls through sip.telnyx.com. Made once (or adopted by name),
//      kept in voice_agent_secrets.
//   2. per market, a local number in its area code, ordered onto that
//      connection, its Telnyx customer reference set to the label;
//   3. the number imported into ElevenLabs as a SIP trunk number under the
//      label and assigned to the agent that answers it when someone calls back.
// Every step is resumable: a number that failed halfway keeps what it got
// (the number, the ElevenLabs id) and the next Publish picks up from there.

import { elJson, type ElConfig } from './voice-agent-admin.ts';

export const TELNYX_API = 'https://api.telnyx.com/v2';
export const EL_SIP_HOST = 'sip.rtc.elevenlabs.io';
export const TELNYX_SIP_HOST = 'sip.telnyx.com';
export const SIP_CONNECTION_NAME = 'CLOZR AI agents (ElevenLabs)';

export type NumberRow = {
  id: number; workspace_id: number; market: string; state: string | null; area_code: string; covers: string[]; label: string;
  answer_agent_key: string | null; phone_number: string | null; status: 'wanted' | 'ordered' | 'active' | 'failed';
  telnyx_number_id: string | null; telnyx_order_id: string | null; el_phone_number_id: string | null; error: string | null;
};
export type SipState = { sip_connection_id: string | null; sip_username: string | null; sip_password: string | null };
export type TelnyxCfg = { apiKey: string; fetchFn?: typeof fetch };

export class TelnyxError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A line's label: trimmed, single-line, 60 characters (ElevenLabs and Telnyx both show it). */
export function cleanLabel(v: unknown, fallback: string): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || fallback.slice(0, 60);
}

/** A US area code (NXX: first digit 2 to 9), or null. */
export function cleanAreaCode(v: unknown): string | null {
  const s = String(v ?? '').replace(/\D/g, '');
  return /^[2-9]\d{2}$/.test(s) ? s : null;
}

/** The default name for a market's number: "AI · Houston". */
export const defaultLabel = (market: string) => `AI · ${(market || 'local').trim()}`;

/** The area code of a US phone number in any format, or null. */
export function areaCodeOf(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 && /^[2-9]/.test(ten) ? ten.slice(0, 3) : null;
}

/** A market's area codes: its own and the ones it is local for, cleaned and unique. */
export function cleanCovers(main: string, v: unknown): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = [main];
  for (const x of list) { const a = cleanAreaCode(x); if (a && !out.includes(a)) out.push(a); }
  return out.slice(0, 20);
}

export type LocalPick = { el_phone_number_id: string; phone_number: string | null; market: string; why: 'area_code' | 'state' };

/**
 * Local presence: the pool number to call a lead from. Same area code (the
 * market's own or one it covers) first, else the same state; null when
 * nothing in the pool is local, so the caller keeps the agent's default.
 * Only live numbers (active, imported into ElevenLabs) are picked.
 */
export function pickLocalNumber(pool: Pick<NumberRow, 'market' | 'state' | 'area_code' | 'covers' | 'status' | 'el_phone_number_id' | 'phone_number'>[], leadPhone: string | null | undefined, leadState?: string | null): LocalPick | null {
  const live = pool.filter((r) => r.status === 'active' && r.el_phone_number_id);
  const ac = areaCodeOf(leadPhone);
  const pick = (r: typeof live[number], why: LocalPick['why']): LocalPick => ({ el_phone_number_id: r.el_phone_number_id!, phone_number: r.phone_number, market: r.market, why });
  if (ac) {
    const hit = live.find((r) => r.area_code === ac) ?? live.find((r) => (r.covers ?? []).includes(ac));
    if (hit) return pick(hit, 'area_code');
  }
  const st = String(leadState ?? '').trim().toUpperCase() || (ac ? AREA_CODE_STATE[ac] ?? '' : '');
  if (st) {
    const hit = live.find((r) => String(r.state ?? '').toUpperCase() === st);
    if (hit) return pick(hit, 'state');
  }
  return null;
}

/**
 * The state of the area codes our markets sit in and their neighbours, so a
 * lead with no state on file still gets an in-state number (a 979 lead is
 * called from a Texas number). Not every US area code: unknown ones fall
 * back to the agent's default.
 */
export const AREA_CODE_STATE: Record<string, string> = Object.fromEntries(([
  ['TX', '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979'],
  ['GA', '229 404 470 478 678 706 762 770 912 943'],
  ['SC', '803 839 843 854 864'],
  ['NC', '252 336 704 743 828 910 919 980 984'],
  ['MO', '314 417 557 573 636 660 816 975'],
  ['OK', '405 539 572 580 918'],
  ['TN', '423 615 629 731 865 901 931'],
  ['AL', '205 251 256 334 659 938'],
  ['FL', '239 305 321 352 386 407 448 561 656 689 727 754 772 786 813 850 863 904 941 954'],
  ['AR', '479 501 870'],
  ['MS', '228 601 662 769'],
  ['LA', '225 318 337 504 985'],
  ['KS', '316 620 785 913'],
] as [string, string][]).flatMap(([st, codes]) => codes.split(' ').map((c) => [c, st])));

/** SIP credentials Telnyx accepts: a letters-and-digits username and a long letters-and-digits password. */
export function sipCredentials(ws: number, rand: (n: number) => string = randomAlnum): { username: string; password: string } {
  return { username: `clozrai${ws}${rand(6).toLowerCase()}`, password: rand(28) };
}

export function randomAlnum(n: number): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/**
 * The Telnyx body that creates the agents' FQDN connection. Telnyx takes no
 * outbound voice profile until the connection is fully set up (its FQDN and
 * credentials), so the profile is attached last (ensureSipConnection).
 * Outbound authentication stays Telnyx's FQDN default: credentials.
 */
export function fqdnConnectionBody() {
  return {
    connection_name: SIP_CONNECTION_NAME,
    active: true,
    transport_protocol: 'TCP',
    tags: ['clozr', 'elevenlabs'],
    inbound: { ani_number_format: '+E.164', dnis_number_format: '+e164' },
  };
}

/** The ElevenLabs body that imports a Telnyx number as a SIP trunk number. */
export function elImportBody(phone: string, label: string, agentId: string | null, creds: { username: string; password: string } | null) {
  return {
    provider: 'sip_trunk',
    phone_number: phone,
    label,
    ...(agentId ? { agent_id: agentId } : {}),
    inbound_trunk_config: { media_encryption: 'allowed' },
    outbound_trunk_config: {
      address: TELNYX_SIP_HOST,
      transport: 'tcp',
      media_encryption: 'allowed',
      ...(creds ? { credentials: { username: creds.username, password: creds.password } } : {}),
    },
  };
}

/** The best outbound voice profile: the one Talkr already uses, else any enabled one. */
export function pickOutboundProfile(rows: { id?: unknown; name?: unknown; enabled?: unknown }[]): string | null {
  const ok = rows.filter((r) => r && r.enabled !== false && r.id);
  const talkr = ok.find((r) => /talkr/i.test(String(r.name ?? '')));
  return String((talkr ?? ok[0])?.id ?? '') || null;
}

/** Telnyx's error as one line: its first error's detail or title. */
function telnyxDetail(body: unknown, status: number): string {
  const e = (body as { errors?: { title?: string; detail?: string }[] } | null)?.errors?.[0];
  return (e?.detail || e?.title || `Telnyx answered ${status}`).slice(0, 300);
}

export async function tx<T = Record<string, unknown>>(cfg: TelnyxCfg, method: string, path: string, body?: unknown): Promise<T> {
  const f = cfg.fetchFn ?? fetch;
  const res = await f(TELNYX_API + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new TelnyxError(res.status, telnyxDetail(json, res.status).replaceAll(cfg.apiKey, '[key]'));
  return (json ?? {}) as T;
}

type Data<T> = { data?: T };

type Conn = { id?: string; user_name?: string | null; connection_name?: string; outbound?: { outbound_voice_profile_id?: string | null } };

/**
 * The agents' SIP connection, ready for ElevenLabs: the stored one if Telnyx
 * still has it, else one already named for CLOZR (made by hand or by an
 * earlier run that stopped halfway), else a new one. In that order it gets
 * the ElevenLabs FQDN, CLOZR's own credentials (new ones whenever we do not
 * hold its password) and an outbound voice profile. Returns the state to
 * store; the caller persists it.
 */
export async function ensureSipConnection(cfg: TelnyxCfg, ws: number, have: SipState): Promise<{ state: SipState; creds: { username: string; password: string } }> {
  const enc = encodeURIComponent;
  let conn: Conn | null = null;
  if (have.sip_connection_id) {
    try {
      conn = (await tx<Data<Conn>>(cfg, 'GET', `/fqdn_connections/${enc(have.sip_connection_id)}`)).data ?? null;
    } catch (e) {
      if (!(e instanceof TelnyxError) || e.status !== 404) throw e; // Deleted in the portal: find or make another.
    }
  }
  if (!conn?.id) {
    const found = await tx<Data<Conn[]>>(cfg, 'GET', `/fqdn_connections?filter[connection_name][contains]=${enc(SIP_CONNECTION_NAME)}&page[size]=10`);
    conn = (found.data ?? []).find((c) => c.connection_name === SIP_CONNECTION_NAME) ?? null;
  }
  if (!conn?.id) conn = (await tx<Data<Conn>>(cfg, 'POST', '/fqdn_connections', fqdnConnectionBody())).data ?? null;
  const id = String(conn?.id ?? '');
  if (!id) throw new TelnyxError(502, 'Telnyx did not return the SIP connection id');

  // The ElevenLabs address, once.
  const fqdns = await tx<Data<{ fqdn?: string }[]>>(cfg, 'GET', `/fqdns?filter[connection_id]=${enc(id)}&page[size]=20`);
  if (!(fqdns.data ?? []).some((f) => String(f.fqdn ?? '').toLowerCase() === EL_SIP_HOST)) {
    await tx(cfg, 'POST', '/fqdns', { connection_id: id, fqdn: EL_SIP_HOST, port: 5060, dns_record_type: 'a' });
  }

  // Credentials ElevenLabs places calls with: ours if Telnyx still has our username, else new ones.
  let creds = have.sip_connection_id === id && have.sip_username && have.sip_password && conn?.user_name === have.sip_username
    ? { username: have.sip_username, password: have.sip_password }
    : null;
  if (!creds) {
    const fresh = sipCredentials(ws);
    const set = await tx<Data<Conn>>(cfg, 'PATCH', `/fqdn_connections/${enc(id)}`, { user_name: fresh.username, password: fresh.password });
    if (String(set.data?.user_name ?? '') !== fresh.username) throw new TelnyxError(502, 'Telnyx did not keep the SIP credentials on the CLOZR AI connection');
    creds = fresh;
    conn = set.data ?? conn;
  }

  // The outbound voice profile, last: Telnyx refuses it before the connection is fully set up.
  if (!conn?.outbound?.outbound_voice_profile_id) {
    const profiles = await tx<Data<{ id?: string; name?: string; enabled?: boolean }[]>>(cfg, 'GET', '/outbound_voice_profiles?page[size]=50');
    const profile = pickOutboundProfile(profiles.data ?? []);
    if (!profile) throw new TelnyxError(404, 'Telnyx has no outbound voice profile to put on the CLOZR AI connection');
    await tx(cfg, 'PATCH', `/fqdn_connections/${enc(id)}`, { outbound: { outbound_voice_profile_id: profile } });
  }
  return { state: { sip_connection_id: id, sip_username: creds.username, sip_password: creds.password }, creds };
}

/**
 * Order one local voice number onto the connection: in the market's own area
 * code, else the next one it covers (San Antonio 210, then 726, then 830).
 * Telnyx answers an area code with nothing free either with no rows or with
 * "No numbers found", so both move on to the next.
 */
export async function orderNumber(cfg: TelnyxCfg, areaCodes: string | string[], connectionId: string, label: string): Promise<{ phone: string; orderId: string }> {
  const codes = [...new Set((Array.isArray(areaCodes) ? areaCodes : [areaCodes]).filter((c) => /^[2-9]\d{2}$/.test(c)))];
  let phone: string | undefined;
  for (const areaCode of codes) {
    const q = new URLSearchParams({
      'filter[country_code]': 'US', 'filter[national_destination_code]': areaCode, 'filter[phone_number_type]': 'local',
      'filter[features][]': 'voice', 'filter[limit]': '5',
    });
    try {
      const avail = await tx<Data<{ phone_number?: string }[]>>(cfg, 'GET', `/available_phone_numbers?${q}`);
      phone = (avail.data ?? []).map((r) => String(r.phone_number ?? '')).find((p) => /^\+1\d{10}$/.test(p));
    } catch (e) {
      if (!(e instanceof TelnyxError) || !/no numbers found/i.test(e.message)) throw e;
    }
    if (phone) break;
  }
  if (!phone) throw new TelnyxError(404, `Telnyx has no local number free in ${codes.join(', ')} right now. Add another area code to the market and try again.`);
  const order = await tx<Data<{ id?: string }>>(cfg, 'POST', '/number_orders', { phone_numbers: [{ phone_number: phone }], connection_id: connectionId, customer_reference: label });
  return { phone, orderId: String(order.data?.id ?? '') };
}

/** The Telnyx id of a number we own, or null while the order is still settling. */
export async function numberId(cfg: TelnyxCfg, phone: string): Promise<string | null> {
  const r = await tx<Data<{ id?: string }[]>>(cfg, 'GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(phone)}`);
  return String(r.data?.[0]?.id ?? '') || null;
}

/** Put the number on the agents' connection and name it (customer reference = the label). */
export async function tagNumber(cfg: TelnyxCfg, id: string, connectionId: string | null, label: string): Promise<void> {
  await tx(cfg, 'PATCH', `/phone_numbers/${encodeURIComponent(id)}`, { ...(connectionId ? { connection_id: connectionId } : {}), customer_reference: label });
}

/** The ElevenLabs id of a number already imported, or null. */
export async function findEleven(el: ElConfig, phone: string): Promise<string | null> {
  const list = await elJson<unknown>(el, 'GET', '/v1/convai/phone-numbers');
  const rows = (Array.isArray(list) ? list : ((list as { phone_numbers?: unknown[] })?.phone_numbers ?? [])) as { phone_number?: string; phone_number_id?: string }[];
  const key = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-10);
  return rows.find((r) => key(r.phone_number) === key(phone))?.phone_number_id ?? null;
}

/**
 * Import the number into ElevenLabs, or adopt it when it is there already (a
 * run that imported it and stopped before saving the id): then it is put on
 * the agent and named like a fresh import.
 */
export async function importToEleven(el: ElConfig, phone: string, label: string, agentId: string | null, creds: { username: string; password: string } | null): Promise<string> {
  try {
    const r = await elJson<{ phone_number_id?: string }>(el, 'POST', '/v1/convai/phone-numbers', elImportBody(phone, label, agentId, creds));
    const id = String(r.phone_number_id ?? '');
    if (!id) throw new Error('ElevenLabs did not return the phone number id');
    return id;
  } catch (e) {
    if (!/already exists/i.test(e instanceof Error ? e.message : '')) throw e;
    const id = await findEleven(el, phone);
    if (!id) throw e;
    await updateEleven(el, id, { label, ...(agentId ? { agent_id: agentId } : {}) });
    return id;
  }
}

/** Assign (or rename) a line in ElevenLabs. */
export async function updateEleven(el: ElConfig, phoneNumberId: string, patch: { agent_id?: string; label?: string }): Promise<void> {
  await elJson(el, 'PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, patch);
}
