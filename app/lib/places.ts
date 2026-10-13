// Google Places autocomplete, loaded only when a key exists.
//
// The Maps JavaScript API is a script tag, so this loads it once per page and
// hands back the Places library. No key, no script: the address fields stay
// plain inputs and nothing is sent to Google.

type PlacesNS = {
  Autocomplete: new (input: HTMLInputElement, opts: Record<string, unknown>) => {
    addListener: (ev: string, fn: () => void) => void;
    getPlace: () => { address_components?: { long_name: string; short_name: string; types: string[] }[]; formatted_address?: string };
  };
};

declare global {
  interface Window { google?: { maps?: { places?: PlacesNS } }; __clozrPlaces?: Promise<PlacesNS>; }
}

export function loadPlaces(key: string): Promise<PlacesNS> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google?.maps?.places) return Promise.resolve(window.google.maps.places);
  if (window.__clozrPlaces) return window.__clozrPlaces;
  window.__clozrPlaces = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;
    el.async = true;
    el.onload = () => {
      const p = window.google?.maps?.places;
      if (p) resolve(p); else reject(new Error('Places did not load'));
    };
    el.onerror = () => reject(new Error('Could not load Google Maps — check the key and its referrer restrictions'));
    document.head.appendChild(el);
  });
  return window.__clozrPlaces;
}

export type PlaceParts = { addr: string; city: string; st: string; zip: string };

/** The parts the Quick Add form wants, from a Places result. */
export function partsOf(place: { address_components?: { long_name: string; short_name: string; types: string[] }[] }): PlaceParts | null {
  const c = place.address_components ?? [];
  const get = (type: string, short = false) => c.find((x) => x.types.includes(type))?.[short ? 'short_name' : 'long_name'] ?? '';
  const number = get('street_number');
  const route = get('route');
  if (!route) return null;
  return {
    addr: [number, route].filter(Boolean).join(' '),
    city: get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_2'),
    st: get('administrative_area_level_1', true),
    zip: get('postal_code'),
  };
}

/**
 * Attach autocomplete to an input. Returns a detach function. When a place is
 * chosen, `onPlace` gets the parts; the caller fills the sibling fields.
 */
export async function attachAutocomplete(
  key: string, input: HTMLInputElement, onPlace: (p: PlaceParts) => void,
): Promise<() => void> {
  const places = await loadPlaces(key);
  const ac = new places.Autocomplete(input, {
    types: ['address'],
    componentRestrictions: { country: 'us' },
    fields: ['address_components', 'formatted_address'],
  });
  const handler = () => { const p = partsOf(ac.getPlace()); if (p) onPlace(p); };
  ac.addListener('place_changed', handler);
  return () => { /* the Autocomplete has no destroy; dropping the input is enough */ };
}

// ---- through COMPR -----------------------------------------------------------
// No Maps key in CLOZR: the same Google suggestions COMPR's search box uses,
// asked through the compr-underwrite function (COMPR's /api/address-suggest
// on the workspace's COMPR key). The key never reaches the browser.

export type Suggestion = { place_id: string; src: 'new' | 'legacy'; main: string; secondary: string };

export async function comprSuggest(q: string): Promise<Suggestion[]> {
  const { supabase } = await import('./supabase');
  if (!supabase || q.trim().length < 3) return [];
  const { data } = await supabase.functions.invoke('compr-underwrite', { body: { action: 'suggest', q: q.trim() } });
  const items = (data as { items?: Suggestion[] } | null)?.items;
  return Array.isArray(items) ? items.slice(0, 6) : [];
}

export async function comprPlace(s: Suggestion): Promise<PlaceParts | null> {
  const { supabase } = await import('./supabase');
  if (!supabase) return null;
  const { data } = await supabase.functions.invoke('compr-underwrite', { body: { action: 'suggest', place_id: s.place_id, src: s.src } });
  const p = (data as { place?: { addr?: string; city?: string; st?: string; zip?: string } } | null)?.place;
  return p?.addr ? { addr: p.addr, city: p.city ?? '', st: p.st ?? '', zip: p.zip ?? '' } : null;
}

// ---- Places API (New), straight from the browser --------------------------------
// Google no longer offers the legacy Autocomplete widget to new keys, so a key
// with only "Places API (New)" left the widget silently empty. These two calls
// use the new REST endpoints with the same key and feed our own dropdown.

export async function googleSuggest(key: string, q: string): Promise<Suggestion[]> {
  if (q.trim().length < 3) return [];
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ input: q.trim(), includedRegionCodes: ['us'], includedPrimaryTypes: ['street_address', 'premise', 'subpremise'] }),
  });
  if (!res.ok) throw new Error(`places ${res.status}`);
  const j = await res.json() as { suggestions?: { placePrediction?: { placeId: string; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }; text?: { text?: string } } }[] };
  return (j.suggestions ?? []).map((s) => s.placePrediction).filter((p): p is NonNullable<typeof p> => !!p?.placeId).slice(0, 6).map((p) => ({
    place_id: p.placeId, src: 'new' as const,
    main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
    secondary: p.structuredFormat?.secondaryText?.text ?? '',
  }));
}

export async function googlePlace(key: string, placeId: string): Promise<PlaceParts | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'addressComponents' },
  });
  if (!res.ok) throw new Error(`place ${res.status}`);
  const j = await res.json() as { addressComponents?: { longText: string; shortText: string; types: string[] }[] };
  return partsOf({ address_components: (j.addressComponents ?? []).map((c) => ({ long_name: c.longText, short_name: c.shortText, types: c.types })) });
}
