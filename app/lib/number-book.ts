// Settings → Numbers: every line the workspace has, merged from the places
// that each know part of it, and sorted into people, company lines and the
// RVM pool.
//
//   rep_phone_numbers (153, 200)  whose line it is in CLOZR (credit), its name, caller ID flag
//   Talkr /v1/numbers             the live phone system: owner, routing, company-line flag
//   Talkr /v1/team/members        each person's Talkr seat and Talkr caller ID (admins only)
//   caller_lines (91, 135)        Free Caller Registry, branded calling, spam, pool
//   number_health (68)            grade, attestation, 10DLC
//   voice_agent_numbers (150)     AI agent lines, kept out of the lists
//
// Pure, so tools/number-book.test.ts covers the merge.

export type BookMember = { user_id: string; full_name: string | null; email: string | null; avatar_url?: string | null; role: string };
export type BookLineRow = { phone_e164: string; user_id: string | null; label: string; is_caller_id?: boolean | null };
export type BookTalkrNumber = {
  id: string; phone_e164: string; label: string | null; status: string; assigned_user_id: string | null; assigned_user_name: string | null;
  is_company_line?: boolean; routing_mode?: string; flow_steps?: string[]; standby?: boolean; route_callbacks_to_last_contact?: boolean;
  forward_to_e164?: string | null; capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
};
export type BookTalkrMember = {
  id: string; email: string; display_name: string; status: string; default_phone_number_id: string | null;
  personal_phone_e164?: string | null; voicemail_greeting?: { tts: string } | { audio_url: string } | null;
};
export type BookCallerLine = {
  phone_e164: string; pool: string | null; fcr_status: string | null; reputation_enrolled: boolean | null; branded_attached: boolean | null;
  spam_risk: string | null; market_state?: string | null;
};
export type BookHealth = {
  phone_e164: string; talkr_number_id: string; grade: string | null; paused: boolean | null; spam_risk: string | null;
  attestation_a_7d: number | null; attestation_calls_7d: number | null; ten_dlc_assigned: boolean | null; ten_dlc_status: string | null;
  campaign_approved: boolean | null; checked_at: string | null;
};

export type BookLine = {
  phone: string;
  label: string;
  /** CLOZR owner: who calls and texts on it are credited to. Null = company line. */
  ownerId: string | null;
  /** The owner by Talkr's assignment, as a CLOZR user, when it says someone else. */
  talkrOwnerId: string | null;
  /** Talkr's assignment disagrees with CLOZR's. */
  mismatch: boolean;
  /** The CLOZR owner has left the workspace. */
  formerOwner: boolean;
  callerId: boolean;
  talkr: BookTalkrNumber | null;
  row: BookLineRow | null;
  caller: BookCallerLine | null;
  health: BookHealth | null;
};
export type BookPerson = { member: BookMember; talkr: BookTalkrMember | null; lines: BookLine[]; callerId: string | null };
export type NumberBook = { people: BookPerson[]; company: BookLine[]; pool: BookLine[]; agentLines: number };

export type BookInput = {
  team: BookMember[];
  rows: BookLineRow[];
  talkrNumbers: BookTalkrNumber[];
  /** Admins see the whole roster; reps only themselves (`me`). */
  talkrMembers: BookTalkrMember[];
  me?: { userId: string; talkrId: string | null; defaultNumberId: string | null } | null;
  callerLines: BookCallerLine[];
  health: BookHealth[];
  agentPhones: string[];
};

/** +1 and ten digits, or null. */
export function e164(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

const lower = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

export function buildNumberBook(input: BookInput): NumberBook {
  const members = input.team.filter((m) => m.role !== 'notary');
  const memberIds = new Set(input.team.map((m) => m.user_id));
  const byEmail = new Map(members.filter((m) => m.email).map((m) => [lower(m.email), m]));
  const talkrByUser = new Map<string, BookTalkrMember>();
  const userByTalkr = new Map<string, string>();
  for (const t of input.talkrMembers) {
    let m = byEmail.get(lower(t.email));
    // Same person, different mailbox on CLOZR vs Talkr — match a unique name.
    if (!m && t.display_name) {
      const hits = members.filter((x) => lower(x.full_name) === lower(t.display_name));
      if (hits.length === 1) m = hits[0];
    }
    if (!m) continue;
    talkrByUser.set(m.user_id, t);
    userByTalkr.set(t.id, m.user_id);
  }
  if (input.me?.talkrId) userByTalkr.set(input.me.talkrId, input.me.userId);

  /** A Talkr owner as a CLOZR user: by roster, else by a unique display name. */
  const talkrOwner = (n: BookTalkrNumber): string | null => {
    if (!n.assigned_user_id) return null;
    const known = userByTalkr.get(n.assigned_user_id);
    if (known) return known;
    const hits = members.filter((m) => n.assigned_user_name && lower(m.full_name) === lower(n.assigned_user_name));
    return hits.length === 1 ? hits[0]!.user_id : null;
  };

  const phones = new Map<string, { row: BookLineRow | null; talkr: BookTalkrNumber | null }>();
  const slot = (p: string) => phones.get(p) ?? phones.set(p, { row: null, talkr: null }).get(p)!;
  for (const r of input.rows) {
    const p = e164(r.phone_e164);
    if (p) slot(p).row = r;
  }
  for (const n of input.talkrNumbers) {
    const p = e164(n.phone_e164);
    if (p && (n.status === 'active' || !n.status)) slot(p).talkr = n;
  }
  const callerBy = new Map(input.callerLines.map((c) => [e164(c.phone_e164), c]));
  const healthBy = new Map(input.health.map((h) => [e164(h.phone_e164), h]));
  const agents = new Set(input.agentPhones.map(e164).filter(Boolean));

  const all: BookLine[] = [];
  let agentLines = 0;
  for (const [phone, { row, talkr }] of phones) {
    if (agents.has(phone)) { agentLines++; continue; }
    const fromTalkr = talkr ? talkrOwner(talkr) : null;
    const rowOwner = row?.user_id ?? null;
    const formerOwner = !!rowOwner && !memberIds.has(rowOwner);
    const ownerId = row ? (formerOwner ? null : rowOwner) : fromTalkr;
    all.push({
      phone,
      label: row?.label || talkr?.label || '',
      ownerId,
      talkrOwnerId: fromTalkr,
      mismatch: !!row && !!talkr && !!talkr.assigned_user_id && fromTalkr !== ownerId,
      formerOwner,
      callerId: false,
      talkr,
      row,
      caller: callerBy.get(phone) ?? null,
      health: healthBy.get(phone) ?? null,
    });
  }

  const pool = all.filter((l) => l.caller?.pool === 'rvm');
  const rest = all.filter((l) => l.caller?.pool !== 'rvm');

  const people: BookPerson[] = members.map((m) => {
    const lines = rest.filter((l) => l.ownerId === m.user_id);
    const flagged = lines.find((l) => l.row?.is_caller_id);
    const talkrSeat = talkrByUser.get(m.user_id) ?? null;
    const talkrDefault = talkrSeat?.default_phone_number_id ?? (input.me?.userId === m.user_id ? input.me.defaultNumberId : null);
    const viaTalkr = lines.find((l) => l.talkr && l.talkr.id === talkrDefault);
    const pick = flagged ?? viaTalkr ?? null;
    for (const l of lines) l.callerId = l === pick;
    lines.sort((a, b) => Number(b.callerId) - Number(a.callerId) || a.label.localeCompare(b.label) || a.phone.localeCompare(b.phone));
    return { member: m, talkr: talkrSeat, lines, callerId: pick?.phone ?? null };
  }).sort((a, b) => lower(a.member.full_name || a.member.email).localeCompare(lower(b.member.full_name || b.member.email)));

  const company = rest
    .filter((l) => !l.ownerId || !members.some((m) => m.user_id === l.ownerId))
    .sort((a, b) => Number(!!b.talkr?.is_company_line) - Number(!!a.talkr?.is_company_line) || a.label.localeCompare(b.label) || a.phone.localeCompare(b.phone));

  return { people, company, pool, agentLines };
}

/** People who own several lines and have not picked a caller ID: the cleanup list. */
export function needsCallerId(book: NumberBook): BookPerson[] {
  return book.people.filter((p) => p.lines.length > 1 && !p.lines.some((l) => l.row?.is_caller_id));
}
