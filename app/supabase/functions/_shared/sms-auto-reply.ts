// A line's SMS auto-reply (migration 200, line_sms_flows), sent by
// talkr-webhook when a text arrives. The decision is lib/sms-flow.ts; this
// file claims the reply (one per inbound event, so a redelivery never texts
// twice), then sends it through Talkr as the line's owner, else as the admin
// who set the flow up, from the line itself. Best effort: it never throws, and
// a line with no flow does exactly what it did before.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { autoReplyFor, type SmsFlow } from '../../../lib/sms-flow.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg } from './talkr-binding.ts';
import { loadTalkrConnections } from './talkr-connect.ts';
import { TALKR_DEFAULT_URL, partnerToken } from './talkr-outreach.ts';

const e164 = (raw: unknown): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : null;
};

type Inbound = { ref: string; from: unknown; to: unknown; body: unknown; at?: Date };

/** What happened, in words for the log; null when the line has no auto-reply. */
export async function smsAutoReply(admin: SupabaseClient, ws: number, msg: Inbound): Promise<string | null> {
  try {
    const line = e164(msg.to);
    const theirs = e164(msg.from);
    if (!line || !theirs || !msg.ref) return null;
    const { data: flow, error } = await admin.from('line_sms_flows')
      .select('phone_e164, talkr_number_id, auto_reply_enabled, auto_reply_body, auto_reply_when, hours, cooldown_hours, updated_by')
      .eq('workspace_id', ws).eq('phone_e164', line).maybeSingle();
    if (error || !flow?.auto_reply_enabled) return null;

    const { data: last } = await admin.from('line_sms_auto_replies').select('created_at')
      .eq('workspace_id', ws).eq('line_e164', line).eq('to_e164', theirs).eq('status', 'sent')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const at = msg.at ?? new Date();
    const decision = autoReplyFor(flow as unknown as SmsFlow, { body: String(msg.body ?? ''), at, lastReplyAt: last?.created_at ?? null });
    if (!decision.send) return `auto-reply skipped: ${decision.reason}`;

    // The claim: a second delivery of the same event stops here.
    const { data: claim, error: claimErr } = await admin.from('line_sms_auto_replies')
      .insert({ workspace_id: ws, line_e164: line, to_e164: theirs, inbound_ref: msg.ref })
      .select('id').maybeSingle();
    if (claimErr || !claim) return 'auto-reply already handled';
    const done = async (status: 'sent' | 'failed', why: string) => {
      await admin.from('line_sms_auto_replies').update({ status, error: status === 'failed' ? why : null }).eq('id', claim.id);
      return `auto-reply ${status}${status === 'failed' ? `: ${why}` : ''}`;
    };

    const { data: wsRow } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
    const binding = activeTalkrBinding({ id: ws, settings: wsRow?.settings }, (await loadTalkrConnections(admin, [ws]))[0] ?? null);
    if (!binding) return await done('failed', 'Talkr not connected');

    const { data: owner } = await admin.from('rep_phone_numbers').select('user_id').eq('workspace_id', ws).eq('phone_e164', line).maybeSingle();
    const senderId = (owner?.user_id as string | null) ?? (flow.updated_by as string | null);
    if (!senderId) return await done('failed', 'no one to send as');
    const { data: profile } = await admin.from('profiles').select('email').eq('id', senderId).maybeSingle();
    const token = await partnerToken({ id: senderId, email: (profile?.email as string | null) ?? null });
    if (!token) return await done('failed', 'server texting is not configured (TALKR_PARTNER_JWT_SECRET)');

    const base = String((wsRow?.settings as Record<string, unknown> | null)?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const call = async (path: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
      } catch {
        return { ok: false, status: 0, body: { error: 'unreachable' } as Record<string, unknown> };
      }
    };
    if (!gateTalkrWrite({ binding, observedOrgId: await readTalkrOrg((p) => call(p)) }).ok) return await done('failed', 'Talkr org does not match this workspace');

    const res = await call('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ to_number: theirs, body: decision.body, ...(flow.talkr_number_id ? { from_phone_number_id: flow.talkr_number_id } : {}) }),
    });
    return res.ok ? await done('sent', '') : await done('failed', `Talkr refused: ${String(res.body?.error ?? res.status)}`);
  } catch (err) {
    console.error('sms auto-reply', err);
    return null;
  }
}
