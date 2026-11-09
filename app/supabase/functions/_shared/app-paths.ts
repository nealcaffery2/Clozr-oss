// The operator app paths the functions link to (`/app/people/s42`,
// `/app/deals/d7`, `/app/coaching`) in emails, calendar events, webhook
// payloads and OAuth returns.
//
// The app's own route table is lib/routes.ts. Deno cannot load it (its imports
// carry no extension), so this file copies the few paths the functions write.
// tools/app-paths.test.ts parses every one of them back through lib/routes.ts
// parsePath, so the two copies cannot drift.
//
// Pure, no Deno global: the app's tsx tests import it.

/** The operator app's root. */
export const APP_BASE = '/app';

/** A database id as a path segment: digits only, else null. */
function dbId(id: unknown): string | null {
  const s = typeof id === 'number' ? (Number.isSafeInteger(id) && id >= 0 ? String(id) : '') : String(id ?? '').trim();
  return /^\d{1,18}$/.test(s) ? s : null;
}

/**
 * A record's page, or the list it belongs to when the id is not one: a link
 * never points at nothing.
 */
const record = (list: string, prefix: string) => (id: unknown): string => {
  const n = dbId(id);
  return n ? `${APP_BASE}/${list}/${prefix}${n}` : `${APP_BASE}/${list}`;
};

/** The paths the functions link to. */
export const appPath = {
  /** The app; the page sends a member to their role's landing. */
  base: APP_BASE,
  /** A seller's record: `/app/people/s42`. */
  seller: record('people', 's'),
  /** A buyer's record: `/app/buyers/b9`. */
  buyer: record('buyers', 'b'),
  /** A deal sheet: `/app/deals/d7` (the app fills in the seller). */
  deal: record('deals', 'd'),
  /** A contract: `/app/contracts/k123`. */
  contract: record('contracts', 'k'),
  coaching: `${APP_BASE}/coaching`,
  calendar: `${APP_BASE}/calendar`,
  tasks: `${APP_BASE}/tasks`,
  /** Reporting on its Custom reports tab, where a scheduled report is edited. */
  customReports: `${APP_BASE}/reporting/custom`,
  /** Settings → Email deliverability: mailboxes, senders, domains and their pauses. */
  deliverability: `${APP_BASE}/settings/email/deliverability`,
  /** Cold email campaigns and the cold pool. */
  campaigns: `${APP_BASE}/campaigns`,
  /** Dispo, where blast campaigns are sent from. */
  dispo: `${APP_BASE}/dispo`,
} as const;

/** An absolute link: the origin (a trailing slash is dropped) plus an app path. */
export function appLink(origin: string, path: string): string {
  return `${String(origin ?? '').replace(/\/+$/, '')}${path}`;
}

/**
 * True for a line that is one of our own calendar links, the old
 * `<origin>/clozr/` or a path this file writes, so the calendar pull can keep
 * it out of an appointment's notes.
 */
export function isOwnCalendarLink(line: string): boolean {
  return /^https?:\/\/[^\s/]+\/(?:clozr\/?|app\/(?:people\/s\d{1,18}|buyers\/b\d{1,18}|calendar|tasks))$/.test(String(line ?? '').trim());
}
