/**
 * POST /ten-dlc-events — Telnyx's 10DLC webhooks.
 *
 * Registered as `webhookURL` on the brand and the campaign by ten-dlc-register,
 * which is why there is no polling cron: TCR decisions arrive here instead of
 * being discovered days later in a portal. Three event types land:
 *
 *   10dlc.brand.update         brand vetting, revet, external vetting
 *   10dlc.campaign.update      the carrier decision on the campaign
 *   10dlc.phone_number.update  a number joining or leaving the campaign
 *
 * A rejection is the valuable one. Telnyx names the offending fields —
 * `reasons: [{ fields: ["ein"], description: "Invalid EIN — ..." }]` — so the
 * admins get "fix the EIN", not "your brand failed".
 *
 * Trust. Telnyx signs every delivery with Ed25519 over `${timestamp}|${body}`.
 * Without TELNYX_PUBLIC_KEY (or Vault telnyx_public_key) we refuse everything rather than take a
 * stranger's word for a carrier decision. Delivery is at-least-once and
 * unordered, so the event id is the dedupe key (ten_dlc_events is keyed on it)
 * and a redelivery is a no-op.
 *
 * verify_jwt is off for this function (supabase/config.toml): the signature is
 * the credential, the same way talkr-webhook works.
 *
 * Env: TELNYX_PUBLIC_KEY or Vault telnyx_public_key, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING } from '../_shared/security.ts';
import { brandOk, campaignOk, explainReasons, terminal } from '../_shared/tendlc.ts';
import { telnyxSetting } from '../_shared/telnyx-settings.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

/** Telnyx tells consumers to reject deliveries older than five minutes. */
const MAX_SKEW_S = 300;

/**
 * Backed by a plain ArrayBuffer rather than the ArrayBufferLike a bare
 * `new Uint8Array(n)` infers, because WebCrypto's BufferSource will not take
 * anything that might be shared memory.
 */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.trim());
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyTelnyx(publicKeyB64: string, signatureB64: string, timestamp: string, rawBody: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify('Ed25519', key, fromBase64(signatureB64), signed);
  } catch (e) {
    console.error('ten-dlc-events: signature check could not run', e instanceof Error ? e.message : e);
    return false;
  }
}

const str = (o: Any, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

/** Tell the workspace's admins once, in the words they can act on. */
async function notify(admin: SupabaseClient, wsId: number, title: string, body: string) {
  const { data: members } = await admin.from('workspace_members').select('user_id').eq('workspace_id', wsId).in('role', ['owner', 'admin']);
  const rows = (members ?? []).map((m: Any) => ({
    workspace_id: wsId, user_id: m.user_id, category: 'Number health',
    title: title.length > 120 ? `${title.slice(0, 117)}…` : title, body,
  }));
  if (rows.length) await admin.from('notifications').insert(rows);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const publicKey = await telnyxSetting(admin, 'TELNYX_PUBLIC_KEY');
  if (!publicKey) {
    console.error('ten-dlc-events: neither TELNYX_PUBLIC_KEY nor Vault telnyx_public_key is set, so no delivery can be trusted');
    return json({ error: 'not configured' }, 503);
  }

  const raw = await req.text();
  const signature = req.headers.get('telnyx-signature-ed25519') ?? '';
  const timestamp = req.headers.get('telnyx-timestamp') ?? '';
  if (!signature || !timestamp) return json({ error: 'unsigned' }, 401);

  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_S) return json({ error: 'stale' }, 401);
  if (!await verifyTelnyx(publicKey, signature, timestamp, raw)) return json({ error: 'bad signature' }, 401);

  const body = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  const data = body?.data;
  if (!data?.id) return json({ error: 'no event id' }, 400);

  const eventType = String(data.event_type ?? '');
  const payload = (data.payload ?? {}) as Any;

  // Which workspace is this about? Every id Telnyx might quote back.
  const brandId = str(payload, 'brandId');
  const tcrBrandId = str(payload, 'tcrBrandId');
  const campaignId = str(payload, 'campaignId');
  const tcrCampaignId = str(payload, 'tcrCampaignId');

  // Each id is looked up on its own column rather than folded into one
  // PostgREST `or` filter, because that filter is a string and these values
  // come off the wire: a comma or a dot in one would change which rows it
  // matches. The signature says the delivery is Telnyx's; it does not make a
  // payload value safe to use as query syntax.
  const lookups: Array<[string, string | null]> = [
    ['brand_id', brandId],
    ['tcr_brand_id', tcrBrandId],
    ['campaign_id', campaignId],
    ['tcr_campaign_id', tcrCampaignId],
  ];
  let reg: Any = null;
  for (const [column, value] of lookups) {
    if (!value || reg) continue;
    const { data: found } = await admin.from('ten_dlc_registrations').select('*').eq(column, value).limit(1).maybeSingle();
    if (found) reg = found;
  }

  // Ledger first, and it is the dedupe: a redelivery loses the insert race and
  // we stop, so no status is applied twice and no admin is told twice.
  const { error: dupe } = await admin.from('ten_dlc_events').insert({
    event_id: String(data.id),
    workspace_id: reg?.workspace_id ?? null,
    event_type: eventType,
    payload_type: str(payload, 'type'),
    status: str(payload, 'status'),
    occurred_at: data.occurred_at ?? null,
    payload,
  });
  if (dupe) {
    // 23505 is the primary key: we have seen this event already.
    if (String((dupe as Any).code) === '23505') return json({ ok: true, duplicate: true });
    console.error('ten_dlc_events insert', dupe.message);
  }

  if (!reg) {
    // Filed outside CLOZR, or the register call's write lost a race with the
    // webhook. Keeping the event means it is not lost, and the guard's daily
    // read reconciles the status.
    return json({ ok: true, unmatched: true });
  }

  const wsId = Number(reg.workspace_id);
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
  const why = explainReasons(reasons);
  const failed = String(payload.status ?? '').toLowerCase() === 'failed';
  const patch: Record<string, unknown> = {};
  let attach = false;

  if (eventType === '10dlc.brand.update') {
    const status = str(payload, 'identityStatus', 'brandStatus', 'status');
    if (tcrBrandId) patch.tcr_brand_id = tcrBrandId;
    if (failed || terminal(status)) {
      patch.brand_status = status ?? 'FAILED';
      patch.status = 'failed';
      patch.last_error = why || 'The brand was not accepted.';
      patch.reasons = reasons;
      await notify(admin, wsId, '10DLC brand rejected — texting stays blocked',
        `${why || 'TCR did not accept the brand.'}\n\nFix it in Settings → Phone numbers → 10DLC, then file again. A rejected filing is not refunded, so check the legal name and EIN against the IRS letter before resubmitting.`);
    } else if (status) {
      patch.brand_status = status;
      if (brandOk(status) && reg.status === 'brand_pending') {
        patch.last_error = null;
        await notify(admin, wsId, '10DLC brand verified', 'The brand is verified. Press Register again in Settings → Phone numbers to file the campaign, or wait for the next guard run to do it.');
      }
    }
  } else if (eventType === '10dlc.campaign.update') {
    const status = str(payload, 'campaignStatus', 'status');
    if (tcrCampaignId) patch.tcr_campaign_id = tcrCampaignId;
    if (failed || terminal(status)) {
      patch.campaign_status = status ?? 'FAILED';
      patch.status = 'failed';
      patch.last_error = why || 'The campaign was not accepted.';
      patch.reasons = reasons;
      await notify(admin, wsId, '10DLC campaign rejected — texts are still filtered',
        `${why || 'The carriers did not accept the campaign.'}\n\nA rejected campaign cannot be edited; the corrected facts go in as a new filing, and each submission carries a TCR fee. The usual causes are sample messages that do not match what is actually sent, an opt-in description a reviewer cannot go and verify on the website, and a missing privacy policy.`);
    } else if (status) {
      patch.campaign_status = status;
      if (campaignOk(status)) {
        patch.last_error = null;
        patch.status = reg.messaging_profile_id ? 'assigning' : 'campaign_pending';
        attach = true;
        await notify(admin, wsId, '10DLC campaign approved',
          'The campaign is approved. Numbers on the messaging profile are being attached to it; once that lands, texting from those lines is no longer filtered.');
      }
    }
  } else if (eventType === '10dlc.phone_number.update') {
    const status = str(payload, 'status', 'assignmentStatus');
    patch.assignment_status = status;
    if (failed) {
      patch.last_error = why || 'A number could not be attached to the campaign.';
      await notify(admin, wsId, 'A number could not be attached to the 10DLC campaign',
        `${why || 'Telnyx refused the assignment.'}\n\nTexts from that line stay filtered until it is on the campaign.`);
    } else if (String(status ?? '').toUpperCase() === 'SUCCESS' || String(status ?? '').toLowerCase() === 'success') {
      patch.status = 'active';
      patch.active_at = new Date().toISOString();
      patch.last_error = null;
    }
  }

  if (Object.keys(patch).length) {
    const { error } = await admin.from('ten_dlc_registrations').update(patch).eq('workspace_id', wsId);
    if (error) console.error('ten_dlc_registrations update', error.message);
  }

  // Attach the lines now rather than at the next weekday morning check: an
  // approval on Friday night would otherwise leave texting filtered until
  // Monday. Brand and campaign are filed, so this only assigns numbers.
  if (attach) {
    const kicked = await fetch(`${Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')}/functions/v1/ten-dlc-register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'register', workspace_id: wsId }),
    }).catch((e) => { console.error('ten-dlc-register kick', e); return null; });
    if (kicked && !kicked.ok) console.error('ten-dlc-register kick', kicked.status, await kicked.text());
  }

  return json({ ok: true });
});
