/**
 * How a pool mailbox actually sends and how its inbox is read.
 *
 * Google reuses the Gmail send already in google.ts. Microsoft Graph and
 * SMTP/IMAP are here. Nothing in this file is called by tests; the decisions
 * live in cold-campaign.ts.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { normalizeMailboxPassword } from './cold-campaign.ts';
import { SCOPE, clientId, messageIdOf, rawMessage, renew, seal, sendMail, textToHtml, unseal, whoami } from './google.ts';

type Any = any;

export type Outbound = {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  inReplyTo?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  /** Graph has one body. Plain text is the Primary-inbox default. Gmail and SMTP stay multipart. */
  plainText?: boolean;
  headers?: Record<string, string>;
};

export type Sent = { providerId: string; rfcMessageId: string | null; threadId: string | null };

export type Polled = {
  providerId: string;
  from: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  receivedAt: string;
  headers?: Record<string, string>;
  labels?: string[];
  folder?: string | null;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export const POOL_GOOGLE_SCOPES = [...SCOPE.id, SCOPE.gmailSend, SCOPE.gmailRead];

export function poolGoogleRedirect(): string {
  return `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')}/functions/v1/cold-pool/callback`;
}

export function poolMicrosoftRedirect(): string {
  return `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')}/functions/v1/cold-pool/microsoft`;
}

export function googleConfigured(): boolean {
  return Boolean(clientId() && (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim());
}

export function microsoftConfigured(): boolean {
  return Boolean((Deno.env.get('MICROSOFT_CLIENT_ID') ?? '').trim() && (Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? '').trim());
}

export function googleConsentUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: poolGoogleRedirect(),
    response_type: 'code',
    scope: POOL_GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function microsoftConsentUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: (Deno.env.get('MICROSOFT_CLIENT_ID') ?? '').trim(),
    redirect_uri: poolMicrosoftRedirect(),
    response_type: 'code',
    response_mode: 'query',
    scope: 'offline_access openid profile email https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
    prompt: 'consent',
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${q}`;
}

async function googleToken(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim(),
      ...form,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error_description ?? body.error ?? res.status));
  return body;
}

export const exchangeGoogle = (code: string) => googleToken({ code, redirect_uri: poolGoogleRedirect(), grant_type: 'authorization_code' });

async function microsoftToken(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: (Deno.env.get('MICROSOFT_CLIENT_ID') ?? '').trim(),
      client_secret: (Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? '').trim(),
      ...form,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error_description ?? body.error ?? res.status));
  return body;
}

export const exchangeMicrosoft = (code: string) => microsoftToken({ code, redirect_uri: poolMicrosoftRedirect(), grant_type: 'authorization_code' });

export async function sealSecrets(patch: { smtp?: string; imap?: string; refresh?: string; access?: string; expires?: string | null }): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (patch.smtp != null) out.smtp_password = patch.smtp ? await seal(patch.smtp) : null;
  if (patch.imap != null) out.imap_password = patch.imap ? await seal(patch.imap) : null;
  if (patch.refresh != null) out.refresh_token = patch.refresh ? await seal(patch.refresh) : null;
  if (patch.access != null) out.access_token = patch.access ? await seal(patch.access) : null;
  if (patch.expires !== undefined) out.access_expires_at = patch.expires;
  return out;
}

async function secretRow(admin: SupabaseClient, mailboxId: number): Promise<Any | null> {
  const { data } = await admin.from('cold_mailbox_secrets').select('refresh_token, access_token, access_expires_at, smtp_password, imap_password').eq('mailbox_id', mailboxId).maybeSingle();
  return data;
}

/** A live access token for a Google or Microsoft pool mailbox. */
export async function poolAccess(admin: SupabaseClient, mailbox: { id: number; provider: string }): Promise<string | null> {
  const row = await secretRow(admin, mailbox.id);
  if (!row?.refresh_token && !row?.access_token) return null;
  if (row.access_token && row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now() + 60_000) {
    return await unseal(row.access_token).catch(() => null);
  }
  const refresh = row.refresh_token ? await unseal(row.refresh_token).catch(() => null) : null;
  if (!refresh) return row.access_token ? await unseal(row.access_token).catch(() => null) : null;
  try {
    const t = mailbox.provider === 'microsoft_oauth'
      ? await microsoftToken({ refresh_token: refresh, grant_type: 'refresh_token' })
      : await renew(refresh);
    const sealed = await sealSecrets({
      access: t.access_token,
      refresh: t.refresh_token || undefined,
      expires: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    });
    await admin.from('cold_mailbox_secrets').update(sealed).eq('mailbox_id', mailbox.id);
    return t.access_token;
  } catch (err) {
    console.error('pool token refresh failed', mailbox.id, String(err));
    await admin.from('cold_mailboxes').update({ status: 'error', last_error: 'The mailbox needs to be connected again.' }).eq('id', mailbox.id);
    return null;
  }
}

export async function sendPool(admin: SupabaseClient, mailbox: Any, msg: Outbound): Promise<Sent> {
  if (mailbox.provider === 'google_oauth') {
    const token = await poolAccess(admin, mailbox);
    if (!token) throw new Error('Google is not connected for this mailbox.');
    const sent = await sendMail(token, {
      from: msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from,
      to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
      inReplyTo: msg.inReplyTo, threadId: msg.threadId,
      headers: { ...(msg.messageId ? { 'Message-ID': msg.messageId } : {}), ...(msg.headers ?? {}) },
    });
    if (!sent) throw new Error('Gmail refused the send.');
    const rfc = (await messageIdOf(token, sent.id)) ?? msg.messageId ?? null;
    return { providerId: sent.id, rfcMessageId: rfc, threadId: sent.threadId };
  }
  if (mailbox.provider === 'microsoft_oauth') {
    const token = await poolAccess(admin, mailbox);
    if (!token) throw new Error('Microsoft is not connected for this mailbox.');
    return sendGraph(token, msg);
  }
  return sendSmtp(admin, mailbox, msg);
}

async function sendGraph(token: string, msg: Outbound): Promise<Sent> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: msg.plainText !== false && msg.text
          ? { contentType: 'Text', content: msg.text }
          : { contentType: 'HTML', content: msg.html },
        toRecipients: [{ emailAddress: { address: msg.to } }],
        from: { emailAddress: { address: msg.from, name: msg.fromName ?? undefined } },
        internetMessageId: msg.messageId ?? undefined,
        replyTo: [{ emailAddress: { address: msg.from } }],
        internetMessageHeaders: graphHeaders(msg),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microsoft Graph refused the send (${res.status}): ${body.slice(0, 180)}`);
  }
  return { providerId: msg.messageId ?? `graph:${crypto.randomUUID()}`, rfcMessageId: msg.messageId ?? null, threadId: null };
}

/**
 * Graph sendMail rejects In-Reply-To, References, and List-Unsubscribe in
 * internetMessageHeaders. Those are set on the Gmail and SMTP raw message.
 * A follow-up still uses a Re: subject. The unsubscribe link stays in the body.
 */
function graphHeaders(msg: Outbound): { name: string; value: string }[] | undefined {
  const out = Object.entries(msg.headers ?? {})
    .filter(([name, value]) => !!value && /^x-[A-Za-z0-9-]+$/i.test(name))
    .map(([name, value]) => ({ name, value: value.replace(/[\r\n]+/g, ' ').slice(0, 500) }));
  return out.length ? out : undefined;
}

async function sendSmtp(admin: SupabaseClient, mailbox: Any, msg: Outbound): Promise<Sent> {
  const row = await secretRow(admin, mailbox.id);
  const password = row?.smtp_password ? await unseal(row.smtp_password).catch(() => null) : null;
  if (!mailbox.smtp_host || !password) throw new Error('SMTP host or password is missing.');
  const rfc = msg.messageId ?? `<cold.${crypto.randomUUID()}@${String(msg.from).split('@')[1] ?? 'localhost'}>`;
  const raw = rawMessage({
    from: msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from,
    to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
    inReplyTo: msg.inReplyTo,
    headers: { 'Message-ID': rfc, ...(msg.headers ?? {}) },
  });
  await smtpData({
    host: mailbox.smtp_host,
    port: Number(mailbox.smtp_port) || 587,
    username: mailbox.smtp_username || msg.from,
    password: normalizeMailboxPassword(password),
    from: msg.from,
    to: msg.to,
    raw,
  });
  return { providerId: rfc, rfcMessageId: rfc, threadId: null };
}

export async function pollPool(admin: SupabaseClient, mailbox: Any): Promise<Polled[]> {
  if (mailbox.provider === 'google_oauth') {
    const token = await poolAccess(admin, mailbox);
    if (!token) return [];
    return pollGmail(token);
  }
  if (mailbox.provider === 'microsoft_oauth') {
    const token = await poolAccess(admin, mailbox);
    if (!token) return [];
    return pollGraph(token);
  }
  const row = await secretRow(admin, mailbox.id);
  const password = row?.imap_password ? await unseal(row.imap_password).catch(() => null) : null;
  if (!mailbox.imap_host || !password) return [];
  return pollImap({
    host: mailbox.imap_host,
    port: Number(mailbox.imap_port) || 993,
    username: mailbox.imap_username || mailbox.email,
    password: normalizeMailboxPassword(password),
  });
}

async function pollGmail(token: string): Promise<Polled[]> {
  const auth = { Authorization: `Bearer ${token}` };
  const labelsRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: auth });
  const labelNames = new Map<string, string>();
  if (labelsRes.ok) {
    const listed = await labelsRes.json() as { labels?: { id: string; name: string }[] };
    for (const label of listed.labels ?? []) labelNames.set(label.id, label.name);
  }
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=${encodeURIComponent('in:inbox newer_than:7d')}`, { headers: auth });
  if (!list.ok) throw new Error(`Gmail list failed (${list.status})`);
  const body = await list.json() as { messages?: { id: string }[] };
  const out: Polled[] = [];
  for (const m of body.messages ?? []) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth });
    if (!res.ok) continue;
    const msg = await res.json() as Any;
    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) headers[String(h.name).toLowerCase()] = String(h.value ?? '');
    const labels = ((msg.labelIds ?? []) as string[]).map((id) => labelNames.get(id) ?? id);
    out.push({
      providerId: String(msg.id),
      from: addressOf(headers.from ?? ''),
      subject: headers.subject ?? '',
      body: gmailText(msg.payload) || String(msg.snippet ?? ''),
      inReplyTo: headers['in-reply-to'] ?? null,
      receivedAt: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
      headers,
      labels,
      folder: 'inbox',
    });
  }
  return out;
}

function gmailText(payload: Any): string {
  const chunks: string[] = [];
  const walk = (part: Any) => {
    if (!part) return;
    const data = part.body?.data;
    const mime = String(part.mimeType ?? '');
    if (typeof data === 'string' && (mime.startsWith('text/') || !part.parts)) {
      try { chunks.push(dec.decode(b64url(data))); } catch { /* a part we cannot read is skipped */ }
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return chunks.join('\n').slice(0, 8000);
}

function b64url(data: string): Uint8Array {
  const pad = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pollGraph(token: string): Promise<Polled[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=15&$select=id,from,subject,bodyPreview,body,receivedDateTime,internetMessageHeaders&$filter=receivedDateTime ge ${since}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph inbox failed (${res.status})`);
  const body = await res.json() as Any;
  return ((body.value ?? []) as Any[]).map((m) => {
    const headers: Record<string, string> = {};
    for (const h of (m.internetMessageHeaders ?? []) as Any[]) headers[String(h.name).toLowerCase()] = String(h.value ?? '');
    const text = String(m.body?.content ?? m.bodyPreview ?? '');
    return {
      providerId: String(m.id),
      from: String(m.from?.emailAddress?.address ?? ''),
      subject: String(m.subject ?? ''),
      body: text.slice(0, 8000),
      inReplyTo: headers['in-reply-to'] ?? null,
      receivedAt: String(m.receivedDateTime ?? new Date().toISOString()),
      headers,
      folder: 'inbox',
    };
  });
}

export async function microsoftProfile(token: string): Promise<{ email: string | null; name: string | null }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { email: null, name: null };
  const b = await res.json() as Any;
  return { email: String(b.mail || b.userPrincipalName || '').toLowerCase() || null, name: b.displayName ?? null };
}

export { whoami, textToHtml };

function addressOf(from: string): string {
  const hit = /<([^>]+)>/.exec(from);
  return (hit?.[1] ?? from).trim().toLowerCase();
}

// ---------------------------------------------------------------- SMTP/IMAP
type Sock = Deno.Conn;

async function openMail(host: string, port: number): Promise<Sock> {
  if (port === 465 || port === 993) return await Deno.connectTls({ hostname: host, port });
  return await Deno.connect({ hostname: host, port });
}

async function readSome(conn: Sock, ms = 8000): Promise<string> {
  const buf = new Uint8Array(64_000);
  const timer = setTimeout(() => { try { conn.close(); } catch { /* already closed */ } }, ms);
  try {
    const n = await conn.read(buf);
    return n == null ? '' : dec.decode(buf.subarray(0, n));
  } finally {
    clearTimeout(timer);
  }
}

async function smtpData(opts: { host: string; port: number; username: string; password: string; from: string; to: string; raw: string }): Promise<void> {
  const conn = await openMail(opts.host, opts.port);
  // After STARTTLS, Deno.startTls owns `conn`. Close the socket we are
  // actually writing on, which is the TLS one once the upgrade succeeds.
  let active: Sock = conn;
  const say = (sock: Sock) => async (line: string) => {
    await sock.write(enc.encode(line + '\r\n'));
    return await readSmtp(sock);
  };
  try {
    const greet = await readSmtp(conn);
    if (!greet.startsWith('2')) throw new Error(`SMTP greeting: ${greet.slice(0, 120)}`);
    let hello = await say(conn)('EHLO clozr');
    const implicitTls = opts.port === 465;
    if (!implicitTls && /STARTTLS/i.test(hello)) {
      const tls = await say(conn)('STARTTLS');
      if (!tls.startsWith('2')) throw new Error('SMTP STARTTLS was refused.');
      const secure = await Deno.startTls(conn, { hostname: opts.host });
      active = secure;
      await secure.write(enc.encode('EHLO clozr\r\n'));
      hello = await readSmtp(secure);
      await smtpAuth(secure, opts, hello);
      return;
    }
    await smtpAuth(conn, opts, hello);
  } finally {
    try { active.close(); } catch { /* closed by the reader timeout or the server */ }
  }
}

async function readSmtp(conn: Sock): Promise<string> {
  let acc = '';
  for (let i = 0; i < 6; i++) {
    const chunk = await readSome(conn, i === 0 ? 8000 : 1500);
    acc += chunk;
    const lines = acc.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    if (/^\d{3} /.test(last) || !chunk) break;
  }
  return acc;
}

async function smtpAuth(conn: Sock, opts: { username: string; password: string; from: string; to: string; raw: string }, _hello: string): Promise<void> {
  const say = async (line: string) => {
    await conn.write(enc.encode(line + '\r\n'));
    return await readSmtp(conn);
  };
  const user = btoa(opts.username);
  const pass = btoa(normalizeMailboxPassword(opts.password));
  const auth = await say('AUTH LOGIN');
  if (!auth.startsWith('3')) throw new Error(`SMTP AUTH: ${auth.slice(0, 120)}`);
  const u = await say(user);
  if (!u.startsWith('3')) throw new Error('SMTP rejected the username.');
  const p = await say(pass);
  if (!p.startsWith('2')) throw new Error('SMTP rejected the password.');
  const from = await say(`MAIL FROM:<${opts.from}>`);
  if (!from.startsWith('2')) throw new Error(`SMTP MAIL FROM: ${from.slice(0, 120)}`);
  const rcpt = await say(`RCPT TO:<${opts.to}>`);
  if (!rcpt.startsWith('2')) throw new Error(`SMTP RCPT TO: ${rcpt.slice(0, 120)}`);
  const data = await say('DATA');
  if (!data.startsWith('3')) throw new Error('SMTP DATA was refused.');
  const stuffed = opts.raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  await conn.write(enc.encode(stuffed + '\r\n.\r\n'));
    const done = await readSmtp(conn);
  if (!done.startsWith('2')) throw new Error(`SMTP data: ${done.slice(0, 160)}`);
  await say('QUIT');
}

async function pollImap(opts: { host: string; port: number; username: string; password: string }): Promise<Polled[]> {
  const conn = await openMail(opts.host, opts.port);
  let n = 0;
  const tag = () => `C${++n}`;
  const cmd = async (line: string) => {
    const t = tag();
    await conn.write(enc.encode(`${t} ${line}\r\n`));
    let acc = '';
    for (let i = 0; i < 8; i++) {
      acc += await readSome(conn, 5000);
      if (acc.includes(`${t} OK`) || acc.includes(`${t} NO`) || acc.includes(`${t} BAD`)) break;
    }
    if (!acc.includes(`${t} OK`)) throw new Error(`IMAP ${line.split(' ')[0]} failed`);
    return acc;
  };
  try {
    await readSome(conn);
    await cmd(`LOGIN ${quoteImap(opts.username)} ${quoteImap(opts.password)}`);
    await cmd('SELECT INBOX');
    const search = await cmd('SEARCH UNSEEN');
    const ids = (search.match(/\* SEARCH([0-9 ]*)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).slice(-15);
    const out: Polled[] = [];
    const gmail = /(?:^|\.)gmail\.com$/i.test(opts.host) || /(?:^|\.)googlemail\.com$/i.test(opts.host);
    let gmailLabels = gmail;
    for (const id of ids) {
      let fetched = '';
      if (gmailLabels) {
        try {
          fetched = await cmd(`FETCH ${id} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.4000> X-GM-LABELS)`);
        } catch {
          gmailLabels = false;
        }
      }
      if (!fetched) fetched = await cmd(`FETCH ${id} (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.4000>)`);
      const headers = headerMap(fetched);
      const from = headers.from || headerValue(fetched, 'from');
      out.push({
        providerId: `imap:${id}:${headers['message-id'] || headerValue(fetched, 'message-id') || id}`,
        from: addressOf(from),
        subject: headers.subject || headerValue(fetched, 'subject'),
        body: imapText(fetched),
        inReplyTo: headers['in-reply-to'] || headerValue(fetched, 'in-reply-to') || null,
        receivedAt: new Date().toISOString(),
        headers,
        labels: gmailLabelsOf(fetched),
        folder: 'INBOX',
      });
    }
    await cmd('LOGOUT').catch(() => '');
    return out;
  } finally {
    try { conn.close(); } catch { /* already closed */ }
  }
}

function quoteImap(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function headerValue(raw: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  return (re.exec(raw)?.[1] ?? '').trim();
}

function headerMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const hit = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (hit) out[hit[1].toLowerCase()] = hit[2].trim();
  }
  return out;
}

function imapText(raw: string): string {
  const hit = /BODY\[TEXT\](?:<0>)?\s*\{(\d+)\}/i.exec(raw);
  if (!hit || hit.index == null) return raw.slice(0, 4000);
  const start = raw.indexOf('\n', hit.index);
  if (start < 0) return '';
  return raw.slice(start + 1, start + 1 + Number(hit[1]));
}

function gmailLabelsOf(raw: string): string[] {
  const hit = /X-GM-LABELS \(([^)]*)\)/i.exec(raw);
  if (!hit) return [];
  const labels: string[] = [];
  const re = /"((?:\\"|[^"])*)"|\\([A-Za-z]+)|([^\s\\]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hit[1]))) {
    const label = (m[1] ?? (m[2] ? `\\${m[2]}` : m[3]) ?? '').replace(/\\"/g, '"');
    if (label) labels.push(label);
  }
  return labels;
}
