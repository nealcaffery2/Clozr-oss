/**
 * Resend transport: transactional (signing links) and bulk (dispo blasts).
 *
 * Blasts use MAIL_FROM_BLASTS when set, else MAIL_FROM. That is meant to be
 * a sending subdomain (deals.<company domain>) so a campaign cannot burn the
 * company root or anyone's Gmail. Blasts pass a workspace env
 * (workspace-email.ts resendEnvFor) so each workspace sends with its own key
 * and domain; transactional mail stays on the project env. AgentMail is not
 * on this path.
 */
import { type ResendFrom, parseFrom } from './resend-rules.ts';

export { type EnvLike, type ResendFrom, type ResendEventKind, classifyResendEvent, parseFrom, resendConnectPayload, suggestBlastFrom, verifyResendWebhook, workspaceResendEnv } from './resend-rules.ts';

/** Blasts first, then the transactional from. Null when Resend is not wired. */
export function blastFrom(env: { get: (k: string) => string | undefined } = Deno.env): ResendFrom | null {
  if (!(env.get('RESEND_API_KEY') ?? '').trim()) return null;
  return parseFrom(env.get('MAIL_FROM_BLASTS')) || parseFrom(env.get('MAIL_FROM'));
}

export function transactionalFrom(env: { get: (k: string) => string | undefined } = Deno.env): ResendFrom | null {
  if (!(env.get('RESEND_API_KEY') ?? '').trim()) return null;
  return parseFrom(env.get('MAIL_FROM')) || parseFrom(env.get('MAIL_FROM_BLASTS'));
}

export type ResendSend = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from: string;
  replyTo?: string | null;
  /** Copied on this send. The contracts TC is always here when a contract goes out. */
  cc?: string[];
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  idempotencyKey?: string;
};

export async function sendResend(msg: ResendSend, env: { get: (k: string) => string | undefined } = Deno.env): Promise<{ id: string } | null> {
  const key = (env.get('RESEND_API_KEY') ?? '').trim();
  if (!key) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey.slice(0, 256);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.tags ? { tags: Object.entries(msg.tags).map(([name, value]) => ({ name, value: String(value).slice(0, 256) })) } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) {
    const body = await res?.text().catch(() => '');
    console.error('resend send', res?.status, (body ?? '').slice(0, 400));
    return null;
  }
  const j = await res.json().catch(() => ({})) as { id?: string };
  return j.id ? { id: j.id } : null;
}

export type ResendDnsRecord = { type: string; name: string; value: string; ttl?: string; status?: string; priority?: number };

export type ResendDomain = {
  id: string;
  name: string;
  status: string;
  records: ResendDnsRecord[];
};

export async function resendDomains(env: { get: (k: string) => string | undefined } = Deno.env): Promise<ResendDomain[] | null> {
  const key = (env.get('RESEND_API_KEY') ?? '').trim();
  if (!key) return null;
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = await res.json().catch(() => ({})) as { data?: ResendDomain[] };
  return Array.isArray(j.data) ? j.data : [];
}

/** Null when Resend accepts the key for domain reads (a full access key), else why not. */
export async function resendKeyProblem(key: string): Promise<string | null> {
  const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (!res) return 'Could not reach Resend to check that key.';
  if (res.ok) return null;
  const body = await res.text().catch(() => '');
  if (/restricted/i.test(body)) return 'That key can only send. Create a Full access key in Resend so CLOZR can add and verify the blast domain.';
  return res.status === 401 || res.status === 403 ? 'Resend rejected that API key.' : `Resend did not accept the key (${res.status}).`;
}

export async function ensureResendDomain(name: string, env: { get: (k: string) => string | undefined } = Deno.env): Promise<ResendDomain | { error: string }> {
  const key = (env.get('RESEND_API_KEY') ?? '').trim();
  if (!key) return { error: 'RESEND_API_KEY is not set on the project.' };
  const have = await resendDomains(env);
  const existing = (have ?? []).find((d) => d.name === name);
  if (existing) {
    await fetch(`https://api.resend.com/domains/${existing.id}/verify`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    const fresh = await fetch(`https://api.resend.com/domains/${existing.id}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    if (fresh?.ok) return await fresh.json() as ResendDomain;
    return existing;
  }
  const res = await fetch('https://api.resend.com/domains', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const errBody = res ? await res.clone().text().catch(() => '') : '';
  if (!res?.ok) return { error: errBody.slice(0, 240) || `Resend refused to add ${name} (${res?.status ?? 0}).` };
  return await res.json() as ResendDomain;
}
