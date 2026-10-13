// Who may open a signing link, and what the activity feed says when they do.
//
// The link is not enough. The contract names one email (rlee2014@example.com).
// That inbox has to prove it with a code before the document, the signature,
// or the PDF is returned. View time is measured from the moment the code
// is accepted until they sign, so the feed can say how long they had it open.

export const CODE_TTL_MS = 10 * 60 * 1000;
/** A heartbeat that sat open for an hour is a forgotten tab, not an hour of reading. */
export const MAX_HEARTBEAT_SEC = 30 * 60;

export function normalizeEmail(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** True only when the typed address is the one on the signer row. */
export function emailsMatch(authorized: string | null | undefined, given: unknown): boolean {
  const a = normalizeEmail(authorized);
  const g = normalizeEmail(given);
  return a.length > 0 && a === g;
}

/** "rlee2014@example.com" → "rl•••@example.com". The domain stays so they know which inbox. */
export function maskEmail(email: string): string {
  const [user, host] = normalizeEmail(email).split('@');
  if (!user || !host) return '••••';
  return `${user.slice(0, 2)}•••@${host}`;
}

export function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(100000 + (n % 900000));
}

export function mintGate(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashAccessCode(signerId: number, code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${signerId}:${code.trim()}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function codeFresh(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t > now;
}

/** The document stays locked until this browser holds the gate issued after the code. */
export function gateOk(
  signer: { email?: string | null; access_gate?: string | null; email_verified_at?: string | null },
  gate: unknown,
): boolean {
  if (!normalizeEmail(signer.email)) return false;
  if (!signer.email_verified_at || !signer.access_gate) return false;
  return signer.access_gate === String(gate ?? '');
}

export function addViewSeconds(openAt: string | null | undefined, current: number, now = Date.now()): { view_seconds: number; view_open_at: string } {
  const start = openAt ? Date.parse(openAt) : now;
  const raw = Number.isFinite(start) ? Math.round((now - start) / 1000) : 0;
  const add = Math.max(0, Math.min(MAX_HEARTBEAT_SEC, raw));
  return { view_seconds: Math.max(0, current) + add, view_open_at: new Date(now).toISOString() };
}

/** Seller, buyer, or the company — the word the activity feed leads with. */
export function partyLabel(role: string | null | undefined): string {
  const r = (role ?? '').toLowerCase();
  if (r.startsWith('seller')) return 'Seller';
  if (r.startsWith('buyer')) return 'Buyer';
  if (r === 'company' || r === 'tc') return 'Company';
  if (r === 'notary') return 'Notary';
  return 'Signer';
}

export function formatViewDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${Math.max(1, s)} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} hr ${rem} min` : `${h} hr`;
}

export function formatWhen(iso: string, nowLabel = 'America/Chicago'): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('en-US', {
    timeZone: nowLabel, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function viewedTitle(role: string | null | undefined): string {
  return `${partyLabel(role)} viewed contract`;
}

export function signedTitle(role: string | null | undefined): string {
  return `${partyLabel(role)} signed`;
}

/** The line under the title: who, how long the document was open, and when they signed. */
export function signedBody(p: { name?: string | null; email?: string | null; viewSeconds?: number | null; signedAt: string }): string {
  const who = [p.name, p.email].filter(Boolean).join(' · ');
  const viewed = p.viewSeconds != null ? `viewed ${formatViewDuration(p.viewSeconds)}` : null;
  const when = `signed ${formatWhen(p.signedAt)}`;
  return [who, viewed, when].filter(Boolean).join(' · ');
}

export function viewedBody(p: { name?: string | null; email?: string | null; at: string }): string {
  const who = [p.name, p.email].filter(Boolean).join(' · ');
  return [who, `opened ${formatWhen(p.at)}`].filter(Boolean).join(' · ');
}
