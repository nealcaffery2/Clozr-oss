// One property, one blast per buyer. Two campaigns for the same deal (the
// same deal_id) must not reach the same buyer twice: on 2026-10-21 campaigns 8
// and 9 went to the same 1,056 buyers minutes apart. A blast about another
// property is fine. Pure, so the launch dialogs (Composer, QuickCampaign), the
// tick (dispo-campaign-tick) and tools/blast-dupes.test.ts share it.

/** A message that already went out (status sent or delivered) for this deal. */
export type PriorSend = { buyer_id: number; campaign_id: number; sent_at: string | null; by: string | null };

export type Dupes = {
  /** Buyers of the new blast who already got one for this property. */
  ids: Set<number>;
  /** Who sent them and when, one entry per sender and day, biggest first. */
  groups: { by: string | null; day: string; count: number }[];
};

const dayOf = (iso: string | null, tz: string) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }) : 'an earlier day';

/** When a send went out; one with no sent_at is not the earliest, it is unknown and loses to any dated send. */
const sentAt = (p: PriorSend) => Date.parse(p.sent_at ?? '') || Number.POSITIVE_INFINITY;

/** Which of `buyerIds` a blast for this deal already reached, each counted once, on its first send. */
export function blastDupes(buyerIds: number[], prior: PriorSend[], tz = 'America/Chicago'): Dupes {
  const want = new Set(buyerIds);
  const first = new Map<number, PriorSend>();
  for (const p of prior) {
    if (!want.has(p.buyer_id)) continue;
    const had = first.get(p.buyer_id);
    if (!had || sentAt(p) < sentAt(had)) first.set(p.buyer_id, p);
  }
  const groups = new Map<string, { by: string | null; day: string; count: number }>();
  for (const p of first.values()) {
    const day = dayOf(p.sent_at, tz);
    const key = `${p.by ?? ''}|${day}`;
    const g = groups.get(key) ?? { by: p.by, day, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return { ids: new Set(first.keys()), groups: [...groups.values()].sort((a, b) => b.count - a.count) };
}

/** "48 of these buyers already got a blast for 3430 Peachwood Trace from Morgan on Oct 20." `by` is a first name, or "you". */
export function dupeWarning(d: Dupes, address: string): string {
  const n = d.ids.size;
  if (!n) return '';
  const from = (g: Dupes['groups'][number]) => `from ${g.by ?? 'a teammate'} on ${g.day}`;
  const head = `${n.toLocaleString('en-US')} of these buyers already got a blast for ${address || 'this property'}`;
  if (d.groups.length === 1) return `${head} ${from(d.groups[0])}.`;
  const shown = d.groups.slice(0, 3).map((g) => `${g.count.toLocaleString('en-US')} ${from(g)}`);
  const rest = d.groups.slice(3).reduce((s, g) => s + g.count, 0);
  return `${head}: ${shown.join(', ')}${rest ? `, ${rest.toLocaleString('en-US')} more earlier` : ''}.`;
}

const CHANNEL_WORD: Record<string, string> = { sms: 'text', email: 'email', rvm: 'voicemail', ai_call: 'AI call' };

/**
 * The tick's guard: which messages of a wave to skip, with the reason. A
 * message is a repeat when the same buyer already got a message of the same
 * kind on the same channel for the same deal from another campaign (`sent`:
 * sent or delivered rows), or when an earlier message of this wave (due
 * order) is that same send from another campaign.
 */
export function waveRepeats<M extends { id: number; campaign_id: number; buyer_id: number; kind: string; channel: string; deal_id: number }>(
  wave: M[], sent: Omit<M, 'id'>[],
): Map<number, string> {
  const key = (x: Omit<M, 'id'>) => `${x.deal_id}|${x.buyer_id}|${x.channel}|${x.kind}`;
  const seen = new Map<string, number[]>();
  const add = (x: Omit<M, 'id'>) => { const k = key(x); seen.set(k, [...(seen.get(k) ?? []), x.campaign_id]); };
  sent.forEach(add);
  const out = new Map<number, string>();
  for (const m of wave) {
    const other = (seen.get(key(m)) ?? []).find((c) => c !== m.campaign_id);
    if (other != null) out.set(m.id, `buyer already got this ${m.kind} ${CHANNEL_WORD[m.channel] ?? m.channel} for this property from campaign ${other}`);
    else add(m);
  }
  return out;
}
