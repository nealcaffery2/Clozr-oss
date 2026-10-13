/**
 * Deal Machine → CLOZR.
 *
 * SUPERSEDED — this is no longer the code that runs. The extension carries this
 * mapping natively now: the upstream deal-machine site repo,
 * `chrome-extension/background.js`, the "Clozr sync" block at the top. Change
 * it there; this file is kept as the readable statement of the mapping and as
 * the standalone sink for any other sender that wants one.
 *
 * Drop this file into the extension (`chrome-extension/clozr-sink.js`), add it
 * to the service worker, and call `pushDealToClozr(deal)` at the same point the
 * run already calls its Podio push. It is deliberately a SECOND sink, not a
 * replacement: run both for a week and diff what lands before trusting it.
 *
 *   // background.js
 *   importScripts('clozr-sink.js');
 *   …
 *   await pushToPodio(deal);              // unchanged
 *   await pushDealToClozr(deal);          // new, never throws
 *
 * Setup, once, from the extension's options or the console:
 *   chrome.storage.local.set({
 *     clozrEndpoint: 'https://<project>.supabase.co/functions/v1/ingest',
 *     clozrKey: 'clz_…'                   // Settings → Ingest keys → Deal Machine
 *   });
 *
 * MV3 service workers are killed between events, so nothing is cached in
 * memory and every call re-reads storage.
 */

/* global chrome */

const CLOZR_MAX_ATTEMPTS = 4;

/**
 * The field names below are the one part of this file that was not read from
 * the extension's own source — the deal object's shape wasn't visible from
 * outside the repo. Each line lists the plausible aliases and takes the first
 * that is present, so it should work as-is; pin it to the real names on the
 * first live run.
 *
 * Nothing is lost either way: the whole deal object ships in `raw`, and a
 * corrected mapping can be replayed over the stored payloads with
 * `select public.ingest_replay(<workspace>, 'deal_machine')`.
 */
function firstOf(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

/** Strip $ and commas so "$186,000" becomes 186000. */
function money(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A stable id for this deal, because it is the idempotency key.
 *
 * Re-running a scrape over the same Facebook post must not create a second
 * lead, so this must be derived from the deal, never from Date.now(). The
 * post/listing id is ideal; the address is the fallback.
 */
function dealSourceId(deal) {
  const id = firstOf(deal, ['id', 'postId', 'post_id', 'listingId', 'externalId', 'url', 'permalink']);
  if (id) return String(id).slice(0, 256);
  const addr = firstOf(deal, ['address', 'propertyAddress', 'street', 'addr']) ?? '';
  const src = firstOf(deal, ['sourceSite', 'site', 'origin']) ?? 'dm';
  return `${src}:${String(addr).toLowerCase().replace(/\s+/g, '-')}`.slice(0, 256);
}

function toEnvelope(deal) {
  const arv = money(firstOf(deal, ['arv', 'ARV', 'afterRepairValue', 'estimatedArv']));
  const rehab = money(firstOf(deal, ['rehab', 'repairs', 'rehabCost', 'estimatedRehab']));
  const asking = money(firstOf(deal, ['asking', 'askingPrice', 'price', 'listPrice']));

  return {
    source: 'deal_machine',
    source_id: dealSourceId(deal),
    type: 'lead.discovered',
    occurred_at: new Date().toISOString(),

    property: {
      line1: firstOf(deal, ['address', 'propertyAddress', 'street', 'addr', 'address1']),
      city: firstOf(deal, ['city', 'propertyCity']),
      state: firstOf(deal, ['state', 'propertyState', 'st']),
      zip: firstOf(deal, ['zip', 'zipcode', 'postalCode', 'propertyZip']),
      beds: Number(firstOf(deal, ['beds', 'bedrooms', 'bd'])) || undefined,
      baths: Number(firstOf(deal, ['baths', 'bathrooms', 'ba'])) || undefined,
      sqft: Number(String(firstOf(deal, ['sqft', 'squareFeet', 'sf']) ?? '').replace(/[^0-9]/g, '')) || undefined,
      year_built: Number(firstOf(deal, ['yearBuilt', 'year', 'built'])) || undefined,
    },

    person: {
      name: firstOf(deal, ['sellerName', 'contactName', 'ownerName', 'posterName', 'name']),
      phone: firstOf(deal, ['sellerPhone', 'contactPhone', 'phone', 'ownerPhone']),
      email: firstOf(deal, ['sellerEmail', 'contactEmail', 'email']),
    },

    deal: {
      asking_price: asking,
      arv,
      rehab,
      // The extension's own screen, from chrome-extension/RUNBOOK.md:
      // good deal = Asking ≤ (70% ARV − Rehab − $20k), in ARV range, open city.
      // $20k is the assignment fee the rule reserves.
      // Rounded: 345000 * 0.7 in binary floating point is 241499.99999999997.
      mao: arv !== undefined && rehab !== undefined ? Math.round(arv * 0.7 - rehab - 20000) : undefined,
      motivation: firstOf(deal, ['motivation', 'reason', 'sellerMotivation']),
      notes: firstOf(deal, ['notes', 'description', 'body', 'postText']),
      source_site: firstOf(deal, ['sourceSite', 'site', 'origin', 'platform']),
    },

    // Everything, verbatim. This is what makes a wrong mapping recoverable.
    raw: deal,
  };
}

/**
 * Push one qualified deal. Never throws — a CRM push must not be able to kill
 * a scrape run that is halfway through a list.
 *
 * Returns { ok, deduped?, status?, error? } so the caller can count it the way
 * the popup already counts Podio pushes.
 */
async function pushDealToClozr(deal) {
  let cfg;
  try {
    cfg = await chrome.storage.local.get(['clozrEndpoint', 'clozrKey']);
  } catch (e) {
    return { ok: false, error: 'storage unavailable: ' + e.message };
  }
  if (!cfg.clozrEndpoint || !cfg.clozrKey) {
    return { ok: false, error: 'CLOZR not configured (clozrEndpoint / clozrKey)' };
  }

  const body = JSON.stringify(toEnvelope(deal));

  for (let attempt = 1; attempt <= CLOZR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(cfg.clozrEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.clozrKey,
        },
        body,
      });

      if (res.ok) {
        const out = await res.json();
        console.log('[DealMachine→CLOZR]', out.deduped ? 'already had it' : 'accepted', out);
        return { ok: true, deduped: !!out.deduped, ...out };
      }

      // 4xx is our bug — a bad envelope or a dead key. Retrying cannot fix it
      // and would just burn the run, so stop and say so loudly.
      if (res.status >= 400 && res.status < 500) {
        const detail = await res.text();
        console.warn('[DealMachine→CLOZR] rejected', res.status, detail);
        return { ok: false, status: res.status, error: detail };
      }
      // 5xx: transient. Fall through to the backoff.
    } catch (e) {
      // Network error, offline, service worker torn down mid-flight.
      if (attempt === CLOZR_MAX_ATTEMPTS) {
        console.warn('[DealMachine→CLOZR] gave up', e.message);
        return { ok: false, error: e.message };
      }
    }

    if (attempt < CLOZR_MAX_ATTEMPTS) {
      // 1s, 2s, 4s with jitter. The endpoint is idempotent on source_id, so a
      // retry after a response we never saw is safe.
      const wait = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { ok: false, error: 'exhausted retries' };
}

// Service-worker global, matching how the rest of the extension is written.
if (typeof globalThis !== 'undefined') {
  globalThis.pushDealToClozr = pushDealToClozr;
  globalThis.clozrDealEnvelope = toEnvelope; // exported for the test page
}
