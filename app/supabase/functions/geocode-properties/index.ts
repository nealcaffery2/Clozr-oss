/**
 * POST /geocode-properties — fill properties.lat/lng so distance matching works.
 *
 * Radius buy-box matching (buyer_markets.match_type='radius') needs real
 * coordinates; exact place matching does not. Every property row landed here
 * from an import with no coordinates, so this backfills them.
 *
 * Primary source is the US Census Bureau batch geocoder: free, no key, and it
 * takes up to 10,000 addresses per upload. That matters because the
 * alternative — one ATTOM property/basicprofile call per address — would spend
 * thousands of billable ATTOM calls on data ATTOM is not needed for. ATTOM
 * stays as the per-address fallback for rows Census cannot match, which is
 * where its address parsing actually earns its cost.
 *
 * An operational backfill run from a console, not a user-facing endpoint, and
 * it writes across every workspace: the service role only (the project's
 * service key, or the cron's vault key), sent as `Authorization: Bearer …`.
 * It only ever writes lat/lng, and only onto rows where they are null. This
 * lived only in the dashboard behind a static token in the source; that token
 * no longer opens anything (docs/security.md).
 *
 * Body:
 *   { action: 'check' }
 *     -> which provider secrets are set on this project (presence only, never
 *        the value), so a missing key is distinguishable from a bad address.
 *   { limit?=500, use_attom_fallback?=true, dry_run?=false }
 *     -> { attempted, census_hits, attom_hits, misses, updated, remaining }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, HARDENING, isServiceCaller } from '../_shared/security.ts';

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const ATTOM = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Any = any;

interface Row { id: number; line1: string | null; city: string | null; state: string | null; zip: string | null }

const clean = (s: string | null | undefined) =>
  (s ?? '').replace(/[",\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

const zip5 = (s: string | null | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : '';
};

const plausible = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= 17 && lat <= 72 && lng >= -180 && lng <= -64;

/** Census wants: id,street,city,state,zip with no header. */
function toCsv(rows: Row[]): string {
  return rows
    .map((r) => [r.id, clean(r.line1), clean(r.city), clean(r.state), zip5(r.zip)].join(','))
    .join('\n');
}

/**
 * The response is CSV, one line per input, quoted fields. Coordinates come
 * back as lon,lat — the reverse of how they are stored, which is an easy and
 * silent thing to get backwards.
 */
function parseCensus(text: string): Map<number, { lat: number; lng: number }> {
  const out = new Map<number, { lat: number; lng: number }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);

    const id = Number(cells[0]);
    if (!Number.isFinite(id)) continue;
    if ((cells[2] ?? '').trim() !== 'Match') continue;

    const coords = (cells[5] ?? '').split(',');
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (plausible(lat, lng)) out.set(id, { lat, lng });
  }
  return out;
}

async function censusBatch(rows: Row[]): Promise<Map<number, { lat: number; lng: number }>> {
  const form = new FormData();
  form.append('benchmark', 'Public_AR_Current');
  form.append('addressFile', new Blob([toCsv(rows)], { type: 'text/csv' }), 'addresses.csv');
  try {
    const res = await fetch(CENSUS, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return new Map();
    return parseCensus(await res.text());
  } catch {
    return new Map();
  }
}

/** Returns coordinates, or a reason string so a missing key is never silent. */
async function attomGeocode(r: Row): Promise<{ lat: number; lng: number } | { error: string }> {
  const key = (Deno.env.get('ATTOM_API_KEY') ?? '').trim();
  if (!key) return { error: 'no_key' };
  const address2 = [clean(r.city), clean(r.state), zip5(r.zip)].filter(Boolean).join(' ');
  if (!clean(r.line1) || !address2) return { error: 'incomplete_address' };
  try {
    const url = `${ATTOM}/property/basicprofile?${new URLSearchParams({ address1: clean(r.line1), address2 })}`;
    const res = await fetch(url, {
      headers: { APIKey: key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { error: 'key_rejected' };
    if (!res.ok) return { error: `http_${res.status}` };
    const j: Any = await res.json();
    const p = j?.property?.[0];
    const lat = Number(p?.location?.latitude);
    const lng = Number(p?.location?.longitude);
    return plausible(lat, lng) ? { lat, lng } : { error: 'no_match' };
  } catch (e) {
    return { error: `fetch_failed: ${(e as Error).message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service role only' }, 403);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  // Presence only. Never return a key, or any part of one.
  if (b.action === 'check') {
    const present = (n: string) => Boolean((Deno.env.get(n) ?? '').trim());
    return json({
      secrets: {
        ATTOM_API_KEY: present('ATTOM_API_KEY'),
        BATCHDATA_API_KEY: present('BATCHDATA_API_KEY'),
        RESEND_API_KEY: present('RESEND_API_KEY'),
        SENDGRID_API_KEY: present('SENDGRID_API_KEY'),
        POSTMARK_SERVER_TOKEN: present('POSTMARK_SERVER_TOKEN'),
      },
    });
  }

  const limit = Math.min(1000, Math.max(1, Number(b.limit) || 500));
  const useAttom = b.use_attom_fallback !== false;
  const dryRun = b.dry_run === true;

  const { data: rows, error } = await admin
    .from('properties')
    .select('id, line1, city, state, zip')
    .is('lat', null)
    .not('line1', 'is', null)
    .order('id')
    .limit(limit);
  if (error) return json({ error: error.message }, 500);

  const batch = (rows ?? []).filter((r: Row) => clean(r.line1) && (clean(r.city) || zip5(r.zip)));
  if (!batch.length) {
    return json({ attempted: 0, census_hits: 0, attom_hits: 0, misses: 0, updated: 0, remaining: 0 });
  }

  const hits = await censusBatch(batch);
  const censusHits = hits.size;

  let attomHits = 0;
  const attomErrors: Record<string, number> = {};
  if (useAttom) {
    const missed = batch.filter((r: Row) => !hits.has(r.id));
    // Serial, with a small gap: ATTOM rate-limits, and every call is billable.
    for (const r of missed) {
      const g = await attomGeocode(r);
      if ('error' in g) {
        attomErrors[g.error] = (attomErrors[g.error] ?? 0) + 1;
        // No point hammering the remaining rows if the key is simply absent.
        if (g.error === 'no_key' || g.error === 'key_rejected') break;
      } else {
        hits.set(r.id, g);
        attomHits++;
      }
      await new Promise((res) => setTimeout(res, 120));
    }
  }

  let updated = 0;
  if (!dryRun) {
    for (const [id, g] of hits) {
      const { error: upErr } = await admin
        .from('properties')
        .update({ lat: g.lat, lng: g.lng })
        .eq('id', id)
        .is('lat', null);
      if (!upErr) updated++;
    }
  }

  const { count: remaining } = await admin
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .is('lat', null)
    .not('line1', 'is', null);

  return json({
    attempted: batch.length,
    census_hits: censusHits,
    attom_hits: attomHits,
    attom_errors: attomErrors,
    misses: batch.length - hits.size,
    updated,
    remaining: remaining ?? null,
    dry_run: dryRun,
  });
});
