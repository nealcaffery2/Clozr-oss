// Google, from the browser's side: one button, then it is connected.
//
// Everything secret stays on the server. What happens here is a popup pointed
// at Google's own consent screen, and a message back from the page Google
// redirects to when the user says yes. No code to copy, no URL to paste into
// Calendar, no token in this file or in localStorage.

import { supabase } from './supabase';
import { isReadOnly } from './read-only';
import type { GoogleAccountRow } from './database.types';

export type GoogleAccount = GoogleAccountRow;

export type GoogleStatus = {
  /** Whether the project has a Google OAuth client at all. */
  configured: boolean;
  /** The redirect URI to register in Google Cloud — shown when it is not. */
  redirect_uri: string;
  account: GoogleAccount | null;
  team: Pick<GoogleAccount, 'id' | 'user_id' | 'email' | 'scopes' | 'calendar_sync' | 'gmail_send' | 'gmail_read' | 'status' | 'last_calendar_sync_at' | 'last_gmail_sync_at' | 'last_error' | 'connected_at'>[];
};

export type SyncSummary = {
  connected: boolean;
  ok?: boolean;
  status?: string;
  /**
   * What one pass did. created/updated/removed went to Google (invited is
   * how many attendees Google emailed); applied/added/deleted came back from
   * it; `full` means the incremental token had expired and the calendar was
   * re-read; `tasks` is the one-way reminder push.
   */
  calendar: {
    created: number; updated: number; removed: number; invited: number; failed: number;
    applied: number; added: number; deleted: number; full: boolean;
    tasks: { created: number; updated: number; removed: number };
  } | null;
  /** logged: new emails on records; relinked: older ones that just found their seller or buyer. */
  gmail: { logged: number; relinked?: number } | null;
  /** When the calendar pass started, ISO. */
  synced_at?: string;
  message?: string;
};

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

/** One in-flight sync per workspace in this tab — overlapping invokes were stacking until every one hit CPU Time exceeded (546). */
const inflightSync = new Map<number, Promise<Result<SyncSummary>>>();

async function call<T>(fn: 'google-oauth' | 'google-sync' | 'drive-photos', body: Record<string, unknown>): Promise<Result<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        // Platform kills (504/546) often return an empty body with no CORS
        // headers; treat them as a soft miss rather than a user-facing failure.
        if (ctx.status === 504 || ctx.status === 546) {
          return { ok: false, message: 'Google sync timed out. It will try again on the next pass.' };
        }
        message = ((await ctx.json()) as { error?: string }).error ?? message;
      }
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

export const googleStatus = (workspaceId: number) =>
  call<GoogleStatus>('google-oauth', { workspace_id: workspaceId, action: 'status' });

export const disconnectGoogle = (workspaceId: number) =>
  call<{ ok: boolean }>('google-oauth', { workspace_id: workspaceId, action: 'disconnect' });

/** `ifStale`: a background pass; the function skips the calendar when it was read in the last five minutes. */
export function syncGoogle(workspaceId: number, opts: { calendarOnly?: boolean; ifStale?: boolean } = {}): Promise<Result<SyncSummary>> {
  const existing = inflightSync.get(workspaceId);
  if (existing) return existing;
  const action = opts.calendarOnly ? 'calendar' : 'sync';
  const p = call<SyncSummary>('google-sync', {
    workspace_id: workspaceId, action, origin: typeof window !== 'undefined' ? window.location.origin : '',
    ...(opts.ifStale ? { if_stale: true } : {}),
  }).finally(() => {
    if (inflightSync.get(workspaceId) === p) inflightSync.delete(workspaceId);
  });
  inflightSync.set(workspaceId, p);
  return p;
}

export const testGoogleMail = (workspaceId: number) =>
  call<{ ok: boolean; message: string }>('google-sync', { workspace_id: workspaceId, action: 'test' });

/** A file the caller uploaded to the deal-files bucket (ws/<workspace>/…) for a send. */
export type OutgoingFile = { storage_path: string; filename: string; content_type?: string | null };

export type SendEmailInput = {
  to: string; subject: string; body_html?: string; body_text?: string;
  /** More addresses, comma separated; twenty recipients in all. Bcc is delivered but only the sender's copy shows it. */
  cc?: string; bcc?: string;
  /** Files: uploaded for this send, already on a deal, or on stored email (a forward). 18 MB in all. */
  attachments?: OutgoingFile[]; deal_file_ids?: number[]; email_attachment_ids?: number[];
  /** Read receipt and counted links. On by default for one-to-one mail. */
  track?: boolean;
  /** File it on this deal rather than the one the address points at. */
  deal_id?: number | null;
  /** The RFC Message-ID being answered, so it threads in both inboxes. */
  in_reply_to?: string | null;
  seller_id?: number | null; buyer_id?: number | null;
  /** A vendor list's bulk send (Wholesalers, Lenders, …): logged on the vendor. */
  vendor_id?: number | null;
  /** Send without writing it onto a record — "Send test to me". */
  test?: boolean;
  /**
   * 'bulk' for anything a plan, campaign or automation sends: one recipient,
   * List-Unsubscribe added, held to the mailbox's window and spacing and to the
   * domain's launch checks. Default one_to_one.
   */
  kind?: 'one_to_one' | 'bulk';
};

export type SendEmailResult = {
  connected: boolean; ok?: boolean; status?: string; message?: string;
  /** Set when the mailbox guard refused the send (nothing went out): paused, daily_cap, hourly_cap, gap, window, suppressed, domain. */
  code?: string; next_at?: string | null;
  message_id?: string | null; seller_id?: number | null; buyer_id?: number | null;
  /** The communications row the send was written to (not on a test send). */
  communication_id?: number | null;
  deal_id?: number | null;
  /** Whether a read receipt went out with it. */
  tracked?: boolean;
};

/** One email from the signed-in member's own Gmail, logged on the record it was to. */
export const sendEmail = (workspaceId: number, input: SendEmailInput) =>
  call<SendEmailResult>('google-sync', { workspace_id: workspaceId, action: 'send_email', ...input });

/** Upload a file from the composer, ready to attach. Kept under ws/<workspace>/email/outgoing/. */
export async function uploadOutgoing(workspaceId: number, file: File): Promise<Result<OutgoingFile>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (file.size > 18 * 1024 * 1024) return { ok: false, message: `${file.name} is over 18 MB — share a link instead.` };
  const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const path = `ws/${workspaceId}/email/outgoing/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const up = await supabase.storage.from('deal-files').upload(path, file, { contentType: file.type || undefined });
  if (up.error) return { ok: false, message: `${file.name}: ${up.error.message}` };
  return { ok: true, data: { storage_path: path, filename: file.name, content_type: file.type || null } };
}

export type AttachmentLink = { ok: boolean; message?: string; url?: string | null; filename: string; deal_file_id?: number | null };

/**
 * The designed HTML of one stored email, when Gmail has it and the row does not.
 * The row is updated server-side when the document fits, so the next open is local.
 */
export const emailHtml = (workspaceId: number, communicationId: number) =>
  call<{ html: string | null; text: string | null }>('google-sync', { workspace_id: workspaceId, action: 'email_html', communication_id: communicationId });

/** A link to a file on a stored email; with saveToDeal, also put it on the email's deal's files. */
export const emailAttachment = (workspaceId: number, attachmentId: number, saveToDeal = false) =>
  call<AttachmentLink>('google-sync', { workspace_id: workspaceId, action: 'attachment', attachment_id: attachmentId, save_to_deal: saveToDeal });

/**
 * Email a contract's signing links from the sender's own Gmail.
 *
 * The contract engine mints the links; this puts them in front of the signer
 * as a message from a person they have been talking to. Nothing sensitive
 * crosses the wire — the call names a contract, and the server reads the
 * one-time tokens itself.
 */
export const mailSignerLinks = (workspaceId: number, contractId: number, message?: string | null) =>
  call<{ connected: boolean; emailed: number }>('google-sync', {
    workspace_id: workspaceId, action: 'mail', contract_id: contractId,
    message: message ?? null, origin: typeof window !== 'undefined' ? window.location.origin : '',
  });

/** The three switches a member owns on their own connection. */
export async function setGoogleSync(
  accountId: number,
  patch: Partial<Pick<GoogleAccount, 'calendar_sync' | 'gmail_send' | 'gmail_read'>>,
): Promise<Result<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('google_accounts').update(patch).eq('id', accountId);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

/**
 * Connect. Opens Google's consent screen in a popup and resolves when the user
 * comes back through it.
 *
 * The window is opened first, empty, and pointed at Google once the server has
 * minted the URL: a popup opened inside the click is allowed, one opened later
 * from an async callback is blocked. If the browser blocks it anyway, this
 * falls back to navigating the tab, and the callback page offers the way back.
 */
export async function connectGoogle(
  workspaceId: number,
  opts: { gmailRead?: boolean; postmaster?: boolean; drive?: boolean } = {},
): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  if (typeof window === 'undefined') return { ok: false, message: 'Only from the browser.' };
  // Added to the Home Screen, a popup opens in an in-app browser with no way
  // back to this window, so the connect never reports in. Go through Google
  // in this window instead; its callback lands back on /app?google=…, which
  // the app already reads (a normal browser tab is unaffected).
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches === true;
  const popup = standalone ? null : window.open('', 'clozr-google', 'width=520,height=700,menubar=no,toolbar=no');

  const started = await call<{ url: string }>('google-oauth', {
    workspace_id: workspaceId, action: 'start', gmail_read: opts.gmailRead !== false, postmaster: opts.postmaster === true, drive: opts.drive === true,
  });
  if (!started.ok) { popup?.close(); return { ok: false, message: started.message }; }

  if (!popup || popup.closed) { window.location.assign(started.data.url); return { ok: false, message: 'Opening Google…' }; }
  popup.location.href = started.data.url;

  return await new Promise((resolve) => {
    const finish = (r: { ok: true; detail: string } | { ok: false; message: string }) => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(watch);
      window.clearTimeout(giveUp);
      resolve(r);
    };
    function onMessage(e: MessageEvent) {
      // Google's callback redirects back into CLOZR rather than rendering a
      // page of its own, so the window reporting in is one of ours — and this
      // origin is the only one whose word is taken for it.
      if (e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; ok?: boolean; detail?: string } | null;
      if (!d || d.source !== 'clozr-google') return;
      finish(d.ok ? { ok: true, detail: String(d.detail ?? 'Connected.') } : { ok: false, message: String(d.detail ?? 'Not connected.') });
    }
    window.addEventListener('message', onMessage);
    // Closing the popup without approving is an answer too — but Google's
    // pages cut the popup's link back here (Cross-Origin-Opener-Policy), so a
    // popup that approved can also read as closed with no message. Ask the
    // server before calling it a failure.
    const startedAt = Date.now();
    let checking = false;
    const watch = window.setInterval(() => {
      if (!popup.closed || checking) return;
      checking = true;
      void googleStatus(workspaceId).then((r) => {
        const at = r.ok && r.data.account?.connected_at ? Date.parse(r.data.account.connected_at) : 0;
        finish(at >= startedAt - 5_000 ? { ok: true, detail: `${r.ok ? r.data.account?.email ?? 'Google' : 'Google'} is connected.` } : { ok: false, message: 'Closed before Google finished.' });
      });
    }, 700);
    const giveUp = window.setTimeout(() => { try { popup.close(); } catch { /* already gone */ } finish({ ok: false, message: 'Google took too long. Try again.' }); }, 5 * 60_000);
  });
}

/** Everything the calendar half needs granted, and everything the mail half does. */
export const GOOGLE_SCOPE = {
  calendar: 'https://www.googleapis.com/auth/calendar',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
} as const;

// ---- the Drive deals folder (drive-photos `tree_*`, migration 139) ----------
export type DriveTreeNotes = {
  at: string; counts: { folders: number; files: number; photos: number; matched: number; unmatched: number; calls: number };
  first_pass: boolean; folders_left: number; unmatched: string[]; unmatched_total: number; deal_folders: number;
};
export type DriveTreeStatus = {
  email: string | null; drive_connected: boolean;
  config: { root_folder_id: string; root_name: string | null; enabled: boolean; last_run_at: string | null; last_error: string | null; last_notes: DriveTreeNotes | null; running: boolean } | null;
};
export const driveTreeStatus = (workspaceId: number) => call<DriveTreeStatus>('drive-photos', { action: 'tree_status', workspace_id: workspaceId });
export const driveTreeSave = (workspaceId: number, folder: string) => call<DriveTreeNotes & { error?: string | null }>('drive-photos', { action: 'tree_save', workspace_id: workspaceId, folder });
export const driveTreeRun = (workspaceId: number) => call<DriveTreeNotes & { error?: string | null; skipped?: string }>('drive-photos', { action: 'tree_run', workspace_id: workspaceId });

/** "First pass: 212 deal folders · 1,840 files · 3,906 photos · 14 addresses with no deal yet". */
export function driveTreeLine(n: DriveTreeNotes | null | undefined): string {
  if (!n) return 'Not run yet.';
  const c = n.counts;
  const bits = [`${n.deal_folders.toLocaleString('en-US')} deal folders`, `${c.files} new files`, `${c.photos} new photos this run`];
  if (n.unmatched_total) bits.push(`${n.unmatched_total} address folders with no deal yet`);
  return (n.first_pass ? `First pass (${n.folders_left} folders to go): ` : '') + bits.join(' · ');
}

export const granted = (a: Pick<GoogleAccount, 'scopes'> | null, scope: string) => Boolean(a?.scopes?.includes(scope));

/**
 * Push what just changed without making anyone wait for it. Appointment writes
 * call this; a failure is not the user's problem, because the next sync — on
 * the next app open at the latest — picks the change up anyway.
 */
export function nudgeGoogle(workspaceId: number | null | undefined): void {
  // A background sync writes, so a read-only preview skips it quietly rather
  // than have the guard refuse it and toast about a save nobody asked for.
  // Calendar only: the write just changed an appointment; mail can wait for
  // the five-minute timer (or Sync now) instead of stacking with this nudge.
  if (!workspaceId || !supabase || isReadOnly()) return;
  void syncGoogle(workspaceId, { calendarOnly: true }).catch(() => null);
}
