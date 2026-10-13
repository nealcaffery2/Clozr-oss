/**
 * POST /google-sync — run a connected Google account once.
 *
 * Body: { workspace_id, action, origin? }
 *   sync   (default) the calendar both ways, then the mail:
 *            push   appointments that changed here (new, edited, deleted,
 *                   invitations requested) to the member's CLOZR calendar —
 *                   events.insert / patch / delete with attendees, and
 *                   sendUpdates=all so Google emails the invitations itself
 *            pull   what changed on Google since the last run, through the
 *                   stored syncToken (410 → full resync): moved, renamed,
 *                   answered, created there, or deleted there — each lands
 *                   on the appointment row, a delete deletes the row
 *            tasks  open dated tasks become reminders on the same calendar
 *            gmail  mail with anyone in the CRM or on a deal — received and
 *                   sent, whole threads — onto the record and the deal
 *                   (_shared/google.ts pullGmail, rules in gmail-match.ts)
 *          Only the parts the user granted and left switched on.
 *   calendar  same as sync but skip Gmail. The app's write nudge uses this so
 *             a busy calendar does not stack concurrent mail pulls.
 *   mail   email the signing links for a contract from the member's own Gmail.
 *   email_html  { communication_id } the designed body of a stored email.
 *          Sync writes that HTML onto the row. This is only the fallback for
 *          a row that still holds the plain part. When communications.body is
 *          already HTML, that is returned. Otherwise the mailbox that holds
 *          the message is asked for text/html (works without a Google
 *          connection of the caller's own). HTML under HTML_BODY_MAX is
 *          written back onto the row. Nothing here returns a token.
 *   attachment  { attachment_id, save_to_deal? } a file on a stored email:
 *          a signed URL for it (fetched from the Gmail that holds it the first
 *          time, then kept in the deal-files bucket), and with save_to_deal
 *          put on that email's deal's files. Works without a connection of
 *          one's own: the file is on a message the caller can already read.
 *   test   send a one-line email to the connected address.
 *   send_email  { to, cc?, bcc?, subject, body_html?, body_text?, in_reply_to?, seller_id?, buyer_id?, vendor_id?, deal_id?,
 *                 attachments?, deal_file_ids?, email_attachment_ids?, track?, test? }
 *          cc / bcc: more addresses, twenty recipients in all. attachments:
 *          [{ storage_path, filename, content_type }] already uploaded by the
 *          caller to the deal-files bucket under ws/<workspace>/; deal_file_ids
 *          are files already on a deal; email_attachment_ids forward files
 *          from mail CLOZR stored. 20 MB in all. A sent file lands on the
 *          deal's files when the email is filed on a deal.
 *          track (default true for one-to-one mail): a read-receipt pixel and
 *          counted links (_shared/email-track.ts, migration 82).
 *          one email from the caller's own Gmail. in_reply_to is the RFC
 *          Message-ID being answered: it sets In-Reply-To/References and
 *          finds the caller's own Gmail thread for it. Written to
 *          communications (outbound, source 'gmail', source_id the new
 *          Message-ID) on the seller/buyer named — checked against the
 *          workspace — or matched by address; deal_id likewise, else the
 *          deal the address or subject points at. test: true sends without
 *          logging (the template editor's "Send test to me").
 *          → { connected, ok, id, thread_id, message_id, message? }
 *          kind: 'bulk' (plans, campaigns, automations) adds List-Unsubscribe
 *          and an unsubscribe line and is held to the sending window, the
 *          spacing and the domain's launch checks. Every kind passes the
 *          mailbox guard (_shared/mailguard.ts) first: suppressions, pause,
 *          daily/hourly caps and the warm-up ramp. A refusal is
 *          { connected, ok: false, code, message, next_at } — nothing sent.
 *
 * Who runs it:
 *   a signed-in member  — syncs their own connection. The app calls this on
 *                         open, after every calendar write (nudgeGoogle) and
 *                         from Sync now. Rate limited per user.
 *   the service role    — { action: 'sync_all' } with the service-role key as
 *                         the bearer posts { action: 'sync_one', account_id,
 *                         part: 'gmail' | 'calendar' } back to this function
 *                         for every active connection (or one workspace, with
 *                         workspace_id), so each mailbox and each calendar
 *                         runs in an isolate of its own. Doing them in one
 *                         isolate exceeded the CPU budget (HTTP 546) and
 *                         never stored a Gmail cursor.
 *                         Migration 71 schedules it: public.google_sync_kick()
 *                         runs from pg_cron ('clozr-google-sync', every five
 *                         minutes) and posts exactly that body with the
 *                         service-role key from the vault. Migration 168 gives
 *                         that HTTP call long enough to finish one mailbox.
 *
 * Every pass is idempotent: an appointment whose sync_state is 'synced' is
 * not touched, a pull with nothing new lists and returns, and running twice
 * in a row costs one list call the second time.
 *
 * Google API scope needed: https://www.googleapis.com/auth/calendar (what
 * google-oauth already asks for). Inviting attendees and sendUpdates need
 * nothing beyond it; the CLOZR calendar is one this account owns.
 *
 * Tokens: exactly as before — the service role reads google_tokens, refreshes
 * through accessFor(), and nothing here returns a token to a browser.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import { type Account, type MailFile, HTML_BODY_MAX, MAX_MESSAGE_BYTES, SCOPE, accessFor, addressesOf, configured, documentForGmail, ensureCalendar, ensureFeeds, fetchAttachment, gmailIdFor, gmailSignature, has, htmlToText, knowPeople, loadBook, looksLikeHtml, messageIdOf, pullGmail, sendMail, textToHtml, threadOf, withSignature } from '../_shared/google.ts';
import { googleSyncWorkspace } from '../_shared/google-scope.ts';
import { instrument, newToken, trackBase } from '../_shared/email-track.ts';
import { type PullResult, type PushResult, pullAppointments, pushAppointments, pushTasks } from './calendar.ts';
import { type Link, linkFor, mergeLink } from '../_shared/gmail-match.ts';
import { guardSend, release, scanBounces, unsubscribeToken, unsubscribeUrl } from '../_shared/mailguard.ts';

type Any = any;
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

/** A connection whose signature has not been read yet (before its first sync since migration 157): read it now and keep it. */
async function signatureNow(admin: SupabaseClient, account: Account, token: string): Promise<string | null> {
  if (!has(account, SCOPE.gmailRead)) return null;
  const sig = await gmailSignature(token, account.email).catch(() => null);
  if (sig === null) return null;
  account.gmail_signature = sig || null;
  await admin.from('google_accounts').update({ gmail_signature: sig || null, gmail_signature_at: new Date().toISOString() }).eq('id', account.id);
  return sig || null;
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const SELECT = 'id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at, gmail_signature, gmail_signature_at';

export type SyncResult = {
  ok: boolean; email: string; status: string;
  calendar: (PushResult & PullResult & { tasks: { created: number; updated: number; removed: number } }) | null;
  gmail: { logged: number; relinked: number; backfilled?: number; filed?: number } | null;
  synced_at?: string;
  message?: string;
};

/** One pass over one connection: mail first (so a heavy calendar read cannot eat the CPU budget before any mail is stored), then the calendar — pull before push, so an edit made on Google is not overwritten. */
async function syncAccount(admin: SupabaseClient, account: Account, opts: { origin: string; workspaceName: string; gmail?: boolean; calendar?: boolean }): Promise<SyncResult> {
  const accessToken = await accessFor(admin, account);
  if (!accessToken) {
    return { ok: false, email: account.email, status: 'needs_reauth', calendar: null, gmail: null, message: 'Google needs this connection approved again.' };
  }
  const out: SyncResult = { ok: true, email: account.email, status: 'active', calendar: null, gmail: null };
  const patch: Any = { last_error: null, status: 'active' };
  const wantGmail = opts.gmail !== false;

  // The user's Gmail signature, so mail sent from CLOZR signs off the way their Gmail does. Once a day is plenty.
  const sigStale = !account.gmail_signature_at || Date.parse(account.gmail_signature_at) < Date.now() - 86_400_000;
  if (wantGmail && sigStale && has(account, SCOPE.gmailRead)) {
    const sig = await gmailSignature(accessToken, account.email).catch(() => null);
    if (sig !== null) { patch.gmail_signature = sig || null; patch.gmail_signature_at = new Date().toISOString(); }
  }

  if (wantGmail && account.gmail_read && has(account, SCOPE.gmailRead)) {
    try {
      const startedAt = new Date();
      const pulled = await pullGmail(admin, account, accessToken, startedAt);
      out.gmail = { logged: pulled.logged, relinked: pulled.relinked, filed: pulled.filed, backfilled: pulled.backfilled };
      // Bounce notices: suppress the address, mark the send, auto-pause past the thresholds. An idle mailbox has none new.
      const b = pulled.idle ? null : await scanBounces(admin, account, accessToken).catch((err) => { console.error('bounce scan failed', { account: account.id, err: String(err) }); return null; });
      if (b) Object.assign(out.gmail, { bounces: b.bounces, paused: b.paused });
      // Not the time the run started: the edge of the mail it actually read.
      // A run that stopped at a message it could not fetch, or at the per-run
      // limit, leaves the cursor there, and the next run picks up from it —
      // stamping startedAt regardless is what used to skip that mail for good.
      // pullGmail also writes this before the history crawl, so a kill during
      // backfill still keeps the edge.
      if (pulled.through) patch.last_gmail_sync_at = pulled.through;
      if (pulled.failed) {
        patch.last_error = 'Some Gmail messages could not be read. The next sync picks up where this one stopped.';
        out.message = patch.last_error;
      }
    } catch (err) {
      console.error('gmail sync failed', { account: account.id, err: String(err) });
      patch.last_error = 'Gmail sync hit an error. It will try again on the next sync.';
      out.message = patch.last_error;
    }
  }

  if (opts.calendar !== false && account.calendar_sync && has(account, SCOPE.calendar)) {
    try {
      await ensureCalendar(admin, account, accessToken, opts.workspaceName);
      // Which calendars to read: the one CLOZR owns, and the member's own
      // primary. Until migration 74 these were the same single calendar, which
      // is why a member's real meetings never appeared — see google.ts.
      const feeds = await ensureFeeds(admin, account, accessToken);
      const { data: peers } = await admin.from('google_accounts').select('id, user_id').eq('workspace_id', account.workspace_id).eq('status', 'active').eq('calendar_sync', true).order('id');
      const accounts = (peers ?? []) as Pick<Account, 'id' | 'user_id'>[];
      if (!accounts.some((a) => a.id === account.id)) accounts.push({ id: account.id, user_id: account.user_id });
      const startedAt = new Date();
      const pulled = await pullAppointments(admin, account, accessToken, feeds);
      const pushed = await pushAppointments(admin, account, accessToken, accounts, opts.origin, feeds);
      const tasks = await pushTasks(admin, account, accessToken, opts.origin);
      // A push changes Google; read the cursors forward so the next pull does
      // not replay our own writes. Only the calendars CLOZR writes to can have
      // moved, so only those are re-read.
      if (pushed.created + pushed.updated + pushed.removed > 0) {
        const { data: after } = await admin.from('google_calendar_feeds')
          .select('calendar_id, summary, writable, enabled, sync_token')
          .eq('account_id', account.id).eq('enabled', true).eq('writable', true);
        // Nothing back means migration 74 is not applied here; the fallback
        // inside pullAppointments re-reads the single calendar off the account.
        const again = (after ?? []) as typeof feeds;
        const fresh = { ...account, sync_token: (await admin.from('google_accounts').select('sync_token').eq('id', account.id).maybeSingle()).data?.sync_token ?? null } as Account;
        await pullAppointments(admin, fresh, accessToken, again).catch(() => null);
      }
      out.calendar = { ...pushed, ...pulled, tasks };
      // Events that did not land are an error to see, not a clean sync.
      if (pulled.pullFailed > 0) throw new Error(pulled.pullFailed + ' calendar events did not save');
      patch.last_calendar_sync_at = startedAt.toISOString();
      out.synced_at = patch.last_calendar_sync_at;
    } catch (err) {
      console.error('calendar sync failed', { account: account.id, err: String(err) });
      patch.last_error = 'Calendar sync hit an error. It will try again on the next sync.';
      out.message = patch.last_error;
      out.ok = false;
    }
  }

  await admin.from('google_accounts').update(patch).eq('id', account.id);
  return out;
}

// ------------------------------------------------------------- attachments
const BUCKET = 'deal-files';
const MAX_FILES = 10;
const safeName = (n: string) => n.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';

type Gathered = { file: MailFile; storage_path: string; deal_file_id: number | null; size: number };

/**
 * Every file a send asked for, read into memory: uploads the caller made to
 * ws/<workspace>/ in the deal-files bucket, files already on a deal, and files
 * on stored email (forwarded). Each is checked against the workspace — the
 * deal and email rows as the caller, so RLS decides — and the whole message
 * must fit under Gmail's limit once base64'd.
 */
async function gatherFiles(admin: SupabaseClient, asCaller: SupabaseClient, ws: number, b: Any): Promise<{ list: Gathered[] } | { error: string; status: number }> {
  const uploads = Array.isArray(b.attachments) ? b.attachments as Any[] : [];
  const dealFileIds = (Array.isArray(b.deal_file_ids) ? b.deal_file_ids : []).map(Number).filter(Number.isFinite);
  const emailFileIds = (Array.isArray(b.email_attachment_ids) ? b.email_attachment_ids : []).map(Number).filter(Number.isFinite);
  if (uploads.length + dealFileIds.length + emailFileIds.length > MAX_FILES) return { error: `${MAX_FILES} files at most`, status: 422 };
  const list: Gathered[] = [];
  let total = 0;
  const add = async (path: string, filename: string, contentType: string | null, dealFileId: number | null) => {
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error(`could not read ${filename}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    total += bytes.length;
    list.push({ file: { filename, contentType: contentType || data.type || 'application/octet-stream', data: bytes }, storage_path: path, deal_file_id: dealFileId, size: bytes.length });
  };
  try {
    for (const u of uploads) {
      const path = String(u?.storage_path ?? '');
      if (!path.startsWith(`ws/${ws}/`) || path.includes('..')) return { error: 'an attachment is not in this workspace', status: 422 };
      await add(path, String(u?.filename || path.split('/').pop() || 'file').slice(0, 180), u?.content_type ? String(u.content_type) : null, null);
    }
    if (dealFileIds.length) {
      const { data } = await asCaller.from('deal_files').select('id, name, storage_path, content_type').eq('workspace_id', ws).in('id', dealFileIds);
      for (const f of (data ?? []) as Any[]) if (f.storage_path) await add(f.storage_path, String(f.name), f.content_type, f.id);
    }
    for (const id of emailFileIds) {
      const got = await attachment(admin, asCaller, ws, id, false);
      if (!got.ok || !got.storage_path) return { error: got.message ?? 'a forwarded file could not be read', status: 422 };
      await add(got.storage_path, got.filename, got.content_type, null);
    }
  } catch (err) {
    return { error: String((err as Error).message ?? err), status: 422 };
  }
  // base64 grows a file by a third; leave room for the body.
  if (total * 1.37 > MAX_MESSAGE_BYTES - 500_000) return { error: 'attachments are over 18 MB — share a link to the larger files instead', status: 413 };
  return { list };
}

/** A sent email's files: listed on the message, and put on its deal's files when it has a deal. */
async function recordSentFiles(admin: SupabaseClient, ws: number, commId: number, dealId: number | null, list: Gathered[]): Promise<void> {
  for (const [i, f] of list.entries()) {
    let dealFileId = f.deal_file_id;
    if (dealId && dealFileId == null) {
      const { data: df } = await admin.from('deal_files').insert({
        workspace_id: ws, deal_id: dealId, kind: f.file.contentType.startsWith('image/') ? 'photo' : 'file',
        name: f.file.filename, storage_path: f.storage_path, content_type: f.file.contentType, byte_size: f.size, source: 'email',
      }).select('id').maybeSingle();
      dealFileId = (df?.id as number | undefined) ?? null;
    }
    const { error } = await admin.from('email_attachments').upsert({
      workspace_id: ws, communication_id: commId, part_key: `sent:${i}`, filename: f.file.filename,
      content_type: f.file.contentType, byte_size: f.size, storage_path: f.storage_path, deal_file_id: dealFileId,
    }, { onConflict: 'communication_id,part_key', ignoreDuplicates: true });
    if (error) console.error('email_attachments (sent) failed', error.message);
  }
}

type Fetched = { ok: boolean; message?: string; url?: string | null; storage_path?: string; filename: string; content_type: string | null; deal_file_id?: number | null };

/**
 * One file on a stored email, as a short-lived link. A received file is read
 * from the Gmail that stored it the first time and kept in the bucket, so the
 * next open, a forward and "save to deal" do not go back to Google.
 */
async function attachment(admin: SupabaseClient, asCaller: SupabaseClient, ws: number, id: number, saveToDeal: boolean): Promise<Fetched> {
  if (!Number.isFinite(id)) return { ok: false, message: 'attachment_id is required', filename: '', content_type: null };
  // As the caller: RLS says whether they may see it at all.
  const { data: a } = await asCaller.from('email_attachments')
    .select('id, communication_id, part_key, filename, content_type, byte_size, account_id, gmail_message_id, storage_path, deal_file_id')
    .eq('id', id).eq('workspace_id', ws).maybeSingle();
  if (!a) return { ok: false, message: 'That file is not here.', filename: '', content_type: null };
  let path = a.storage_path as string | null;
  if (!path) {
    if (!a.account_id || !a.gmail_message_id) return { ok: false, message: 'That file is no longer in Gmail.', filename: a.filename, content_type: a.content_type };
    const { data: acct } = await admin.from('google_accounts').select(SELECT).eq('id', a.account_id).maybeSingle();
    const token = acct ? await accessFor(admin, acct as Account) : null;
    if (!token) return { ok: false, message: 'The mailbox that has this file needs reconnecting.', filename: a.filename, content_type: a.content_type };
    const bytes = await fetchAttachment(token, a.gmail_message_id, a.part_key);
    if (!bytes) return { ok: false, message: 'Gmail did not return that file.', filename: a.filename, content_type: a.content_type };
    path = `ws/${ws}/email/${a.communication_id}/${a.id}-${safeName(a.filename)}`;
    const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: a.content_type || 'application/octet-stream', upsert: true });
    if (up.error) throw new Error('attachment upload failed: ' + up.error.message);
    await admin.from('email_attachments').update({ storage_path: path }).eq('id', a.id);
  }
  let dealFileId = a.deal_file_id as number | null;
  if (saveToDeal && dealFileId == null) {
    const { data: c } = await asCaller.from('communications').select('deal_id').eq('id', a.communication_id).maybeSingle();
    if (!c?.deal_id) return { ok: false, message: 'File this email on a deal first.', filename: a.filename, content_type: a.content_type };
    // The Gmail sync may already have filed it on its own (deal_files.communication_id, migration 80).
    const { data: already } = await admin.from('deal_files').select('id').eq('deal_id', c.deal_id)
      .eq('communication_id', a.communication_id).eq('name', a.filename).limit(1).maybeSingle();
    if (already?.id) {
      await admin.from('email_attachments').update({ deal_file_id: already.id }).eq('id', a.id);
      return { ok: true, url: (await admin.storage.from(BUCKET).createSignedUrl(path, 3600, { download: a.filename })).data?.signedUrl ?? null, storage_path: path, filename: a.filename, content_type: a.content_type, deal_file_id: already.id as number };
    }
    const { data: df, error } = await admin.from('deal_files').insert({
      workspace_id: ws, deal_id: c.deal_id, kind: /^image\//.test(a.content_type ?? '') ? 'photo' : 'file',
      name: a.filename, storage_path: path, content_type: a.content_type, byte_size: a.byte_size, source: 'email',
    }).select('id').maybeSingle();
    if (error) throw new Error('deal file insert failed: ' + error.message);
    dealFileId = (df?.id as number | undefined) ?? null;
    await admin.from('email_attachments').update({ deal_file_id: dealFileId }).eq('id', a.id);
  }
  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600, { download: a.filename });
  return { ok: true, url: signed?.signedUrl ?? null, storage_path: path, filename: a.filename, content_type: a.content_type, deal_file_id: dealFileId };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const projectUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false } });
  if (!configured()) return json({ error: 'Google is not set up on this project yet.' }, 503);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const defaultOrigin = String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');

  // ------------------------------------------------------- the scheduled run
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const isService = await isServiceCaller(admin, bearer);
  if (b.action === 'sync_all') {
    // The vault's key (migration 71) and this runtime's env key are both
    // service-role JWTs but need not be the same issue, so an exact match
    // alone refused every scheduled run with a 403 and the five-minute sync
    // never ran once. isServiceCaller accepts exactly either key.
    if (!isService) return json({ error: 'sync_all is for the service role' }, 403);
    let q = admin.from('google_accounts').select('id, gmail_read, scopes, calendar_sync, last_calendar_sync_at').eq('status', 'active').order('id');
    if (Number.isFinite(Number(b.workspace_id))) q = q.eq('workspace_id', Number(b.workspace_id));
    const { data: accounts } = await q;
    // Every connection's mail and calendar each run in an invoke of their
    // own (sync_one below), so each gets the isolate's whole CPU budget.
    // Running them in this isolate one after another hit CPU Time exceeded
    // (546) on the first mailbox every tick, and since the stalest mailbox
    // always went first, the rest never got a Gmail pass at all.
    // Mail every tick (an idle mailbox costs one profile call). The calendar
    // every third tick: CLOZR's own writes push at once through the app's
    // nudge, so this only brings in edits made on Google.
    const jobs: { account_id: number; part: 'gmail' | 'calendar' }[] = [];
    const calendarDue = (a: Account) => !a.last_calendar_sync_at || Date.parse(a.last_calendar_sync_at) < Date.now() - 14 * 60_000;
    for (const a of (accounts ?? []) as Account[]) {
      if (a.gmail_read && has(a, SCOPE.gmailRead)) jobs.push({ account_id: a.id, part: 'gmail' });
      if (a.calendar_sync && has(a, SCOPE.calendar) && calendarDue(a)) jobs.push({ account_id: a.id, part: 'calendar' });
    }
    const self = `${projectUrl.replace(/\/$/, '')}/functions/v1/google-sync`;
    const dispatch = Promise.allSettled(jobs.map(async (j) => {
      const res = await fetch(self, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ action: 'sync_one', ...j }),
      });
      if (!res.ok) console.error('sync_one failed', { ...j, status: res.status });
      await res.body?.cancel();
    }));
    EdgeRuntime.waitUntil(dispatch);
    return json({ ok: true, dispatched: jobs.length });
  }

  if (b.action === 'sync_one') {
    if (!isService) return json({ error: 'sync_one is for the service role' }, 403);
    const part = b.part === 'gmail' ? 'gmail' : 'calendar';
    const { data: row } = await admin.from('google_accounts').select(SELECT).eq('id', Number(b.account_id)).eq('status', 'active').maybeSingle();
    if (!row) return json({ ok: false, message: 'no such active connection' }, 404);
    const a = row as Account;
    // Mail and calendar lock separately, so a long Gmail pass does not stop
    // the calendar from moving, and a tab's sync does not double either.
    const lock = await rateLimit(admin, part === 'gmail' ? `google-sync-mail:${a.id}` : `google-sync-run:${a.id}`, 1, part === 'gmail' ? 120 : 90);
    if (!lock.allowed) return json({ ok: true, skipped: true, part, account_id: a.id });
    const { data: w } = await admin.from('workspaces').select('name').eq('id', googleSyncWorkspace(a)).maybeSingle();
    const r = await syncAccount(admin, a, {
      origin: defaultOrigin,
      workspaceName: String(w?.name ?? 'CLOZR'),
      gmail: part === 'gmail',
      calendar: part === 'calendar',
    });
    return json({ ...r, part, account_id: a.id, workspace_id: googleSyncWorkspace(a) });
  }

  // ------------------------------------------------------------ a member
  const asCaller = createClient(projectUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: workspace } = await asCaller.from('workspaces').select('id, name').eq('id', ws).maybeSingle();
  if (!workspace) return json({ error: 'not a member of that workspace' }, 403);

  // The sync runs on app open and after every calendar write, so the limit
  // is generous; it is here to stop a loop in a tab from hammering Google.
  const rl = await rateLimit(admin, `google-sync:${who.user.id}:${clientIp(req)}`, 60, 300);
  if (!rl.allowed) return tooMany(cors, rl);

  if (b.action === 'email_html') {
    try {
      const id = Number(b.communication_id);
      if (!Number.isFinite(id)) return json({ error: 'communication_id is required' }, 422);
      const { data: row } = await asCaller.from('communications')
        .select('id, body, source, source_id, channel')
        .eq('id', id).eq('workspace_id', ws).maybeSingle();
      if (!row || row.channel !== 'email') return json({ html: null, text: null });
      if (looksLikeHtml(row.body)) return json({ html: row.body, text: htmlToText(String(row.body)) });
      const plain = typeof row.body === 'string' ? row.body : null;
      if (row.source !== 'gmail' || !row.source_id) return json({ html: null, text: plain });
      const { data: boxes } = await admin.from('communication_mailboxes')
        .select('account_id, user_id').eq('communication_id', id).eq('workspace_id', ws);
      const list = (boxes ?? []) as { account_id: number; user_id: string }[];
      const mine = list.find((x) => x.user_id === who.user.id) ?? list[0];
      if (!mine) return json({ html: null, text: plain });
      const { data: acct } = await admin.from('google_accounts').select(SELECT).eq('id', mine.account_id).maybeSingle();
      const token = acct ? await accessFor(admin, acct as Account) : null;
      if (!token) return json({ html: null, text: plain });
      const gmailId = await gmailIdFor(token, String(row.source_id));
      if (!gmailId) return json({ html: null, text: plain });
      const resolved = await documentForGmail(token, gmailId);
      const html = resolved.html && resolved.html.length <= 400_000 ? resolved.html : '';
      if (html && html.length <= HTML_BODY_MAX) {
        await admin.from('communications').update({ body: html }).eq('id', id).eq('workspace_id', ws);
      }
      return json({ html: html || null, text: resolved.text || plain });
    } catch (err) {
      return serverError(cors, 'google-sync email_html', err);
    }
  }

  if (b.action === 'attachment') {
    try {
      return json(await attachment(admin, asCaller, ws, Number(b.attachment_id), b.save_to_deal === true));
    } catch (err) {
      return serverError(cors, 'google-sync attachment', err);
    }
  }

  const { data } = await admin.from('google_accounts').select(SELECT).eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  const account = data as Account | null;
  if (!account) return json({ connected: false });
  if (account.status !== 'active') return json({ connected: true, ok: false, status: account.status, message: 'Google needs this connection approved again.' });

  const origin = String(b.origin || req.headers.get('origin') || defaultOrigin).replace(/\/$/, '');
  // A write nudge is calendar-only; a full Sync now / timer pass still does mail.
  // Skipping Gmail on the hot path is what keeps a busy calendar from stacking
  // concurrent pulls that each burn the isolate's CPU budget (status 546).
  const calendarOnly = b.action === 'calendar' || b.parts === 'calendar';

  try {
    if (b.action === 'test') {
      if (!account.gmail_send || !has(account, SCOPE.gmailSend)) return json({ connected: true, ok: false, message: 'Gmail sending is not switched on for this connection.' });
      const token = await accessFor(admin, account);
      if (!token) return json({ connected: true, ok: false, status: 'needs_reauth', message: 'Google needs this connection approved again.' });
      const claim = await guardSend(admin, account, [account.email], 'transactional');
      if (!claim.ok) return json({ connected: true, ok: false, message: claim.message });
      const sent = await sendMail(token, {
        to: account.email,
        subject: 'CLOZR is connected to your Gmail',
        html: `<p>This is CLOZR, sending from your own address.</p><p>Contracts, signing links and offer letters will go out from here, which is why they land in the inbox instead of the promotions tab.</p><p style="color:#71717a;font-size:12px">Sent from ${origin}</p>`,
      });
      if (!sent) await release(admin, claim.ids);
      return json({ connected: true, ok: !!sent, message: sent ? `Sent to ${account.email}.` : 'Gmail refused that send.' });
    }

    if (b.action === 'send_email') {
      if (!account.gmail_send || !has(account, SCOPE.gmailSend)) return json({ connected: true, ok: false, message: 'Gmail sending is not switched on for this connection.' });
      const to = addressesOf(String(b.to ?? ''));
      const cc = addressesOf(String(b.cc ?? '')).filter((a) => !to.includes(a));
      const bcc = addressesOf(String(b.bcc ?? '')).filter((a) => !to.includes(a) && !cc.includes(a));
      const everyone = [...to, ...cc, ...bcc];
      const valid = (a: string) => /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(a);
      if (!to.length || to.length > 10 || !everyone.every(valid)) return json({ error: 'to must be one to ten email addresses' }, 422);
      if (everyone.length > 20) return json({ error: 'twenty recipients at most, To, Cc and Bcc together' }, 422);
      const subject = String(b.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
      const html = typeof b.body_html === 'string' && b.body_html.trim() ? b.body_html : null;
      const text = typeof b.body_text === 'string' && b.body_text.trim() ? b.body_text : null;
      if (!subject) return json({ error: 'subject is required' }, 422);
      if (!html && !text) return json({ error: 'body_html or body_text is required' }, 422);
      if ((html?.length ?? 0) + (text?.length ?? 0) > 400_000) return json({ error: 'that email is too large' }, 413);
      const inReplyTo = typeof b.in_reply_to === 'string' && /^<[^<>\s]+>$/.test(b.in_reply_to.trim()) ? b.in_reply_to.trim() : null;

      // Sending as someone is the part worth a tighter limit than the sync.
      const sendRl = await rateLimit(admin, `google-send:${who.user.id}`, 120, 3600);
      if (!sendRl.allowed) return tooMany(cors, sendRl);

      // What kind of send decides which protections apply (_shared/mailguard.ts):
      // a test to yourself is transactional; anything a plan, campaign or
      // automation sends must say kind: 'bulk' and goes one recipient at a time.
      const kind = b.test === true ? 'transactional' : b.kind === 'bulk' ? 'bulk' : 'one_to_one';
      if (kind === 'bulk' && (to.length !== 1 || cc.length || bcc.length)) return json({ error: 'bulk email goes to one recipient per message' }, 422);

      // The files, gathered before anything is claimed or sent.
      const files = await gatherFiles(admin, asCaller, ws, b);
      if ('error' in files) return json({ error: files.error }, files.status);

      const token = await accessFor(admin, account);
      if (!token) return json({ connected: true, ok: false, status: 'needs_reauth', message: 'Google needs this connection approved again.' });
      const claim = await guardSend(admin, account, everyone, kind, { allowUnverified: b.allowUnverified === true });
      if (!claim.ok) return json({ connected: true, ok: false, code: claim.code, message: claim.message, next_at: claim.next_at, suppressed: claim.suppressed ?? [] });

      let bodyText = text ?? htmlToText(html!);
      let bodyHtml = html ?? textToHtml(text!);
      // Signed the way the user signs in Gmail, unless the caller says not (b.signature === false).
      if (b.signature !== false) {
        const sig = account.gmail_signature ?? await signatureNow(admin, account, token);
        ({ html: bodyHtml, text: bodyText } = withSignature(bodyHtml, bodyText, sig));
      }
      let headers: Record<string, string> | undefined;
      if (kind === 'bulk') {
        // RFC 8058 one-click unsubscribe, which Gmail and Yahoo require of bulk
        // senders, plus a plain line a person can find and click.
        const link = unsubscribeUrl(await unsubscribeToken({ w: ws, e: to[0], a: account.id }));
        headers = { 'List-Unsubscribe': `<${link}>, <mailto:${account.email}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
        bodyText += `\n\n--\nDon't want these emails? Unsubscribe: ${link}`;
        bodyHtml += `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#71717a;margin-top:24px">Don't want these emails? <a href="${esc(link)}" style="color:#71717a">Unsubscribe</a></p>`;
      }
      // Read receipts: on unless the caller says not, never on a test or on bulk mail.
      const tracked = kind === 'one_to_one' && b.track !== false;
      let trackToken: string | null = null;
      if (tracked) {
        const tok = newToken();
        const { error: tErr } = await admin.from('email_tracking').insert({
          token: tok, workspace_id: ws, user_id: who.user.id, recipients: everyone.join(', ').slice(0, 1000), subject,
        });
        // Before migration 82 there is no table: send untracked rather than not at all.
        if (!tErr) {
          const done = instrument(bodyHtml, tok, trackBase());
          if (done.links.length) await admin.from('email_tracking_links').insert(done.links.map((url, idx) => ({ token: tok, idx, url })));
          bodyHtml = done.html;
          trackToken = tok;
        } else console.error('email tracking skipped', tErr.message);
      }

      const sent = await sendMail(token, {
        to: to.join(', '), cc: cc.join(', ') || null, bcc: bcc.join(', ') || null, subject, html: bodyHtml, text: bodyText, headers,
        attachments: files.list.map((f) => f.file),
        inReplyTo, threadId: inReplyTo ? await threadOf(token, inReplyTo) : null,
      });
      if (!sent) {
        await release(admin, claim.ids);
        if (trackToken) await admin.from('email_tracking').delete().eq('token', trackToken);
        return json({ connected: true, ok: false, message: 'Gmail refused that send.' });
      }
      if (b.test === true) return json({ connected: true, ok: true, id: sent.id, thread_id: sent.threadId, message_id: null });

      const messageId = (await messageIdOf(token, sent.id)) ?? `gmail:${sent.id}`;
      // The record it belongs on: what the caller named, if RLS lets them see
      // it in this workspace, else whoever owns the address.
      const own = async (table: 'sellers' | 'buyers' | 'vendors', id: unknown) => {
        const n = Number(id);
        if (!id || !Number.isFinite(n)) return null;
        const { data: row } = await asCaller.from(table).select('id').eq('id', n).eq('workspace_id', ws).maybeSingle();
        return row ? n : null;
      };
      const named = { seller_id: await own('sellers', b.seller_id), buyer_id: await own('buyers', b.buyer_id), vendor_id: await own('vendors', b.vendor_id) };
      const anyNamed = named.seller_id != null || named.buyer_id != null || named.vendor_id != null;
      // The deal: the one the caller named, else the named seller's latest,
      // else whatever the Gmail pull would have filed it under (gmail-match.ts).
      // Before, a send from CLOZR carried no deal at all and never reached the
      // deal's history.
      const dealId = Number(b.deal_id);
      const { data: namedDeal } = b.deal_id && Number.isFinite(dealId)
        ? await asCaller.from('deals').select('id, property_id').eq('id', dealId).eq('workspace_id', ws).maybeSingle()
        : { data: null };
      let link = { ...named, deal_id: (namedDeal?.id as number | undefined) ?? null, property_id: (namedDeal?.property_id as number | null | undefined) ?? null };
      if (!namedDeal || !anyNamed) {
        const { book } = await loadBook(admin, ws);
        book.ours.add(account.email.toLowerCase());
        await knowPeople(admin, ws, book, to);
        const found = linkFor(book, to, subject);
        const sellerDeal = named.seller_id != null ? book.dealsBySeller.get(named.seller_id)?.[0] : undefined;
        if (!anyNamed) link = { ...link, seller_id: found.seller_id, buyer_id: found.buyer_id, vendor_id: found.vendor_id };
        if (!namedDeal) {
          const d = sellerDeal ? { deal_id: sellerDeal.id, property_id: sellerDeal.property_id } : { deal_id: found.deal_id, property_id: found.property_id };
          link = { ...link, ...d };
        }
      }
      // A reply files where the message it answers was filed, for whatever the rules above left empty.
      if (inReplyTo) {
        const { data: parent } = await admin.from('communications').select('seller_id, buyer_id, vendor_id, deal_id, property_id')
          .eq('workspace_id', ws).eq('source', 'gmail').eq('source_id', inReplyTo).limit(1).maybeSingle();
        if (parent) link = mergeLink(link, parent as Link);
      }
      const base = {
        workspace_id: ws, ...link, channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(),
        subject,
        // A designed send keeps its HTML. A plain send stays plain text, which is what the record already shows.
        body: html && html.length <= HTML_BODY_MAX ? html : bodyText.slice(0, 20_000),
        from_email: account.email.toLowerCase(), to_email: to.join(', '),
        status: 'sent', source: 'gmail', source_id: messageId,
      };
      let { data: row, error } = await admin.from('communications')
        .upsert({ ...base, cc_email: cc.join(', ') || null, bcc_email: bcc.join(', ') || null }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
      // Before migration 82: no cc/bcc columns, Cc rides in to_email as the pull always wrote it.
      if (error && /cc_email|bcc_email/.test(error.message)) {
        ({ data: row, error } = await admin.from('communications')
          .upsert({ ...base, to_email: [...to, ...cc].join(', ') }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle());
      }
      if (error) console.error('email sent but not recorded', error.message);
      const commId = (row?.id as number | undefined) ?? null;
      if (commId) {
        await admin.from('communication_mailboxes').upsert({ communication_id: commId, account_id: account.id, workspace_id: ws, user_id: account.user_id }, { onConflict: 'communication_id,account_id', ignoreDuplicates: true })
          .then(({ error: e }) => { if (e) console.error('mailbox link failed', e.message); });
        if (trackToken) await admin.from('email_tracking').update({ communication_id: commId }).eq('token', trackToken);
        await recordSentFiles(admin, ws, commId, link.deal_id, files.list);
      }
      return json({ connected: true, ok: true, id: sent.id, thread_id: sent.threadId, message_id: messageId, communication_id: commId, seller_id: link.seller_id, buyer_id: link.buyer_id, deal_id: link.deal_id, tracked: !!trackToken });
    }

    if (b.action === 'mail') {
      if (!account.gmail_send || !has(account, SCOPE.gmailSend)) return json({ connected: true, emailed: 0, reason: 'gmail-off' });
      const contractId = Number(b.contract_id);
      if (!Number.isFinite(contractId)) return json({ error: 'contract_id is required' }, 422);
      // Read the contract as the caller so RLS decides whether they may see it;
      // the signing tokens themselves are service-role only and never leave here.
      const { data: contract } = await asCaller.from('contracts').select('id, name, message, workspace_id').eq('id', contractId).eq('workspace_id', ws).maybeSingle();
      if (!contract) return json({ error: 'contract not found' }, 404);
      const token = await accessFor(admin, account);
      if (!token) return json({ connected: true, ok: false, status: 'needs_reauth', emailed: 0 });

      const { data: signers } = await admin.from('contract_signers').select('name, email, token, status, delivery, recipient_type').eq('contract_id', contractId).order('sort');
      const { data: wsRow } = await admin.from('workspaces').select('settings, name').eq('id', ws).maybeSingle();
      const company = String(((wsRow?.settings as { company?: { name?: string } } | null)?.company?.name) || wsRow?.name || 'Acme Homes');
      const message = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : (contract.message as string | null);

      let emailed = 0;
      for (const s of signers ?? []) {
        // Answered, handed to someone else (migration 114), or reached by text only: no email.
        if (!s.email || ['signed', 'declined', 'delegated', 'approved', 'rejected'].includes(s.status) || s.delivery === 'sms') continue;
        // A CC or viewer is copied, never asked to "review and sign"; an approver has its own mail.
        if (['cc', 'viewer', 'approver'].includes(String(s.recipient_type ?? 'signer'))) continue;
        // One-off signing links skip the caps but are counted, and never go to an address that hard-bounced.
        const claim = await guardSend(admin, account, [s.email], 'transactional');
        if (!claim.ok) continue;
        const link = `${origin}/sign/?t=${s.token}`;
        const html = `<p>Hi ${esc(String(s.name ?? '').split(' ')[0] || 'there')},</p>`
          + `<p>${esc(company)} has sent you <strong>${esc(String(contract.name))}</strong> to review and sign.</p>`
          + (message ? `<p>${esc(message)}</p>` : '')
          + `<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#0A8560;color:#fff;border-radius:8px;text-decoration:none">Review and sign</a></p>`
          + `<p style="color:#71717a;font-size:12px">Or open this link: ${esc(link)}</p>`;
        const signed = withSignature(html, htmlToText(html), account.gmail_signature ?? await signatureNow(admin, account, token)).html;
        if (await sendMail(token, { to: s.email, subject: `${contract.name} — please review and sign`, html: signed })) emailed++;
        else await release(admin, claim.ids);
      }
      return json({ connected: true, ok: true, emailed });
    }

    // A background pass (the open tab's timer, a record opening) skips the
    // calendar when it was read in the last five minutes: every open tab ran
    // a full pull and push every five minutes on top of the cron, about 960
    // calendar passes a day, each reading appointments, tasks and sellers.
    // A write nudge (no if_stale) still pushes at once.
    const calFresh = !!b.if_stale && !!account.last_calendar_sync_at && Date.parse(account.last_calendar_sync_at) > Date.now() - 5 * 60_000;
    if (calFresh && calendarOnly) return json({ connected: true, ok: true, skipped: true, message: 'Calendar synced in the last five minutes.' });

    // One sync at a time per connection. Overlapping invokes (tab timer +
    // nudge + focus) used to pile up until every one hit CPU Time exceeded.
    // 90s is long enough for a healthy pass and short enough that a stuck
    // slot does not block the next cron.
    const runLock = await rateLimit(admin, `google-sync-run:${account.id}`, 1, 90);
    if (!runLock.allowed) {
      return json({ connected: true, ok: true, skipped: true, message: 'A sync is already running.' });
    }

    const mailLock = calendarOnly ? null : await rateLimit(admin, `google-sync-mail:${account.id}`, 1, 120);
    const out = await syncAccount(admin, account, {
      origin, workspaceName: String(workspace.name ?? 'CLOZR'), gmail: !!mailLock?.allowed, calendar: !calFresh,
    });
    return json({ connected: true, ...out });
  } catch (err) {
    return serverError(cors, 'google-sync', err);
  }
});
