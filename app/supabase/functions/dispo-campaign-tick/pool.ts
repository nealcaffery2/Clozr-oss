/**
 * The send loop's shape, apart from index.ts so tools/dispo-tick-pool.test.ts
 * can run two overlapping ticks against a fake client.
 *
 * Due messages go in waves of up to POOL, at most one per lane. A wave is
 * claimed first, one conditional update each (queued → sending, exactly as
 * before), then it reads what it needs once (recipients, the blacklist), then
 * every claimed message sends at once. Only the run whose update flipped the
 * row sends it. Nothing in a wave waits behind another message of the wave,
 * so a claim is as close to its send as before, and a user who cancels a
 * still-queued message (marked interested, STOP, campaign cancelled) still
 * stops it up to its claim.
 */

type Any = any;

/** Messages in flight at once, and so the most a wave holds. */
export const POOL = 5;

export type Lane = { id: number; workspace_id: number; campaign_id: number; recipient_id: number; channel: string };

/**
 * Messages with the same key never run side by side, and keep due order.
 * Texts stay one at a time per workspace, as before: Talkr checks a line's
 * daily cap by counting before it inserts, with no lock (its smsDecision),
 * and picks the line itself when the campaign names none, so parallel posts
 * could overshoot a cap. AI calls stay one at a time per workspace too;
 * nothing here shows the dispo agent expects parallel dials. Email and
 * voicemail drops are one at a time per recipient (a suppressed address still
 * cancels that buyer's next queued email before it is claimed) and otherwise
 * parallel: email_send_claim counts and reserves a mailbox under an advisory
 * lock, so caps and spacing hold however many run; a drop is only a row for
 * the RVM tick.
 */
export function laneKey(m: Lane): string {
  return m.channel === 'sms' || m.channel === 'ai_call' ? `${m.channel}:${m.workspace_id}` : `${m.channel}:r${m.recipient_id}`;
}

/** The next wave in due order, at most one message per lane and `size` in all. The rest wait for later waves. */
export function nextWave<T extends Lane>(due: T[], size = POOL): { wave: T[]; rest: T[] } {
  const keys = new Set<string>();
  const wave: T[] = [];
  const rest: T[] = [];
  for (const m of due) {
    const k = laneKey(m);
    if (wave.length < size && !keys.has(k)) { keys.add(k); wave.push(m); } else rest.push(m);
  }
  return { wave, rest };
}

/** A per-tick cache that hands every caller the same promise, so sends side by side read once. */
export function once<K, V>(load: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const m = new Map<K, Promise<V>>();
  return (k) => {
    let p = m.get(k);
    if (!p) m.set(k, (p = load(k)));
    return p;
  };
}

/** Claim it: only one tick gets past this. A failed update is not a claim. */
export async function claim(db: Any, id: number): Promise<boolean> {
  const { data, error } = await db.from('dispo_campaign_messages').update({ status: 'sending' }).eq('id', id).eq('status', 'queued').select('id');
  return !error && !!data?.length;
}

/** Hand back a claim this run will not use. Nothing was sent; the next tick takes it. */
export async function unclaim(db: Any, id: number): Promise<void> {
  const { error } = await db.from('dispo_campaign_messages').update({ status: 'queued' }).eq('id', id).eq('status', 'sending');
  if (error) console.error('dispo unclaim failed, left as sending', id, error.message);
}

export type Tick<M, W> = {
  db: Any;
  /** Reads for the wave, after its claims. null: the wave was rescheduled, send none of it. */
  prepare: (won: M[]) => Promise<W | null>;
  send: (m: M, wave: W) => Promise<void>;
  /** Past the time budget: claim no more. */
  late: () => boolean;
};

export async function runWaves<M extends Lane, W>(due: M[], t: Tick<M, W>, size = POOL): Promise<void> {
  let rest = due;
  while (rest.length) {
    if (t.late()) return;
    const next = nextWave(rest, size);
    rest = next.rest;
    const got = await Promise.all(next.wave.map((m) => claim(t.db, m.id)));
    const won = next.wave.filter((_, j) => got[j]);
    if (!won.length) continue;
    // Nothing of the wave is sent yet, so a throw here hands the claims back.
    const w = await t.prepare(won).catch(async (e) => {
      console.error('dispo wave read threw, claims handed back', String(e));
      for (const m of won) await unclaim(t.db, m.id);
      return null;
    });
    if (w === null) continue;
    // A throw may come after the send, so that message stays claimed (as a
    // crashed tick left it before) and the rest of the wave carries on.
    // dispo_campaign_kick marks it failed after 30 minutes, never queued (354).
    await Promise.all(won.map((m) => t.send(m, w).catch((e) => console.error('dispo send threw, left as sending', m.id, String(e)))));
    // dispo_message_sent marks a campaign done only when nothing of it is
    // queued or sending, and a drop or an AI call never asks. Sends side by
    // side can each see the other still sending, so once the wave has
    // settled, ask once for every campaign it touched. The call only marks
    // done when nothing is queued or sending.
    for (const id of new Set(won.map((m) => m.campaign_id))) {
      const { error } = await t.db.rpc('dispo_campaign_finish', { p_campaign_id: id });
      if (error) console.error('dispo campaign finish failed', id, error.message);
    }
  }
}
