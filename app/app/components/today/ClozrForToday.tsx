// "Clozr for today": the top of the Today screen, written like a prompt.
//
// A greeting and the three to six things to do first, each opening its record;
// under them a composer that hands whatever is typed to Ask CLOZR with this
// list as context, so "do the second one" means the second row here; chips
// under the composer for the usual questions. Skeleton rows while the list
// loads, never a spinner. The footer says whether Clozr AI or the rules
// ordered it (clozr-today, action focus; lib/focus.ts).
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FOCUS_CHIPS, loadTodayFocus, partOfDay, type TodayFocus } from '@/lib/today-focus';
import type { FocusRecord } from '@/lib/focus';
import type { AskFocusItem } from '@/lib/ask-clozr';

const INK = '#18181B';
const INK2 = '#3F3F46';
const MUTED = '#52525B';
const SUBTLE = '#71717A';
const LINE = '#E4E4E7';
const MINT = '#0A8560';
const MINT_TEXT = '#08694C';
const AMBER = '#B45309';
const RED = '#B91C1C';
const TONE: Record<string, string> = { overdue: RED, due: AMBER, money: INK, muted: MUTED };
const HIDE_KEY = 'clozr.today.focus.hidden';

/** A row as the panel shows it; the demo graph builds these from its own Today list. */
export type FocusRow = { id: string; kind: string; title: string; why: string; tag: string; tone: string; record: FocusRecord | null; open: () => void };

const CSS = `
.cft-row { transition: background-color 120ms linear; }
.cft-row:hover { background: #F4F4F5 !important; }
.cft-chip:hover { background: #F4F4F5 !important; }
.cft-send:not(:disabled):hover { background: #08694C !important; }
.cft :is(button, textarea):focus-visible { outline: 2px solid ${MINT}; outline-offset: 2px; }
@keyframes cftPulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .cft-skel { animation: none !important; } }
`;

function Skeleton({ cols }: { cols: number }) {
  return (
    <ol aria-label="Loading your focus list" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} data-testid="today-focus-skeleton" className="cft-skel" style={{ height: 58, borderRadius: 10, border: `1px solid ${LINE}`, background: '#FFFFFF', padding: '10px 12px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8, animation: 'cftPulse 1.4s ease-in-out infinite' }}>
          <span style={{ width: `${40 + ((i * 17) % 30)}%`, height: 10, borderRadius: 4, background: '#EEEEF0' }} />
          <span style={{ width: `${70 - ((i * 11) % 25)}%`, height: 8, borderRadius: 4, background: '#F4F4F5' }} />
        </li>
      ))}
    </ol>
  );
}

export function ClozrForToday({
  workspaceId, first, isMobile, demo, open, ask, busy,
}: {
  workspaceId: number | null; first: string; isMobile: boolean;
  /** The sample workspace's rows; null on a real workspace. */
  demo: FocusRow[] | null;
  open: (r: FocusRecord) => void;
  ask: (q: string, focus: AskFocusItem[]) => void;
  busy: boolean;
}) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  const [focus, setFocus] = useState<TodayFocus | null>(null);
  const [loading, setLoading] = useState(workspaceId != null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  // Bumped by Refresh and Try again: the next read skips the browser's copy.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (workspaceId == null) return;
    let on = true;
    void loadTodayFocus(workspaceId, first, { fresh: asked > 0 }).then((r) => {
      if (!on) return;
      setLoading(false);
      if (r.ok) { setFocus(r.focus); setError(null); } else setError(r.message);
    });
    return () => { on = false; };
  }, [workspaceId, first, asked]);
  const refresh = () => { setLoading(true); setError(null); setAsked((n) => n + 1); };

  const toggle = () => setHidden((h) => { try { localStorage.setItem(HIDE_KEY, h ? '0' : '1'); } catch { /* per-viewer nicety only */ } return !h; });

  const rows: FocusRow[] = demo ?? (focus?.items ?? []).map((it) => ({ id: it.id, kind: it.kind, title: it.title, why: it.why, tag: it.tag, tone: it.tone, record: it.record, open: () => open(it.record) }));
  const context: AskFocusItem[] = (focus?.items ?? []).map((it) => ({ id: it.id, kind: it.kind, record: it.record, title: it.title, detail: it.detail, why: it.why }));
  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    ask(t, context);
    setQ('');
  };
  const cols = isMobile ? 1 : 2;
  const greeting = `${partOfDay()}${first ? `, ${first}` : ''}.`;
  const line = demo ? 'Here is what to do first.' : focus?.greeting || (loading ? 'Reading your day…' : '');

  return (
    <section data-testid="today-focus" aria-label="Clozr for today" className="cft" style={{ flexShrink: 0, boxSizing: 'border-box', padding: isMobile ? '12px 16px 4px' : '16px 24px 12px', background: '#FAFAFA', borderBottom: isMobile ? 0 : `1px solid ${LINE}`, color: INK }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 17 : 19, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em' }}>{greeting}</h2>
        <span data-testid="today-focus-greeting" style={{ fontSize: 13, fontWeight: 500, color: INK2, flex: 1, minWidth: 160 }}>{hidden ? '' : line}</span>
        <button type="button" onClick={toggle} aria-expanded={!hidden} style={{ border: 0, background: 'none', padding: 0, color: MINT_TEXT, fontSize: 12, fontWeight: 500, cursor: 'pointer', minHeight: 28 }}>
          {hidden ? 'Show Clozr for today' : 'Hide'}
        </button>
      </div>

      {hidden ? null : (
        <>
          <div style={{ marginTop: 10 }}>
            {loading && !focus && !demo ? <Skeleton cols={cols} /> : null}
            {error && !focus ? (
              <p role="status" style={{ margin: 0, fontSize: 13, color: MUTED }}>
                Could not read your day: {error}{' '}
                <button type="button" onClick={refresh} style={{ border: 0, background: 'none', padding: 0, color: MINT_TEXT, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Try again</button>
              </p>
            ) : null}
            {!loading && !error && !rows.length ? (
              <p style={{ margin: 0, fontSize: 13, color: MUTED }}>Nothing is pressing: no overdue tasks, appointments, new leads, closings or cold leads. Ask below for anything else.</p>
            ) : null}
            {rows.length ? (
              <ol data-testid="today-focus-list" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 8, opacity: loading ? 0.6 : 1 }}>
                {rows.map((r, i) => (
                  <li key={r.id}>
                    <button
                      type="button" className="cft-row" data-testid={`today-focus-${i + 1}`} onClick={r.open}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 58, display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'start', padding: '10px 12px', borderRadius: 10, border: `1px solid ${LINE}`, background: '#FFFFFF', textAlign: 'left', cursor: 'pointer', color: INK, fontFamily: 'inherit' }}
                    >
                      <span aria-hidden style={{ fontSize: 12, fontWeight: 600, color: SUBTLE, lineHeight: '20px', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.4, color: INK2 }}>{r.why}</span>
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, lineHeight: '20px', color: TONE[r.tone] ?? MUTED, whiteSpace: 'nowrap' }}>{r.tag}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); send(q); }}
            style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 8, padding: 6, paddingLeft: 12, background: '#FFFFFF', border: `1px solid #D4D4D8`, borderRadius: 12 }}
          >
            <textarea
              ref={box} data-testid="today-composer" value={q} rows={1} aria-label="Ask Clozr"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(q); } }}
              placeholder={rows.length > 1 ? 'Ask Clozr, or say “do the second one”…' : 'Ask Clozr anything about your day…'}
              style={{ flex: 1, minWidth: 0, resize: 'none', border: 0, outline: 0, background: 'transparent', color: INK, fontSize: 14, lineHeight: '20px', padding: '7px 0', fontFamily: 'inherit', maxHeight: 120 }}
            />
            <button type="submit" className="cft-send" data-testid="today-composer-send" disabled={!q.trim() || busy}
              style={{ height: 34, padding: '0 14px', borderRadius: 8, border: 0, background: MINT, color: '#FFFFFF', fontSize: 13, fontWeight: 600, cursor: q.trim() && !busy ? 'pointer' : 'default', opacity: q.trim() && !busy ? 1 : 0.5, fontFamily: 'inherit' }}>
              {busy ? 'Answering…' : 'Ask'}
            </button>
          </form>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            {FOCUS_CHIPS.map((c) => (
              <button key={c} type="button" className="cft-chip" data-testid="today-chip" onClick={() => send(c)} disabled={busy}
                style={{ height: 28, padding: '0 10px', borderRadius: 999, border: `1px solid ${LINE}`, background: '#FFFFFF', color: INK2, fontSize: 12, fontWeight: 500, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                {c}
              </button>
            ))}
            {!demo && focus ? (
              <span data-testid="today-focus-source" title={focus.note} style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 500, color: SUBTLE, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                {focus.source === 'ai' ? 'Ranked by Clozr AI' : focus.note ?? 'Ranked by the rules'}
                <button type="button" onClick={refresh} disabled={loading} style={{ border: 0, background: 'none', padding: 0, color: MINT_TEXT, fontSize: 11.5, fontWeight: 500, cursor: 'pointer' }}>Refresh</button>
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
