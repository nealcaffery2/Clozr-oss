'use client';

// One block's settings: chart type, title, the metric (object + aggregation +
// field), group-by, the advanced date settings, and the filter conditions.

import React, { useState } from 'react';
import { CHART_LABEL } from '@/lib/report-catalog';
import { FIELDS, SOURCE_LABEL, fieldOf, type Agg, type Chart, type Comparison, type Cond, type Op, type Source, type Spec } from '@/lib/report-engine';
import type { Block } from '@/lib/report-store';
import { DateRangePicker } from './DateRangePicker';
import { INK, LINE, MUTED, SOFT, btn, eyebrow, field } from './ui';

const AGGS: { v: Agg; label: string }[] = [{ v: 'count', label: 'Count' }, { v: 'distinct', label: 'Count distinct' }, { v: 'sum', label: 'Sum' }, { v: 'avg', label: 'Average' }, { v: 'min', label: 'Minimum' }, { v: 'max', label: 'Maximum' }];
const OPS: { v: Op; label: string }[] = [{ v: 'is', label: 'Is' }, { v: 'is_not', label: 'Is not' }, { v: 'contains', label: 'Contains' }, { v: 'gt', label: 'Greater than' }, { v: 'lt', label: 'Less than' }, { v: 'set', label: 'Is set' }, { v: 'unset', label: 'Is empty' }];
const COMPARE: { v: Comparison; label: string }[] = [{ v: 'report', label: 'Report comparison date range' }, { v: 'none', label: 'No comparison' }, { v: 'previous', label: 'Previous period' }, { v: 'year', label: 'Year before' }];
const CHARTS: Chart[] = ['number', 'donut', 'line', 'column', 'bar', 'table'];

export type Member = { id: string; name: string };

/** The plain-English merge fields the title can carry. */
export const TITLE_FIELDS = ['{{date_range}}', '{{workspace}}', '{{today}}'];

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: '12px' }}>{children}</div>;
}

function CondRow({ source, cond, members, onChange, onRemove }: { source: Source; cond: Cond; members: Member[]; onChange: (c: Cond) => void; onRemove: () => void }) {
  const f = fieldOf(source, cond.field);
  const noValue = cond.op === 'set' || cond.op === 'unset';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 26px', gap: '6px', alignItems: 'center' }}>
      <select value={cond.field} onChange={(e) => onChange({ ...cond, field: e.target.value, value: '' })} aria-label="Field" style={field}>
        {FIELDS[source].map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
      </select>
      <select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as Op })} aria-label="Operator" style={field}>
        {OPS.filter((o) => (f?.kind === 'bool' ? o.v === 'is' || o.v === 'is_not' : true)).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {noValue ? <span /> : f?.kind === 'bool' ? (
        <select value={cond.value || 'true'} onChange={(e) => onChange({ ...cond, value: e.target.value })} aria-label="Value" style={field}><option value="true">Yes</option><option value="false">No</option></select>
      ) : f?.kind === 'user' && (cond.op === 'is' || cond.op === 'is_not') ? (
        <select value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} aria-label="Value" style={field}>
          <option value="">Pick a teammate</option><option value="@me">Me (whoever views it)</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      ) : (
        <input value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder={f?.kind === 'date' ? 'YYYY-MM-DD' : f?.kind === 'money' ? '150000' : 'Value'} aria-label="Value" style={field} />
      )}
      <button type="button" onClick={onRemove} aria-label="Remove condition" style={{ ...btn.icon, width: '26px', height: '26px', color: MUTED }}>🗑</button>
    </div>
  );
}

export function WidgetConfig({ block, members, onChange, onClose, onDelete, onEditFormula }: {
  block: Block; members: Member[]; onChange: (b: Block) => void; onClose: () => void; onDelete: () => void; onEditFormula?: () => void;
}) {
  const [tab, setTab] = useState<'configure' | 'conditions'>('configure');
  const [advanced, setAdvanced] = useState(false);

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: '8px 10px 0', borderBottom: `1px solid ${SOFT}` }}>
      {block.kind === 'widget' ? (['configure', 'conditions'] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ height: '32px', padding: '0 10px', border: 0, borderBottom: `2px solid ${tab === k ? INK : 'transparent'}`, background: 'none', fontSize: '12.5px', fontWeight: 600, color: tab === k ? INK : MUTED, cursor: 'pointer', textTransform: 'capitalize' }}>{k}</button>
      )) : <span style={{ height: '32px', display: 'inline-flex', alignItems: 'center', padding: '0 10px', fontSize: '12.5px', fontWeight: 600 }}>{block.kind === 'metric' ? 'Custom metric' : 'Element'}</span>}
      <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn.icon, border: 0, marginLeft: 'auto', fontSize: '18px' }}>×</button>
    </div>
  );

  const widthRow = (
    <Row>
      <span style={eyebrow}>Width</span>
      <div style={{ display: 'flex', gap: '5px' }}>
        <button type="button" onClick={() => onChange({ ...block, w: 1 })} style={btn.chip(block.w === 1)}>Half</button>
        <button type="button" onClick={() => onChange({ ...block, w: 2 })} style={btn.chip(block.w === 2)}>Full</button>
      </div>
    </Row>
  );
  const footer = <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '6px', borderTop: `1px solid ${SOFT}`, marginTop: '4px' }}><button type="button" onClick={onDelete} style={btn.danger}>Remove</button><button type="button" onClick={onClose} style={btn.primary}>Done</button></div>;

  if (block.kind === 'element') {
    return (
      <aside aria-label="Element settings" style={{ width: '340px', flex: 'none', borderLeft: `1px solid ${LINE}`, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {head}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          <Row>
            <span style={eyebrow}>{block.element === 'title' ? 'Heading' : block.element === 'text' ? 'Text' : 'URL'}</span>
            {block.element === 'text' ? <textarea value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} rows={6} style={{ ...field, height: 'auto', padding: '8px 9px', resize: 'vertical' }} />
              : <input value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} placeholder={block.element === 'title' ? 'Section title' : 'https://…'} style={field} />}
            {block.element === 'embed' ? <p style={{ fontSize: '11.5px', color: MUTED, margin: '6px 0 0', lineHeight: 1.45 }}>The page must allow framing; most dashboards and docs with a share link do.</p> : null}
          </Row>
          {widthRow}
          {footer}
        </div>
      </aside>
    );
  }

  if (block.kind === 'metric') {
    return (
      <aside aria-label="Metric settings" style={{ width: '340px', flex: 'none', borderLeft: `1px solid ${LINE}`, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {head}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          <Row><span style={eyebrow}>Title</span><input value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} style={field} /></Row>
          <Row>
            <span style={eyebrow}>Formula</span>
            <div style={{ fontSize: '12.5px', color: INK, lineHeight: 1.5, padding: '8px 9px', border: `1px solid ${LINE}`, borderRadius: '8px', background: '#fafafa' }}>{block.formula.map((t) => (t.kind === 'metric' ? `[${t.label}]` : String(t.v))).join(' ')}</div>
            {onEditFormula ? <button type="button" onClick={onEditFormula} style={{ ...btn.plain, padding: 0, marginTop: '6px' }}>Edit the formula in the metric builder</button> : null}
          </Row>
          <Row>
            <span style={eyebrow}>Comparison polarity</span>
            <div style={{ display: 'flex', gap: '5px' }}>
              <button type="button" onClick={() => onChange({ ...block, polarity: 'up' })} style={btn.chip(block.polarity === 'up')}>Increase is positive</button>
              <button type="button" onClick={() => onChange({ ...block, polarity: 'down' })} style={btn.chip(block.polarity === 'down')}>Decrease is positive</button>
            </div>
          </Row>
          {widthRow}
          {footer}
        </div>
      </aside>
    );
  }

  const spec = block.spec;
  const setSpec = (patch: Partial<Spec>) => onChange({ ...block, spec: { ...spec, ...patch } });
  const numeric = FIELDS[spec.source].filter((x) => x.kind === 'number' || x.kind === 'money' || x.kind === 'duration' || x.kind === 'pct');
  const groupable = FIELDS[spec.source].filter((x) => x.kind === 'text' || x.kind === 'tags' || x.kind === 'user' || x.kind === 'bool' || x.kind === 'date');
  const dates = FIELDS[spec.source].filter((x) => x.kind === 'date');
  const charts = spec.funnel?.length ? [...CHARTS, 'funnel' as Chart] : CHARTS;

  return (
    <aside aria-label="Widget settings" style={{ width: '340px', flex: 'none', borderLeft: `1px solid ${LINE}`, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {head}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
        {tab === 'configure' ? (
          <>
            <Row>
              <span style={eyebrow}>Chart type</span>
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                {charts.map((c) => <button key={c} type="button" onClick={() => onChange({ ...block, chart: c, w: c === 'table' || c === 'line' || c === 'column' ? 2 : block.w })} style={btn.chip(block.chart === c)}>{CHART_LABEL[c]}</button>)}
              </div>
            </Row>
            <Row>
              <span style={eyebrow}>Title</span>
              <input value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} style={field} />
              <div style={{ display: 'flex', gap: '4px', marginTop: '5px', flexWrap: 'wrap' }}>
                {TITLE_FIELDS.map((t) => <button key={t} type="button" onClick={() => onChange({ ...block, title: (block.title + ' ' + t).trim() })} style={{ ...btn.plain, height: '22px', padding: '0 6px', fontSize: '11px', border: `1px solid ${LINE}`, borderRadius: '6px' }}>{t}</button>)}
              </div>
            </Row>
            <Row>
              <span style={eyebrow}>Metric</span>
              <div style={{ display: 'grid', gridTemplateColumns: spec.agg === 'count' ? '1fr 1fr' : '1fr 1fr 1fr', gap: '6px' }}>
                <select value={spec.source} onChange={(e) => { const source = e.target.value as Source; const d = FIELDS[source].find((x) => x.kind === 'date'); onChange({ ...block, spec: { ...spec, source, field: null, groupBy: null, dateField: d?.key ?? null, filters: [], columns: undefined, funnel: undefined } }); }} aria-label="Data object" style={field}>
                  {(Object.keys(SOURCE_LABEL) as Source[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </select>
                <select value={spec.agg} onChange={(e) => { const agg = e.target.value as Agg; setSpec({ agg, field: agg === 'count' ? null : spec.field ?? (agg === 'distinct' ? FIELDS[spec.source][0].key : numeric[0]?.key ?? null) }); }} aria-label="Aggregation" style={field}>
                  {AGGS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
                </select>
                {spec.agg !== 'count' ? (
                  <select value={spec.field ?? ''} onChange={(e) => setSpec({ field: e.target.value || null })} aria-label="Field" style={field}>
                    {(spec.agg === 'distinct' ? FIELDS[spec.source] : numeric).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                ) : null}
              </div>
            </Row>
            {block.chart !== 'table' && block.chart !== 'funnel' ? (
              <Row>
                <span style={eyebrow}>Group by</span>
                <select value={spec.groupBy ?? ''} onChange={(e) => setSpec({ groupBy: e.target.value || null })} style={field}>
                  <option value="">None — one number{block.chart === 'line' || block.chart === 'column' ? ' over time' : ''}</option>
                  {groupable.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                {spec.groupBy ? <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12px', color: MUTED }}>Show top<input type="number" min={2} max={30} value={spec.limit ?? 8} onChange={(e) => setSpec({ limit: Math.max(2, Math.min(30, Number(e.target.value) || 8)) })} style={{ ...field, width: '64px', height: '26px' }} />groups, the rest as Other</label> : null}
              </Row>
            ) : null}
            {block.chart === 'table' ? (
              <Row>
                <span style={eyebrow}>Columns</span>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  {FIELDS[spec.source].map((x) => {
                    const cols = spec.columns ?? [];
                    const on = cols.includes(x.key);
                    return <button key={x.key} type="button" onClick={() => setSpec({ columns: on ? cols.filter((k) => k !== x.key) : [...cols, x.key] })} style={btn.chip(on)}>{x.label}</button>;
                  })}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12px', color: MUTED }}>Rows<input type="number" min={5} max={200} value={spec.limit ?? 50} onChange={(e) => setSpec({ limit: Math.max(5, Math.min(200, Number(e.target.value) || 50)) })} style={{ ...field, width: '70px', height: '26px' }} /></label>
              </Row>
            ) : null}
            <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} style={{ ...btn.plain, padding: 0, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <span style={{ display: 'inline-block', transform: advanced ? 'rotate(90deg)' : 'none' }}>›</span> Advanced settings
            </button>
            {advanced ? (
              <div style={{ padding: '10px', border: `1px solid ${SOFT}`, borderRadius: '9px', marginBottom: '12px' }}>
                <Row>
                  <span style={eyebrow}>Date property</span>
                  <select value={spec.dateField ?? ''} onChange={(e) => setSpec({ dateField: e.target.value || null })} style={field}>
                    <option value="">None — everything till date</option>
                    {dates.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                </Row>
                <Row>
                  <span style={eyebrow}>Date range</span>
                  <DateRangePicker allowReport value={{ preset: spec.datePreset ?? '', custom: null, comparison: spec.comparison && spec.comparison !== 'report' ? spec.comparison : 'previous' }} onChange={(v) => setSpec({ datePreset: v.preset && v.preset !== 'Custom' ? v.preset : null })} />
                </Row>
                <Row>
                  <span style={eyebrow}>Comparison date range</span>
                  <select value={spec.comparison ?? 'report'} onChange={(e) => setSpec({ comparison: e.target.value as Comparison })} style={field}>
                    {COMPARE.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                  </select>
                </Row>
                <Row>
                  <span style={eyebrow}>Comparison polarity</span>
                  <div style={{ display: 'flex', gap: '5px' }}>
                    <button type="button" onClick={() => setSpec({ polarity: 'up' })} style={btn.chip((spec.polarity ?? 'up') === 'up')}>Increase is positive</button>
                    <button type="button" onClick={() => setSpec({ polarity: 'down' })} style={btn.chip(spec.polarity === 'down')}>Decrease is positive</button>
                  </div>
                </Row>
              </div>
            ) : null}
            {widthRow}
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 10px', fontSize: '12px', color: MUTED, lineHeight: 1.5 }}>Rows must match every condition in a group; add a second group for an OR.</p>
            {spec.filters.map((group, gi) => (
              <div key={gi} style={{ padding: '10px', border: `1px solid ${LINE}`, borderRadius: '9px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {gi > 0 ? <span style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600 }}>or</span> : null}
                {group.map((c, ci) => (
                  <CondRow key={ci} source={spec.source} cond={c} members={members}
                    onChange={(nc) => setSpec({ filters: spec.filters.map((g, i) => (i === gi ? g.map((x, j) => (j === ci ? nc : x)) : g)) })}
                    onRemove={() => setSpec({ filters: spec.filters.map((g, i) => (i === gi ? g.filter((_, j) => j !== ci) : g)).filter((g) => g.length) })} />
                ))}
                <button type="button" onClick={() => setSpec({ filters: spec.filters.map((g, i) => (i === gi ? [...g, { field: FIELDS[spec.source][0].key, op: 'is' as Op, value: '' }] : g)) })} style={{ ...btn.plain, padding: 0, alignSelf: 'flex-start' }}>+ AND</button>
              </div>
            ))}
            <button type="button" onClick={() => setSpec({ filters: [...spec.filters, [{ field: FIELDS[spec.source][0].key, op: 'is' as Op, value: '' }]] })} style={btn.ghost}>+ Add filter{spec.filters.length ? ' (OR)' : ''}</button>
          </>
        )}
        {footer}
      </div>
    </aside>
  );
}
