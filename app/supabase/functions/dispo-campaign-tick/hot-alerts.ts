/**
 * Hot blast replies to the rep's inbox (migration 434). The trigger writes a
 * 'Hot buyer' bell row with payload.alert 'pending'; this claims it, emails the
 * rep who sent the blast, and stamps 'sent' or 'failed'. The bell only reaches
 * a rep with CLOZR open, and on 2026-10-30 twelve buyers asking for numbers on
 * one blast sat unseen for a week.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { emailRep } from '../_shared/rep-alert.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const MAX_AGE_MS = 2 * 3_600_000;

export async function sendHotAlerts(admin: SupabaseClient): Promise<number> {
  const { data } = await admin.from('notifications')
    .select('id, user_id, title, body, buyer_id, deal_id, payload')
    .eq('category', 'Hot buyer').eq('payload->>alert', 'pending')
    .gte('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
    .order('created_at').limit(20);
  let sent = 0;
  for (const n of (data ?? []) as Any[]) {
    // Claim first, so two overlapping ticks never mail the same alert.
    const { data: claimed } = await admin.from('notifications')
      .update({ payload: { ...n.payload, alert: 'sending' } })
      .eq('id', n.id).eq('payload->>alert', 'pending').select('id');
    if (!claimed?.length || !n.buyer_id) continue;
    const { data: b } = await admin.from('buyers').select('name, company, phone, email').eq('id', n.buyer_id).maybeSingle();
    const name = String((b as Any)?.name || (b as Any)?.company || 'the buyer').trim();
    const said = n.payload?.channel === 'email' ? 'emailed back' : 'texted back';
    const ok = await emailRep(admin, n.user_id, {
      kind: 'buyer', id: n.buyer_id, key: `hot-buyer-${n.id}`,
      subject: n.title,
      name,
      phone: (b as Any)?.phone ?? null,
      lines: [
        `${name} ${said} on your blast:`,
        `"${String(n.body ?? '').trim()}"`,
        ...((b as Any)?.email ? [`Email: ${(b as Any).email}`] : []),
        'Call them while it is fresh.',
      ],
      note: 'Their reply and the blast they answered are on the buyer\'s Activity tab.',
    });
    await admin.from('notifications').update({ payload: { ...n.payload, alert: ok ? 'sent' : 'failed' } }).eq('id', n.id);
    if (ok) sent++;
  }
  return sent;
}
