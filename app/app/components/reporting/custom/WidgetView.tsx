'use client';

// Draws one computed widget. No chart library: SVG for donut, line and column,
// divs for horizontal bars and funnels. Every mark has a hover tooltip, every
// group is labelled in ink (never the series color alone), and a single series
// takes the theme's chart color while groups take the fixed categorical slots.

import React, { useState } from 'react';
import type { Chart, Format, Polarity, Result } from '@/lib/report-engine';
import { fmtDelta, fmtValue } from '@/lib/report-engine';
import { SERIES, type Theme } from '@/lib/report-catalog';

const GREEN = '#16a34a', RED = '#dc2626', MUTED = '#71717a', INK = '#18181b', LINE = '#e4e4e7', SOFT = '#f0f0f1';
const label: React.CSSProperties = { fontSize: '11.5px', color: '#52525b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const empty: React.CSSProperties = { padding: '18px 0', fontSize: '12.5px', color: MUTED };

export type TipState = { x: number; y: number; text: string } | null;

function Tip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div role="tooltip" style={{ position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 8px))', background: INK, color: '#fff', fontSize: '11.5px', padding: '5px 8px', borderRadius: '6px', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 2 }}>
      {tip.text}
    </div>
  );
}

export function DeltaChip({ cur, prev, polarity, compareLabel }: { cur: number | null; prev: number | null; polarity: Polarity; compareLabel: string }) {
  const d = fmtDelta(cur, prev, polarity);
  if (!d) return null;
  const color = d.good === null ? MUTED : d.good ? GREEN : RED;
  const bg = d.good === null ? SOFT : d.good ? '#dcfce7' : '#fee2e2';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: MUTED }}>
      <span style={{ background: bg, color, fontWeight: 600, padding: '2px 7px', borderRadius: '999px' }}>{d.text}</span>
      <span>vs {compareLabel}</span>
    </span>
  );
}

/** The big number a tile leads with. */
export function NumberView({ value, format, prev, polarity, theme, compareLabel, compact }: { value: number | null; format: Format; prev: number | null; polarity: Polarity; theme: Theme; compareLabel: string; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: compact ? '2px 0' : '6px 0' }}>
      <span style={{ fontSize: compact ? '26px' : '34px', fontWeight: 700, letterSpacing: '-0.03em', color: theme.metric, lineHeight: 1.05 }}>{fmtValue(value, format)}</span>
      <DeltaChip cur={value} prev={prev} polarity={polarity} compareLabel={compareLabel} />
    </div>
  );
}

function Donut({ groups, format, theme }: { groups: { label: string; value: number }[]; format: Format; theme: Theme }) {
  const [tip, setTip] = useState<TipState>(null);
  const total = groups.reduce((a, g) => a + Math.max(0, g.value), 0);
  if (!total) return <div style={empty}>Nothing in this range.</div>;
  const R = 44, C = 2 * Math.PI * R, GAP = 2;
  // Each arc starts where the ones before it end: the running total is derived, not mutated in render.
  const shares = groups.map((g) => Math.max(0, g.value) / total);
  const starts = shares.map((_, i) => shares.slice(0, i).reduce((a, b) => a + b, 0) * C);
  const arcs = groups.map((g, i) => {
    const share = shares[i];
    const len = Math.max(0, share * C - GAP);
    return { ...g, i, share, dash: `${len} ${C - len}`, offset: -starts[i], color: SERIES[i % SERIES.length] };
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 120px) 1fr', gap: '14px', alignItems: 'center', position: 'relative' }}>
      <svg viewBox="0 0 120 120" width="120" height="120" style={{ width: '100%', height: 'auto' }} role="img" aria-label={`${groups.length} groups`}>
        <circle cx="60" cy="60" r={R} fill="none" stroke={SOFT} strokeWidth="14" />
        {arcs.map((a) => (
          <circle key={a.label} cx="60" cy="60" r={R} fill="none" stroke={a.color} strokeWidth={14} strokeDasharray={a.dash} strokeDashoffset={a.offset} transform="rotate(-90 60 60)" style={{ cursor: 'default' }}
            onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).parentElement!.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${a.label} · ${fmtValue(a.value, format)} · ${Math.round(a.share * 100)}%` }); }}
            onMouseLeave={() => setTip(null)} />
        ))}
        <text x="60" y="57" textAnchor="middle" style={{ font: '700 15px system-ui, sans-serif', fill: theme.metric }}>{fmtValue(total, format)}</text>
        <text x="60" y="72" textAnchor="middle" style={{ font: '500 9px system-ui, sans-serif', fill: MUTED }}>total</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
        {arcs.map((a) => (
          <div key={a.label} style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto auto', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: a.color }} />
            <span style={label}>{a.label}</span>
            <span style={{ fontWeight: 600, color: INK }}>{fmtValue(a.value, format)}</span>
            <span style={{ color: MUTED, width: '34px', textAlign: 'right' }}>{Math.round(a.share * 100)}%</span>
          </div>
        ))}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

function HBars({ groups, format, theme, categorical }: { groups: { label: string; value: number }[]; format: Format; theme: Theme; categorical: boolean }) {
  const max = Math.max(0, ...groups.map((g) => g.value));
  if (!groups.length || max <= 0) return <div style={empty}>Nothing in this range.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
      {groups.map((g, i) => (
        <div key={g.label} title={`${g.label} · ${fmtValue(g.value, format)}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 34%) 1fr auto', gap: '10px', alignItems: 'center', fontSize: '12px' }}>
          <span style={label}>{g.label}</span>
          <span style={{ height: '8px', background: SOFT, borderRadius: '4px', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.max(1, (g.value / max) * 100)}%`, background: categorical ? SERIES[i % SERIES.length] : theme.chart, borderRadius: '4px' }} />
          </span>
          <span style={{ fontWeight: 600, color: INK, minWidth: '44px', textAlign: 'right' }}>{fmtValue(g.value, format)}</span>
        </div>
      ))}
    </div>
  );
}

function Columns({ points, format, theme }: { points: { label: string; value: number }[]; format: Format; theme: Theme }) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (!points.length || max <= 0) return <div style={empty}>Nothing in this range.</div>;
  const W = 600, H = 170, PAD = 4, BASE = H - 22;
  const n = points.length;
  const slot = (W - PAD * 2) / n;
  const bw = Math.max(3, Math.min(28, slot - 2));
  const every = Math.ceil(n / 8);
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Columns">
        <line x1={PAD} x2={W - PAD} y1={BASE} y2={BASE} stroke={LINE} />
        {points.map((p, i) => {
          const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * (BASE - 14));
          const x = PAD + i * slot + (slot - bw) / 2;
          return (
            <g key={i}>
              <rect x={PAD + i * slot} y={0} width={slot} height={BASE} fill="transparent"
                onMouseMove={(e) => { const r = e.currentTarget.ownerSVGElement!.parentElement!.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${p.label} · ${fmtValue(p.value, format)}` }); }}
                onMouseLeave={() => setTip(null)} />
              <rect x={x} y={BASE - h} width={bw} height={h} rx={Math.min(4, bw / 2)} fill={theme.chart} style={{ pointerEvents: 'none' }} />
              {i % every === 0 ? <text x={PAD + i * slot + slot / 2} y={H - 6} textAnchor="middle" style={{ font: '500 10px system-ui, sans-serif', fill: MUTED }}>{p.label}</text> : null}
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

function LineChart({ points, format, theme }: { points: { label: string; value: number }[]; format: Format; theme: Theme }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (!points.length || max <= 0) return <div style={empty}>Nothing in this range.</div>;
  const W = 600, H = 170, PADX = 8, TOP = 12, BASE = H - 22;
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : PADX + (i * (W - PADX * 2)) / (n - 1));
  const y = (v: number) => BASE - (v / max) * (BASE - TOP);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${x(n - 1).toFixed(1)},${BASE} L${x(0).toFixed(1)},${BASE} Z`;
  const every = Math.ceil(n / 8);
  const h = hover !== null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Trend"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(n - 1, Math.round(((px - PADX) / (W - PADX * 2)) * (n - 1))))); }}
        onMouseLeave={() => setHover(null)}>
        {[0.5, 1].map((f) => <line key={f} x1={PADX} x2={W - PADX} y1={y(max * f)} y2={y(max * f)} stroke={SOFT} />)}
        <line x1={PADX} x2={W - PADX} y1={BASE} y2={BASE} stroke={LINE} />
        <path d={area} fill={theme.chart} opacity={0.08} />
        <path d={d} fill="none" stroke={theme.chart} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null ? <>
          <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={BASE} stroke={MUTED} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <circle cx={x(hover)} cy={y(points[hover].value)} r={5} fill={theme.chart} stroke="#fff" strokeWidth={2} />
        </> : null}
        {points.map((p, i) => (i % every === 0 ? <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} style={{ font: '500 10px system-ui, sans-serif', fill: MUTED }}>{p.label}</text> : null))}
      </svg>
      {h ? <div style={{ position: 'absolute', top: 0, right: 0, background: INK, color: '#fff', fontSize: '11.5px', padding: '5px 8px', borderRadius: '6px', pointerEvents: 'none' }}>{h.label} · {fmtValue(h.value, format)}</div> : null}
    </div>
  );
}

function Funnel({ steps, theme }: { steps: { label: string; value: number }[]; theme: Theme }) {
  const top = steps[0]?.value ?? 0;
  if (!top) return <div style={empty}>Nothing in this range.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : null;
        const rate = prev ? Math.round((s.value / prev) * 100) + '%' : null;
        return (
          <div key={s.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px' }}>
              <span style={{ color: '#52525b' }}>{s.label}</span>
              <span><span style={{ fontWeight: 600, color: INK }}>{s.value.toLocaleString('en-US')}</span>{rate ? <span style={{ color: MUTED, marginLeft: '8px' }}>{rate} of previous</span> : null}</span>
            </div>
            <div style={{ height: '10px', background: SOFT, borderRadius: '5px', marginTop: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.max(1, (s.value / top) * 100)}%`, background: theme.chart, borderRadius: '5px', opacity: 1 - i * 0.1 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Table({ cols, rows }: { cols: string[]; rows: string[][] }) {
  if (!rows.length) return <div style={empty}>Nothing in this range.</div>;
  return (
    <div style={{ overflow: 'auto', maxHeight: '360px', margin: '0 -4px' }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px' }}>
        <thead>
          <tr>{cols.map((c) => <th key={c} style={{ position: 'sticky', top: 0, background: 'var(--c-thead)', textAlign: 'left', padding: '7px 8px', fontSize: '11px', color: MUTED, fontWeight: 600, borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={{ padding: '7px 8px', borderBottom: `1px solid ${SOFT}`, whiteSpace: 'nowrap', color: j === 0 ? INK : '#27272a', fontWeight: j === 0 ? 500 : 400, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function WidgetView({ chart, result, theme, polarity, compareLabel, compact }: { chart: Chart; result: Result; theme: Theme; polarity: Polarity; compareLabel: string; compact?: boolean }) {
  const { format } = result;
  if (chart === 'number' || (!result.groups && !result.series && !result.table && !result.funnel)) {
    return <NumberView value={result.value} format={format} prev={result.prev} polarity={polarity} theme={theme} compareLabel={compareLabel} compact={compact} />;
  }
  if (chart === 'donut' && result.groups) return <Donut groups={result.groups} format={format} theme={theme} />;
  if (chart === 'bar' && result.groups) return <HBars groups={result.groups} format={format} theme={theme} categorical={false} />;
  if (chart === 'column' && result.groups) return <HBars groups={result.groups} format={format} theme={theme} categorical={false} />;
  if (chart === 'column' && result.series) return <Columns points={result.series} format={format} theme={theme} />;
  if (chart === 'line' && result.series) return <LineChart points={result.series} format={format} theme={theme} />;
  if (chart === 'line' && result.groups) return <HBars groups={result.groups} format={format} theme={theme} categorical={false} />;
  if (chart === 'table' && result.table) return <Table cols={result.table.cols} rows={result.table.rows} />;
  if (chart === 'funnel' && result.funnel) return <Funnel steps={result.funnel} theme={theme} />;
  if (result.groups) return <HBars groups={result.groups} format={format} theme={theme} categorical={false} />;
  return <NumberView value={result.value} format={format} prev={result.prev} polarity={polarity} theme={theme} compareLabel={compareLabel} compact={compact} />;
}
