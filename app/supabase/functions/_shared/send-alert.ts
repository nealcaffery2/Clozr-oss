/**
 * A send that stopped: an auto-paused mailbox, sender or domain, a domain whose
 * DNS check now blocks sending, failed campaign or scheduled messages. These
 * were written on the row and nobody heard (audit 2026-10-31). Each one is a
 * 'send_failure' bell row for the workspace owner plus an email with the reason
 * and a link, at most one per key (a mailbox, a domain, a campaign) per hour.
 *
 * Best effort: a failed read, insert or email logs and returns false; the pause
 * or the failed row it reports is already written. The bell's per-category mute
 * (lib/bell-mute-prefs) covers 'send_failure' like any other category.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { appLink, appPath } from './app-paths.ts';
import { clozrAppOrigin } from './app-url.ts';
import { repAlertEmail } from './rep-alert.ts';
import { sendResend, transactionalFrom } from './resend.ts';

export const ALERT_EVERY_MS = 3_600_000;

export type SendFailure = {
  ws: number;
  /** What it is about, e.g. `cold_mailbox:12`, `dispo_campaign:40`: one alert per key per hour. */
  key: string;
  title: string;
  reason: string;
  /** The app path to fix it from (appPath.deliverability, appPath.campaigns, ...). */
  path: string;
  /** What the link opens, for the button: "Email deliverability". */
  place: string;
  /** The record it is about, so the bell row opens it. */
  sellerId?: number | null;
  buyerId?: number | null;
};

/** True when it rang the bell. */
export async function alertSendFailure(admin: SupabaseClient, f: SendFailure, now = Date.now()): Promise<boolean> {
  try {
    const { data: recent, error: readErr } = await admin.from('notifications').select('id')
      .eq('workspace_id', f.ws).eq('category', 'send_failure').eq('payload->>key', f.key)
      .gte('created_at', new Date(now - ALERT_EVERY_MS).toISOString()).limit(1);
    if (readErr || recent?.length) return false;
    const { data: w } = await admin.from('workspaces').select('owner_id').eq('id', f.ws).maybeSingle();
    const owner = (w as { owner_id?: string | null } | null)?.owner_id;
    if (!owner) return false;
    const reason = String(f.reason ?? '').slice(0, 500);
    const { error } = await admin.from('notifications').insert({
      workspace_id: f.ws, user_id: owner, category: 'send_failure', title: f.title.slice(0, 200), body: reason,
      seller_id: f.sellerId ?? null, buyer_id: f.buyerId ?? null, payload: { key: f.key, path: f.path },
    });
    if (error) { console.error('send alert notify', error.message); return false; }
    const from = transactionalFrom();
    const { data: p } = await admin.from('profiles').select('email').eq('id', owner).maybeSingle();
    const to = String((p as { email?: string } | null)?.email ?? '').trim();
    if (from && to) {
      const mail = repAlertEmail({
        subject: f.title, name: f.place, phone: null, link: appLink(clozrAppOrigin(), f.path),
        lines: [f.title, reason],
        note: 'One email per hour for the same mailbox, domain or campaign while it keeps failing.',
      });
      await sendResend({ to, from: from.from, ...mail, idempotencyKey: `send-failure-${f.ws}-${f.key}-${Math.floor(now / ALERT_EVERY_MS)}`, tags: { kind: 'send_failure' } });
    }
    return true;
  } catch (e) {
    console.error('send alert', String(e));
    return false;
  }
}

/** An auto-paused mailbox, sender or domain: `what` is its address or domain. */
export function alertPause(admin: SupabaseClient, ws: number, kind: string, id: unknown, what: string, reason: string): Promise<boolean> {
  return alertSendFailure(admin, {
    ws, key: `${kind}:${id}`, title: `${what} was auto-paused`,
    reason: `Auto-paused: ${reason}. Nothing sends from it until it is unpaused under Email deliverability.`,
    path: appPath.deliverability, place: 'Email deliverability',
  });
}
