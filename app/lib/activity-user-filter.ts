// Activity feed "User" filter: rep's own rows plus full text/email threads
// they took part in (inbound on their line counts via toRep).

import { emailThreadKey, type ThreadEmail } from './email-thread';

export type ActivityFilterRow = {
  id: string;
  actor: string;
  isSms?: boolean;
  toRep?: string | null;
  email?: ThreadEmail | null;
};

export function isSmsRow(t: Pick<ActivityFilterRow, 'isSms'> & { chan?: string; type?: string }): boolean {
  if (t.isSms) return true;
  const c = t.chan ?? t.type ?? '';
  return /sms/i.test(c);
}

/** A row is "by" this user, or an inbound text on their line. */
export function activityRowByUser(t: ActivityFilterRow, user: string): boolean {
  if (user === 'System') return t.actor === 'System';
  if (t.actor === user) return true;
  if (t.toRep === user) return true;
  return false;
}

/** One rep's text thread with this contact (their line + their sends). */
export function smsConversationKey(t: ActivityFilterRow): string | null {
  if (!isSmsRow(t)) return null;
  if (t.actor !== 'System') return `rep:${t.actor}`;
  if (t.toRep) return `rep:${t.toRep}`;
  return 'rep:unknown';
}

/**
 * Newest-first feed. SMS: keep the whole rep thread when they sent or received
 * on their line. Email: keep every row in a thread when any row does.
 * Other channels: row-by-row on actor / toRep.
 */
export function filterActivityByUser<T extends ActivityFilterRow>(feed: T[], user: string): T[] {
  if (!user || user === 'Any') return feed;
  const include = new Set<string>();

  const emailGroups = new Map<string, T[]>();
  for (const item of feed) {
    if (item.email) {
      const key = emailThreadKey(item.email);
      const g = emailGroups.get(key);
      if (g) g.push(item);
      else emailGroups.set(key, [item]);
    }
  }
  for (const group of emailGroups.values()) {
    if (group.some((x) => activityRowByUser(x, user))) {
      for (const x of group) include.add(x.id);
    }
  }

  const smsGroups = new Map<string, T[]>();
  for (const item of feed) {
    const key = smsConversationKey(item);
    if (!key) continue;
    const g = smsGroups.get(key);
    if (g) g.push(item);
    else smsGroups.set(key, [item]);
  }
  for (const group of smsGroups.values()) {
    if (group.some((x) => activityRowByUser(x, user))) {
      for (const x of group) include.add(x.id);
    }
  }

  for (const item of feed) {
    if (isSmsRow(item) || item.email) continue;
    if (activityRowByUser(item, user)) include.add(item.id);
  }

  return feed.filter((t) => include.has(t.id));
}
