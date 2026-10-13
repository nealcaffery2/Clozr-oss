// What an inbound caller is calling back about: the latest ringless drop to
// that number in the last week (lib/rvm-pool.ts attributeCallback), read when
// the phone rings so the card can say "Called back from your RVM blast Oct 2".
// Talkr may also name the touch it routed on (reason 'last_contact'); that is
// used when present, never required.

import { supabase } from './supabase';
import { attributeCallback, CALLBACK_WINDOW_DAYS, type Touch } from './rvm-pool';

export type CallbackTouch = Touch & { seller_id: number | null; buyer_id: number | null };

/**
 * Talkr's routing note on an inbound call (CallDto.routing:
 * { reason: 'last_contact', last_contact: { user_id, channel, occurred_at, ref } }),
 * as a touch. Read defensively; null for any other reason or shape.
 * `drop_id` is set when the ref is `rvm:<drop id>`.
 */
export function talkrRoutingTouch(call: unknown): (Touch & { drop_id: number | null }) | null {
  const c = (call ?? {}) as { routing?: { reason?: string; last_contact?: Record<string, unknown> | null } | null };
  const r = c.routing;
  const touch = r?.last_contact;
  if (r?.reason !== 'last_contact' || !touch) return null;
  const at = String(touch.occurred_at ?? '');
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const ch = String(touch.channel ?? 'other');
  const kind: Touch['kind'] = ch === 'rvm' ? 'rvm' : ch === 'email' ? 'email' : ch === 'sms' ? 'sms' : 'call';
  const ref = touch.ref == null ? null : String(touch.ref);
  const m = ref ? /^rvm:(\d+)$/.exec(ref) : null;
  return { id: ref ?? at, at, kind, rep_id: (touch.user_id as string | null | undefined) ?? null, drop_id: m ? Number(m[1]) : null };
}

export async function loadCallbackTouch(workspaceId: number | null | undefined, phoneE164: string): Promise<CallbackTouch | null> {
  if (!supabase || workspaceId == null || !/^\+\d{8,15}$/.test(phoneE164)) return null;
  const since = new Date(Date.now() - CALLBACK_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('rvm_drops')
    .select('id, sent_at, created_by, seller_id, buyer_id')
    .eq('workspace_id', workspaceId).eq('phone_e164', phoneE164).eq('status', 'dropped')
    .gte('sent_at', since).order('sent_at', { ascending: false }).limit(5);
  if (error || !data?.length) return null;
  const touches: CallbackTouch[] = (data as { id: number; sent_at: string | null; created_by: string | null; seller_id: number | null; buyer_id: number | null }[])
    .filter((d) => d.sent_at)
    .map((d) => ({ id: d.id, at: d.sent_at!, kind: 'rvm' as const, rep_id: d.created_by, seller_id: d.seller_id, buyer_id: d.buyer_id }));
  return attributeCallback(touches, new Date());
}
