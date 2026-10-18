// Settings → History: every skip trace and import, newest first (lib/data-runs,
// migration 117). Who ran it, what it touched, how it went, what it cost.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { type DataRun, listRuns } from '@/lib/data-runs';
import { listTeam, type Teammate } from '@/lib/team';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const HAIR = 'var(--divider-2, #f0f0f1)';
const GREEN = '#0A8560';

const chip = (on: boolean): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '999px', fontSize: '12px', fontWeight: on ? 650 : 500, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? GREEN : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: on ? GREEN : 'var(--ink-2, #27272a)', fontFamily: 'inherit',
});
const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--meta, #71717a)', padding: '0 12px', height: '34px', borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', background: 'var(--canvas, #fafafa)' };
const td: React.CSSProperties = { padding: '9px 12px', borderBottom: `1px solid ${HAIR}`, fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)', verticalAlign: 'top' };
const when = (s: string) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const n = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : '0');

function results(r: DataRun): string {
  const d = r.detail as Record<string, unknown>;
  if (r.kind === 'skiptrace') {
    return [`${n(d.found)} with contacts`, d.phones != null ? `${n(d.phones)} phones` : null, d.emails != null ? `${n(d.emails)} emails` : null, d.cached ? `${n(d.cached)} from cache` : null, r.failed ? `${n(r.failed)} failed` : null]
      .filter(Boolean).join(' · ');
  }
  return [`${n(d.created)} created`, `${n(d.updated)} updated`, d.cosellers ? `${n(d.cosellers)} co-sellers` : null, d.skipped ? `${n(d.skipped)} skipped` : null, r.failed ? `${n(r.failed)} failed` : null, d.stage ? `stage ${String(d.stage)}` : null]
    .filter(Boolean).join(' · ');
}

export function DataHistory({ workspaceId, isMobile }: { workspaceId: number | null; isMobile: boolean }) {
  const [rows, setRows] = useState<{ ws: number; runs: DataRun[] } | null>(null);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [kind, setKind] = useState<'all' | 'skiptrace' | 'import'>('all');
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void Promise.all([listRuns(workspaceId, 500), listTeam(workspaceId)]).then(([runs, t]) => { if (live) { setRows({ ws: workspaceId, runs }); setTeam(t); } });
    return () => { live = false; };
  }, [workspaceId]);
  const runs = rows && rows.ws === workspaceId ? rows.runs : null;
  const who = useMemo(() => new Map(team.map((t) => [t.user_id, t.full_name || t.email || 'Teammate'])), [team]);
  const shown = (runs ?? []).filter((r) => kind === 'all' || r.kind === kind);
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const creditsThisMonth = (runs ?? []).filter((r) => r.kind === 'skiptrace' && Date.parse(r.created_at) >= month.getTime()).reduce((a, r) => a + (r.credits || 0), 0);
  const counts = { skiptrace: (runs ?? []).filter((r) => r.kind === 'skiptrace').length, import: (runs ?? []).filter((r) => r.kind === 'import').length };

  if (!workspaceId) return <div style={{ fontSize: '13px', color: MUTED }}>History lives on a signed-in workspace.</div>;
  return (
    <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '12px 14px', borderBottom: `1px solid ${LINE}` }}>
        <button type="button" onClick={() => setKind('all')} style={chip(kind === 'all')}>All · {runs?.length ?? 0}</button>
        <button type="button" onClick={() => setKind('skiptrace')} style={chip(kind === 'skiptrace')}>Skip traces · {counts.skiptrace}</button>
        <button type="button" onClick={() => setKind('import')} style={chip(kind === 'import')}>Imports · {counts.import}</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: '12px', color: MUTED }}>Skip trace credits this month: <b style={{ color: INK }}>{creditsThisMonth.toLocaleString('en-US')}</b></span>
      </div>
      {!runs ? <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px', color: MUTED }}>Loading…</div>
        : !shown.length ? <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px', color: MUTED }}>Nothing here yet. Skip traces and imports are listed from now on.</div>
        : isMobile ? (
          <div>
            {shown.map((r) => (
              <div key={r.id} style={{ padding: '10px 14px', borderBottom: `1px solid ${HAIR}` }}>
                <div style={{ fontSize: '13px', fontWeight: 650, color: INK }}>{r.label || (r.kind === 'import' ? 'Import' : 'Skip trace')}</div>
                <div style={{ fontSize: '12px', color: MUTED }}>{when(r.created_at)} · {r.created_by ? who.get(r.created_by) ?? 'Teammate' : 'System'}</div>
                <div style={{ fontSize: '12px', color: 'var(--ink-3, #3f3f46)', marginTop: '3px' }}>{results(r)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflow: 'auto', maxHeight: '70vh' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead><tr><th style={th}>When</th><th style={th}>What</th><th style={th}>Records</th><th style={th}>Result</th><th style={th}>Credits</th><th style={th}>By</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const err = (r.detail as { message?: string; errors?: string[] }).message ?? (r.detail as { errors?: string[] }).errors?.[0];
                  return (
                    <tr key={r.id}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(r.created_at)}</td>
                      <td style={td}>
                        <span style={{ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '2px 7px', marginRight: '6px', background: r.kind === 'import' ? '#eef2ff' : '#E7F8F1', color: r.kind === 'import' ? '#4338ca' : GREEN }}>{r.kind === 'import' ? 'Import' : 'Skip trace'}</span>
                        <span style={{ color: INK, fontWeight: 600 }}>{r.label}</span>
                        {err ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '2px' }}>{err}</div> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{n(r.total)} {r.entity ?? ''}{r.total === 1 ? '' : r.entity ? 's' : ''}</td>
                      <td style={td}>{results(r)}</td>
                      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.kind === 'skiptrace' ? n(r.credits) : '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.created_by ? who.get(r.created_by) ?? 'Teammate' : 'System'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
