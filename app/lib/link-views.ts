// "Viewed" on a text, from the CLOZR link inside it.
//
// SMS and MMS have no read receipts: a carrier reports sent and delivered,
// never read. Real read receipts on texts need RCS, which Talkr does not
// carry (app/docs/inbox-receipts.md). What CLOZR does know is when someone
// opens a link it minted, because the page behind the link records the open:
//
//   sign     /sign/?t=<48 hex>       an offer or contract signing link
//                                    (contract_signers.viewed_at, esign)
//   listing  /deal?s=<slug>&t=<tok>  a buyer's own tracked deal page
//            /functions/v1/listing/<slug>?t=<tok>
//                                    (deal_page_views by deal and buyer)
//
// So a text carrying one of those links can say "Viewed 2:14 PM" once the
// person opens it. Pure, so the parsing is testable
// (`npx tsx tools/link-views.test.ts`).

export type TrackedLink =
  | { kind: 'sign'; key: string; token: string }
  | { kind: 'listing'; key: string; deal: number; buyer: number };

export type LinkView = {
  /** First time the person opened it (ISO). */
  firstAt: string;
  /** How many times it was opened, when the page counts them. */
  views?: number | null;
  /** Seconds spent on it, when the page measures that. */
  seconds?: number | null;
};

const SIGN = /\/sign\/?\?(?:[^\s#]*&)?t=([a-f0-9]{48})(?![a-f0-9])/gi;
const LISTING = /(?:\/deal\/?\?[^\s#]*|\/functions\/v1\/listing\/[a-z0-9_-]+\?(?:[^\s#]*&)?)\bt=([A-Za-z0-9_%.-]+)/gi;

function b64urlJson(s: string): unknown {
  try {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(pad + '==='.slice((pad.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/**
 * The buyer and deal a listing token names. The token is `<base64url JSON>.<sig>`
 * with `{ w, d, b }` (supabase/functions/listing). Reading it needs no secret:
 * the signature only matters to the server deciding whom to credit.
 */
export function readListingClaim(token: string): { deal: number; buyer: number } | null {
  let t = token;
  try { t = decodeURIComponent(token); } catch { /* keep as is */ }
  const body = t.split('.')[0];
  if (!body) return null;
  const c = b64urlJson(body) as { d?: unknown; b?: unknown } | null;
  const deal = Number(c?.d);
  const buyer = Number(c?.b);
  return Number.isInteger(deal) && deal > 0 && Number.isInteger(buyer) && buyer > 0 ? { deal, buyer } : null;
}

/** Every CLOZR tracked link in a message, once each, in order. */
export function trackedLinks(text: string | null | undefined): TrackedLink[] {
  const body = String(text ?? '');
  if (!body.includes('t=')) return [];
  const out: TrackedLink[] = [];
  const seen = new Set<string>();
  const add = (l: TrackedLink) => { if (!seen.has(l.key)) { seen.add(l.key); out.push(l); } };
  for (const m of body.matchAll(SIGN)) add({ kind: 'sign', key: `sign:${m[1]!.toLowerCase()}`, token: m[1]!.toLowerCase() });
  for (const m of body.matchAll(LISTING)) {
    const claim = readListingClaim(m[1]!);
    if (claim) add({ kind: 'listing', key: `listing:${claim.deal}:${claim.buyer}`, ...claim });
  }
  return out;
}

/** The earliest open across a message's links, or null while none has been opened. */
export function firstView(links: readonly TrackedLink[], views: ReadonlyMap<string, LinkView>): LinkView | null {
  let best: LinkView | null = null;
  let total = 0;
  let counted = false;
  for (const l of links) {
    const v = views.get(l.key);
    if (!v) continue;
    if (v.views != null) { total += v.views; counted = true; }
    if (!best || Date.parse(v.firstAt) < Date.parse(best.firstAt)) best = v;
  }
  return best ? { ...best, views: counted ? total : best.views ?? null } : null;
}

/** "2:14 PM" today, "Yesterday 2:14 PM", "Oct 3, 2:14 PM" before that. */
export function viewStamp(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** What a text says under it: "Viewed 2:14 PM", "Link not opened yet", or nothing without a tracked link. */
export function viewLabel(links: readonly TrackedLink[], views: ReadonlyMap<string, LinkView>, now = Date.now()): string | null {
  if (!links.length) return null;
  const v = firstView(links, views);
  if (!v) return 'Link not opened yet';
  return `Viewed ${viewStamp(v.firstAt, now)}${v.views && v.views > 1 ? ` · ${v.views} times` : ''}`;
}

/**
 * An email's receipt (email_tracking, migration 82): "Opened 2:14 PM · 4 opens
 * · 1 click", "Not opened yet", or null when the send was not tracked.
 */
export function emailOpenLabel(r: { opens: number; clicks: number; first_opened_at: string | null } | undefined, now = Date.now()): string | null {
  if (!r) return null;
  if (!r.opens || !r.first_opened_at) return 'Not opened yet';
  const opens = r.opens > 1 ? ` · ${r.opens} opens` : '';
  const clicks = r.clicks ? ` · ${r.clicks} click${r.clicks === 1 ? '' : 's'}` : '';
  return `Opened ${viewStamp(r.first_opened_at, now)}${opens}${clicks}`;
}

/** The longer line for a tooltip: when it was first opened and how often. */
export function viewTitle(links: readonly TrackedLink[], views: ReadonlyMap<string, LinkView>): string {
  const v = firstView(links, views);
  const what = links.some((l) => l.kind === 'sign') ? 'the signing link' : 'their deal page';
  if (!v) return `Nobody has opened ${what} yet. Texts have no read receipts; opening the link is the signal.`;
  const when = new Date(v.firstAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const often = v.views && v.views > 1 ? `, ${v.views} times in all` : '';
  const long = v.seconds ? `, ${Math.max(1, Math.round(v.seconds / 60))} min on the page` : '';
  return `Opened ${what} first ${when}${often}${long}.`;
}
