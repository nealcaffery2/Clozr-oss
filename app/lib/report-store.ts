// Saved custom reports, custom metrics and schedules: the rows behind
// components/reporting/custom. A report's pages, blocks, theme and date
// settings are one JSON document (ReportDef) on the row, so a save is one
// write and never half-applies. Without Supabase (the demo) everything lives
// in memory for the session.

import { supabase } from './supabase';
import type { Report, CustomMetricRow, ReportSchedule } from './database.types';
import type { Chart, Comparison, Polarity, Spec, Token, MetricFormat } from './report-engine';
import { THEMES, type Theme } from './report-catalog';

export type Block =
  | { id: string; kind: 'widget'; key: string; chart: Chart; title: string; spec: Spec; w: 1 | 2; metricId?: number | null }
  | { id: string; kind: 'metric'; key: string; chart: 'number'; title: string; formula: Token[]; format: MetricFormat; polarity: Polarity; w: 1 | 2; metricId?: number | null }
  | { id: string; kind: 'element'; element: 'title' | 'text' | 'image' | 'embed'; text: string; w: 1 | 2 };

export type ReportPage = { id: string; title: string; blocks: Block[] };

export type PageSettings = { logoUrl: string | null; showTitle: boolean; showDate: boolean; showDivider: boolean; showCover: boolean; background: string };

export type ReportDef = {
  pages: ReportPage[];
  theme: Theme;
  page: PageSettings;
  datePreset: string;
  custom: { from: string; to: string } | null;
  comparison: Comparison;
};

export type ReportRow = Omit<Report, 'definition'> & { definition: ReportDef; schedule: ReportSchedule | null; owner_name?: string | null };
export type CustomMetric = Omit<CustomMetricRow, 'formula' | 'display_format' | 'polarity'> & { formula: Token[]; display_format: MetricFormat; polarity: Polarity };
export type WriteResult<T = undefined> = { ok: true; data: T } | { ok: false; message: string };

export const DEFAULT_PAGE: PageSettings = { logoUrl: null, showTitle: true, showDate: true, showDivider: true, showCover: true, background: '#ffffff' };

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export function blankDef(): ReportDef {
  return { pages: [{ id: uid(), title: 'Untitled page', blocks: [] }], theme: THEMES[0], page: { ...DEFAULT_PAGE }, datePreset: 'Last 30 days', custom: null, comparison: 'previous' };
}

export function defaultName(now = new Date()): string {
  return `My report - ${now.getFullYear()} ${now.toLocaleDateString('en-US', { month: 'short' })} ${String(now.getDate()).padStart(2, '0')}`;
}

/** Whatever was stored, made whole: older or hand-edited definitions get the defaults filled in. */
export function coerceDef(raw: unknown): ReportDef {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReportDef>;
  const theme = d.theme && typeof d.theme === 'object' ? { ...THEMES[0], ...d.theme } : THEMES[0];
  const pages = Array.isArray(d.pages) && d.pages.length ? d.pages.map((p) => ({ id: p.id || uid(), title: p.title || 'Untitled page', blocks: Array.isArray(p.blocks) ? p.blocks : [] })) : blankDef().pages;
  return {
    pages, theme, page: { ...DEFAULT_PAGE, ...(d.page ?? {}) },
    datePreset: d.datePreset || 'Last 30 days', custom: d.custom ?? null, comparison: d.comparison ?? 'previous',
  };
}

// ---- demo fallback -------------------------------------------------------------

const mem = { reports: new Map<number, ReportRow>(), metrics: new Map<number, CustomMetric>(), next: 1 };
const nowIso = () => new Date().toISOString();

function rowOf(r: Report, schedule: ReportSchedule | null, names: Map<string, string>): ReportRow {
  return { ...r, definition: coerceDef(r.definition), schedule, owner_name: r.owner_id ? names.get(r.owner_id) ?? null : null };
}

// ---- reports ----------------------------------------------------------------------

export async function listReports(workspaceId: number | null, names: Map<string, string> = new Map()): Promise<ReportRow[]> {
  if (!supabase || workspaceId === null) return [...mem.reports.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const [{ data: rows }, { data: scheds }] = await Promise.all([
    supabase.from('reports').select('*').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }),
    supabase.from('report_schedules').select('*').eq('workspace_id', workspaceId),
  ]);
  const byReport = new Map((scheds ?? []).map((s) => [s.report_id, s]));
  return (rows ?? []).map((r) => rowOf(r, byReport.get(r.id) ?? null, names));
}

export async function createReport(
  workspaceId: number | null, userId: string | null, input: { name: string; definition: ReportDef; created_from: string; is_private?: boolean; is_template?: boolean },
): Promise<WriteResult<ReportRow>> {
  const base = { name: input.name.trim() || defaultName(), is_private: !!input.is_private, is_template: !!input.is_template, created_from: input.created_from };
  if (!supabase || workspaceId === null) {
    const id = mem.next++;
    const row: ReportRow = { id, workspace_id: workspaceId ?? 0, owner_id: userId, ...base, definition: input.definition, schedule: null, created_at: nowIso(), updated_at: nowIso() };
    mem.reports.set(id, row);
    return { ok: true, data: row };
  }
  const { data, error } = await supabase.from('reports').insert({ workspace_id: workspaceId, owner_id: userId, ...base, definition: input.definition as unknown as Record<string, unknown> }).select('*').single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: rowOf(data, null, new Map()) };
}

// A row that was created in memory (the demo, or no workspace) stays in memory: its id is not a database id.
const inMemory = (id: number) => mem.reports.has(id);
const metricInMemory = (id: number) => mem.metrics.has(id);

export async function updateReport(id: number, patch: Partial<{ name: string; definition: ReportDef; is_private: boolean; is_template: boolean }>): Promise<WriteResult> {
  if (!supabase || inMemory(id)) {
    const r = mem.reports.get(id);
    if (!r) return { ok: false, message: 'No such report.' };
    mem.reports.set(id, { ...r, ...patch, updated_at: nowIso() } as ReportRow);
    return { ok: true, data: undefined };
  }
  const { definition, ...rest } = patch;
  const { error } = await supabase.from('reports').update({ ...rest, ...(definition ? { definition: definition as unknown as Record<string, unknown> } : {}) }).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: undefined };
}

export async function deleteReport(id: number): Promise<WriteResult> {
  if (!supabase || inMemory(id)) { mem.reports.delete(id); return { ok: true, data: undefined }; }
  const { error } = await supabase.from('reports').delete().eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: undefined };
}

// ---- custom metrics ------------------------------------------------------------------

export async function listMetrics(workspaceId: number | null): Promise<CustomMetric[]> {
  if (!supabase || workspaceId === null) return [...mem.metrics.values()];
  const { data } = await supabase.from('custom_metrics').select('*').eq('workspace_id', workspaceId).order('name');
  return (data ?? []).map((m) => ({ ...m, formula: (Array.isArray(m.formula) ? m.formula : []) as Token[], display_format: m.display_format as MetricFormat, polarity: (m.polarity === 'down' ? 'down' : 'up') as Polarity }));
}

export async function saveMetric(
  workspaceId: number | null, userId: string | null,
  m: { id?: number | null; name: string; description: string | null; display_format: MetricFormat; formula: Token[]; polarity: Polarity },
): Promise<WriteResult<CustomMetric>> {
  const clean = { name: m.name.trim(), description: m.description?.trim() || null, display_format: m.display_format, formula: m.formula, polarity: m.polarity };
  if (!clean.name) return { ok: false, message: 'Give the metric a name.' };
  if (!supabase || workspaceId === null || (m.id != null && metricInMemory(m.id))) {
    const id = m.id ?? mem.next++;
    const row: CustomMetric = { id, workspace_id: workspaceId ?? 0, created_by: userId, created_at: nowIso(), updated_at: nowIso(), ...clean };
    mem.metrics.set(id, row);
    return { ok: true, data: row };
  }
  const payload = { ...clean, formula: clean.formula as unknown as Record<string, unknown>[] };
  const q = m.id
    ? supabase.from('custom_metrics').update(payload).eq('id', m.id).select('*').single()
    : supabase.from('custom_metrics').insert({ workspace_id: workspaceId, created_by: userId, ...payload }).select('*').single();
  const { data, error } = await q;
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: { ...data, formula: data.formula as Token[], display_format: data.display_format as MetricFormat, polarity: (data.polarity === 'down' ? 'down' : 'up') as Polarity } };
}

export async function deleteMetric(id: number): Promise<WriteResult> {
  if (!supabase || metricInMemory(id)) { mem.metrics.delete(id); return { ok: true, data: undefined }; }
  const { error } = await supabase.from('custom_metrics').delete().eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: undefined };
}

// ---- schedules -----------------------------------------------------------------------

export type ScheduleInput = {
  frequency: 'none' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';
  at_time: string; tz: string; date_preset: string; comparison: string; use_widget_dates: boolean;
  from_email: string | null; subject: string | null; recipients: string[]; message: string | null;
};

/** The range a schedule reports on when none is chosen: yesterday for a daily mail, last week for a weekly one, and so on. */
export const SCHEDULE_DEFAULT_RANGE: Record<ScheduleInput['frequency'], string> = {
  none: 'Last 30 days', daily: 'Yesterday', weekly: 'Last week', monthly: 'Last month', quarterly: 'Last quarter', annually: 'Last year',
};

export async function saveSchedule(reportId: number, workspaceId: number | null, userId: string | null, s: ScheduleInput): Promise<WriteResult<ReportSchedule | null>> {
  if (!supabase || workspaceId === null || inMemory(reportId)) {
    const r = mem.reports.get(reportId);
    if (r) mem.reports.set(reportId, { ...r, schedule: s.frequency === 'none' ? null : { report_id: reportId, workspace_id: workspaceId ?? 0, ...s, enabled: true, next_run_at: null, last_run_at: null, last_error: null, created_by: userId, updated_at: nowIso() } });
    return { ok: true, data: mem.reports.get(reportId)?.schedule ?? null };
  }
  if (s.frequency === 'none') {
    const { error } = await supabase.from('report_schedules').delete().eq('report_id', reportId);
    return error ? { ok: false, message: error.message } : { ok: true, data: null };
  }
  const recipients = [...new Set(s.recipients.map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
  if (!recipients.length) return { ok: false, message: 'Add at least one recipient.' };
  // next_run_at is computed by the mailer on its next pass (it knows the time zone rules); null means "due now, then align".
  const { data, error } = await supabase.from('report_schedules')
    .upsert({ report_id: reportId, workspace_id: workspaceId, ...s, recipients, enabled: true, next_run_at: null, last_error: null, created_by: userId }, { onConflict: 'report_id' })
    .select('*').single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data };
}

/** Emails the report to the signed-in person now, through the report-mail function. */
export async function sendTestReport(reportId: number, workspaceId: number | null, datePreset: string, comparison: string): Promise<WriteResult<{ to: string }>> {
  if (!supabase || workspaceId === null) return { ok: false, message: 'Sign in to a workspace to send email.' };
  const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; to?: string }>('report-mail', {
    body: { action: 'test', workspace_id: workspaceId, report_id: reportId, date_preset: datePreset, comparison },
  });
  if (error) return { ok: false, message: error.message };
  if (!data?.ok) return { ok: false, message: data?.error ?? 'The mailer refused that send.' };
  return { ok: true, data: { to: data.to ?? '' } };
}
