'use client';

// The Info and Notes tabs of an open conversation (screens/Inbox.tsx
// AllThread), Follow Up Boss's person card folded into SmarterContact's tabs.
// Info reads the seller or buyer record the resolver handed the Inbox: the
// property, stage, heat, score, asking, offer, close date, the assigned rep,
// and the other conversations with the same person. Notes lists the record's
// notes (activity rows of kind `note`) and adds one.

import React, { useEffect, useState } from 'react';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';
import { supabase } from '@/lib/supabase';
import { logActivity } from '@/lib/crm-write';
import { formatPhone } from '@/lib/talkr-web/time';
import { heat } from '@/lib/heat';
import { Chip, type HeatChip } from './LabelChips';

export type RelatedRow = { key: string; kind: 'sms' | 'email' | 'call'; label: string; preview: string; at: string; title?: string };

const KIND: Record<RelatedRow['kind'], string> = { sms: 'Text', email: 'Email', call: 'Call' };
const when = (iso: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function InfoTab({ rec, name, phone, email, lastAt, heat: h, related, onOpenRelated, onText }: {
  rec: ClozrRecord | null;
  name: string;
  phone: string | null;
  email: string | null;
  lastAt: string;
  heat: HeatChip;
  related: RelatedRow[];
  onOpenRelated: (key: string) => void;
  onText: (() => void) | null;
}) {
  const r = rec?.recipient;
  const rows: [string, React.ReactNode][] = rec ? [
    ['Property', rec.address || r?.address || <span className="ax-info-none">No address on the record</span>],
    ['Stage', rec.stage ? <Chip label={rec.stage} /> : <span className="ax-info-none">None</span>],
    ['Heat', h ? <Chip label={h.label} fg={h.fg} bg={h.bg} /> : <span className="ax-info-none">Not scored</span>],
    ['Score', rec.score != null ? <span style={{ color: heat(rec.score).text, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{rec.score}</span> : <span className="ax-info-none">None yet</span>],
    ...(rec.kind === 'seller' ? [
      ['Asking', r?.askingPrice || <span className="ax-info-none">Not given</span>] as [string, React.ReactNode],
      ['Offer', r?.offer || <span className="ax-info-none">None made</span>] as [string, React.ReactNode],
      ['Close date', r?.closeDate || <span className="ax-info-none">Not set</span>] as [string, React.ReactNode],
    ] : []),
    ['Assigned rep', rec.rep || <span className="ax-info-none">Unassigned</span>],
  ] : [];
  return (
    <div className="ax-info">
      <section className="ax-info-card" aria-label="Contact">
        <h3 className="ax-info-name">{name}</h3>
        <p className="ax-info-last">Last communication {when(lastAt) || 'unknown'}</p>
        {phone ? (
          <p className="ax-info-line">
            <span className="ax-info-k">Phone</span>
            <span className="ax-info-v">{formatPhone(phone)}{onText ? <button type="button" className="ax-link" onClick={onText}>Send text</button> : null}</span>
          </p>
        ) : null}
        {email ? <p className="ax-info-line"><span className="ax-info-k">Email</span><span className="ax-info-v"><a className="ax-link" href={`mailto:${email}`}>{email}</a></span></p> : null}
      </section>
      <section className="ax-info-card" aria-label="Details">
        <h3 className="ax-info-h">Details</h3>
        {rec ? (
          <dl className="ax-info-dl">
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        ) : (
          <p className="ax-info-none">Not in CLOZR. Add them from the record search, or from the dialer when they call.</p>
        )}
        {rec ? <button type="button" className="ax-link ax-info-open" onClick={rec.open}>Open record</button> : null}
      </section>
      <section className="ax-info-card" aria-label="Recent conversations">
        <h3 className="ax-info-h">Recent conversations</h3>
        {related.length ? (
          <ul className="ax-info-recent">
            {related.map((x) => (
              <li key={x.key}>
                <button type="button" onClick={() => onOpenRelated(x.key)} title={x.title ?? x.preview}>
                  <span className="ax-info-kind">{KIND[x.kind]}</span>
                  <span className="ax-info-prev">{x.title ?? x.preview}</span>
                  <time dateTime={x.at || undefined}>{when(x.at)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="ax-info-none">No other threads with them on this inbox.</p>}
      </section>
    </div>
  );
}

type Note = { id: string; body: string; at: string };

export function NotesTab({ rec, workspaceId, userId, canWrite, toast }: {
  rec: ClozrRecord | null;
  workspaceId: number | null;
  userId: string | null;
  canWrite: boolean;
  toast: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}) {
  const id = rec?.id ?? null;
  const kind = rec?.kind ?? null;
  const key = `${kind}:${id}`;
  // What the database holds for this record, and what was added here since.
  const [fetched, setFetched] = useState<{ key: string; notes: Note[]; err: string | null } | null>(null);
  const [added, setAdded] = useState<{ key: string; notes: Note[] }>({ key, notes: [] });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const live = !!supabase && !!workspaceId && id != null;
  useEffect(() => {
    if (!live) return;
    let on = true;
    void supabase!.from('activity').select('id,title,body,occurred_at')
      .eq('workspace_id', workspaceId!).eq('entity_type', kind!).eq('entity_id', id!).eq('kind', 'note')
      .order('occurred_at', { ascending: false }).limit(100)
      .then(({ data, error }) => {
        if (!on) return;
        if (error) { setFetched({ key, notes: [], err: `Notes did not load: ${error.message}` }); return; }
        setFetched({ key, err: null, notes: ((data ?? []) as { id: number | string; title: string | null; body: string | null; occurred_at: string }[])
          .map((r) => ({ id: String(r.id), body: r.body || r.title || '', at: r.occurred_at })) });
      });
    return () => { on = false; };
  }, [live, workspaceId, kind, id, key]);
  const mine = added.key === key ? added.notes : [];
  const err = fetched?.key === key ? fetched.err : null;
  const notes: Note[] | null = !live ? mine : fetched?.key === key ? [...mine, ...fetched.notes] : null;
  const setNotes = (f: (n: Note[]) => Note[]) => setAdded((a) => ({ key, notes: f(a.key === key ? a.notes : []) }));

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const note: Note = { id: `local-${Date.now()}`, body: text, at: new Date().toISOString() };
    setNotes((n) => [note, ...n]);
    setDraft('');
    if (!live || !canWrite) { toast('Note added (demo)'); return; }
    setBusy(true);
    try {
      await logActivity(workspaceId!, kind!, id!, 'note', 'Note added', text, userId);
      toast('Note added to the record', 'success');
    } catch (e) {
      setNotes((n) => n.filter((x) => x.id !== note.id));
      setDraft(text);
      toast(`The note did not save: ${e instanceof Error ? e.message : 'try again'}`, 'error');
    } finally { setBusy(false); }
  };

  if (!rec) return <div className="ax-info"><p className="ax-info-none">Notes live on a CLOZR record, and this number is not on one yet.</p></div>;
  return (
    <div className="ax-info">
      <form className="ax-note-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label htmlFor="ax-note" className="ax-info-h">Add a note to {rec.name}</label>
        <textarea id="ax-note" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What they said, what happens next"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void add(); }} />
        <div className="ax-note-foot">
          <span className="ax-info-none">Ctrl + Enter adds it</span>
          <button type="submit" className="ax-tool ax-tool-dark" disabled={!draft.trim() || busy}>{busy ? 'Adding…' : 'Add note'}</button>
        </div>
      </form>
      {err ? <p className="ax-note-err" role="alert">{err}</p> : null}
      {notes === null ? <p className="ax-info-none">Loading notes…</p> : notes.length === 0 ? <p className="ax-info-none">No notes on this record yet.</p> : (
        <ul className="ax-notes">
          {notes.map((n) => <li key={n.id}><p>{n.body}</p><time dateTime={n.at}>{when(n.at)}</time></li>)}
        </ul>
      )}
    </div>
  );
}
