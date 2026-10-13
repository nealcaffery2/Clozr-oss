// The buyer page /deal writes the listing function's HTML into the app's own
// document, so anything in it runs with the app's origin (and a signed-in
// teammate's session). The listing escapes every value it prints; this is the
// second fence on the app side: links may only be http(s), mailto: or tel:,
// images and form targets only http(s), and nothing may carry an inline event
// handler, a frame, a plugin or a <base> that re-points relative URLs.

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const LOAD_SCHEMES = new Set(['http:', 'https:']);

/** `#photos` style in-page anchors are always fine; everything else must parse to an allowed scheme. */
export function allowedUrl(raw: string, kind: 'link' | 'load', base: string): boolean {
  const v = raw.trim();
  if (v === '') return kind === 'load';
  if (kind === 'link' && v.startsWith('#')) return true;
  let u: URL;
  try { u = new URL(v, base); } catch { return false; }
  return (kind === 'link' ? LINK_SCHEMES : LOAD_SCHEMES).has(u.protocol);
}

// The listing's own page script is inline; nothing it serves loads a script
// from elsewhere. <noscript> and <template> go because DOMParser reads them
// with scripting off and document.write re-reads them with scripting on, so
// markup hidden inside would come back to life; <svg> and <math> because
// their parsing rules differ enough to smuggle the same.
const DROP = 'script[src], noscript, template, svg, math, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]';
const LINK_ATTRS = ['href', 'xlink:href'];
const LOAD_ATTRS = ['src', 'action', 'formaction', 'poster', 'data', 'background'];

/** Clean a parsed listing page in place. `base` is the URL it was fetched from. */
export function sanitizeListing(doc: Document, base: string): void {
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'srcdoc') el.removeAttribute(attr.name);
      else if (LINK_ATTRS.includes(name) && !allowedUrl(attr.value, 'link', base)) el.removeAttribute(attr.name);
      else if (LOAD_ATTRS.includes(name) && !allowedUrl(attr.value, 'load', base)) el.removeAttribute(attr.name);
    }
  });
}
