// "Lane heard": what Lane took from this file's calls, texts, emails, tasks
// and filed documents (lib/lane-updates.ts). Waiting items get Accept and
// Dismiss; what Lane applied on its own gets Undo. Each shows the words it
// rests on, so a TC can trust it without opening the thread.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  type LaneUpdate, acceptLaneUpdate, catchLaneUp, dismissLaneUpdate, loadLaneUpdates, undoLaneUpdate,
} from '@/lib/lane-updates';
import { supabase } from '@/lib/supabase';

const KIND: Record<LaneUpdate['kind'], string> = {
  tick: 'Checklist', task_done: 'Task done', date: 'Date', task_add: 'New task', party: 'Deal team', note: 'Note',
};
const btn: React.CSSProperties = { height: '26px', padding: '0 10px', borderRadius: '7px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', cursor: 'pointer', color: 'var(--ink, #18181b)', whiteSpace: 'nowrap' };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export function LaneHeard({ transactionId, workspaceId, me, canWrite, onChanged, onToast }: {
  transactionId: number | null; workspaceId: number | null; me: string | null; canWrite: boolean;
  /** After an accept or undo changed the file (checklist, tasks, team, dates). */
  onChanged?: () => void;
  onToast?: (m: string) => void;
}) {
  const [rows, setRows] = useState<LaneUpdate[] | null>(null);
  const [busy, setBusy] = useState<number | 'catch' | null>(null);
  const [showDone, setShowDone] = useState(false);
  const toast = onToast ?? (() => {});

  const load = useCallback(async () => {
    if (!transactionId) return;
    setRows(await loadLaneUpdates(transactionId));
  }, [transactionId]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  // Lane writes from the server every ten minutes; the card follows without a reload.
  useEffect(() => {
    if (!supabase || !transactionId) return;
    const sb = supabase;
    const ch = sb.channel(`lane-updates-${transactionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lane_updates', filter: `transaction_id=eq.${transactionId}` }, () => void load())
      .subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [transactionId, load]);

  if (!transactionId || !workspaceId) return null;
  const pending = (rows ?? []).filter((r) => r.status === 'pending');
  const done = (rows ?? []).filter((r) => r.status !== 'pending' && r.status !== 'dismissed');

  const act = async (u: LaneUpdate, what: 'accept' | 'dismiss' | 'undo') => {
    setBusy(u.id);
    const r = what === 'accept' ? await acceptLaneUpdate(u, workspaceId, me) : what === 'dismiss' ? await dismissLaneUpdate(u, me) : await undoLaneUpdate(u, me);
    setBusy(null);
    if (!r.ok) return toast(r.message ?? 'Could not save that.');
    toast(what === 'accept' ? 'Done — on the file' : what === 'undo' ? 'Undone' : 'Dismissed');
    void load();
    if (what !== 'dismiss') onChanged?.();
  };
  const catchUp = async () => {
    setBusy('catch');
    const r = await catchLaneUp(transactionId);
    setBusy(null);
    toast(r.message);
    void load();
    onChanged?.();
  };

  const row = (u: LaneUpdate) => (
    <div key={u.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '10px', alignItems: 'start', padding: '9px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)', opacity: u.status === 'undone' ? 0.55 : 1 }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--c-lane)' }}>{KIND[u.kind]}</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink, #18181b)', textDecoration: u.status === 'undone' ? 'line-through' : 'none' }}>{u.summary}</span>
        </span>
        {u.evidence ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', marginTop: '2px', lineHeight: 1.45 }}>“{u.evidence}”</span> : null}
        <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--subtle, #a1a1aa)', marginTop: '2px' }}>
          {ago(u.created_at)}{u.status === 'applied' && !u.decided_by ? ' · applied by Lane' : u.status === 'applied' ? ' · accepted' : u.status === 'undone' ? ' · undone' : u.confidence === 'medium' ? ' · check this one' : ''}
        </span>
      </span>
      {canWrite ? (
        <span style={{ display: 'flex', gap: '6px' }}>
          {u.status === 'pending' ? (
            <>
              <button style={{ ...btn, background: 'var(--c-lane)', borderColor: 'var(--c-lane)', color: '#fff' }} disabled={busy === u.id} onClick={() => void act(u, 'accept')}>{u.kind === 'note' ? 'Keep' : 'Accept'}</button>
              <button style={btn} disabled={busy === u.id} onClick={() => void act(u, 'dismiss')}>Dismiss</button>
            </>
          ) : u.status === 'applied' && (u.kind === 'tick' || u.kind === 'task_done') && !u.decided_by ? (
            <button style={btn} disabled={busy === u.id} onClick={() => void act(u, 'undo')}>Undo</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );

  return (
    <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderTop: '3px solid var(--c-lane)', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--c-lane)' }}>Lane heard</span>
        <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>
          {rows === null ? 'Loading…' : pending.length ? `${pending.length} to review` : 'Nothing waiting'} · calls, texts, email and tasks with seller, buyer and title
        </span>
        <div style={{ flex: 1 }} />
        {done.length ? <button style={{ ...btn, border: 0, color: 'var(--meta, #71717a)' }} onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide' : 'Show'} what Lane applied ({done.length})</button> : null}
        {canWrite ? <button style={btn} disabled={busy === 'catch'} onClick={() => void catchUp()}>{busy === 'catch' ? 'Listening…' : 'Catch Lane up'}</button> : null}
      </div>
      {pending.map(row)}
      {showDone ? done.map(row) : null}
    </div>
  );
}
