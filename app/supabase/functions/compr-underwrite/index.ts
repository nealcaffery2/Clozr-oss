/**
 * POST /compr-underwrite — ask COMPR for ARV, rehab and MAO on a property.
 *
 * COMPR is Acme Homes' own underwriting product. This is the outbound half of
 * the integration (the inbound half is the ingest door, which COMPR can post
 * to). It calls COMPR's documented REST API:
 *
 *   POST https://underwriting.example.com/api/v1/underwrite
 *   Authorization: Bearer compr_live_… | compr_test_…
 *   { address: { street, city, state, zip }, photo_urls?: string[], photo_sources?: string[], subject?: object }
 *   → { status, arv: { weighted, low, high }, rehab: { for_flip, for_rental,
 *       uad_condition }, mao: { presented_offer, wholesale, institutional },
 *       exit_offers, confidence: { score }, red_flags, comp_count,
 *       comp_report_url }
 *
 * The key is a project secret (COMPR_API_KEY). The seller is read as the
 * caller so RLS decides who may underwrite what; the result is written with
 * the service role onto the seller's deal, with a readable summary (range,
 * comps, condition, both MAOs, red flags, report link) as activity.
 *
 * A run is synchronous on COMPR's side (usually under a minute, hard ceiling
 * five). Edge functions have a wall clock too, so the call is capped and a
 * slow run answers 504 with a plain "try again"; the same lead_id is sent on
 * the retry so a finished report is replayed rather than billed again.
 *
 * Body:    { workspace_id, seller_id, deal_id?, refresh_lead? }  — deal_id picks the deal (and its
 *          property) on a contact with many deals, e.g. a partner. refresh_lead
 *          re-runs a report the deal links to in place (force_refresh, same
 *          /r/ link) with every photo on the record; links are left as they are.
 * Internal: the ingest function calls with the service-role key as the bearer
 *          for a deal it just created (no user: no owner, no auto-offer; capped
 *          at 80 runs an hour per workspace, shared with Podio and the sweep).
 * Returns: { ok, arv, rehab, mao, wholesale, institutional, status,
 *            confidence, report_url, red_flags }
 *
 * Share:   { workspace_id, seller_id, action: 'share', audience: 'seller' | 'buyer' }
 *          → { ok, audience, url }  — the public Compr Seller or Compr Buyer
 *          report (underwriting.example.com/v/<token>, POST /api/share-link with the same
 *          key). A deal with a saved report shares that lead; one without is
 *          underwritten first, exactly as above, and then shared.
 *
 * Suggest: { action: 'suggest', q } → { ok, items: [{ place_id, src, main, secondary }] }
 *          { action: 'suggest', place_id, src } → { ok, place: { addr, city, st, zip, lat, lng } }
 *          Google address autocomplete through COMPR's /api/address-suggest
 *          on the same key: CLOZR's address boxes get Google's suggestions
 *          without a Maps key of their own. Nothing billed, nothing written.
 *
 * Assets:  { workspace_id, seller_id, action: 'assets', deal_id? }
 *          → { ok, buyer_report_url, photo_url, photos, cma_url }  — no run,
 *          nothing billed. Buyer share link, tokenized photo-set URLs written
 *          onto deal_files, hero photo, and a buyer CMA PDF. The dispo blast
 *          merge fields read these.
 *
 * Pull:    { workspace_id, deal_id, action: 'pull', check? } → { ok, changed, arv, rehab, mao, low, high, lead_id,
 *            own_photos, report_photos, report_provenance, photos_missing }
 *          No run, nothing billed. The numbers the deal's COMPR report shows
 *          now (ARV, rehab and offer after any edit an AM saved there) onto
 *          the deal, with the low / high that follow, unless a person set
 *          them. CLOZR asks when the rep comes back from the COMPR window.
 *          check: write nothing, only say whether the report is missing the
 *          photos the record holds.
 *
 * Outcome: { workspace_id, deal_id, action: 'outcome', auto? } → { ok, stages, already, lead_id }
 *          A Closed or Terminated deal's actuals to Compr's calibration intake
 *          (POST /api/calibration/capture, COMPR_TEAM_API_KEY, else COMPR_API_KEY), so its ARV,
 *          rehab and offer predictions learn what the deal really did. The
 *          lead_id is the one this function sent for the deal's underwrite
 *          (compr_underwrites; else the seller's latest; else the report
 *          link). Each send is mirrored in compr_outcomes and is a line on the
 *          deal's activity. `auto` (service role only) is the deals trigger on
 *          a stage move: outcomes already sent are skipped. Every body also
 *          carries the deal id, the address, the team's ARV / rehab / MAO and
 *          the deal's data flaws (dealFlaws), for Compr's cross-reference.
 *
 * Weekly: { workspace_id, action: 'outcome_sweep' } (service role only) →
 *          { ok, started }. Every Closed and Terminated deal's outcome, sent
 *          when it changed, then the team's flaws to Compr's
 *          /api/calibration/weekly; both halves land in compr_sync_reports.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, corsFor, isServiceCaller, jsonWith, memberRole, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { generateOffer } from '../_shared/docs.ts';
import { comprPropertyFacts, comprPropertyLine, comprRecords, propertyPatchFromCompr } from '../_shared/compr-records.ts';
import { cmaFromCompr } from '../_shared/compr-cma.ts';
import { cmaPdfBytes } from '../_shared/compr-cma-pdf.ts';
import { comprLeadId, comprLeadIdInUrl, comprLeadIds, dealFlaws, leadIdDay, outcomePayloads, payloadKey, type OutcomeDeal, type OutcomeFeedback } from '../_shared/compr-outcome.ts';
import { COMPR_FACT_KEYS, COMPR_PHOTO_CAP, comprFacts, comprPhotoPayload, comprSubject, dedupeByPhotoKey } from '../_shared/compr-photos.ts';
import { comprNumbersOf, comprPhotoGap, comprPhotosOf } from '../_shared/compr-numbers.ts';
import { bandOfRow, offerBand, offerBandColumns } from '../_shared/offer-band.ts';
import { pickSellerDeal } from '../_shared/compr-deal-pick.ts';

const COMPR_URL = 'https://underwriting.example.com/api/v1/underwrite';
const KEY_NAMES = ['COMPR_API_KEY', 'COMPR_KEY', 'COMPR_API_TOKEN', 'COMPR_TOKEN', 'COMPR'];
const CALL_CAP_MS = 140_000;
/**
 * The edge gateway cuts a request off at 150 s with no answer (61 times in a
 * day), and the photo work before the COMPR call can take up to 55 s of it.
 * The call waits only for what is left of this budget, measured from the
 * request's start, so a slow run ends in this function's own "still running,
 * try again" reply (504) rather than the gateway's silent cut. A run that
 * needs longer still finishes on COMPR's side and comes straight back on the
 * retry. Making the whole underwrite a background job the client polls is
 * the full fix (see the PR); this keeps the answer honest until then.
 */
const GATEWAY_BUDGET_MS = 142_000;


/** First numeric value found at any of these dotted paths. */
function pickNumber(obj: unknown, paths: string[]): number | null {
  for (const p of paths) {
    const v = p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
    const n = typeof v === 'string' ? Number(v.replace(/[^0-9.\-]/g, '')) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}
function pickString(obj: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const v = p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** A sweep answer that is not the house's fault: COMPR busy, a run still going (it replays when asked again), the edge runtime's own limits, a dropped connection. */
const SWEEP_TRANSIENT = new Set([0, 429, 502, 503, 504, 546]);

/**
 * Stamp a swept deal. Before migration 184 there is no compr_sweep_tries
 * column, and the stamp goes without it.
 */
async function markSweep(admin: Admin, dealId: number, fields: { compr_photos_synced_at: string; compr_sweep_tries: number }): Promise<void> {
  const { error } = await admin.from('deals').update(fields).eq('id', dealId);
  if (error) await admin.from('deals').update({ compr_photos_synced_at: fields.compr_photos_synced_at }).eq('id', dealId);
}

/** The photo position the saved hero points at, when it is this lead's photo. */
function heroPosition(hero: string | null | undefined, leadId: string): number | null {
  if (!hero || !/thecompr\.com\/api\/photo/i.test(hero)) return null;
  try {
    const u = new URL(hero);
    if (u.searchParams.get('lead_id') !== leadId) return null;
    const pos = Number(u.searchParams.get('pos'));
    return Number.isInteger(pos) && pos >= 0 ? pos : null;
  } catch { return null; }
}

/** Compr's public, no-login link to a lead's seller or buyer report. Idempotent on Compr's side. */
async function shareLinkMeta(key: string, leadId: string, audience: 'seller' | 'buyer'): Promise<{ url: string; token: string | null }> {
  const res = await fetch('https://underwriting.example.com/api/share-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ lead_id: leadId, audience }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { path?: string; token?: string };
  if (!res.ok || !j.path) {
    console.error('compr share-link', { status: res.status, lead: leadId });
    throw new Error(res.status === 404 ? 'COMPR has no report under this record’s lead yet.' : `COMPR could not make the report link (${res.status}).`);
  }
  return { url: 'https://underwriting.example.com' + j.path, token: typeof j.token === 'string' && j.token ? j.token : null };
}
async function shareLink(key: string, leadId: string, audience: 'seller' | 'buyer'): Promise<string> {
  return (await shareLinkMeta(key, leadId, audience)).url;
}

const COMPR_ORIGIN = 'https://underwriting.example.com';
const STREET_VIEW_URL = /maps\.googleapis\.com\/maps\/api\/streetview|googleusercontent\.com\/streetview/i;

/**
 * COMPR's front photo of the subject as a URL a browser can load: COMPR's
 * photo proxy, opened by the lead's seller share token (an <img> cannot carry
 * a session). Same pick as COMPR's own report hero: vision's
 * front_photo_index when it named a curb shot, else the first photo. A Street
 * View tile is not a photo, so it is skipped and CLOZR keeps drawing its own.
 * Null when there is nothing to show; never throws.
 */
async function comprHeroUrl(key: string, leadId: string): Promise<string | null> {
  const auth = { Authorization: `Bearer ${key}` };
  const rr = await fetch(`${COMPR_ORIGIN}/api/underwrite-result?lead_id=${encodeURIComponent(leadId)}`, {
    headers: auth, signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!rr?.ok) return null;
  const r = (await rr.json().catch(() => null)) as {
    photos?: { storage_url?: string | null; position?: number | null }[];
    vision?: { raw_response?: { photo_coverage?: { front_photo_index?: number | null } } }[];
  } | null;
  const photos = Array.isArray(r?.photos) ? r!.photos : [];
  if (!photos.length) return null;
  const front = (r?.vision ?? [])
    .map((v) => v?.raw_response?.photo_coverage?.front_photo_index)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < photos.length)
    .pop();
  const idx = front ?? 0;
  const url = photos[idx]?.storage_url ?? '';
  if (!url || url.startsWith('inline-base64') || STREET_VIEW_URL.test(url)) return null;
  const pos = photos[idx]?.position ?? idx;
  const sr = await fetch(`${COMPR_ORIGIN}/api/share-link`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: leadId, audience: 'seller' }), signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  const token = sr?.ok ? ((await sr.json().catch(() => ({}))) as { token?: string }).token : null;
  if (!token) return null;
  return photoProxyUrl(leadId, pos, token);
}

function photoProxyUrl(leadId: string, pos: number, token: string): string {
  return `${COMPR_ORIGIN}/api/photo?lead_id=${encodeURIComponent(leadId)}&pos=${pos}&token=${encodeURIComponent(token)}`;
}

type Admin = ReturnType<typeof createClient>;

// ── Outcomes back to Compr ───────────────────────────────────────────────────

// The untyped client's tables are `never` to the checker; this one takes any row.
// deno-lint-ignore no-explicit-any
type OutcomeDb = ReturnType<typeof createClient<any>>;
type OutcomeMode = 'manual' | 'auto' | 'sweep';
type OutcomeAnswer =
  | { ok: true; stages: string[]; already: string[]; lead_id?: string; skipped?: string }
  | { error: string; status: number; stages?: string[] };

const DEAL_OUTCOME_COLS = 'id, seller_id, stage, underwriting_url, compr_report_url, hero_image_url, offer_amount, sold_price, assignment_fee, closed_on, close_date, terminated_on, termination_reason, stage_entered_at, arv, rehab, mao, properties(line1, state, zip)';
type DealOutcomeRow = OutcomeDeal & {
  id: number; seller_id: number | null; compr_report_url: string | null;
  arv: number | null; rehab: number | null; mao: number | null;
  properties: { line1: string | null; state: string | null; zip: string | null } | null;
};

/** The Acme Homes key when it is set, else the underwriting key CLOZR already has. */
function outcomeKey(): { key: string; name: string } | null {
  const teamKey = Deno.env.get('COMPR_TEAM_API_KEY');
  if (teamKey) return { key: teamKey, name: 'COMPR_TEAM_API_KEY' };
  const fallback = comprKey();
  return 'key' in fallback ? { key: fallback.key, name: 'COMPR_API_KEY' } : null;
}

/** COMPR_API_URL points the outcome at another Compr (a staging copy); underwriting.example.com otherwise. */
const comprApiOrigin = () => (Deno.env.get('COMPR_API_URL')?.trim() || COMPR_ORIGIN).replace(/\/+$/, '');

/** What CLOZR adds to the deal's capture bodies: where it came from, the house, the team's numbers, its flaws. */
function feedbackOf(d: DealOutcomeRow, flags: string[]): OutcomeFeedback {
  const team: NonNullable<OutcomeFeedback['team']> = {};
  for (const [k, v] of [['arv', d.arv], ['rehab', d.rehab], ['offer', d.mao]] as const) {
    const n = Number(v);
    if (v != null && Number.isFinite(n) && n > 0) team[k] = n;
  }
  return {
    source_system: 'clozr', source_deal_id: String(d.id),
    ...(d.properties?.line1 ? { address: d.properties.line1 } : {}),
    ...(d.properties?.zip ? { zip: d.properties.zip } : {}),
    ...(Object.keys(team).length ? { team } : {}),
    ...(flags.length ? { flags } : {}),
  };
}

/**
 * A finished deal's actuals to Compr's calibration intake (POST
 * /api/calibration/capture). Idempotent on Compr's side: it updates the lead's
 * outcome row in place. The underwrite is the deal's own, else the seller's
 * latest (compr_underwrites, migration 143), addressed by the lead_id CLOZR
 * sent when it asked for it; each outcome is mirrored in compr_outcomes, once
 * per (underwrite, outcome). `auto` skips outcomes already sent; `sweep`
 * skips one whose body has not changed since it was sent, and stops retrying
 * a lead Compr does not know (or says is another house) after three tries. Neither treats a deal with
 * nothing to send as an error.
 */
async function sendOutcome(admin: OutcomeDb, workspaceId: number, dealId: number, mode: OutcomeMode, userId: string | null, sweepFlags?: string[]): Promise<OutcomeAnswer> {
  const quiet = mode !== 'manual';
  const k = outcomeKey();
  if (!k) return { error: 'Compr outcome sync is not connected: set COMPR_TEAM_API_KEY (or COMPR_API_KEY) on the Supabase project.', status: 503 };
  const { data: row } = await admin.from('deals').select(DEAL_OUTCOME_COLS).eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
  if (!row) return { error: 'deal not found', status: 404 };
  const d = row as unknown as DealOutcomeRow;

  // The underwrite: this deal's newest, else the seller's newest that is on
  // no deal (a run from the seller's record). Another deal's underwrite is
  // another house: seller 1296 has ten, and Peachtree Farms' close landed on
  // Black Rock Ln's report that way. Before migration 143 there is no ledger,
  // and the report link alone is used.
  type Uw = { id: number; lead_id: string };
  let uw: Uw | null = null;
  const byDeal = await admin.from('compr_underwrites').select('id, lead_id').eq('workspace_id', workspaceId).eq('deal_id', dealId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const ledger = !byDeal.error;
  uw = (byDeal.data as Uw | null) ?? null;
  if (ledger && !uw && d.seller_id) {
    const { data: bySeller } = await admin.from('compr_underwrites').select('id, lead_id').eq('workspace_id', workspaceId).eq('seller_id', d.seller_id)
      .is('deal_id', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
    uw = (bySeller as Uw | null) ?? null;
  }
  const flags = sweepFlags ?? dealFlaws([{ ...d, line1: d.properties?.line1, state: d.properties?.state, has_compr: true }], new Date().toISOString().slice(0, 10))
    .filter((f) => f.flag !== 'no_compr_underwrite').map((f) => f.flag);
  const built = outcomePayloads(d, uw ? [comprLeadId(uw.lead_id)] : [], feedbackOf(d, flags));
  if (!built.ok) return quiet ? { ok: true, stages: [], already: [], skipped: built.reason } : { error: built.reason, status: 422 };
  // A deal underwritten inside the embedded Compr has a report link but no
  // request of ours: its link becomes the underwrite the outcome hangs on.
  if (ledger && !uw) {
    const { data: made } = await admin.from('compr_underwrites')
      .upsert({ workspace_id: workspaceId, seller_id: d.seller_id, deal_id: dealId, lead_id: built.leadIds[0], report_url: d.underwriting_url, source: 'report_link' },
        { onConflict: 'workspace_id,lead_id' })
      .select('id, lead_id').maybeSingle();
    uw = (made as Uw | null) ?? null;
  }
  const prior = new Map<string, { status: string; attempts: number; http_status: number | null; payload: Record<string, unknown> | null }>();
  if (uw) {
    const { data: rows } = await admin.from('compr_outcomes').select('outcome, status, attempts, http_status, payload').eq('underwrite_id', uw.id);
    for (const r of (rows ?? []) as { outcome: string; status: string; attempts: number; http_status: number | null; payload: Record<string, unknown> | null }[]) prior.set(r.outcome, r);
  }

  const capture = (payload: unknown) => fetch(`${comprApiOrigin()}/api/calibration/capture`, {
    method: 'POST',
    // Compr's middleware refuses some automated user agents: name ourselves.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}`, 'User-Agent': 'CLOZR/1.0 (+outcome-sync)' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  }).then(async (r) => ({ status: r.status, text: (await r.text().catch(() => '')).slice(0, 300) }))
    .catch((e) => ({ status: 0, text: (e as Error).message }));

  // The report link can be an address slug; a lead Compr does not know (404),
  // or one Compr says is a different house (409), tries the next one.
  let leads = built.leadIds;
  const sent: string[] = [];
  const already: string[] = [];
  let error: string | null = null;
  for (const p of built.payloads) {
    const was = prior.get(p.stage);
    const same = !!was && payloadKey(was.payload) === payloadKey(p as unknown as Record<string, unknown>);
    const dead = was?.http_status === 404 || was?.http_status === 409;
    if ((mode === 'auto' && was?.status === 'sent') || (mode === 'sweep' && same && (was?.status === 'sent' || (dead && (was?.attempts ?? 0) >= 3)))) {
      already.push(p.stage);
      continue;
    }
    let r = { status: 0, text: '' };
    let usedLead = leads[0];
    for (const id of leads) {
      usedLead = id;
      r = await capture({ ...p, lead_id: id });
      if (r.status !== 404 && r.status !== 409) { leads = [id]; break; }
    }
    const ok = r.status >= 200 && r.status < 300;
    let why: string | null = null;
    if (!ok) {
      console.error('compr outcome', { deal: dealId, stage: p.stage, status: r.status, body: r.text });
      why = r.status === 401 || r.status === 403 ? `Compr rejected the key (${k.name}). Set COMPR_TEAM_API_KEY on the Supabase project.`
        : r.status === 404 ? 'Compr has no underwrite for this deal’s report.'
        : r.status === 409 ? 'The Compr report linked to this deal is for a different house.'
        : r.status === 400 ? `Compr refused the ${p.stage.replace('_', ' ')} numbers.`
        : r.status === 0 ? 'Compr did not answer.' : `Compr answered ${r.status}.`;
    }
    if (uw) {
      const { error: mirrorErr } = await admin.from('compr_outcomes').upsert({
        workspace_id: workspaceId, underwrite_id: uw.id, deal_id: dealId, outcome: p.stage, lead_id: usedLead,
        payload: { ...p, lead_id: usedLead }, status: ok ? 'sent' : 'failed', http_status: r.status || null, error: why,
        attempts: same || !was ? (was?.attempts ?? 0) + 1 : 1, ...(ok ? { sent_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'underwrite_id,outcome' });
      if (mirrorErr) console.error('compr_outcomes', mirrorErr.message);
    }
    if (!ok) { error = why; break; }
    sent.push(p.stage);
  }

  if (quiet && !sent.length && !error) return { ok: true, stages: [], already };
  const stages = sent.map((s) => s.replace('_', ' ')).join(', ');
  const when = mode === 'auto' ? ' when the deal moved' : mode === 'sweep' ? ' in the weekly sync' : '';
  await admin.from('activity').insert({
    workspace_id: workspaceId, entity_type: 'deal', entity_id: dealId, kind: 'compr',
    title: error ? `Compr outcome not sent: ${error}` : `Compr outcome sent (${stages})${when}`,
    body: [`Lead id ${leads[0]}.`, sent.length ? `Sent: ${stages}.` : null, error, flags.length ? `Flagged: ${flags.join(', ')}.` : null].filter(Boolean).join('\n'),
    actor_id: userId,
  });
  return error ? { error, status: 502, stages: sent } : { ok: true, stages: sent, already, lead_id: leads[0] };
}

/** Monday of the week a day falls in, YYYY-MM-DD (UTC). */
function weekOf(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * The weekly pass for one workspace: flaws over the whole closed book (a
 * duplicate needs its twin in view), each finished deal's outcome sent when
 * it changed, then the flaws and the tallies to Compr's weekly
 * cross-reference (POST /api/calibration/weekly), whose answer is kept with
 * them in compr_sync_reports for the week. A second pass the same week
 * replaces the row and only sends what the first one could not.
 */
async function outcomeSweep(admin: OutcomeDb, workspaceId: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const { data: rows, error } = await admin.from('deals').select(DEAL_OUTCOME_COLS)
    .eq('workspace_id', workspaceId).in('stage', ['Closed', 'Terminated']).order('id');
  if (error) { console.error('outcome sweep', error.message); return { error: error.message }; }
  // Archived deals count: a Terminated deal is archived as "Terminated" (86 of 90).
  const deals = (rows ?? []) as unknown as DealOutcomeRow[];
  const { data: uws } = await admin.from('compr_underwrites').select('deal_id, lead_id').eq('workspace_id', workspaceId).in('deal_id', deals.map((d) => d.id));
  const runDays = new Map<number, string[]>();
  for (const u of (uws ?? []) as { deal_id: number; lead_id: string }[]) {
    const dayOf = leadIdDay(comprLeadId(u.lead_id));
    runDays.set(u.deal_id, [...(runDays.get(u.deal_id) ?? []), ...(dayOf ? [dayOf] : [])]);
  }
  const flaws = dealFlaws(deals.map((d) => ({
    ...d, line1: d.properties?.line1, state: d.properties?.state, zip: d.properties?.zip,
    underwritten_at: runDays.get(d.id) ?? [],
    has_compr: runDays.has(d.id) || comprLeadIds(d).length > 0,
  })), today);
  const flagsOf = new Map<number, string[]>();
  for (const f of flaws) if (f.flag !== 'no_compr_underwrite') flagsOf.set(f.deal_id, [...(flagsOf.get(f.deal_id) ?? []), f.flag]);

  const tally = { deals: deals.length, sent: 0, unchanged: 0, skipped: 0, failed: 0, not_reached: 0 };
  const failures: { deal_id: number; error: string }[] = [];
  for (const d of deals) {
    // Leave room in the edge runtime's wall clock for the report.
    if (Date.now() - started > 80_000) { tally.not_reached++; continue; }
    if (!runDays.has(d.id) && !comprLeadIds(d).length) { tally.skipped++; continue; }
    const r = await sendOutcome(admin, workspaceId, d.id, 'sweep', null, flagsOf.get(d.id) ?? []);
    if ('error' in r) { tally.failed++; failures.push({ deal_id: d.id, error: r.error }); }
    else if (r.stages.length) tally.sent++;
    else if (r.skipped) tally.skipped++;
    else tally.unchanged++;
  }

  // Compr's side: its predictions against these actuals. Missing until Compr
  // ships /api/calibration/weekly; the CLOZR half of the report stands alone.
  let compr: Record<string, unknown> | null = null;
  const k = outcomeKey();
  if (k) {
    try {
      const res = await fetch(`${comprApiOrigin()}/api/calibration/weekly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}`, 'User-Agent': 'CLOZR/1.0 (+outcome-sync)' },
        body: JSON.stringify({ source_system: 'clozr', workspace_id: workspaceId, week_of: weekOf(new Date()), tally, flaws }),
        // Compr's endpoint has 60s; the sends above stop at 80s, inside the edge runtime's 150s.
        signal: AbortSignal.timeout(55_000),
      });
      compr = res.ok ? await res.json() : { error: `Compr answered ${res.status}` };
    } catch (e) {
      compr = { error: (e as Error).message };
    }
  }
  const report = { workspace_id: workspaceId, week_of: weekOf(new Date()), tally, failures, flaws, compr, updated_at: new Date().toISOString() };
  const { error: saveErr } = await admin.from('compr_sync_reports').upsert(report, { onConflict: 'workspace_id,week_of' });
  if (saveErr) console.error('compr_sync_reports', saveErr.message);
  console.log('outcome sweep', { workspaceId, ...tally, flaws: flaws.length });
  return report;
}

type MarketingDeal = {
  id: number;
  underwriting_url: string | null;
  /** A Podio submission's COMPR report link ("Ai Compr Tool"), migration 169. */
  compr_report_url?: string | null;
  marketing_url: string | null;
  hero_image_url?: string | null;
  asking_price?: number | null;
  marketed_price?: number | null;
  offer_amount?: number | null;
  arv?: number | null;
  rehab?: number | null;
  mao?: number | null;
  property_id?: number | null;
};

/** COMPR's own buyer CMA PDF, when the API serves one. Null is normal — we write our own. */
async function comprCmaPdfFile(key: string, leadId: string, token: string | null): Promise<Uint8Array | null> {
  const auth = { Authorization: `Bearer ${key}` };
  const qs = `lead_id=${encodeURIComponent(leadId)}&audience=buyer${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const urls = [`${COMPR_ORIGIN}/api/cma.pdf?${qs}`, `${COMPR_ORIGIN}/api/report.pdf?${qs}`];
  for (const u of urls) {
    const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    if (!r?.ok) continue;
    const buf = new Uint8Array(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (buf.length > 100 && buf[0] === 0x25 && buf[1] === 0x50) return buf;
  }
  return null;
}

/**
 * The photos an underwrite carries (_shared/compr-photos.ts comprPhotoPayload):
 * the deal's own photo rows as images, cover first (the Drive photos CLOZR
 * read, Podio and Gmail uploads by a signed link a server can fetch), and
 * the source links deal_photo_links (migration 120) collects that CLOZR has
 * not read. Before this only the links went, so a Drive folder COMPR could
 * not open graded Street View while CLOZR showed its eighteen photos. The
 * deal is the one asked for, else the seller's deal on their own property.
 * Fail-open: no photos is the address-only run this always was.
 */
async function dealPhotoPayload(admin: Admin, workspaceId: number, dealId: number | null, sellerId: number, propertyId: number | null): Promise<{ photo_urls: string[]; photo_sources: string[] }> {
  const none = { photo_urls: [] as string[], photo_sources: [] as string[] };
  try {
    let id = dealId;
    if (id === null && propertyId != null) {
      const { data } = await admin.from('deals').select('id').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
        .eq('property_id', propertyId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      id = data ? Number((data as { id: number }).id) : null;
    }
    if (id === null) return none;
    const [links, rows] = await Promise.all([
      (admin as unknown as { rpc: Rpc }).rpc('deal_photo_links', { p_deal_id: id }),
      admin.from('deal_files').select('url, storage_path, source').eq('deal_id', id).eq('kind', 'photo')
        .order('is_cover', { ascending: false }).order('position', { ascending: true, nullsFirst: false }).order('id').limit(300),
    ]);
    if (links.error) console.error('compr photo links', links.error.message);
    // A private upload goes by a signed link that outlives the report's first
    // year; COMPR's gallery fetches it again whenever the report is opened.
    const photos = await Promise.all(((rows.data ?? []) as { url: string | null; storage_path: string | null; source: string | null }[])
      .map(async (r) => {
        if (r.url) return { url: r.url, source: r.source };
        if (!r.storage_path) return null;
        const { data } = await admin.storage.from('deal-files').createSignedUrl(r.storage_path, 60 * 60 * 24 * 400);
        return data?.signedUrl ? { url: data.signedUrl, source: r.source } : null;
      }));
    return comprPhotoPayload({
      links: (links.data ?? []) as string[],
      photos: photos.filter((p): p is { url: string; source: string | null } => !!p),
    });
  } catch (e) {
    console.error('compr photo payload', (e as Error).message);
    return none;
  }
}

/**
 * The deal's numbers and offer band, read before a COMPR write so a low or
 * high a person typed is kept (migration 184). Before that migration has run
 * the band columns are not there, and the read falls back to the rest.
 */
async function dealBandRow(admin: Admin, dealId: number): Promise<Record<string, unknown> | null> {
  const base = 'id, stage, arv, rehab, mao, wholesale_offer, institutional_offer, underwriting_url, compr_report_url, hero_image_url';
  const first = await admin.from('deals').select(base + ', offer_low_set_at, offer_high_set_at').eq('id', dealId).maybeSingle();
  if (!first.error) return first.data as Record<string, unknown> | null;
  const again = await admin.from('deals').select(base).eq('id', dealId).maybeSingle();
  return again.data as Record<string, unknown> | null;
}
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Public buyer-facing COMPR assets on the deal: buyer report link, photo-set
 * URLs (email-safe), hero, and a CMA PDF. No run, nothing billed.
 */
async function writeMarketingAssets(
  admin: Admin, key: string, workspaceId: number, deal: MarketingDeal, opts: { cma?: boolean } = {},
): Promise<{ buyer_report_url: string | null; photo_url: string | null; photos: string[]; cma_url: string | null }> {
  const empty = { buyer_report_url: null, photo_url: null, photos: [] as string[], cma_url: null };
  const leads = comprLeadIds(deal);
  if (!leads.length) return empty;

  // A report link can be an address slug rather than the lead id; the hero we
  // already saved names the real lead. Use the first lead COMPR has photos for.
  let leadId = leads[0];
  let result: unknown = null;
  for (const id of leads) {
    const rr = await fetch(`${COMPR_ORIGIN}/api/underwrite-result?lead_id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    const r = rr?.ok ? await rr.json().catch(() => null) : null;
    if (!r) continue;
    if (!result) { leadId = id; result = r; }
    if (Array.isArray((r as { photos?: unknown }).photos) && (r as { photos: unknown[] }).photos.length) { leadId = id; result = r; break; }
  }

  let buyerUrl: string | null = null;
  let buyerToken: string | null = null;
  let photoToken: string | null = null;
  try {
    const buyer = await shareLinkMeta(key, leadId, 'buyer');
    buyerUrl = buyer.url;
    buyerToken = buyer.token;
  } catch (e) { console.error('compr buyer share', (e as Error).message); }
  try {
    const seller = await shareLinkMeta(key, leadId, 'seller');
    photoToken = seller.token;
  } catch (e) { console.error('compr seller share', (e as Error).message); }

  const photos = Array.isArray((result as { photos?: unknown } | null)?.photos)
    ? (result as { photos: { storage_url?: string | null; position?: number | null }[] }).photos
    : [];
  const front = ((result as { vision?: { raw_response?: { photo_coverage?: { front_photo_index?: number | null } } }[] } | null)?.vision ?? [])
    .map((v) => v?.raw_response?.photo_coverage?.front_photo_index)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < photos.length)
    .pop();
  // A front someone already picked (or COMPR picked on an earlier pull) stays
  // the front; vision's curb shot only decides the first time.
  const { data: prevCover } = await admin.from('deal_files').select('position')
    .eq('deal_id', deal.id).eq('source', 'compr').eq('kind', 'photo').eq('is_cover', true).limit(1).maybeSingle();
  // A front the team picked from its own photos (an upload, a Drive shot) is
  // theirs: COMPR's set comes in behind it and leaves the cover and hero alone.
  // Uploads carry no url and some rows no source, so the test runs here, not in SQL.
  const { data: covers } = await admin.from('deal_files').select('source, url')
    .eq('deal_id', deal.id).eq('kind', 'photo').eq('is_cover', true);
  const keepOwnCover = ((covers ?? []) as { source: string | null; url: string | null }[])
    .some((c) => c.source !== 'compr' && !/thecompr\.com\/api\/photo/i.test(c.url ?? ''));
  const heroPos = heroPosition(deal.hero_image_url, leadId);
  const keepPos = (prevCover as { position?: number | null } | null)?.position ?? heroPos;
  const keptIdx = keepPos == null ? -1 : photos.findIndex((p, i) => (p?.position ?? i) === keepPos);
  const heroIdx = keptIdx >= 0 ? keptIdx : front ?? 0;

  const photoUrls: { url: string; pos: number; cover: boolean }[] = [];
  if (photoToken) {
    photos.forEach((p, i) => {
      const raw = p?.storage_url ?? '';
      if (!raw || raw.startsWith('inline-base64') || STREET_VIEW_URL.test(raw)) return;
      const pos = p?.position ?? i;
      photoUrls.push({ url: photoProxyUrl(leadId, pos, photoToken!), pos, cover: !keepOwnCover && i === heroIdx });
    });
  }
  // A refresh rotates token=. One shot is one row, even if an older token
  // was stored under a different source.
  const uniquePhotos = dedupeByPhotoKey(photoUrls);
  const photoUrl = uniquePhotos.find((p) => p.cover)?.url ?? uniquePhotos[0]?.url ?? null;

  // Pointers only: each row is COMPR's photo proxy, not a copy of the file.
  // Replacing the compr rows keeps this deal 1:1 with COMPR's photo set.
  await admin.from('deal_files').delete().eq('deal_id', deal.id).eq('source', 'compr').eq('kind', 'photo');
  const { data: stray } = await admin.from('deal_files').select('id, url').eq('deal_id', deal.id).eq('kind', 'photo').ilike('url', '%underwriting.example.com/api/photo%');
  const strayIds = ((stray ?? []) as { id: number; url: string | null }[]).map((r) => r.id);
  if (strayIds.length) await admin.from('deal_files').delete().in('id', strayIds);
  // A photo this deal already holds under that exact link (added by hand,
  // or by another source) stays as it is: deal_files is unique on
  // (deal_id, url), so inserting it again failed the whole set.
  const { data: held } = uniquePhotos.length
    ? await admin.from('deal_files').select('url').eq('deal_id', deal.id).in('url', uniquePhotos.map((p) => p.url))
    : { data: [] };
  const heldUrls = new Set(((held ?? []) as { url: string | null }[]).map((r) => r.url));
  const newPhotos = uniquePhotos.filter((p) => !heldUrls.has(p.url));
  if (newPhotos.length) {
    const { error } = await admin.from('deal_files').insert(newPhotos.map((p, i) => ({
      workspace_id: workspaceId, deal_id: deal.id, kind: 'photo', name: `COMPR photo ${i + 1}`,
      url: p.url, source: 'compr', visible_to_buyers: true, is_cover: p.cover, position: p.pos,
    })));
    if (error) console.error('compr photos', error.message);
  }

  let cmaUrl: string | null = null;
  if (opts.cma !== false) try {
    const prop = deal.property_id
      ? (await admin.from('properties').select('line1, city, state, zip, beds, baths, sqft, year_built').eq('id', deal.property_id).maybeSingle()).data
      : null;
    const model = cmaFromCompr(result, {
      address: prop?.line1 ?? '',
      cityLine: [prop?.city, [prop?.state, prop?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      asking: deal.marketed_price ?? deal.asking_price ?? deal.offer_amount ?? null,
      arv: deal.arv ?? null, rehab: deal.rehab ?? null, mao: deal.mao ?? null,
      beds: prop?.beds ?? null, baths: prop?.baths ?? null, sqft: prop?.sqft ?? null, yearBuilt: prop?.year_built ?? null,
      reportUrl: buyerUrl,
    });
    const bytes = await comprCmaPdfFile(key, leadId, buyerToken) ?? await cmaPdfBytes(model, 'Acme Homes');
    const path = `ws/${workspaceId}/deals/${deal.id}/cma.pdf`;
    const up = await admin.storage.from('deal-public').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) console.error('cma pdf', up.error.message);
    else {
      const pub = admin.storage.from('deal-public').getPublicUrl(path);
      cmaUrl = pub.data.publicUrl || null;
    }
  } catch (e) { console.error('cma pdf', (e as Error).message); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (buyerUrl) {
    patch.buyer_report_url = buyerUrl;
    if (!deal.marketing_url) patch.marketing_url = buyerUrl;
  }
  if (photoUrl && !keepOwnCover) patch.hero_image_url = photoUrl;
  if (cmaUrl) patch.compr_cma_url = cmaUrl;
  if (Object.keys(patch).length > 1) {
    const { error } = await admin.from('deals').update(patch).eq('id', deal.id);
    if (error) console.error('marketing assets', error.message);
  }

  return { buyer_report_url: buyerUrl, photo_url: photoUrl, photos: uniquePhotos.map((p) => p.url), cma_url: cmaUrl };
}

function comprKey(): { key: string } | { missing: string } {
  for (const n of KEY_NAMES) {
    const v = Deno.env.get(n);
    if (v) return { key: v };
  }
  // Names only, never values: this tells an admin which secret they set.
  const seen = Object.keys(Deno.env.toObject()).filter((n) => /compr/i.test(n));
  return {
    missing: 'COMPR is not connected: set the COMPR_API_KEY secret on the Supabase project.'
      + (seen.length ? ` (Found a secret named ${seen.join(', ')} — rename it to COMPR_API_KEY.)` : ''),
  };
}

Deno.serve(async (req) => {
  // When this request started: the COMPR call gets what is left of the gateway's budget (GATEWAY_BUDGET_MS).
  const startedAt = Date.now();
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  // The ingest function queues a run for a deal it just created, as the service
  // role: no user, so no owner, no auto-offer, and a per-workspace hourly cap.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  // Exactly the env key or the cron's vault key (they can be different issues);
  // a decoded role claim alone is never enough.
  const internal = await isServiceCaller(createClient(url, serviceKey, { auth: { persistSession: false } }), bearerOf(req));
  const { data: who } = internal ? { data: null } : await asCaller.auth.getUser();
  if (!internal && !who?.user) return json({ error: 'sign in first' }, 401);
  const userId: string | null = who?.user?.id ?? null;

  let body: { workspace_id?: number; seller_id?: number; deal_id?: number; action?: string; audience?: string; limit?: number; pull_only?: boolean; keep_numbers?: boolean; check?: boolean; refresh_lead?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);

  // Most actions read or write a deal with the service role, so a person must
  // belong to the workspace they name before anything else runs.
  if (!internal && body.action !== 'suggest') {
    if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
    if (!(await memberRole(asCaller, workspaceId, userId!))) return json({ error: 'not a member of that workspace' }, 403);
  }

  if (body.action === 'suggest') {
    // Address lookups are billed upstream: a per-person ceiling first.
    if (!internal) {
      const rl = await rateLimit(createClient(url, serviceKey, { auth: { persistSession: false } }), `compr-suggest:${userId}`, 600, 3600);
      if (!rl.allowed) return tooMany(CORS, rl);
    }
    const k = comprKey();
    if ('missing' in k) return json({ error: k.missing }, 503);
    const b = body as unknown as { q?: string; place_id?: string; src?: string };
    const qs = b.place_id
      ? `place_id=${encodeURIComponent(String(b.place_id).slice(0, 300))}&src=${b.src === 'new' ? 'new' : 'legacy'}`
      : `q=${encodeURIComponent(String(b.q ?? '').slice(0, 160))}`;
    try {
      const r = await fetch(`${COMPR_ORIGIN}/api/address-suggest?${qs}`, { headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(9_000) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) return json({ ok: false, items: [] });
      if (b.place_id) {
        if (j.error || !j.street) return json({ ok: false });
        return json({ ok: true, place: { addr: j.street, city: j.city ?? '', st: j.state ?? '', zip: j.zip ?? '', lat: j.lat ?? null, lng: j.lng ?? null } });
      }
      return json({ ok: true, items: j.provider === 'google' && Array.isArray(j.items) ? j.items : [] });
    } catch (e) {
      console.error('address suggest', (e as Error).message);
      return json({ ok: false, items: [] });
    }
  }

  // Outcome: what a finished deal really did, back to Compr (sendOutcome).
  // `auto` is the database trigger on a stage move.
  if (body.action === 'outcome') {
    const dealId = Number(body.deal_id);
    const auto = (body as { auto?: unknown }).auto === true && internal;
    if (!Number.isFinite(workspaceId) || !Number.isFinite(dealId)) return json({ error: 'workspace_id and deal_id are required' }, 422);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: seen } = await (internal ? admin : asCaller).from('deals').select('id').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
    if (!seen) return json({ error: 'deal not found' }, 404);
    const r = await sendOutcome(admin, workspaceId, dealId, auto ? 'auto' : 'manual', userId);
    if ('error' in r) return json({ error: r.error, stages: r.stages ?? [] }, r.status);
    return json(r);
  }

  // Weekly sync (migration 202): every Closed and Terminated deal's numbers to
  // Compr, not only the ones that changed stage after migration 143 (2 of 48
  // closes had reached it). A deal goes again only when what it would send
  // changed. Then the team's data flaws go to Compr's weekly cross-reference
  // and its answer is kept in compr_sync_reports.
  if (body.action === 'outcome_sweep') {
    if (!internal) return json({ error: 'service only' }, 403);
    if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const run = outcomeSweep(admin, workspaceId);
    const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (edge?.waitUntil) { edge.waitUntil(run); return json({ ok: true, started: true }); }
    return json(await run);
  }

  // Photo set + front photo from reports COMPR already has: nothing billed.
  // deal_photos is one deal the caller can see; sync_photos is the nightly
  // service-role pass over every deal linked to a COMPR report.
  if (body.action === 'deal_photos' || body.action === 'sync_photos') {
    if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
    const k = comprKey();
    if ('missing' in k) return json({ error: k.missing }, 503);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const cols = 'id, underwriting_url, compr_report_url, marketing_url, hero_image_url, asking_price, marketed_price, offer_amount, arv, rehab, mao, property_id';
    if (body.action === 'deal_photos') {
      const dealId = Number(body.deal_id);
      if (!Number.isFinite(dealId)) return json({ error: 'deal_id is required' }, 422);
      const { data: seen } = await (internal ? admin : asCaller).from('deals').select('id').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
      if (!seen) return json({ error: 'deal not found' }, 404);
      const { data: d } = await admin.from('deals').select(cols).eq('id', dealId).maybeSingle();
      if (!d || !comprLeadIds(d as MarketingDeal).length) return json({ ok: true, photos: [], hero_url: null, linked: false });
      const out = await writeMarketingAssets(admin, k.key, workspaceId, d as MarketingDeal, { cma: false });
      await admin.from('deals').update({ compr_photos_synced_at: new Date().toISOString() }).eq('id', dealId);
      return json({ ok: true, linked: true, hero_url: out.photo_url, photos: out.photos });
    }
    if (!internal) return json({ error: 'service only' }, 403);
    // Never-synced deals first, then any not refreshed in a week, so repeated
    // runs walk the whole list instead of re-reading the newest 60.
    const limit = Math.max(1, Math.min(60, Number(body.limit) || 40));
    const stale = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: rows } = await admin.from('deals').select(cols).eq('workspace_id', workspaceId)
      .or('underwriting_url.ilike.%underwriting.example.com/r/%,underwriting_url.ilike.%underwriting.example.com/r/%,compr_report_url.ilike.%underwriting.example.com/r/%,compr_report_url.ilike.%underwriting.example.com/r/%,hero_image_url.ilike.%underwriting.example.com/api/photo%')
      .or(`compr_photos_synced_at.is.null,compr_photos_synced_at.lt.${stale}`)
      .order('compr_photos_synced_at', { ascending: true, nullsFirst: true })
      .order('updated_at', { ascending: false }).limit(limit);
    let synced = 0; let photos = 0; const failed: number[] = [];
    for (const d of (rows ?? []) as MarketingDeal[]) {
      try {
        const out = await writeMarketingAssets(admin, k.key, workspaceId, d, { cma: false });
        if (out.photos.length) { synced++; photos += out.photos.length; }
      } catch (e) { failed.push(d.id); console.error('compr photo sync', d.id, (e as Error).message); }
      await admin.from('deals').update({ compr_photos_synced_at: new Date().toISOString() }).eq('id', d.id);
    }
    console.log('compr photo sync', { workspaceId, deals: rows?.length ?? 0, synced, photos, failed: failed.length });
    return json({ ok: true, deals: rows?.length ?? 0, synced, photos, failed });
  }

  // The underwrite sweep (pg_cron every two minutes, migration 184). Every
  // New Submission / Underwriting house with no COMPR report goes to COMPR
  // with its photos, so a rep opens a finished report instead of a search
  // box; and a house elsewhere in the pipeline with a photo link and an empty
  // album (Mark Spain's GoMedia page is drawn behind their portal, and COMPR
  // holds that login) gets COMPR's set. Each deal goes through round_trip (an
  // underwrite with every photo, then COMPR's set written back).
  //
  // One house at a time: COMPR's engine runs two at once and turns the rest
  // away as "engine busy" after a 90 second wait, and fifteen sent together
  // came back 13 busy of 15, every hour. The next house starts only when the
  // one before answered fast (an address COMPR cannot read, a report it
  // already had), so a sweep inside the edge wall clock is one real run and
  // is done before the next tick. A busy or slow answer is not
  // the house's fault: it goes back in line for the next ticks, up to three
  // times a day, instead of waiting until tomorrow. Service only; every one
  // is a COMPR run.
  if (body.action === 'photo_sweep') {
    if (!internal) return json({ error: 'service only' }, 403);
    if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const limit = Math.max(1, Math.min(5, Number(body.limit) || 3));
    // The pick is SQL (migration 176, 184): "no photos at all" is a NOT EXISTS the REST filters cannot say.
    const { data: cands, error: candErr } = await admin.rpc('compr_photo_sweep_candidates', { p_workspace_id: workspaceId, p_limit: limit });
    if (candErr) return json({ error: candErr.message }, 500);
    const batch = ((cands ?? []) as { deal_id: number; seller_id: number }[]).map((r) => ({ id: Number(r.deal_id), seller_id: Number(r.seller_id) }));
    if (!batch.length) return json({ ok: true, sent: 0 });
    const started = Date.now();
    const run = (async () => {
      for (const r of batch) {
        if (Date.now() - started > 10_000) break;
        const { data: prior } = await admin.from('deals').select('compr_sweep_tries').eq('id', r.id).maybeSingle();
        const tries = Number((prior as { compr_sweep_tries?: number } | null)?.compr_sweep_tries ?? 0) || 0;
        await markSweep(admin, r.id, { compr_photos_synced_at: new Date().toISOString(), compr_sweep_tries: tries });
        let status = 0;
        let text = '';
        try {
          const res = await fetch(`${url}/functions/v1/compr-underwrite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
            // keep_numbers: an underwriter's MAO and analysis sheet stay put.
            body: JSON.stringify({ workspace_id: workspaceId, seller_id: r.seller_id, deal_id: r.id, action: 'round_trip', keep_numbers: true }),
          });
          status = res.status;
          text = res.ok ? '' : (await res.text()).slice(0, 200);
        } catch (e) { text = (e as Error).message; }
        const now = new Date().toISOString();
        if (status >= 200 && status < 300) {
          if (tries) await markSweep(admin, r.id, { compr_photos_synced_at: now, compr_sweep_tries: 0 });
          continue;
        }
        console.error('compr sweep', { deal: r.id, status, body: text });
        // Back in line in about five minutes (the pick waits a day after a
        // try), at most three tries a day; anything else waits until tomorrow.
        const again = SWEEP_TRANSIENT.has(status) && tries < 2;
        await markSweep(admin, r.id, {
          compr_photos_synced_at: again ? new Date(Date.now() - 86_400_000 + 5 * 60_000).toISOString() : now,
          compr_sweep_tries: again ? tries + 1 : 0,
        });
      }
    })();
    const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (edge?.waitUntil) edge.waitUntil(run); else await run;
    console.log('compr sweep', { workspaceId, picked: batch.length });
    return json({ ok: true, sent: batch.length, deals: batch.map((r) => r.id) });
  }

  // Pull: the numbers the deal's COMPR report shows now, onto the deal. An AM
  // moved the ARV, the rehab, the fee or a comp in COMPR (in the window CLOZR
  // opened, or in COMPR on its own) and COMPR saved it; CLOZR asks when the
  // rep comes back to the record. No run, nothing billed. The low and high
  // follow the offer unless a person set them. `check` writes nothing: a
  // record past underwriting only learns whether its report is missing the
  // photos CLOZR holds (photos_missing), so the rep can re-run it with them.
  if (body.action === 'pull') {
    const pullDeal = Number(body.deal_id);
    if (!Number.isFinite(workspaceId) || !Number.isFinite(pullDeal)) return json({ error: 'workspace_id and deal_id are required' }, 422);
    const k = comprKey();
    if ('missing' in k) return json({ error: k.missing }, 503);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: seen } = await (internal ? admin : asCaller).from('deals').select('id').eq('id', pullDeal).eq('workspace_id', workspaceId).maybeSingle();
    if (!seen) return json({ error: 'deal not found' }, 404);
    const cur = await dealBandRow(admin, pullDeal);
    const leads = cur ? comprLeadIds(cur as { underwriting_url?: string | null; compr_report_url?: string | null; hero_image_url?: string | null }) : [];
    if (!cur || !leads.length) return json({ ok: true, changed: false, linked: false });
    let nums: ReturnType<typeof comprNumbersOf> = null;
    let pics: ReturnType<typeof comprPhotosOf> = null;
    for (const id of leads) {
      const rr = await fetch(`${COMPR_ORIGIN}/api/underwrite-result?lead_id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(9_000),
      }).catch(() => null);
      const report = rr?.ok ? await rr.json().catch(() => null) : null;
      nums = comprNumbersOf(report);
      if (nums) { pics = comprPhotosOf(report); break; }
    }
    if (!nums) return json({ ok: true, changed: false, linked: true });
    // The photos CLOZR would send (comprPhotoPayload): every photo row that is
    // not COMPR's own, up to the cap.
    const { count: ownCount } = await admin.from('deal_files').select('id', { count: 'exact', head: true })
      .eq('deal_id', pullDeal).eq('kind', 'photo').or('url.is.null,url.not.ilike.*thecompr.*');
    const own = Number(ownCount ?? 0) || 0;
    const photos = {
      own_photos: own, report_photos: pics?.album ?? null, report_provenance: pics?.provenance ?? null,
      photos_missing: comprPhotoGap(own, pics, COMPR_PHOTO_CAP),
    };
    if (body.check) return json({ ok: true, changed: false, linked: true, lead_id: nums.leadId, ...photos });
    const band = offerBand({ ...bandOfRow(cur as Parameters<typeof bandOfRow>[0]), mao: nums.mao ?? Number(cur.mao ?? NaN) });
    const has = (v: unknown) => v != null && v !== '';
    const differs = (a: unknown, b: number | null) => b != null && (!has(a) || Number(a) !== b);
    const patch: Record<string, unknown> = {
      ...(differs(cur.arv, nums.arv) ? { arv: nums.arv } : {}),
      ...(differs(cur.rehab, nums.rehab) ? { rehab: nums.rehab } : {}),
      ...(differs(cur.mao, nums.mao) ? { mao: nums.mao } : {}),
      ...(differs(cur.wholesale_offer, band.low) ? { wholesale_offer: band.low } : {}),
      ...(differs(cur.institutional_offer, band.high) ? { institutional_offer: band.high } : {}),
    };
    const changed = Object.keys(patch).length > 0;
    if (changed) {
      const { error } = await admin.from('deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', pullDeal);
      if (error) return json({ error: error.message }, 500);
      const money = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));
      await admin.from('activity').insert({
        workspace_id: workspaceId, entity_type: 'deal', entity_id: pullDeal, kind: 'compr',
        title: `COMPR: ARV ${money(nums.arv)} · rehab ${money(nums.rehab)} · MAO ${money(nums.mao)}${nums.condition ? ` · ${nums.condition}` : ''}`,
        body: [
          'Saved in COMPR; brought onto the deal.',
          `Low ${money(band.low)}, high ${money(band.high)}${band.lowSet || band.highSet ? ' (set by hand, kept)' : ''}.`,
          nums.leadId ? `Lead id ${nums.leadId}.` : null,
        ].filter(Boolean).join('\n'),
        actor_id: userId,
      });
    }
    return json({
      ok: true, changed, linked: true, lead_id: nums.leadId, arv: nums.arv, rehab: nums.rehab, mao: nums.mao,
      low: band.low, high: band.high, low_set: band.lowSet, high_set: band.highSet, ...photos,
    });
  }

  if (body.action === 'round_trip') {
    if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
    const tripDeal = Number(body.deal_id);
    if (!Number.isFinite(tripDeal)) return json({ error: 'deal_id is required' }, 422);
    const k = comprKey();
    if ('missing' in k) return json({ error: k.missing }, 503);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const cols = 'id, underwriting_url, compr_report_url, marketing_url, hero_image_url, asking_price, marketed_price, offer_amount, arv, rehab, mao, property_id';
    const { data: d } = await admin.from('deals').select(cols).eq('id', tripDeal).eq('workspace_id', workspaceId).maybeSingle();
    const row = d as (MarketingDeal & { compr_report_url?: string | null }) | null;
    const linked = row ? { ...row, underwriting_url: row.underwriting_url || row.compr_report_url || null } : null;
    if (linked && comprLeadIds(linked).length) {
      const out = await writeMarketingAssets(admin, k.key, workspaceId, linked, { cma: false });
      await admin.from('deals').update({ compr_photos_synced_at: new Date().toISOString() }).eq('id', tripDeal);
      return json({ ok: true, pulled: true, linked: true, hero_url: out.photo_url, photos: out.photos });
    }
    // A pull asked for because the deal has a report link: never a billed run.
    if (body.pull_only) return json({ ok: true, pulled: false, linked: false });
  }

  const sellerId = Number(body.seller_id);
  if (!Number.isFinite(workspaceId) || !Number.isFinite(sellerId)) return json({ error: 'workspace_id and seller_id are required' }, 422);
  const share = body.action === 'share';
  const audience = body.audience === 'buyer' ? 'buyer' : 'seller';

  const k = comprKey();
  if ('missing' in k) return json({ error: k.missing }, 503);

  // Every run is billable at COMPR: an hourly ceiling per user, and one for
  // the service's own runs per workspace (the sweep sends about one every
  // two minutes, and Podio round trips ride the same one). Fetching the
  // hero photo bills nothing, so it does not spend the ceiling.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const hero = body.action === 'hero';
  const assets = body.action === 'assets';
  if (!hero && !assets) {
    const rl = await rateLimit(admin, internal ? `compr-underwrite:ingest:${workspaceId}` : `compr-underwrite:${userId}`, internal ? 80 : 40, 3600);
    if (!rl.allowed) return tooMany(CORS, rl);
  }
  const reader = internal ? admin : asCaller;

  // The seller is read as the caller: RLS decides whether they may see it.
  const { data: seller } = await reader.from('sellers')
    .select('id, name, property_id, property_address, properties(line1, city, state, zip)')
    .eq('id', sellerId).eq('workspace_id', workspaceId).maybeSingle();
  if (!seller) return json({ error: 'seller not found' }, 404);

  // A partner contact carries many deals: deal_id names which property to underwrite and which deal gets the numbers.
  const dealId = body.deal_id === undefined || body.deal_id === null ? null : Number(body.deal_id);
  let dealProp: { line1: string; city: string | null; state: string | null; zip: string | null } | null = null;
  let dealPropertyId: number | null = null;
  if (dealId !== null) {
    const { data: d } = Number.isFinite(dealId)
      ? await reader.from('deals').select('id, property_id, properties(line1, city, state, zip)')
        .eq('id', dealId).eq('workspace_id', workspaceId).eq('seller_id', sellerId).maybeSingle()
      : { data: null };
    if (!d) return json({ error: 'deal not found' }, 404);
    dealProp = (d as unknown as { properties: typeof dealProp }).properties;
    dealPropertyId = (d as { property_id: number | null }).property_id;
  }

  // Hero / assets: photos and share links behind the deal's saved report, no run.
  if (hero || assets) {
    const { data: d } = dealId !== null
      ? await admin.from('deals').select('id, underwriting_url, compr_report_url, marketing_url, hero_image_url, asking_price, marketed_price, offer_amount, arv, rehab, mao, property_id').eq('id', dealId).maybeSingle()
      : await admin.from('deals').select('id, underwriting_url, compr_report_url, marketing_url, hero_image_url, asking_price, marketed_price, offer_amount, arv, rehab, mao, property_id').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
        .not('underwriting_url', 'is', null).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!d) return json({ ok: true, hero_url: null, buyer_report_url: null, photos: [], cma_url: null });
    const out = await writeMarketingAssets(admin, k.key, workspaceId, d as MarketingDeal);
    return json({ ok: true, hero_url: out.photo_url, ...out });
  }

  // Share a report that already exists: no run, nothing billed.
  if (share) {
    const { data: d } = await admin.from('deals').select('underwriting_url').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
      .not('underwriting_url', 'is', null).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const saved = comprLeadIdInUrl(String(d?.underwriting_url ?? ''));
    if (saved) {
      try { return json({ ok: true, audience, url: await shareLink(k.key, saved, audience) }); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }
  }
  const prop = dealId !== null ? dealProp : (seller as unknown as { properties: { line1: string; city: string | null; state: string | null; zip: string | null } | null }).properties;
  if (!prop?.line1 || !prop.city || !prop.state || !prop.zip) {
    return json({ error: 'COMPR needs a full address — street, city, state and ZIP. Set it on the record first.' }, 422);
  }
  // "Durham, NC 27701" as the street: COMPR geocoded the city and priced
  // whatever house sat there (nine records on 2026-10-09). No house number,
  // no run.
  if (!/^\s*\d/.test(prop.line1)) {
    return json({ error: `COMPR needs a house number in the street (“${prop.line1}”). Fix the address on the record first.` }, 422);
  }

  // One lead id per property per day: a retry after a slow run replays the
  // finished report instead of spending another one; tomorrow is a fresh run.
  const leadId = `clozr-w${workspaceId}-${dealId !== null ? `d${dealId}` : `s${sellerId}`}-${new Date().toISOString().slice(0, 10)}`;
  // The photos CLOZR has go as photo_urls (graded as they are), the links it
  // has not read as photo_sources (COMPR resolves those). The house facts
  // already on the record go as subject. The graded set comes back through
  // writeMarketingAssets.
  const sent = await dealPhotoPayload(admin, workspaceId, dealId ?? null, sellerId, seller.property_id);
  const houseId = dealId !== null ? dealPropertyId : seller.property_id;
  let subject: Record<string, number | string> = {};
  // What the submitter gave, at the top of the body where COMPR reads it.
  // A field COMPR filled on an earlier run is left off so COMPR looks it up
  // again. Before migration 201 there is no compr_filled column: every value
  // on the record is then treated as the submitter's.
  let submitted: Record<string, number> = {};
  if (houseId) {
    const cols = 'beds, baths, sqft, year_built, lot_sqft, property_type';
    let read = await admin.from('properties').select(`${cols}, compr_filled`).eq('id', houseId).maybeSingle();
    if (read.error) read = await admin.from('properties').select(cols).eq('id', houseId).maybeSingle();
    const house = read.data as {
      beds: number | null; baths: number | null; sqft: number | null; year_built: number | null;
      lot_sqft: number | null; property_type: string | null; compr_filled?: string[] | null;
    } | null;
    if (house) {
      subject = comprSubject(house);
      submitted = comprFacts(house, house.compr_filled ?? []);
    }
  }
  if (dealId !== null) {
    const { data: money } = await admin.from('deals')
      .select('asking_price, arv, rehab, occupancy_notes, condition_notes')
      .eq('id', dealId).maybeSingle();
    if (money) subject = {
      ...subject,
      ...comprSubject({
        asking_price: money.asking_price, arv: money.arv, rehab: money.rehab,
        occupancy: money.occupancy_notes, condition: money.condition_notes,
      }),
    };
  }
  // refresh_lead: re-run the deal's own report in place, same /r/ link, with
  // every photo CLOZR has (the record offers it when the report was graded
  // without them; pull's photos_missing). Only a lead the deal links to, and
  // only one COMPR shows this key, so a run never lands on another org's lead.
  let runLead = leadId;
  let refresh = false;
  const askLead = typeof body.refresh_lead === 'string' ? body.refresh_lead.trim() : '';
  if (askLead && dealId !== null) {
    const linked = await dealBandRow(admin, dealId);
    if (linked && comprLeadIds(linked as { underwriting_url?: string | null; compr_report_url?: string | null; hero_image_url?: string | null }).includes(askLead)) {
      const known = await fetch(`${COMPR_ORIGIN}/api/underwrite-result?lead_id=${encodeURIComponent(askLead)}`, {
        headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(9_000),
      }).catch(() => null);
      if (known?.ok) { runLead = askLead; refresh = true; }
    }
    if (!refresh) return json({ error: 'That COMPR report is not one this deal links to, or COMPR does not show it to this workspace.' }, 409);
  }
  const payload = {
    address: { street: prop.line1, city: prop.city, state: prop.state, zip: prop.zip }, lead_id: runLead,
    ...(refresh ? { force_refresh: true } : {}),
    // Ingest, sweep and imports run as the service role with nobody watching:
    // COMPR skips its ATTOM premium calls (foreclosure, liens, sale history) for those.
    ...(internal ? { bulk: true } : {}),
    ...(sent.photo_sources.length ? { photo_sources: sent.photo_sources } : {}),
    ...(sent.photo_urls.length ? { photo_urls: sent.photo_urls } : {}),
    ...(Object.keys(subject).length ? { subject } : {}),
    ...submitted,
  };

  let reply: unknown;
  let text = '';
  try {
    const res = await fetch(COMPR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(CALL_CAP_MS, GATEWAY_BUDGET_MS - (Date.now() - startedAt)))),
    });
    text = await res.text();
    if (!res.ok) {
      // Upstream bodies go to the log, not to the browser.
      console.error('compr upstream', { status: res.status, body: text.slice(0, 500) });
      if (res.status === 401) return json({ error: 'COMPR rejected the key. Check COMPR_API_KEY on the Supabase project.' }, 503);
      if (res.status === 403) return json({ error: 'COMPR refused the run: the plan or key is not eligible for API access.' }, 502);
      if (res.status === 422) return json({ error: 'COMPR could not resolve that address. Check the street, city, state and ZIP.' }, 422);
      // COMPR's engine takes two runs at a time and answers engine_busy past
      // that: nothing ran and nothing was billed. Only its quota is a 429 here.
      if (res.status === 429 && /engine_busy/.test(text)) {
        return json({ error: 'COMPR is busy with other runs. Nothing was billed; try again in about 30 seconds.', busy: true }, 503);
      }
      if (res.status === 429) return json({ error: 'COMPR quota is used up for the month.' }, 429);
      return json({ error: `COMPR answered ${res.status}.` }, 502);
    }
    reply = text ? JSON.parse(text) : {};
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') {
      return json({ error: 'COMPR is still running this one. Try again in a minute; the finished report will come straight back.' }, 504);
    }
    return serverError(CORS, 'compr-underwrite fetch', e, 504);
  }

  // Documented paths first, then the flat shape COMPR's own report uses.
  const arv = pickNumber(reply, ['arv.weighted', 'underwrite.arv_weighted', 'arv_weighted', 'arv']);
  const rehab = pickNumber(reply, ['rehab.for_flip', 'underwrite.rehab_for_flip', 'rehab_for_flip', 'rehab']);
  const presented = pickNumber(reply, ['mao.presented_offer', 'underwrite.presented_offer', 'presented_offer']);
  let wholesale = pickNumber(reply, ['mao.wholesale', 'underwrite.mao_wholesale', 'mao_wholesale']);
  let institutional = pickNumber(reply, ['mao.institutional', 'underwrite.mao_institutional', 'mao_institutional']);
  // Presented offer is the COMPR offer (MAO): the high, with the low $20k under
  // it (_shared/offer-band.ts). COMPR's wholesale and institutional exits are
  // only reported, and sometimes come back swapped.
  // MAO <= 0 is COMPR saying "no deal at any price", not an offer: no number, so no band and never an auto-offer letter.
  const positive = (n: number | null) => (n != null && n > 0 ? n : null);
  const mao = positive(presented) ?? positive(wholesale) ?? positive(pickNumber(reply, ['mao']));
  if (wholesale != null && institutional != null && wholesale > institutional) {
    const t = wholesale; wholesale = institutional; institutional = t;
  }
  const status = pickString(reply, ['status']) ?? 'complete';
  const confidence = pickNumber(reply, ['confidence.score_pct']) ?? (() => {
    const raw = ['confidence.score', 'underwrite.confidence_score', 'confidence_score']
      .map((p) => pickNumberRaw(reply, p)).find((n) => n !== null);
    return raw === null || raw === undefined ? null : Math.round(raw * 100);
  })();
  // A reply with no link (seen on red-flagged and slow runs) still ran under
  // the lead id we sent, and /r/<lead id> is that report. Without the link the
  // deal looked un-run, and the sweep ran it again the next day under a new
  // id: 112 houses on 2026-10-09.
  const reportUrl = pickString(reply, ['comp_report_url', 'report_url', 'url']) ?? (runLead ? `${COMPR_ORIGIN}/r/${encodeURIComponent(runLead)}` : null);
  const redFlags = ((reply as { red_flags?: unknown }).red_flags ?? []) as { category?: string; severity?: string; description?: string }[];

  // Write onto the seller's deal, creating one if there is none yet. With
  // several deals, the one on the seller's property (latest first); several
  // and none on it, no deal is written rather than one picked at random.
  const { data: existing } = dealId !== null
    ? { data: [] }
    : await admin.from('deals').select('id, property_id').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
      .order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(50);
  const sellerDeals = ((existing ?? []) as { id: number; property_id: number | null }[])
    .map((d) => ({ id: Number(d.id), property_id: d.property_id == null ? null : Number(d.property_id) }));
  const picked = dealId !== null ? { id: dealId, ambiguous: false } : pickSellerDeal(sellerDeals, seller.property_id);
  const dealSkipped = picked.ambiguous
    ? `Not saved to a deal. This seller has ${sellerDeals.length} deals and none is on their property, so run COMPR from the deal to save the numbers there.`
    : null;
  let dealRowId: number | null = picked.id;
  const cur = dealRowId !== null ? await dealBandRow(admin, dealRowId) : null;
  // A photo sweep run (keep_numbers) never replaces an underwriter's work: a
  // deal that already has a MAO keeps its numbers (COMPR only fills blanks).
  // A submission with no MAO yet takes COMPR's whole set, so the record never
  // shows the submitter's ARV beside COMPR's offer.
  // A Closed or Terminated deal keeps what the team underwrote at the time:
  // that is the team's half of the weekly cross-reference, and a run after
  // the close (its comps include the sale itself) wrote $0 over 4037 N Elgin's
  // MAO on 2026-10-09. The run still fills blanks and stays in activity.
  const finished = dealId !== null && (cur?.stage === 'Closed' || cur?.stage === 'Terminated');
  const keep = finished || (!!body.keep_numbers && dealId !== null && cur?.mao != null);
  const fresh: Record<string, number | null> = { arv, rehab, mao };
  const numbers: Record<string, number | null> = keep
    ? Object.fromEntries(Object.entries(fresh).filter(([k, v]) => cur?.[k] == null && v != null))
    : fresh;
  // The low and high follow COMPR's offer unless a person set them (migration 184).
  const band = offerBand({ ...bandOfRow(cur as Parameters<typeof bandOfRow>[0]), mao: keep && cur?.mao != null ? Number(cur.mao) : mao });
  const patch: Record<string, unknown> = {
    ...numbers,
    ...offerBandColumns(band),
    updated_at: new Date().toISOString(),
  };
  // The report link doubles as the record's tie to COMPR: Open in COMPR goes
  // to `/r/<lead id>` straight from it. A sweep run keeps an analysis sheet in
  // underwriting_url and puts COMPR's report beside it in compr_report_url.
  // A report re-run in place keeps every link the deal already has to it.
  if (reportUrl && !refresh) {
    if (!(body.keep_numbers || finished) || cur?.underwriting_url == null) patch.underwriting_url = reportUrl;
    else if (cur?.compr_report_url == null) patch.compr_report_url = reportUrl;
  }
  if (dealRowId !== null) await admin.from('deals').update(patch).eq('id', dealRowId);
  else if (!picked.ambiguous) {
    const { data: made } = await admin.from('deals')
      .insert({ workspace_id: workspaceId, seller_id: sellerId, property_id: seller.property_id, stage: 'Prospect', ...patch, owner_id: userId, created_by: userId, source: 'compr' })
      .select('id').single();
    dealRowId = made ? Number(made.id) : null;
  }

  // The lead_id this run sent, so a deal that later closes or terminates can
  // tell Compr which underwrite it was (the outcome action, migration 143).
  if (dealRowId !== null) {
    const { error: uwErr } = await admin.from('compr_underwrites').upsert(
      { workspace_id: workspaceId, seller_id: sellerId, deal_id: dealRowId, lead_id: runLead, report_url: reportUrl, source: 'run', created_by: userId },
      { onConflict: 'workspace_id,lead_id' },
    );
    if (uwErr) console.error('compr_underwrites', uwErr.message);
  }

  // Public buyer assets (hero, photo set, buyer report, CMA PDF) so a dispo
  // blast can actually be clicked. Fail-open: the numbers above already landed.
  if (status === 'complete' && dealRowId !== null) {
    try {
      const { data: d } = await admin.from('deals')
        .select('id, underwriting_url, compr_report_url, marketing_url, hero_image_url, asking_price, marketed_price, offer_amount, arv, rehab, mao, property_id')
        .eq('id', dealRowId).maybeSingle();
      if (d) await writeMarketingAssets(admin, k.key, workspaceId, d as MarketingDeal);
    } catch (e) { console.error('marketing assets', (e as Error).message); }
  }

  // The public record COMPR pulled (owner, loan, equity, tax, sale, events,
  // permits, rent) and the house itself (beds, baths, sqft, year, lot, type,
  // county, APN) onto the property. The v1 reply carries part of it; the rest
  // is on COMPR's lead row, read back with the same key. A run that is not
  // "complete" still pulled the record, so it is written too. Fail-open: the
  // underwriting numbers above already landed. Blank columns only — a value
  // a rep already typed stays.
  const propertyId = dealId !== null ? dealPropertyId : seller.property_id;
  let propertyLine: string | null = null;
  if (propertyId) {
    try {
      const comprLead = comprLeadIdInUrl(reportUrl) ?? runLead;
      const lr = await fetch(`https://underwriting.example.com/api/underwrite-result?lead_id=${encodeURIComponent(comprLead)}`, {
        headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
      const lead = lr?.ok ? ((await lr.json().catch(() => ({}))) as { lead?: unknown }).lead ?? null : null;
      const rec = comprRecords(reply, lead, prop.line1);
      if (rec) {
        const { error } = await admin.from('property_records').upsert(
          { workspace_id: workspaceId, property_id: propertyId, source: 'compr', ...rec, fetched_at: new Date().toISOString() },
          { onConflict: 'property_id' },
        );
        if (error) console.error('property_records', error.message);
      }
      const facts = comprPropertyFacts(reply, lead);
      if (facts) {
        propertyLine = comprPropertyLine(facts);
        const { data: curProp } = await admin.from('properties')
          .select('beds, baths, sqft, year_built, lot_sqft, property_type, county, apn, condition, lat, lng')
          .eq('id', propertyId).maybeSingle();
        const house = propertyPatchFromCompr(curProp, facts);
        if (Object.keys(house).length) {
          // Mark what COMPR filled so the next run leaves it off and looks it
          // up again; a person editing the field clears the mark 
          // 201's trigger). Before 201 the mark is skipped.
          const filled: string[] = COMPR_FACT_KEYS.filter((f) => f in house);
          const marks = filled.length
            ? await admin.from('properties').select('compr_filled').eq('id', propertyId).maybeSingle()
            : null;
          const prior = ((marks?.data as { compr_filled?: string[] | null } | null)?.compr_filled ?? []);
          let { error } = marks && !marks.error
            ? await admin.from('properties').update({
              ...house, compr_filled: [...new Set([...prior, ...filled])], compr_filled_at: new Date().toISOString(),
            }).eq('id', propertyId)
            : await admin.from('properties').update(house).eq('id', propertyId);
          if (error && marks && !marks.error) ({ error } = await admin.from('properties').update(house).eq('id', propertyId));
          if (error) console.error('property facts', error.message);
        }
        if (dealRowId !== null) {
          const { data: curDeal } = await admin.from('deals').select('condition_notes, occupancy_notes').eq('id', dealRowId).maybeSingle();
          const notes: { condition_notes?: string; occupancy_notes?: string } = {};
          if (!curDeal?.condition_notes && facts.condition) notes.condition_notes = facts.condition;
          if (!curDeal?.occupancy_notes && rec?.absentee === true) notes.occupancy_notes = 'Absentee owner';
          else if (!curDeal?.occupancy_notes && rec?.absentee === false) notes.occupancy_notes = 'Owner-occupied';
          if (Object.keys(notes).length) await admin.from('deals').update(notes).eq('id', dealRowId);
        }
      }
    } catch (e) { console.error('property_records', (e as Error).message); }
  }

  // Auto-offer: when the workspace has it on and COMPR produced a MAO, the
  // offer (and its letter) is generated right here, so a rep sees the number
  // and the signing link the moment the underwriting lands.
  let autoOffer: { amount: number; contract_id: number | null; signers: { role: string; url: string }[] } | null = null;
  if (userId && mao !== null && status === 'complete') {
    const { data: wsRow } = await admin.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle();
    const os = ((wsRow?.settings as { offers?: { auto?: boolean } } | null)?.offers) ?? {};
    if (os.auto) {
      const { data: prior } = await admin.from('offers').select('id').eq('seller_id', sellerId).eq('direction', 'outbound').limit(1);
      if (!prior?.length) {
        try {
          const origin = req.headers.get('origin') || Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com';
          const o = await generateOffer(admin, { ws: workspaceId, sellerId, userId, origin });
          autoOffer = { amount: o.amount, contract_id: o.contract?.contract.id ?? null, signers: (o.contract?.signers ?? []).map((s) => ({ role: s.role, url: s.url })) };
        } catch (e) { console.error('auto-offer', (e as Error).message); }
      }
    }
  }

  // The activity body shows on the record's timeline, so it reads as a
  // summary, not a blob. The full report lives at COMPR behind report_url.
  const money = (n: number | null) => (n === null ? '—' : '$' + n.toLocaleString('en-US'));
  const flagLine = redFlags.length ? ` · ${redFlags.length} red flag${redFlags.length === 1 ? '' : 's'}` : '';
  const arvLow = pickNumber(reply, ['arv.low']);
  const arvHigh = pickNumber(reply, ['arv.high']);
  const compCount = pickNumber(reply, ['comp_count']);
  const condition = pickString(reply, ['rehab.uad_condition']);
  const bodyLines = [
    `ARV ${money(arv)}${arvLow !== null && arvHigh !== null ? ` (range ${money(arvLow)} – ${money(arvHigh)})` : ''}${compCount !== null ? ` from ${compCount} comps` : ''}.`,
    `Rehab ${money(rehab)}${condition ? ` · condition ${condition}` : ''}.`,
    `MAO ${money(mao)} — low ${money(band.low)}, high ${money(band.high)}${band.lowSet || band.highSet ? ' (set by hand, kept)' : ''}. COMPR exits: wholesale ${money(wholesale)}, institutional ${money(institutional)}.`,
    confidence !== null ? `Confidence ${confidence}%.` : null,
    status !== 'complete' ? `Status: ${status}.` : null,
    ...redFlags.map((f) => `Red flag (${f.severity ?? '?'}): ${f.description ?? f.category ?? ''}`),
    propertyLine,
    reportUrl ? `Report: ${reportUrl}` : null,
    dealId !== null && prop ? `Property: ${[prop.line1, prop.city, prop.state].filter(Boolean).join(', ')}.` : null,
    refresh ? `Re-run in place with the ${sent.photo_urls.length} photos on the record; same report link.` : null,
    dealSkipped,
    `Lead id ${runLead}.`,
  ].filter((l): l is string => !!l);
  await admin.from('activity').insert({
    workspace_id: workspaceId, entity_type: 'seller', entity_id: sellerId, kind: 'compr',
    title: `COMPR: ARV ${money(arv)} · rehab ${money(rehab)} · MAO ${money(mao)}${status !== 'complete' ? ` · ${status}` : ''}${flagLine}`,
    body: bodyLines.join('\n'),
    actor_id: userId,
  });

  // Underwritten just now so it could be shared: share it.
  let shareUrl: string | null = null;
  let shareError: string | null = null;
  if (share) {
    const lid = comprLeadIdInUrl(reportUrl);
    try { shareUrl = await shareLink(k.key, lid ?? runLead, audience); } catch (e) { shareError = (e as Error).message; }
  }

  return json({ ok: true, arv, rehab, mao, wholesale: band.low, institutional: band.high, status, confidence, report_url: reportUrl, red_flags: redFlags, auto_offer: autoOffer, ...(dealSkipped ? { deal_skipped: dealSkipped } : {}), ...(share ? { audience, url: shareUrl, share_error: shareError } : {}) });
});

/** A number at one path without rounding — for 0–1 scores. */
function pickNumberRaw(obj: unknown, p: string): number | null {
  const v = p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
