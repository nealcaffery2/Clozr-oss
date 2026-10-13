// The bar pinned to the bottom of every tab. It says where the agent stands
// (edits not saved, draft saved but not live, live and current) and carries the
// three things you do about it: save the draft, preview the prompt, publish.
'use client';

import React from 'react';
import { Eye, Rocket } from 'lucide-react';
import { Spinner, ghost, primary } from './kit';

export type Note = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

export function ConsoleBar({ canEdit, dirty, invalid, saving, published, unpublished, liveVersion, note, onSave, onDiscard, onPreview, onPublish, onDismiss }: {
  canEdit: boolean; dirty: boolean; invalid: boolean; saving: boolean; published: boolean; unpublished: boolean; liveVersion: number; note: Note;
  onSave: () => void; onDiscard: () => void; onPreview: () => void; onPublish: () => void; onDismiss: () => void;
}) {
  const state = dirty ? { dot: '#f59e0b', text: invalid ? 'Fix the highlighted fields to save.' : 'Unsaved edits' }
    : !published ? { dot: '#a1a1aa', text: 'Draft, not published yet' }
      : unpublished ? { dot: '#f59e0b', text: `Draft saved, not published. Live is v${liveVersion}` }
        : { dot: '#34d399', text: `Live v${liveVersion}, no unpublished changes` };
  const tone = note ? (note.tone === 'ok' ? '#86efac' : note.tone === 'warn' ? '#fcd34d' : '#fca5a5') : '#fff';
  const btn: React.CSSProperties = { ...ghost, height: 34, background: 'transparent', border: '1px solid rgba(255,255,255,.25)', color: '#fff' };
  const publishOff = !canEdit || saving || invalid || (published && !dirty && !unpublished);
  return (
    <div role="region" aria-label="Save and publish" className="va-bar" style={{ position: 'sticky', bottom: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px 10px 14px', borderRadius: 12,
      background: '#18181b', color: '#fff', boxShadow: 'var(--elev-3), 0 0 0 1px rgba(255,255,255,.06)' }}>
      <span role="status" className="va-bar-status" style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, lineHeight: 1.4 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: state.dot, flex: 'none' }} />
        <span style={{ minWidth: 0 }}>
          {note && !(dirty && invalid) ? <span style={{ color: tone }}>{note.text}</span> : state.text}
          {note && !(dirty && invalid) ? <button type="button" className="va-btn" onClick={onDismiss} aria-label="Dismiss message" style={{ marginLeft: 8, padding: 0, border: 0, background: 'none', color: 'rgba(255,255,255,.6)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textDecoration: 'underline' }}>Dismiss</button> : null}
        </span>
      </span>
      {canEdit && dirty ? <button type="button" className="va-btn va-bar-btn" style={btn} disabled={saving} onClick={onDiscard}>Discard</button> : null}
      <button type="button" className="va-btn va-bar-btn" style={btn} onClick={onPreview}><Eye size={15} aria-hidden="true" /> Preview<span className="va-long"> prompt</span></button>
      {canEdit ? (
        <>
          <button type="button" className="va-btn va-bar-btn" style={{ ...btn, minWidth: 104, background: dirty && !invalid ? 'rgba(255,255,255,.12)' : 'transparent', opacity: !dirty || invalid ? 0.55 : 1, cursor: !dirty || invalid || saving ? 'not-allowed' : 'pointer' }}
            disabled={saving || !dirty || invalid} onClick={onSave}>
            {saving ? <Spinner size={14} /> : null}{saving ? 'Saving…' : 'Save draft'}
          </button>
          <button type="button" className="va-btn va-prim va-bar-btn" style={{ ...primary(publishOff), height: 34, minWidth: 104 }} disabled={publishOff} onClick={onPublish}
            title={published && !dirty && !unpublished ? 'Nothing to publish: the live agent is current' : undefined}>
            <Rocket size={15} aria-hidden="true" /> Publish
          </button>
        </>
      ) : null}
    </div>
  );
}
