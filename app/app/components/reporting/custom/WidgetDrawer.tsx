'use client';

// The add-widget drawer: prebuilt widgets by category (searchable, filtered by
// chart type), static elements, the theme, and the workspace's custom metrics.

import React, { useMemo, useState } from 'react';
import type { Chart } from '@/lib/report-engine';
import { CATEGORIES, CHART_LABEL, THEMES, WIDGETS, type Theme, type WidgetDef } from '@/lib/report-catalog';
import type { CustomMetric } from '@/lib/report-store';
import { ACCENT, INK, LINE, MUTED, SOFT, btn, eyebrow, field } from './ui';

export type DrawerTab = 'widgets' | 'elements' | 'themes' | 'metrics';
export type ElementKind = 'title' | 'text' | 'image' | 'embed';

const CHART_CHIPS: { v: Chart | 'all'; label: string }[] = [
  { v: 'all', label: 'All' }, { v: 'number', label: '# Number' }, { v: 'donut', label: 'Donut' }, { v: 'line', label: 'Line' },
  { v: 'column', label: 'Column' }, { v: 'bar', label: 'Horizontal bar' }, { v: 'table', label: 'Table' },
];

const ELEMENTS: { kind: ElementKind; label: string; hint: string }[] = [
  { kind: 'title', label: 'Title', hint: 'A section heading across the page' },
  { kind: 'text', label: 'Text box', hint: 'A paragraph of commentary' },
  { kind: 'image', label: 'Image', hint: 'A picture by URL — a logo, a map' },
  { kind: 'embed', label: 'Embed', hint: 'Another page by URL, framed inside the report' },
];

function ChartGlyph({ chart }: { chart: Chart }) {
  const c = ACCENT;
  if (chart === 'number') return <span style={{ font: '700 13px system-ui', color: c }}>#</span>;
  if (chart === 'donut') return <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="3" strokeDasharray="20 12" /></svg>;
  if (chart === 'line') return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={c} strokeWidth="2"><path d="M1 11 5 6l3 3 4-6" /></svg>;
  if (chart === 'column') return <svg width="14" height="14" viewBox="0 0 14 14" fill={c}><rect x="1" y="7" width="3" height="6" rx="1" /><rect x="5.5" y="3" width="3" height="10" rx="1" /><rect x="10" y="5" width="3" height="8" rx="1" /></svg>;
  if (chart === 'bar') return <svg width="14" height="14" viewBox="0 0 14 14" fill={c}><rect x="1" y="1" width="12" height="3" rx="1" /><rect x="1" y="5.5" width="8" height="3" rx="1" /><rect x="1" y="10" width="10" height="3" rx="1" /></svg>;
  if (chart === 'funnel') return <svg width="14" height="14" viewBox="0 0 14 14" fill={c}><path d="M1 1h12l-4 6v6H5V7z" /></svg>;
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={c} strokeWidth="1.6"><rect x="1" y="2" width="12" height="10" rx="1" /><path d="M1 6h12M5 2v10" /></svg>;
}

export function WidgetDrawer({ tab, setTab, theme, onTheme, metrics, onAddWidget, onAddElement, onAddMetric, onNewMetric, onEditMetric, onClose }: {
  tab: DrawerTab; setTab: (t: DrawerTab) => void; theme: Theme; onTheme: (t: Theme) => void; metrics: CustomMetric[];
  onAddWidget: (w: WidgetDef) => void; onAddElement: (k: ElementKind) => void; onAddMetric: (m: CustomMetric) => void; onNewMetric: () => void; onEditMetric: (m: CustomMetric) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [chart, setChart] = useState<Chart | 'all'>('all');
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [mq, setMq] = useState('');
  const shown = useMemo(() => WIDGETS.filter((w) => (chart === 'all' || w.chart === chart) && (!q || (w.label + ' ' + w.description + ' ' + w.category).toLowerCase().includes(q.toLowerCase()))), [q, chart]);
  const byCat = useMemo(() => CATEGORIES.map((c) => ({ ...c, items: shown.filter((w) => w.category === c.name) })).filter((c) => c.items.length), [shown]);
  const searching = !!q || chart !== 'all';

  return (
    <aside aria-label="Add to the report" style={{ width: '340px', flex: 'none', borderLeft: `1px solid ${LINE}`, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: '8px 10px 0', borderBottom: `1px solid ${SOFT}` }}>
        {([['widgets', 'Widgets'], ['elements', 'Elements'], ['themes', 'Themes'], ['metrics', 'Custom metrics']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ height: '32px', padding: '0 9px', border: 0, borderBottom: `2px solid ${tab === k ? INK : 'transparent'}`, background: 'none', fontSize: '12.5px', fontWeight: 600, color: tab === k ? INK : MUTED, cursor: 'pointer', whiteSpace: 'nowrap' }}>{l}</button>
        ))}
        <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn.icon, border: 0, marginLeft: 'auto', fontSize: '18px' }}>×</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px' }}>
        {tab === 'widgets' ? (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search widget" aria-label="Search widgets" style={field} />
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', margin: '10px 0 12px' }}>
              {CHART_CHIPS.map((c) => <button key={c.v} type="button" onClick={() => setChart(c.v)} style={btn.chip(chart === c.v)}>{c.label}</button>)}
            </div>
            {!byCat.length ? <p style={{ fontSize: '12.5px', color: MUTED }}>No widget matches. Ads, web analytics, social and payment widgets need a connected source CLOZR does not have yet.</p> : null}
            {byCat.map((c) => {
              const open = searching || openCat === c.name;
              return (
                <div key={c.name} style={{ borderTop: `1px solid ${SOFT}` }}>
                  <button type="button" onClick={() => setOpenCat(open && !searching ? null : c.name)} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px 2px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{c.name}</span>
                    <span style={{ fontSize: '11px', color: MUTED, background: SOFT, borderRadius: '999px', padding: '1px 7px' }}>{c.items.length}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '11px', color: MUTED }}>{c.blurb}</span>
                    <span style={{ color: MUTED, fontSize: '11px', transform: open ? 'rotate(90deg)' : 'none' }}>›</span>
                  </button>
                  {open ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingBottom: '10px' }}>
                      {c.items.map((w) => (
                        <button key={w.key} type="button" onClick={() => onAddWidget(w)} className="dc2" style={{ display: 'grid', gridTemplateColumns: '26px 1fr', gap: '8px', alignItems: 'start', padding: '8px 9px', border: `1px solid ${LINE}`, borderRadius: '9px', background: '#fff', cursor: 'pointer', textAlign: 'left' }}>
                          <span style={{ width: '26px', height: '26px', borderRadius: '7px', background: '#E7F8F1', display: 'grid', placeItems: 'center' }}><ChartGlyph chart={w.chart} /></span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: INK }}>{w.label}</span>
                            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, lineHeight: 1.4 }}>{w.description} · {CHART_LABEL[w.chart]}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        ) : null}

        {tab === 'elements' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {ELEMENTS.map((el) => (
              <button key={el.kind} type="button" onClick={() => onAddElement(el.kind)} className="dc2" style={{ padding: '10px 11px', border: `1px solid ${LINE}`, borderRadius: '9px', background: '#fff', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: INK }}>{el.label}</span>
                <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{el.hint}</span>
              </button>
            ))}
          </div>
        ) : null}

        {tab === 'themes' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
              {THEMES.map((t) => {
                const on = theme.id === t.id;
                return (
                  <button key={t.id} type="button" onClick={() => onTheme(t.id === 'custom' ? { ...theme, id: 'custom', name: 'Custom' } : t)} aria-pressed={on} style={{ padding: '8px', border: `2px solid ${on ? ACCENT : LINE}`, borderRadius: '10px', background: '#fff', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ display: 'block', height: '44px', borderRadius: '6px', background: t.bg, border: `1px solid ${SOFT}`, padding: '6px', boxSizing: 'border-box' }}>
                      <span style={{ display: 'block', height: '5px', width: '60%', background: t.title, borderRadius: '2px' }} />
                      <span style={{ display: 'flex', gap: '3px', marginTop: '6px', alignItems: 'flex-end', height: '16px' }}>
                        {[10, 16, 7, 13].map((h, i) => <span key={i} style={{ flex: 1, height: h, background: t.id === 'custom' ? ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'][i] : t.chart, borderRadius: '2px 2px 0 0' }} />)}
                      </span>
                    </span>
                    <span style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, marginTop: '6px', color: INK }}>{t.name}</span>
                  </button>
                );
              })}
            </div>
            {theme.id === 'custom' ? (
              <div style={{ marginTop: '14px' }}>
                <span style={eyebrow}>Custom color options</span>
                {([['title', 'Title text color'], ['bg', 'Background color'], ['metric', 'Metric color'], ['chart', 'Chart color'], ['link', 'Link color']] as const).map(([k, l]) => (
                  <label key={k} style={{ display: 'grid', gridTemplateColumns: '1fr 40px 90px', gap: '8px', alignItems: 'center', fontSize: '12.5px', padding: '5px 0' }}>
                    <span>{l}</span>
                    <input type="color" value={theme[k]} onChange={(e) => onTheme({ ...theme, [k]: e.target.value })} aria-label={l} style={{ width: '36px', height: '26px', border: `1px solid ${LINE}`, borderRadius: '6px', padding: 0, background: 'none' }} />
                    <input value={theme[k]} onChange={(e) => onTheme({ ...theme, [k]: e.target.value })} style={{ ...field, height: '28px', fontSize: '12px' }} />
                  </label>
                ))}
                <button type="button" onClick={() => onTheme(THEMES[0])} style={{ ...btn.plain, padding: 0, marginTop: '6px' }}>Reset</button>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === 'metrics' ? (
          <>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input value={mq} onChange={(e) => setMq(e.target.value)} placeholder="Search custom metrics" aria-label="Search custom metrics" style={field} />
              <button type="button" onClick={onNewMetric} style={{ ...btn.primary, flex: 'none' }}>Create</button>
            </div>
            {!metrics.length ? (
              <div style={{ marginTop: '14px', padding: '16px', border: `1px dashed ${LINE}`, borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>Create your first custom metric</div>
                <p style={{ margin: '6px 0 10px', fontSize: '12px', color: MUTED, lineHeight: 1.5 }}>Metrics that suit your business — combine two to four numbers with a formula, from scratch or by cloning one.</p>
                <button type="button" onClick={onNewMetric} style={btn.accent}>Create custom metrics</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
                {metrics.filter((m) => !mq || (m.name + ' ' + (m.description ?? '')).toLowerCase().includes(mq.toLowerCase())).map((m) => (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 9px', border: `1px solid ${LINE}`, borderRadius: '9px' }}>
                    <button type="button" onClick={() => onAddMetric(m)} style={{ flex: 1, minWidth: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                      <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: INK }}>{m.name}</span>
                      <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.description || m.formula.map((t) => (t.kind === 'metric' ? t.label : t.kind === 'num' ? t.v : t.v)).join(' ')}</span>
                    </button>
                    <button type="button" onClick={() => onEditMetric(m)} style={{ ...btn.plain, height: '26px', padding: '0 6px' }}>Edit</button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}
