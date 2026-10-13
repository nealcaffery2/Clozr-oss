// Outside lookups for a property. Zillow, Redfin, Realtor.com and Google Maps
// all refuse to be framed, so the record opens them in popup windows.

export type PropertyLink = { label: string; url: string };

export function propertyLinks(address: string, lat?: number | null, lng?: number | null): PropertyLink[] {
  const q = encodeURIComponent(address);
  const google = (site: string) => `https://www.google.com/search?q=${encodeURIComponent(`site:${site} "${address}"`)}`;
  return [
    {
      label: 'Street View',
      url: lat != null && lng != null
        ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
        : `https://www.google.com/maps/search/?api=1&query=${q}`,
    },
    // Zillow's `_rb` search lands on the home page itself when the address matches.
    { label: 'Zillow', url: `https://www.zillow.com/homes/${address.replace(/[\s,#/]+/g, '-')}_rb/` },
    // Redfin and Realtor.com have no address URL that resolves without their
    // internal listing ids, so a site search puts the property page first.
    { label: 'Redfin', url: google('redfin.com') },
    { label: 'Realtor.com', url: google('realtor.com') },
  ];
}

/**
 * Street View Static photo; 404s (so the grey placeholder shows) where Google
 * has no imagery. Parens and quotes are escaped too: it lands in a CSS url().
 */
export const streetViewImage = (address: string, key: string) =>
  `https://maps.googleapis.com/maps/api/streetview?size=600x300&return_error_code=true&location=${encodeURIComponent(address)}&key=${encodeURIComponent(key)}`
    .replace(/[()']/g, (c) => '%' + c.charCodeAt(0).toString(16));

export const openPopup = (url: string, name: string) =>
  window.open(url, name, 'popup=yes,width=1200,height=850');
