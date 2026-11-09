'use client';

// Every deal's buyer blasts in one table (dispo_campaigns): where each is,
// Pause, Resume and Stop, and the way to the deal's Marketing tab, where the
// lines, replies and per-buyer detail live. Building a blast stays on the
// deal, since it starts from the deal's buyers.

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useConfirm } from '@/components/ds/Confirm';
import { type Blast, setCampaignStatus } from '@/lib/dispo-campaign';

const LABEL: Record<string, string> = { running: 'Running', paused: 'Paused', done: 'Done', cancelled: 'Stopped' };
// The list's dots: running reads as active, done as completed, stopped as a draft's grey.
const DOT: Record<string, string> = { running: 'active', paused: 'paused', done: 'completed', cancelled: 'draft' };
const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' });
const n = (x: number) => x.toLocaleString('en-US');

export function DealBlasts({ rows, loading, error, canWrite, onOpenDeal, onChanged, toast }: {
  rows: Blast[]; loading: boolean; error: string | null; canWrite: boolean;
  onOpenDeal: (dealId: number) => void; onChanged: () => void; toast: (msg: string, tone?: 'error' | 'success') => void;
}) {
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);
  const set = async (b: Blast, status: Blast['status'], done: string) => {
    setBusy(b.id);
    const r = await setCampaignStatus(b.id, status);
    setBusy(null);
    if (r.ok) toast(done, 'success'); else toast(r.message, 'error');
    onChanged();
  };
  const stop = async (b: Blast) => {
    const ok = await confirm({
      title: `Stop the ${b.address} blast?`,
      body: `${n(b.queued)} message${b.queued === 1 ? '' : 's'} not sent yet will never go out. Replies still come in. Pause instead to hold it.`,
      confirmLabel: 'Stop blast', tone: 'danger',
    });
    if (ok) await set(b, 'cancelled', 'Blast stopped');
  };

  if (error) return <div className="cp-alert" role="alert" style={{ margin: 12 }}>Deal blasts did not load: {error}</div>;
  if (loading && !rows.length) return <div className="cp-empty" role="status">Loading deal blasts…</div>;
  if (!rows.length) {
    return (
      <div className="cp-empty">
        <h3>No deal blasts yet</h3>
        <span>Open a deal in Dispo, go to Marketing, and send its buyers a blast. It shows here while it runs.</span>
      </div>
    );
  }
  return (
    <table className="cp-table" data-testid="deal-blasts">
      <thead><tr><th>Deal</th><th>Status</th><th>Progress</th><th>Buyers</th><th>Replied</th><th>Launched</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className="cp-row" tabIndex={0} onClick={() => onOpenDeal(b.deal_id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenDeal(b.deal_id); }}>
            <td className="cp-name" title={b.address}>{b.address}</td>
            <td><span className="cp-status"><span className="cp-dot" data-s={DOT[b.status] ?? 'draft'} aria-hidden />{LABEL[b.status] ?? b.status}</span></td>
            <td>{n(b.sent)} of {n(b.total)} sent{b.queued && b.status !== 'cancelled' ? <span className="cp-sub"> · {n(b.queued)} queued</span> : null}</td>
            <td>{n(b.recipients)}</td>
            <td>{n(b.replied)}</td>
            <td className="cp-sub">{fmt(b.created_at)}</td>
            <td className="cp-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {canWrite && b.status === 'running' ? <button type="button" className="cp-btn" disabled={busy === b.id} onClick={() => void set(b, 'paused', 'Blast paused')}>Pause</button> : null}
              {canWrite && b.status === 'paused' ? <button type="button" className="cp-btn" disabled={busy === b.id} onClick={() => void set(b, 'running', 'Blast resumed')}>Resume</button> : null}
              {canWrite && (b.status === 'running' || b.status === 'paused') ? <button type="button" className="cp-btn" data-kind="danger" disabled={busy === b.id} onClick={() => void stop(b)}>Stop</button> : null}
              <button type="button" className="cp-icon-btn" aria-label={`Open the ${b.address} deal's Marketing tab`} title="Open the deal's Marketing tab: lines, replies, each buyer" onClick={() => onOpenDeal(b.deal_id)}><ExternalLink size={14} aria-hidden /></button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
