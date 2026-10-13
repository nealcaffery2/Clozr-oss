/**
 * Outreach Talkr cannot see for itself, told to Talkr so an inbound call can
 * ring the rep who last reached out (Talkr's `last_contact` ring target and a
 * number's "route callbacks to last contact" setting).
 *
 * Talkr sees its own calls and texts. A ringless drop goes out through
 * Slybroadcast (or Drop Cowboy) and a blast email through Resend or Gmail, so
 * without this a callback from a 1,000-person RVM blast would not know whose
 * blast it was.
 *
 * Talkr's contract (its /v1/outreach):
 *   POST /v1/outreach        one item           → 201 created, 200 duplicate
 *   POST /v1/outreach/batch  bare array, 1–500  → 200 { created, duplicate, rejected, results[] }
 *   item { phone_e164, channel: 'rvm'|'email'|'other', occurred_at (ISO with offset), ref? (≤200, idempotent per org), user_id? }
 *   auth Bearer: the HS256 partner JWT minted FOR the rep who reached out
 *        (TALKR_PARTNER_JWT_SECRET), so user_id is left out; naming another
 *        user needs a manager token.
 *   errors 400 invalid_body/invalid_phone, 403 forbidden_user, 422 unknown_user
 *          (a rep never linked in Talkr). All best effort for CLOZR.
 *
 * The path and shape live here alone. Pure: the Deno sender is
 * supabase/functions/_shared/talkr-outreach.ts.
 */

export const TALKR_OUTREACH = {
  /** One touch. */
  path: '/v1/outreach',
  /** Many touches in one request, as a bare JSON array. */
  batchPath: '/v1/outreach/batch',
  /** Most items per batch request. */
  batchMax: 500,
  /** Longest ref Talkr keeps. */
  refMax: 200,
} as const;

export type OutreachChannel = 'rvm' | 'email' | 'other';

/** What CLOZR tracks per touch; `user_id` picks the token and is not sent. */
export type OutreachItem = {
  phone_e164: string;
  /** The CLOZR user (auth.users id) who reached out. The partner token is minted for them. */
  user_id: string;
  channel: OutreachChannel;
  occurred_at: string;
  /** Back to the CLOZR row: `rvm:<drop id>`, `email:<message id>`. Talkr dedupes on it. */
  ref: string;
};

/** The body Talkr takes for one item: no user_id, since the token already names the rep. */
export type OutreachWire = { phone_e164: string; channel: OutreachChannel; occurred_at: string; ref: string };

function e164(phone: string | null | undefined): string | null {
  const raw = String(phone ?? '').trim();
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** One item, or null when there is no number or no rep to credit. */
export function outreachItem(input: {
  phone: string | null | undefined;
  userId: string | null | undefined;
  channel: OutreachChannel;
  at: string | Date;
  ref: string;
}): OutreachItem | null {
  const phone = e164(input.phone);
  if (!phone || !input.userId) return null;
  const at = typeof input.at === 'string' ? new Date(input.at) : input.at;
  if (Number.isNaN(at.getTime())) return null;
  return { phone_e164: phone, user_id: input.userId, channel: input.channel, occurred_at: at.toISOString(), ref: input.ref.slice(0, TALKR_OUTREACH.refMax) };
}

export function toWire(item: OutreachItem): OutreachWire {
  return { phone_e164: item.phone_e164, channel: item.channel, occurred_at: item.occurred_at, ref: item.ref };
}

/**
 * Requests to make for these items, grouped by rep (each request carries that
 * rep's token): one item alone goes to the single endpoint, more go to the
 * batch endpoint as a bare array of at most 500.
 */
export function outreachRequests(items: readonly (OutreachItem | null)[]): { userId: string; path: string; body: OutreachWire | OutreachWire[]; refs: string[] }[] {
  const byUser = new Map<string, OutreachItem[]>();
  for (const it of items) {
    if (!it) continue;
    const list = byUser.get(it.user_id) ?? [];
    if (!list.some((x) => x.ref === it.ref)) list.push(it);
    byUser.set(it.user_id, list);
  }
  const out: { userId: string; path: string; body: OutreachWire | OutreachWire[]; refs: string[] }[] = [];
  for (const [userId, list] of byUser) {
    if (list.length === 1) { out.push({ userId, path: TALKR_OUTREACH.path, body: toWire(list[0]!), refs: [list[0]!.ref] }); continue; }
    for (let i = 0; i < list.length; i += TALKR_OUTREACH.batchMax) {
      const chunk = list.slice(i, i + TALKR_OUTREACH.batchMax);
      out.push({ userId, path: TALKR_OUTREACH.batchPath, body: chunk.map(toWire), refs: chunk.map((x) => x.ref) });
    }
  }
  return out;
}

/** Talkr's error code in words, for the note on the drop. */
export function outreachErrorNote(status: number, code: string | null | undefined): string {
  const c = String(code ?? '');
  if (status === 422 || c === 'unknown_user') return 'Talkr not told: this rep is not linked in Talkr, so a callback rings by the number\'s own routing.';
  if (status === 403 || c === 'forbidden_user') return 'Talkr refused to record this rep\'s outreach (forbidden_user).';
  if (status === 400) return `Talkr rejected the outreach (${c || 'invalid_body'}).`;
  if (status === 401) return 'Talkr did not accept the server token (check TALKR_PARTNER_JWT_SECRET matches Talkr).';
  return `Talkr did not record the outreach (HTTP ${status}${c ? `, ${c}` : ''}).`;
}

/** Per-ref outcome of a batch reply: rejected rows by ref, when Talkr lists them. */
export function batchRejections(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const results = (body as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return out;
  for (const r of results as { ref?: string; status?: string; error?: string; code?: string }[]) {
    const st = String(r?.status ?? '');
    if (r?.ref && (st === 'rejected' || r.error || (st && st !== 'created' && st !== 'duplicate'))) out.set(r.ref, String(r.error ?? r.code ?? st ?? 'rejected'));
  }
  return out;
}
