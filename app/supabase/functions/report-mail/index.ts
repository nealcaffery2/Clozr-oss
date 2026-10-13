// report-mail: emails a custom report (Reporting → Custom reports) on its
// schedule, and "Send test email" to the signed-in person now.
//
//   { action: 'tick' }                                   service role (pg_cron, hourly at :05); also sends
//                                                        the weekly rep scorecards (_shared/sales-manager.ts)
//   { action: 'test', workspace_id, report_id,           a signed-in member who can see the report;
//     date_preset?, comparison? }                        the mail goes to their own address
//
// The widgets are computed by the same engine the browser draws with
// (_shared/report-engine.ts is a verbatim copy of app/lib/report-engine.ts;
// tools/report-engine.test.ts fails if they drift), over the workspace's rows
// read with the service role. Mail goes out through Resend from MAIL_FROM; the
// schedule's "from email" becomes Reply-To. A schedule saved with next_run_at
// null is aligned to its next occurrence on the first pass and sent then.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS, HARDENING, corsFor, jsonWith, isServiceCaller } from '../_shared/security.ts';
import {
  compute, evalFormula, fmtDelta, fmtValue, normalize, presetRange, rangeLabel, withComparison,
  type Chart, type Comparison, type EngineRaw, type Range, type Result, type Row, type Source, type Spec, type Token,
} from '../_shared/report-engine.ts';
import { runWeeklyScorecards } from '../_shared/sales-manager.ts';

type Block =
  | { id: string; kind: 'widget'; key: string; chart: string; title: string; spec: Spec; w: 1 | 2 }
  | { id: string; kind: 'metric'; key: string; chart: 'number'; title: string; formula: Token[]; format: 'int' | 'float' | 'pct' | 'usd'; polarity: 'up' | 'down'; w: 1 | 2 }
  | { id: string; kind: 'element'; element: 'title' | 'text' | 'image' | 'embed'; text: string; w: 1 | 2 };
type Def = { pages: { id: string; title: string; blocks: Block[] }[]; theme?: { title?: string; metric?: string; chart?: string; link?: string }; datePreset?: string; custom?: { from: string; to: string } | null; comparison?: Comparison };
type Schedule = { report_id: number; workspace_id: number; frequency: string; at_time: string; tz: string; date_preset: string; comparison: string; use_widget_dates: boolean; from_email: string | null; subject: string | null; recipients: string[]; message: string | null; enabled: boolean; next_run_at: string | null };

const APP = () => String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');
const DAY = 86_400_000;

// ---- time zones ----------------------------------------------------------------

function zoned(tz: string, t: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
/** The instant of a wall-clock time in a zone (two passes absorb the offset, DST included). */
function toUtc(tz: string, y: number, m: number, d: number, h: number, mi: number): number {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const z = zoned(tz, guess);
    guess += want - Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s);
  }
  return guess;
}
/** The next send after `from`: daily; weekly on Mondays; monthly on the 1st; quarterly on Jan/Apr/Jul/Oct 1; annually on Jan 1 — at at_time in tz. */
export function nextRunAt(frequency: string, atTime: string, tz: string, from = Date.now()): number {
  const [h, mi] = (atTime || '10:00').split(':').map((x) => Number(x) || 0);
  let zone = tz || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'America/Chicago'; }
  const z = zoned(zone, from);
  for (let k = 0; k < 400; k++) {
    const day = new Date(Date.UTC(z.y, z.m - 1, z.d + k));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay();
    const ok = frequency === 'daily' ? true : frequency === 'weekly' ? wd === 1 : frequency === 'monthly' ? d === 1
      : frequency === 'quarterly' ? d === 1 && [1, 4, 7, 10].includes(m) : frequency === 'annually' ? d === 1 && m === 1 : false;
    if (!ok) continue;
    const t = toUtc(zone, y, m, d, h, mi);
    if (t > from) return t;
  }
  return from + DAY;
}

// ---- data -------------------------------------------------------------------------

async function loadRaw(admin: SupabaseClient, ws: number, since: number): Promise<EngineRaw> {
  const sinceIso = new Date(Number.isFinite(since) ? since : Date.now() - 400 * DAY).toISOString();
  const [members, sellers, deals, comms, offers, contracts, matches, buyers, appts, tasks] = await Promise.all([
    admin.from('workspace_members').select('user_id,role,profiles(full_name)').eq('workspace_id', ws),
    admin.from('sellers').select('id,name,created_at,source,assigned_to,lead_stage,property_address,email,phone,tags,stage_entered_at').eq('workspace_id', ws).is('archived_at', null),
    admin.from('deals').select('id,seller_id,buyer_id,stage,created_at,stage_entered_at,contract_date,close_date,closed_on,marketing_started_on,owner_id,dispo_rep_id,offer_amount,arv,mao,assignment_fee,dispo_fee,sold_price,wholesale_fee,total_cogs,team_commissions_paid,deal_net_profit,final_profit,lead_source,market,marketed_price').eq('workspace_id', ws),
    admin.from('communications').select('seller_id,buyer_id,channel,direction,occurred_at,duration_s,status').eq('workspace_id', ws).gte('occurred_at', sinceIso).order('occurred_at', { ascending: false }).limit(10_000),
    admin.from('offers').select('id,deal_id,seller_id,buyer_id,direction,amount,status,sent_at,responded_at,created_by').eq('workspace_id', ws),
    admin.from('contracts').select('id,deal_id,kind,status,provider,sent_at,viewed_at,completed_at,created_at').eq('workspace_id', ws),
    admin.from('deal_buyer_matches').select('deal_id,buyer_id,status,sent_at,viewed_at,replied_at').eq('workspace_id', ws),
    admin.from('buyers').select('id,name,vip,created_at,last_activity_at,blacklisted_at').eq('workspace_id', ws),
    admin.from('appointments').select('id,seller_id,buyer_id,title,kind,starts_at,assigned_to,source,created_at,deleted_at').eq('workspace_id', ws),
    admin.from('tasks').select('id,seller_id,title,task_type,priority,due_at,assigned_to,done,completed_at,created_at').eq('workspace_id', ws),
  ]);
  type M = { user_id: string; role: string; profiles: { full_name: string | null } | { full_name: string | null }[] | null };
  const nameOf = (m: M) => (Array.isArray(m.profiles) ? m.profiles[0]?.full_name : m.profiles?.full_name) || 'Teammate';
  type S = { id: number; name: string; created_at: string; source: string | null; assigned_to: string | null; lead_stage: string; property_address: string | null; email: string | null; phone: string | null; tags: string[] | null; stage_entered_at: string | null };
  return {
    members: ((members.data ?? []) as unknown as M[]).map((m) => ({ id: m.user_id, name: nameOf(m), role: m.role })),
    sellers: ((sellers.data ?? []) as unknown as S[]).map((s) => ({ id: s.id, name: s.name, created_at: s.created_at, source: s.source, assigned_to: s.assigned_to, stage: s.lead_stage, address: s.property_address, email: s.email, phone: s.phone, tags: s.tags ?? [], stage_entered_at: s.stage_entered_at })),
    deals: (deals.data ?? []) as unknown as EngineRaw['deals'],
    comms: (comms.data ?? []) as unknown as EngineRaw['comms'],
    offers: (offers.data ?? []) as unknown as EngineRaw['offers'],
    contracts: (contracts.data ?? []) as unknown as EngineRaw['contracts'],
    matches: (matches.data ?? []) as unknown as EngineRaw['matches'],
    buyers: (buyers.data ?? []) as unknown as EngineRaw['buyers'],
    appointments: (appts.data ?? []) as unknown as EngineRaw['appointments'],
    tasks: (tasks.data ?? []) as unknown as EngineRaw['tasks'],
  };
}

// ---- rendering --------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function widgetHtml(b: Block, r: Result | null, theme: Def['theme'], compareLabel: string): string {
  const ink = theme?.metric || '#18181b', chart = theme?.chart || '#0A8560';
  const title = `<div style="font:600 12px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#52525b;margin-bottom:6px">${esc(b.kind === 'element' ? '' : b.title)}</div>`;
  if (b.kind === 'element') {
    if (b.element === 'title') return `<h3 style="margin:14px 0 4px;font:700 16px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${esc(theme?.title || '#18181b')}">${esc(b.text)}</h3>`;
    if (b.element === 'text') return `<p style="margin:0 0 8px;font:400 13px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#3f3f46;white-space:pre-wrap">${esc(b.text)}</p>`;
    if (b.element === 'image' && b.text) return `<img src="${esc(b.text)}" alt="" style="max-width:100%;border-radius:8px;display:block">`;
    return '';
  }
  if (!r) return title + `<div style="font:400 12px -apple-system,sans-serif;color:#71717a">—</div>`;
  const rows = (items: { label: string; value: number }[]) => {
    const max = Math.max(0, ...items.map((x) => x.value));
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${items.slice(0, 12).map((x) => `<tr><td style="padding:3px 6px 3px 0;font:400 12px -apple-system,sans-serif;color:#52525b;white-space:nowrap;max-width:160px;overflow:hidden">${esc(x.label)}</td><td style="width:100%;padding:3px 0"><div style="height:8px;background:#f0f0f1;border-radius:4px"><div style="height:8px;width:${max ? Math.max(1, Math.round((x.value / max) * 100)) : 0}%;background:${esc(chart)};border-radius:4px"></div></div></td><td style="padding:3px 0 3px 8px;font:600 12px -apple-system,sans-serif;color:#18181b;text-align:right;white-space:nowrap">${esc(fmtValue(x.value, r.format))}</td></tr>`).join('')}</table>`;
  };
  if (r.table) {
    return title + `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font:400 12px -apple-system,sans-serif"><tr>${r.table.cols.map((c) => `<th style="text-align:left;padding:5px 6px;border-bottom:1px solid #e4e4e7;font:600 10.5px -apple-system,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#71717a">${esc(c)}</th>`).join('')}</tr>${r.table.rows.slice(0, 15).map((row) => `<tr>${row.map((v) => `<td style="padding:5px 6px;border-bottom:1px solid #f0f0f1;color:#27272a;white-space:nowrap">${esc(v)}</td>`).join('')}</tr>`).join('')}</table>${r.table.rows.length > 15 ? `<div style="font:400 11px -apple-system,sans-serif;color:#71717a;margin-top:4px">${r.table.rows.length - 15} more in CLOZR</div>` : ''}`;
  }
  if (r.funnel) return title + rows(r.funnel);
  if (r.groups) return title + rows(r.groups);
  if (r.series) return title + rows(r.series.filter((_, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0));
  const polarity = b.kind === 'widget' ? b.spec.polarity ?? 'up' : b.kind === 'metric' ? b.polarity : 'up';
  const d = fmtDelta(r.value, r.prev, polarity);
  const color = !d || d.good === null ? '#71717a' : d.good ? '#16a34a' : '#dc2626';
  return title + `<div style="font:700 28px/1.1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;letter-spacing:-.02em;color:${esc(ink)}">${esc(fmtValue(r.value, r.format))}</div>${d ? `<div style="font:500 11.5px -apple-system,sans-serif;color:${color};margin-top:4px">${esc(d.text)} <span style="color:#71717a">vs ${esc(compareLabel)}</span></div>` : ''}`;
}

function reportHtml(opts: { name: string; workspace: string; def: Def; range: Range; results: Map<string, Result>; message: string | null; compareLabel: string }): { html: string; text: string } {
  const { def, range } = opts;
  const dates = rangeLabel(range);
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
  const pages = def.pages.map((p) => {
    const cells = p.blocks.map((b) => `<td valign="top" width="${b.w === 2 ? '100%' : '50%'}" ${b.w === 2 ? 'colspan="2"' : ''} style="padding:6px"><div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:12px 14px">${widgetHtml(b, opts.results.get(b.id) ?? null, def.theme, opts.compareLabel)}</div></td>`);
    // Two cells a row; a full-width block takes the row.
    const trs: string[] = [];
    for (let i = 0; i < p.blocks.length;) {
      const b = p.blocks[i];
      if (b.w === 2) { trs.push(`<tr>${cells[i]}</tr>`); i++; continue; }
      const next = p.blocks[i + 1];
      if (next && next.w !== 2) { trs.push(`<tr>${cells[i]}${cells[i + 1]}</tr>`); i += 2; } else { trs.push(`<tr>${cells[i]}<td width="50%"></td></tr>`); i++; }
    }
    return `<h2 style="margin:22px 0 6px;font:700 15px/1.3 ${font};color:${esc(def.theme?.title || '#18181b')}">${esc(p.title)}</h2><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed">${trs.join('')}</table>`;
  }).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:20px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;margin:0 auto"><tr><td style="padding:0 12px">
<div style="font:700 10.5px ${font};letter-spacing:.12em;text-transform:uppercase;color:#71717a">${esc(opts.workspace)}</div>
<h1 style="margin:6px 0 2px;font:700 24px/1.2 ${font};letter-spacing:-.02em;color:${esc(def.theme?.title || '#18181b')}">${esc(opts.name)}</h1>
<div style="font:400 13px ${font};color:#71717a">${esc(dates)}${opts.compareLabel ? ` · compared with the ${esc(opts.compareLabel)}` : ''}</div>
${opts.message ? `<p style="margin:14px 0 0;font:400 13.5px/1.55 ${font};color:#27272a;white-space:pre-wrap">${esc(opts.message)}</p>` : ''}
${pages}
<p style="margin:22px 0 0;font:400 12px ${font};color:#71717a">Sent by CLOZR · <a href="${esc(APP())}" style="color:${esc(def.theme?.link || '#0A8560')};font-weight:600">Open Reporting</a> to change the range, the widgets or the schedule.</p>
</td></tr></table></body></html>`;
  const text = [`${opts.name} — ${dates}`, opts.message ?? '', ...def.pages.flatMap((p) => [``, p.title.toUpperCase(), ...p.blocks.map((b) => { const r = opts.results.get(b.id); return b.kind === 'element' ? b.text : `${b.title}: ${r ? fmtValue(r.value, r.format) : '—'}`; })]), '', `Open Reporting: ${APP()}`].join('\n');
  return { html, text };
}

/** Every block's numbers for the range. `widgetDates` false strips widget-level overrides so the whole mail reads one window. */
function computeAll(def: Def, raw: EngineRaw, range: Range, widgetDates: boolean): Map<string, Result> {
  const data = normalize(raw) as Record<Source, Row[]>;
  const out = new Map<string, Result>();
  const spec = (s: Spec): Spec => (widgetDates ? s : { ...s, datePreset: null, comparison: 'report' });
  for (const p of def.pages) for (const b of p.blocks) {
    if (b.kind === 'widget') out.set(b.id, compute(spec(b.spec), range, data, raw, { chart: b.chart as Chart }));
    else if (b.kind === 'metric') {
      const value = evalFormula(b.formula, (s) => compute(spec(s), range, data, raw, {}).value);
      const prev = range.prevStart === null ? null : evalFormula(b.formula, (s) => compute(spec(s), range, data, raw, {}).prev);
      out.set(b.id, { value, prev, format: b.format === 'usd' ? 'usd' : b.format === 'pct' ? 'pct' : b.format === 'float' ? 'float' : 'int', groups: null, series: null, table: null, funnel: null, n: 0 });
    }
  }
  return out;
}

function compareLabelOf(preset: string, comparison: string, range: Range): string {
  if (comparison === 'none' || range.prevStart === null) return '';
  if (comparison === 'year') return 'year before';
  const days = Math.max(1, Math.round((range.end - range.start) / DAY));
  return preset === 'Yesterday' || days === 1 ? 'previous day' : `previous ${days} days`;
}

async function sendMail(to: string, subject: string, html: string, text: string, replyTo: string | null): Promise<string | null> {
  const key = (Deno.env.get('RESEND_API_KEY') ?? '').trim();
  const from = (Deno.env.get('MAIL_FROM') ?? '').trim();
  if (!key || !from) return 'Resend is not configured on the project (RESEND_API_KEY + MAIL_FROM).';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}), tags: [{ name: 'kind', value: 'report' }] }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) return `Resend refused the send (${res?.status ?? 'network'}).`;
  return null;
}

async function mailReport(admin: SupabaseClient, ws: number, report: { name: string; definition: Def }, opts: { preset: string; comparison: string; widgetDates: boolean; to: string[]; subject: string | null; message: string | null; replyTo: string | null }): Promise<{ sent: number; error: string | null }> {
  const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
  const def: Def = { ...(report.definition ?? {}), pages: report.definition?.pages ?? [] };
  const win = presetRange(opts.preset, def.custom ?? null);
  const range = withComparison(win, opts.comparison === 'none' ? 'none' : opts.comparison === 'year' ? 'year' : 'previous');
  const raw = await loadRaw(admin, ws, Math.min(range.prevStart ?? range.start, range.start) - 30 * DAY);
  const results = computeAll(def, raw, range, opts.widgetDates);
  const { html, text } = reportHtml({ name: report.name, workspace: w?.name ?? 'CLOZR', def, range, results, message: opts.message, compareLabel: compareLabelOf(opts.preset, opts.comparison, range) });
  let sent = 0, error: string | null = null;
  for (const to of opts.to) {
    const err = await sendMail(to, opts.subject || report.name, html, text, opts.replyTo);
    if (err) error = err; else sent++;
  }
  return { sent, error };
}

// ---- the function --------------------------------------------------------------------

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'POST, OPTIONS', headers: ALLOW_HEADERS });
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...HARDENING } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const input = await req.json().catch(() => ({})) as { action?: string; workspace_id?: number; report_id?: number; date_preset?: string; comparison?: string };
  // The service role is exactly the env key or the cron's vault key; a decoded claim alone is never enough.
  const role = (await isServiceCaller(admin, bearer)) ? 'service_role' : 'person';

  if (input.action === 'tick') {
    if (role !== 'service_role') return json({ error: 'service role only' }, 403);
    const nowIso = new Date().toISOString();
    const { data: due } = await admin.from('report_schedules').select('*').eq('enabled', true).or(`next_run_at.is.null,next_run_at.lte.${nowIso}`).limit(25);
    let sent = 0, aligned = 0, failed = 0;
    for (const s of (due ?? []) as Schedule[]) {
      const next = new Date(nextRunAt(s.frequency, s.at_time, s.tz)).toISOString();
      if (!s.next_run_at) {
        // Saved without a first run: line it up with its cadence rather than mailing within the hour.
        await admin.from('report_schedules').update({ next_run_at: next }).eq('report_id', s.report_id);
        aligned++;
        continue;
      }
      const { data: report } = await admin.from('reports').select('name,definition').eq('id', s.report_id).maybeSingle();
      if (!report) { await admin.from('report_schedules').update({ enabled: false, last_error: 'report is gone' }).eq('report_id', s.report_id); continue; }
      try {
        const r = await mailReport(admin, s.workspace_id, report as { name: string; definition: Def }, { preset: s.date_preset, comparison: s.comparison, widgetDates: s.use_widget_dates, to: s.recipients ?? [], subject: s.subject, message: s.message, replyTo: s.from_email });
        await admin.from('report_schedules').update({ next_run_at: next, last_run_at: nowIso, last_error: r.error }).eq('report_id', s.report_id);
        if (r.error) failed++; else sent++;
      } catch (e) {
        await admin.from('report_schedules').update({ next_run_at: next, last_run_at: nowIso, last_error: (e as Error).message.slice(0, 300) }).eq('report_id', s.report_id);
        failed++;
      }
    }
    // The AI Sales Manager's weekly rep scorecards ride the same hourly tick (migration 149).
    let scorecards: Record<string, unknown> = {};
    try {
      scorecards = await runWeeklyScorecards(admin, (at, tz) => nextRunAt('weekly', at, tz));
    } catch (e) {
      scorecards = { error: (e as Error).message.slice(0, 300) };
    }
    return json({ ok: true, sent, aligned, failed, scorecards });
  }

  if (input.action === 'test') {
    if (!bearer || role === 'service_role') return json({ error: 'sign in' }, 401);
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data: who } = await asCaller.auth.getUser();
    if (!who?.user?.email) return json({ error: 'sign in' }, 401);
    const ws = Number(input.workspace_id), id = Number(input.report_id);
    if (!Number.isFinite(ws) || !Number.isFinite(id)) return json({ error: 'workspace_id and report_id required' }, 400);
    // RLS decides whether the caller can see this report at all.
    const { data: report } = await asCaller.from('reports').select('name,definition,workspace_id').eq('id', id).eq('workspace_id', ws).maybeSingle();
    if (!report) return json({ error: 'no such report, or not yours to see' }, 404);
    const def = (report as { definition: Def }).definition ?? { pages: [] };
    const r = await mailReport(admin, ws, report as { name: string; definition: Def }, { preset: input.date_preset || def.datePreset || 'Last 30 days', comparison: input.comparison || def.comparison || 'previous', widgetDates: true, to: [who.user.email], subject: null, message: null, replyTo: null });
    if (r.error) return json({ ok: false, error: r.error }, 200);
    return json({ ok: true, to: who.user.email });
  }

  return json({ error: 'unknown action' }, 400);
});
