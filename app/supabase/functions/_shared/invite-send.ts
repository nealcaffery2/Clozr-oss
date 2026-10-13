/**
 * Send a CLOZR teammate invite: Resend when configured, else the workspace's
 * connected Gmail (same path signing links use when Resend is off).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type Account, SCOPE, accessFor, has, sendMail } from './google.ts';
import { inviteEmail, type InviteMail } from './invite-email.ts';
import { sendResend, transactionalFrom } from './resend.ts';

export async function sendTeammateInvite(
  admin: SupabaseClient,
  workspaceId: number,
  mail: InviteMail,
): Promise<{ emailed: boolean; via: 'resend' | 'gmail' | null }> {
  const built = inviteEmail(mail);
  const from = transactionalFrom();
  if (from) {
    const ok = await sendResend({
      to: mail.email,
      from: `CLOZR <${from.email}>`,
      subject: built.subject,
      html: built.html,
      text: built.text,
      replyTo: from.email,
      tags: { kind: mail.resend ? 'teammate_invite_resend' : 'teammate_invite' },
    });
    if (ok) return { emailed: true, via: 'resend' };
  }

  const { data } = await admin.from('google_accounts')
    .select('id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .eq('gmail_send', true)
    .order('id')
    .limit(1)
    .maybeSingle();
  const account = data as Account | null;
  if (!account || !has(account, SCOPE.gmailSend)) {
    console.error('teammate invite: no Resend and no Gmail sender for workspace', workspaceId);
    return { emailed: false, via: null };
  }
  const token = await accessFor(admin, account);
  if (!token) {
    console.error('teammate invite: Gmail token unavailable for', account.email);
    return { emailed: false, via: null };
  }
  const sent = await sendMail(token, {
    to: mail.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
  });
  return { emailed: !!sent, via: sent ? 'gmail' : null };
}
