// Settings → Archive: every archived seller and buyer, searchable, and a way
// to put any of them back. Archiving never deletes; restoring clears
// archived_at and the record is on every list again.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { archiveBuyers, archiveSellers } from '@/lib/crm-write';

type Kind = 'seller' | 'buyer';
type Row = { id: number; name: string | null; phone: string | null; email: string | null; where: string | null; archived_at: string };

const MUTED = '#71717a';
const LINE = '#e4e4e7';
const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const btn = (primary = false): React.CSSProperties => ({
  height: '30px', padding: '0 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? '#0A8560' : LINE}`, background: primary ? '#0A8560' : '#fff', color: primary ? '#fff' : '#18181b',
});
const PAGE = 100;
/** "%" and "_" are wildcards to ILIKE; "," and parentheses break an or() filter. */
const likeSafe = (q: string) => q.replace(/[%_\\,()]/g, ' ').trim();

export function ArchiveSettings({ workspaceId, canWrite, onOpen, onRestored }: {
  workspaceId: number | null; canWrite: boolean;
  onOpen?: (kind: Kind, id: number) => void;
  onRestored?: () => void;
}) {
  const [kind, setKind] = useState<Kind>('seller');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (k: Kind, query: string) => {
    if (!supabase || !workspaceId) return { rows: [] as Row[], error: null };
    const s = likeSafe(query);
    const cols = k === 'seller' ? 'id, name, phone, email, property_address, archived_at' : 'id, name, phone, email, company, archived_at';
    let req = supabase.from(k === 'seller' ? 'sellers' : 'buyers').select(cols).eq('workspace_id', workspaceId).not('archived_at', 'is', null);
    if (s) req = req.or(k === 'seller' ? `name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%,property_address.ilike.%${s}%` : `name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%`);
    const { data, error: e } = await req.order('archived_at', { ascending: false }).limit(PAGE);
    if (e) return { rows: [] as Row[], error: e.message };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { rows: ((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, where: r.property_address ?? r.company ?? null, archived_at: r.archived_at })), error: null };
  }, [workspaceId]);

  // Typing settles for a moment before it searches; the result lands in a callback, not the effect body.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void load(kind, q).then((r) => { if (live) { setRows(r.rows); setError(r.error); setPicked(new Set()); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [kind, q, load, tick]);

  const restore = async (list: number[], open?: number) => {
    if (!list.length) return;
    setBusy(true); setMsg(null);
    const ids = list.map((id) => (kind === 'seller' ? 's' : 'b') + id);
    const r = kind === 'seller' ? await archiveSellers(ids, false) : await archiveBuyers(ids, false);
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Could not restore.'); return; }
    setMsg(`${list.length} ${kind === 'seller' ? (list.length === 1 ? 'seller' : 'sellers') : (list.length === 1 ? 'buyer' : 'buyers')} back on every list.`);
    onRestored?.();
    if (open != null) onOpen?.(kind, open);
    setTick((t) => t + 1);
  };

  if (!workspaceId) return <div style={card}><p style={{ margin: 0, fontSize: '12.5px', color: MUTED }}>The archive is on a signed-in workspace.</p></div>;

  const all = rows ?? [];
  const allOn = all.length > 0 && all.every((r) => picked.has(r.id));
  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Archive</h2>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: MUTED }}>
        Archived sellers and buyers are off every list, nothing deleted. Restore puts them back. Adding someone again from Quick Add also offers to bring them back.
      </p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
        {(['seller', 'buyer'] as const).map((k) => (
          <button key={k} type="button" onClick={() => { setKind(k); setRows(null); }} aria-pressed={kind === k}
            style={{ ...btn(), borderRadius: '999px', borderColor: kind === k ? '#0A8560' : LINE, background: kind === k ? '#E7F8F1' : '#fff', color: kind === k ? '#0A8560' : '#27272a' }}>
            {k === 'seller' ? 'Sellers' : 'Buyers'}
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email, address" aria-label="Search the archive"
          style={{ flex: '1 1 220px', minWidth: 0, height: '32px', padding: '0 10px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '12.5px' }} />
        {canWrite && picked.size ? (
          <button type="button" style={btn(true)} disabled={busy} onClick={() => void restore([...picked])}>{busy ? 'Restoring…' : `Restore ${picked.size}`}</button>
        ) : null}
      </div>
      {msg ? <div role="status" style={{ fontSize: '12.5px', color: '#0A8560', marginBottom: '8px' }}>{msg}</div> : null}
      {error ? <div role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', marginBottom: '8px' }}>{error}</div> : null}
      {rows === null ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading…</div>
        : !all.length ? <div style={{ fontSize: '12.5px', color: MUTED }}>{q ? 'Nobody archived matches that.' : `No archived ${kind}s.`}</div>
        : (
          <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden' }}>
            {canWrite ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: '#fafafa', borderBottom: `1px solid ${LINE}`, fontSize: '12px', color: MUTED }}>
                <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(all.map((r) => r.id)))} />
                Select all {all.length}{all.length === PAGE ? ' shown (search to narrow)' : ''}
              </label>
            ) : null}
            {all.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderTop: `1px solid #f0f0f1`, flexWrap: 'wrap' }}>
                {canWrite ? (
                  <input type="checkbox" aria-label={`Select ${r.name ?? 'record'}`} checked={picked.has(r.id)}
                    onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                ) : null}
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || 'No name'}</div>
                  <div style={{ fontSize: '11.5px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[r.phone, r.email, r.where].filter(Boolean).join(' · ') || '—'} · archived {new Date(r.archived_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
                {canWrite ? <button type="button" style={btn(true)} disabled={busy} onClick={() => void restore([r.id], r.id)}>Restore and open</button> : null}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
