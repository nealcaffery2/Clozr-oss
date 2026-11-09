/**
 * Read receipts for one send from a rep's Gmail: the email_tracking row
 * (migration 82), its link rows, and the pixel and counted links in the HTML
 * (email-track.ts). Every one-to-one send that goes out of CLOZR through
 * Gmail calls this: google-sync send_email (every composer), meeting-invite,
 * a single Compr payment link. Bulk, campaign, dispo and cold mail never do;
 * a pixel there costs deliverability.
 *
 * Tracking never blocks a send. When a write fails the mail goes out
 * untracked (or with the pixel but plain links), and the failure is logged
 * with where it came from, so a gap in receipts shows up in the function logs
 * instead of as silence.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { instrument, newToken, trackBase } from './email-track.ts';

export type TrackStart = {
  workspaceId: number; userId: string | null; recipients: readonly string[]; subject: string; html: string;
  /** Which send path, for the log line. */
  where: string;
};

/** The HTML to send and the token it carries, or the HTML untouched and a null token when the row would not write. */
export async function startTracking(admin: SupabaseClient, t: TrackStart): Promise<{ html: string; token: string | null }> {
  const token = newToken();
  const { error } = await admin.from('email_tracking').insert({
    token, workspace_id: t.workspaceId, user_id: t.userId, recipients: t.recipients.join(', ').slice(0, 1000), subject: t.subject.slice(0, 300),
  });
  if (error) {
    console.error(`email tracking skipped (${t.where}): ${error.message}`);
    return { html: t.html, token: null };
  }
  const done = instrument(t.html, token, trackBase());
  if (!done.links.length) return { html: done.html, token };
  const { error: lErr } = await admin.from('email_tracking_links').insert(done.links.map((url, idx) => ({ token, idx, url })));
  if (!lErr) return { html: done.html, token };
  // Rewritten links with no rows behind them would 404: send the links as written, keep the pixel.
  console.error(`email click tracking skipped (${t.where}): ${lErr.message}`);
  return { html: instrument(t.html, token, trackBase(), { links: false }).html, token };
}

/** Ties the receipt to the communications row the send was written to, so the record and the inbox can show it. */
export async function linkTracking(admin: SupabaseClient, token: string | null, communicationId: number | null, where: string): Promise<void> {
  if (!token) return;
  if (communicationId == null) {
    console.error(`email tracked but not recorded (${where}): token ${token.slice(0, 8)} has no communication`);
    return;
  }
  const { error } = await admin.from('email_tracking').update({ communication_id: communicationId }).eq('token', token);
  if (error) console.error(`email tracking not linked to communication ${communicationId} (${where}): ${error.message}`);
}

/** A send Gmail refused: its receipt row goes too. */
export async function dropTracking(admin: SupabaseClient, token: string | null, where: string): Promise<void> {
  if (!token) return;
  const { error } = await admin.from('email_tracking').delete().eq('token', token);
  if (error) console.error(`unsent email's tracking row left behind (${where}): ${error.message}`);
}
