// The terms Claude read off a contract's PDF, and where they disagree with
// the deal sheet ("Review changes"): per-row Apply and Dismiss, or Apply all.
// Below it, the Extracted terms view for the Contracts screen: every term
// read in the workspace, searchable and filterable (all close dates this
// month, every title company, …).
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { ContractRow } from '@/lib/contracts';
import {
  type ContractExtractionRow, type Review, EXTRACT_FIELDS, applyTerms, dismissTerms, extractTerms, fieldKind, fieldLabel,
  listExtractions, normDate, reviewTerms,
} from '@/lib/contract-extract';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const HAIR = 'var(--divider-2, #f0f0f1)';
const GREEN = '#0A8560';
const link: React.CSSProperties = { fontSize: '12px', color: GREEN, background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 500, fontFamily: 'inherit' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '28px', padding: '0 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : INK, opacity: disabled ? 0.6 : 1, fontFamily: 'inherit',
});
const pct = (c: number | null) => (c == null ? '' : `${Math.round(c * 100)}%`);
const confColor = (c: number | null) => (c == null ? MUTED : c >= 0.85 ? '#15803d' : c >= 0.6 ? '#b45309' : '#b91c1c');
const fmtWhen = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** One contract's read terms and its Review changes list. */
export function ContractTermsPanel({ contract, canWrite, onToast, onChanged }: {
  contract: ContractRow; canWrite: boolean; onToast: (m: string) => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<{ id: number; review: Review } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const review = data && data.id === contract.id ? data.review : null;

  useEffect(() => {
    let live = true;
    void reviewTerms(contract.id).then((r) => {
      if (!live) return;
      if (r.ok) { setData({ id: contract.id, review: r.data }); setFailed(null); } else setFailed(r.message);
    });
    return () => { live = false; };
  }, [contract.id, tick]);

  async function run() {
    setBusy('extract');
    const r = await extractTerms(contract.id);
    setBusy(null);
    if (!r.ok) { onToast(r.message); setTick((t) => t + 1); return; }
    onToast(r.data.fields.length ? `Read ${r.data.fields.length} term${r.data.fields.length === 1 ? '' : 's'}${r.data.diff.length ? ` · ${r.data.diff.length} differ from the deal` : ''}` : 'No terms found in this PDF');
    setTick((t) => t + 1);
  }
  async function apply(ids: number[]) {
    setBusy(`apply:${ids.join(',')}`);
    const r = await applyTerms(ids);
    setBusy(null);
    if (!r.ok) return onToast(r.message);
    onToast(`Deal updated · ${r.data.applied.length} term${r.data.applied.length === 1 ? '' : 's'}`);
    setTick((t) => t + 1); onChanged?.();
  }
  async function dismiss(ids: number[]) {
    setBusy(`dismiss:${ids.join(',')}`);
    const r = await dismissTerms(ids);
    setBusy(null);
    if (!r.ok) return onToast(r.message);
    setTick((t) => t + 1);
  }

  if (failed) return <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginTop: '8px' }}>{failed}</div>;
  if (!review) return <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)', marginTop: '8px' }}>Loading terms…</div>;
  const diff = review.diff;
  const applyable = diff.filter((d) => d.column);
  const live = review.extractions.filter((x) => !x.dismissed_at);
  const status = busy === 'extract' || review.status === 'running' ? 'Reading the PDF…'
    : review.status === 'failed' ? `Last read failed: ${review.error ?? 'unknown error'}`
    : review.extracted_at ? `Read ${fmtWhen(review.extracted_at)}` : live.length ? '' : 'Not read yet';

  return (
    <div style={{ marginTop: '8px', border: `1px solid ${LINE}`, borderRadius: '10px', background: '#fcfcfc', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12.5px', fontWeight: 650, color: INK }}>Terms from the PDF</span>
        <span style={{ fontSize: '11.5px', color: review.status === 'failed' ? '#b91c1c' : MUTED, flex: 1, minWidth: '120px' }}>{status}</span>
        {canWrite && review.has_pdf ? (
          <button type="button" style={btn(!live.length, !!busy)} disabled={!!busy} onClick={() => void run()}>
            {busy === 'extract' ? 'Reading…' : live.length ? 'Re-run' : 'Read terms'}
          </button>
        ) : null}
        {!review.has_pdf ? <span style={{ fontSize: '11.5px', color: MUTED }}>No PDF on this contract yet.</span> : null}
      </div>

      {diff.length ? (
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '11.5px', color: 'var(--tx-amber, #b45309)', fontWeight: 700, flex: 1 }}>Review changes · {diff.length}</span>
            {canWrite && applyable.length > 1 ? (
              <button type="button" style={btn(true, !!busy)} disabled={!!busy} onClick={() => void apply(applyable.map((d) => d.extraction_id))}>Apply all to deal</button>
            ) : null}
          </div>
          {diff.map((d) => (
            <div key={d.extraction_id} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '6px 0', borderTop: `1px solid ${HAIR}` }}>
              <div style={{ flex: 1, minWidth: '200px', fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)' }}>
                <b style={{ color: INK }}>{d.label}</b>: PDF says <b style={{ color: INK }}>{d.pdf_display}</b>, deal says <b style={{ color: INK }}>{d.deal_display}</b>
                <span style={{ fontSize: '11px', color: confColor(d.confidence), marginLeft: '6px' }}>{pct(d.confidence)}</span>
                {d.page ? <span style={{ fontSize: '11px', color: MUTED, marginLeft: '6px' }}>p.{d.page}</span> : null}
                {!d.column ? <span style={{ fontSize: '11px', color: MUTED, marginLeft: '6px' }}>· change it on the deal</span> : null}
              </div>
              {canWrite ? (
                <span style={{ display: 'inline-flex', gap: '10px' }}>
                  {d.column ? <button type="button" style={link} disabled={!!busy} onClick={() => void apply([d.extraction_id])}>{busy === `apply:${d.extraction_id}` ? 'Applying…' : 'Apply'}</button> : null}
                  <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => void dismiss([d.extraction_id])}>Dismiss</button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : live.length ? <div style={{ fontSize: '12px', color: 'var(--tx-green, #15803d)', marginTop: '6px' }}>The deal matches the PDF.</div> : null}

      {live.length ? (
        <div style={{ marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 16px' }}>
          {live.map((x) => (
            <div key={x.id} style={{ fontSize: '12px', color: 'var(--ink-3, #3f3f46)', padding: '3px 0', borderBottom: `1px solid ${HAIR}` }} title={x.model ? `Read by ${x.model}` : undefined}>
              <span style={{ color: MUTED }}>{fieldLabel(x.field_key)}</span>{' '}
              <span style={{ color: INK, fontWeight: 550 }}>{x.value}</span>{' '}
              <span style={{ fontSize: '10.5px', color: confColor(x.confidence) }}>{pct(x.confidence)}</span>
              {x.page ? <span style={{ fontSize: '10.5px', color: MUTED }}> · p.{x.page}</span> : null}
              {x.applied_to_deal_at ? <span style={{ fontSize: '10.5px', color: 'var(--tx-green, #15803d)' }}> · applied</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- search view
type Range = { id: string; label: string; from?: string; to?: string };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** The date windows, worked out when a chip is pressed (never in render). */
function rangeFor(id: string): Range {
  const now = new Date();
  if (id === 'month') return { id, label: 'This month', from: ymd(new Date(now.getFullYear(), now.getMonth(), 1, 12)), to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12)) };
  if (id === 'next30') return { id, label: 'Next 30 days', from: ymd(now), to: ymd(new Date(now.getTime() + 30 * 864e5)) };
  if (id === 'past30') return { id, label: 'Last 30 days', from: ymd(new Date(now.getTime() - 30 * 864e5)), to: ymd(now) };
  return { id: 'any', label: 'Any date' };
}
const RANGES = ['any', 'month', 'next30', 'past30'];
const RANGE_LABEL: Record<string, string> = { any: 'Any date', month: 'This month', next30: 'Next 30 days', past30: 'Last 30 days' };

/** Every extracted term across the workspace's contracts. */
export function ExtractedTermsView({ workspaceId, contracts, onOpen }: { workspaceId: number; contracts: ContractRow[]; onOpen: (c: ContractRow) => void }) {
  const [field, setField] = useState('close_date');
  const [range, setRange] = useState<Range>({ id: 'any', label: 'Any date' });
  const [q, setQ] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; rows: ContractExtractionRow[] } | null>(null);
  const key = `${workspaceId}:${field}`;
  const rows = loaded && loaded.key === key ? loaded.rows : null;
  const byId = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts]);
  const isDate = fieldKind(field) === 'date';

  useEffect(() => {
    let live = true;
    void listExtractions(workspaceId, field || null).then((r) => { if (live) setLoaded({ key, rows: r }); });
    return () => { live = false; };
  }, [workspaceId, field, key]);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((x) => {
    if (isDate && range.from && range.to) {
      const d = normDate(x.value);
      if (!d || d < range.from || d > range.to) return false;
    }
    if (!terms.length) return true;
    const c = x.contract_id ? byId.get(x.contract_id) : undefined;
    const hay = `${x.value} ${fieldLabel(x.field_key)} ${c?.name ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }).sort((a, b) => (isDate ? String(normDate(a.value) ?? '').localeCompare(String(normDate(b.value) ?? '')) : 0));

  const th: React.CSSProperties = { position: 'sticky', top: 0, background: 'var(--c-thead, #fafafa)', borderBottom: `1px solid ${LINE}`, padding: '0 12px', height: '36px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--meta, #71717a)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '0 12px', height: '42px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', color: 'var(--muted, #52525b)', fontSize: '12.5px' };
  const chip = (on: boolean): React.CSSProperties => ({
    height: '30px', padding: '0 11px', borderRadius: '999px', fontSize: '12px', fontWeight: on ? 650 : 500, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${on ? GREEN : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: on ? GREEN : 'var(--ink-2, #27272a)', fontFamily: 'inherit',
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Which term" style={{ height: '32px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 8px', fontSize: '12.5px', background: 'var(--surface, #fff)', fontFamily: 'inherit' }}>
          <option value="">Every term</option>
          {EXTRACT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        {isDate ? RANGES.map((id) => (
          <button key={id} type="button" className="dc2" style={chip(range.id === id)} onClick={() => setRange(rangeFor(id))}>{RANGE_LABEL[id]}</button>
        )) : null}
        <span style={{ flex: 1 }} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms or contracts…" aria-label="Search extracted terms" style={{ height: '32px', width: 'min(280px, 100%)', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '12.5px', background: 'var(--surface, #fff)' }} />
      </div>
      <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'auto', maxHeight: '62vh' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: '680px' }}>
          <thead><tr><th style={th}>Term</th><th style={th}>Value</th><th style={th}>Contract</th><th style={th}>Confidence</th><th style={th}>Page</th><th style={th}>Deal</th></tr></thead>
          <tbody>
            {shown.map((x) => {
              const c = x.contract_id ? byId.get(x.contract_id) : undefined;
              return (
                <tr key={x.id} className="dc2" onClick={() => c && onOpen(c)} style={{ cursor: c ? 'pointer' : 'default' }}>
                  <td style={td}>{fieldLabel(x.field_key)}</td>
                  <td style={{ ...td, color: INK, fontWeight: 600, maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={x.value}>{x.value}</td>
                  <td style={{ ...td, maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c?.name ?? (x.deal_file_id ? 'Uploaded file' : '—')}</td>
                  <td style={{ ...td, color: confColor(x.confidence) }}>{pct(x.confidence) || '—'}</td>
                  <td style={td}>{x.page ?? '—'}</td>
                  <td style={td}>{x.applied_to_deal_at ? <span style={{ color: 'var(--tx-green, #15803d)' }}>Applied</span> : '—'}</td>
                </tr>
              );
            })}
            {rows && !shown.length ? <tr><td colSpan={6} style={{ ...td, height: '80px', textAlign: 'center', color: MUTED }}>{rows.length ? 'No terms match.' : 'No terms read yet. Signed contracts are read automatically; open one and press Read terms for older ones.'}</td></tr> : null}
            {!rows ? <tr><td colSpan={6} style={{ ...td, height: '80px', textAlign: 'center', color: MUTED }}>Loading terms…</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
