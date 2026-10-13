/**
 * GET/POST /listing — the buyer-facing listing page and everything it records.
 *
 * This is the only part of CLOZR a buyer ever sees, so it is public: no JWT,
 * no cookie, no account. What stands in for a login is a signed link token
 * naming the workspace, deal and buyer, minted when a campaign goes out. A
 * buyer with a token is attributed; a buyer without one still sees the deal,
 * because links get forwarded and a forwarded deal is still a live deal.
 *
 * Routes:
 *   GET  /listing/{slug}            the page, with ?t= to attribute the visit
 *   GET  /listing/r?t=&u=           click redirect, logs a click then forwards
 *   POST /listing/beacon            time on page and photo clicks
 *   POST /listing/offer             an offer, attributed to the token's buyer
 *   GET  /listing/market            redirects to the marketplace in the app
 *   GET  /listing/market.json       marketplace inventory; ?access= unlocks full cards
 *   GET  /listing/market/{slug}     redirects to that deal in the app marketplace
 *   POST /listing/join              opt in to the buyers list, returns marketplace access
 *   POST /listing/access            log back in with the email or phone you joined with
 *   POST /listing/inquiry           inquiry, save or view from a signed-up buyer
 *
 * Nothing is written from here directly. dispo_public_view and
 * dispo_public_offer (migration: public_listing_page_rpcs) hold the writes,
 * and dispo_log_engagement rolls them into deal_buyer_matches, so the deal
 * board warms up on its own.
 *
 * There is deliberately no open-tracking pixel. Campaign email never carries
 * one (deliverability-rules.spamRisk penalises it and says so); the page view
 * is the signal, and it is a better one.
 *
 * Secrets: LISTING_SECRET (falls back to SUPABASE_SERVICE_ROLE_KEY, same as
 * the unsubscribe token), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { hideStreet, isBuyerPhoto, lockCard, mentionsStreet, toMarketCard } from '../_shared/marketplace-public.ts';
import { ALLOW_HEADERS, HARDENING, clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';

type Any = any;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ------------------------------------------------------------ the link token

async function hmac(data: string): Promise<Uint8Array> {
  const secret = Deno.env.get('LISTING_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const key = await crypto.subtle.importKey('raw', enc.encode(`clozr.listing.v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** w: workspace, d: deal, b: buyer. Signed so it cannot be edited into another buyer. */
export type LinkClaim = { w: number; d: number; b: number };

export async function listingToken(c: LinkClaim): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(c)));
  return `${body}.${b64url((await hmac(body)).slice(0, 18))}`;
}

export async function readListingToken(token: string | null): Promise<LinkClaim | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64url((await hmac(body)).slice(0, 18));
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(unb64url(body))) as LinkClaim;
    return Number.isFinite(c.w) && Number.isFinite(c.d) && Number.isFinite(c.b) ? c : null;
  } catch { return null; }
}

/**
 * Marketplace access: minted when someone joins the buyers list (or logs back
 * in with the email or phone they joined with) and kept by their browser. It
 * names the workspace and the buyer, never a deal, and is signed under its own
 * prefix so a campaign link token can never be replayed as one.
 */
export type AccessClaim = { w: number; b: number; e: number };
const ACCESS_DAYS = 180;

export async function accessToken(w: number, b: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ w, b, e: Math.floor(Date.now() / 1000) + ACCESS_DAYS * 86400 })));
  return `${body}.${b64url((await hmac(`market:${body}`)).slice(0, 18))}`;
}

export async function readAccessToken(token: unknown): Promise<AccessClaim | null> {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64url((await hmac(`market:${body}`)).slice(0, 18));
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(unb64url(body))) as AccessClaim;
    if (!Number.isFinite(c.w) || !Number.isFinite(c.b) || !Number.isFinite(c.e)) return null;
    return c.e * 1000 > Date.now() ? c : null;
  } catch { return null; }
}

const phoneKey = (raw: unknown): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
};

const textList = (v: unknown, max = 12): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/))
    .map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, max);

const priceOrNull = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n) : null;
};

// ------------------------------------------------------------ rendering

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** An absolute http(s) URL, the only kind a link or image on this page may carry. */
const webUrl = (u: unknown): u is string => {
  try { return ['http:', 'https:'].includes(new URL(String(u ?? '').trim()).protocol); } catch { return false; }
};

const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? '$' + Math.round(v).toLocaleString('en-US') : null;
};

const num = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US') : null;
};

function page(o: {
  deal: Any; prop: Any; link: Any; photos: Any[]; token: string | null; canOffer: boolean; base: string;
  buyerReport?: string | null; cmaUrl?: string | null; marketplace?: boolean; heroUrl?: string | null;
}): string {
  const { deal, prop, link, photos, token, canOffer, base, marketplace } = o;
  const address = link.show_address
    ? [prop?.line1, [prop?.city, prop?.state].filter(Boolean).join(', '), prop?.zip].filter(Boolean).join(' · ')
    : [prop?.city, prop?.state].filter(Boolean).join(', ') || 'Address on request';
  // Public copy shows the city and state only unless the rep turned the full
  // address on, and the headline defaulted to the street for a long time.
  const place = [prop?.city, prop?.state].filter(Boolean).join(', ');
  const hidden = !link.show_address;
  const headline = hidden && mentionsStreet(link.headline, prop?.line1) ? null : link.headline;
  const title = headline || (link.show_address ? prop?.line1 : null) || (place ? `Investment property in ${place}` : 'Investment property');
  const rawDesc = String(link.description || deal.marketing_description || '');
  const description = hidden ? hideStreet(rawDesc, prop?.line1, place || 'this area') : rawDesc;
  const price = money(deal.asking_price ?? deal.marketed_price ?? deal.offer_amount);
  const arv = deal.arv_low && deal.arv_high
    ? `${money(deal.arv_low)} – ${money(deal.arv_high)}`
    : money(deal.arv);

  const facts: [string, string | null][] = [
    ['Beds', num(prop?.beds)],
    ['Baths', num(prop?.baths)],
    ['Sq ft', num(prop?.sqft)],
    ['Lot sq ft', num(prop?.lot_sqft)],
    ['Year built', prop?.year_built ? String(prop.year_built) : null],
    ['Type', prop?.property_type || null],
    ['County', prop?.county || null],
    ['Condition', prop?.condition || deal.underwrite_condition || null],
    ['ARV', arv],
    ['Est. rehab', money(deal.rehab)],
    ['Occupancy', deal.occupancy_at_close || deal.occupancy_notes || null],
    ['Access', deal.property_access || null],
  ];

  // Only http(s) reaches an href or src: a rep-typed javascript: or data: URL
  // would run in the buyer's page (and /deal writes this page into the app).
  const shots = photos.filter((p) => webUrl(p?.url)).slice(0, 40);
  const hero = shots[0] || (webUrl(o.heroUrl) ? { url: o.heroUrl, caption: title } : null);
  const buyerReport = webUrl(o.buyerReport) ? o.buyerReport : null;
  const cmaUrl = webUrl(o.cmaUrl) ? o.cmaUrl : null;
  const accent = marketplace ? '#07345C' : undefined;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="robots" content="${marketplace ? 'index, follow' : 'noindex, nofollow'}">
<style>
  :root{
    --bg:#f6f4ef; --surface:#fff; --ink:#17140f; --ink-2:#4a443c; --muted:#7c746a;
    --line:#e4ded2; --accent:${accent || '#e3620e'}; --accent-ink:${marketplace ? '#07345C' : '#a8480a'}; --accent-soft:${marketplace ? '#e8eef4' : '#fdeee2'}; --ok:#1d7f48;
    color-scheme:light dark;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#121110; --surface:#1c1a17; --ink:#f2ede6; --ink-2:#cdc6bc; --muted:#968d81;
      --line:#312c26; --accent:#f97316; --accent-ink:#fbb072; --accent-soft:#3a2009; --ok:#4cc282; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:900px;margin:0 auto;padding-inline:16px;padding-block:0 56px}
  header{padding-block:28px 18px}
  .eyebrow{font:600 12px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
  h1{font-size:clamp(24px,5vw,36px);line-height:1.1;margin:0 0 8px;letter-spacing:-.02em;text-wrap:balance}
  .addr{color:var(--muted);margin:0;font-size:15px}
  .pricerow{display:flex;flex-wrap:wrap;gap:10px 28px;align-items:baseline;margin-top:18px}
  .price{font-size:clamp(26px,6vw,40px);font-weight:800;letter-spacing:-.02em;color:var(--accent-ink)}
  .pricelab{font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px}
  .sub{font-size:18px;font-weight:600}
  figure{margin:0}
  .hero{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:12px;background:var(--line);display:block}
  .strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:8px}
  .strip img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:var(--line);cursor:zoom-in;display:block}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:22px}
  h2{font-size:17px;margin:0 0 14px;letter-spacing:-.01em}
  dl.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px 20px;margin:0}
  dl.facts dt{font:600 11px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
  dl.facts dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
  .desc{white-space:pre-wrap;color:var(--ink-2);margin:0}
  label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
  input,textarea{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;
    background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
  input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:520px){.grid2{grid-template-columns:1fr}}
  .field{margin-bottom:14px}
  button{background:var(--accent);color:#fff;border:0;border-radius:9px;padding:13px 22px;
    font:inherit;font-weight:650;font-size:16px;cursor:pointer;width:100%}
  button:hover{background:var(--accent-ink)}
  button[disabled]{opacity:.55;cursor:progress}
  .msg{margin-top:12px;font-weight:600}
  .msg.ok{color:var(--ok)} .msg.err{color:#b8322a}
  .note{color:var(--muted);font-size:13.5px;margin:10px 0 0}
  footer{margin-top:34px;color:var(--muted);font-size:12.5px;text-align:center}
  dialog{border:0;padding:0;background:transparent;max-width:96vw;max-height:96vh}
  dialog::backdrop{background:rgba(0,0,0,.85)}
  dialog img{max-width:96vw;max-height:96vh;border-radius:8px;display:block}
</style>
</head><body>
<div class="wrap">
  <header>
    ${marketplace ? `<p class="eyebrow" style="margin-bottom:14px"><a href="${esc(base)}/market" style="color:inherit;text-decoration:none">Acme Homes marketplace</a></p>
    <a href="https://yourcompany.com" style="display:inline-block;margin-bottom:18px"><img src="https://www.yourcompany.com/assets/images/logo.png" alt="Acme Homes" width="180" style="display:block;height:auto"></a>` : '<p class="eyebrow">Off-market opportunity</p>'}
    <h1>${esc(title)}</h1>
    <p class="addr">${esc(address)}</p>
    <div class="pricerow">
      ${price ? `<div><span class="pricelab">Asking</span><span class="price">${esc(price)}</span></div>` : ''}
      ${arv ? `<div><span class="pricelab">ARV</span><span class="sub">${esc(arv)}</span></div>` : ''}
      ${money(deal.rehab) ? `<div><span class="pricelab">Est. rehab</span><span class="sub">${esc(money(deal.rehab))}</span></div>` : ''}
    </div>
  </header>

  ${hero ? `<figure id="photos"><img class="hero" src="${esc(hero.url)}" alt="${esc(hero.caption || title)}" data-i="0"></figure>` : ''}
  ${shots.length > 1 ? `<div class="strip">${shots.slice(1).map((p, i) =>
    `<img src="${esc(p.url)}" alt="${esc(p.caption || 'Property photo')}" loading="lazy" data-i="${i + 1}">`).join('')}</div>` : ''}

  ${(buyerReport || cmaUrl) ? `<p class="note" style="margin-top:14px">${buyerReport ? `<a href="${esc(buyerReport)}" target="_blank" rel="noopener">View full deal (COMPR buyer report)</a>` : ''}${buyerReport && cmaUrl ? ' · ' : ''}${cmaUrl ? `<a href="${esc(cmaUrl)}" target="_blank" rel="noopener">Comps &amp; underwriting (PDF)</a>` : ''}${shots.length ? ' · <a href="#photos">Photos</a>' : ''}</p>` : ''}

  <section class="card">
    <h2>Property details</h2>
    <dl class="facts">
      ${facts.filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>
  </section>

  ${description ? `<section class="card">
    <h2>About this deal</h2>
    <p class="desc">${esc(description)}</p>
  </section>` : ''}

  ${canOffer ? `<section class="card">
    <h2>Make an offer</h2>
    <form id="offer">
      <div class="field">
        <label for="amount">Your offer</label>
        <input id="amount" name="amount" type="text" inputmode="numeric" placeholder="$0" required>
      </div>
      <div class="grid2">
        <div class="field">
          <label for="financing">Financing</label>
          <input id="financing" name="financing" type="text" placeholder="Cash, hard money, private">
        </div>
        <div class="field">
          <label for="close_days">Days to close</label>
          <input id="close_days" name="close_days" type="text" inputmode="numeric" placeholder="14">
        </div>
      </div>
      <div class="field">
        <label for="notes">Anything we should know</label>
        <textarea id="notes" name="notes" rows="3" placeholder="Contingencies, questions, walkthrough request"></textarea>
      </div>
      <button type="submit">Submit offer</button>
      <p class="msg" id="msg" hidden></p>
      <p class="note">Submitting sends this straight to the disposition rep on this deal. It is not a binding contract.</p>
    </form>
  </section>` : `<section class="card">
    <h2>Interested?</h2>
    <p class="note" style="margin-top:0">${marketplace ? 'Join the buyers list below and we will send matching deals first.' : 'Reply to the text or email you received and the rep on this deal will get straight back to you.'}</p>
  </section>`}

  <section class="card" id="join">
    <h2>Join the Acme Homes buyers list</h2>
    <p class="note" style="margin:0 0 14px">Off-market deals, COMPR numbers, and photos — sent to investors who actually buy. Free. Unsubscribe any time.</p>
    <form id="optin">
      <input type="text" name="company_website" autocomplete="off" tabindex="-1" style="position:absolute;left:-9999px" aria-hidden="true">
      <div class="grid2">
        <div class="field"><label for="jn">Name</label><input id="jn" name="name" required autocomplete="name"></div>
        <div class="field"><label for="je">Email</label><input id="je" name="email" type="email" required autocomplete="email"></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="jp">Mobile phone <span style="font-weight:400;color:#64748b">(optional)</span></label><input id="jp" name="phone" type="tel" autocomplete="tel" placeholder="(210) 555-0100"></div>
        <div class="field"><label for="jm">Markets</label><input id="jm" name="markets" placeholder="San Antonio, Austin"></div>
      </div>
      <div class="field"><label for="js">Strategy</label><input id="js" name="strategy" placeholder="Flip, rental, both"></div>
      <div class="field" style="display:flex;gap:8px;align-items:flex-start">
        <input id="jsms" name="sms_ok" type="checkbox" style="width:auto;margin-top:4px">
        <label for="jsms" style="font-weight:500">Optional. By checking this box, I agree to receive text messages from Acme Homes about matching deals at the mobile number above. Consent is not a condition of joining. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. <a href="https://www.yourcompany.com/privacy-policy" target="_blank" rel="noreferrer">Privacy</a> · <a href="https://www.yourcompany.com/terms-of-service" target="_blank" rel="noreferrer">Terms</a></label>
      </div>
      <button type="submit">Join the list</button>
      <p class="msg" id="jmsg" hidden></p>
    </form>
  </section>

  <footer>${marketplace ? 'Acme Homes · Acme Holdings LLC · <a href="https://yourcompany.com">yourcompany.com</a>' : 'Shared privately. Please do not repost this link.'}</footer>
</div>

<dialog id="lb"><img id="lbimg" src="" alt=""></dialog>

<script>
(function(){
  var BASE = ${JSON.stringify(base)};
  var SLUG = ${JSON.stringify(link.slug)};
  var T = ${JSON.stringify(token)};
  var WS = ${JSON.stringify(deal.workspace_id ?? link.workspace_id ?? null)};
  var DEAL = ${JSON.stringify(deal.id ?? link.deal_id ?? null)};
  var KEY = 's:' + SLUG;

  // One session key per browser per listing, so a buyer who comes back twice in
  // a day is one session, not two views.
  var session = '';
  try { session = sessionStorage.getItem(KEY) || ''; } catch (e) {}
  if (!session) {
    session = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, '');
    try { sessionStorage.setItem(KEY, session); } catch (e) {}
  }

  var seconds = 0, photoClicks = 0, pending = 0, sentFirst = false;

  function send(useBeacon) {
    if (!sentFirst) { sentFirst = true; } else if (!pending && !photoClicks) { return; }
    var body = JSON.stringify({
      slug: SLUG, t: T, session: session,
      seconds: pending, photo_clicks: photoClicks,
      referrer: document.referrer || null
    });
    pending = 0; photoClicks = 0;
    var url = BASE + '/beacon';
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
    }
  }

  send(false);
  setInterval(function(){ if (!document.hidden) { seconds += 15; pending += 15; } if (pending >= 15) send(false); }, 15000);
  document.addEventListener('visibilitychange', function(){ if (document.hidden) send(true); });
  addEventListener('pagehide', function(){ send(true); });

  // Lightbox. Opening a photo is the clearest "this one is interesting" signal
  // the page has, so it is the thing we count.
  var lb = document.getElementById('lb'), lbimg = document.getElementById('lbimg');
  document.addEventListener('click', function(e){
    var img = e.target.closest('img[data-i]');
    if (!img || !lb) return;
    photoClicks++;
    lbimg.src = img.src; lbimg.alt = img.alt;
    if (lb.showModal) lb.showModal();
  });
  if (lb) lb.addEventListener('click', function(){ if (lb.close) lb.close(); });

  var form = document.getElementById('offer');
  if (form) form.addEventListener('submit', function(e){
    e.preventDefault();
    var btn = form.querySelector('button'), msg = document.getElementById('msg');
    var amount = Number(String(form.amount.value).replace(/[^0-9.]/g, ''));
    msg.hidden = false; msg.className = 'msg';
    if (!amount || amount <= 0) { msg.className = 'msg err'; msg.textContent = 'Enter an offer amount.'; return; }
    btn.disabled = true; msg.textContent = 'Sending...';
    fetch(BASE + '/offer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG, t: T, amount: amount,
        financing: form.financing.value || null,
        close_days: form.close_days.value || null,
        notes: form.notes.value || null
      })
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) { throw new Error(res.j && res.j.error ? res.j.error : 'That did not go through.'); }
        msg.className = 'msg ok';
        msg.textContent = 'Offer sent. The rep on this deal has it and will be in touch.';
        form.querySelector('button').textContent = 'Offer sent';
      })
      .catch(function(err){ btn.disabled = false; msg.className = 'msg err'; msg.textContent = String(err.message || err); });
  });

  var join = document.getElementById('optin');
  if (join) join.addEventListener('submit', function(e){
    e.preventDefault();
    var btn = join.querySelector('button'), msg = document.getElementById('jmsg');
    msg.hidden = false; msg.className = 'msg';
    btn.disabled = true; msg.textContent = 'Saving...';
    var fd = new FormData(join);
    if (fd.get('sms_ok') === 'on' && !String(fd.get('phone') || '').trim()) {
      btn.disabled = false; msg.className = 'msg err';
      msg.textContent = 'Add a mobile number to get deals by text, or untick the box.';
      return;
    }
    fetch(BASE + '/join', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: WS, deal_id: DEAL, slug: SLUG,
        name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'),
        markets: fd.get('markets'), strategy: fd.get('strategy'),
        sms_ok: fd.get('sms_ok') === 'on', company_website: fd.get('company_website')
      })
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) { throw new Error(res.j && res.j.error ? res.j.error : 'That did not go through.'); }
        msg.className = 'msg ok';
        msg.textContent = res.j && res.j.created ? 'You are on the list. Matching deals will come to you first.' : 'You are already on the list. We updated your info.';
        btn.textContent = 'Joined';
      })
      .catch(function(err){ btn.disabled = false; msg.className = 'msg err'; msg.textContent = String(err.message || err); });
  });
})();
</script>
</body></html>`;
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...HARDENING, 'Content-Type': 'text/html; charset=utf-8' } });

const notFound = () =>
  html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not available</title>
<div style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 20px;text-align:center;color:#3f3a33">
<h1 style="font-size:22px;margin:0 0 8px">This listing is not available</h1>
<p style="color:#7c746a;margin:0">The link may have expired, or the deal may already be spoken for. Reply to the message you received and the rep will help.</p>
</div>`, 404);

const MARKET_STAGES = new Set(['Ready To Market', 'Under Contract Seller', 'Buyer Under Contract']);

/**
 * The workspace whose deals the public marketplace shows: MARKETPLACE_WORKSPACE_ID
 * when set, else the first workspace. Marketplace is not a login, so this is
 * how we know whose deals to show.
 */
async function marketplaceWorkspaceId(admin: Any): Promise<number | null> {
  const configured = Number(Deno.env.get('MARKETPLACE_WORKSPACE_ID') ?? '');
  if (Number.isInteger(configured) && configured > 0) return configured;
  const { data } = await admin.from('workspaces').select('id').order('id').limit(1);
  const rows = (data ?? []) as { id: number }[];
  return rows[0]?.id ?? null;
}


// ------------------------------------------------------------ the handler

Deno.serve(async (req) => {
  // ALLOW_HEADERS, not just content-type: /links is called through
  // supabase.functions.invoke, which always attaches apikey and x-client-info,
  // and a preflight that refuses them surfaces to the rep as nothing more than
  // "failed to send a request to the edge function".
  const cors = corsFor(req, { methods: 'GET, POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  // The gateway hands us /listing/... and a direct call gives /functions/v1/listing/...
  // Take everything after the last 'listing' segment either way.
  const segs = url.pathname.split('/').filter(Boolean);
  const at = segs.lastIndexOf('listing');
  const path = (at >= 0 ? segs.slice(at + 1) : segs).join('/');
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/listing`;

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const ip = clientIp(req);

  try {
    // -------------------------------------------------- click redirect
    if (path === 'r' && req.method === 'GET') {
      const target = url.searchParams.get('u') ?? '';
      // Only ever forward to somewhere we would have put in a message ourselves.
      let dest: URL | null = null;
      try { dest = new URL(target); } catch { dest = null; }
      if (!dest || (dest.protocol !== 'https:' && dest.protocol !== 'http:')) return json({ error: 'bad link' }, 400);

      const claim = await readListingToken(url.searchParams.get('t'));
      if (claim) {
        await admin.rpc('dispo_log_engagement', {
          p_deal_id: claim.d, p_buyer_id: claim.b, p_kind: 'click', p_channel: 'web',
          p_campaign_id: null, p_message_id: null, p_meta: { url: dest.toString().slice(0, 500) },
        });
      }
      return new Response(null, { status: 302, headers: { ...HARDENING, Location: dest.toString() } });
    }

    // -------------------------------------------------- beacon
    if (path === 'beacon' && req.method === 'POST') {
      const limit = await rateLimit(admin, `listing:beacon:${ip}`, 240, 3600);
      if (!limit.allowed) return tooMany(cors, limit);

      const b = await req.json().catch(() => ({})) as Any;
      const link = await linkBySlug(admin, String(b.slug ?? ''));
      if (!link) return json({ ok: true });

      const claim = await readListingToken(b.t ?? null);
      const buyerId = claim && claim.d === link.deal_id ? claim.b : null;

      await admin.rpc('dispo_public_view', {
        p_link_id: link.id,
        p_buyer_id: buyerId,
        p_session_key: String(b.session ?? '').slice(0, 64),
        p_seconds: Number(b.seconds) || 0,
        p_photo_clicks: Number(b.photo_clicks) || 0,
        p_referrer: typeof b.referrer === 'string' ? b.referrer.slice(0, 500) : null,
        p_user_agent: (req.headers.get('user-agent') ?? '').slice(0, 500),
      });
      return json({ ok: true });
    }

    // -------------------------------------------------- offer
    if (path === 'offer' && req.method === 'POST') {
      const limit = await rateLimit(admin, `listing:offer:${ip}`, 12, 3600);
      if (!limit.allowed) return tooMany(cors, limit);

      const b = await req.json().catch(() => ({})) as Any;
      const market = b.access ? await readAccessToken(b.access) : null;
      const link = b.slug
        ? await linkBySlug(admin, String(b.slug))
        : (market && Number.isFinite(Number(b.deal_id)) ? await marketLinkForDeal(admin, Number(b.deal_id)) : null);
      if (!link) return json({ error: 'This listing is no longer available.' }, 404);
      if (!link.allow_offers) return json({ error: 'This listing is not taking offers.' }, 400);

      const linkClaim = await readListingToken(b.t ?? null);
      const buyerId = linkClaim && linkClaim.d === link.deal_id
        ? linkClaim.b
        : market && market.w === Number(link.workspace_id) ? market.b : null;
      if (!buyerId) {
        // Offers are attributed or not taken: an unattributed offer is a form
        // for strangers to fill, and the rep cannot act on one anyway.
        return json({ error: 'Join the buyers list or use the link from your text or email to send an offer.', join: true }, 403);
      }
      const claim = { b: buyerId };

      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Enter an offer amount.' }, 400);

      const terms: Record<string, unknown> = {};
      if (b.financing) terms.financing = String(b.financing).slice(0, 120);
      if (b.close_days) terms.close_days = String(b.close_days).slice(0, 20);
      if (b.emd) terms.emd = String(b.emd).slice(0, 40);
      if (market) terms.via = 'marketplace';

      const { data, error } = await admin.rpc('dispo_public_offer', {
        p_link_id: link.id,
        p_buyer_id: claim.b,
        p_amount: amount,
        p_terms: terms,
        p_notes: b.notes ? String(b.notes).slice(0, 2000) : null,
      });
      if (error) throw error;
      if (!data) return json({ error: 'This listing is not taking offers.' }, 400);
      return json({ ok: true, offer_id: data });
    }

    // -------------------------------------------------- per-buyer links
    // The bridge to the campaign engine. A composer asks for one deal's links,
    // gets a signed URL per buyer, and merges them into the message bodies it
    // hands dispo_campaign_launch. Minting them here is what makes the clicks,
    // views and offers on those links attributable to a buyer at all.
    //
    // Authenticated, unlike the rest of this function: the caller's own JWT is
    // used for the client, so deal_public_link_ensure sees auth.uid() and its
    // has_role check does the authorising.
    if (path === 'links' && req.method === 'POST') {
      const auth = req.headers.get('authorization') ?? '';
      if (!/^Bearer\s+\S+/i.test(auth)) return json({ error: 'sign in first' }, 401);

      const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: auth } },
      });
      const { data: who } = await asUser.auth.getUser();
      if (!who?.user) return json({ error: 'sign in first' }, 401);

      const b = await req.json().catch(() => ({})) as Any;
      const dealId = Number(b.deal_id);
      if (!Number.isFinite(dealId)) return json({ error: 'deal_id is required' }, 400);

      // has_role lives inside this RPC, so an unauthorised caller stops here.
      const { data: link, error: linkErr } = await asUser.rpc('deal_public_link_ensure', {
        p_deal_id: dealId,
        p_headline: b.headline ?? null,
        p_description: b.description ?? null,
      });
      if (linkErr) return json({ error: linkErr.message }, 403);
      if (!link) return json({ error: 'could not publish that deal' }, 400);

      let buyerIds: number[] = Array.isArray(b.buyer_ids) ? b.buyer_ids.map(Number).filter(Number.isFinite) : [];
      if (!buyerIds.length) {
        const { data: matches } = await admin.from('deal_buyer_matches')
          .select('buyer_id').eq('deal_id', dealId).limit(2000);
        buyerIds = (matches ?? []).map((m: Any) => Number(m.buyer_id));
      }
      buyerIds = Array.from(new Set(buyerIds)).slice(0, 2000);

      const links: Record<string, string> = {};
      for (const id of buyerIds) {
        const t = await listingToken({ w: Number(link.workspace_id), d: dealId, b: id });
        links[String(id)] = `${base}/${link.slug}?t=${encodeURIComponent(t)}`;
      }

      return json({ ok: true, slug: link.slug, url: `${base}/${link.slug}`, links });
    }

    // -------------------------------------------------- buyers-list opt-in
    if (path === 'join' && req.method === 'POST') {
      const limit = await rateLimit(admin, `listing:join:${ip}`, 8, 3600);
      if (!limit.allowed) return tooMany(cors, limit);
      const b = await req.json().catch(() => ({})) as Any;
      if (typeof b.company_website === 'string' && b.company_website.trim()) return json({ ok: true, created: false });
      // Workspace comes from the deal (or Acme Homes), never from the posted id —
      // otherwise anyone could insert buyers into another tenant.
      const postedDeal = Number(b.deal_id);
      let workspaceId: number | null = null;
      let dealId: number | null = null;
      if (Number.isFinite(postedDeal)) {
        // A deal id alone is guessable: the page's own live slug for that deal
        // is the credential that names the workspace.
        const d = await linkBySlug(admin, String(b.slug ?? ''));
        if (!d || Number(d.deal_id) !== postedDeal) return json({ error: 'This listing is no longer available.' }, 404);
        workspaceId = Number(d.workspace_id);
        dealId = Number(d.deal_id);
      } else {
        workspaceId = await marketplaceWorkspaceId(admin);
      }
      if (!Number.isFinite(workspaceId)) return json({ error: 'marketplace is not available' }, 400);
      const email = String(b.email ?? '').trim();
      const phone = String(b.phone ?? '').trim();
      const name = String(b.name ?? '').trim();
      if (!name) return json({ error: 'Name is required.' }, 400);
      if (!email && !phone) return json({ error: 'Email or phone is required.' }, 400);
      const markets = String(b.markets ?? '').split(/[,;]/).map((s: string) => s.trim()).filter(Boolean).slice(0, 12);
      const { data, error } = await admin.rpc('buyers_list_opt_in', {
        p_workspace_id: workspaceId,
        p_name: name.slice(0, 120),
        p_email: email ? email.slice(0, 200) : null,
        p_phone: phone ? phone.slice(0, 40) : null,
        p_markets: markets,
        p_strategy: b.strategy ? String(b.strategy).slice(0, 40) : null,
        // Consent to text needs a number to text; the phone itself is optional.
        p_sms_ok: !!b.sms_ok && !!phone,
        p_deal_id: dealId,
      });
      if (error) throw error;
      const row = data as { buyer_id?: number; created?: boolean } | null;
      const buyerId = Number(row?.buyer_id);
      if (!Number.isFinite(buyerId)) return json({ ok: true, created: !!row?.created, buyer_id: null });

      // The buy box from step two. Only what was answered is written, so a
      // returning buyer re-joining with a shorter form keeps what they had.
      const box: Record<string, unknown> = {};
      const types = textList(b.property_types, 8);
      const strategies = textList(b.strategy_types, 8);
      const financing = textList(b.financing_types, 6);
      if (types.length) box.property_types = types;
      if (strategies.length) box.strategy_types = strategies;
      if (financing.length) box.financing_types = financing;
      const lo = priceOrNull(b.min_price);
      const hi = priceOrNull(b.max_price);
      if (lo) box.min_purchase_price = lo;
      if (hi) box.max_purchase_price = hi;
      const beds = Number(b.beds_min);
      if (Number.isFinite(beds) && beds > 0 && beds < 20) box.beds_min = Math.round(beds);
      if (b.company) box.company = String(b.company).slice(0, 120);
      if (b.buy_box) box.buy_box = String(b.buy_box).slice(0, 1000);
      if (Object.keys(box).length) {
        await admin.from('buyers').update(box).eq('id', buyerId).eq('workspace_id', workspaceId);
      }
      return json({
        ok: true,
        created: !!row?.created,
        buyer_id: buyerId,
        access: await accessToken(Number(workspaceId), buyerId),
        name: name.split(/\s+/)[0],
      });
    }

    // -------------------------------------------------- marketplace log-in
    // A buyer who already joined gets their access back with the email or
    // phone they joined with. The gate is lead capture, not an account: the
    // feed it unlocks is what a rep would text that buyer anyway.
    if (path === 'access' && req.method === 'POST') {
      const limit = await rateLimit(admin, `listing:access:${ip}`, 20, 3600);
      if (!limit.allowed) return tooMany(cors, limit);
      const b = await req.json().catch(() => ({})) as Any;
      const workspaceId = await marketplaceWorkspaceId(admin);
      if (!workspaceId) return json({ error: 'marketplace is not available' }, 400);
      const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
      const key = phoneKey(b.phone);
      if (!email && !key) return json({ error: 'Enter the email or phone you joined with.' }, 400);
      let q = admin.from('buyers').select('id, name').eq('workspace_id', workspaceId).is('blacklisted_at', null).limit(1);
      q = email ? q.ilike('email', email) : q.eq('phone_key', key);
      const { data: found } = await q;
      const buyer = (found ?? [])[0];
      if (!buyer) return json({ error: 'We could not find you on the list yet. Join the buyers list to unlock deals.', join: true }, 404);
      return json({
        ok: true,
        buyer_id: buyer.id,
        access: await accessToken(Number(workspaceId), Number(buyer.id)),
        name: String(buyer.name ?? '').split(/\s+/)[0] || null,
      });
    }

    // -------------------------------------------------- marketplace actions
    // Inquiry, save and view from a buyer with marketplace access. Each lands
    // on the deal's and the buyer's timelines so dispositions sees it.
    if (path === 'inquiry' && req.method === 'POST') {
      const limit = await rateLimit(admin, `listing:inquiry:${ip}`, 60, 3600);
      if (!limit.allowed) return tooMany(cors, limit);
      const b = await req.json().catch(() => ({})) as Any;
      const claim = await readAccessToken(b.access);
      if (!claim) return json({ error: 'Join the buyers list first.', join: true }, 401);
      const dealId = Number(b.deal_id);
      const link = Number.isFinite(dealId) ? await marketLinkForDeal(admin, dealId) : null;
      if (!link || Number(link.workspace_id) !== claim.w) return json({ error: 'This listing is no longer available.' }, 404);
      const kind = ['inquiry', 'save', 'unsave', 'view'].includes(String(b.kind)) ? String(b.kind) : 'inquiry';
      const { data: buyer } = await admin.from('buyers').select('id, name').eq('id', claim.b).eq('workspace_id', claim.w).maybeSingle();
      if (!buyer) return json({ error: 'Join the buyers list first.', join: true }, 401);
      const who = String(buyer.name || 'A buyer');
      if (kind === 'view') {
        await admin.rpc('dispo_public_view', {
          p_link_id: link.id, p_buyer_id: claim.b,
          p_session_key: String(b.session ?? '').slice(0, 64),
          p_seconds: Number(b.seconds) || 0, p_photo_clicks: Number(b.photo_clicks) || 0,
          p_referrer: 'marketplace', p_user_agent: (req.headers.get('user-agent') ?? '').slice(0, 500),
        });
        return json({ ok: true });
      }
      const message = String(b.message ?? '').trim().slice(0, 2000);
      if (kind === 'inquiry' && !message) return json({ error: 'Write a short message.' }, 400);
      const title = kind === 'inquiry' ? `Marketplace inquiry from ${who}` : kind === 'save' ? `${who} saved this deal` : `${who} unsaved this deal`;
      await admin.from('activity').insert([
        { workspace_id: claim.w, entity_type: 'deal', entity_id: link.deal_id, kind: kind === 'inquiry' ? 'inquiry' : 'engagement', title, body: message || 'From the Acme Homes marketplace' },
        { workspace_id: claim.w, entity_type: 'buyer', entity_id: claim.b, kind: kind === 'inquiry' ? 'inquiry' : 'engagement', title: kind === 'inquiry' ? `Asked about deal ${link.deal_id}` : `${kind === 'save' ? 'Saved' : 'Unsaved'} deal ${link.deal_id}`, body: message || 'From the Acme Homes marketplace' },
      ]);
      await admin.rpc('dispo_log_engagement', {
        p_deal_id: link.deal_id, p_buyer_id: claim.b, p_kind: kind === 'inquiry' ? 'reply' : 'click', p_channel: 'web',
        p_campaign_id: null, p_message_id: null, p_meta: { source: 'marketplace', action: kind },
      });
      await admin.from('buyers').update({ last_activity_at: new Date().toISOString() }).eq('id', claim.b);
      return json({ ok: true });
    }

    // -------------------------------------------------- marketplace
    if ((path === 'market' || path === 'market.json') && req.method === 'GET') {
      // Every lookup that does not need the one before it runs beside it: the
      // feed used to make six round trips in a row (rate limit, workspace,
      // links, deals, properties, photos), which is most of the wait before
      // the first card paints.
      const [limit, workspaceId, claim] = await Promise.all([
        rateLimit(admin, `listing:market:${ip}`, 60, 3600),
        marketplaceWorkspaceId(admin),
        path === 'market.json' ? readAccessToken(url.searchParams.get('access')) : Promise.resolve(null),
      ]);
      if (!limit.allowed) return tooMany(cors, limit);
      if (!workspaceId) return path === 'market.json' ? json({ ok: true, member: false, deals: [] }) : Response.redirect(`${appUrl()}/marketplace`, 302);
      const { data: links } = await admin.from('deal_public_links')
        .select('id, workspace_id, deal_id, slug, headline, description, show_address, allow_offers, view_count, created_at')
        .eq('workspace_id', workspaceId).eq('active', true).eq('on_marketplace', true).order('updated_at', { ascending: false }).limit(80);
      const ids = (links ?? []).map((l: Any) => l.deal_id);
      // Photos are fetched for every linked deal alongside the deals themselves;
      // the few on a deal that left the market are dropped below. Capped: a
      // COMPR set can hold 100 photos a deal and a card shows at most 24.
      const [{ data: deals }, { data: photos }] = ids.length
        ? await Promise.all([
          admin.from('deals').select('id, workspace_id, property_id, stage, asking_price, marketed_price, offer_amount, arv, rehab, hero_image_url, buyer_report_url, compr_cma_url, marketing_headline, marketing_description, underwrite_condition, occupancy_at_close, occupancy_notes, updated_at')
            .in('id', ids),
          admin.from('deal_files').select('deal_id, url')
            .in('deal_id', ids).eq('kind', 'photo').eq('visible_to_buyers', true).not('url', 'is', null)
            .order('is_cover', { ascending: false }).order('position', { ascending: true }).limit(4000),
        ])
        : [{ data: [] }, { data: [] }];
      const live = new Map((deals ?? []).filter((d: Any) => MARKET_STAGES.has(d.stage)).map((d: Any) => [d.id, d]));
      const shown = (links ?? []).filter((l: Any) => live.has(l.deal_id));
      const propIds = [...new Set(shown.map((l: Any) => live.get(l.deal_id)?.property_id).filter(Boolean))];
      const { data: props } = propIds.length
        ? await admin.from('properties').select('id, line1, city, state, zip, county, beds, baths, sqft, lot_sqft, year_built, property_type, condition, lat, lng').in('id', propIds)
        : { data: [] };
      const propBy = new Map((props ?? []).map((p: Any) => [p.id, p]));
      const photoBy = new Map<number, string[]>();
      for (const p of photos ?? []) {
        if (!isBuyerPhoto(p.url)) continue;
        const list = photoBy.get(p.deal_id) ?? [];
        if (list.length < 24 && !list.includes(p.url)) list.push(p.url);
        photoBy.set(p.deal_id, list);
      }
      const cards = shown.map((l: Any) => {
        const d = live.get(l.deal_id);
        const p = d?.property_id ? propBy.get(d.property_id) : null;
        return toMarketCard({
          slug: l.slug,
          url: `${base}/market/${l.slug}`,
          showAddress: l.show_address !== false,
          headline: l.headline || d?.marketing_headline || null,
          workspaceId: l.workspace_id,
          dealId: l.deal_id,
          stage: d?.stage ?? '',
          asking: d?.asking_price,
          marketed: d?.marketed_price,
          offer: d?.offer_amount,
          arv: d?.arv,
          rehab: d?.rehab,
          occupancy: d?.occupancy_at_close || d?.occupancy_notes || null,
          heroUrl: d?.hero_image_url || null,
          buyerReportUrl: d?.buyer_report_url || null,
          cmaUrl: d?.compr_cma_url || null,
          updatedAt: d?.updated_at || null,
          line1: p?.line1 || null,
          city: p?.city || null,
          state: p?.state || null,
          zip: p?.zip || null,
          beds: p?.beds,
          baths: p?.baths,
          sqft: p?.sqft,
          lat: p?.lat,
          lng: p?.lng,
          photos: photoBy.get(l.deal_id) ?? [],
          county: p?.county || null,
          yearBuilt: p?.year_built,
          lotSqft: p?.lot_sqft,
          propertyType: p?.property_type || null,
          condition: p?.condition || d?.underwrite_condition || null,
          description: l.description || d?.marketing_description || null,
          listedAt: l.created_at || null,
          views: l.view_count,
          allowOffers: l.allow_offers !== false,
        });
      });
      if (path === 'market.json') {
        // Signed-up buyers get the whole card; everyone else gets the teaser.
        const member = !!claim && claim.w === Number(workspaceId);
        return json({ ok: true, member, deals: member ? cards : cards.map(lockCard), join: `${base}/join` });
      }
      // The marketplace lives in the app now, behind the buyers-list sign-up.
      return Response.redirect(`${appUrl()}/marketplace`, 302);
    }

    if (req.method === 'GET' && path.startsWith('market/')) {
      const slug = path.slice('market/'.length);
      const link = await linkBySlug(admin, slug);
      const ws = await marketplaceWorkspaceId(admin);
      if (!link || link.on_marketplace === false || (ws != null && link.workspace_id !== ws)) return notFound();
      return Response.redirect(`${appUrl()}/marketplace?deal=${encodeURIComponent(String(link.deal_id))}`, 302);
    }

    // -------------------------------------------------- the page
    if (req.method === 'GET' && path && !path.includes('/')) {
      const limit = await rateLimit(admin, `listing:page:${ip}`, 120, 3600);
      if (!limit.allowed) return tooMany(cors, limit);

      const link = await linkBySlug(admin, path);
      if (!link) return notFound();
      const claim = await readListingToken(url.searchParams.get('t'));
      const token = claim && claim.d === link.deal_id ? url.searchParams.get('t') : null;
      // CORS on the page too: the app's /deal route fetches this HTML from the
      // buyer's browser so the link a buyer gets is on the app's domain.
      const page = await renderDealPage(admin, link, token, base, false);
      for (const [k, v] of Object.entries(cors)) page.headers.set(k, v);
      return page;
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    if (req.method === 'GET' && path && !path.includes('/')) {
      console.error('listing page', err);
      return notFound();
    }
    return serverError(cors, 'listing', err);
  }
});

const appUrl = () => String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');

/** The marketplace link for a deal, when that deal is on the market right now. */
async function marketLinkForDeal(admin: Any, dealId: number) {
  const { data } = await admin.from('deal_public_links')
    .select('id, workspace_id, deal_id, slug, active, allow_offers, on_marketplace, expires_at')
    .eq('deal_id', dealId).eq('active', true).eq('on_marketplace', true).order('id').limit(1);
  const link = (data ?? [])[0];
  if (!link || (link.expires_at && new Date(link.expires_at).getTime() < Date.now())) return null;
  const { data: deal } = await admin.from('deals').select('stage').eq('id', dealId).maybeSingle();
  return deal && MARKET_STAGES.has(deal.stage) ? link : null;
}

/** The active, unexpired link for a slug. */
async function linkBySlug(admin: Any, slug: string) {
  if (!slug || slug.length > 64 || !/^[a-z0-9_-]+$/i.test(slug)) return null;
  const { data } = await admin.from('deal_public_links')
    .select('id, workspace_id, deal_id, slug, active, show_address, allow_offers, headline, description, expires_at, on_marketplace')
    .eq('slug', slug).eq('active', true).maybeSingle();
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}

async function renderDealPage(admin: Any, link: Any, token: string | null, base: string, marketplace: boolean) {
  const { data: deal } = await admin.from('deals')
    .select('id, workspace_id, property_id, stage, asking_price, marketed_price, offer_amount, arv, arv_low, arv_high, rehab, marketing_headline, marketing_description, occupancy_at_close, occupancy_notes, property_access, underwrite_condition, hero_image_url, buyer_report_url, compr_cma_url')
    .eq('id', link.deal_id).maybeSingle();
  if (!deal) return notFound();

  const { data: prop } = deal.property_id
    ? await admin.from('properties')
      .select('line1, city, state, zip, county, beds, baths, sqft, lot_sqft, year_built, property_type, condition')
      .eq('id', deal.property_id).maybeSingle()
    : { data: null };

  const { data: photos } = await admin.from('deal_files')
    .select('url, caption, is_cover, position')
    .eq('deal_id', link.deal_id).eq('kind', 'photo').eq('visible_to_buyers', true)
    .order('is_cover', { ascending: false }).order('position', { ascending: true }).limit(40);

  return html(page({
    deal, prop, link,
    photos: (photos ?? []).filter((p: Any) => typeof p.url === 'string' && /^https:\/\//.test(p.url)),
    token,
    canOffer: !!link.allow_offers && !!token,
    base,
    marketplace,
    buyerReport: deal.buyer_report_url,
    cmaUrl: deal.compr_cma_url,
    heroUrl: deal.hero_image_url,
  }));
}
