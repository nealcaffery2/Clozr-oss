// Resend from-address parse, event mapping, webhook verify.
// Run: npx tsx tools/resend.test.ts
import assert from 'node:assert/strict';
import { classifyResendEvent, parseFrom, suggestBlastFrom, verifyResendWebhook, workspaceResendEnv } from '../supabase/functions/_shared/resend-rules';
import { campaignChecklist, poolRoom, type Overview, type ResendSender } from '../lib/deliverability';

assert.equal(parseFrom(''), null);
assert.equal(parseFrom('not-an-email'), null);
assert.equal(parseFrom('Sam <sam@gmail.com>'), null, 'free mailboxes are not a blast from');
const blast = parseFrom('Acme Homes <deals@deals.yourcompany.com>');
assert.equal(blast?.email, 'deals@deals.yourcompany.com');
assert.equal(blast?.domain, 'deals.yourcompany.com');
assert.equal(blast?.name, 'Acme Homes');
assert.equal(blast?.from, 'Acme Homes <deals@deals.yourcompany.com>');
assert.equal(parseFrom('deals@deals.yourcompany.com')?.name, null);

assert.equal(classifyResendEvent('email.bounced', 'Permanent'), 'hard_bounce');
assert.equal(classifyResendEvent('email.bounced', 'transient'), 'ignored');
assert.equal(classifyResendEvent('email.complained'), 'complaint');
assert.equal(classifyResendEvent('email.delivered'), 'delivered');
assert.equal(classifyResendEvent('email.opened'), 'ignored');

const secret = 'whsec_' + btoa('test-secret-bytes!!');
const raw = '{"type":"email.bounced"}';
const id = 'msg_1';
const timestamp = String(Math.floor(Date.now() / 1000));
const bytes = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
const sig = 'v1,' + btoa(String.fromCharCode(...mac));
assert.equal(await verifyResendWebhook(raw, { id, timestamp, signature: sig }, secret), true);
assert.equal(await verifyResendWebhook(raw, { id, timestamp, signature: 'v1,aaaa' }, secret), false);
assert.equal(await verifyResendWebhook(raw, { id, timestamp: String(Number(timestamp) - 400), signature: sig }, secret), false);

const emptyOverview = (): Overview => ({
  domains: [], mailboxes: [], suppressions: [], warmup: { instantly: false, instantly_own: false, inboxkit: false, inboxkit_own: false }, me: { user_id: 'u', admin: true },
});
const gmailItems = campaignChecklist(emptyOverview(), null, null);
assert.equal(gmailItems[0].label, 'A connected mailbox that can send');
assert.equal(gmailItems[0].ok, false);

const resendItems = campaignChecklist({
  ...emptyOverview(),
  resend: {
    configured: true, from: 'Acme Homes <deals@deals.yourcompany.com>', email: 'deals@deals.yourcompany.com',
    domain: 'deals.yourcompany.com',
    own_key: false, own_from: null, key_source: 'project', webhook_url: 'https://x/resend', webhook_secret_set: true,
    sender: {
      id: 1, from_email: 'deals@deals.yourcompany.com', from_name: 'Acme Homes', domain: 'deals.yourcompany.com', active: true,
      settings: {
        daily_cap: 200, hourly_cap: 40, min_gap_seconds: 20, window_start: 8, window_end: 18, window_days: [1, 2, 3, 4, 5],
        timezone: 'America/Chicago', ramp_enabled: true, ramp_start: 30, ramp_increase_pct: 20, ramp_target: 200,
        ramp_started_on: '2026-09-17', paused: false, paused_reason: null, paused_at: null, paused_auto: false,
      },
      sent_today: 0, allowance: 30, ramp_day: 1, sent_7d: 0, bounced_7d: 0,
    },
    status: 'verified',
  },
  domains: [{
    id: 1, domain: 'deals.yourcompany.com', source: 'manual', dkim_selectors: [], tracking_domain: null, uses_resend: true,
    score: 90, blocking: [], report: { checks: [], provider: 'resend' }, checked_at: new Date().toISOString(),
  }],
}, null, null);
assert.equal(resendItems[0].label, 'Resend is wired for blasts');
assert.equal(resendItems[0].ok, true);
assert.equal(resendItems.find((i) => i.label === 'Blast sender is not paused')?.ok, true);
assert.equal(resendItems.find((i) => i.label === 'A connected mailbox that can send'), undefined);
assert.equal(resendItems.find((i) => i.label === 'Room left today')?.detail, '0 of 30 across 1 address · warm-up day 1');

const primary = {
  id: 1, from_email: 'deals@deals.yourcompany.com', from_name: 'Acme Homes', domain: 'deals.yourcompany.com', active: true,
  settings: {
    daily_cap: 200, hourly_cap: 40, min_gap_seconds: 20, window_start: 8, window_end: 18, window_days: [1, 2, 3, 4, 5],
    timezone: 'America/Chicago', ramp_enabled: true, ramp_start: 50, ramp_increase_pct: 20, ramp_target: 200,
    ramp_started_on: '2026-09-26', paused: false, paused_reason: null, paused_at: null, paused_auto: false,
  },
  sent_today: 50, allowance: 50, ramp_day: 1, sent_7d: 50, bounced_7d: 0,
} satisfies ResendSender;
const mate: ResendSender = { ...primary, id: 2, from_email: 'jamie1@deals.yourcompany.com', from_name: 'Jamie Brooks', reply_to: 'jamie@yourcompany.com', user_id: 'jamie', sent_today: 10, allowance: 50 };
const morganOnly: ResendSender = { ...mate, id: 3, from_email: 'morgan1@deals.yourcompany.com', from_name: 'Morgan Lane', reply_to: 'morgan@yourcompany.com', user_id: 'u', sent_today: 0, allowance: 50 };
assert.deepEqual(poolRoom([primary, mate]), { count: 2, allowance: 100, sent: 60, left: 40 });
assert.deepEqual(poolRoom([{ ...mate, settings: { ...mate.settings, paused: true } }]), { count: 0, allowance: 0, sent: 0, left: 0 });
const scoped = campaignChecklist({
  ...emptyOverview(),
  resend: {
    configured: true, from: 'Acme Homes <deals@deals.yourcompany.com>', email: 'deals@deals.yourcompany.com',
    domain: 'deals.yourcompany.com',
    own_key: false, own_from: null, key_source: 'project', webhook_url: 'https://x/resend', webhook_secret_set: true,
    sender: primary, senders: [primary, mate, morganOnly], status: 'verified',
  },
  domains: [{
    id: 1, domain: 'deals.yourcompany.com', source: 'manual', dkim_selectors: [], tracking_domain: null, uses_resend: true,
    score: 90, blocking: [], report: { checks: [], provider: 'resend' }, checked_at: new Date().toISOString(),
  }],
}, null, null);
assert.equal(scoped.find((i) => i.label === 'Room left today')?.detail.startsWith('0 of 50 across 1 address'), true);

// Each workspace sends with its own Resend key and sender; the project fills in only what it has not set.
const project = { get: (k: string) => ({ RESEND_API_KEY: 're_project', MAIL_FROM_BLASTS: 'Acme Homes <deals@deals.yourcompany.com>', MAIL_FROM: 'Acme Homes <noreply@yourcompany.com>', APP_URL: 'https://app' } as Record<string, string>)[k] };
const acme = workspaceResendEnv(project, {});
assert.equal(acme.get('RESEND_API_KEY'), 're_project', 'nothing set: the project key');
assert.equal(acme.get('MAIL_FROM_BLASTS'), 'Acme Homes <deals@deals.yourcompany.com>', 'nothing set: the project sender, so Acme Homes is unchanged');
const compr = workspaceResendEnv(project, { key: 're_compr', from: 'Compr <deals@deals.thecompr.ai>' });
assert.equal(compr.get('RESEND_API_KEY'), 're_compr');
assert.equal(compr.get('MAIL_FROM_BLASTS'), 'Compr <deals@deals.thecompr.ai>');
assert.equal(compr.get('MAIL_FROM'), 'Compr <deals@deals.thecompr.ai>');
assert.equal(compr.get('APP_URL'), 'https://app', 'other keys pass through');
const senderOnly = workspaceResendEnv(project, { from: 'Compr <deals@deals.thecompr.ai>' });
assert.equal(senderOnly.get('RESEND_API_KEY'), 're_project', 'own sender, project key');
assert.equal(senderOnly.get('MAIL_FROM_BLASTS'), 'Compr <deals@deals.thecompr.ai>');
const keyOnly = workspaceResendEnv(project, { key: 're_compr' });
assert.equal(keyOnly.get('MAIL_FROM_BLASTS'), '', 'own key, no sender: never the project domain on another Resend account');
assert.equal(workspaceResendEnv(project, { from: 'someone@gmail.com' }).get('MAIL_FROM_BLASTS'), 'Acme Homes <deals@deals.yourcompany.com>', 'a free-mail sender is ignored');
assert.equal(suggestBlastFrom('Compr', 'thecompr.com'), 'Compr <deals@deals.thecompr.com>');
assert.equal(suggestBlastFrom('Compr', 'deals.thecompr.ai'), 'Compr <deals@deals.thecompr.ai>');
assert.equal(suggestBlastFrom('', 'gmail.com'), null);
assert.equal(suggestBlastFrom(null, null), null);

console.log('resend: all assertions passed');
