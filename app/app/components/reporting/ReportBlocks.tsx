'use client';

// Draws the blocks lib/reporting.ts computes for a tab. No chart library:
// bars are divs, the funnel is CSS widths, tables scroll inside their card.

import React from 'react';
import type { Block } from '@/lib/reporting';
import { DiagramBlock } from './diagrams';

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', minWidth: 0 };
const head: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '12px 16px', borderBottom: '1px solid #f0f0f1' };
const title: React.CSSProperties = { fontWeight: 600, fontSize: '14px' };
const sub: React.CSSProperties = { fontSize: '11.5px', color: '#71717a' };
const empty: React.CSSProperties = { padding: '22px 16px', fontSize: '12.5px', color: '#71717a' };

function Head({ t, s }: { t: string; s?: string }) {
  return <div style={head}><span style={title}>{t}</span>{s ? <span style={sub}>{s}</span> : null}</div>;
}

export function ReportBlocks({ blocks, isMobile, bank }: { blocks: Block[]; isMobile: boolean; bank: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'repeat(2, minmax(0,1fr))', gap: '14px', alignItems: 'start' }}>
      {blocks.map((b, i) => {
        const span = { gridColumn: !isMobile && !('half' in b && b.half) ? '1 / -1' : undefined };
        if (b.kind === 'bank') return <div key={i} style={span}>{bank}</div>;
        if (b.kind === 'diagram') return <div key={i} style={{ ...span, minWidth: 0 }}><DiagramBlock b={b} /></div>;
        if (b.kind === 'kpis') {
          return (
            <div key={i} style={{ ...card, ...span, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', overflow: 'hidden' }}>
              {b.items.map((k) => (
                <div key={k.k} style={{ padding: '14px 16px', borderRight: '1px solid #f0f0f1', borderBottom: '1px solid #f0f0f1', marginBottom: '-1px' }}>
                  <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.k}</div>
                  <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.03em', marginTop: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.v}</div>
                  {k.d ? <div style={{ fontSize: '11.5px', marginTop: '2px', color: k.dColor ?? '#71717a' }}>{k.d}</div> : null}
                </div>
              ))}
            </div>
          );
        }
        if (b.kind === 'note') {
          return (
            <div key={i} style={{ ...card, ...span, padding: '14px 16px', background: '#fafafa' }}>
              <div style={title}>{b.title}</div>
              <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: '#52525b', lineHeight: 1.5 }}>{b.text}</p>
            </div>
          );
        }
        if (b.kind === 'funnel') {
          return (
            <div key={i} style={{ ...card, ...span }}>
              <Head t={b.title} s={b.sub} />
              {!b.steps[0]?.n ? <div style={empty}>{b.empty}</div> : (
                <div style={{ padding: '4px 16px 16px' }}>
                  {b.steps.map((f) => (
                    <div key={f.k} style={{ marginTop: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px' }}>
                        <span style={{ color: '#52525b' }}>{f.k}</span>
                        <span><span style={{ fontWeight: 600 }}>{f.n.toLocaleString('en-US')}</span>{f.rate ? <span style={{ color: '#a1a1aa', marginLeft: '8px' }}>{f.rate}</span> : null}</span>
                      </div>
                      <div style={{ height: '8px', background: '#f0f0f1', borderRadius: '4px', marginTop: '5px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: f.pct + '%', background: '#0A8560', borderRadius: '4px' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (b.kind === 'bars') {
          const max = Math.max(0, ...b.items.map((x) => x.value));
          const every = Math.ceil(b.items.length / 12);
          return (
            <div key={i} style={{ ...card, ...span }}>
              <Head t={b.title} s={b.sub} />
              {max <= 0 ? <div style={empty}>{b.empty}</div> : b.rows ? (
                <div style={{ padding: '6px 16px 16px' }}>
                  {b.items.map((x) => (
                    <div key={x.label} title={x.tip} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 38%) 1fr auto', gap: '8px', alignItems: 'center', marginTop: '10px', fontSize: '12px' }}>
                      <span style={{ color: '#52525b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.label}</span>
                      <span style={{ height: '6px', background: '#f0f0f1', borderRadius: '3px', overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: (x.value / max) * 100 + '%', background: '#18181b' }} />
                      </span>
                      <span style={{ fontWeight: 600, textAlign: 'right' }}>{x.value.toLocaleString('en-US')}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: b.items.length > 30 ? '2px' : '6px', height: '180px', padding: '14px 16px 12px', minWidth: b.items.length * 14 + 'px' }}>
                    {b.items.map((x, j) => (
                      <div key={j} title={x.tip} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' }}>
                        <div style={{ width: '100%', height: max ? Math.max(x.value ? 2 : 0, (x.value / max) * 100) + '%' : 0, background: x.value ? '#0A8560' : '#e4e4e7', borderRadius: '3px 3px 0 0' }} />
                        <span style={{ fontSize: '10px', color: '#a1a1aa', whiteSpace: 'nowrap', visibility: j % every ? 'hidden' : 'visible' }}>{x.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        }
        return (
          <div key={i} style={{ ...card, ...span, overflow: 'hidden' }}>
            <Head t={b.title} s={b.sub} />
            {!b.rows.length ? <div style={empty}>{b.empty}</div> : <Table cols={b.cols} rows={b.rows} />}
          </div>
        );
      })}
    </div>
  );
}

export function Table({ cols, rows }: { cols: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflow: 'auto', maxHeight: '460px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
        <thead>
          <tr>
            {cols.map((c, j) => (
              <th key={j} style={{ position: 'sticky', top: 0, zIndex: 1, padding: '0 12px', height: '34px', textAlign: j ? 'right' : 'left', fontSize: '11px', fontWeight: 600, color: '#71717a', borderBottom: '1px solid #f0f0f1', whiteSpace: 'nowrap', background: 'var(--c-thead)' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className="dc2">
              {r.map((v, j) => (
                <td key={j} style={{ padding: '0 12px', height: '38px', borderBottom: '1px solid #f0f0f1', whiteSpace: 'nowrap', textAlign: j ? 'right' : 'left', fontWeight: j ? 400 : 500, fontVariantNumeric: 'tabular-nums', maxWidth: j ? undefined : '280px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
