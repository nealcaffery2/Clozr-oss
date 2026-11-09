/**
 * Which line a plan text goes out on, and which version of it.
 *
 * A plan used to text everyone from the sender's one default line, so a plan
 * with thousands of prospects was one number's volume. A text to someone who
 * is not yet a customer now goes out across the sender's own Talkr lines:
 * the line the person already hears from first, else a line local to them
 * (same area code, then same state), else the least-used line under its
 * daily cap. A new line's cap ramps from 50 to 200 over two weeks (lineCap). On when the plan's
 * settings.rotate_lines is true, or when it is unset and more than
 * ROTATE_OVER people are active on the plan; rotate_lines false keeps the
 * sender's own line. A customer always hears from the rep's own line.
 *
 * A text step can hold up to three versions separated by a line of ---. Each
 * person always gets the same one (by enrolment id).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { everyRow } from '../_shared/every-row.ts';
import { partnerToken, TALKR_DEFAULT_URL } from '../_shared/talkr-outreach.ts';
import { type Line, isMainLine, lineCap, tail } from './line-pick.ts';

export * from './line-pick.ts';

/** The number we last texted this person from, in this workspace. */
export async function lastLineTo(admin: SupabaseClient, wsId: number, who: { buyer_id: number | null; seller_id: number | null }): Promise<string | null> {
  const col = who.buyer_id ? 'buyer_id' : who.seller_id ? 'seller_id' : null;
  if (!col) return null;
  const { data } = await admin.from('communications').select('from_phone').eq('workspace_id', wsId).eq(col, who.buyer_id ?? who.seller_id)
    .eq('channel', 'sms').eq('direction', 'outbound').not('from_phone', 'is', null).order('occurred_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { from_phone?: string | null } | null)?.from_phone ?? null;
}


/**
 * The sender's own text lines with today's count (outbound texts in the last
 * 24 hours from that number, any workspace). Only lines Talkr assigns to the
 * sender: the Inbox files a text thread under its line's owner
 * (lib/inbox-owner), so a reply to a text sent from a teammate's line would
 * land in the teammate's Inbox. A ringless-pool number assigned to the
 * sender counts too. Empty when the sender owns no line (no partner token,
 * or none assigned). Throws when Talkr cannot be read, so a caller tells the
 * two apart: plan-tick and dispo-campaign-tick hold the text, the AI agent
 * keeps the rep's default line.
 *
 * `shared` adds the office lines nobody owns (a dispo blast's overflow). A
 * reply on one files under the conversation's rep, who is whoever texted
 * first (Talkr assigns the conversation to the sender), so it comes back to
 * the rep who sent the blast. Teammates' own lines stay out: their Inbox would
 * take the reply. Ringless-voicemail pool lines, AI agent numbers and retired
 * lines stay out too.
 */
export async function loadLines(admin: SupabaseClient, wsId: number, senderId: string, settings: Record<string, unknown>, opts: { shared?: boolean } = {}): Promise<Line[]> {
  const { data: p } = await admin.from('profiles').select('email').eq('id', senderId).maybeSingle();
  const token = await partnerToken({ id: senderId, email: (p?.email as string | null) ?? null });
  if (!token) return [];
  const base = String(settings.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  type OrgNumber = { id: string; phone_e164: string; assigned_user_id: string | null; label?: string | null };
  let org: OrgNumber[] = [];
  let me: string | null = null;
  let res: Response;
  try {
    res = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new Error(`Talkr /v1/me unreachable: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new Error(`Talkr /v1/me answered ${res.status}`);
  const body = await res.json().catch(() => ({})) as { id?: string; org_numbers?: OrgNumber[] };
  org = body.org_numbers ?? [];
  me = body.id ?? null;
  if (!me) throw new Error('Talkr /v1/me answered without a user id');
  let off = new Set<string>();
  if (opts.shared) {
    const { data: skip } = await admin.from('caller_lines').select('phone_e164, pool, retired_at').eq('workspace_id', wsId)
      .or('pool.eq.rvm,retired_at.not.is.null');
    off = new Set(((skip ?? []) as { phone_e164: string }[]).map((r) => tail(r.phone_e164)));
    // An AI agent's number (Riley, Jordan, Avery, Cody...) answers with the agent: a buyer's reply or callback would reach a bot.
    const { data: agents } = await admin.from('voice_agent_numbers').select('phone_number').not('phone_number', 'is', null);
    for (const a of (agents ?? []) as { phone_number: string }[]) off.add(tail(a.phone_number));
  }
  const lines = org.filter((n) => n.id && !off.has(tail(n.phone_e164)) && (n.assigned_user_id === me || (opts.shared && !n.assigned_user_id)))
    .map((n): Line => ({ id: n.id, e164: n.phone_e164, sent: 0 }));
  if (!lines.length) return [];
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  // This workspace's texts only (a line shared across workspaces counted the other's), every page.
  const recent = await everyRow<{ from_phone: string | null }>(() => admin.from('communications').select('from_phone')
    .eq('workspace_id', wsId).eq('channel', 'sms').eq('direction', 'outbound')
    .gte('occurred_at', since).in('from_phone', lines.map((l) => l.e164)).order('id')).catch(() => [] as { from_phone: string | null }[]);
  for (const r of recent) {
    const l = lines.find((x) => tail(x.e164) === tail(r.from_phone));
    if (l) l.sent++;
  }
  // Each line's ramp, from its first text ever.
  await Promise.all(lines.map(async (l) => {
    const { data: first } = await admin.from('communications').select('occurred_at').eq('channel', 'sms').eq('direction', 'outbound')
      .eq('from_phone', l.e164).order('occurred_at', { ascending: true }).limit(1).maybeSingle();
    l.cap = lineCap((first as { occurred_at?: string } | null)?.occurred_at);
  }));
  // A blast never goes out on a main line (Sam Main, Company Main, Acme Homes main): cap 0 keeps it
  // in the list, so a blast picked on it still spreads across the other lines instead of sending from it.
  if (opts.shared) for (const l of lines) if (isMainLine(org.find((n) => n.id === l.id)?.label)) l.cap = 0;
  return lines;
}
