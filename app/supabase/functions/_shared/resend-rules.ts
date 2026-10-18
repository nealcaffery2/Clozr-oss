/**
 * Pure Resend helpers (no Deno, no network). Shared by the edge transport
 * and the Node test runner so tsc can typecheck the parse / verify path.
 */
export type ResendFrom = { from: string; email: string; name: string | null; domain: string };

const ADDR = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$|^([^\s<>]+@[^\s<>]+)$/;
const domainOf = (email: string) => (email.split('@')[1] ?? '').trim().toLowerCase();
const FREEISH = (email: string) => {
  const d = domainOf(email);
  return !d || ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'].includes(d);
};

export function parseFrom(raw: string | null | undefined): ResendFrom | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = ADDR.exec(s);
  if (!m) return null;
  const email = (m[2] || m[3] || '').trim().toLowerCase();
  if (!email.includes('@') || FREEISH(email)) return null;
  const name = (m[1] ?? '').trim().replace(/[\r\n<>"]/g, '') || null;
  return { from: name ? `${name} <${email}>` : email, email, name, domain: domainOf(email) };
}

export type EnvLike = { get: (k: string) => string | undefined };

/**
 * The Resend env one workspace sends with. Its own key and blast sender
 * (deliverability_secrets.resend_key, workspaces.settings.blast_from) win;
 * the project's RESEND_API_KEY and MAIL_FROM_BLASTS / MAIL_FROM fill in only
 * what the workspace has not set. A workspace with its own key but no sender
 * gets no project sender either: the project's domain is not verified on
 * that workspace's Resend account, so blasts stay off until it sets one.
 */
export function workspaceResendEnv(base: EnvLike, own: { key?: string | null; from?: string | null }): EnvLike {
  const key = (own.key ?? '').trim();
  const from = parseFrom(own.from)?.from ?? '';
  return {
    get(k: string) {
      if (k === 'RESEND_API_KEY') return key || base.get(k);
      if (k === 'MAIL_FROM_BLASTS' || k === 'MAIL_FROM') return from || (key ? '' : base.get(k));
      return base.get(k);
    },
  };
}

/** A sending subdomain to suggest for a company domain: deals.<root>. Null for a free mailbox or no domain. */
export function suggestBlastFrom(company: string | null | undefined, domain: string | null | undefined): string | null {
  const d = String(domain ?? '').trim().toLowerCase().replace(/^.*@/, '');
  if (!d || FREEISH(`x@${d}`)) return null;
  const root = d.startsWith('deals.') ? d.slice(6) : d;
  const name = String(company ?? '').replace(/[\r\n<>"]/g, '').trim();
  return name ? `${name} <deals@deals.${root}>` : `deals@deals.${root}`;
}

/** Resend refuses the whole send (422) when a tag name or value has anything but ASCII letters, digits, _ or -. */
export function resendTags(tags: Record<string, string>): Array<{ name: string; value: string }> {
  const clean = (s: string) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 256);
  return Object.entries(tags)
    .map(([name, value]) => ({ name: clean(name), value: clean(value) || 'none' }))
    .filter((t) => t.name);
}

export type ResendEventKind = 'hard_bounce' | 'complaint' | 'delivered' | 'ignored';

export function classifyResendEvent(type: string, bounceType?: string | null): ResendEventKind {
  const t = type.toLowerCase();
  if (t === 'email.complained' || t === 'email.received.spam') return 'complaint';
  if (t === 'email.delivered') return 'delivered';
  if (t === 'email.bounced' || t === 'email.failed') {
    const b = (bounceType ?? '').toLowerCase();
    if (b === 'transient' || b === 'temporary') return 'ignored';
    return 'hard_bounce';
  }
  return 'ignored';
}

/**
 * Svix-style verify (Resend webhooks). Secret is `whsec_…`; signatures are
 * `v1,<base64>` in svix-signature. Timing-safe compare of the first matching v1.
 */
export async function verifyResendWebhook(raw: string, headers: { id: string; timestamp: string; signature: string }, secret: string): Promise<boolean> {
  const s = secret.trim();
  if (!s || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const payload = `${headers.id}.${headers.timestamp}.${raw}`;
  const bytes = s.startsWith('whsec_') ? Uint8Array.from(atob(s.slice(6)), (c) => c.charCodeAt(0)) : new TextEncoder().encode(s);
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const want = btoa(String.fromCharCode(...mac));
  for (const part of headers.signature.split(/\s+/)) {
    const [ver, sig] = part.split(',', 2);
    if (ver !== 'v1' || !sig) continue;
    if (sig.length === want.length && timingEqual(sig, want)) return true;
  }
  return false;
}

function timingEqual(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * GET /domains/:id. These are the keys React error #31 names when the whole
 * resource is rendered: object, id, name, created_at, status, capabilities,
 * records, region.
 */
export function isResendDomain(value: unknown): boolean {
  if (!isPlain(value) || typeof value.name !== 'string') return false;
  return value.object === 'domain' || 'region' in value || 'capabilities' in value || 'records' in value;
}

/**
 * Always a string. A Resend domain contributes only its name, status and
 * region. Any other object becomes ''. An array is joined into one string,
 * so the result can never be rendered as an object or array child.
 */
export function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  if (isPlain(value) && isResendDomain(value)) return [textValue(value.name), textValue(value.status), textValue(value.region)].filter(Boolean).join(' · ');
  return '';
}

export type ResendDomainFields = { name: string; status: string; region: string };

/** Name, status and region, whether `domain` is the hostname or the API object. */
export function resendDomainFields(domain: unknown, status?: unknown, region?: unknown): ResendDomainFields {
  if (isPlain(domain) && isResendDomain(domain)) {
    return {
      name: textValue(domain.name),
      status: textValue(domain.status) || textValue(status),
      region: textValue(domain.region) || textValue(region),
    };
  }
  return { name: textValue(domain), status: textValue(status), region: textValue(region) };
}

export type ResendRecordFields = { type: string; name: string; value: string; ttl?: string; status?: string; priority?: number };

/** One DNS row, strings only. A domain object is not a row. */
export function resendRecordFields(record: unknown): ResendRecordFields | null {
  if (!isPlain(record) || isResendDomain(record)) return null;
  const type = textValue(record.type);
  const name = textValue(record.name);
  const value = textValue(record.value);
  if (!type && !name && !value) return null;
  const ttl = textValue(record.ttl);
  const rowStatus = textValue(record.status);
  const priority = typeof record.priority === 'number' && Number.isFinite(record.priority) ? record.priority : undefined;
  return { type, name, value, ...(ttl ? { ttl } : {}), ...(rowStatus ? { status: rowStatus } : {}), ...(priority != null ? { priority } : {}) };
}

/** What Settings may keep from a connect/verify response. Never the raw domain object. */
export function resendConnectPayload(added: unknown, fallbackName: string): { domain: string; status: string | null; region: string | null; records: ResendRecordFields[] } {
  const raw = isPlain(added) ? added : {};
  const fields = resendDomainFields(added, raw.status, raw.region);
  const records = (Array.isArray(raw.records) ? raw.records : []).flatMap((rec) => {
    const row = resendRecordFields(rec);
    return row ? [row] : [];
  });
  return {
    domain: fields.name || textValue(fallbackName),
    status: fields.status || null,
    region: fields.region || null,
    records,
  };
}
