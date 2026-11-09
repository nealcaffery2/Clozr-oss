// Who gets "Reply STOP to opt out." on a text. Only a stranger on their first
// text from us: never a VIP or vetted buyer, never anyone who has written to
// us, never anyone we have texted before. Every dispo blast used to carry it,
// so the buyers list, VIPs and people we deal with weekly got told how to
// unsubscribe on each deal (owner, 2026-10-20).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { type OptOutFacts } from './opt-out-rule.ts';
export { needsOptOutLine, type OptOutFacts } from './opt-out-rule.ts';

/** The facts for one buyer or seller. A failed read counts as "known to us": no line rather than a wrong one. */
export async function optOutFacts(admin: SupabaseClient, ws: number, who: { buyer_id?: number | null; seller_id?: number | null }): Promise<OptOutFacts> {
  const col = who.buyer_id != null ? 'buyer_id' : 'seller_id';
  const id = who.buyer_id ?? who.seller_id;
  if (id == null) return { repliedBefore: false, textedBefore: false };
  const [b, inbound, texted] = await Promise.all([
    col === 'buyer_id'
      ? admin.from('buyers').select('vip, vetted_at').eq('id', id).eq('workspace_id', ws).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin.from('communications').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq(col, id).eq('direction', 'inbound'),
    admin.from('communications').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq(col, id).eq('direction', 'outbound').in('channel', ['sms', 'text']),
  ]);
  if (inbound.error || texted.error) return { repliedBefore: true, textedBefore: true };
  const row = (b.data ?? null) as { vip?: boolean | null; vetted_at?: string | null } | null;
  return { vip: !!row?.vip, vetted: !!row?.vetted_at, repliedBefore: (inbound.count ?? 0) > 0, textedBefore: (texted.count ?? 0) > 0 };
}
