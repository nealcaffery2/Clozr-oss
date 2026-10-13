'use client';

// Submit a call for review: a call from outside CLOZR, as a transcript (.txt)
// or a recording (mp3, wav, m4a; 25 MB), with its call scoring type. Graded
// in the background exactly like a recorded call (four review sections,
// framework, overall score, instant feedback); the list refreshes until it
// is done.

import React, { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { CALL_TYPES } from '@/lib/sales-framework';
import { UPLOAD_ACCEPT, checkUpload } from '@/lib/call-upload';
import { listSubmissions, salesManagerApi, uploadRecording, type SubmissionRow } from '@/lib/sales-manager-client';
import { isCoachingReview } from '@/lib/call-coaching';
import type { RepScorecard } from '@/lib/sales-scorecard';
import { CoachingReviewView } from '@/app/components/talkr/CoachingReviewCard';
import { INK, LINE, MUTED, RED, btn, card, eyebrow, gradeColor, primary, select } from './parts';

export function SubmitCall({ workspaceId, me, admin, cards, toast }: { workspaceId: number; me: string | null; admin: boolean; cards: RepScorecard[]; toast?: (m: string) => void }) {
  const api = salesManagerApi(workspaceId);
  const [callType, setCallType] = useState<string>(CALL_TYPES[0].id);
  const [repId, setRepId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let gone = false;
    void listSubmissions(workspaceId).then((r) => {
      if (gone) return;
      if (Array.isArray(r)) { setRows(r); setListError(null); } else setListError(r.error);
    });
    return () => { gone = true; };
  }, [workspaceId, tick]);
  const processing = (rows ?? []).some((r) => r.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const t = setTimeout(() => setTick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  }, [processing, rows]);

  const submit = async () => {
    if (!file || !me) return;
    setError(null);
    const c = checkUpload(file.name, file.size);
    if (!c.ok) { setError(c.error); return; }
    setBusy(true);
    let r;
    if (c.kind === 'text') {
      r = await api.submitReview({ callType, repId: repId || null, title: title || file.name, text: await file.text() });
    } else {
      const up = await uploadRecording(workspaceId, me, file);
      if (!up.ok) { setBusy(false); setError(up.error); return; }
      r = await api.submitReview({ callType, repId: repId || null, title: title || file.name, filePath: up.path });
    }
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast?.('Submitted. The review shows up here in a minute.');
    setFile(null); setTitle('');
    setOpen(r.submission_id);
    setTick((n) => n + 1);
  };

  const names = new Map(cards.map((c) => [c.id, c.name]));
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ ...card, display: 'grid', gap: 10 }}>
        <div style={eyebrow}>Submit a call for review</div>
        <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>A call made outside CLOZR: upload the transcript (.txt) or the recording (mp3, wav, m4a, up to 25 MB). It is scored the same way as a recorded call.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select aria-label="Call scoring type" value={callType} onChange={(e) => setCallType(e.target.value)} style={select}>
            {CALL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          {admin ? (
            <select aria-label="Whose call" value={repId} onChange={(e) => setRepId(e.target.value)} style={select}>
              <option value="">My call</option>
              {cards.filter((c) => c.id !== me).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : null}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Label (optional), e.g. 12 Oak St follow-up"
            style={{ flex: '1 1 220px', height: 30, borderRadius: 8, border: `1px solid ${LINE}`, padding: '0 10px', fontSize: 12.5 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Upload size={13} />{file ? file.name : 'Choose a file'}
            <input type="file" accept={UPLOAD_ACCEPT} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} style={{ display: 'none' }} />
          </label>
          <button type="button" style={primary} disabled={!file || busy} onClick={submit}>{busy ? 'Uploading…' : 'Review this call'}</button>
        </div>
        {error ? <div style={{ fontSize: 12.5, color: RED }}>{error}</div> : null}
      </div>

      {listError ? <div style={{ ...card, fontSize: 13, color: RED }}>{listError}</div> : null}
      {rows && !rows.length ? <div style={{ ...card, fontSize: 13, color: MUTED }}>Nothing submitted yet.</div> : null}
      {(rows ?? []).map((r) => (
        <div key={r.id} style={{ ...card, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: gradeColor(r.score), minWidth: 32, fontVariantNumeric: 'tabular-nums' }}>{r.score ?? '–'}</span>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{r.title || 'Submitted call'}</div>
              <div style={{ fontSize: 12, color: MUTED }}>
                {CALL_TYPES.find((t) => t.id === r.call_type)?.label ?? r.call_type} · {r.source === 'audio' ? 'recording' : 'transcript'}
                {r.rep_id ? ` · ${names.get(r.rep_id) ?? (r.rep_id === me ? 'You' : 'Teammate')}` : ''} · {new Date(r.created_at).toLocaleString()}
              </div>
            </div>
            {r.status === 'processing' ? <span style={{ fontSize: 12, color: MUTED }}>Reviewing…</span> : null}
            {r.status === 'failed' ? <span style={{ fontSize: 12, color: RED }}>{r.error ?? 'Failed'}</span> : null}
            {r.status === 'scored' ? <button type="button" style={btn} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Close' : 'Open review'}</button> : null}
          </div>
          {open === r.id && isCoachingReview(r.review) ? <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10 }}><CoachingReviewView review={r.review} /></div> : null}
        </div>
      ))}
    </div>
  );
}
