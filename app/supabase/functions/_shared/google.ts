/**
 * Google, without the ceremony.
 *
 * One button, Google's own consent screen, and from then on CLOZR talks to the
 * user's calendar and mailbox on their behalf. Everything secret — the client
 * secret, the refresh token, the access token — stays in here and in the
 * `google_tokens` table, which no browser can read.
 *
 * Project secrets:
 *   GOOGLE_CLIENT_ID       OAuth 2.0 Web application client, from Google Cloud
 *   GOOGLE_CLIENT_SECRET   its secret
 *   GOOGLE_TOKEN_KEY       optional; the passphrase refresh tokens are sealed
 *                          with at rest. Unset, they are sealed with the
 *                          service role key instead, which is always present.
 *   GOOGLE_REDIRECT_URI    optional; the callback on a domain we own, e.g.
 *                          https://clozr.yourcompany.com/oauth/google/callback,
 *                          which vercel.json proxies to the function. Google
 *                          only brands the consent screen for a verified
 *                          domain, and supabase.co can never be one.
 *
 * The authorised redirect URI to register is exactly GOOGLE_REDIRECT_URI, or
 * when unset:
 *   https://<project>.supabase.co/functions/v1/google-oauth/callback
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type DocType, DOC_LABEL, classifyDoc, isJunkAttachment, stageFromDoc } from './deal-docs.ts';
import { type Book, type DealRef, type Link, type Route, addrKey, addressesOf as addressesOfHeader, conversationKey, dealRank, emptyLink, fillable, isLinked, mergeLink, refsOf, repFor, reroute, routeFor, streetKey, threadLink } from './gmail-match.ts';
import { AI_PER_RUN, aiKey, classifyDeal } from './gmail-ai.ts';
import { googleSyncWorkspace } from './google-scope.ts';
import { rateLimit } from './security.ts';
import { type Stranger, classifyStranger, namesOf, titleDomains } from './contact-suggest.ts';

type Any = any;

// ------------------------------------------------------------------- scopes
export const SCOPE = {
  /** Who connected — the address the team sees on the card, and their Google photo for the profile. */
  id: ['openid', 'email', 'profile'],
  /** Full calendar: CLOZR creates its own calendar in the account, not in yours. */
  calendar: 'https://www.googleapis.com/auth/calendar',
  /** Send from the user's own address, so signing links land in the inbox. */
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  /** Read mail with people and deals in the CRM — received and sent — to log it on the record and the deal. */
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  /**
   * Optional, asked for on its own from Settings → Email deliverability
   * ("Connect Postmaster"): Gmail's numbers on domain reputation and spam
   * rate. Not in DEFAULT_SCOPES, so nobody already connected is asked again.
   */
  postmaster: 'https://www.googleapis.com/auth/postmaster.traffic.readonly',
  /**
   * Postmaster Tools v2 lists domains under its own scope; asked for with
   * `postmaster`. v1's postmaster.readonly no longer reads anything, so an
   * account holding only that one is asked to connect Postmaster again.
   */
  postmasterDomains: 'https://www.googleapis.com/auth/postmaster.domain',
  /**
   * Asked for together with Postmaster: lets CLOZR verify the workspace's
   * sending domains for that account (site-verification.ts), so Postmaster
   * can report on them without anyone pasting TXT records.
   */
  siteVerification: 'https://www.googleapis.com/auth/siteverification',
  /**
   * Optional, asked for on its own from Settings → Google ("Connect Drive"):
   * read the team's deals folder so its files and photos land on the deals
   * (drive-photos `tree`). Read-only; not in DEFAULT_SCOPES.
   */
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
} as const;

export const DEFAULT_SCOPES = [...SCOPE.id, SCOPE.calendar, SCOPE.gmailSend, SCOPE.gmailRead];

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
export const clientId = () => env('GOOGLE_CLIENT_ID');
const clientSecret = () => env('GOOGLE_CLIENT_SECRET');
export const configured = () => Boolean(clientId() && clientSecret());

export const redirectUri = () => env('GOOGLE_REDIRECT_URI') || `${env('SUPABASE_URL')}/functions/v1/google-oauth/callback`;

export type Account = {
  id: number; workspace_id: number; user_id: string; email: string; scopes: string[];
  calendar_id: string | null; calendar_sync: boolean; gmail_send: boolean; gmail_read: boolean;
  status: string; sync_token: string | null;
  last_calendar_sync_at: string | null; last_gmail_sync_at: string | null;
  /** The signature set in Gmail for this address (migration 157), HTML; refreshed by a sync once a day. */
  gmail_signature?: string | null;
  gmail_signature_at?: string | null;
};

export const has = (a: Pick<Account, 'scopes'>, scope: string) => (a.scopes ?? []).includes(scope);

// ---------------------------------------------------------------- the dance
/**
 * Google's consent URL. `consent` is what guarantees a refresh token;
 * `select_account` shows the account picker instead of reusing the browser's
 * signed-in account.
 */
export function authUrl(state: string, scopes: string[], loginHint?: string | null): string {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type TokenSet = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

async function token(form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...form }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(body.error ?? res.status)), { google: body.error, status: res.status });
  return body as TokenSet;
}

export const exchange = (code: string) => token({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
export const renew = (refreshToken: string) => token({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function revoke(t: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => null);
}

export async function whoami(accessToken: string): Promise<{ email: string | null; name: string | null; picture: string | null }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { email: null, name: null, picture: null };
  const b = await res.json() as Any;
  // `picture` needs the profile scope; a grant from before it was asked for has none.
  return { email: b.email ?? null, name: b.name ?? null, picture: typeof b.picture === 'string' ? b.picture.replace(/=s\d+-c$/, '=s256-c') : null };
}

// ------------------------------------------------------------------ sealing
// Refresh tokens are long-lived keys to someone's mailbox, so they do not sit
// in the table in the clear. AES-GCM with a key derived from a project secret;
// only code holding that secret can open them, and the database alone cannot.
const enc = new TextEncoder();
const dec = new TextDecoder();
let cached: CryptoKey | null = null;

async function sealKey(): Promise<CryptoKey> {
  if (cached) return cached;
  const secret = env('GOOGLE_TOKEN_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(`clozr.google.v1:${secret}`));
  cached = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cached;
}

// Chunked, because spreading a long byte array into fromCharCode overflows the
// call stack — an HTML email is easily long enough.
function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Not Uint8Array.from(atob(s), fn): that spreads the string into a list first, which for a 20 MB attachment ran the isolate out of memory. */
const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(), enc.encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function unseal(stored: string): Promise<string> {
  if (!stored.startsWith('v1.')) return stored; // written before sealing, or by hand
  const [, iv, ct] = stored.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await sealKey(), unb64(ct));
  return dec.decode(plain);
}

// ------------------------------------------------------------------- tokens
export async function storeTokens(admin: SupabaseClient, accountId: number, t: TokenSet, keepRefresh = true): Promise<void> {
  const patch: Any = {
    account_id: accountId,
    access_token: await seal(t.access_token),
    access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000).toISOString(),
  };
  if (t.refresh_token) patch.refresh_token = await seal(t.refresh_token);
  if (patch.refresh_token || !keepRefresh) await admin.from('google_tokens').upsert(patch, { onConflict: 'account_id' });
  else await admin.from('google_tokens').update(patch).eq('account_id', accountId);
}

/**
 * A live access token for an account, refreshing when the stored one is stale.
 * A grant the user took back at Google comes back as invalid_grant, which is
 * not an error to retry: the connection is marked and the card asks for a
 * reconnect.
 */
export async function accessFor(admin: SupabaseClient, account: Account): Promise<string | null> {
  const { data: row } = await admin.from('google_tokens').select('refresh_token, access_token, access_expires_at').eq('account_id', account.id).maybeSingle();
  if (!row) return null;
  if (row.access_token && row.access_expires_at && new Date(row.access_expires_at) > new Date()) {
    return await unseal(row.access_token).catch(() => null) as string | null;
  }
  const refreshToken = await unseal(row.refresh_token).catch(() => null);
  if (!refreshToken) return null;
  try {
    const t = await renew(refreshToken);
    await storeTokens(admin, account.id, t);
    return t.access_token;
  } catch (err) {
    const code = (err as Any)?.google;
    if (code === 'invalid_grant' || code === 'unauthorized_client') {
      await admin.from('google_accounts').update({ status: 'needs_reauth', last_error: 'Google asked for this connection to be approved again.' }).eq('id', account.id);
    } else {
      console.error('google refresh failed', { account: account.id, err: String(err) });
    }
    return null;
  }
}

// ---------------------------------------------------------------------- api
async function api(accessToken: string, url: string, init: RequestInit = {}): Promise<Any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(String(message)), { status: res.status, reason: body?.error?.errors?.[0]?.reason });
  }
  return body;
}

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ----------------------------------------------------------------- calendar
/**
 * CLOZR gets its own calendar inside the user's account rather than writing
 * into their primary one: it can be hidden, coloured or unsubscribed without
 * touching anything they put there themselves, and "delete the CLOZR calendar"
 * is a clean way out.
 */
export async function ensureCalendar(admin: SupabaseClient, account: Account, accessToken: string, name: string): Promise<string | null> {
  if (account.calendar_id) {
    try {
      await api(accessToken, `${CAL}/calendars/${encodeURIComponent(account.calendar_id)}`);
      return account.calendar_id;
    } catch { /* deleted on their side — make a new one */ }
  }
  const summary = `${name} · CLOZR`;
  const list = await api(accessToken, `${CAL}/users/me/calendarList?maxResults=250&minAccessRole=owner`).catch(() => ({ items: [] }));
  const found = (list.items ?? []).find((c: Any) => c.summary === summary);
  const id = found?.id ?? (await api(accessToken, `${CAL}/calendars`, { method: 'POST', body: JSON.stringify({ summary, description: 'Appointments and due tasks from CLOZR. Edits here flow back to the CRM.' }) })).id;
  if (!id) return null;
  if (!found) {
    await api(accessToken, `${CAL}/users/me/calendarList/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ colorId: '10', selected: true }),
    }).catch(() => null);
  }
  await admin.from('google_accounts').update({ calendar_id: id }).eq('id', account.id);
  account.calendar_id = id;
  return id;
}

// ------------------------------------------------------------------- feeds
/** One calendar this connection reads, with its own cursor. */
export type Feed = {
  calendar_id: string;
  summary: string | null;
  writable: boolean;
  enabled: boolean;
  sync_token: string | null;
};

/**
 * Which calendars to read.
 *
 * Writing and reading were the same calendar until migration 74, so the moment
 * ensureCalendar pointed `calendar_id` at the calendar CLOZR had just made,
 * reads followed it there — and a brand new calendar contains nothing. The
 * member's own meetings were never read, and the sync said so in the only way
 * it could: success, nothing changed.
 *
 * So: the CLOZR calendar stays the one CLOZR writes to, and the member's
 * primary is read alongside it. `primary` is an alias Google resolves
 * per-account, which is why the real id is asked for and stored — an event
 * mirrored from a calendar has to say which calendar, and `'primary'` in that
 * column is exactly the ambiguity the pre-74 rows are stuck in.
 *
 * A feed is only added if it is missing, so a member who turned one off keeps
 * it off.
 */
export async function ensureFeeds(admin: SupabaseClient, account: Account, accessToken: string): Promise<Feed[]> {
  const want: { calendar_id: string; summary: string | null; writable: boolean }[] = [];

  if (account.calendar_id) want.push({ calendar_id: account.calendar_id, summary: null, writable: true });

  // The member's own calendar. A failure here is not fatal: the CLOZR calendar
  // still syncs, and the next run tries again.
  try {
    const me = await api(accessToken, `${CAL}/users/me/calendarList/primary`);
    if (me?.id && me.id !== account.calendar_id) {
      want.push({ calendar_id: String(me.id), summary: me.summary ?? me.summaryOverride ?? null, writable: false });
    }
  } catch (err) {
    console.error('primary calendar lookup failed', { account: account.id, err: String(err) });
  }

  for (const f of want) {
    await admin.from('google_calendar_feeds')
      .upsert({ account_id: account.id, ...f }, { onConflict: 'account_id,calendar_id', ignoreDuplicates: true });
  }

  const { data, error } = await admin.from('google_calendar_feeds')
    .select('calendar_id, summary, writable, enabled, sync_token')
    .eq('account_id', account.id).eq('enabled', true).order('writable', { ascending: false });

  // Migration 74 not applied here yet: fall back to the single calendar, which
  // is what every run did before it. Degraded, not broken.
  if (error) {
    console.error('calendar feeds unavailable', { account: account.id, err: error.message });
    return account.calendar_id
      ? [{ calendar_id: account.calendar_id, summary: null, writable: true, enabled: true, sync_token: account.sync_token }]
      : [];
  }
  return (data ?? []) as Feed[];
}

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();

async function fingerprint(o: unknown): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(o)));
  return Array.from(new Uint8Array(bits)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Ev = { summary: string; description: string; location: string | null; start: string; end: string };

/**
 * CLOZR → Google. Appointments and open dated tasks from the last month
 * forward; a fingerprint of what we last sent means an unchanged row costs
 * nothing, and a row that no longer qualifies takes its event with it.
 */
export async function pushCalendar(admin: SupabaseClient, account: Account, accessToken: string, origin: string): Promise<{ created: number; updated: number; removed: number }> {
  const calendarId = account.calendar_id;
  if (!calendarId) return { created: 0, updated: 0, removed: 0 };
  const ws = googleSyncWorkspace(account);
  const since = iso(new Date(Date.now() - 30 * 24 * HOUR));

  const [{ data: appts }, { data: tasks }, { data: sellers }, { data: links }] = await Promise.all([
    admin.from('appointments').select('id, title, kind, starts_at, ends_at, location, notes, seller_id').eq('workspace_id', ws).gte('starts_at', since),
    admin.from('tasks').select('id, title, task_type, due_at, done, seller_id, deal_id').eq('workspace_id', ws).eq('done', false).not('due_at', 'is', null).gte('due_at', since),
    admin.from('sellers').select('id, name, property_address').eq('workspace_id', ws),
    admin.from('google_event_links').select('id, source, source_id, event_id, pushed').eq('account_id', account.id),
  ]);
  const who = new Map((sellers ?? []).map((s) => [s.id, s]));
  const linkOf = new Map((links ?? []).map((l) => [`${l.source}:${l.source_id}`, l]));

  const want = new Map<string, Ev>();
  for (const a of appts ?? []) {
    const s = a.seller_id ? who.get(a.seller_id) : null;
    want.set(`appointment:${a.id}`, {
      summary: [a.kind && a.kind !== 'Appointment' ? a.kind : '', a.title].filter(Boolean).join(' · ') || 'Appointment',
      description: [s ? `${s.name}${s.property_address ? ' — ' + s.property_address : ''}` : '', a.notes ?? '', `${origin}/clozr/`].filter(Boolean).join('\n\n'),
      location: a.location ?? s?.property_address ?? null,
      start: new Date(a.starts_at).toISOString(),
      end: new Date(a.ends_at ?? new Date(new Date(a.starts_at).getTime() + HOUR)).toISOString(),
    });
  }
  for (const t of tasks ?? []) {
    const s = t.seller_id ? who.get(t.seller_id) : null;
    want.set(`task:${t.id}`, {
      summary: `${t.task_type}: ${t.title}`,
      description: [s ? `${s.name}${s.property_address ? ' — ' + s.property_address : ''}` : 'CLOZR task', `${origin}/clozr/`].join('\n\n'),
      location: null,
      start: new Date(t.due_at!).toISOString(),
      end: new Date(new Date(t.due_at!).getTime() + 30 * 60_000).toISOString(),
    });
  }

  let created = 0, updated = 0, removed = 0;
  for (const [key, ev] of want) {
    const [source, idText] = key.split(':');
    const link = linkOf.get(key);
    const print = await fingerprint(ev);
    if (link && (link.pushed === print || link.pushed === `cancelled:${print}`)) continue;
    const body = {
      summary: ev.summary,
      description: ev.description,
      location: ev.location ?? undefined,
      start: { dateTime: ev.start },
      end: { dateTime: ev.end },
      extendedProperties: { private: { clozr: '1', clozr_source: source, clozr_id: idText, clozr_ws: String(ws) } },
      source: { title: 'Open in CLOZR', url: `${origin}/clozr/` },
    };
    try {
      if (link) {
        await api(accessToken, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(link.event_id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, status: 'confirmed' }) });
        await admin.from('google_event_links').update({ pushed: print }).eq('id', link.id);
        updated++;
      } else {
        const ev2 = await api(accessToken, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) });
        await admin.from('google_event_links').insert({ account_id: account.id, source, source_id: Number(idText), event_id: ev2.id, pushed: print });
        created++;
      }
    } catch (err) {
      if ((err as Any)?.status === 404 && link) {
        await admin.from('google_event_links').delete().eq('id', link.id);
      } else {
        console.error('calendar push failed', { key, err: String(err) });
      }
    }
  }

  for (const [key, link] of linkOf) {
    if (want.has(key)) continue;
    await api(accessToken, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(link.event_id)}`, { method: 'DELETE' }).catch(() => null);
    await admin.from('google_event_links').delete().eq('id', link.id);
    removed++;
  }
  return { created, updated, removed };
}

/**
 * Google → CLOZR. Only events CLOZR put there, matched by the private
 * properties we stamped on them, so nothing else in the account is read or
 * touched. Moving an appointment on a phone moves it in the CRM.
 *
 * A deleted event is not a deleted appointment: the record is the CRM's, so
 * the link is parked instead, and changing the appointment in CLOZR brings
 * the event back.
 */
export async function pullCalendar(admin: SupabaseClient, account: Account, accessToken: string): Promise<{ applied: number; cancelled: number }> {
  const calendarId = account.calendar_id;
  if (!calendarId) return { applied: 0, cancelled: 0 };
  const updatedMin = account.last_calendar_sync_at ?? iso(new Date(Date.now() - 7 * 24 * HOUR));
  const q = new URLSearchParams({ updatedMin, showDeleted: 'true', singleEvents: 'true', maxResults: '250', privateExtendedProperty: 'clozr=1' });
  const page = await api(accessToken, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${q}`).catch((err) => {
    console.error('calendar pull failed', String(err));
    return { items: [] };
  });

  let applied = 0, cancelled = 0;
  for (const ev of (page.items ?? []) as Any[]) {
    const props = ev.extendedProperties?.private ?? {};
    const source = props.clozr_source as string | undefined;
    const id = Number(props.clozr_id);
    if (!source || !Number.isFinite(id)) continue;
    if (String(props.clozr_ws) !== String(account.workspace_id)) continue;

    if (ev.status === 'cancelled') {
      const { data: link } = await admin.from('google_event_links').select('id, pushed').eq('account_id', account.id).eq('source', source).eq('source_id', id).maybeSingle();
      if (link && !String(link.pushed ?? '').startsWith('cancelled:')) {
        await admin.from('google_event_links').update({ pushed: `cancelled:${link.pushed ?? ''}` }).eq('id', link.id);
        cancelled++;
      }
      continue;
    }
    const start = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T09:00:00Z` : null);
    if (!start) continue;
    const end = ev.end?.dateTime ?? null;

    if (source === 'appointment') {
      const { data: row } = await admin.from('appointments').select('id, starts_at, ends_at, location').eq('id', id).eq('workspace_id', account.workspace_id).maybeSingle();
      if (!row) continue;
      const patch: Any = {};
      if (new Date(row.starts_at).getTime() !== new Date(start).getTime()) patch.starts_at = new Date(start).toISOString();
      if (end && (!row.ends_at || new Date(row.ends_at).getTime() !== new Date(end).getTime())) patch.ends_at = new Date(end).toISOString();
      if (ev.location && ev.location !== row.location) patch.location = String(ev.location).slice(0, 500);
      if (Object.keys(patch).length) {
        await admin.from('appointments').update(patch).eq('id', id);
        applied++;
      }
    } else if (source === 'task') {
      const { data: row } = await admin.from('tasks').select('id, due_at').eq('id', id).eq('workspace_id', account.workspace_id).maybeSingle();
      if (!row) continue;
      if (!row.due_at || new Date(row.due_at).getTime() !== new Date(start).getTime()) {
        await admin.from('tasks').update({ due_at: new Date(start).toISOString() }).eq('id', id);
        applied++;
      }
    }
  }
  return { applied, cancelled };
}

// -------------------------------------------------------------------- gmail
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => dec.decode(unb64(s.replace(/-/g, '+').replace(/_/g, '/')));
const wrap76 = (s: string) => b64(enc.encode(s)).replace(/(.{76})/g, '$1\r\n');
const escHtml = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Plain text as the smallest safe HTML: escaped, line breaks kept. */
export const textToHtml = (text: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escHtml(text).replace(/\r?\n/g, '<br>')}</div>`;

/** HTML as readable text, for the plain alternative and for a snippet. The app renders the HTML itself. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => `${label} (${href})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A file to send: its bytes, as they will be base64'd into the message. */
export type MailFile = { filename: string; contentType: string; data: Uint8Array };

type Mail = { to: string; subject: string; html: string; text?: string | null; from?: string | null; replyTo?: string | null; inReplyTo?: string | null;
  /** Send the text part alone (text/plain, no HTML alternative): what cold and Compr mail send. Needs `text`. */
  plainOnly?: boolean;
  /** Visible copies, and blind ones: Gmail delivers to Bcc and keeps the line only on the sender's own copy. */
  cc?: string | null; bcc?: string | null;
  attachments?: MailFile[];
  /** Extra headers, e.g. List-Unsubscribe on bulk mail; line breaks are stripped so none can inject another header. */
  headers?: Record<string, string> };

/** A header value on one line, so nothing in it can start a header of its own. */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ');
/** RFC 2231 for a filename that is not plain ASCII; quoted-safe for one that is. */
const fileParam = (name: string) => {
  const clean = name.replace(/[\r\n"\\]+/g, '_').slice(0, 180) || 'file';
  return /^[\x20-\x7e]*$/.test(clean) ? `filename="${clean}"` : `filename*=UTF-8''${encodeURIComponent(clean)}`;
};
/** The older `name=` parameter many clients still read: RFC 2047 when the name is not plain ASCII. */
const nameParam = (name: string) => {
  const clean = name.replace(/[\r\n"\\]+/g, '_').slice(0, 180) || 'file';
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(enc.encode(clean))}?=`;
};
const wrapBytes = (bytes: Uint8Array) => b64(bytes).replace(/(.{76})/g, '$1\r\n');

/**
 * RFC 2822 with a UTF-8 subject, since names and addresses are not ASCII. With
 * a text part it goes out multipart/alternative, so a client that will not
 * render the HTML still reads the message; with files, that alternative sits
 * inside a multipart/mixed beside them. A reply carries In-Reply-To and
 * References, which is what threads it in the recipient's client.
 */
export function rawMessage(msg: Mail): string {
  const subject = `=?UTF-8?B?${b64(enc.encode(msg.subject))}?=`;
  const alt = `clozr-alt-${crypto.randomUUID()}`;
  const mixed = `clozr-mix-${crypto.randomUUID()}`;
  const files = msg.attachments ?? [];
  const head = [
    `To: ${oneLine(msg.to)}`,
    msg.cc ? `Cc: ${oneLine(msg.cc)}` : '',
    msg.bcc ? `Bcc: ${oneLine(msg.bcc)}` : '',
    msg.from ? `From: ${oneLine(msg.from)}` : '',
    msg.replyTo ? `Reply-To: ${oneLine(msg.replyTo)}` : '',
    msg.inReplyTo ? `In-Reply-To: ${oneLine(msg.inReplyTo)}` : '',
    msg.inReplyTo ? `References: ${oneLine(msg.inReplyTo)}` : '',
    ...Object.entries(msg.headers ?? {}).map(([k, v]) => `${k.replace(/[^A-Za-z0-9-]/g, '')}: ${oneLine(v)}`),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  // The readable part: text alone when asked, text and HTML as alternatives, or HTML alone.
  const readable = msg.plainOnly && msg.text
    ? { type: 'text/plain; charset=UTF-8', encoding: 'base64' as string | null, body: wrap76(msg.text) }
    : msg.text
    ? {
      type: `multipart/alternative; boundary="${alt}"`, encoding: null as string | null,
      body: [
        `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(msg.text),
        `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(msg.html),
        `--${alt}--`,
      ].join('\r\n'),
    }
    : { type: 'text/html; charset=UTF-8', encoding: 'base64' as string | null, body: wrap76(msg.html) };

  if (!files.length) {
    head.push(`Content-Type: ${readable.type}`);
    if (readable.encoding) head.push(`Content-Transfer-Encoding: ${readable.encoding}`);
    return `${head.join('\r\n')}\r\n\r\n${readable.body}`;
  }
  head.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  const parts = [
    `--${mixed}`, `Content-Type: ${readable.type}`, ...(readable.encoding ? [`Content-Transfer-Encoding: ${readable.encoding}`] : []), '', readable.body,
  ];
  for (const f of files) {
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(f.contentType) ? f.contentType : 'application/octet-stream';
    parts.push(
      `--${mixed}`, `Content-Type: ${type}; name="${nameParam(f.filename)}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${fileParam(f.filename)}`, '', wrapBytes(f.data),
    );
  }
  parts.push(`--${mixed}--`);
  return `${head.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/** Gmail's ceiling on a whole sent message, attachments and encoding included. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Sends from the account's own address. Null when Gmail refused it.
 *
 * A message with files goes through Gmail's upload endpoint (multipart:
 * the thread id as JSON metadata, then the message itself), which takes
 * messages up to 35 MB; the JSON `raw` route is for small ones.
 */
export async function sendMail(accessToken: string, msg: Mail & { threadId?: string | null }): Promise<{ id: string; threadId: string } | null> {
  try {
    const mime = rawMessage(msg);
    if (!msg.attachments?.length) {
      const sent = await api(accessToken, `${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(enc.encode(mime)), ...(msg.threadId ? { threadId: msg.threadId } : {}) }) });
      return { id: String(sent.id), threadId: String(sent.threadId) };
    }
    const boundary = `clozr-up-${crypto.randomUUID()}`;
    const body = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(msg.threadId ? { threadId: msg.threadId } : {}),
      `--${boundary}`, 'Content-Type: message/rfc822', '', mime,
      `--${boundary}--`, '',
    ].join('\r\n');
    const res = await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const sent = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(sent?.error?.message ?? `HTTP ${res.status}`));
    return { id: String(sent.id), threadId: String(sent.threadId) };
  } catch (err) {
    console.error('gmail send failed', String(err));
    return null;
  }
}

/**
 * The signature the user set in Gmail for this address: the matching send-as
 * alias, else the primary one. HTML, '' when they have none, null when Gmail
 * would not say (a connection with no Gmail read scope).
 */
export async function gmailSignature(accessToken: string, email: string): Promise<string | null> {
  const r = await api(accessToken, `${GMAIL}/settings/sendAs`).catch(() => null);
  const list = (r?.sendAs ?? []) as Any[];
  if (!list.length) return null;
  const me = list.find((x) => String(x.sendAsEmail ?? '').toLowerCase() === email.toLowerCase()) ?? list.find((x) => x.isPrimary) ?? list[0];
  return String(me?.signature ?? '').trim();
}

/**
 * The signature added under a message CLOZR sends, unless the body already
 * carries it (someone pasted it, or a reply quotes it).
 */
export function withSignature(html: string, text: string, signature: string | null | undefined): { html: string; text: string } {
  const sig = String(signature ?? '').trim();
  if (!sig) return { html, text };
  const sigText = htmlToText(sig).replace(/\s+/g, ' ').trim();
  const probe = sigText.slice(0, 40);
  if (probe && htmlToText(html).replace(/\s+/g, ' ').includes(probe)) return { html, text };
  return {
    html: `${html}<br><div class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>`,
    text: sigText ? `${text}\n\n--\n${htmlToText(sig).trim()}` : text,
  };
}

/**
 * The thread a Message-ID lives in, in this mailbox. Gmail thread ids are per
 * mailbox, so a teammate's reply to a seller finds its own copy of the thread
 * rather than trusting an id that came from someone else's inbox.
 */
export async function threadOf(accessToken: string, messageId: string): Promise<string | null> {
  const q = encodeURIComponent(`rfc822msgid:${messageId.replace(/^<|>$/g, '')}`);
  const r = await api(accessToken, `${GMAIL}/messages?maxResults=1&q=${q}`).catch(() => null);
  return (r?.messages?.[0]?.threadId as string | undefined) ?? null;
}

/** The RFC Message-ID Gmail stamped on a message — the id every mailbox agrees on. */
export async function messageIdOf(accessToken: string, gmailId: string): Promise<string | null> {
  const m = await api(accessToken, `${GMAIL}/messages/${gmailId}?format=metadata&metadataHeaders=Message-ID`).catch(() => null);
  const h = ((m?.payload?.headers ?? []) as Any[]).find((x) => String(x.name).toLowerCase() === 'message-id');
  return h ? String(h.value).trim() : null;
}

/**
 * The bytes of one received file, from the mailbox that holds it. Gmail's
 * attachment ids change between reads, so the part is found again by its
 * partId (email_attachments.part_key "gmail:<partId>"), which does not.
 */
export async function fetchAttachment(accessToken: string, gmailMessageId: string, partKey: string): Promise<Uint8Array | null> {
  const partId = partKey.replace(/^gmail:/, '');
  const m = await api(accessToken, `${GMAIL}/messages/${encodeURIComponent(gmailMessageId)}?format=full`).catch(() => null);
  if (!m) return null;
  let found: Any = null;
  const walk = (p: Any) => { if (!p || found) return; if (String(p.partId ?? '') === partId) { found = p; return; } for (const c of p.parts ?? []) walk(c); };
  walk(m.payload);
  const inline = found?.body?.data as string | undefined;
  const id = found?.body?.attachmentId as string | undefined;
  const data = inline ?? (id ? (await api(accessToken, `${GMAIL}/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(id)}`).catch(() => null))?.data : null);
  return typeof data === 'string' ? unb64(data.replace(/-/g, '+').replace(/_/g, '/')) : null;
}

/** "A <a@x>, b@y" → ['a@x', 'b@y']. See gmail-match.ts: read by pattern, so a quoted "Doe, Jane" is not split. */
export const addressesOf = addressesOfHeader;

/**
 * A designed message, not a sentence that mentions one tag.
 * Paragraph mail (a signing link, a bold line) counts; one stray tag does not.
 * Keep the rules identical to looksLikeHtml in app/lib/email-html.ts.
 */
export function looksLikeHtml(raw: string | null | undefined): boolean {
  const s = String(raw ?? '').trim();
  if (s.length < 12) return false;
  if (/^<!doctype\s+html\b/i.test(s) || /<html[\s>]/i.test(s) || /<body[\s>]/i.test(s)) return true;
  const tags = s.match(/<\/?(?:p|div|br|table|td|tr|th|img|style|span|a|strong|em|b|i|u|ul|ol|li|h[1-6]|blockquote|font|center|html|body|head)\b/gi);
  return !!tags && tags.length >= 4;
}

/** HTML kept on communications.body. A larger document stays as its words until a later read can store the HTML. */
export const HTML_BODY_MAX = 120_000;
const PART_FETCH_MAX = 400_000;
const CID_INLINE_MAX = 60_000;

function mimeIs(part: Any, type: string): boolean {
  return String(part?.mimeType ?? '').toLowerCase().startsWith(type);
}

/** The decoded text of one MIME part, including a part Gmail only returns by attachment id. */
async function partString(accessToken: string, messageId: string, part: Any): Promise<string> {
  const inline = part?.body?.data;
  if (typeof inline === 'string' && inline.length) return unb64url(inline);
  const id = part?.body?.attachmentId as string | undefined;
  if (!id) return '';
  const size = Number(part?.body?.size ?? 0);
  if (size > PART_FETCH_MAX) return '';
  const att = await api(accessToken, `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(id)}`).catch(() => null);
  const data = att?.data;
  return typeof data === 'string' && data ? unb64url(data) : '';
}

/**
 * The plain part and the HTML part of a `format=full` payload.
 * text/html; charset=… counts. A part that only has an attachment id is fetched
 * when it is under PART_FETCH_MAX. Small inline CID images become data URLs
 * so the document still has its pictures after it leaves Gmail.
 */
export async function resolveBodies(accessToken: string, messageId: string, payload: Any): Promise<{ html: string; text: string }> {
  const parts: Any[] = [];
  const walk = (p: Any) => { if (!p) return; parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  const first = async (type: string) => {
    for (const p of parts) {
      if (!mimeIs(p, type)) continue;
      const text = (await partString(accessToken, messageId, p)).trim();
      if (text) return text;
    }
    return '';
  };
  let html = await first('text/html');
  const text = (await first('text/plain')) || (html ? htmlToText(html) : '');
  if (html) {
    for (const p of parts) {
      if (!/^image\/(png|jpe?g|gif|webp)\b/i.test(String(p.mimeType ?? ''))) continue;
      const headers = new Map<string, string>(((p.headers ?? []) as Any[]).map((h) => [String(h.name).toLowerCase(), String(h.value ?? '')]));
      const cid = (headers.get('content-id') ?? '').replace(/^<|>$/g, '').trim();
      const inline = p?.body?.data as string | undefined;
      if (!cid || typeof inline !== 'string' || !inline || inline.length > CID_INLINE_MAX * 2) continue;
      const mime = String(p.mimeType).split(';')[0].trim().toLowerCase();
      const b64 = inline.replace(/-/g, '+').replace(/_/g, '/');
      const url = `data:${mime};base64,${b64}`;
      html = html.replace(new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), url);
    }
  }
  return { html, text };
}

/** What communications.body stores: the HTML when it fits, otherwise the words. */
export function mailBodyForStorage(resolved: { html: string; text: string }, snippet = ''): string {
  if (resolved.html && resolved.html.length <= HTML_BODY_MAX) return resolved.html;
  return (resolved.text || snippet).slice(0, 20_000);
}

/** format=full for one Gmail id, as { html, text }. */
export async function documentForGmail(accessToken: string, gmailId: string): Promise<{ html: string; text: string }> {
  const m = await api(accessToken, `${GMAIL}/messages/${encodeURIComponent(gmailId)}?format=full`);
  return resolveBodies(accessToken, gmailId, m?.payload);
}

/** The Gmail id for a stored row: `gmail:<id>`, or a search by RFC Message-ID. */
export async function gmailIdFor(accessToken: string, sourceId: string): Promise<string | null> {
  if (sourceId.startsWith('gmail:')) return sourceId.slice('gmail:'.length) || null;
  const mid = sourceId.replace(/^<|>$/g, '').trim();
  if (!mid) return null;
  const list = await api(accessToken, `${GMAIL}/messages?q=${encodeURIComponent(`rfc822msgid:${mid}`)}&maxResults=1`).catch(() => null);
  const id = list?.messages?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Every page of a PostgREST read. A bare select stops at the project's
 * max-rows (1000), which is how a workspace with more buyers than that had
 * the rest of its address book silently left out of the match.
 */
async function everyRow<T>(make: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}

/** One address to look back through, in the order the backfill walks them: `key` is "updated_at|kind|id". */
type Contact = { key: string; email: string };

/** Which addresses (and deal_parties rows) a book has already asked the database about. */
const looked = new WeakMap<Book, { emails: Set<string>; parties: Set<number> }>();

const pushDeal = (m: Map<number, DealRef[]>, id: number | null | undefined, d: DealRef) => {
  if (id == null) return;
  const list = m.get(id) ?? [];
  if (!list.some((x) => x.id === d.id)) list.push(d);
  m.set(id, list);
};

const addParty = (book: Book, email: unknown, dealId: number) => {
  const e = addrKey(email);
  if (!e || book.ours.has(e) || !book.deals.has(dealId)) return;
  const list = book.parties.get(e) ?? [];
  if (!list.includes(dealId)) list.push(dealId);
  book.parties.set(e, list);
};

/**
 * The people behind `addresses`, added to the book: the seller, buyer and
 * vendor each one is (newest record first, a buyer's main address before
 * their other ones), and the deal_parties rows on those people or addresses.
 * gmail_people (migration 170) reads only those rows, so a run costs what
 * its mail costs instead of the whole address book. Call it before
 * routeFor / linkFor on any address the book has not seen.
 */
export async function knowPeople(admin: SupabaseClient, ws: number, book: Book, addresses: string[]): Promise<void> {
  let seen = looked.get(book);
  if (!seen) { seen = { emails: new Set(), parties: new Set() }; looked.set(book, seen); }
  const want = Array.from(new Set(addresses.map(addrKey))).filter((e) => e && !book.ours.has(e) && !seen!.emails.has(e));
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    const { data, error } = await admin.rpc('gmail_people', { p_ws: ws, p_emails: part });
    if (error) throw new Error('gmail_people: ' + error.message);
    part.forEach((e) => seen!.emails.add(e));
    const people = ((data as Any)?.people ?? []) as { kind: string; id: number; email: string }[];
    const maps: [string, Map<string, number>][] = [['seller', book.sellers], ['buyer', book.buyers], ['buyer_alt', book.buyers], ['vendor', book.vendors]];
    for (const [kind, map] of maps) {
      for (const p of people) {
        if (p.kind !== kind) continue;
        const e = addrKey(p.email);
        if (e && !book.ours.has(e) && !map.has(e)) map.set(e, Number(p.id));
      }
    }
    for (const p of ((data as Any)?.parties ?? []) as Any[]) {
      if (seen.parties.has(p.id)) continue;
      seen.parties.add(p.id);
      const d = book.deals.get(p.deal_id);
      if (!d) continue;
      if (p.seller_id) pushDeal(book.dealsBySeller, p.seller_id, d);
      if (p.buyer_id) pushDeal(book.dealsByBuyer, p.buyer_id, d);
      if (p.vendor_id) pushDeal(book.dealsByVendor, p.vendor_id, d);
      addParty(book, p.email, p.deal_id);
    }
  }
}

/** Every address on a message's From, To and Cc headers. */
const messageAddresses = (m: Any) => {
  const h = headersOf(m);
  return addressesOf(`${h.get('from') ?? ''},${h.get('to') ?? ''},${h.get('cc') ?? ''}`);
};

/**
 * The next addresses for the history backfill after `cursor`, read from the
 * database in the cursor's own order (gmail_backfill_contacts, migration
 * 170): sellers, deal parties, and buyers and vendors on a live deal. A
 * buyer or vendor on no deal has no history worth crawling for.
 */
async function backfillContacts(admin: SupabaseClient, ws: number, book: Book, cursor: string): Promise<Contact[]> {
  const { data, error } = await admin.rpc('gmail_backfill_contacts', { p_ws: ws, p_after: cursor, p_limit: 60 });
  if (error) throw new Error('gmail_backfill_contacts: ' + error.message);
  return ((data ?? []) as Any[]).map((r) => ({ key: String(r.key), email: addrKey(r.email) })).filter((c) => c.email && !book.ours.has(c.email));
}

/**
 * The workspace as the mail matcher sees it (gmail-match.ts `Book`): each
 * live deal with its street and the people named on the deal row, the title
 * emails on deals and transactions, and our own addresses, which never count
 * as a match. Sellers, buyers, vendors and deal parties come in per batch
 * through knowPeople.
 */
export async function loadBook(admin: SupabaseClient, ws: number): Promise<{ book: Book }> {
  const [deals, txs, accounts, members, senders] = await Promise.all([
    // Archived deals (duplicates, dead files) take no mail: what was filed on one refiles onto the live deal.
    everyRow<Any>(() => admin.from('deals').select('id, seller_id, buyer_id, title_vendor_id, title_email, property_id, stage, created_at, properties(line1)').eq('workspace_id', ws).is('archived_at', null).order('created_at', { ascending: false }).order('id', { ascending: false })),
    everyRow<Any>(() => admin.from('transactions').select('id, deal_id, title_email').eq('workspace_id', ws).not('title_email', 'is', null).order('id')),
    admin.from('google_accounts').select('email, user_id').eq('workspace_id', ws),
    admin.from('workspace_members').select('user_id, profiles(email)').eq('workspace_id', ws),
    admin.from('email_senders').select('from_email, reply_to, user_id').eq('workspace_id', ws).eq('active', true),
  ]);

  const ours = new Set<string>();
  const reps = new Map<string, string>();
  const claim = (email: unknown, userId: unknown) => {
    const e = addrKey(email);
    if (!e) return;
    ours.add(e);
    const id = String(userId ?? '').trim();
    if (id && !reps.has(e)) reps.set(e, id);
  };
  for (const a of (accounts.data ?? []) as Any[]) claim(a.email, a.user_id);
  for (const m of (members.data ?? []) as Any[]) {
    const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    claim(p?.email, m.user_id);
  }
  for (const s of (senders.data ?? []) as Any[]) {
    const from = addrKey(s.from_email);
    if (from) ours.add(from);
    claim(s.from_email, s.user_id);
    claim(s.reply_to, s.user_id);
  }

  const book: Book = { sellers: new Map(), buyers: new Map(), vendors: new Map(), parties: new Map(), dealsBySeller: new Map(), dealsByBuyer: new Map(), dealsByVendor: new Map(), deals: new Map(), ours, reps };
  for (const d of deals) {
    const prop = Array.isArray(d.properties) ? d.properties[0] : d.properties;
    const l1 = (prop?.line1 ?? null) as string | null;
    const ref: DealRef = { id: d.id, property_id: d.property_id ?? null, seller_id: d.seller_id ?? null, street: streetKey(l1), label: l1, rank: dealRank(d.stage) };
    book.deals.set(d.id, ref);
    pushDeal(book.dealsBySeller, d.seller_id, ref);
    pushDeal(book.dealsByBuyer, d.buyer_id, ref);
    pushDeal(book.dealsByVendor, d.title_vendor_id, ref);
  }
  for (const t of txs) if (t.deal_id) addParty(book, t.title_email, t.deal_id);
  // The deal sheet's own title email (migration 19): the escrow officer is often on no other row.
  for (const d of deals) addParty(book, d.title_email, d.id);
  return { book };
}

// Gmail's per-user quota is 250 units a second; a message read is 5 and a
// thread read 10, so a handful at a time stays well inside it.
const POOL = 5;
/** Look-back for an address the first time this mailbox is searched for it. */
const BACKFILL_DAYS = 180;
/**
 * Per run, small enough that one mailbox finishes inside the edge isolate's
 * CPU budget. A larger pull (full threads, hundreds of messages) was killed
 * with HTTP 546 before it could store last_gmail_sync_at, so the next run
 * started over. The rest of the history waits for the next run.
 */
const BACKFILL_ADDRESSES = 8;
const BACKFILL_THREADS = 8;
const INCREMENTAL_MESSAGES = 40;
/** format=full reads per run, backfill and new mail together. Metadata is cheap; HTML is not. */
const FULL_PER_RUN = 16;
const META_QS = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence';
/** A new message can land in Gmail with a date slightly before the last run ended; each window starts this far back. */
const OVERLAP_MS = 15 * 60_000;
/** The widest new-mail window one run lists. A mailbox that has been away longer catches up a window at a time, oldest first, instead of listing only its newest mail and skipping the rest. */
const WINDOW_MS = 3 * 86_400_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Gmail read that rides out a rate limit or a Google hiccup (429/5xx) twice before giving up. */
async function gmail(accessToken: string, path: string): Promise<Any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(accessToken, `${GMAIL}${path}`);
    } catch (err) {
      const status = (err as Any)?.status as number | undefined;
      const retry = status === 429 || (status != null && status >= 500) || (err as Any)?.reason === 'rateLimitExceeded' || (err as Any)?.reason === 'userRateLimitExceeded';
      if (!retry || attempt >= 2) throw err;
      await wait(800 * (attempt + 1));
    }
  }
}

/** A read of something the list just named; null when it was deleted in between (404), which is not a failure to retry. */
const gmailOrGone = (accessToken: string, path: string) =>
  gmail(accessToken, path).catch((err) => { if ((err as Any)?.status === 404) return null; throw err; });

/** Runs `fn` over `items`, `n` at a time, keeping order; a failure is an Error in its slot, not a throw. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<(R | Error)[]> {
  const out: (R | Error)[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (err) { out[i] = err instanceof Error ? err : new Error(String(err)); }
    }
  }));
  return out;
}

/** Every message id (with its thread) a search returns, following nextPageToken up to `cap`. */
async function listAll(accessToken: string, q: string, cap: number): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let page: string | undefined;
  do {
    const r = await gmail(accessToken, `/messages?maxResults=500&q=${encodeURIComponent(q)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const m of (r.messages ?? []) as Any[]) out.push({ id: String(m.id), threadId: String(m.threadId) });
    page = r.nextPageToken;
  } while (page && out.length < cap);
  return out.slice(0, cap);
}

const headersOf = (m: Any) => new Map<string, string>(((m?.payload?.headers ?? []) as Any[]).map((h) => [String(h.name).toLowerCase(), String(h.value ?? '')]));
const sourceIdOf = (m: Any, h: Map<string, string>) => h.get('message-id')?.trim() || `gmail:${m.id}`;
const notDraft = (m: Any) => !((m?.labelIds ?? []) as string[]).includes('DRAFT');
const isBulk = (h: Map<string, string>) => h.has('list-unsubscribe') || /\b(bulk|list|junk)\b/i.test(h.get('precedence') ?? '');

/** What a message is about, from its headers alone. */
function peek(book: Book, m: Any) {
  const h = headersOf(m);
  const from = addressesOf(h.get('from') ?? '')[0] ?? '';
  const to = addressesOf(`${h.get('to') ?? ''},${h.get('cc') ?? ''}`);
  const subject = h.get('subject') ?? '';
  // format=metadata still carries Gmail's snippet: enough to catch a street named in the first lines.
  // A full message also has its attachments, whose names often carry the street ("1206 Harbor Blvd - AB Contract.pdf").
  const files = filesOf(m?.payload).map((f) => f.filename).join(' | ');
  const route = routeFor(book, [from, ...to], subject, isBulk(h), String(m?.snippet ?? ''), files);
  return { h, from, to, subject, refs: refsOf(h.get('in-reply-to'), h.get('references')), route, link: route.link };
}

/** A file on a message, as email_attachments (migration 82) lists it. */
export type FilePart = { part_key: string; filename: string; content_type: string | null; byte_size: number | null };

/**
 * The files on a `format=full` message: every part with a filename whose body
 * Gmail keeps as an attachment. An inline image (a signature logo, a
 * tracking pixel) is part of the message, not a file anyone sent, and is left out.
 */
export function filesOf(payload: Any): FilePart[] {
  const out: FilePart[] = [];
  const walk = (p: Any) => {
    if (!p) return;
    const name = String(p.filename ?? '').trim();
    if (name && p.body?.attachmentId) {
      const hs = new Map<string, string>(((p.headers ?? []) as Any[]).map((x) => [String(x.name).toLowerCase(), String(x.value ?? '')]));
      const inline = /^inline/i.test(hs.get('content-disposition') ?? '') || (hs.has('content-id') && !/^attachment/i.test(hs.get('content-disposition') ?? ''));
      if (!(inline && /^image\//i.test(String(p.mimeType ?? '')))) {
        out.push({ part_key: `gmail:${String(p.partId ?? out.length)}`, filename: name.slice(0, 250), content_type: p.mimeType ? String(p.mimeType) : null, byte_size: Number.isFinite(Number(p.body?.size)) ? Number(p.body.size) : null });
      }
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

/** One communications row from a `format=full` message. Inbound is anything not sent from our side. */
async function rowFor(accessToken: string, ws: number, book: Book, m: Any, link: Link, routedBy: 'rule' | 'ai' = 'rule'): Promise<Any> {
  const h = headersOf(m);
  const from = addressesOf(h.get('from') ?? '')[0] ?? '';
  const to = addressesOf(h.get('to') ?? '');
  const cc = addressesOf(h.get('cc') ?? '');
  const inbound = !!from && !book.ours.has(from);
  const when = Number(m.internalDate);
  const resolved = await resolveBodies(accessToken, String(m.id), m.payload).catch(() => ({ html: '', text: '' }));
  const body = mailBodyForStorage(resolved, String(m.snippet ?? ''));
  // Stamped here so the background pass does not fetch a message it just stored.
  // HTML keeps a short plain preview; a plain body keeps its own words.
  const summary = looksLikeHtml(body)
    ? ((resolved.text || String(m.snippet ?? '')).replace(/\s+/g, ' ').trim().slice(0, 280) || null)
    : (body.slice(0, 20_000) || null);
  return {
    workspace_id: ws,
    ...link,
    channel: 'email',
    direction: inbound ? 'inbound' : 'outbound',
    occurred_at: new Date(Number.isFinite(when) ? when : Date.now()).toISOString(),
    subject: (h.get('subject') || '(no subject)').slice(0, 300),
    body,
    summary,
    from_email: from || null,
    to_email: to.join(', ').slice(0, 1000) || null,
    cc_email: cc.join(', ').slice(0, 1000) || null,
    status: inbound ? null : 'sent',
    source: 'gmail',
    source_id: sourceIdOf(m, h),
    rep_id: repFor(book, from, [...to, ...cc]),
    // Migration 107: how the deal was chosen, so a later pass may move it and never moves a hand-filed one.
    deal_routed_by: link.deal_id != null ? routedBy : null,
    // Not columns: store() writes them to email_attachments and strips them.
    _files: filesOf(m.payload),
    _gmail_id: String(m.id),
  };
}

const LINK_COLS = 'id, source_id, seller_id, buyer_id, vendor_id, deal_id, property_id';

/**
 * Writes the rows and, for any that were already stored (another teammate's
 * mailbox, an earlier run, the send itself), fills in links they were missing
 * — a deal that exists now, a thread that matched later. A stored link is
 * never overwritten: someone may have filed it by hand.
 */
async function store(admin: SupabaseClient, ws: number, rows: Any[], account: Pick<Account, 'id' | 'user_id'>): Promise<{ logged: number; filled: number }> {
  if (!rows.length) return { logged: 0, filled: 0 };
  const unique = Array.from(new Map(rows.map((r) => [r.source_id, r])).values());
  const extras = new Map(unique.map((r) => [r.source_id as string, { files: (r._files ?? []) as FilePart[], gmailId: r._gmail_id as string | undefined }]));
  let plain: Any[] = unique.map(({ _files: _f, _gmail_id: _g, ...r }) => r);
  const upsert = (rows: Any[]) => admin.from('communications').upsert(rows, { onConflict: 'workspace_id,source,source_id', ignoreDuplicates: true, count: 'exact' });
  // A column a project has not migrated yet is dropped and the write retried:
  // rep_id (85), deal_routed_by (107), and cc_email (82), which before 82 is
  // folded back into To as it always was.
  let { error, count } = await upsert(plain);
  for (let tries = 0; error && tries < 3; tries++) {
    const col = ['rep_id', 'deal_routed_by', 'cc_email'].find((c) => error!.message.includes(c));
    if (!col) break;
    plain = col === 'cc_email'
      ? plain.map(({ cc_email, ...r }) => ({ ...r, to_email: [r.to_email, cc_email].filter(Boolean).join(', ').slice(0, 1000) || null }))
      : plain.map(({ [col]: _drop, ...r }) => r);
    ({ error, count } = await upsert(plain));
  }
  // Thrown, so the caller records last_error and does not move the cursor.
  if (error) throw new Error('gmail communications insert failed: ' + error.message);
  let filled = 0;
  let routedCol = plain.some((r) => 'deal_routed_by' in r);
  for (let i = 0; i < unique.length; i += 200) {
    const part = unique.slice(i, i + 200);
    const pick = (cols: string) => admin.from('communications').select(cols).eq('workspace_id', ws).eq('source', 'gmail').in('source_id', part.map((r) => r.source_id));
    let { data: stored, error: readErr } = await pick(`${LINK_COLS}, body${routedCol ? ', deal_routed_by' : ''}`);
    if (readErr && routedCol) { routedCol = false; ({ data: stored } = await pick(`${LINK_COLS}, body`)); }
    const by = new Map(part.map((r) => [r.source_id, r]));
    await noteMailbox(admin, ws, account, (stored ?? []) as Any[], extras);
    for (const s of (stored ?? []) as Any[]) {
      const incoming = by.get(s.source_id);
      const linkPatch = fillable(s, incoming ?? emptyLink());
      // A person took it off every deal: another mailbox reading it does not put it back.
      if (s.deal_routed_by === 'manual') { delete linkPatch.deal_id; delete linkPatch.property_id; }
      const patch: Any = { ...linkPatch };
      if (linkPatch.deal_id != null && routedCol) patch.deal_routed_by = incoming?.deal_routed_by ?? 'rule';
      // A row stored as the plain stub (or before HTML was kept) picks up the
      // document the next time this mailbox reads the message.
      if (incoming && looksLikeHtml(String(incoming.body ?? '')) && !looksLikeHtml(String(s.body ?? ''))) {
        patch.body = String(incoming.body).slice(0, HTML_BODY_MAX);
        const preview = htmlToText(patch.body).replace(/\s+/g, ' ').trim().slice(0, 280);
        if (preview) patch.summary = preview;
      }
      if (!Object.keys(patch).length) continue;
      let { error: upErr } = await admin.from('communications').update(patch).eq('id', s.id);
      if (upErr && /deal_routed_by/.test(upErr.message)) {
        routedCol = false;
        delete patch.deal_routed_by;
        ({ error: upErr } = await admin.from('communications').update(patch).eq('id', s.id));
      }
      if (!upErr && Object.keys(linkPatch).length) filled++;
    }
  }
  return { logged: count ?? 0, filled };
}

/**
 * Which mailbox held each stored message, and the files on it (migration 82).
 * Written for every mailbox that sees a message, so an admin opening a rep's
 * inbox finds the thread whichever teammate's sync stored it first. Errors are
 * logged, not thrown: before the migration there is nowhere to write, and the
 * mail itself is already safe.
 */
async function noteMailbox(admin: SupabaseClient, ws: number, account: Pick<Account, 'id' | 'user_id'>, stored: { id: number; source_id: string }[], extras: Map<string, { files: FilePart[]; gmailId?: string }>): Promise<void> {
  if (!stored.length) return;
  const { error } = await admin.from('communication_mailboxes').upsert(
    stored.map((s) => ({ communication_id: s.id, account_id: account.id, workspace_id: ws, user_id: account.user_id })),
    { onConflict: 'communication_id,account_id', ignoreDuplicates: true });
  if (error) { console.error('communication_mailboxes write failed', error.message); return; }
  const files = stored.flatMap((s) => {
    const x = extras.get(s.source_id);
    return (x?.files ?? []).map((f) => ({ ...f, workspace_id: ws, communication_id: s.id, account_id: account.id, gmail_message_id: x?.gmailId ?? null }));
  });
  if (!files.length) return;
  const { error: fErr } = await admin.from('email_attachments').upsert(files, { onConflict: 'communication_id,part_key', ignoreDuplicates: true });
  if (fErr) console.error('email_attachments write failed', fErr.message);
}

/** Addresses on a stored row, the way the matcher reads them. */
const rowAddresses = (c: Any) => addressesOf(`${c.from_email ?? ''},${c.to_email ?? ''},${c.cc_email ?? ''}`);

/**
 * Recent filed mail by conversation (counterpart + subject, gmail-match.ts
 * conversationKey), newest first wins: a reply that lost its References
 * header, or that Gmail split into a new thread, still files with the
 * conversation it continues.
 */
async function loadConversations(admin: SupabaseClient, ws: number, book: Book): Promise<Map<string, Link>> {
  const out = new Map<string, Link>();
  const read = (cols: string) => admin.from('communications').select(`${LINK_COLS}, ${cols}`)
    .eq('workspace_id', ws).eq('channel', 'email').not('deal_id', 'is', null)
    .order('occurred_at', { ascending: false }).limit(2000);
  let { data, error } = await read('from_email, to_email, cc_email, subject');
  if (error) ({ data } = await read('from_email, to_email, subject'));
  for (const c of (data ?? []) as Any[]) {
    if (!book.deals.has(c.deal_id)) continue;
    const key = conversationKey(book, c.from_email ?? '', addressesOf(`${c.to_email ?? ''},${c.cc_email ?? ''}`), c.subject ?? '');
    if (key && !out.has(key)) out.set(key, { seller_id: c.seller_id, buyer_id: c.buyer_id, vendor_id: c.vendor_id, deal_id: c.deal_id, property_id: c.property_id });
  }
  return out;
}

/** The AI fallback's budget for one run, shared by every pass. */
type AiBudget = { key: string | null; left: number; routed: number };

/** A route the rules left open, put to the AI fallback while the run's budget lasts. */
async function aiFill(budget: AiBudget, route: Route, link: Link, msg: { subject: string; from: string; to: string[]; text: string }): Promise<Link | null> {
  if (link.deal_id != null || route.candidates.length < 2 || !budget.key || budget.left <= 0) return null;
  budget.left--;
  const id = await classifyDeal(budget.key, msg, route.candidates);
  const d = id != null ? route.candidates.find((c) => c.id === id) : null;
  if (!d) return null;
  budget.routed++;
  return { ...link, deal_id: d.id, property_id: d.property_id };
}

/**
 * Routing re-run against the workspace as it is now, every sync. Mail with
 * no deal gains one when its record, its deal or its conversation turns up
 * (a new lead's first reply, a deal opened after the seller had been
 * writing, a title company added mid-thread). Mail the rules or the AI filed
 * (deal_routed_by, migration 107) moves when a renamed or new deal is now the
 * one its street names. A row a person filed, or one filed before 107, is
 * never moved.
 */
/** Older unfiled mail re-tried per run, on top of the newest 40. */
const OLDER_RELINK_PER_RUN = 60;

async function relinkEmail(admin: SupabaseClient, ws: number, book: Book, conversations: Map<string, Link>, budget: AiBudget, accountId?: number): Promise<number> {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const read = (cols: string, routed: boolean) => {
    const q = admin.from('communications').select(`${LINK_COLS}, ${cols}`).eq('workspace_id', ws).eq('channel', 'email');
    return (routed ? q.gte('occurred_at', since).or('deal_id.is.null,deal_routed_by.in.(rule,ai)') : q.is('deal_id', null))
      .order('occurred_at', { ascending: false }).limit(40);
  };
  let routedCol = true;
  let cols = 'from_email, to_email, cc_email, subject, summary, deal_routed_by';
  let { data: loose, error } = await read(cols, true);
  // Before migration 107 there is no deal_routed_by (only unfiled mail is re-run); before 82 no cc_email.
  if (error) { routedCol = false; cols = 'from_email, to_email, cc_email, subject, summary'; ({ data: loose, error } = await read(cols, false)); }
  if (error) { cols = 'from_email, to_email, subject'; ({ data: loose } = await read(cols, false)); }
  // The newest 40 alone never reach older mail that is still unfiled. A page
  // of it per run, walking back from gmail_relink_before (migration 259) and
  // starting over from the newest when it reaches the end, so every unfiled
  // email is tried again against the deals and people as they are now.
  if (accountId != null) {
    const { data: cur, error: curErr } = await admin.from('google_accounts').select('gmail_relink_before').eq('id', accountId).maybeSingle();
    if (!curErr) {
      let q = admin.from('communications').select(`${LINK_COLS}, ${cols}, occurred_at`).eq('workspace_id', ws).eq('channel', 'email').is('deal_id', null);
      if (cur?.gmail_relink_before) q = q.lt('occurred_at', cur.gmail_relink_before);
      const { data: older } = await q.order('occurred_at', { ascending: false }).limit(OLDER_RELINK_PER_RUN);
      const page = (older ?? []) as Any[];
      const have = new Set(((loose ?? []) as Any[]).map((c) => c.id));
      loose = [...((loose ?? []) as Any[]), ...page.filter((c) => !have.has(c.id))];
      const edge = page.length >= OLDER_RELINK_PER_RUN ? page[page.length - 1].occurred_at ?? null : null;
      await admin.from('google_accounts').update({ gmail_relink_before: edge }).eq('id', accountId);
    }
  }
  // The files on each row, by name: a street there files the mail like one in the subject.
  const names = new Map<number, string[]>();
  const ids = ((loose ?? []) as Any[]).map((c) => c.id as number);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: files } = await admin.from('email_attachments').select('communication_id, filename').in('communication_id', ids.slice(i, i + 200));
    for (const f of (files ?? []) as Any[]) names.set(f.communication_id, [...(names.get(f.communication_id) ?? []), String(f.filename)]);
  }
  await knowPeople(admin, ws, book, ((loose ?? []) as Any[]).flatMap(rowAddresses));
  let relinked = 0;
  for (const c of (loose ?? []) as Any[]) {
    const subject = String(c.subject ?? '');
    const route = routeFor(book, rowAddresses(c), subject, false, String(c.summary ?? ''), (names.get(c.id) ?? []).join(' | '));
    let found = route.link;
    let by: 'rule' | 'ai' = 'rule';
    if (found.deal_id == null) {
      const key = conversationKey(book, c.from_email ?? '', addressesOf(`${c.to_email ?? ''},${c.cc_email ?? ''}`), subject);
      const conv = key ? conversations.get(key) : undefined;
      if (conv) found = mergeLink(found, conv);
    }
    // A row filed on a seller by hand still reaches that seller's latest deal.
    if (found.deal_id == null && c.seller_id != null) {
      const d = book.dealsBySeller.get(c.seller_id)?.[0];
      if (d) found = { ...found, deal_id: d.id, property_id: d.property_id };
    }
    if (found.deal_id == null && c.deal_id == null) {
      const ai = await aiFill(budget, route, found, { subject, from: c.from_email ?? '', to: addressesOf(`${c.to_email ?? ''},${c.cc_email ?? ''}`), text: String(c.summary ?? '') });
      if (ai) { found = ai; by = 'ai'; }
    }
    const patch: Any = fillable(c, found);
    // A person took it off every deal: it stays off.
    if (c.deal_routed_by === 'manual') { delete patch.deal_id; delete patch.property_id; }
    if (c.deal_id != null && reroute(book, { deal_id: c.deal_id, routed_by: c.deal_routed_by }, { ...route, link: found })) {
      patch.deal_id = found.deal_id;
      patch.property_id = found.property_id;
    }
    if (!Object.keys(patch).length) continue;
    if (patch.deal_id != null && routedCol) patch.deal_routed_by = by;
    const { error } = await admin.from('communications').update(patch).eq('id', c.id);
    if (!error) relinked++;
  }
  return relinked;
}

// ------------------------------------------------------- new contacts
/** An address the workspace already knows: a teammate, a seller, buyer or vendor, or a party on a deal. */
const knownAddress = (book: Book, e: string) =>
  book.ours.has(e) || book.sellers.has(e) || book.buyers.has(e) || book.vendors.has(e) || book.parties.has(e);

/**
 * Notes the agents, escrow officers and title reps on this run's mail that
 * CLOZR does not know (contact-suggest.ts, migration 259). Someone at a title
 * company we already use is added as a vendor under that company right away,
 * and onto the deal when the mail is on one. Everyone else becomes a
 * suggestion the TC adds or dismisses from the Inbox. Words alone (no
 * brokerage or title domain) only count on mail filed on a deal, or in the
 * TC's own mailbox, so a wholesaler's blast to a rep does not fill the list.
 */
async function noteStrangers(admin: SupabaseClient, ws: number, account: Pick<Account, 'id' | 'user_id'>, book: Book,
  seen: { m: Any; h: Map<string, string>; from: string; to: string[]; subject: string; link: Link }[]): Promise<void> {
  const live = seen.filter((s) => !isBulk(s.h));
  if (!live.length) return;
  const [{ data: vendorRows }, { data: me }] = await Promise.all([
    admin.from('vendors').select('business_name, email').eq('workspace_id', ws).ilike('service_type', 'title%').not('email', 'is', null).limit(500),
    admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', account.user_id).maybeSingle(),
  ]);
  const titles = titleDomains((vendorRows ?? []) as Any[]);
  const tcMailbox = me?.role === 'tc';
  const found = new Map<string, Stranger & { deal_id: number | null; subject: string; seen_at: string }>();
  for (const s of live) {
    const names = namesOf(`${s.h.get('from') ?? ''},${s.h.get('to') ?? ''},${s.h.get('cc') ?? ''}`);
    const files = filesOf(s.m?.payload).map((f) => f.filename).join(' ');
    const text = s.link.deal_id != null || tcMailbox ? `${s.subject} ${String(s.m?.snippet ?? '')} ${files}` : '';
    const at = new Date(Number(s.m?.internalDate) || Date.now()).toISOString();
    for (const e of [s.from, ...s.to].map(addrKey)) {
      if (!e || knownAddress(book, e)) continue;
      const c = classifyStranger(e, names.get(e) ?? null, text, titles);
      if (!c) continue;
      const had = found.get(e);
      if (!had || (had.deal_id == null && s.link.deal_id != null)) found.set(e, { ...c, deal_id: s.link.deal_id ?? had?.deal_id ?? null, subject: s.subject, seen_at: at });
    }
  }
  if (!found.size) return;
  const emails = Array.from(found.keys());
  const { data: prior } = await admin.from('contact_suggestions').select('email, status').eq('workspace_id', ws).in('email', emails);
  const statusOf = new Map(((prior ?? []) as Any[]).map((r) => [String(r.email), String(r.status)]));
  const rows: Any[] = [];
  for (const c of found.values()) {
    const row: Any = { email: c.email, name: c.name, company: c.company, kind: c.kind, deal_id: c.deal_id, user_id: account.user_id, subject: c.subject.slice(0, 300), seen_at: c.seen_at };
    if (c.known_company && !statusOf.has(c.email)) {
      const { data: v, error } = await admin.from('vendors').insert({
        workspace_id: ws, business_name: c.company, contact_name: c.name, email: c.email,
        service_type: 'Title Company', source: 'gmail', source_id: `gmail-title:${c.email}`,
      }).select('id').single();
      if (!error && v) {
        row.status = 'auto';
        row.vendor_id = v.id;
        book.vendors.set(c.email, Number(v.id));
        if (c.deal_id != null) {
          await admin.from('deal_parties').insert({
            workspace_id: ws, deal_id: c.deal_id, role: 'title', vendor_id: v.id, name: c.name, company: c.company,
            email: c.email, source: 'gmail', source_id: `gmail-title:${c.email}`,
          });
        }
      } else if (error) console.error('title contact not added', { email: c.email, err: error.message });
    }
    rows.push(row);
  }
  const { error } = await admin.rpc('contact_suggestions_note', { p_ws: ws, p_rows: rows });
  // Before migration 259 there is nowhere to write; the mail itself is unaffected.
  if (error) console.error('contact_suggestions_note', error.message);
}

// ------------------------------------------------------------- attachments
/** Attachments filed per run, across every message; the rest wait for the next run (dedupe makes that safe). */
const ATTACH_PER_RUN = 8;
/** Gmail hands attachments over as base64 in JSON; past this a function runs short of memory for no document a TC needs. */
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

/** attachmentId for anything Gmail stores apart; small files come inline as `data` instead. */
type Attachment = { filename: string; mimeType: string; attachmentId: string | null; data: string | null; size: number; inline: boolean };
export type Filing = {
  m: Any; deal_id: number; source_id: string; subject: string;
  /** When the message was sent, ms. Only fresh mail moves a deal's stage. */
  at: number;
  /** Our own mail to the seller on the deal: a contract sent for signature, not one signed. */
  toSeller: boolean;
};

/** A stored row's filing: its deal, and enough about it to judge whether a contract on it moves the deal. */
const filingOf = (m: Any, row: Any): Filing => ({
  m, deal_id: Number(row.deal_id), source_id: row.source_id, subject: row.subject,
  at: Date.parse(row.occurred_at) || Date.now(),
  toSeller: row.direction === 'outbound' && row.seller_id != null,
});

/** Every real attachment on a `format=full` message. */
function attachmentsOf(payload: Any): Attachment[] {
  const out: Attachment[] = [];
  const walk = (p: Any) => {
    if (!p) return;
    const id = p.body?.attachmentId ?? null;
    const data = p.body?.data ?? null;
    if (p.filename && (id || data)) {
      const disp = ((p.headers ?? []) as Any[]).find((h) => String(h.name).toLowerCase() === 'content-disposition')?.value ?? '';
      out.push({ filename: String(p.filename), mimeType: String(p.mimeType ?? ''), attachmentId: id ? String(id) : null, data: data ? String(data) : null, size: Number(p.body?.size ?? 0), inline: /^\s*inline/i.test(String(disp)) });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out.filter((a) => !isJunkAttachment(a.filename, a.mimeType, a.size, a.inline) && a.size <= ATTACH_MAX_BYTES);
}

const b64urlBytes = (data: string) => unb64(data.replace(/-/g, '+').replace(/_/g, '/'));

/**
 * Whether a file belongs in a deal's Files. Anything on a deal in the
 * pipeline does; on a Prospect (a lead's deal sheet) only a recognised deal
 * document does (a contract, a title commitment), not the flyers and photos
 * wholesalers send about every lead.
 */
const worthFiling = (stage: string | null, type: DocType) => (!!stage && stage !== 'Prospect') || (type !== 'photos' && type !== 'other');

/** A contract this fresh moves its deal along; an old one found by the backfill does not rewrite history. */
const STAGE_MOVE_MS = 14 * 86_400_000;

/** The deals a person has already moved off `to`: an email never moves them back there. */
async function undoneBy(admin: SupabaseClient, dealIds: number[], to: string): Promise<Set<number>> {
  if (!dealIds.length) return new Set();
  const { data } = await admin.from('stage_events').select('entity_id')
    .eq('entity_type', 'deal').eq('field', 'stage').eq('from_stage', to).not('changed_by', 'is', null).in('entity_id', dealIds);
  return new Set(((data ?? []) as Any[]).map((r) => Number(r.entity_id)));
}

/** Moves a deal along for a contract that arrived by email, and says why on its activity. The deal trigger moves the seller too. */
async function advanceDeal(admin: SupabaseClient, ws: number, dealId: number, from: string | null, to: string, filename: string): Promise<boolean> {
  const q = admin.from('deals').update({ stage: to }).eq('id', dealId).eq('workspace_id', ws);
  const { data, error } = await (from ? q.eq('stage', from) : q.is('stage', null)).select('id');
  if (error || !data?.length) return false;
  await admin.from('activity').insert({
    workspace_id: ws, entity_type: 'deal', entity_id: dealId, kind: 'stage',
    title: `Deal → ${to}`, body: `Moved by the email attachment "${filename.slice(0, 120)}".`,
  });
  return true;
}

type FileJob = { deal_id: number; source_id: string; subject: string; at: number; toSeller: boolean; filename: string; mimeType: string; size: number; communication_id: number | null; bytes: () => Promise<Uint8Array | null>; emailAttachmentId?: number };

/**
 * Saves files onto their deals: the deal-files bucket, a deal_files row
 * labelled by deal-docs.ts (title_commitment, purchase_agreement, …) and tied
 * to the message, and, for a fresh contract, the deal's next stage. The key is
 * the RFC Message-ID plus the file's name and size, the same in every
 * teammate's mailbox, so one PDF is filed once however many inboxes hold it
 * and however often the sync reads the thread.
 */
async function fileJobs(admin: SupabaseClient, ws: number, jobs: FileJob[]): Promise<number> {
  if (!jobs.length) return 0;
  const dealIds = Array.from(new Set(jobs.map((j) => j.deal_id)));
  const { data: deals } = await admin.from('deals').select('id, stage, archived_at, buyer_id, terminated').in('id', dealIds);
  const live = ((deals ?? []) as Any[]).filter((d) => !d.archived_at);
  const stageOf = new Map(live.map((d) => [d.id as number, (d.stage ?? null) as string | null]));
  const withBuyer = new Set(live.filter((d) => d.buyer_id != null).map((d) => d.id as number));
  const terminated = new Set(live.filter((d) => d.terminated).map((d) => d.id as number));
  let undone: Promise<Set<number>> | null = null;
  const keyed = jobs
    .map((j) => ({ j, type: classifyDoc(j.filename, j.subject, j.mimeType), key: `gmail:${j.source_id}:${j.filename}:${j.size}` }))
    .filter(({ j, type }) => stageOf.has(j.deal_id) && worthFiling(stageOf.get(j.deal_id) ?? null, type));
  if (!keyed.length) return 0;
  const { data: have } = await admin.from('deal_files').select('id, deal_id, source_id').in('deal_id', dealIds).in('source_id', keyed.map((k) => k.key));
  const done = new Map(((have ?? []) as Any[]).map((h) => [`${h.deal_id}|${h.source_id}`, h.id as number]));
  // Already on the deal (another mailbox, an earlier run): only the attachment's link to it is missing.
  for (const k of keyed) {
    const id = done.get(`${k.j.deal_id}|${k.key}`);
    if (id && k.j.emailAttachmentId) await admin.from('email_attachments').update({ deal_file_id: id }).eq('id', k.j.emailAttachmentId);
  }
  const todo = keyed.filter((k) => !done.has(`${k.j.deal_id}|${k.key}`)).slice(0, ATTACH_PER_RUN);
  let filed = 0;
  // One file at a time: each is held as base64 text, decoded text and bytes at once.
  const results = await pool(todo, 1, async ({ j, type, key }) => {
    const bytes = await j.bytes();
    if (!bytes) return;
    const safe = j.filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
    const path = `ws/${ws}/deals/${j.deal_id}/gmail-${crypto.randomUUID().slice(0, 8)}-${safe}`;
    const up = await admin.storage.from('deal-files').upload(path, bytes, { contentType: j.mimeType || 'application/octet-stream' });
    if (up.error) throw new Error(`upload ${j.filename}: ${up.error.message}`);
    const { data: row, error } = await admin.from('deal_files').insert({
      workspace_id: ws, deal_id: j.deal_id, kind: type === 'photos' ? 'photo' : 'file', name: j.filename,
      storage_path: path, content_type: j.mimeType || null, byte_size: bytes.byteLength, source: 'gmail', source_id: key,
      category: type, communication_id: j.communication_id,
    }).select('id').single();
    if (error) {
      await admin.storage.from('deal-files').remove([path]);
      // 23505: a teammate's run filed it a moment ago.
      if (error.code !== '23505') throw new Error(`deal_files ${j.filename}: ${error.message}`);
      return;
    }
    filed++;
    if (j.emailAttachmentId) await admin.from('email_attachments').update({ deal_file_id: row.id }).eq('id', j.emailAttachmentId);
    if (Date.now() - j.at <= STAGE_MOVE_MS && !terminated.has(j.deal_id)) {
      const cur = stageOf.get(j.deal_id) ?? null;
      const next = stageFromDoc(cur, type, j.toSeller, withBuyer.has(j.deal_id));
      // A person moved this deal off that stage before: theirs is the last word.
      if (next === 'Buyer Under Contract' && (await (undone ??= undoneBy(admin, dealIds, next))).has(j.deal_id)) return;
      if (next && await advanceDeal(admin, ws, j.deal_id, cur, next, j.filename)) {
        stageOf.set(j.deal_id, next);
        console.log('deal stage from email', { deal: j.deal_id, from: cur, to: next, doc: DOC_LABEL[type] });
      }
    }
  });
  for (const r of results) if (r instanceof Error) console.error('gmail attachment not filed', String(r));
  return filed;
}

/** Every attachment on mail this run filed under a deal. */
async function fileAttachments(admin: SupabaseClient, accessToken: string, ws: number, filings: Filing[]): Promise<number> {
  const withFiles = filings.map((f) => ({ ...f, atts: attachmentsOf(f.m?.payload) })).filter((f) => f.atts.length);
  if (!withFiles.length) return 0;
  const { data: comms } = await admin.from('communications').select('id, source_id').eq('workspace_id', ws).eq('source', 'gmail')
    .in('source_id', Array.from(new Set(withFiles.map((f) => f.source_id))));
  const commOf = new Map(((comms ?? []) as Any[]).map((c) => [c.source_id as string, c.id as number]));
  return fileJobs(admin, ws, withFiles.flatMap((f) => f.atts.map((a): FileJob => ({
    deal_id: f.deal_id, source_id: f.source_id, subject: f.subject, at: f.at, toSeller: f.toSeller,
    filename: a.filename, mimeType: a.mimeType, size: a.size, communication_id: commOf.get(f.source_id) ?? null,
    bytes: async () => {
      const got = a.data ? { data: a.data } : await gmailOrGone(accessToken, `/messages/${f.m.id}/attachments/${a.attachmentId}`);
      return got?.data ? b64urlBytes(String(got.data)) : null;
    },
  }))));
}

/**
 * Files on mail stored before it had a deal: the deal turned up later (a
 * relink, a street in an attachment's name, a hand filing), or the mail was
 * read before files were saved at all. email_attachments (migration 82)
 * remembers each file and which mailbox holds it, so this mailbox's share is
 * fetched and filed here, a few per run.
 */
async function fileStoredAttachments(admin: SupabaseClient, account: Account, accessToken: string): Promise<number> {
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data, error } = await admin.from('email_attachments')
    .select('id, part_key, filename, content_type, byte_size, gmail_message_id, communication_id, communications!inner(deal_id, source_id, subject, occurred_at, direction, seller_id)')
    .eq('workspace_id', account.workspace_id).eq('account_id', account.id).is('deal_file_id', null)
    .not('gmail_message_id', 'is', null).not('communications.deal_id', 'is', null).gte('communications.occurred_at', since)
    .order('id', { ascending: false }).limit(60);
  if (error) { console.error('stored attachments skipped', error.message); return 0; }
  const rows = ((data ?? []) as Any[]).filter((a) => !isJunkAttachment(String(a.filename), String(a.content_type ?? ''), Number(a.byte_size ?? 0), false) && Number(a.byte_size ?? 0) <= ATTACH_MAX_BYTES);
  return fileJobs(admin, account.workspace_id, rows.map((a): FileJob => {
    const c = Array.isArray(a.communications) ? a.communications[0] : a.communications;
    return {
      deal_id: Number(c.deal_id), source_id: String(c.source_id), subject: String(c.subject ?? ''),
      at: Date.parse(c.occurred_at) || 0, toSeller: c.direction === 'outbound' && c.seller_id != null,
      filename: String(a.filename), mimeType: String(a.content_type ?? ''), size: Number(a.byte_size ?? 0),
      communication_id: Number(a.communication_id), emailAttachmentId: Number(a.id),
      bytes: () => fetchAttachment(accessToken, String(a.gmail_message_id), String(a.part_key)),
    };
  }));
}

/** Plain rows asked of Gmail for their HTML part on one sync. */
const HTML_HYDRATE_PER_RUN = 3;

/**
 * HTML is saved when a message is first read. Older rows kept only the plain
 * part, and opening one was what went back to Gmail. Each sync finishes a few
 * of those here and stamps summary, so the same row is not fetched on the
 * next run or when someone selects it. A body that is already HTML only gets
 * that summary, which is the list preview.
 */
async function hydrateHtml(admin: SupabaseClient, account: Account, accessToken: string): Promise<number> {
  const { data, error } = await admin.from('communications')
    .select('id, body, source_id, communication_mailboxes!inner(account_id)')
    .eq('workspace_id', account.workspace_id)
    .eq('channel', 'email')
    .eq('source', 'gmail')
    .is('summary', null)
    .eq('communication_mailboxes.account_id', account.id)
    .order('occurred_at', { ascending: false })
    .limit(40);
  if (error) {
    console.error('gmail html hydrate skipped', error.message);
    return 0;
  }
  let fetched = 0;
  let wrote = 0;
  for (const row of (data ?? []) as Any[]) {
    const body = String(row.body ?? '');
    if (looksLikeHtml(body)) {
      const preview = htmlToText(body).replace(/\s+/g, ' ').trim().slice(0, 280) || '(no text)';
      await admin.from('communications').update({ summary: preview }).eq('id', row.id).eq('workspace_id', account.workspace_id);
      continue;
    }
    if (fetched >= HTML_HYDRATE_PER_RUN) continue;
    fetched++;
    try {
      const gmailId = await gmailIdFor(accessToken, String(row.source_id ?? ''));
      const resolved = gmailId ? await documentForGmail(accessToken, gmailId) : { html: '', text: '' };
      const html = resolved.html && resolved.html.length <= HTML_BODY_MAX && looksLikeHtml(resolved.html) ? resolved.html : '';
      const preview = (html ? htmlToText(html) : (resolved.text || body)).replace(/\s+/g, ' ').trim().slice(0, 280) || '(no text)';
      const patch: Any = { summary: preview };
      if (html) patch.body = html;
      const { error: upErr } = await admin.from('communications').update(patch).eq('id', row.id).eq('workspace_id', account.workspace_id);
      if (upErr) console.error('gmail html hydrate write failed', upErr.message);
      else if (html) wrote++;
    } catch (err) {
      console.error('gmail html hydrate', { id: row.id, err: String(err) });
    }
  }
  return wrote;
}

export type GmailPull = {
  logged: number; relinked: number;
  /** Attachments saved to a deal's files this run. */
  filed: number;
  /** Addresses looked back through this run for the first time. */
  backfilled: number;
  /** How far the new-mail window got; the caller stores it as last_gmail_sync_at. Null: nothing new was read, keep the old one. */
  through: string | null;
  /** True when a Gmail read failed and the run stopped short of it; the next run starts again from there. */
  failed: boolean;
  /** Nothing changed in the mailbox since the last full read; the run stopped after the profile call. */
  idle?: boolean;
};

/** Between full passes on a mailbox where nothing arrives, the relink, history, file and HTML passes still run this often. */
const MAINTENANCE_S = 55 * 60;

/**
 * Mail with people in the CRM, onto their record and their deal.
 *
 * Two passes, each with its own cursor, so nothing is skipped and nothing
 * is fetched twice without need:
 *
 *   backfill   every address in the book, oldest-touched first, searched once
 *              per mailbox — From, To and Cc — BACKFILL_DAYS back, and every
 *              thread it turns up read whole, so a reply from someone not in
 *              the CRM still lands with the thread. Resumes from
 *              google_accounts.gmail_backfill_cursor (migration 78), which
 *              also means a contact added or edited today, or a title company
 *              put on a deal, has their history pulled on the next run.
 *   new mail   everything since last_gmail_sync_at (Sent included — the
 *              rep's own replies are half of a deal's email), read headers
 *              first; what matches by address, by the street in the subject,
 *              by a thread-mate in this batch or by In-Reply-To/References to
 *              a row already stored is read in full and kept. The rest is
 *              never stored: CRM-unrelated mail stays out of the shared inbox.
 *              Oldest first, so a run cut short by a failure or the per-run
 *              limit hands `through` back at the last message it finished.
 *
 * Each message is one `communications` row keyed by its RFC Message-ID, the
 * same in every teammate's mailbox, so two reps on one thread store it once
 * and a re-run is a no-op (apart from filling links it learnt since).
 */
export async function pullGmail(admin: SupabaseClient, account: Account, accessToken: string, startedAt = new Date()): Promise<GmailPull> {
  const ws = googleSyncWorkspace(account);
  // Gmail's historyId moves on any change to the mailbox. Unchanged since a
  // run that read through to its own start means no mail arrived, so one
  // profile call answers the run. Read on its own so a project without
  // migration 170 just does the full pass.
  const profile = await gmail(accessToken, '/profile').catch(() => null);
  const historyId = profile?.historyId != null ? String(profile.historyId) : null;
  const { data: hrow } = await admin.from('google_accounts').select('gmail_history_id').eq('id', account.id).maybeSingle();
  const current = !!account.last_gmail_sync_at && Date.parse(account.last_gmail_sync_at) >= startedAt.getTime() - 3_600_000;
  if (historyId && hrow?.gmail_history_id === historyId && current) {
    const maintenance = await rateLimit(admin, `gmail-maint:${account.id}`, 1, MAINTENANCE_S);
    if (!maintenance.allowed) {
      const through = startedAt.toISOString();
      await admin.from('google_accounts').update({ last_gmail_sync_at: through }).eq('id', account.id);
      return { logged: 0, relinked: 0, filed: 0, backfilled: 0, through, failed: false, idle: true };
    }
  }

  const { book } = await loadBook(admin, ws);
  // The connected address is ours even before its google_accounts row is read back.
  book.ours.add(addrKey(account.email));
  const budget: AiBudget = { key: aiKey(), left: AI_PER_RUN, routed: 0 };
  const conversations = await loadConversations(admin, ws, book).catch((err) => { console.error('gmail conversations failed', String(err)); return new Map<string, Link>(); });
  let relinked = await relinkEmail(admin, ws, book, conversations, budget, account.id).catch((err) => { console.error('gmail relink failed', String(err)); return 0; });
  let logged = 0;
  let failed = false;
  const filings: Filing[] = [];

  // ---------------------------------------------------------------- backfill
  // Called after the new-mail cursor is saved. History is metadata first;
  // only messages that match a person or a deal are read in full, and only
  // a few of those, so one run stays inside the CPU budget. The newest
  // threads for each address are the ones kept — Gmail lists newest first
  // and the cursor moves on, while mail from here forward arrives on the
  // new-mail pass. Read on its own so a project without migration 78 still
  // gets that pass.
  const runBackfill = async (): Promise<number> => {
    const { data: cur, error: curErr } = await admin.from('google_accounts').select('gmail_backfill_cursor').eq('id', account.id).maybeSingle();
    if (curErr) { console.error('gmail backfill skipped: migration 78 not applied?', curErr.message); return 0; }
    const cursor = String(cur?.gmail_backfill_cursor ?? '');
    const chunks: Contact[][] = [];
    const queued = new Set<string>();
    const contacts = await backfillContacts(admin, ws, book, cursor).catch((err) => { console.error('gmail backfill contacts failed', String(err)); return [] as Contact[]; });
    for (const c of contacts) {
      if (!queued.has(c.email) && queued.size >= BACKFILL_ADDRESSES) break;
      queued.add(c.email);
      const last = chunks[chunks.length - 1];
      if (!last || new Set(last.map((x) => x.email)).size >= 20) chunks.push([c]); else last.push(c);
    }
    const searched = new Set<string>();
    const threadsRead = new Set<string>();
    let fullLeft = 8;
    let nextCursor: string | null = null;
    for (const chunk of chunks) {
      if (threadsRead.size >= BACKFILL_THREADS && nextCursor) break;
      const emails = Array.from(new Set(chunk.map((c) => c.email))).filter((e) => !searched.has(e));
      try {
        if (emails.length) {
          const q = `newer_than:${BACKFILL_DAYS}d -in:chats -in:drafts {${emails.map((a) => `from:${a} to:${a} cc:${a}`).join(' ')}}`;
          const hits = await listAll(accessToken, q, 40);
          const room = BACKFILL_THREADS - threadsRead.size;
          const threadIds = Array.from(new Set(hits.map((x) => x.threadId))).filter((t) => !threadsRead.has(t)).slice(0, Math.max(0, room));
          const threads = await pool(threadIds, POOL, (t) => gmailOrGone(accessToken, `/threads/${t}?${META_QS}`));
          const bad = threads.find((t) => t instanceof Error);
          if (bad) throw bad;
          await knowPeople(admin, ws, book, (threads as Any[]).flatMap((t) => ((t?.messages ?? []) as Any[]).flatMap(messageAddresses)));
          type Pick = { id: string; link: Link; by: 'rule' | 'ai' };
          const picks: Pick[] = [];
          for (const t of threads as Any[]) {
            const msgs = ((t?.messages ?? []) as Any[]).filter(notDraft);
            const peeks = msgs.map((m) => peek(book, m));
            const links = peeks.map((p) => p.link);
            const lend = threadLink(links);
            for (let i = 0; i < msgs.length; i++) {
              const m = msgs[i];
              const p = peeks[i];
              let l = mergeLink(links[i], lend);
              const key = l.deal_id == null ? conversationKey(book, p.from, p.to, p.subject) : null;
              if (key && conversations.has(key)) l = mergeLink(l, conversations.get(key));
              const ai = await aiFill(budget, p.route, l, { subject: p.subject, from: p.from, to: p.to, text: String(m.snippet ?? '') });
              if (ai) l = ai;
              if (!isLinked(l)) continue;
              picks.push({ id: String(m.id), link: l, by: ai ? 'ai' : 'rule' });
            }
          }
          const take = picks.slice(0, fullLeft);
          fullLeft -= take.length;
          const fulls = await pool(take, POOL, (p) => gmailOrGone(accessToken, `/messages/${p.id}?format=full`));
          const rows: Any[] = [];
          for (let i = 0; i < take.length; i++) {
            const m = fulls[i];
            if (!m || m instanceof Error) continue;
            const row = await rowFor(accessToken, ws, book, m, take[i].link, take[i].by);
            rows.push(row);
            if (take[i].link.deal_id) filings.push(filingOf(m, row));
          }
          const s = await store(admin, ws, rows, account);
          logged += s.logged;
          relinked += s.filled;
          threadIds.forEach((t) => threadsRead.add(t));
          emails.forEach((e) => searched.add(e));
        }
        nextCursor = chunk[chunk.length - 1].key;
      } catch (err) {
        console.error('gmail backfill stopped', { account: account.id, err: String(err) });
        failed = true;
        break;
      }
    }
    if (nextCursor) await admin.from('google_accounts').update({ gmail_backfill_cursor: nextCursor }).eq('id', account.id);
    return searched.size;
  };

  // ---------------------------------------------------------------- new mail
  // First run: the backfill carries history, so the window only has to reach
  // back far enough to meet it.
  const fromMs = account.last_gmail_sync_at ? new Date(account.last_gmail_sync_at).getTime() - OVERLAP_MS : startedAt.getTime() - 86_400_000;
  const toMs = Math.min(startedAt.getTime(), fromMs + WINDOW_MS);
  let through: string | null = null;
  const listed = await listAll(accessToken, `after:${Math.floor(fromMs / 1000)} before:${Math.ceil(toMs / 1000)} -in:chats -in:drafts`, 5000);
  if (listed.length >= 5000) console.error('gmail window over 5000 messages; the oldest may be missed', { account: account.id, from: new Date(fromMs).toISOString() });
  // Gmail lists newest first; work oldest first so a cut-off leaves a clean edge.
  const queue = listed.reverse();
  const batch = queue.slice(0, INCREMENTAL_MESSAGES);
  const metas = await pool(batch, POOL, (x) => gmailOrGone(accessToken, `/messages/${x.id}?${META_QS}`));
  let upTo = metas.findIndex((m) => m instanceof Error);
  let cut = upTo !== -1;
  if (upTo === -1) upTo = metas.length;
  const done = metas.slice(0, upTo) as Any[];
  await knowPeople(admin, ws, book, done.filter(Boolean).flatMap(messageAddresses));
  const seen = done.filter((m) => m && notDraft(m)).map((m) => ({ m, ...peek(book, m) }));

  // Thread-mates in this batch lend each other their link…
  const byThread = new Map<string, Link[]>();
  for (const s of seen) byThread.set(String(s.m.threadId), [...(byThread.get(String(s.m.threadId)) ?? []), s.link]);
  // …and so does anything already stored that the message is a reply to.
  const refs = Array.from(new Set(seen.filter((s) => !s.link.deal_id).flatMap((s) => s.refs)));
  const prior = new Map<string, Link>();
  for (let i = 0; i < refs.length; i += 200) {
    const { data } = await admin.from('communications').select(LINK_COLS).eq('workspace_id', ws).eq('source', 'gmail').in('source_id', refs.slice(i, i + 200));
    for (const r of (data ?? []) as Any[]) prior.set(r.source_id, r);
  }
  const merged = seen.map((s) => {
    let l = mergeLink(s.link, threadLink(byThread.get(String(s.m.threadId)) ?? []));
    for (const r of s.refs) l = mergeLink(l, prior.get(r));
    // …and so does a filed conversation with the same person and subject.
    const key = l.deal_id == null ? conversationKey(book, s.from, s.to, s.subject) : null;
    if (key && conversations.has(key)) l = mergeLink(l, conversations.get(key));
    return { ...s, link: l, by: 'rule' as 'rule' | 'ai' };
  });
  for (const s of merged) {
    const ai = await aiFill(budget, s.route, s.link, { subject: s.subject, from: s.from, to: s.to, text: String(s.m.snippet ?? '') });
    if (ai) { s.link = ai; s.by = 'ai'; }
  }
  // Agents, escrow officers and title reps on this mail who are not in CLOZR yet.
  await noteStrangers(admin, ws, account, book, merged).catch((err) => console.error('gmail contact suggestions failed', String(err)));
  const wanted = merged.filter((s) => isLinked(s.link));
  // HTML bodies are the expensive part. Stop after FULL_PER_RUN and leave
  // the window edge on the last one stored, so the next run continues there
  // instead of pretending the whole window was read.
  if (wanted.length > FULL_PER_RUN) {
    const last = wanted[FULL_PER_RUN - 1].m;
    const idx = done.indexOf(last);
    if (idx >= 0) upTo = idx + 1;
    wanted.length = FULL_PER_RUN;
  }

  const fulls = await pool(wanted, POOL, (s) => gmailOrGone(accessToken, `/messages/${s.m.id}?format=full`));
  const firstBad = fulls.findIndex((f) => f instanceof Error);
  let kept = wanted.length;
  if (firstBad !== -1) {
    cut = true;
    kept = firstBad;
    // Stop the window at the first message that could not be read, so it is read again next time.
    upTo = done.indexOf(wanted[firstBad].m);
  }
  const rows: Any[] = [];
  for (let i = 0; i < kept; i++) {
    const m = fulls[i] as Any;
    if (!m) continue;
    // The headers matched a person but no deal: the full message has the attachments' names to try.
    let link = wanted[i].link;
    if (link.deal_id == null) {
      const again = peek(book, m).link;
      if (again.deal_id != null) link = mergeLink(link, again);
    }
    const row = await rowFor(accessToken, ws, book, m, link, wanted[i].by);
    if (row.deal_id) filings.push(filingOf(m, row));
    rows.push(row);
  }
  const s = await store(admin, ws, rows, account);
  logged += s.logged;
  relinked += s.filled;

  if (cut) failed = true;
  if (upTo === queue.length && !cut) through = new Date(toMs).toISOString();
  else if (upTo > 0) {
    // The newest message finished, as the edge of the next window.
    const last = Math.max(...done.slice(0, upTo).map((m) => Number(m?.internalDate) || 0));
    if (last > 0) through = new Date(last).toISOString();
  }
  // Before history, attachments, or anything else that can blow the CPU
  // budget: a kill after this still leaves a cursor, and the next run
  // continues instead of rereading the same window forever.
  if (through) {
    await admin.from('google_accounts').update({ last_gmail_sync_at: through }).eq('id', account.id);
  }
  // Read through to this run's start: the historyId taken before the listing
  // marks "nothing since". Any later change moves it, so the next run reads.
  // Its own write, so a project without migration 170 still keeps the cursor.
  if (historyId && !cut && toMs === startedAt.getTime() && through === new Date(toMs).toISOString()) {
    await admin.from('google_accounts').update({ gmail_history_id: historyId }).eq('id', account.id);
  }

  // A mailbox still working through old windows spends the run on mail
  // alone. History, files and HTML wait until new mail is current; the files
  // are already listed in email_attachments, so fileStoredAttachments picks
  // them up then.
  const edge = through ?? account.last_gmail_sync_at;
  if (!edge || Date.parse(edge) < startedAt.getTime() - 3_600_000) {
    return { logged, relinked, filed: 0, backfilled: 0, through, failed };
  }

  const backfilled = await runBackfill();

  // After the rows are stored, so each file can point at the message it came on.
  // A failure here never costs the mail: it is logged and retried next run.
  let filed = await fileAttachments(admin, accessToken, ws, filings).catch((err) => { console.error('gmail attachments failed', String(err)); return 0; });
  // …and files on mail that found its deal only now (relinked above, or filed by hand since).
  filed += await fileStoredAttachments(admin, account, accessToken).catch((err) => { console.error('stored attachments failed', String(err)); return 0; });

  // Messages already stored as the plain part (or as HTML the old check
  // ignored) get the document here, a few per run, so opening one is not
  // what fetches it.
  await hydrateHtml(admin, account, accessToken).catch((err) => { console.error('gmail html hydrate failed', String(err)); });

  return { logged, relinked, filed, backfilled, through, failed };
}

// --------------------------------------------------------------------- sync
export type SyncResult = {
  ok: boolean; email: string; status: string;
  calendar: { created: number; updated: number; removed: number; applied: number; cancelled: number } | null;
  gmail: { logged: number; relinked: number } | null;
  message?: string;
};

/** One pass over one connection: push, pull back, then the mail. */
export async function syncAccount(admin: SupabaseClient, account: Account, opts: { origin: string; workspaceName: string }): Promise<SyncResult> {
  const accessToken = await accessFor(admin, account);
  if (!accessToken) {
    return { ok: false, email: account.email, status: 'needs_reauth', calendar: null, gmail: null, message: 'Google needs this connection approved again.' };
  }
  const out: SyncResult = { ok: true, email: account.email, status: 'active', calendar: null, gmail: null };
  const patch: Any = { last_error: null, status: 'active' };

  if (account.calendar_sync && has(account, SCOPE.calendar)) {
    try {
      await ensureCalendar(admin, account, accessToken, opts.workspaceName);
      const startedAt = new Date();
      const pulled = await pullCalendar(admin, account, accessToken);
      const pushed = await pushCalendar(admin, account, accessToken, opts.origin);
      out.calendar = { ...pushed, ...pulled };
      patch.last_calendar_sync_at = iso(startedAt);
    } catch (err) {
      console.error('calendar sync failed', { account: account.id, err: String(err) });
      patch.last_error = 'Calendar sync hit an error. It will try again on the next sync.';
      out.message = patch.last_error;
    }
  }

  if (account.gmail_read && has(account, SCOPE.gmailRead)) {
    try {
      const startedAt = new Date();
      out.gmail = await pullGmail(admin, account, accessToken);
      patch.last_gmail_sync_at = iso(startedAt);
    } catch (err) {
      console.error('gmail sync failed', { account: account.id, err: String(err) });
      patch.last_error = 'Gmail sync hit an error. It will try again on the next sync.';
      out.message = patch.last_error;
    }
  }

  await admin.from('google_accounts').update(patch).eq('id', account.id);
  return out;
}
