'use client';

// The report editor: a paginated, document-style canvas (a pinned cover page
// and drag-free reorderable pages), a right drawer to add widgets, elements,
// themes and custom metrics, a config panel for the selected block, and the
// global date range every widget follows unless it pins its own.

import React, { useEffect, useMemo, useState } from 'react';
import { compute, evalFormula, rangeFor, rangeLabel, type EngineRaw, type Result, type Row, type Source } from '@/lib/report-engine';
import { SUGGESTED, WIDGET_BY_KEY, type Theme, type WidgetDef } from '@/lib/report-catalog';
import { updateReport, uid, type Block, type CustomMetric, type ReportDef, type ReportPage, type ReportRow } from '@/lib/report-store';
import { DateRangePicker, compareLabelOf } from './DateRangePicker';
import { WidgetDrawer, type DrawerTab, type ElementKind } from './WidgetDrawer';
import { WidgetConfig, type Member } from './WidgetConfig';
import { WidgetView } from './WidgetView';
import { ACCENT, INK, LINE, MUTED, SOFT, Modal, Toggle, btn, eyebrow, field, popover } from './ui';

type Side = { kind: 'drawer'; tab: DrawerTab } | { kind: 'config'; blockId: string } | null;

const wideChart = (chart: string) => chart === 'table' || chart === 'line' || chart === 'column' || chart === 'funnel';

export function blockFromWidget(w: WidgetDef): Block {
  const width: 1 | 2 = wideChart(w.chart) ? 2 : 1;
  if (w.formula) return { id: uid(), kind: 'metric', key: w.key, chart: 'number', title: w.label, formula: structuredClone(w.formula), format: w.format, polarity: 'up', w: 1 };
  return { id: uid(), kind: 'widget', key: w.key, chart: w.chart, title: w.label, spec: structuredClone(w.spec), w: width };
}
export function blockFromMetric(m: CustomMetric): Block {
  return { id: uid(), kind: 'metric', key: 'custom:' + m.id, metricId: m.id, chart: 'number', title: m.name, formula: structuredClone(m.formula), format: m.display_format, polarity: m.polarity, w: 1 };
}

export function ReportEditor({ report, raw, data, members, me, workspaceName, metrics, isMobile, canEdit, onBack, onSaved, onSchedule, onNewMetric, onEditMetric, toast }: {
  report: ReportRow; raw: EngineRaw | null; data: Record<Source, Row[]> | null; members: Member[]; me: string | null; workspaceName: string; metrics: CustomMetric[];
  isMobile: boolean; canEdit: boolean; onBack: () => void; onSaved: (r: ReportRow) => void; onSchedule: (r: ReportRow) => void; onNewMetric: () => void; onEditMetric: (m: CustomMetric) => void; toast: (m: string) => void;
}) {
  const [def, setDef] = useState<ReportDef>(() => structuredClone(report.definition));
  const [name, setName] = useState(report.name);
  const [isPrivate, setPrivate] = useState(report.is_private);
  const [renaming, setRenaming] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [side, setSide] = useState<Side>(null);
  const [panel, setPanel] = useState<'pages' | 'props' | null>(null);
  const [perm, setPerm] = useState(false);
  const [moveOpen, setMoveOpen] = useState<string | null>(null);

  const patch = (fn: (d: ReportDef) => ReportDef) => { setDef((d) => fn(d)); setDirty(true); };
  const range = useMemo(() => rangeFor(def.datePreset, def.comparison, def.custom), [def.datePreset, def.comparison, def.custom]);
  const compareLabel = compareLabelOf({ preset: def.datePreset, comparison: def.comparison, custom: def.custom });
  const dates = rangeLabel(range);
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fill = (t: string) => t.replace(/\{\{date_range\}\}/g, dates).replace(/\{\{workspace\}\}/g, workspaceName).replace(/\{\{today\}\}/g, today);

  // Every block's numbers, recomputed when the definition or the data changes.
  const results = useMemo(() => {
    const out = new Map<string, Result>();
    if (!data || !raw) return out;
    for (const p of def.pages) for (const b of p.blocks) {
      if (b.kind === 'widget') out.set(b.id, compute(b.spec, range, data, raw, { me, chart: b.chart }));
      else if (b.kind === 'metric') {
        const value = evalFormula(b.formula, (spec) => compute(spec, range, data, raw, { me, chart: 'number' }).value);
        const prev = range.prevStart === null ? null : evalFormula(b.formula, (spec) => compute(spec, range, data, raw, { me, chart: 'number' }).prev);
        out.set(b.id, { value, prev, format: b.format === 'usd' ? 'usd' : b.format === 'pct' ? 'pct' : b.format === 'float' ? 'float' : 'int', groups: null, series: null, table: null, funnel: null, n: 0 });
      }
    }
    return out;
  }, [def.pages, range, data, raw, me]);

  // Escape closes whatever is open; Cmd/Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSide(null); setPanel(null); setPerm(false); setMoveOpen(null); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selected = side?.kind === 'config' ? def.pages.flatMap((p) => p.blocks).find((b) => b.id === side.blockId) ?? null : null;

  const addBlock = (b: Block, pageId?: string) => {
    if (!canEdit) return toast('Only the owner or an admin can edit this report.');
    const target = pageId ?? def.pages[0]?.id;
    patch((d) => ({ ...d, pages: d.pages.map((p) => (p.id === target ? { ...p, blocks: [...p.blocks, b] } : p)) }));
    setSide({ kind: 'config', blockId: b.id });
  };
  const addElement = (k: ElementKind, pageId?: string) => addBlock({ id: uid(), kind: 'element', element: k, text: k === 'title' ? 'Section title' : k === 'text' ? 'Write a note for whoever reads this.' : '', w: 2 }, pageId);
  const setBlock = (b: Block) => patch((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, blocks: p.blocks.map((x) => (x.id === b.id ? b : x)) })) }));
  const removeBlock = (id: string) => { patch((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, blocks: p.blocks.filter((x) => x.id !== id) })) })); if (side?.kind === 'config' && side.blockId === id) setSide(null); };
  const moveBlock = (id: string, dir: -1 | 1) => patch((d) => ({ ...d, pages: d.pages.map((p) => { const i = p.blocks.findIndex((b) => b.id === id); if (i < 0 || i + dir < 0 || i + dir >= p.blocks.length) return p; const bs = [...p.blocks]; [bs[i], bs[i + dir]] = [bs[i + dir], bs[i]]; return { ...p, blocks: bs }; }) }));
  const moveBlockToPage = (id: string, pageId: string) => patch((d) => { const b = d.pages.flatMap((p) => p.blocks).find((x) => x.id === id); if (!b) return d; return { ...d, pages: d.pages.map((p) => ({ ...p, blocks: p.id === pageId ? [...p.blocks.filter((x) => x.id !== id), b] : p.blocks.filter((x) => x.id !== id) })) }; });
  const addPage = () => patch((d) => ({ ...d, pages: [...d.pages, { id: uid(), title: 'Untitled page', blocks: [] }] }));
  const renamePage = (id: string, title: string) => patch((d) => ({ ...d, pages: d.pages.map((p) => (p.id === id ? { ...p, title } : p)) }));
  const movePage = (id: string, dir: -1 | 1) => patch((d) => { const i = d.pages.findIndex((p) => p.id === id); if (i < 0 || i + dir < 0 || i + dir >= d.pages.length) return d; const ps = [...d.pages]; [ps[i], ps[i + dir]] = [ps[i + dir], ps[i]]; return { ...d, pages: ps }; });
  const removePage = (id: string) => { if (def.pages.length <= 1) return toast('A report keeps at least one page.'); if (!window.confirm('Remove this page and its widgets?')) return; patch((d) => ({ ...d, pages: d.pages.filter((p) => p.id !== id) })); };

  async function save() {
    if (!canEdit) return toast('Only the owner or an admin can edit this report.');
    setSaving(true);
    const r = await updateReport(report.id, { name: name.trim() || report.name, definition: def, is_private: isPrivate });
    setSaving(false);
    if (!r.ok) return toast(r.message);
    setDirty(false);
    onSaved({ ...report, name: name.trim() || report.name, definition: def, is_private: isPrivate, updated_at: new Date().toISOString() });
    toast('Report saved');
  }
  const download = () => {
    document.body.classList.add('report-printing');
    const done = () => { document.body.classList.remove('report-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 60_000);
  };
  const leave = () => { if (dirty && !window.confirm('Leave without saving? Your changes to this report are lost.')) return; onBack(); };

  const theme: Theme = def.theme;
  const cols = isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))';
  const sideStyle: React.CSSProperties = isMobile ? { position: 'fixed', inset: 0, zIndex: 50, display: 'flex' } : { display: 'contents' };

  const blockCard = (b: Block, page: ReportPage) => {
    const r = results.get(b.id);
    const isSel = side?.kind === 'config' && side.blockId === b.id;
    const polarity = b.kind === 'widget' ? b.spec.polarity ?? 'up' : b.kind === 'metric' ? b.polarity : 'up';
    const span = { gridColumn: !isMobile && b.w === 2 ? '1 / -1' : undefined };
    if (b.kind === 'element') {
      return (
        <div key={b.id} style={{ ...span, position: 'relative', outline: isSel ? `2px solid ${ACCENT}` : 'none', borderRadius: '10px' }} className="report-block">
          {b.element === 'title' ? <h3 style={{ margin: '6px 0 0', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.01em', color: theme.title }}>{fill(b.text) || 'Section title'}</h3>
            : b.element === 'text' ? <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: '#3f3f46', whiteSpace: 'pre-wrap' }}>{fill(b.text)}</p>
              : b.element === 'image' ? (b.text ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={b.text} alt="" style={{ maxWidth: '100%', borderRadius: '8px', display: 'block' }} /> : <div style={{ padding: '24px', border: `1px dashed ${LINE}`, borderRadius: '8px', color: MUTED, fontSize: '12.5px', textAlign: 'center' }}>Image URL goes in the panel →</div>)
                : (b.text ? <iframe src={b.text} title="Embedded page" style={{ width: '100%', height: '320px', border: `1px solid ${LINE}`, borderRadius: '8px' }} /> : <div style={{ padding: '24px', border: `1px dashed ${LINE}`, borderRadius: '8px', color: MUTED, fontSize: '12.5px', textAlign: 'center' }}>Embed URL goes in the panel →</div>)}
          {canEdit ? blockTools(b, page) : null}
        </div>
      );
    }
    return (
      <div key={b.id} className="report-block" style={{ ...span, position: 'relative', background: '#fff', border: `1px solid ${isSel ? ACCENT : LINE}`, boxShadow: isSel ? `0 0 0 1px ${ACCENT}` : 'none', borderRadius: '10px', padding: '12px 14px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#52525b', letterSpacing: '.01em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fill(b.title)}</span>
          {b.kind === 'widget' && b.spec.datePreset ? <span style={{ fontSize: '10.5px', color: MUTED, whiteSpace: 'nowrap' }}>{b.spec.datePreset}</span> : null}
        </div>
        {r ? <WidgetView chart={b.chart} result={r} theme={theme} polarity={polarity} compareLabel={compareLabel} compact={isMobile} /> : <div style={{ fontSize: '12.5px', color: MUTED, padding: '8px 0' }}>{raw ? 'Computing…' : 'Loading the workspace…'}</div>}
        {canEdit ? blockTools(b, page) : null}
      </div>
    );
  };

  const blockTools = (b: Block, page: ReportPage) => (
    <div data-no-print className="report-block-tools" style={{ position: 'absolute', top: '6px', right: '6px', display: 'flex', gap: '2px', background: '#fff', border: `1px solid ${LINE}`, borderRadius: '8px', padding: '2px', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
      <button type="button" onClick={() => setSide({ kind: 'config', blockId: b.id })} title="Configure" aria-label="Configure" style={tool}>⚙</button>
      {b.kind !== 'element' || b.element !== 'title' ? <button type="button" onClick={() => setBlock({ ...b, w: b.w === 2 ? 1 : 2 })} title={b.w === 2 ? 'Half width' : 'Full width'} aria-label="Toggle width" style={tool}>⇔</button> : null}
      <button type="button" onClick={() => moveBlock(b.id, -1)} title="Move up" aria-label="Move up" style={tool}>↑</button>
      <button type="button" onClick={() => moveBlock(b.id, 1)} title="Move down" aria-label="Move down" style={tool}>↓</button>
      {def.pages.length > 1 ? (
        <span style={{ position: 'relative' }}>
          <button type="button" onClick={() => setMoveOpen(moveOpen === b.id ? null : b.id)} title="Move to page" aria-label="Move to page" style={tool}>⇢</button>
          {moveOpen === b.id ? (
            <div style={{ ...popover, right: 0, width: '180px', padding: '6px' }}>
              {def.pages.filter((p) => p.id !== page.id).map((p) => <button key={p.id} type="button" onClick={() => { moveBlockToPage(b.id, p.id); setMoveOpen(null); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 0, background: 'none', fontSize: '12.5px', cursor: 'pointer', borderRadius: '6px' }} className="dc2">{p.title}</button>)}
            </div>
          ) : null}
        </span>
      ) : null}
      <button type="button" onClick={() => removeBlock(b.id)} title="Remove" aria-label="Remove" style={{ ...tool, color: '#b91c1c' }}>×</button>
    </div>
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Top bar */}
      <div data-no-print style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', background: '#fff', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
        <button type="button" onClick={leave} style={btn.ghost}>← Back</button>
        {renaming ? (
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} onBlur={() => setRenaming(false)} onKeyDown={(e) => { if (e.key === 'Enter') setRenaming(false); }} aria-label="Report name" style={{ ...field, width: '280px', fontWeight: 700 }} />
        ) : (
          <button type="button" onClick={() => canEdit && setRenaming(true)} title="Rename" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', border: 0, background: 'none', cursor: canEdit ? 'text' : 'default', fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em', color: INK, padding: '0 4px', minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isMobile ? '160px' : '420px' }}>{name}</span>
            {canEdit ? <span aria-hidden style={{ color: MUTED, fontSize: '12px' }}>✎</span> : null}
          </button>
        )}
        {dirty ? <span style={{ fontSize: '11px', color: MUTED }}>Unsaved</span> : null}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={download} title="Download as PDF" style={btn.ghost}>Download</button>
        <button type="button" onClick={leave} style={btn.ghost}>Cancel</button>
        {canEdit ? <button type="button" onClick={() => void save()} disabled={saving} style={btn.primary}>{saving ? 'Saving…' : 'Save'}</button> : null}
        <button type="button" onClick={() => { if (dirty) void save(); onSchedule({ ...report, name, definition: def, is_private: isPrivate }); }} style={btn.accent}>Send or schedule</button>
      </div>

      {/* Toolbar */}
      <div data-no-print style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', background: '#fff', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
        {canEdit ? <button type="button" onClick={() => setSide(side?.kind === 'drawer' ? null : { kind: 'drawer', tab: 'widgets' })} style={{ ...btn.primary, background: side?.kind === 'drawer' ? '#27272a' : INK }}>+ Add widget</button> : null}
        <button type="button" onClick={() => setPerm(true)} style={btn.ghost}>Manage permissions</button>
        <span style={{ position: 'relative' }}>
          <button type="button" onClick={() => setPanel(panel === 'pages' ? null : 'pages')} aria-expanded={panel === 'pages'} style={btn.ghost}>Page list</button>
          {panel === 'pages' ? (
            <div style={{ ...popover, left: 0, width: '300px' }}>
              <span style={eyebrow}>Pages</span>
              {def.page.showCover ? <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 4px', fontSize: '12.5px', color: MUTED }}><span aria-hidden>📌</span> Cover page <span style={{ marginLeft: 'auto', fontSize: '11px' }}>pinned</span></div> : null}
              {def.pages.map((p, i) => (
                <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '4px', alignItems: 'center', padding: '3px 0' }}>
                  <input value={p.title} onChange={(e) => renamePage(p.id, e.target.value)} disabled={!canEdit} aria-label="Page title" style={{ ...field, height: '28px' }} />
                  <button type="button" disabled={!canEdit || i === 0} onClick={() => movePage(p.id, -1)} aria-label="Move page up" style={{ ...btn.icon, width: '26px', height: '26px' }}>↑</button>
                  <button type="button" disabled={!canEdit || i === def.pages.length - 1} onClick={() => movePage(p.id, 1)} aria-label="Move page down" style={{ ...btn.icon, width: '26px', height: '26px' }}>↓</button>
                  <button type="button" disabled={!canEdit} onClick={() => removePage(p.id)} aria-label="Remove page" style={{ ...btn.icon, width: '26px', height: '26px', color: '#b91c1c' }}>×</button>
                </div>
              ))}
              {canEdit ? <button type="button" onClick={addPage} style={{ ...btn.ghost, marginTop: '6px', width: '100%' }}>+ Add page</button> : null}
            </div>
          ) : null}
        </span>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <DateRangePicker value={{ preset: def.datePreset, custom: def.custom, comparison: def.comparison }} onChange={(v) => patch((d) => ({ ...d, datePreset: v.preset || 'Last 30 days', custom: v.custom, comparison: v.comparison }))} />
        </div>
        <span style={{ position: 'relative' }}>
          <button type="button" onClick={() => setPanel(panel === 'props' ? null : 'props')} aria-expanded={panel === 'props'} title="Page properties" style={btn.ghost}>Page properties</button>
          {panel === 'props' ? (
            <div style={{ ...popover, right: 0, width: '300px' }}>
              <span style={eyebrow}>Configure pages</span>
              <label style={{ display: 'block', marginBottom: '8px' }}><span style={{ fontSize: '12px', color: MUTED }}>Logo image URL</span><input value={def.page.logoUrl ?? ''} onChange={(e) => patch((d) => ({ ...d, page: { ...d.page, logoUrl: e.target.value || null } }))} placeholder="https://…/logo.png" style={{ ...field, marginTop: '3px' }} /></label>
              <Toggle on={def.page.showTitle} onChange={(v) => patch((d) => ({ ...d, page: { ...d.page, showTitle: v } }))} label="Show title" />
              <Toggle on={def.page.showDate} onChange={(v) => patch((d) => ({ ...d, page: { ...d.page, showDate: v } }))} label="Show date" />
              <Toggle on={def.page.showDivider} onChange={(v) => patch((d) => ({ ...d, page: { ...d.page, showDivider: v } }))} label="Show divider" />
              <Toggle on={def.page.showCover} onChange={(v) => patch((d) => ({ ...d, page: { ...d.page, showCover: v } }))} label="Show cover page" />
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12.5px' }}>Page background<input type="color" value={def.page.background} onChange={(e) => patch((d) => ({ ...d, page: { ...d.page, background: e.target.value } }))} aria-label="Page background color" style={{ width: '34px', height: '24px', border: `1px solid ${LINE}`, borderRadius: '6px', padding: 0 }} /><span style={{ color: MUTED, fontSize: '11.5px' }}>{def.page.background.toUpperCase()}</span></label>
            </div>
          ) : null}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Canvas */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: isMobile ? '12px 10px 60px' : '20px 24px 60px', background: '#f4f4f5' }} onClick={() => { setPanel(null); setMoveOpen(null); }}>
          <div data-report-print style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {def.page.showCover ? (
              <section data-report-page style={{ background: def.page.background, border: `1px solid ${LINE}`, borderRadius: '12px', padding: isMobile ? '28px 20px' : '64px 48px', boxShadow: '0 1px 3px rgba(0,0,0,.05)', minHeight: isMobile ? undefined : '300px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '10px' }}>
                {def.page.logoUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={def.page.logoUrl} alt="" style={{ height: '40px', width: 'auto', alignSelf: 'flex-start', marginBottom: 'auto' }} /> : <span style={{ fontSize: '11.5px', color: MUTED, fontWeight: 700, marginBottom: 'auto' }}>{workspaceName}</span>}
                <h2 style={{ margin: 0, fontSize: isMobile ? '24px' : '34px', fontWeight: 700, letterSpacing: '-0.03em', color: theme.title }}>{name}</h2>
                <div style={{ fontSize: '13px', color: MUTED }}>{dates}{compareLabel ? ` · compared with the ${compareLabel}` : ''}</div>
              </section>
            ) : null}
            {def.pages.map((p) => (
              <section key={p.id} data-report-page style={{ background: def.page.background, border: `1px solid ${LINE}`, borderRadius: '12px', padding: isMobile ? '16px 12px' : '24px 28px', boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}>
                {def.page.showTitle || def.page.showDate ? (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', paddingBottom: '12px', marginBottom: '14px', borderBottom: def.page.showDivider ? `1px solid ${SOFT}` : 0 }}>
                    {def.page.logoUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={def.page.logoUrl} alt="" style={{ height: '22px', width: 'auto' }} /> : null}
                    {def.page.showTitle ? <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em', color: theme.title, flex: 1 }}>{p.title}</h3> : <span style={{ flex: 1 }} />}
                    {def.page.showDate ? <span style={{ fontSize: '12px', color: MUTED, whiteSpace: 'nowrap' }}>{dates}</span> : null}
                  </div>
                ) : null}
                {!p.blocks.length ? (
                  <div style={{ padding: '32px 16px', textAlign: 'center', border: `1px dashed ${LINE}`, borderRadius: '10px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: INK }}>Let&rsquo;s enhance this report by adding a widget</div>
                    {canEdit ? (
                      <div data-no-print style={{ display: 'flex', gap: '8px', justifyContent: 'center', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => setSide({ kind: 'drawer', tab: 'widgets' })} style={btn.primary}>Add widget</button>
                        <span style={{ fontSize: '12px', color: MUTED }}>or</span>
                        <button type="button" onClick={() => { patch((d) => ({ ...d, pages: d.pages.map((x) => (x.id === p.id ? { ...x, blocks: SUGGESTED.map((k) => WIDGET_BY_KEY[k]).filter(Boolean).map(blockFromWidget) } : x)) })); }} style={btn.ghost}>Use suggested widgets</button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '12px', alignItems: 'start' }}>
                    {p.blocks.map((b) => blockCard(b, p))}
                  </div>
                )}
                {canEdit && p.blocks.length ? <div data-no-print style={{ marginTop: '12px', display: 'flex', gap: '6px' }}><button type="button" onClick={() => setSide({ kind: 'drawer', tab: 'widgets' })} style={btn.plain}>+ Add widget to this page</button><button type="button" onClick={() => addElement('title', p.id)} style={btn.plain}>+ Title</button><button type="button" onClick={() => addElement('text', p.id)} style={btn.plain}>+ Text</button></div> : null}
              </section>
            ))}
            {canEdit ? <button data-no-print type="button" onClick={addPage} style={{ ...btn.ghost, alignSelf: 'center' }}>+ Add page</button> : null}
            {raw && raw.sellers.length === 0 && raw.deals.length === 0 ? <p data-no-print style={{ fontSize: '12px', color: MUTED, textAlign: 'center' }}>The workspace has no rows yet, so every widget reads zero.</p> : null}
          </div>
        </div>

        {/* Side panels */}
        {side?.kind === 'drawer' ? (
          <div style={sideStyle}>
            <WidgetDrawer tab={side.tab} setTab={(tab) => setSide({ kind: 'drawer', tab })} theme={def.theme} onTheme={(t) => patch((d) => ({ ...d, theme: t }))} metrics={metrics}
              onAddWidget={(w) => addBlock(blockFromWidget(w))} onAddElement={(k) => addElement(k)} onAddMetric={(m) => addBlock(blockFromMetric(m))} onNewMetric={onNewMetric} onEditMetric={onEditMetric} onClose={() => setSide(null)} />
          </div>
        ) : null}
        {selected ? (
          <div style={sideStyle}>
            <WidgetConfig block={selected} members={members} onChange={setBlock} onClose={() => setSide(null)} onDelete={() => removeBlock(selected.id)}
              onEditFormula={selected.kind === 'metric' && selected.metricId ? () => { const m = metrics.find((x) => x.id === selected.metricId); if (m) onEditMetric(m); } : undefined} />
          </div>
        ) : null}
      </div>

      {perm ? (
        <Modal title="Manage permissions" onClose={() => setPerm(false)} width={460}>
          <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: MUTED }}>Specify who can access this report.</p>
          <Toggle on={isPrivate} onChange={(v) => { setPrivate(v); setDirty(true); }} label="Private report" sub="Set up this report so only you can see it. It won't be visible to other team members. Owners and admins of the workspace can still edit any report that is not private." />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}><button type="button" onClick={() => setPerm(false)} style={btn.primary}>Done</button></div>
        </Modal>
      ) : null}
    </div>
  );
}

const tool: React.CSSProperties = { width: '24px', height: '24px', border: 0, background: 'none', borderRadius: '5px', cursor: 'pointer', color: '#52525b', fontSize: '12px', display: 'inline-grid', placeItems: 'center' };
