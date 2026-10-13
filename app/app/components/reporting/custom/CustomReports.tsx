'use client';

// Reporting → Custom reports: the list of saved reports and the doors into the
// editor, the schedule page and the custom metric builder. Data is the same
// ReportRaw the fixed tabs read, normalised once for the engine.

import React, { useEffect, useMemo, useState } from 'react';
import { normalize, rangeFor, type EngineRaw, type Source, type Row } from '@/lib/report-engine';
import { TEMPLATES, WIDGET_BY_KEY } from '@/lib/report-catalog';
import { blankDef, createReport, defaultName, deleteReport, deleteMetric, listMetrics, listReports, saveMetric, updateReport, uid, type CustomMetric, type ReportDef, type ReportRow } from '@/lib/report-store';
import { useSession } from '@/lib/session';
import { MetricBuilder } from './MetricBuilder';
import { ReportEditor, blockFromWidget } from './ReportEditor';
import { SchedulePage } from './SchedulePage';
import { TemplateLibrary, defFromTemplate } from './TemplateLibrary';
import { ACCENT, INK, LINE, MUTED, SOFT, Modal, Toggle, btn, card, field } from './ui';

type View = { kind: 'list' } | { kind: 'edit'; id: number } | { kind: 'schedule'; id: number } | { kind: 'metric'; metric: CustomMetric | null; back: View };

/** "Import from existing dashboard": the fixed Reporting tabs, as starting sets of widgets. */
const DASHBOARD_IMPORTS: Record<string, string[] | { template: string }> = {
  Overview: { template: 'scoreboard' },
  Acquisitions: ['sellers.count', 'appointments.count', 'offers.sent', 'deals.under_contract', 'sellers.by_stage', 'sellers.by_assigned', 'sellers.over_time'],
  'Lead Sources': ['sellers.by_source', 'sellers.top_sources', 'deals.by_lead_source', 'general.lead_to_contract'],
  Calls: { template: 'call-statistics' },
  Team: { template: 'leaderboard' },
  Offers: ['offers.sent', 'offers.accepted', 'general.offer_acceptance', 'offers.by_outcome', 'offers.received', 'offers.avg_vs_asking', 'offers.over_time'],
  Contracts: ['contracts.sent', 'contracts.signed', 'contracts.hours_to_sign', 'contracts.by_status', 'contracts.by_kind', 'contracts.by_provider'],
  Dispo: { template: 'dispo' },
  Buyers: ['buyers.total', 'buyers.active', 'buyers.vip', 'buyers.dormant', 'buyers.added_over_time', 'buyers.recent_activity'],
  Closings: ['deals.won', 'deals.won_value', 'deals.days_to_close', 'deals.avg_spread', 'deals.fee_over_time'],
  Marketing: ['blasts.sent', 'blasts.viewed', 'blasts.replied', 'general.blast_reply_rate', 'sellers.by_source', 'blasts.over_time'],
  Profitability: ['deals.won_value', 'deals.avg_fee', 'deals.total_spread', 'deals.fee_by_dispo_rep', 'deals.fee_over_time'],
};

function defFromDashboard(tab: string): ReportDef {
  const spec = DASHBOARD_IMPORTS[tab];
  if (spec && !Array.isArray(spec)) { const t = TEMPLATES.find((x) => x.id === spec.template); if (t) return defFromTemplate(t); }
  const keys = Array.isArray(spec) ? spec : DASHBOARD_IMPORTS.Acquisitions as string[];
  const def = blankDef();
  def.pages[0] = { id: uid(), title: tab, blocks: keys.map((k) => WIDGET_BY_KEY[k]).filter(Boolean).map(blockFromWidget) };
  return def;
}

const badge = (freq: string | null | undefined): React.CSSProperties => ({ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px', background: freq ? '#E7F8F1' : SOFT, color: freq ? ACCENT : MUTED, whiteSpace: 'nowrap' });

export function CustomReports({ raw, workspaceId, workspaceName, admin, isMobile, toast }: {
  raw: EngineRaw | null; workspaceId: number | null; workspaceName: string; admin: boolean; isMobile: boolean; toast: (m: string) => void;
}) {
  const session = useSession();
  const me = session.user?.id ?? null;
  const myEmail = session.user?.email ?? null;
  const members = useMemo(() => (raw?.members ?? []).map((m) => ({ id: m.id, name: m.name })), [raw]);
  const names = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const data = useMemo<Record<Source, Row[]> | null>(() => (raw ? normalize(raw) : null), [raw]);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [metrics, setMetrics] = useState<CustomMetric[]>([]);
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [library, setLibrary] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [permFor, setPermFor] = useState<ReportRow | null>(null);
  const [cloneFrom, setCloneFrom] = useState<string>('');
  const [importFrom, setImportFrom] = useState<string>('Overview');

  useEffect(() => {
    let live = true;
    void Promise.all([listReports(workspaceId, names), listMetrics(workspaceId)]).then(([r, m]) => { if (!live) return; setReports(r); setMetrics(m); });
    return () => { live = false; };
  }, [workspaceId, names, nonce]);
  const reload = () => setNonce((n) => n + 1);

  const canEdit = (r: ReportRow) => admin || !r.owner_id || r.owner_id === me || !session.user;
  const mine = (reports ?? []).filter((r) => r.is_template);
  const listed = (reports ?? []).filter((r) => !r.is_template && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  const PER = 15;
  const pageRows = listed.slice(page * PER, page * PER + PER);

  async function create(name: string, definition: ReportDef, from: string) {
    const r = await createReport(workspaceId, me, { name, definition, created_from: from });
    if (!r.ok) return toast(r.message);
    setNewOpen(false); setLibrary(false);
    setReports((rs) => [{ ...r.data, owner_name: me ? names.get(me) ?? null : null }, ...(rs ?? [])]);
    setView({ kind: 'edit', id: r.data.id });
  }
  async function clone(r: ReportRow) {
    await create(r.name + ' (copy)', structuredClone(r.definition), 'clone');
  }
  async function remove(r: ReportRow) {
    if (!window.confirm(`Delete "${r.name}"? Its schedule goes with it.`)) return;
    const res = await deleteReport(r.id);
    if (!res.ok) return toast(res.message);
    setReports((rs) => (rs ?? []).filter((x) => x.id !== r.id));
    toast('Report deleted');
  }
  async function saveAsTemplate(r: ReportRow) {
    const res = await createReport(workspaceId, me, { name: r.name + ' (template)', definition: structuredClone(r.definition), created_from: 'clone', is_template: true });
    if (!res.ok) return toast(res.message);
    reload(); toast('Saved to My templates');
  }
  async function setPrivate(r: ReportRow, v: boolean) {
    const res = await updateReport(r.id, { is_private: v });
    if (!res.ok) return toast(res.message);
    setReports((rs) => (rs ?? []).map((x) => (x.id === r.id ? { ...x, is_private: v } : x)));
    setPermFor((p) => (p && p.id === r.id ? { ...p, is_private: v } : p));
  }
  const onSaved = (r: ReportRow) => setReports((rs) => (rs ?? []).map((x) => (x.id === r.id ? { ...x, ...r } : x)));

  const current = view.kind === 'edit' || view.kind === 'schedule' ? (reports ?? []).find((r) => r.id === view.id) ?? null : null;
  const editorRange = current ? rangeFor(current.definition.datePreset, current.definition.comparison, current.definition.custom) : rangeFor('Last 30 days', 'previous');

  if (view.kind === 'metric') {
    return (
      <MetricBuilder initial={view.metric} data={data} raw={raw} range={editorRange} me={me} members={members}
        onCancel={() => setView(view.back)}
        onDelete={view.metric ? async () => { if (!window.confirm('Delete this custom metric? Reports keep their own copy of its formula.')) return; const r = await deleteMetric(view.metric!.id); if (!r.ok) return toast(r.message); reload(); setView(view.back); } : undefined}
        onSave={async (m) => { const r = await saveMetric(workspaceId, me, m); if (!r.ok) return toast(r.message); toast(m.id ? 'Metric updated' : 'Metric created'); reload(); setView(view.back); }} />
    );
  }
  if (view.kind === 'edit' && current) {
    return (
      <ReportEditor key={current.id} report={current} raw={raw} data={data} members={members} me={me} workspaceName={workspaceName} metrics={metrics} isMobile={isMobile} canEdit={canEdit(current)}
        onBack={() => setView({ kind: 'list' })} onSaved={onSaved} onSchedule={(r) => { onSaved(r); setView({ kind: 'schedule', id: r.id }); }}
        onNewMetric={() => setView({ kind: 'metric', metric: null, back: view })} onEditMetric={(m) => setView({ kind: 'metric', metric: m, back: view })} toast={toast} />
    );
  }
  if (view.kind === 'schedule' && current) {
    return <SchedulePage report={current} workspaceId={workspaceId} userId={me} myEmail={myEmail} onBack={() => setView({ kind: 'edit', id: current.id })} onSaved={onSaved} toast={toast} />;
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: isMobile ? '12px' : '16px 20px 40px', overflow: 'auto', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>Custom reports</div>
            <div style={{ fontSize: '12.5px', color: MUTED }}>Built for the way a wholesale shop runs: leads in, appointments set, offers out, contracts signed, deals assigned, fees earned — pick the widgets, pick the range, schedule the email.</div>
          </div>
          <div style={{ flex: 1 }} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search reports" aria-label="Search reports" style={{ ...field, width: isMobile ? '100%' : '220px' }} />
          <button type="button" onClick={() => setNewOpen(true)} style={btn.accent}>+ New report</button>
        </div>

        <div style={{ ...card, overflow: 'hidden' }}>
          {reports === null ? <div style={{ padding: '22px 16px', fontSize: '12.5px', color: MUTED }}>Loading reports…</div>
            : !listed.length ? (
              <div style={{ padding: '36px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: INK }}>{q ? 'No report matches.' : 'No custom reports yet'}</div>
                {!q ? <p style={{ margin: '6px auto 14px', fontSize: '12.5px', color: MUTED, maxWidth: '460px', lineHeight: 1.5 }}>Start from the Weekly Wholesale Scoreboard, the Rep Leaderboard or the Dispo Performance template, or build one widget at a time.</p> : null}
                {!q ? <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}><button type="button" onClick={() => setLibrary(true)} style={btn.primary}>Browse templates</button><button type="button" onClick={() => void create(defaultName(), blankDef(), 'blank')} style={btn.ghost}>Create a blank report</button></div> : null}
              </div>
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12.5px', minWidth: '640px' }}>
                  <thead>
                    <tr>{['Report name', 'Schedule', 'Created at', 'Created by', ''].map((h) => <th key={h} style={{ textAlign: 'left', padding: '0 14px', height: '36px', background: '#fafafa', borderBottom: `1px solid ${LINE}`, fontSize: '11px', color: MUTED, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr key={r.id} className="dc2" style={{ cursor: 'pointer' }}>
                        <td onClick={() => setView({ kind: 'edit', id: r.id })} style={{ padding: '0 14px', height: '46px', borderBottom: `1px solid ${SOFT}` }}>
                          <span style={{ fontWeight: 600, color: INK }}>{r.name}</span>
                          {r.is_private ? <span style={{ ...badge(null), marginLeft: '8px' }}>Private</span> : null}
                          <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{r.definition.pages.length} page{r.definition.pages.length === 1 ? '' : 's'} · {r.definition.pages.reduce((n, p) => n + p.blocks.length, 0)} widgets · {r.definition.datePreset}</span>
                        </td>
                        <td onClick={() => setView({ kind: 'schedule', id: r.id })} style={{ padding: '0 14px', borderBottom: `1px solid ${SOFT}` }}><span style={badge(r.schedule?.frequency)}>{r.schedule ? r.schedule.frequency : 'Not scheduled'}</span></td>
                        <td onClick={() => setView({ kind: 'edit', id: r.id })} style={{ padding: '0 14px', borderBottom: `1px solid ${SOFT}`, color: '#52525b', whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                        <td onClick={() => setView({ kind: 'edit', id: r.id })} style={{ padding: '0 14px', borderBottom: `1px solid ${SOFT}`, color: '#52525b', whiteSpace: 'nowrap' }}>{r.created_from === 'template' ? (r.owner_name ?? names.get(r.owner_id ?? '') ?? 'Template Library') : r.owner_name ?? names.get(r.owner_id ?? '') ?? '—'}</td>
                        <td style={{ padding: '0 10px', borderBottom: `1px solid ${SOFT}`, textAlign: 'right', position: 'relative', width: '48px' }}>
                          <button type="button" onClick={(e) => { e.stopPropagation(); setMenu(menu === r.id ? null : r.id); }} aria-label="Actions" aria-haspopup="menu" style={{ ...btn.icon, border: 0, fontSize: '16px' }}>⋯</button>
                          {menu === r.id ? (
                            <div role="menu" onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', right: '10px', top: '40px', zIndex: 30, background: '#fff', border: `1px solid ${LINE}`, borderRadius: '10px', boxShadow: '0 12px 32px rgba(0,0,0,.12)', padding: '6px', width: '190px', textAlign: 'left' }}>
                              {[
                                ['Manage permissions', () => { setPermFor(r); setMenu(null); }, canEdit(r)],
                                ['Send or schedule', () => { setMenu(null); setView({ kind: 'schedule', id: r.id }); }, true],
                                ['Clone', () => { setMenu(null); void clone(r); }, true],
                                ['Save as template', () => { setMenu(null); void saveAsTemplate(r); }, true],
                                ['Delete', () => { setMenu(null); void remove(r); }, canEdit(r)],
                              ].map(([label, go, ok]) => (
                                <button key={label as string} type="button" role="menuitem" disabled={!ok} onClick={go as () => void} className="dc2" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', border: 0, background: 'none', borderRadius: '7px', fontSize: '12.5px', cursor: ok ? 'pointer' : 'not-allowed', color: label === 'Delete' ? '#b91c1c' : ok ? INK : '#a1a1aa' }}>{label as string}</button>
                              ))}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {listed.length > PER ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', fontSize: '12px', color: MUTED }}>
                    <span>Rows per page: {PER} · {page * PER + 1}–{Math.min(listed.length, page * PER + PER)} of {listed.length}</span>
                    <div style={{ flex: 1 }} />
                    <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} style={btn.ghost}>‹</button>
                    <button type="button" disabled={page * PER + PER >= listed.length} onClick={() => setPage(page + 1)} style={btn.ghost}>›</button>
                  </div>
                ) : null}
              </div>
            )}
        </div>
        {metrics.length ? <p style={{ fontSize: '12px', color: MUTED, marginTop: '10px' }}>{metrics.length} custom metric{metrics.length === 1 ? '' : 's'} on this workspace — add them from a report&rsquo;s Custom metrics tab.</p> : null}
      </div>

      {newOpen ? (
        <Modal title="Report source" onClose={() => setNewOpen(false)} width={520}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              ['Create a blank report', 'Start fresh with a clean slate', () => void create(defaultName(), blankDef(), 'blank')],
              ['From template library', 'Use a ready-made template from the library or one of yours', () => { setNewOpen(false); setLibrary(true); }],
            ].map(([t, sub, go]) => (
              <button key={t as string} type="button" onClick={go as () => void} className="dc2" style={{ textAlign: 'left', padding: '12px 14px', border: `1px solid ${LINE}`, borderRadius: '10px', background: '#fff', cursor: 'pointer' }}>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: INK }}>{t as string}</span>
                <span style={{ display: 'block', fontSize: '12px', color: MUTED }}>{sub as string}</span>
              </button>
            ))}
            <div style={{ padding: '12px 14px', border: `1px solid ${LINE}`, borderRadius: '10px' }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: INK }}>Clone existing report</span>
              <span style={{ display: 'block', fontSize: '12px', color: MUTED, marginBottom: '8px' }}>Make a copy of one of your reports</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <select value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)} aria-label="Report to clone" style={field}><option value="">Pick a report</option>{(reports ?? []).filter((r) => !r.is_template).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                <button type="button" disabled={!cloneFrom} onClick={() => { const r = (reports ?? []).find((x) => String(x.id) === cloneFrom); if (r) void clone(r); }} style={btn.primary}>Clone</button>
              </div>
            </div>
            <div style={{ padding: '12px 14px', border: `1px solid ${LINE}`, borderRadius: '10px' }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: INK }}>Import from existing dashboard</span>
              <span style={{ display: 'block', fontSize: '12px', color: MUTED, marginBottom: '8px' }}>Start from one of the fixed Reporting tabs as widgets you can rearrange</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <select value={importFrom} onChange={(e) => setImportFrom(e.target.value)} aria-label="Dashboard to import" style={field}>{Object.keys(DASHBOARD_IMPORTS).map((t) => <option key={t} value={t}>{t}</option>)}</select>
                <button type="button" onClick={() => void create(importFrom + ' report', defFromDashboard(importFrom), 'dashboard')} style={btn.primary}>Import</button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
      {library ? <TemplateLibrary mine={mine} onChoose={(def, name, from) => void create(name, def, from)} onClose={() => setLibrary(false)} /> : null}
      {permFor ? (
        <Modal title="Manage permissions" onClose={() => setPermFor(null)} width={460}>
          <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: MUTED }}>Specify who can access &ldquo;{permFor.name}&rdquo;.</p>
          <Toggle on={permFor.is_private} onChange={(v) => void setPrivate(permFor, v)} label="Private report" sub="Set up this report so only you can see it. It won't be visible to other team members." />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}><button type="button" onClick={() => setPermFor(null)} style={btn.primary}>Done</button></div>
        </Modal>
      ) : null}
    </div>
  );
}
