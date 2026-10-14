// Schedule C on the TC file: every requirement on the title commitment, each
// one green (cleared), yellow (in hand, not done) or red (a blocker), the way
// the TC tracks them with title every day (SOP step 8).
//
// Stored on transactions.schedule_c (migration 239) as a list; a save writes
// the whole list back, and a failed save puts the screen back to what the
// database has. Each change is applied to a fresh read of the list, so
// two people editing different items don't overwrite each other.
'use client';

import React, { useEffect, useId, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { patchRecord } from '@/lib/crm-write';
import { readScheduleC, scheduleCOverall, type ScheduleCItem, type ScheduleCStatus } from '@/lib/deal-close';
import { useConfirm } from '@/components/ds/Confirm';

const LIGHT: Record<ScheduleCStatus, { label: string; ink: string; bg: string; line: string }> = {
  green: { label: 'Cleared', ink: '#166534', bg: '#f0fdf4', line: '#bbf7d0' },
  yellow: { label: 'Working', ink: '#92400e', bg: '#fffbeb', line: '#fde68a' },
  red: { label: 'Blocker', ink: '#b91c1c', bg: '#fef2f2', line: '#fecaca' },
};
const ORDER: ScheduleCStatus[] = ['red', 'yellow', 'green'];

/**
 * Entering the commitment's items (each one green, yellow or red) is the
 * "Review title commitment" line (a17 assignment / n21 novation), so it is
 * ticked here. Lane, the stoplight and the TC board read the checklist, and
 * kept calling a reviewed Schedule C overdue.
 */
async function markReviewed(txId: number) {
  if (!supabase) return;
  const { data } = await supabase.from('transactions').select('checklist').eq('id', txId).maybeSingle();
  const ck = ((data as { checklist?: Record<string, unknown> | null } | null)?.checklist ?? {}) as Record<string, unknown>;
  if (ck.a17 && ck.n21) return;
  await patchRecord('transactions', txId, { checklist: { ...ck, a17: true, n21: true } });
}

export function ScheduleC({ txId, canWrite, readOnlyReason }: { txId: number; canWrite: boolean; readOnlyReason?: string }) {
  const [items, setItems] = useState<{ txId: number; list: ScheduleCItem[] } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useConfirm();
  const inputId = useId();

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void supabase.from('transactions').select('schedule_c' as 'id').eq('id', txId).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      // Before migration 239 the column is not there yet: say so instead of an empty list.
      if (error) { setState(/schedule_c/.test(error.message) ? 'missing' : 'error'); return; }
      setItems({ txId, list: readScheduleC((data as { schedule_c?: unknown } | null)?.schedule_c) });
      setState('ready');
    });
    return () => { live = false; };
  }, [txId]);

  const list = items?.txId === txId ? items.list : [];
  const overall = scheduleCOverall(list);

  /**
   * One change, applied to the list as the database has it now (read just
   * before the write), so two people editing different items both keep theirs.
   */
  type Change = { add: ScheduleCItem } | { set: { id: string; status: ScheduleCStatus } } | { remove: string };
  const apply = (base: ScheduleCItem[], c: Change): ScheduleCItem[] =>
    'add' in c ? [...base.filter((x) => x.id !== c.add.id), c.add]
      : 'set' in c ? base.map((x) => (x.id === c.set.id ? { ...x, status: c.set.status } : x))
        : base.filter((x) => x.id !== c.remove);
  async function write(c: Change) {
    const before = list;
    setItems({ txId, list: apply(before, c) });
    setBusy(true);
    const fresh = supabase ? await supabase.from('transactions').select('schedule_c' as 'id').eq('id', txId).maybeSingle() : null;
    const base = fresh && !fresh.error ? readScheduleC((fresh.data as { schedule_c?: unknown } | null)?.schedule_c) : before;
    const next = apply(base, c);
    const r = await patchRecord('transactions', txId, { schedule_c: next });
    setBusy(false);
    if (!r.ok) { setItems({ txId, list: before }); setErr(r.message); return false; }
    setItems({ txId, list: next });
    setErr(null);
    if (next.length) await markReviewed(txId);
    return true;
  }
  async function add() {
    const t = text.trim();
    if (!t) { setErr('Type the requirement as title wrote it'); return; }
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (await write({ add: { id, text: t, status: 'yellow' } })) setText('');
  }
  async function remove(it: ScheduleCItem) {
    const ok = await confirm({ title: 'Remove this Schedule C item?', body: it.text, confirmLabel: 'Remove item', tone: 'danger' });
    if (ok) await write({ remove: it.id });
  }

  const editable = canWrite && state === 'ready';
  return (
    <div data-testid="schedule-c" style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '14px' }}>Schedule C</span>
        <span style={{ fontSize: '12px', color: '#71717a' }}>Title commitment requirements</span>
        <span style={{ flex: 1 }} />
        {overall ? (
          <span data-testid="schedule-c-overall" style={{ fontSize: '11.5px', fontWeight: 700, color: LIGHT[overall].ink, background: LIGHT[overall].bg, border: `1px solid ${LIGHT[overall].line}`, borderRadius: '999px', padding: '2px 9px' }}>
            {overall === 'red' ? `${list.filter((i) => i.status === 'red').length} blocking` : overall === 'yellow' ? 'Still working' : 'All cleared'}
          </span>
        ) : null}
      </div>
      {state === 'loading' ? <p style={{ fontSize: '12.5px', color: '#71717a', margin: '8px 0 0' }}>Loading Schedule C…</p> : null}
      {state === 'missing' ? <p style={{ fontSize: '12.5px', color: '#71717a', margin: '8px 0 0' }}>Schedule C tracking turns on once database migration 239 is applied.</p> : null}
      {state === 'error' ? <p role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', margin: '8px 0 0' }}>Could not read Schedule C. Reload to try again.</p> : null}
      {state === 'ready' && !list.length ? (
        <p style={{ fontSize: '12.5px', color: '#71717a', margin: '8px 0 0' }}>Nothing listed yet. When the commitment comes in, add each requirement and mark it as title clears it.</p>
      ) : null}
      {[...list].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map((it) => (
        <div key={it.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: '8px', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0f0f1' }}>
          <span style={{ fontSize: '12.5px', color: '#18181b', minWidth: 0, overflowWrap: 'anywhere' }}>{it.text}</span>
          <select aria-label={`Status of ${it.text}`} value={it.status} disabled={!editable || busy} title={editable ? undefined : readOnlyReason}
            onChange={(e) => void write({ set: { id: it.id, status: e.target.value as ScheduleCStatus } })}
            style={{ height: '28px', borderRadius: '7px', border: `1px solid ${LIGHT[it.status].line}`, background: LIGHT[it.status].bg, color: LIGHT[it.status].ink, fontSize: '12px', fontWeight: 650, padding: '0 6px' }}>
            {ORDER.map((st) => <option key={st} value={st}>{LIGHT[st].label}</option>)}
          </select>
          {editable ? (
            <button type="button" onClick={() => void remove(it)} disabled={busy} aria-label={`Remove ${it.text}`}
              style={{ height: '28px', padding: '0 8px', borderRadius: '7px', border: '1px solid #e4e4e7', background: '#fff', color: '#71717a', fontSize: '12px', cursor: 'pointer' }}>Remove</button>
          ) : <span />}
        </div>
      ))}
      {editable ? (
        <div style={{ display: 'flex', gap: '6px', marginTop: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label htmlFor={inputId} style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '200px' }}>
            <span style={{ fontSize: '11.5px', fontWeight: 500, color: '#71717a' }}>New requirement</span>
            <input id={inputId} value={text} onChange={(e) => { setText(e.target.value); if (err) setErr(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
              style={{ height: '32px', padding: '0 10px', border: '1px solid #e4e4e7', borderRadius: '8px', fontSize: '12.5px', background: '#fff', color: '#18181b' }} />
          </label>
          <button type="button" onClick={() => void add()} disabled={busy}
            style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--c-primary)', background: 'var(--c-primary)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
            {busy ? 'Saving…' : 'Add item'}
          </button>
        </div>
      ) : null}
      {err ? <p role="alert" style={{ fontSize: '12px', color: '#b91c1c', margin: '6px 0 0' }}>{err}</p> : null}
    </div>
  );
}
