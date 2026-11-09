'use client';

// The AI brief as Follow Up Boss draws its Smart Summary: one bar under the
// composer. Collapsed it is a row (sparkle, "Smart Summary", whether it is
// current, a chevron); open it is the brief in one block, the five facts as
// a compact list, and "Did you find the summary useful?" with thumbs.
//
// "New info available" means a call, text or note on the record is newer
// than the brief. The thumbs land in localStorage: lead_memory (migration
// 110) grants the app no insert or update, so there is no column to write.

import React, { useState } from 'react';
import { ChevronDown, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import { useLeadMemory } from './LeadMemoryCard';
import { demoLeadMemory } from '@/lib/lead-memory-client';

const THUMB_KEY = 'clozr.smart-summary.thumbs';
type Thumb = 'up' | 'down';
function readThumb(id: string): Thumb | null {
  try { const v = JSON.parse(window.localStorage.getItem(THUMB_KEY) || '{}')[id]; return v === 'up' || v === 'down' ? v : null; } catch { return null; }
}
function saveThumb(id: string, v: Thumb | null) {
  try {
    const all = JSON.parse(window.localStorage.getItem(THUMB_KEY) || '{}');
    if (v) all[id] = v; else delete all[id];
    window.localStorage.setItem(THUMB_KEY, JSON.stringify(all));
  } catch { /* private mode: the vote just isn't kept */ }
}

const usd = (n: number | null) => (n == null ? null : '$' + n.toLocaleString('en-US'));
const dt: React.CSSProperties = { fontSize: '12px', fontWeight: 500, color: 'var(--meta, #71717a)', whiteSpace: 'nowrap' };
const dd: React.CSSProperties = { margin: 0, minWidth: 0, fontSize: '12.5px', color: 'var(--ink, #18181b)', overflowWrap: 'anywhere' };
const iconBtn: React.CSSProperties = { width: '28px', height: '28px', display: 'inline-grid', placeItems: 'center', borderRadius: '8px', border: 0, background: 'var(--surface, #fff)', boxShadow: 'var(--shadow-ring)', cursor: 'pointer', color: 'var(--ink-3, #3f3f46)', padding: 0 };

export function SmartSummary({ V, kind = 'seller', newest: newestGiven }: { V: ClozrView; kind?: 'seller' | 'buyer'; /** The newest row's time on a record whose items carry none (the buyer): ISO. */ newest?: string | null }) {
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const recordId = kind === 'buyer' ? V.B.dbId ?? null : V.liveIds?.sellerId ?? null;
  const demo = V.isLiveData ? null
    : kind === 'buyer' ? demoLeadMemory('buyer', { id: V.B.name, name: V.B.name, company: V.B.company })
      : demoLeadMemory('seller', { id: V.P.id, name: V.P.name, address: V.P.addr, fields: (V.personFields || []).map((f) => ({ k: f.k, v: f.v })) });
  const { state, busy, note, refresh } = useLeadMemory(kind, workspaceId, recordId, demo);
  const [open, setOpen] = useState(false);
  const thumbId = `${kind}:${recordId ?? (kind === 'buyer' ? V.B.name : V.P.id)}`;
  const [thumb, setThumb] = useState<Thumb | null>(() => (typeof window === 'undefined' ? null : readThumb(thumbId)));
  const vote = (v: Thumb) => { const next = thumb === v ? null : v; setThumb(next); saveThumb(thumbId, next); };

  const m = state.at === 'ready' ? state.memory : null;
  const f = m?.facts;
  const price = [f?.asking_price ? `Asking ${usd(f.asking_price)}` : null, f?.offer_made ? `Our offer ${usd(f.offer_made)}` : null].filter(Boolean).join(' · ');
  // Anything on the timeline after the brief was written means it is behind.
  const newest = kind === 'buyer' ? (newestGiven ? Date.parse(newestGiven) : 0) : Math.max(0, ...(V.timelineItems || []).map((t) => (t.at ? Date.parse(t.at) : 0)));
  const stale = !!m && newest > Date.parse(m.updated_at);
  const status = state.at === 'loading' ? 'Reading…'
    : state.at === 'offline' ? 'Sign in to see the brief'
      : state.at === 'error' ? 'Could not read the brief'
        : !m || !m.brief.trim() ? 'No summary yet'
          : stale ? 'New info available' : 'Summary is up to date';
  const refreshBtn = state.at === 'offline' ? null : (
    <button type="button" className="lm-btn rec-press" onClick={refresh} disabled={busy} aria-label={busy ? 'Refreshing the summary' : 'Refresh the summary'} data-testid="lead-memory-refresh"
      style={{ ...iconBtn, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
      <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  return (
    <section aria-label="Smart Summary" data-testid="lead-memory" className="rec-smart" aria-busy={state.at === 'loading' || busy}>
      <div className="rec-smart-head">
        <button type="button" className="rec-smart-toggle" aria-expanded={open} aria-controls="rec-smart-body" onClick={() => setOpen((o) => !o)}>
          <Sparkles size={15} strokeWidth={2} aria-hidden="true" style={{ color: 'var(--tx-mint, #0a8560)', flex: 'none' }} />
          <span className="rec-smart-title">Smart Summary</span>
          <span className="rec-smart-status" data-stale={stale || undefined}>{status}</span>
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" style={{ flex: 'none', color: 'var(--meta, #71717a)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms cubic-bezier(.23,1,.32,1)' }} />
        </button>
        {(stale || open) && refreshBtn ? <span style={{ flex: 'none', marginLeft: '8px' }}>{refreshBtn}</span> : null}
      </div>
      {open ? (
        <div id="rec-smart-body" className="rec-smart-body">
          {state.at === 'loading' ? (
            <p className="rec-smart-hint">Reading memory…</p>
          ) : state.at === 'offline' ? (
            <p className="rec-smart-hint">The brief fills in from calls, texts and notes once you are signed in.</p>
          ) : state.at === 'error' ? (
            <p role="alert" className="rec-smart-hint" style={{ color: 'var(--tx-red, #b91c1c)' }}>{state.error}</p>
          ) : !m || !m.brief.trim() ? (
            <p className="rec-smart-hint">Nothing written yet. Refresh reads every call, text and note on this record and writes the brief.</p>
          ) : (
            <>
              <p data-testid="lead-memory-brief" className="rec-smart-brief">{m.brief}</p>
              <dl className="rec-smart-facts">
                {f?.motivation ? <><dt style={dt}>{kind === 'buyer' ? 'Buys' : 'Motivation'}</dt><dd style={dd}>{f.motivation}</dd></> : null}
                {price ? <><dt style={dt}>Price</dt><dd style={{ ...dd, fontVariantNumeric: 'tabular-nums' }}>{price}</dd></> : null}
                {f?.next_step ? <><dt style={dt}>Next step</dt><dd style={dd}>{f.next_step}</dd></> : null}
                {f?.promises_made.length ? <><dt style={dt}>We promised</dt><dd style={dd}>{f.promises_made.join('; ')}</dd></> : null}
                {f?.do_not_mention.length ? <><dt style={dt}>Do not mention</dt><dd style={{ ...dd, color: 'var(--tx-red, #b91c1c)' }}>{f.do_not_mention.join('; ')}</dd></> : null}
              </dl>
              <div className="rec-smart-vote" role="group" aria-label="Was the summary useful">
                <span>Did you find the summary useful?</span>
                <button type="button" className="rec-press" aria-pressed={thumb === 'up'} aria-label="Yes, useful" onClick={() => vote('up')}
                  style={{ ...iconBtn, width: '26px', height: '26px', color: thumb === 'up' ? 'var(--tx-mint, #0a8560)' : iconBtn.color }}>
                  <ThumbsUp size={13} strokeWidth={2} aria-hidden="true" />
                </button>
                <button type="button" className="rec-press" aria-pressed={thumb === 'down'} aria-label="No, not useful" onClick={() => vote('down')}
                  style={{ ...iconBtn, width: '26px', height: '26px', color: thumb === 'down' ? 'var(--tx-red, #b91c1c)' : iconBtn.color }}>
                  <ThumbsDown size={13} strokeWidth={2} aria-hidden="true" />
                </button>
                {m.model === 'fallback' ? <span style={{ marginLeft: 'auto' }}>From the latest touches</span> : null}
              </div>
            </>
          )}
          {note ? <p role="status" className="rec-smart-hint" style={{ marginTop: '6px' }}>{note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
