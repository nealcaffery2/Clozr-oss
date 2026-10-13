// The buyer-facing side of dispositions: a public listing page per deal, and a
// signed per-buyer link into it.
//
// The database side of this is already deployed (migrations
// public_listing_page_rpcs and public_listing_offer_dedupe, plus the `listing`
// edge function). Nothing here creates schema; it calls what is there.
//
// Why the links matter more than they look: a buyer has no CLOZR login, so the
// page identifies them by a signed HMAC token in the URL. That token is what
// turns "someone viewed the deal" into "Julie viewed the deal for 90 seconds
// and opened four photos", and it is the only way an offer from the page can be
// attributed. A campaign that sends the bare page URL still works — it just
// cannot tell you who did anything.

import type { DealPublicLink } from './database.types';
import { SUPABASE_URL, supabase } from './supabase';

export type { DealPublicLink };

/** buyer id (as a string key, because it comes back as JSON) -> signed URL. */
export type LinkMap = Record<string, string>;

export type LinksResult = { slug: string; url: string; links: LinkMap };

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * The app's own public origin, for links that leave the building in a text or
 * an email. NEXT_PUBLIC_APP_URL wins so a rep on a preview deploy or localhost
 * still sends the production domain; the page's own origin otherwise.
 */
export function appOrigin(): string {
  const env = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(env)) return env;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

const FN_BASE = () => `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/listing`;

/** The listing edge function that renders the page. Buyers never see this URL. */
export const listingSourceUrl = (slug: string, token?: string | null) =>
  `${FN_BASE()}/${slug}${token ? `?t=${encodeURIComponent(token)}` : ''}`;

/**
 * The buyer-facing URL of a deal's page, on the app's own domain (app/deal).
 * A raw *.supabase.co link in a blast reads as spam to carriers and buyers,
 * and Supabase serves edge-function HTML as plain text on that host anyway.
 * `token` is the buyer's signed attribution token.
 */
export const listingUrl = (slug: string, token?: string | null) => {
  const origin = appOrigin();
  if (!origin) return listingSourceUrl(slug, token);
  return `${origin}/deal?s=${encodeURIComponent(slug)}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
};

/** A listing URL the edge function minted, moved onto the app's domain. Anything else is returned as is. */
export function toAppListingUrl(url: string): string {
  const m = /\/functions\/v1\/listing\/([a-z0-9_-]+)(?=$|[?#])(?:\?t=([^&#]+))?/i.exec(url);
  if (!m || m[1] === 'market' || m[1] === 'r') return url;
  return listingUrl(m[1], m[2] ? decodeURIComponent(m[2]) : null);
}

/** Acme Homes marketplace index, in the app (the edge function only redirects there). */
export const marketplaceUrl = () => {
  const origin = appOrigin();
  return origin ? `${origin}/marketplace` : `${FN_BASE()}/market`;
};

/**
 * The deal's active public link, created on the first call. Safe to call again:
 * it updates the headline and description and returns the same slug, so a link
 * already sitting in someone's texts keeps working.
 */
export async function publishDeal(
  dealId: number,
  opts: { headline?: string; description?: string } = {},
): Promise<Res<DealPublicLink>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('deal_public_link_ensure', {
    p_deal_id: dealId,
    p_headline: opts.headline ?? null,
    p_description: opts.description ?? null,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: data as DealPublicLink };
}

/** Read the existing link without creating one. */
export async function getPublicLink(dealId: number): Promise<Res<DealPublicLink | null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase
    .from('deal_public_links')
    .select('*')
    .eq('deal_id', dealId)
    .eq('active', true)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: (data as DealPublicLink) ?? null };
}

/**
 * Turn the page off, or change what it shows. Deactivating leaves the row in
 * place, so the view counts survive and the slug is never handed to another
 * deal.
 */
export async function updatePublicLink(
  linkId: number,
  patch: Partial<Pick<DealPublicLink,
    'active' | 'show_address' | 'allow_offers' | 'on_marketplace' | 'show_viewers' | 'headline' | 'description' | 'expires_at'>>,
): Promise<Res<DealPublicLink>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase
    .from('deal_public_links')
    .update(patch)
    .eq('id', linkId)
    .select()
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: data as DealPublicLink };
}

/**
 * Per-buyer signed URLs for a deal, publishing the deal first if it is not
 * published yet. Omit buyerIds to cover every matched buyer (the function caps
 * it at 2000).
 *
 * Call this before building a campaign plan, not after: the {{listing_url}}
 * merge tag is filled from this map, and a buyer missing from it gets no link.
 */
export async function mintBuyerLinks(
  dealId: number,
  buyerIds?: number[],
  opts: { headline?: string; description?: string } = {},
): Promise<Res<LinksResult>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('listing/links', {
    body: { deal_id: dealId, buyer_ids: buyerIds, headline: opts.headline, description: opts.description },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const res = data as LinksResult;
  // The function mints its own host into every link; the texts carry ours.
  const links: LinkMap = Object.fromEntries(Object.entries(res.links ?? {}).map(([id, u]) => [id, toAppListingUrl(u)]));
  return { ok: true, data: { ...res, url: res.url ? toAppListingUrl(res.url) : res.url, links } };
}
