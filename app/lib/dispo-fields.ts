// Dispo blast merge fields. One function fills every {{token}} in
// lib/message-templates MERGE_FIELDS that comes from the deal (the rest —
// first_name, rep_name — come from the buyer and the sender).
//
// View Full Deal, the money shot, Photos, and Comps & underwriting have to be
// URLs an email client can open: COMPR's public buyer report, its tokenized
// photo proxy, and the buyer CMA PDF. Private storage links and empty
// marketing_url used to leave a broken image and dead hrefs.

import { propertyTypeLabel } from '../supabase/functions/_shared/dispo-rules';
import type { Deal, Person } from './clozr-types';

/** https only, and never a private storage object — those 404 in Gmail. */
export function emailSafeUrl(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  if (!/^https:\/\//i.test(u)) return '';
  if (/\/storage\/v1\/object\/(?:sign|authenticated)\//i.test(u)) return '';
  return u;
}

/** A *.supabase.co (or .in) URL: a storage object or an edge function, not a page to hand a buyer. */
export function isSupabaseUrl(url: string | null | undefined): boolean {
  try { return /(^|\.)supabase\.(co|in)$/i.test(new URL(url ?? '').hostname); } catch { return false; }
}

export type DispoDealInput = Partial<Pick<Deal, 'arv' | 'rehab' | 'marketing' | 'underwritingUrl' | 'photoUrl' | 'heroUrl' | 'photos'>> & {
  buyerReportUrl?: string | null;
  cmaPdfUrl?: string | null;
  photosUrl?: string | null;
  listingUrl?: string | null;
  city?: string;
};

/**
 * A deal as dispo merge fields. Values that are money already carry their $.
 *
 *   marketing_link  COMPR buyer report (else a typed marketing URL, else the listing)
 *   photo_url       the hero, else the cover, else the first gallery photo an email client can open
 *                   (COMPR's tokenized /api/photo first), never a private upload
 *   photos_link     COMPR photo set on the listing, else the buyer report
 *   comps_link      COMPR buyer CMA PDF, else the buyer report
 *   deal_link       the deal's buyer page on the app's own domain
 */
export function dispoFields(d: DispoDealInput, p: Person, addr: string, price: number | null | undefined): Record<string, string> {
  const usd = (n: number | null | undefined) => (n ? '$' + Math.round(n).toLocaleString('en-US') : '');
  const num = (n: number | null | undefined) => (n ? String(n) : '');
  const city = d.city || p.property.city;
  const cityLine = [city, [p.property.st, p.property.zip].filter((x) => x && x !== '—').join(' ')].filter((x) => x && x !== '—').join(', ');
  const listing = emailSafeUrl(d.listingUrl);
  // A link a buyer clicks never shows our database host: with a deal page on
  // the app's domain, a storage or function URL gives way to it.
  const link = (url: string | null | undefined) => {
    const u = emailSafeUrl(url);
    return listing && !isSupabaseUrl(listing) && isSupabaseUrl(u) ? '' : u;
  };
  const buyer = link(d.buyerReportUrl);
  const marketing = link(d.marketing?.url);
  const view = buyer || marketing || listing;
  // Only two candidates used to be tried, so a private cover hid every public
  // photo behind it and the email went out with no picture.
  const photo = [d.heroUrl, d.photoUrl, ...(d.photos ?? [])].map(emailSafeUrl).find(Boolean) ?? '';
  const photos = link(d.photosUrl) || view;
  const comps = link(d.cmaPdfUrl) || buyer || link(d.underwritingUrl) || view;
  return {
    address: addr, full_address: [addr, cityLine].filter(Boolean).join(', '),
    city: city === '—' ? '' : city, state: p.property.st, zip: p.property.zip === '—' ? '' : p.property.zip,
    price: usd(price), asking_price: usd(price), cash_price: usd(price), arv: usd(d.arv), rehab: usd(d.rehab),
    beds: num(p.property.beds), baths: num(p.property.baths), sqft: p.property.sqft ? p.property.sqft.toLocaleString('en-US') : '',
    year_built: num(p.property.year), garage: num(d.marketing?.garage),
    headline: d.marketing?.headline ?? '', description: d.marketing?.description ?? '',
    marketing_link: view, comps_link: comps,
    // The deal's page on the app's domain. A campaign overrides it per buyer with their tracked link.
    deal_link: listing,
    photo_url: photo, photos_link: photos,
    property_type: propertyTypeLabel(p.property.type === '—' ? '' : p.property.type),
  };
}
