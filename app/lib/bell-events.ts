// Missed calls and inbound texts for the bell.
//
// Those land on the record as communications. The bell reads notifications,
// which never included them, so a missed call or a text showed on the timeline
// only after a sync — and not in the bell at all.

import { commTab, type NotifLink } from './notif-target';
import { replyTone, type ReplyTone } from './reply-tone';

export type BellComm = {
  id: string;
  channel: string;
  dir: string;
  party: string;
  time: string;
  /** Minutes ago. Smaller is newer. */
  ts: number;
  preview: string;
  status?: string;
  /** Set when the call had talk time — an answered call, not a miss. */
  dur?: string;
  personId?: string;
  buyerId?: string;
  /** The member whose conversation it is (the rep on it, else the line's owner); null when nobody is known. */
  owner?: string | null;
  /** The other side's number, when the row has one (an inbound call or text: who it came from). */
  phone?: string | null;
  /** When it happened (ISO), to tell which of two in the same minute came first. */
  at?: string;
};

export type BellItem = {
  id: string;
  cat: 'Call' | 'SMS';
  text: string;
  time: string;
  unread: boolean;
  link: NotifLink;
  /** Whose it is (BellComm.owner); undefined on items that are not a message. */
  owner?: string | null;
  /** Their number, so reading the thread in the Inbox clears the row. */
  phone?: string;
  /** How many calls or texts the row stands for, when more than one. */
  count?: number;
  /** A text's tone (lib/reply-tone), read from its newest message. */
  tone?: ReplyTone;
};

const MISSED = /^(no_answer|missed|busy|failed|canceled|cancelled|unanswered|rejected)$/i;

export function isMissedCall(c: Pick<BellComm, 'channel' | 'dir' | 'status' | 'dur'>): boolean {
  if (c.dir !== 'in') return false;
  if (c.channel === 'voicemail') return true;
  if (c.channel !== 'call') return false;
  if (c.dur) return false;
  if (c.status && /answered|completed|in_progress|connected/i.test(c.status)) return false;
  return !c.status || MISSED.test(c.status);
}

/**
 * Newest missed calls and inbound texts, capped so the bell stays a list.
 *
 * One row per person and kind: their newest missed call (or text), saying how
 * many there are, instead of a row per message. Its id is the newest
 * message's, so a dismissed row comes back only when something newer arrives.
 * A row is handled, and left out, once anything went out to that person after
 * it: a call back, a text, an email.
 */
export function bellFromComms(comms: BellComm[], limit = 25): BellItem[] {
  // Newer is a later `at` when both have one, else fewer minutes ago.
  const newer = (a: BellComm, b: BellComm) => {
    const ta = a.at ? Date.parse(a.at) : NaN;
    const tb = b.at ? Date.parse(b.at) : NaN;
    return Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : a.ts < b.ts;
  };
  const who = (c: BellComm) => (c.personId ? 'p:' + c.personId : c.buyerId ? 'b:' + c.buyerId : '');
  const lastOut = new Map<string, BellComm>();
  for (const c of comms) {
    const k = who(c);
    if (!k || c.dir !== 'out' || c.channel === 'note') continue;
    const cur = lastOut.get(k);
    if (!cur || newer(c, cur)) lastOut.set(k, c);
  }
  const groups = new Map<string, { cat: 'Call' | 'SMS'; newest: BellComm; count: number }>();
  for (const c of comms) {
    const k = who(c);
    if (!k) continue;
    const cat = isMissedCall(c) ? 'Call' : c.channel === 'sms' && c.dir === 'in' ? 'SMS' : null;
    if (!cat) continue;
    const out = lastOut.get(k);
    if (out && newer(out, c)) continue;
    const g = groups.get(cat + k);
    if (!g) groups.set(cat + k, { cat, newest: c, count: 1 });
    else {
      g.count++;
      if (newer(c, g.newest)) g.newest = c;
    }
  }
  const items: { ts: number; item: BellItem }[] = [];
  for (const { cat, newest: c, count } of groups.values()) {
    const base = c.personId ? { screen: 'person', id: c.personId } : { screen: 'buyer', id: c.buyerId ?? '' };
    // A seller's record opens on its Calls or Texts; a buyer's has no such tab.
    const at = (k: 'Call' | 'SMS'): NotifLink => (base.screen === 'person' ? { ...base, tab: commTab(k) } : base);
    const party = c.party || 'Unknown';
    const extra = { owner: c.owner ?? null, time: c.time, unread: true, ...(c.phone ? { phone: c.phone } : {}), ...(count > 1 ? { count } : {}) };
    if (cat === 'Call') {
      // The Calls tab lists calls only; a voicemail shows on Activity.
      const link = c.channel === 'voicemail' ? base : at('Call');
      items.push({
        ts: c.ts,
        item: { id: 'bell-call-' + c.id, cat: 'Call', text: count > 1 ? `${count} missed calls from ${party}` : `Missed call from ${party}`, link, ...extra },
      });
    } else {
      const preview = (c.preview || '').trim();
      const head = count > 1 ? `${count} texts from ${party}` : `Text from ${party}`;
      items.push({
        ts: c.ts,
        item: { id: 'bell-sms-' + c.id, cat: 'SMS', text: preview && preview !== '—' ? `${head} — ${preview}` : head, link: at('SMS'), tone: replyTone(preview), ...extra },
      });
    }
  }
  items.sort((a, b) => a.ts - b.ts);
  return items.slice(0, limit).map((x) => x.item);
}

/** The last ten digits of a number, to match one however it was written. */
export const phoneTail = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').slice(-10);
