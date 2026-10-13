// Email deliverability, from the browser's side.
//
// The rules (spam risk, the ramp, DMARC parsing, the score) are the same file
// the edge functions enforce with, so what the composer badge says and what
// the server refuses cannot drift. Everything that reads or writes the
// deliverability tables goes through the `deliverability` edge function,
// which checks the caller's role: caps and domains are owner/admin only.

import { supabase, SUPABASE_URL } from './supabase';
import { repSenderPool, type Check, type MailboxSettings } from '../supabase/functions/_shared/deliverability-rules';
import { resendDomainFields, textValue } from '../supabase/functions/_shared/resend-rules';

export { spamRisk, dailyAllowance, healthScore, repSenderPool, type Check, type DnsFix, type MailboxSettings, type SpamFinding } from '../supabase/functions/_shared/deliverability-rules';
export { resendDomainFields, resendRecordFields, textValue } from '../supabase/functions/_shared/resend-rules';

export const resendWebhookUrl = () => (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/deliverability/resend` : '');

export type DomainRow = {
  id: number; domain: string; source: 'google' | 'manual'; dkim_selectors: string[]; tracking_domain: string | null; uses_resend: boolean;
  score: number | null; blocking: string[]; report: { checks: Check[]; provider: string } | null; checked_at: string | null;
};
export type MailboxRow = {
  account_id: number; email: string; owner: string | null; user_id: string; status: string;
  gmail_send: boolean; gmail_read: boolean; postmaster: boolean;
  settings: MailboxSettings & { paused_at: string | null; paused_auto: boolean };
  sent_today: number; allowance: number; ramp_day: number; sent_7d: number; bounced_7d: number; bulk_30d: number;
};
export type SuppressionRow = { id: number; email: string; reason: 'hard_bounce' | 'unsubscribe' | 'complaint' | 'manual'; note: string | null; account_id: number | null; created_at: string };
export type ResendDnsRecord = { type: string; name: string; value: string; ttl?: string; status?: string; priority?: number };
export type ResendSender = {
  id: number; from_email: string; from_name: string | null; reply_to?: string | null; user_id?: string | null; domain: string; active: boolean;
  settings: MailboxSettings & { paused_at: string | null; paused_auto: boolean };
  sent_today: number; allowance: number; ramp_day: number; sent_7d: number; bounced_7d: number;
};
export type ResendStatus = {
  configured: boolean; from: string | null; email: string | null; domain: string | null;
  /** This workspace saved its own Resend key / blast sender; otherwise the project's are used. */
  own_key?: boolean; own_from?: string | null; key_source?: 'workspace' | 'project' | null;
  /** deals.<company domain>, offered when no sender is set. */
  suggested_from?: string | null;
  webhook_url: string; webhook_secret_set: boolean; own_webhook_secret?: boolean;
  error?: string | null;
  sender: ResendSender | null;
  /** Every blast address in the rotation, including `sender`. Each has its own warm-up ramp. */
  senders?: ResendSender[];
  records?: ResendDnsRecord[]; status?: string | null; region?: string | null;
};

/** Room left across the addresses a buyer blast will rotate through. */
export function poolRoom(senders: ResendSender[]): { count: number; allowance: number; sent: number; left: number } {
  const open = senders.filter((s) => s.active && !s.settings.paused);
  const allowance = open.reduce((n, s) => n + s.allowance, 0);
  const sent = open.reduce((n, s) => n + s.sent_today, 0);
  return { count: open.length, allowance, sent, left: Math.max(0, allowance - sent) };
}
/** Which warm-up keys this workspace can read with, and whether each is its own or the project's. */
export type WarmupKeys = { instantly: boolean; instantly_own: boolean; inboxkit: boolean; inboxkit_own: boolean };
export type Overview = { domains: DomainRow[]; mailboxes: MailboxRow[]; suppressions: SuppressionRow[]; warmup?: WarmupKeys; me: { user_id: string; admin: boolean }; resend?: ResendStatus | null };

export type PostmasterDay = { date: string; reputation: 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD' | null; spam: number | null; spf: number | null; dkim: number | null; dmarc: number | null; errors: number; error_types: string[] };
/** Google Site Verification for one domain Postmaster does not list yet. 	xt is shown when it must be added by hand. */
export type DomainVerification = { domain: string; status: 'verified' | 'pending' | 'needs_dns' | 'error' | 'unchecked'; dns_host: 'inboxkit' | 'vercel' | null; txt: string | null; detail: string | null; checked_at: string | null; attempts: number };
export type Postmaster = { connected: boolean; granted: boolean; site_verification?: boolean; error?: string; domains: { domain: string; days: PostmasterDay[] }[]; unverified: string[]; verification?: DomainVerification[] };
export type WarmupMailbox = {
  email: string;
  /** Instantly: warming, health score, and 14 days of warm-up mail by where it landed. */
  instantly: boolean; warming: boolean | null; score: number | null; sent14: number; inbox14: number; spam14: number; inbox_pct: number | null; spam_pct: number | null;
  /** InboxKit: the mailbox status and its 7-day activity health (healthy, low_activity, inactive). */
  inboxkit: boolean; inboxkit_status: string | null; health: string | null; sent7: number | null; bounce_pct: number | null; last_event_at: string | null;
};
export type Warmup = {
  instantly: { connected: boolean; own: boolean; error: string | null };
  inboxkit: { connected: boolean; own: boolean; error: string | null };
  mailboxes: WarmupMailbox[];
};

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export async function deliverability<T>(workspaceId: number, action: string, body: Record<string, unknown> = {}): Promise<Result<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('deliverability', { body: { workspace_id: workspaceId, action, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

/**
 * The "before you send a campaign" checklist. Launch-blocking items are the
 * same ones google-sync refuses a bulk send for; the rest are advice.
 */
export function campaignChecklist(o: Overview, pm: Postmaster | null, accountId: number | null): { label: string; ok: boolean; blocking: boolean; detail: string }[] {
  if (o.resend?.configured) return resendCampaignChecklist(o, pm);
  return gmailCampaignChecklist(o, pm, accountId);
}

export function resendCampaignChecklist(o: Overview, pm: Postmaster | null): { label: string; ok: boolean; blocking: boolean; detail: string }[] {
  const r = o.resend;
  const sender = r?.sender ?? null;
  const listed = r?.senders?.length ? r.senders : sender ? [sender] : [];
  const room = poolRoom(repSenderPool(listed, o.me.user_id));
  const shown = resendDomainFields(r?.domain, r?.status, r?.region);
  const domainName = shown.name;
  const statusText = shown.status.toLowerCase();
  const domain = sender ? o.domains.find((d) => d.domain === sender.domain) ?? o.domains.find((d) => d.domain === domainName) ?? null : o.domains.find((d) => d.domain === domainName) ?? null;
  const pmDays = pm?.domains.find((d) => d.domain === domain?.domain)?.days ?? [];
  const last = pmDays[pmDays.length - 1] ?? null;
  const weekOld = (iso: string | null) => !iso || Date.parse(iso) < Date.now() - 7 * 86_400_000;
  const verified = statusText === 'verified';
  return [
    { label: 'Resend is wired for blasts', ok: !!r?.configured && !!sender, blocking: true, detail: textValue(r?.from) || "Add this workspace's Resend key and blast sender under Buyer blasts." },
    { label: 'Blast domain is not a free mailbox', ok: !!domainName && !domainName.endsWith('gmail.com'), blocking: true, detail: domainName || 'No blast sender yet.' },
    { label: 'Resend has verified the domain', ok: verified || (!!domain && !weekOld(domain.checked_at) && domain.blocking.length === 0), blocking: true, detail: statusText ? `Resend: ${statusText}` : 'Open Settings → Outbound OS and verify the DNS records.' },
    { label: 'Sending domain checked this week', ok: !!domain && !weekOld(domain.checked_at), blocking: true, detail: domain ? (domain.checked_at ? `Last checked ${new Date(domain.checked_at).toLocaleDateString()}` : 'Never checked') : 'Blast from a sending subdomain (deals.yourdomain.com), never the company root.' },
    { label: 'SPF, DKIM, DMARC and blocklists pass', ok: !!domain && domain.blocking.length === 0 && domain.checked_at !== null, blocking: true, detail: domain?.blocking[0] ?? 'No launch-blocking failures.' },
    { label: 'Domain health 70 or higher', ok: (domain?.score ?? 0) >= 70, blocking: true, detail: domain?.score != null ? `${domain.score}/100` : 'Not scored yet' },
    { label: 'Blast sender is not paused', ok: room.count > 0, blocking: true, detail: room.count ? `${room.count} address${room.count === 1 ? '' : 'es'} sending` : sender?.settings.paused ? textValue(sender.settings.paused_reason) || 'Paused' : 'No sender yet' },
    { label: 'Bounce rate under 5% (7 days)', ok: !sender || sender.sent_7d < 20 || sender.bounced_7d / sender.sent_7d <= 0.05, blocking: true, detail: sender ? `${sender.bounced_7d} of ${sender.sent_7d} bounced` : 'Nothing sent yet.' },
    { label: 'Bounce and complaint webhooks', ok: !!r?.webhook_secret_set, blocking: false, detail: r?.webhook_secret_set ? 'The signing secret is set, so Resend posts bounces here.' : 'Add the webhook in Resend under Webhooks and save its signing secret under Buyer blasts.' },
    { label: 'Gmail spam rate under 0.3% (Postmaster)', ok: !last || last.spam === null || last.spam <= 0.003, blocking: false, detail: last?.spam != null ? `${(last.spam * 100).toFixed(2)}% on ${last.date}` : 'Postmaster is optional for Resend blasts. It still helps if you verify the same domain.' },
    { label: 'Room left today', ok: room.count > 0 && room.sent < room.allowance, blocking: false, detail: room.count ? `${room.sent} of ${room.allowance} across ${room.count} address${room.count === 1 ? '' : 'es'}${sender?.settings.ramp_enabled ? ` · warm-up day ${sender.ramp_day}` : ''}` : 'No sender yet.' },
    { label: 'DMARC enforcing (quarantine or reject)', ok: !domain?.report?.checks.some((c) => c.key === 'dmarc' && c.status === 'warn'), blocking: false, detail: 'p=none is allowed but weaker.' },
  ];
}

export function gmailCampaignChecklist(o: Overview, pm: Postmaster | null, accountId: number | null): { label: string; ok: boolean; blocking: boolean; detail: string }[] {
  const mb = o.mailboxes.find((m) => m.account_id === accountId) ?? null;
  const domain = mb ? o.domains.find((d) => d.domain === mb.email.split('@')[1]?.toLowerCase()) ?? null : null;
  const pmDays = pm?.domains.find((d) => d.domain === domain?.domain)?.days ?? [];
  const last = pmDays[pmDays.length - 1] ?? null;
  const weekOld = (iso: string | null) => !iso || Date.parse(iso) < Date.now() - 7 * 86_400_000;
  return [
    { label: 'A connected mailbox that can send', ok: !!mb && mb.gmail_send && mb.status === 'active', blocking: true, detail: mb ? `${mb.email}${mb.status !== 'active' ? ' needs reconnecting' : ''}` : 'Connect Google first.' },
    { label: 'Sending domain checked this week', ok: !!domain && !weekOld(domain.checked_at), blocking: true, detail: domain ? (domain.checked_at ? `Last checked ${new Date(domain.checked_at).toLocaleDateString()}` : 'Never checked') : 'Company domain required: free mailboxes cannot send in bulk safely.' },
    { label: 'SPF, DKIM, DMARC and blocklists pass', ok: !!domain && domain.blocking.length === 0 && domain.checked_at !== null, blocking: true, detail: domain?.blocking[0] ?? 'No launch-blocking failures.' },
    { label: 'Domain health 70 or higher', ok: (domain?.score ?? 0) >= 70, blocking: true, detail: domain?.score != null ? `${domain.score}/100` : 'Not scored yet' },
    { label: 'Mailbox is not paused', ok: !!mb && !mb.settings.paused, blocking: true, detail: mb?.settings.paused ? mb.settings.paused_reason ?? 'Paused' : 'Active' },
    { label: 'Bounce rate under 5% (7 days)', ok: !mb || mb.sent_7d < 20 || mb.bounced_7d / mb.sent_7d <= 0.05, blocking: true, detail: mb ? `${mb.bounced_7d} of ${mb.sent_7d} bounced` : 'Nothing sent yet.' },
    { label: 'Gmail spam rate under 0.3% (Postmaster)', ok: !last || last.spam === null || last.spam <= 0.003, blocking: false, detail: last?.spam != null ? `${(last.spam * 100).toFixed(2)}% on ${last.date}` : pm?.granted ? 'No Postmaster data yet (Gmail needs volume to report)' : 'Connect Postmaster to see complaints. They are not visible from the mailbox.' },
    { label: 'Bounce detection on (Gmail read access)', ok: !!mb?.gmail_read, blocking: false, detail: mb?.gmail_read ? 'Bounces are read from the mailbox on every sync.' : 'Without Gmail read access bounces go unseen and nothing auto-pauses.' },
    { label: 'Room left today', ok: !!mb && mb.sent_today < mb.allowance, blocking: false, detail: mb ? `${mb.sent_today} of ${mb.allowance} used${mb.settings.ramp_enabled ? ` · warm-up day ${mb.ramp_day}` : ''}` : 'No mailbox yet.' },
    { label: 'DMARC enforcing (quarantine or reject)', ok: !domain?.report?.checks.some((c) => c.key === 'dmarc' && c.status === 'warn'), blocking: false, detail: 'p=none is allowed but weaker.' },
  ];
}
