/**
 * POST /portal-submissions — Chris's partner submissions into workspace 11, every weekday at 8 AM Central.
 *
 * Service role only (pg_cron's portal_submissions_kick, migration 419, or a
 * hand call with the service key). Body: { live?, limit?, source?, force?, submissions? }
 *   live   write to CLOZR. Otherwise a dry run: everything is read and
 *          matched, nothing is written but the portal_runs rows. The function
 *          secret INGEST_LIVE=1 makes the cron run live.
 *   limit  at most this many new submissions per source (testing: 2).
 *   source only this label ("Offerpad", "Mark Spain TX").
 *   force  run outside 8 AM Central (the cron fires at 13:00 and 14:00 UTC; only one is 8 AM).
 *   submissions  rows a portal worker read (Felix's browser pull of Express Offers, Orchard,
 *          Place; shape in _shared/portal-subs.ts postedSubmissions). When present the run
 *          imports only these, at any hour: no email or sheet collection, no COMPR retry.
 *   PORTAL_STATES ("TX,GA") skips submissions outside those states before COMPR runs; unset imports every state.
 *
 * Collectors:
 *   email   the Gmail accounts in PORTAL_GMAIL_ACCOUNTS (default sam@ and
 *           chris@, both connected in Settings with gmail.readonly), last
 *           three days, up to 300 messages, csv attachments (xlsx/xls are listed, not read yet) from the partner senders in
 *           _shared/portal-subs.ts SENDERS (+ PORTAL_EXTRA_SENDERS
 *           "domain=Label,…"). Other senders' sheets are listed, not imported.
 *   sheets  the Mark Spain investor sheets (PORTAL_MSRE_SHEETS "TX=<id>,…"),
 *           exported as CSV through Drive on the first account with
 *           drive.readonly. Read only: the sheets are where bids are logged.
 *           Off unless SOURCE_MARKSPAIN_ENABLED=1 (access was cut off Oct 13,
 *           2026; the sheet ids live in the spec, not here).
 *   Portal logins (ESO, Orchard, Zoodealio, Blanket, Place) are not here: they
 *   need a real browser and are a separate worker that posts to /ingest.
 *
 * Each new submission: address checked against properties.address_key (an
 * address that already has a deal is skipped and counted; a property with no
 * deal, like a cold lead, still gets the submission), then ingest_apply_flat as
 * a wholesaler.create keyed source='portal' + external_id (New Submission,
 * migration 387; the ledger dedupes a resend). A deal this run created gets
 * owner PORTAL_ASSIGNEE_USER_ID (default Drew Collins) and lead_source whatever
 * ingest or a round robin set, and COMPR is asked through compr-underwrite.
 * Every COMPR call is awaited before the run is written, so portal_runs.details
 * carries compr_queued / compr_done / compr_failed; a portal deal still without
 * compr_report_url or underwriting_url two hours later is retried once on the next run.
 *
 * Reporting: one portal_runs row per source (a source that had rows before
 * and has sent none for three runs gets an error), a summary notification to
 * Sam (PORTAL_SUMMARY_EMAIL's CLOZR user), and the same summary as a Gmail
 * draft in that mailbox (gmail.compose, "Allow drafts" in Settings → Google).
 * SUMMARY_SEND=1 sends it instead. Draft or send, the recipient must be in
 * SUMMARY_ALLOW (sam@ only); nothing outside Acme Homes ever gets it.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import { flatToEnvelope } from '../_shared/flat.ts';
import { type Account, accessFor, createDraft, fetchAttachment, filesOf, has, SCOPE, sendMail } from '../_shared/google.ts';
import {
  type SourceReport, type Submission, SUMMARY_ALLOW, inMarkets, isEightAmCentral, markSpainLabel, postedSubmissions, parseCsv, quietThreeDays, senderLabel, sheetToSubmissions, submissionToFlat, summaryMail, summaryRecipient,
} from '../_shared/portal-subs.ts';

const WS = 11;
const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const CHRIS_COX = '001bbcdd-0a39-4dcb-9391-f42431516802';
const ASSIGNEE = () => env('PORTAL_ASSIGNEE_USER_ID', CHRIS_COX);
const ASSIGNEE_NAME = () => env('PORTAL_ASSIGNEE_NAME', 'Drew Collins');
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SHEET_FILE = /\.(csv|xlsx|xls)$/i;
const MAIL_MAX = 300;
const COMPR_RETRY_SOURCE = 'Compr retry';

type Batch = { source: string; subs: Submission[] };
type Collected = { batches: Batch[]; unknown: string[]; failures: { source: string; error: string }[] };

async function gget(token: string, url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function collectEmail(token: string, account: string, out: Collected) {
  const q = 'newer_than:3d has:attachment {filename:csv filename:xlsx filename:xls} -in:chats -in:drafts -in:sent';
  const ids: string[] = [];
  let page = '';
  do {
    const list = await (await gget(token, `${GMAIL}/messages?maxResults=100&q=${encodeURIComponent(q)}${page ? `&pageToken=${page}` : ''}`)).json();
    ids.push(...(list.messages ?? []).map((m: { id: string }) => m.id));
    page = ids.length < MAIL_MAX ? String(list.nextPageToken ?? '') : '';
  } while (page);
  for (const id of ids.slice(0, MAIL_MAX)) {
    const m = await (await gget(token, `${GMAIL}/messages/${id}?format=full`)).json();
    const header = (n: string) => (m.payload?.headers ?? []).find((h: { name: string }) => h.name.toLowerCase() === n)?.value ?? '';
    const from = header('from');
    const files = filesOf(m.payload).filter((f) => SHEET_FILE.test(f.filename));
    const known = senderLabel(from, env('PORTAL_EXTRA_SENDERS'));
    if (!known) {
      out.unknown.push(...files.map((f) => `${f.filename} from ${from} (${account}): sender not on the partner list`));
      continue;
    }
    const label = markSpainLabel(known, header('subject'));
    for (const f of files) {
      // ponytail: CSV only. The edge bundler refuses cdn.sheetjs.com and npm's xlsx 0.18.5 has open parsing CVEs;
      // read xlsx once a patched parser is importable here.
      if (!/\.csv$/i.test(f.filename)) { out.unknown.push(`${f.filename} from ${label} (${account}): Excel files not read yet`); continue; }
      const bytes = await fetchAttachment(token, id, f.part_key);
      if (!bytes) { out.failures.push({ source: label, error: `could not download ${f.filename}` }); continue; }
      const subs = sheetToSubmissions(parseCsv(new TextDecoder().decode(bytes)), label, label.toLowerCase().replace(/[^a-z0-9]+/g, ''));
      if (!subs) out.unknown.push(`${f.filename} from ${label} (${account}): layout not known yet`);
      else out.batches.push({ source: label, subs });
    }
  }
}

async function collectSheets(token: string, out: Collected) {
  for (const pair of env('PORTAL_MSRE_SHEETS').split(',')) {
    const [st, id] = pair.split('=').map((s) => s.trim());
    if (!st || !id) continue;
    const source = `Mark Spain ${st.toUpperCase()}`;
    try {
      const csv = await (await gget(token, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`)).text();
      const subs = sheetToSubmissions(parseCsv(csv), source, `markspain:${st.toLowerCase()}`);
      if (!subs) out.unknown.push(`${source} sheet: layout not known yet`);
      else out.batches.push({ source, subs });
    } catch (e) {
      out.failures.push({ source, error: `sheet not readable (share it with the connected Google account): ${(e as Error).message}` });
    }
  }
}

async function collect(admin: SupabaseClient): Promise<Collected> {
  const out: Collected = { batches: [], unknown: [], failures: [] };
  const emails = env('PORTAL_GMAIL_ACCOUNTS', 'sam@yourcompany.com,chris@yourcompany.com').split(',').map((s) => s.trim().toLowerCase());
  const { data } = await admin.from('google_accounts').select('*').eq('workspace_id', WS).eq('status', 'active').in('email', emails);
  const accounts = (data ?? []) as Account[];
  let drive: string | null = null;
  for (const email of emails) {
    const a = accounts.find((x) => x.email.toLowerCase() === email);
    const token = a && has(a, SCOPE.gmailRead) ? await accessFor(admin, a) : null;
    if (!a || !token) { out.failures.push({ source: `Email ${email}`, error: 'Google account not connected with Gmail read in CLOZR Settings' }); continue; }
    if (!drive && has(a, SCOPE.driveRead)) drive = token;
    try { await collectEmail(token, email, out); } catch (e) { out.failures.push({ source: `Email ${email}`, error: (e as Error).message }); }
  }
  if (env('SOURCE_MARKSPAIN_ENABLED') === '1') {
    if (drive) await collectSheets(drive, out);
    else out.failures.push({ source: 'Mark Spain sheets', error: 'no connected Google account has Drive read' });
  }
  return out;
}

type ComprResult = { deal_id: number; ok: boolean; error?: string };
type Tally = { found: number; created: number; existing: number; deduped: number; failed: number; lines: string[]; errors: string[]; compr: Promise<ComprResult>[] };

/**
 * One COMPR run for a deal, capped so a slow one cannot hold the whole run. compr-underwrite owns the key, the hourly cap and the write-back (compr_report_url, MAO).
 * The cap sits past compr-underwrite's own 142 s budget and the 150 s gateway cut, so its answer (or the gateway's) arrives before we give up.
 */
function compr(sellerId: number, dealId: number): Promise<ComprResult> {
  return fetch(`${env('SUPABASE_URL')}/functions/v1/compr-underwrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}` },
    body: JSON.stringify({ workspace_id: WS, seller_id: sellerId, deal_id: dealId }),
    signal: AbortSignal.timeout(155_000),
  }).then(
    async (res) => res.ok ? { deal_id: dealId, ok: true } : { deal_id: dealId, ok: false, error: `${res.status} ${(await res.text()).slice(0, 160)}` },
    (e) => ({ deal_id: dealId, ok: false, error: (e as Error).message }),
  );
}

async function apply(admin: SupabaseClient, s: Submission, live: boolean, t: Tally) {
  const { data: key, error: keyErr } = await admin.rpc('address_key', { p_line1: s.address, p_city: s.city ?? null, p_state: s.state ?? null, p_zip: s.zip ?? null });
  if (keyErr) { t.failed++; t.errors.push(`${s.address}: address_key ${keyErr.message}`); return; }
  const { data: seen } = await admin.from('ingest_events').select('id').eq('workspace_id', WS).eq('source', 'portal').eq('source_id', s.external_id).maybeSingle();
  if (seen) { t.deduped++; return; }
  const { data: prop } = key
    ? await admin.from('properties').select('id').eq('workspace_id', WS).eq('address_key', key).limit(1).maybeSingle()
    : { data: null };
  // A property row alone (a PropStream cold lead, a skip-trace import) is not a submission:
  // only skip when that property already has a deal. Otherwise the deal lands on the existing property.
  const { count: deals } = prop
    ? await admin.from('deals').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('property_id', prop.id)
    : { count: 0 };
  if (deals) { t.existing++; t.lines.push(`already in CLOZR: ${s.address}`); return; }
  if (!live) { t.created++; t.lines.push(`would add: ${s.address}, ${s.city ?? ''} ${s.state ?? ''}`); return; }

  const envelope = flatToEnvelope('portal', submissionToFlat(s), s.external_id);
  if ('error' in envelope) { t.failed++; t.errors.push(`${s.address}: ${envelope.error}`); return; }
  const { data, error } = await admin.rpc('ingest_apply_flat', { p_workspace_id: WS, p_envelope: envelope });
  if (error) { t.failed++; t.errors.push(`${s.address}: ${error.message}`); return; }
  const r = data as { deduped?: boolean; updated?: boolean; id?: number; deal_id?: number | null };
  if (r.deduped || r.updated) { t.deduped++; return; }
  t.created++;
  t.lines.push(`added: ${s.address}, ${s.city ?? ''} ${s.state ?? ''}${r.deal_id ? '' : ' (no price or value, so no deal yet)'}`);
  if (r.id) await admin.from('sellers').update({ assigned_to: ASSIGNEE() }).eq('id', r.id).is('assigned_to', null);
  if (!r.deal_id || !r.id) return;
  // The deal is this run's: whatever ingest or a round robin put on it, it is Chris's partner submission.
  await admin.from('deals').update({ owner_id: ASSIGNEE(), acq_agent: ASSIGNEE_NAME(), lead_source: s.source }).eq('id', r.deal_id);
  t.compr.push(compr(r.id, r.deal_id));
}

/** Portal deals from the last week still without a COMPR report two hours on, not retried before: one more try each. */
async function comprRetry(admin: SupabaseClient, live: boolean): Promise<{ deal_ids: number[]; compr: Promise<ComprResult>[] }> {
  const out = { deal_ids: [] as number[], compr: [] as Promise<ComprResult>[] };
  if (!live) return out;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: events } = await admin.from('ingest_events').select('seller_id').eq('workspace_id', WS).eq('source', 'portal').gte('received_at', since).not('seller_id', 'is', null);
  const sellers = [...new Set(((events ?? []) as { seller_id: number }[]).map((e) => Number(e.seller_id)))];
  if (!sellers.length) return out;
  const { data: tried } = await admin.from('portal_runs').select('details').eq('workspace_id', WS).eq('source', COMPR_RETRY_SOURCE).gte('started_at', since);
  const done = new Set(((tried ?? []) as { details: { deal_ids?: number[] } | null }[]).flatMap((r) => r.details?.deal_ids ?? []));
  const { data: deals } = await admin.from('deals').select('id, seller_id').eq('workspace_id', WS).in('seller_id', sellers)
    // A first run stores the report in underwriting_url (compr-underwrite keeps compr_report_url for a second link), so both empty means no report.
    .is('compr_report_url', null).is('underwriting_url', null).lt('created_at', new Date(Date.now() - 2 * 3_600_000).toISOString());
  for (const d of deals ?? []) {
    if (done.has(d.id)) continue;
    out.deal_ids.push(d.id);
    out.compr.push(compr(Number(d.seller_id), d.id));
  }
  return out;
}

/** A source with found = 0 that had rows before, quiet for three runs: an error on its row, so the summary says so. */
async function quietCheck(admin: SupabaseClient, source: string, found: number): Promise<string | undefined> {
  if (found) return undefined;
  const { data } = await admin.from('portal_runs').select('found').eq('workspace_id', WS).eq('source', source).order('started_at', { ascending: false }).limit(3);
  return quietThreeDays(found, ((data ?? []) as { found: number }[]).map((r) => Number(r.found))) ? 'no rows for three runs in a row from a source that usually has them' : undefined;
}

async function summarize(admin: SupabaseClient, mail: { subject: string; text: string }, live: boolean) {
  const notes: string[] = [];
  const wanted = env('PORTAL_SUMMARY_EMAIL', SUMMARY_ALLOW[0]);
  const to = summaryRecipient(wanted);
  if (!to) { console.error('portal summary: PORTAL_SUMMARY_EMAIL is not an allowed recipient'); notes.push('Summary mail not made: PORTAL_SUMMARY_EMAIL is not on the allowed list.'); }
  const { data: acct } = await admin.from('google_accounts').select('*').eq('workspace_id', WS).eq('email', to ?? SUMMARY_ALLOW[0]).limit(1).maybeSingle();
  const a = acct as Account | null;
  if (!a) console.error('portal summary: no CLOZR Google account for', to ?? wanted);
  else if (to && a.status === 'active') {
    const send = env('SUMMARY_SEND') === '1';
    const scope = send ? SCOPE.gmailSend : SCOPE.gmailCompose;
    const token = has(a, scope) ? await accessFor(admin, a) : null;
    if (!token) notes.push(send ? 'Summary not sent: Gmail send is not granted for this account.' : 'Gmail draft not made: open Settings → Google and click Allow drafts.');
    else {
      try {
        const msg = { to, subject: mail.subject, text: mail.text, html: '', plainOnly: true };
        if (send) { if (!(await sendMail(token, msg))) notes.push('Summary send failed; see the function log.'); }
        else await createDraft(token, msg);
      } catch (e) { notes.push(`Gmail draft failed: ${(e as Error).message}`); }
    }
  } else if (a.status !== 'active') notes.push(`Gmail draft not made: ${a.email} needs reconnecting in Settings → Google.`);
  if (a?.user_id) {
    const body = [mail.text, ...(notes.length ? ['', ...notes] : [])].join('\n');
    await admin.from('notifications').insert({ workspace_id: WS, user_id: a.user_id, category: 'Submissions', title: mail.subject.slice(0, 120), body: body.slice(0, 2000) });
  }
  return { notes, live };
}

Deno.serve(async (req) => {
  const json = jsonWith(corsFor(req));
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '').trim();
  if (!(await isServiceCaller(admin, bearer))) return json({ error: 'service role only' }, 401);

  const body = await req.json().catch(() => ({})) as { live?: boolean; limit?: number; source?: string; force?: boolean; submissions?: unknown };
  const posted = body.submissions !== undefined;
  if (!posted && !body.force && !isEightAmCentral(new Date())) return json({ ok: true, skipped: 'not 8 AM Central on a weekday' });
  const live = body.live === true || env('INGEST_LIVE') === '1';
  const limit = Number(body.limit) > 0 ? Number(body.limit) : Infinity;

  let got: Collected;
  if (posted) {
    const p = postedSubmissions(body.submissions);
    const bySrc = new Map<string, Submission[]>();
    for (const s of p.subs) bySrc.set(s.source, [...(bySrc.get(s.source) ?? []), s]);
    got = { batches: [...bySrc].map(([source, subs]) => ({ source, subs })), unknown: p.rejected, failures: [] };
  } else got = await collect(admin);
  if (!env('PORTAL_ASSIGNEE_USER_ID')) got.unknown.push(`PORTAL_ASSIGNEE_USER_ID is not set; new deals go to ${ASSIGNEE_NAME()} by default.`);
  const bySource = new Map<string, Submission[]>();
  for (const b of got.batches) bySource.set(b.source, [...(bySource.get(b.source) ?? []), ...b.subs]);
  for (const f of got.failures) if (!bySource.has(f.source)) bySource.set(f.source, []);

  const runs: { source: string; t: Tally; error?: string }[] = [];
  for (const [source, all] of bySource) {
    if (body.source && body.source !== source) continue;
    // One sheet often repeats yesterday's rows: same id once per run.
    const subs = [...new Map(all.map((s) => [s.external_id, s])).values()];
    const t: Tally = { found: subs.length, created: 0, existing: 0, deduped: 0, failed: 0, lines: [], errors: [], compr: [] };
    for (const s of subs) {
      if (t.created >= limit) break;
      if (!inMarkets(s.state, env('PORTAL_STATES'))) { t.lines.push(`outside PORTAL_STATES: ${s.address}, ${s.state ?? 'no state'}`); continue; }
      try { await apply(admin, s, live, t); } catch (e) { t.failed++; t.errors.push(`${s.address}: ${(e as Error).message}`); }
    }
    const quiet = await quietCheck(admin, source, t.found);
    const error = [...got.failures.filter((f) => f.source === source).map((f) => f.error), ...t.errors, ...(quiet ? [quiet] : [])].join('; ') || undefined;
    runs.push({ source, t, error });
  }
  const retry = body.source || posted ? { deal_ids: [], compr: [] } : await comprRetry(admin, live);

  // Every COMPR call started above runs while the sources were processed; now wait, so the rows and the summary say what happened.
  const settled = async (ps: Promise<ComprResult>[]) => {
    const rs = (await Promise.allSettled(ps)).map((r) => r.status === 'fulfilled' ? r.value : { deal_id: 0, ok: false, error: String(r.reason) });
    // A call that timed out or errored may still have finished on COMPR's side and written the deal: the deal row is the truth.
    const unsure = rs.filter((r) => !r.ok && r.deal_id).map((r) => r.deal_id);
    if (unsure.length) {
      const { data } = await admin.from('deals').select('id').in('id', unsure).not('underwriting_url', 'is', null).not('arv', 'is', null);
      const written = new Set((data ?? []).map((d) => d.id as number));
      for (const r of rs) if (!r.ok && written.has(r.deal_id)) { r.ok = true; delete r.error; }
    }
    return { queued: rs.length, done: rs.filter((r) => r.ok).length, failed: rs.filter((r) => !r.ok).map((r) => `deal ${r.deal_id}: ${r.error}`) };
  };
  const report: SourceReport[] = [];
  const comprAll = { queued: 0, done: 0, failed: [] as string[] };
  for (const { source, t, error } of runs) {
    const c = await settled(t.compr);
    comprAll.queued += c.queued; comprAll.done += c.done; comprAll.failed.push(...c.failed);
    report.push({ source, found: t.found, created: t.created, existing: t.existing, deduped: t.deduped, failed: t.failed, lines: t.lines, error });
    await admin.from('portal_runs').insert({
      workspace_id: WS, source, found: t.found, new: t.created, existing: t.existing, deduped: t.deduped,
      failed: t.failed, error: error ?? null, dry_run: !live,
      details: { lines: t.lines, unknown: got.unknown, compr_queued: c.queued, compr_done: c.done, compr_failed: c.failed },
    });
  }
  if (retry.deal_ids.length) {
    const c = await settled(retry.compr);
    comprAll.queued += c.queued; comprAll.done += c.done; comprAll.failed.push(...c.failed.map((f) => `${f} (retry)`));
    await admin.from('portal_runs').insert({
      workspace_id: WS, source: COMPR_RETRY_SOURCE, found: retry.deal_ids.length, failed: c.failed.length, error: c.failed.join('; ') || null, dry_run: !live,
      details: { deal_ids: retry.deal_ids, compr_queued: c.queued, compr_done: c.done, compr_failed: c.failed },
    });
  }

  const mail = summaryMail({ date: new Date(), live, assignee: ASSIGNEE_NAME(), report, unknown: got.unknown, compr: comprAll, link: env('PORTAL_SUMMARY_LINK') || undefined });
  const summary = await summarize(admin, mail, live);
  return json({ ok: true, live, title: mail.subject, report, unknown: got.unknown, compr: comprAll, compr_retried: retry.deal_ids, summary: summary.notes });
});
