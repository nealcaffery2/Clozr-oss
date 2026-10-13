// Where a bell row takes you: the exact spot it is about, not just the record.
//
// A text opens the record's Texts, a missed call its Calls, a mention its
// Notes; a row about one deal opens the record pinned to that deal (the TC
// file or the dispo property when that is whose it is); a contract opens the
// deal's contracts, or the Contracts list; number health opens the numbers in
// Settings. Pure, so it is tested (tools/notif-target.test.ts).

export type NotifLink = {
  screen: string;
  id: string;
  /** The tab to land on: a person or buyer record tab, or a Settings section. */
  tab?: string;
  /** The deal the row is about (client id, 'd' + deals.id). */
  dealId?: string;
  /** The other side's E.164 number, for a text thread. */
  phone?: string;
};

export type NotifRowLike = {
  category: string;
  title: string;
  seller_id: number | null;
  buyer_id?: number | null;
  deal_id?: number | null;
  phone_key?: string | null;
};

const FLOOR = new Set(['Badge', 'Leaderboard', 'Wheel', 'Contract']);

/** The E.164 number a text notification is from: its phone_key (migration 152), else the number in an older row's "New text from +1…" title. */
export function notifPhone(n: Pick<NotifRowLike, 'category' | 'title' | 'phone_key'>): string | null {
  if (n.category !== 'inbound_sms') return null;
  const raw = n.phone_key || n.title.match(/^New text from (\+?[\d\s().-]{10,})$/)?.[1] || '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

/**
 * A notifications row's link. `dispoSeller` is the seller of the row's deal
 * when only the deal is known (a Dispo note keyed by deal).
 */
export function notifLink(n: NotifRowLike, dispoSeller: number | null = null): NotifLink {
  const cat = n.category;
  const sid = n.seller_id ? 's' + n.seller_id : '';
  const bid = n.buyer_id ? 'b' + n.buyer_id : '';
  const dealId = n.deal_id ? 'd' + n.deal_id : undefined;
  const deal = dealId ? { dealId } : {};
  const phone = notifPhone(n);

  if (FLOOR.has(cat)) return { screen: 'leaderboard', id: '' };
  // Lane opens on the file it is about, or on the morning check-in.
  if (cat === 'Lane') return { screen: 'lane', id: sid };
  if (cat === 'Number health') return { screen: 'settings', id: '', tab: 'numbers' };

  if (sid) {
    if (cat === 'TC') return { screen: 'tc', id: sid, ...deal };
    // Offer accepted: the deal on the Dispo board.
    if (cat === 'Dispo' && dealId) return { screen: 'dispoProperty', id: sid, dealId };
    const tab = cat === 'inbound_sms' ? 'Texts' : cat === 'Mention' ? 'Notes' : undefined;
    return { screen: 'person', id: sid, ...(tab ? { tab } : {}), ...deal, ...(phone ? { phone } : {}) };
  }
  if (bid) {
    const tab = cat === 'Mention' ? 'Notes' : cat === 'Contracts' ? 'Contracts' : undefined;
    return { screen: 'buyer', id: bid, ...(tab ? { tab } : {}), ...(phone ? { phone } : {}) };
  }
  if (dispoSeller) return { screen: 'dispoProperty', id: 's' + dispoSeller, ...deal };
  // A text from a number that is not a contact yet: its Inbox thread.
  if (phone) return { screen: 'inboxSms', id: phone };
  if (cat === 'Contracts') return { screen: 'contracts', id: '' };
  return { screen: 'home', id: '' };
}

/** A missed call or text built from a message (lib/bell-events): the record's Calls or Texts. */
export function commTab(cat: 'Call' | 'SMS'): string {
  return cat === 'Call' ? 'Calls' : 'Texts';
}
