'use client';

// The custom metric builder: a name, a display format, and a formula of up to
// four metrics joined by + − × ÷ and parentheses, each metric with its own
// filters. The preview evaluates against the report's current range as you go.

import React, { useMemo, useState } from 'react';
import { FIELDS, SOURCE_LABEL, evalFormula, fmtValue, formulaError, compute, type Agg, type Cond, type EngineRaw, type MetricFormat, type Op, type Polarity, type Range, type Row, type Source, type Spec, type Token } from '@/lib/report-engine';
import type { CustomMetric } from '@/lib/report-store';
import type { Member } from './WidgetConfig';
import { ACCENT, INK, LINE, MUTED, SOFT, btn, card, eyebrow, field } from './ui';

const FORMATS: { v: MetricFormat; label: string; help: string }[] = [
  { v: 'int', label: 'Integer', help: 'Whole numbers, e.g. 40' },
  { v: 'float', label: 'Float', help: 'Decimals, e.g. 40.5' },
  { v: 'pct', label: 'Percentage', help: 'Display only: the formula must produce 0–100 (multiply by 100), e.g. 75 → 75%' },
  { v: 'usd', label: 'Currency', help: 'USD, e.g. $40.50' },
];
const AGGS: { v: Agg; label: string }[] = [{ v: 'count', label: 'Count' }, { v: 'distinct', label: 'Count distinct' }, { v: 'sum', label: 'Sum' }, { v: 'avg', label: 'Average' }, { v: 'min', label: 'Minimum' }, { v: 'max', label: 'Maximum' }];
const OPS: Array<'+' | '-' | '*' | '/' | '(' | ')'> = ['+', '-', '*', '/', '(', ')'];

function newSpec(source: Source): Spec {
  return { source, agg: 'count', field: null, groupBy: null, dateField: FIELDS[source].find((x) => x.kind === 'date')?.key ?? null, filters: [] };
}
function metricLabel(spec: Spec): string {
  const agg = AGGS.find((a) => a.v === spec.agg)?.label ?? 'Count';
  const f = spec.field ? FIELDS[spec.source].find((x) => x.key === spec.field)?.label : null;
  return `${agg} of ${f ? f + ' · ' : ''}${SOURCE_LABEL[spec.source]}${spec.filters.length ? ' (filtered)' : ''}`;
}

export function MetricBuilder({ initial, data, raw, range, me, members, onSave, onCancel, onDelete }: {
  initial: CustomMetric | null; data: Record<Source, Row[]> | null; raw: EngineRaw | null; range: Range; me: string | null; members: Member[];
  onSave: (m: { id?: number | null; name: string; description: string | null; display_format: MetricFormat; formula: Token[]; polarity: Polarity }) => Promise<void>; onCancel: () => void; onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [desc, setDesc] = useState(initial?.description ?? '');
  const [descOpen, setDescOpen] = useState(!!initial?.description);
  const [format, setFormat] = useState<MetricFormat>(initial?.display_format ?? 'int');
  const [polarity, setPolarity] = useState<Polarity>(initial?.polarity ?? 'up');
  const [tokens, setTokens] = useState<Token[]>(initial?.formula ?? []);
  const [adding, setAdding] = useState<'metric' | 'num' | null>(null);
  const [draft, setDraft] = useState<Spec>(newSpec('sellers'));
  const [num, setNum] = useState('100');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const error = formulaError(tokens);
  const preview = useMemo(() => {
    if (error || !data || !raw) return null;
    return evalFormula(tokens, (spec) => compute(spec, range, data, raw, { me, chart: 'number' }).value);
  }, [tokens, error, data, raw, range, me]);
  const metricCount = tokens.filter((t) => t.kind === 'metric').length;

  const sel = selected !== null ? tokens[selected] : null;
  const selSpec = sel && sel.kind === 'metric' ? sel.spec : null;
  const setSelSpec = (patch: Partial<Spec>) => { if (selected === null || !selSpec) return; setTokens(tokens.map((t, i) => (i === selected && t.kind === 'metric' ? { ...t, spec: { ...selSpec, ...patch }, label: metricLabel({ ...selSpec, ...patch }) } : t))); };

  async function save() {
    if (!name.trim()) return setErr('Give the metric a name.');
    if (error) return setErr(error);
    setBusy(true); setErr(null);
    await onSave({ id: initial?.id ?? null, name, description: desc || null, display_format: format, formula: tokens, polarity });
    setBusy(false);
  }

  const numeric = FIELDS[draft.source].filter((x) => x.kind === 'number' || x.kind === 'money' || x.kind === 'duration' || x.kind === 'pct');

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', background: '#fff', borderBottom: `1px solid ${LINE}` }}>
        <button type="button" onClick={onCancel} style={btn.ghost}>← Back</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{initial ? 'Edit custom metric' : 'Set up your custom metric'}</div>
          <div style={{ fontSize: '12px', color: MUTED }}>Build KPIs that fit the business by combining numbers with a formula.</div>
        </div>
        <div style={{ flex: 1 }} />
        {onDelete ? <button type="button" onClick={onDelete} style={btn.danger}>Delete</button> : null}
        <button type="button" onClick={onCancel} style={btn.ghost}>Cancel</button>
        <button type="button" onClick={() => void save()} disabled={busy} style={btn.accent}>{busy ? 'Saving…' : 'Save metric'}</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '18px 20px 40px' }}>
          <div style={{ maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {err ? <div role="status" style={{ padding: '10px 12px', borderRadius: '9px', background: '#fee2e2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '12.5px' }}>{err}</div> : null}
            <div style={{ ...card, padding: '16px 18px' }}>
              <label><span style={eyebrow}>Metric name *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Revenue growth rate" style={field} /></label>
              <div style={{ marginTop: '14px' }}>
                <span style={eyebrow}>Display format *</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px' }}>
                  {FORMATS.map((f) => (
                    <label key={f.v} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '9px 10px', border: `1px solid ${format === f.v ? ACCENT : LINE}`, borderRadius: '9px', cursor: 'pointer', background: format === f.v ? '#E7F8F1' : '#fff' }}>
                      <input type="radio" name="metric-format" checked={format === f.v} onChange={() => setFormat(f.v)} style={{ marginTop: '2px', accentColor: ACCENT }} />
                      <span><span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: INK }}>{f.label}</span><span style={{ display: 'block', fontSize: '11.5px', color: MUTED, lineHeight: 1.4 }}>{f.help}</span></span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: '14px' }}>
                <button type="button" onClick={() => setDescOpen(!descOpen)} style={{ ...btn.plain, padding: 0 }}>{descOpen ? '▾' : '▸'} Description (optional)</button>
                {descOpen ? <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} placeholder="What this metric tells the team" style={{ ...field, height: 'auto', padding: '8px 9px', marginTop: '6px', resize: 'vertical' }} /> : null}
              </div>
            </div>

            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={eyebrow}>Formula (up to 4 metrics) *</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: MUTED }}>{metricCount}/4 metrics</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minHeight: '44px', padding: '8px', border: `1px solid ${LINE}`, borderRadius: '9px', background: '#fafafa', alignItems: 'center' }}>
                {!tokens.length ? <span style={{ fontSize: '12.5px', color: '#a1a1aa' }}>Click Metrics, Operator or Number to build the formula.</span> : null}
                {tokens.map((t, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    {t.kind === 'metric' ? (
                      <button type="button" onClick={() => setSelected(selected === i ? null : i)} title="Click to filter this metric" style={{ height: '28px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${selected === i ? ACCENT : LINE}`, background: selected === i ? '#E7F8F1' : '#fff', color: INK, fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        {t.label}{t.spec.filters.length ? <span aria-label="filtered" style={{ color: ACCENT }}>⏷</span> : null}
                      </button>
                    ) : <span style={{ height: '28px', padding: '0 9px', borderRadius: '7px', background: t.kind === 'op' ? SOFT : '#fff', border: t.kind === 'num' ? `1px solid ${LINE}` : 0, fontSize: '13px', fontWeight: 700, color: INK, display: 'inline-flex', alignItems: 'center' }}>{t.kind === 'op' ? { '*': '×', '/': '÷' }[t.v as string] ?? t.v : t.v}</span>}
                    <button type="button" onClick={() => { setTokens(tokens.filter((_, j) => j !== i)); setSelected(null); }} aria-label="Remove" style={{ border: 0, background: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: '13px', padding: '0 2px' }}>×</button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button type="button" disabled={metricCount >= 4} onClick={() => setAdding(adding === 'metric' ? null : 'metric')} style={{ ...btn.ghost, opacity: metricCount >= 4 ? 0.5 : 1 }}>+ Metrics</button>
                <div style={{ display: 'inline-flex', gap: '3px', alignItems: 'center', padding: '0 6px', border: `1px solid ${LINE}`, borderRadius: '8px', height: '30px' }}>
                  <span style={{ fontSize: '11px', color: MUTED, marginRight: '4px' }}>Operator</span>
                  {OPS.map((o) => <button key={o} type="button" onClick={() => setTokens([...tokens, { kind: 'op', v: o }])} style={{ width: '24px', height: '22px', border: 0, background: SOFT, borderRadius: '5px', fontWeight: 700, cursor: 'pointer' }}>{{ '*': '×', '/': '÷' }[o as string] ?? o}</button>)}
                </div>
                <button type="button" onClick={() => setAdding(adding === 'num' ? null : 'num')} style={btn.ghost}>+ Number</button>
              </div>
              {adding === 'metric' ? (
                <div style={{ marginTop: '10px', padding: '10px', border: `1px solid ${SOFT}`, borderRadius: '9px', display: 'grid', gridTemplateColumns: draft.agg === 'count' ? '1fr 1fr auto' : '1fr 1fr 1fr auto', gap: '6px', alignItems: 'end' }}>
                  <label><span style={eyebrow}>Data</span><select value={draft.source} onChange={(e) => setDraft(newSpec(e.target.value as Source))} style={field}>{(Object.keys(SOURCE_LABEL) as Source[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label>
                  <label><span style={eyebrow}>Aggregation</span><select value={draft.agg} onChange={(e) => { const agg = e.target.value as Agg; setDraft({ ...draft, agg, field: agg === 'count' ? null : agg === 'distinct' ? FIELDS[draft.source][0].key : numeric[0]?.key ?? null }); }} style={field}>{AGGS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}</select></label>
                  {draft.agg !== 'count' ? <label><span style={eyebrow}>Field</span><select value={draft.field ?? ''} onChange={(e) => setDraft({ ...draft, field: e.target.value })} style={field}>{(draft.agg === 'distinct' ? FIELDS[draft.source] : numeric).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label> : null}
                  <button type="button" onClick={() => { setTokens([...tokens, { kind: 'metric', spec: draft, label: metricLabel(draft) }]); setAdding(null); }} style={btn.primary}>Add</button>
                </div>
              ) : null}
              {adding === 'num' ? (
                <div style={{ marginTop: '10px', display: 'flex', gap: '6px' }}>
                  <input value={num} onChange={(e) => setNum(e.target.value)} inputMode="decimal" aria-label="Number" style={{ ...field, width: '140px' }} />
                  <button type="button" onClick={() => { const v = Number(num); if (Number.isFinite(v)) { setTokens([...tokens, { kind: 'num', v }]); setAdding(null); } }} style={btn.primary}>Add</button>
                </div>
              ) : null}
              <p style={{ margin: '10px 0 0', fontSize: '11.5px', color: MUTED, lineHeight: 1.5 }}>Pro tip: click any metric to add filters and change how it is calculated. Metrics with filters show a ⏷.</p>
            </div>

            <div style={{ ...card, padding: '16px 18px' }}>
              <span style={eyebrow}>Comparison value</span>
              <div style={{ display: 'flex', gap: '5px' }}>
                <button type="button" onClick={() => setPolarity('up')} style={btn.chip(polarity === 'up')}>Increase is positive</button>
                <button type="button" onClick={() => setPolarity('down')} style={btn.chip(polarity === 'down')}>Decrease is positive</button>
              </div>
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${SOFT}` }}>
                <span style={eyebrow}>Preview · the report&rsquo;s current range</span>
                <div style={{ fontSize: '30px', fontWeight: 700, letterSpacing: '-0.03em', color: error ? '#a1a1aa' : INK }}>{error ? '—' : fmtValue(preview, format === 'usd' ? 'usd' : format === 'pct' ? 'pct' : format === 'float' ? 'float' : 'int')}</div>
                <div style={{ fontSize: '12px', color: error ? '#b91c1c' : MUTED, marginTop: '4px' }}>{error ?? (preview === null ? 'No value yet — a divide by zero or no rows in range.' : 'Live from the rows the report is on.')}</div>
              </div>
            </div>
          </div>
        </div>

        {selSpec ? (
          <aside aria-label="Metric filters" style={{ width: '320px', flex: 'none', borderLeft: `1px solid ${LINE}`, background: '#fff', overflow: 'auto', padding: '14px' }}>
            <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600 }}>Configuration › Filters</div>
            <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '4px' }}>Applying to: {sel && sel.kind === 'metric' ? sel.label : ''}</div>
            <p style={{ fontSize: '12px', color: MUTED, margin: '4px 0 12px', lineHeight: 1.5 }}>Filters apply to this metric only in the formula.</p>
            <label><span style={eyebrow}>Date property</span>
              <select value={selSpec.dateField ?? ''} onChange={(e) => setSelSpec({ dateField: e.target.value || null })} style={field}>
                <option value="">None — everything till date</option>
                {FIELDS[selSpec.source].filter((x) => x.kind === 'date').map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </label>
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {selSpec.filters.flatMap((g, gi) => g.map((c, ci) => (
                <div key={`${gi}-${ci}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 24px', gap: '4px' }}>
                  <select value={c.field} onChange={(e) => setSelSpec({ filters: selSpec.filters.map((gg, i) => (i === gi ? gg.map((x, j) => (j === ci ? { ...x, field: e.target.value, value: '' } : x)) : gg)) })} aria-label="Field" style={field}>{FIELDS[selSpec.source].map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
                  <select value={c.op} onChange={(e) => setSelSpec({ filters: selSpec.filters.map((gg, i) => (i === gi ? gg.map((x, j) => (j === ci ? { ...x, op: e.target.value as Op } : x)) : gg)) })} aria-label="Operator" style={field}>{(['is', 'is_not', 'contains', 'gt', 'lt', 'set', 'unset'] as Op[]).map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</select>
                  {FIELDS[selSpec.source].find((x) => x.key === c.field)?.kind === 'user' ? (
                    <select value={c.value} onChange={(e) => setSelSpec({ filters: selSpec.filters.map((gg, i) => (i === gi ? gg.map((x, j) => (j === ci ? { ...x, value: e.target.value } : x)) : gg)) })} aria-label="Value" style={field}><option value="">Teammate</option><option value="@me">Me</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                  ) : <input value={c.value} onChange={(e) => setSelSpec({ filters: selSpec.filters.map((gg, i) => (i === gi ? gg.map((x, j) => (j === ci ? { ...x, value: e.target.value } : x)) : gg)) })} placeholder="Value" aria-label="Value" style={field} />}
                  <button type="button" onClick={() => setSelSpec({ filters: selSpec.filters.map((gg, i) => (i === gi ? gg.filter((_, j) => j !== ci) : gg)).filter((gg) => gg.length) })} aria-label="Remove" style={{ border: 0, background: 'none', color: MUTED, cursor: 'pointer' }}>×</button>
                </div>
              )))}
              <button type="button" onClick={() => { const c: Cond = { field: FIELDS[selSpec.source][0].key, op: 'is', value: '' }; setSelSpec({ filters: selSpec.filters.length ? selSpec.filters.map((g, i) => (i === 0 ? [...g, c] : g)) : [[c]] }); }} style={{ ...btn.plain, padding: 0, alignSelf: 'flex-start' }}>+ Add filter</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '14px' }}>
              <button type="button" onClick={() => setSelected(null)} style={btn.primary}>Apply</button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
