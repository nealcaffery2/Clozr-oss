'use client';

// The lead's memory (migration 110): the brief a rep, the phone agent and the
// AI drafts all read, with the facts that matter before a call and a Refresh
// that rewrites it from the whole history. Mount with a `key` per record so
// switching records starts clean.

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LeadMemory, RecordKind } from '@/lib/lead-memory';
import { loadLeadMemory, refreshLeadMemoryNow } from '@/lib/lead-memory-client';

type Props = {
  kind: RecordKind;
  workspaceId: number | null;
  recordId: number | null;
  /** /demo: the sample memory to show; nothing is read or written. */
  demo?: LeadMemory | null;
  /** Rendered as the card's own heading when the card stands alone. */
  title?: string;
};

type State =
  | { at: 'loading' }
  | { at: 'offline' }
  | { at: 'ready'; memory: LeadMemory | null }
  | { at: 'error'; error: string };

const card: React.CSSProperties = { border: '1px solid #e4e4e7', borderRadius: 12, background: '#fff', padding: '10px 12px' };
const meta: React.CSSProperties = { fontSize: 11.5, fontWeight: 500, color: '#71717a' };
const ghost: React.CSSProperties = {
  height: 28, padding: '0 10px', borderRadius: 8, border: 0, background: '#fff', color: '#18181b', fontSize: 12.5, fontWeight: 500,
  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 'none',
  boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)',
};
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '92px minmax(0,1fr)', gap: 8, padding: '5px 0', borderTop: '1px solid #f0f0f1', fontSize: 12.5, alignItems: 'baseline', margin: 0 };

function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const usd = (n: number | null) => (n == null ? null : '$' + n.toLocaleString('en-US'));

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div style={row}>
      <dt style={{ color: '#71717a' }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, color: tone ?? '#18181b', fontWeight: 500, overflowWrap: 'anywhere' }}>{children}</dd>
    </div>
  );
}

export function LeadMemoryCard({ kind, workspaceId, recordId, demo, title }: Props) {
  const live = !demo && workspaceId != null && recordId != null;
  const [state, setState] = useState<State>(demo ? { at: 'ready', memory: demo } : live ? { at: 'loading' } : { at: 'offline' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    let alive = true;
    void loadLeadMemory(workspaceId as number, kind, recordId as number).then((r) => {
      if (!alive) return;
      setState(r.error ? { at: 'error', error: r.error } : { at: 'ready', memory: r.memory });
      setNow(Date.now());
    });
    return () => { alive = false; };
  }, [live, workspaceId, kind, recordId]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    if (!live) {
      // The demo has nothing to read; show the same motion without a call.
      await new Promise((r) => setTimeout(r, 500));
      if (state.at === 'ready' && state.memory) setState({ at: 'ready', memory: { ...state.memory, updated_at: new Date().toISOString() } });
      setNow(Date.now());
      setBusy(false);
      return;
    }
    const r = await refreshLeadMemoryNow(workspaceId as number, kind, recordId as number);
    setBusy(false);
    setNow(Date.now());
    if (r.error) {
      // Keep what is on screen; say why the rewrite did not happen.
      if (state.at === 'ready' && state.memory) setNote(r.error);
      else setState({ at: 'error', error: r.error });
      return;
    }
    setState({ at: 'ready', memory: r.memory });
    if (r.message) setNote(r.message);
  };

  const button = (
    <button type="button" className="lm-btn" style={{ ...ghost, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }} disabled={busy} onClick={refresh}
      aria-label={busy ? 'Refreshing lead memory' : 'Refresh lead memory'} data-testid="lead-memory-refresh">
      <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  const m = state.at === 'ready' ? state.memory : null;
  const f = m?.facts;
  const price = [f?.asking_price ? `Asking ${usd(f.asking_price)}` : null, f?.offer_made ? `Our offer ${usd(f.offer_made)}` : null].filter(Boolean).join(' · ');

  return (
    <section aria-label="Lead memory" data-testid="lead-memory" style={card} aria-busy={state.at === 'loading' || busy}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 28 }}>
        <div style={{ minWidth: 0 }}>
          {title ? <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: '#18181b' }}>{title}</h2> : null}
          <div style={{ ...meta, fontVariantNumeric: 'tabular-nums' }}>
            {m ? `Brief · updated ${ago(m.updated_at, now)}${m.model === 'fallback' ? ' · latest touches' : ''}` : 'Brief'}
          </div>
        </div>
        {state.at === 'offline' ? null : button}
      </div>

      {state.at === 'loading' ? (
        <p style={{ ...meta, margin: '8px 0 2px' }}>Reading memory&hellip;</p>
      ) : state.at === 'offline' ? (
        <p style={{ ...meta, margin: '8px 0 2px' }}>The brief fills in from calls, texts and notes once you are signed in.</p>
      ) : state.at === 'error' ? (
        <p role="alert" style={{ margin: '8px 0 2px', fontSize: 12.5, color: '#b91c1c' }}>{state.error}</p>
      ) : !m || !m.brief.trim() ? (
        <p style={{ ...meta, margin: '8px 0 2px' }}>Nothing written yet. Refresh reads every call, text and note on this record and writes the brief.</p>
      ) : (
        <>
          <p data-testid="lead-memory-brief" style={{ margin: '8px 0 6px', fontSize: 12.5, lineHeight: 1.5, color: '#3f3f46', overflowWrap: 'anywhere' }}>{m.brief}</p>
          <dl style={{ margin: 0 }}>
            {f?.motivation ? <Fact label={kind === 'buyer' ? 'Buys' : 'Motivation'}>{f.motivation}</Fact> : null}
            {price ? <Fact label="Price"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{price}</span></Fact> : null}
            {f?.timeline ? <Fact label="Timeline">{f.timeline}</Fact> : null}
            {f?.next_step ? <Fact label="Next step">{f.next_step}</Fact> : null}
            {f?.promises_made.length ? <Fact label="We promised">{f.promises_made.join('; ')}</Fact> : null}
            {f?.do_not_mention.length ? <Fact label="Do not mention" tone="#b91c1c">{f.do_not_mention.join('; ')}</Fact> : null}
          </dl>
        </>
      )}
      {note ? <p role="status" style={{ ...meta, margin: '6px 0 0' }}>{note}</p> : null}
    </section>
  );
}
