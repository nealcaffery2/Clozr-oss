// The address CLOZR keeps in the hash, and what a Back link does with it.
//
// `#screen=person&id=s42&deal=d7&from=deals` — the screen, its record, the
// house it is pinned to, and where it was opened from. `from` is
// `<screen>[:<record id>[:<deal id>]]`, so a reload keeps the back link's
// destination, and a seller opened from a wholesaler's second TC file goes
// back to that file, not the seller's first. Pure, so the codec and
// the back decision are testable without a browser
// (`npx tsx tools/nav-hash.test.ts`).

export type NavHash = { screen: string; id: string | null; deal: string | null; from: string | null };
/** A place a Back link can go: a screen, on a record screen the record, and the house it was pinned to. */
export type NavRef = { screen: string; id: string | null; deal?: string | null };

/**
 * Screens that carry `from` in their address: records and sub-screens, the
 * ones with a Back link. Top-level screens (the nav's own) don't need one, and
 * leaving it off keeps their addresses short and stable.
 */
export const FROM_SCREENS: ReadonlySet<string> = new Set([
  'person', 'dealSheet', 'buyer', 'dispoProperty', 'tc', 'plans', 'leaderboard',
]);

const SAFE = /^[A-Za-z][A-Za-z0-9]*$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `{ screen: 'tc', id: 's42', deal: 'd9' }` → `'tc:s42:d9'`; a junk id or deal is left off. */
export function formatFrom(ref: NavRef | null | undefined): string | null {
  if (!ref || !SAFE.test(ref.screen)) return null;
  const id = ref.id && SAFE_ID.test(ref.id) ? ref.id : '';
  const deal = ref.deal && SAFE_ID.test(ref.deal) ? ref.deal : '';
  return deal ? `${ref.screen}:${id}:${deal}` : id ? `${ref.screen}:${id}` : ref.screen;
}

/** `'tc:s42:d9'` → `{ screen: 'tc', id: 's42', deal: 'd9' }`; anything malformed → null. */
export function parseFrom(raw: string | null | undefined): NavRef | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const [screen, id = '', deal = '', ...rest] = t.split(':');
  if (rest.length || !SAFE.test(screen) || (id && !SAFE_ID.test(id)) || (deal && !SAFE_ID.test(deal))) return null;
  return { screen, id: id || null, deal: deal || null };
}

/** The same place: screen, record and pinned house. */
export const sameRef = (a: NavRef | null | undefined, b: NavRef | null | undefined): boolean =>
  !!a && !!b && a.screen === b.screen && (a.id ?? null) === (b.id ?? null) && (a.deal ?? null) === (b.deal ?? null);

/**
 * The hash for a place. Home is the bare address unless `bareHome` is off
 * (a role that lands elsewhere has to say Home to survive a reload).
 */
export function encodeNavHash(h: NavHash, bareHome = true): string {
  if (h.screen === 'home' && bareHome && !h.deal) return '';
  const q = new URLSearchParams({ screen: h.screen });
  if (h.id) q.set('id', h.id);
  if (h.deal) q.set('deal', h.deal);
  const from = FROM_SCREENS.has(h.screen) ? formatFrom(parseFrom(h.from)) : null;
  if (from) q.set('from', from);
  return '#' + q.toString();
}

/** The hash back into its parts; null when it names no screen. */
export function decodeNavHash(hash: string): NavHash | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const screen = q.get('screen');
  if (!screen) return null;
  const from = formatFrom(parseFrom(q.get('from')));
  return { screen, id: q.get('id'), deal: q.get('deal'), from: FROM_SCREENS.has(screen) ? from : null };
}

/**
 * What a Back link does. When the entry before this one in the tab's history
 * is the place Back names, step back to it: browser Back and in-app Back then
 * agree, with no loop. Otherwise (opened from a link, after a reload that lost
 * the stack) replace this entry with `from`, or with the screen's own
 * fallback when there is no `from`.
 */
export function backAction(
  from: NavRef | null,
  previous: NavRef | null,
  fallback: NavRef,
): { kind: 'history' } | { kind: 'replace'; to: NavRef } {
  if (from && sameRef(from, previous)) return { kind: 'history' };
  return { kind: 'replace', to: from ?? fallback };
}

/**
 * Where login sends you after signing in: the `?next=` the app put there when
 * it bounced you, if it is a CLOZR app address on this site; else `/app`.
 * Same-origin and under /app only, so a crafted link can't send a fresh
 * session anywhere else (an open redirect).
 */
export function safeNext(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t || t.length > 2048 || !t.startsWith('/') || t.startsWith('//') || /[\\\u0000-\u001f]/.test(t)) return '/app';
  let u: URL;
  try { u = new URL(t, 'https://clozr.invalid'); } catch { return '/app'; }
  if (u.origin !== 'https://clozr.invalid') return '/app';
  if (u.pathname !== '/app' && !u.pathname.startsWith('/app/')) return '/app';
  return u.pathname + u.search + u.hash;
}
