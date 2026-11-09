// Edit a task: title, type, priority, due, assignee and note, plus Delete.
// Opened from a task row (Tasks screen) or the record's Next action card.
// A phone gets a bottom sheet, a desk a centred dialog; both are the same form.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';

const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];

const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', fontWeight: 500, color: 'var(--muted, #71717a)', marginBottom: '4px' };
const field: React.CSSProperties = {
  width: '100%', height: '38px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)',
  background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', font: 'inherit', fontSize: 'var(--ds-input-size, 13px)', boxSizing: 'border-box',
};
const btn = (kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
  height: '36px', padding: '0 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit',
  border: `1px solid ${kind === 'primary' ? 'var(--c-primary, #0a8560)' : 'var(--divider, #e4e4e7)'}`,
  background: kind === 'primary' ? 'var(--c-primary, #0a8560)' : 'var(--surface, #fff)',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? 'var(--tx-red, #b91c1c)' : 'var(--ink, #18181b)',
});

/** An ISO time as the value a datetime-local input wants, in local time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TaskEditSheet({ V }: { V: ClozrView }) {
  const t = V.taskEdit;
  if (!t) return null;
  // Keyed by the task, so a different task gets a fresh form.
  return <TaskEditForm key={t.id} V={V} t={t} />;
}

function TaskEditForm({ V, t }: { V: ClozrView; t: NonNullable<ClozrView['taskEdit']> }) {
  const [title, setTitle] = useState(t.title);
  const [type, setType] = useState(t.type || 'Call');
  const [priority, setPriority] = useState(t.priority || 'Medium');
  const [due, setDue] = useState(() => toLocalInput(t.dueAt));
  const [assigned, setAssigned] = useState(t.assigned ?? '');
  const [note, setNote] = useState(t.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // The view model is rebuilt on every shell change (each second during a
  // call), so the focus runs once, on mount, and Escape reads the closer through a ref.
  const closeRef = useRef(V.closeTaskEdit);
  useEffect(() => { closeRef.current = V.closeTaskEdit; }, [V.closeTaskEdit]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => titleRef.current?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); };
  }, []);

  const types = V.taskTypeChoices.includes(type) ? V.taskTypeChoices : [type, ...V.taskTypeChoices];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError('Give the task a title.'); return; }
    setBusy(true); setError(null);
    const ok = await V.saveTaskEdit({
      title: title.trim(), type, priority,
      dueAt: due ? new Date(due).toISOString() : null,
      assignedTo: assigned || null,
      notes: note,
    });
    if (!ok) setBusy(false);
  };
  const phone = V.isMobile;
  return (
    <div role="presentation" onClick={V.closeTaskEdit} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(24,24,27,.35)', display: 'flex', alignItems: phone ? 'flex-end' : 'center', justifyContent: 'center', padding: phone ? 0 : '20px' }}>
      <form role="dialog" aria-labelledby="task-edit-title" data-screen-label="Edit task" onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ width: phone ? '100%' : 'min(440px, 100%)', maxHeight: phone ? '92dvh' : 'calc(100dvh - 40px)', overflow: 'auto', background: 'var(--surface, #fff)', borderRadius: phone ? '16px 16px 0 0' : '14px', boxShadow: 'var(--shadow-lg, 0 22px 60px rgba(0,0,0,.18))', padding: phone ? '12px 16px calc(16px + env(safe-area-inset-bottom, 0px))' : '16px 18px', display: 'grid', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h2 id="task-edit-title" style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.015em', flex: 1 }}>Edit task</h2>
          <button type="button" onClick={V.closeTaskEdit} aria-label="Close" style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', border: 0, borderRadius: '8px', background: 'none', color: 'var(--muted, #71717a)', cursor: 'pointer' }}>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div>
          <label htmlFor="task-edit-name" style={label}>Title</label>
          <input id="task-edit-name" ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} required style={field} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label htmlFor="task-edit-type" style={label}>Type</label>
            <select id="task-edit-type" value={type} onChange={(e) => setType(e.target.value)} style={field}>
              {types.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="task-edit-priority" style={label}>Priority</label>
            <select id="task-edit-priority" value={priority} onChange={(e) => setPriority(e.target.value)} style={field}>
              {(PRIORITIES.includes(priority) ? PRIORITIES : [priority, ...PRIORITIES]).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="task-edit-due" style={label}>Due</label>
          <input id="task-edit-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={field} />
        </div>
        <div>
          <label htmlFor="task-edit-assignee" style={label}>Assigned to</label>
          <select id="task-edit-assignee" value={assigned} onChange={(e) => setAssigned(e.target.value)} style={field}>
            <option value="">Nobody yet</option>
            {V.taskTeam.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="task-edit-note" style={label}>Note</label>
          <textarea id="task-edit-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What to say or send" style={{ ...field, height: 'auto', padding: '8px 11px', resize: 'vertical', lineHeight: 1.45 }} />
        </div>
        {error ? <div role="alert" style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>{error}</div> : null}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
          <button type="button" onClick={() => void V.removeTask(t)} disabled={busy} style={btn('danger')}>Delete task</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={V.closeTaskEdit} disabled={busy} style={btn('ghost')}>Cancel</button>
          <button type="submit" disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save task'}</button>
        </div>
      </form>
    </div>
  );
}
