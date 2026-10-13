/**
 * When the number-guard digest is worth a new notification.
 *
 * The digest is the list of things still open on the phone numbers. It used
 * to be re-posted whenever its text differed from the last run's, and the
 * text differs almost every morning: the 10DLC line is reworded as the filing
 * moves (brand filed → campaign rejected → waiting on the balance), a
 * checklist count ticks, one item drops off. Each of those posted a fresh
 * "7 things to fix on your phone numbers" row, so an admin who marked
 * yesterday's read found the same list back in the bell the next day.
 *
 * So the digest is compared by topic, not by wording: it notifies only when a
 * topic shows up that the last run did not have. Topics are read off the line
 * itself, which means the `open` lines already stored on past runs
 * (number_guard_runs.summary.open) compare without a backfill.
 *
 * Pure, so `npx tsx tools/number-digest.test.ts` covers it.
 */

/** The topic a digest line is about. Stable across rewording and counts. */
export function digestTopic(line: string): string {
  const s = line.trim();
  // Workspace 10DLC standing: one topic whatever stage the filing is at.
  if (/^(the |no )?10dlc\b/i.test(s)) return '10dlc';
  // Per line: "<label> (+1…) is not on a 10DLC campaign", "…: high spam risk", "… is poor".
  const phone = /\+\d{8,15}/.exec(s)?.[0];
  if (phone) {
    const kind = /not on a 10dlc campaign/i.test(s) ? 'campaign' : /spam risk/i.test(s) ? 'spam' : 'grade';
    return `${phone}:${kind}`;
  }
  // Checklist items are "<title>: <detail>"; the rest lead with their subject.
  const head = s.split(/:\s| — /)[0] ?? s;
  return head.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Topics in `open` that `lastOpen` did not have. With no stored `lastOpen`
 * (a run from before the list was kept), falls back to comparing the text.
 */
export function newDigestTopics(open: string[], lastOpen: unknown, lastDigest: unknown): string[] {
  if (!open.length) return [];
  if (!Array.isArray(lastOpen)) {
    return open.join('\n') === lastDigest ? [] : [...new Set(open.map(digestTopic))];
  }
  const seen = new Set(lastOpen.filter((x): x is string => typeof x === 'string').map(digestTopic));
  return [...new Set(open.map(digestTopic).filter((t) => !seen.has(t)))];
}
