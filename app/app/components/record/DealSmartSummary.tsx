'use client';

// The deal's Smart Summary (migration 399), drawn the way the People record's
// Smart Summary is: one bar with its status, opening to the brief, then what
// disagrees and what is missing (conflicts first, each source quoted), the
// terms, the dated timeline and the people on the deal. Every source opens:
// a PDF in a new tab, an email, text or note in a sheet.
//
// "New info since the summary" means a message, note, file, contract or deal
// edit landed after the summary read the deal (deal_memory_newest). Refresh
// rewrites it; an unchanged deal answers without a model call.
//
// Mount with a `key` per deal so switching deals starts clean.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FileText, Mail, MessageSquare, Phone, RefreshCw, Sparkles, StickyNote, X } from 'lucide-react';
import {
  TERM_LABEL, eventState, isStale, issueCounts, sourceLabel, type DealMemory, type SourceCite, type SourceEntry,
} from '@/lib/deal-memory';
import { loadDealMemories, loadNewestInputs, loadSourceMessage, refreshDealMemoryNow, sourceDocUrl, type SourceMessage } from '@/lib/deal-memory-client';
import { useFocusTrap } from './useModal';
import './deal-smart.css';

type State =
  | { at: 'loading' }
  | { at: 'offline' }
  | { at: 'ready'; memory: DealMemory | null }
  | { at: 'error'; error: string };

type Props = {
  workspaceId: number | null;
  dealId: number | null;
  /** /demo: the sample summary to show; nothing is read or written. */
  demo?: DealMemory | null;
  /** A list that already read the rows: the stored summary (or null) and the newest input. Skips this panel's own reads. */
  preloaded?: { memory: DealMemory | null; newestAt: string | null };
  /** Shown after the title in a list of deals ("4873 Orchard Dr"). */
  label?: string;
  defaultOpen?: boolean;
};

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
const shortDay = (iso: string | null) => {
  if (!iso) return 'No date';
  const t = Date.parse(iso + 'T12:00:00Z');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : iso;
};

/** The stored summary, its staleness and Refresh, for one deal. */
export function useDealMemory(workspaceId: number | null, dealId: number | null, demo?: DealMemory | null, preloaded?: Props['preloaded']) {
  const live = !demo && workspaceId != null && dealId != null;
  const [state, setState] = useState<State>(demo ? { at: 'ready', memory: demo } : preloaded ? { at: 'ready', memory: preloaded.memory } : live ? { at: 'loading' } : { at: 'offline' });
  const [newestAt, setNewestAt] = useState<string | null>(preloaded?.newestAt ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live || preloaded) return;
    let alive = true;
    void Promise.all([loadDealMemories(workspaceId as number, [dealId as number]), loadNewestInputs([dealId as number])]).then(([r, n]) => {
      if (!alive) return;
      setState(r.error ? { at: 'error', error: r.error } : { at: 'ready', memory: r.memories.get(dealId as number) ?? null });
      setNewestAt(n.get(dealId as number) ?? null);
      setNow(Date.now());
    });
    return () => { alive = false; };
  }, [live, workspaceId, dealId, preloaded]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    if (!live) {
      // The demo has nothing to read; show the same motion without a call.
      await new Promise((r) => setTimeout(r, 600));
      if (state.at === 'ready' && state.memory) setState({ at: 'ready', memory: { ...state.memory, updated_at: new Date().toISOString() } });
      setNote('Sample data. In a workspace, Refresh reads the deal again.');
      setNow(Date.now());
      setBusy(false);
      return;
    }
    const r = await refreshDealMemoryNow(workspaceId as number, dealId as number);
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
  return { state, busy, note, now, newestAt, refresh };
}

const KIND_ICON: Record<string, typeof FileText> = { document: FileText, contract: FileText, email: Mail, text: MessageSquare, call: Phone, note: StickyNote, activity: StickyNote };

/** A source as a chip: a button when it opens, plain text when it is a field on the deal. */
function SourceChip({ cite, memory, onOpen }: { cite: SourceCite; memory: DealMemory; onOpen: (c: SourceCite) => void }) {
  const e = memory.sources[cite.ref];
  const text = sourceLabel(cite, memory.sources);
  const Icon = e ? KIND_ICON[e.kind] : undefined;
  const opens = !!e && (['document', 'contract', 'email', 'text', 'call', 'note'].includes(e.kind) || !!e.preview);
  const inner = <>{Icon ? <Icon size={12} strokeWidth={2} aria-hidden="true" /> : null}<span>{text}</span></>;
  return opens
    ? <button type="button" className="dsm-src" onClick={() => onOpen(cite)} title={`Open ${text}`}>{inner}</button>
    : <span className="dsm-src" title={cite.quote ?? text}>{inner}</span>;
}

/** The email, text or note a source points at, with the quoted words marked. */
function SourceSheet({ open, onClose }: { open: { entry: SourceEntry; cite: SourceCite; msg: SourceMessage | null; loading: boolean; error?: string }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, onClose);
  const body = open.msg?.body || open.entry.preview || (open.cite.quote ? `“${open.cite.quote}”` : '');
  const q = open.cite.quote?.trim();
  const at = q ? body.toLowerCase().indexOf(q.toLowerCase()) : -1;
  const when = open.msg?.at ?? open.entry.at;
  return createPortal(
    <div className="dsm-dialog" role="dialog" aria-modal="true" aria-label={open.entry.label} onClick={onClose}>
      <div ref={ref} className="dsm-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="dsm-sheet-head">
          <h2 title={open.msg?.subject ?? open.entry.label}>{open.msg?.subject || open.entry.label}</h2>
          <button type="button" className="dsm-btn" style={{ width: 32, height: 32, padding: 0, justifyContent: 'center' }} onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="dsm-sheet-body">
          <div className="dsm-meta">
            {[open.msg?.from ? `From ${open.msg.from}` : null, open.msg?.to ? `to ${open.msg.to}` : null, when ? new Date(when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null].filter(Boolean).join(' · ')}
          </div>
          {open.loading ? <p className="dsm-hint" style={{ margin: 0 }}>Opening the message…</p> : null}
          {open.error ? <p role="alert" className="dsm-hint dsm-err" style={{ margin: 0 }}>{open.error}</p> : null}
          {at >= 0 && q ? <>{body.slice(0, at)}<mark className="dsm-mark">{body.slice(at, at + q.length)}</mark>{body.slice(at + q.length)}</> : body}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function DealSmartSummary({ workspaceId, dealId, demo, preloaded, label, defaultOpen = false }: Props) {
  const { state, busy, note, now, newestAt, refresh } = useDealMemory(workspaceId, dealId, demo, preloaded);
  const [open, setOpen] = useState(defaultOpen);
  const [sheet, setSheet] = useState<React.ComponentProps<typeof SourceSheet>['open'] | null>(null);
  const [srcNote, setSrcNote] = useState<string | null>(null);
  const bodyId = `dsm-body-${dealId ?? 'demo'}`;

  const m = state.at === 'ready' ? state.memory : null;
  const hasBody = !!m && !!m.brief.trim();
  const stale = hasBody && isStale(m, newestAt);
  const counts = issueCounts(m);
  const status = state.at === 'loading' ? 'Reading…'
    : state.at === 'offline' ? 'Sign in to see the summary'
      : state.at === 'error' ? 'Could not read the summary'
        : !hasBody ? 'No summary yet'
          : stale ? 'New info since the summary' : `Updated ${ago(m!.updated_at, now)}`;

  async function openSource(c: SourceCite) {
    if (!m) return;
    const e = m.sources[c.ref];
    if (!e) return;
    setSrcNote(null);
    if (e.kind === 'document' || e.kind === 'contract') {
      if (demo || workspaceId == null || (!e.deal_file_id && !e.contract_id)) {
        setSheet({ entry: { ...e, preview: c.quote ? `${e.label}${c.page ? `, page ${c.page}` : ''}\n\n“${c.quote}”\n\nSample data: in a workspace this opens the PDF.` : 'Sample data: in a workspace this opens the PDF.' }, cite: { ...c, quote: null }, msg: null, loading: false });
        return;
      }
      // Opened before the await, so the browser treats it as the click's own window.
      const win = window.open('', '_blank');
      const r = await sourceDocUrl(workspaceId, e);
      if (r.url && win) { win.opener = null; win.location.href = r.url; }
      else { win?.close(); setSrcNote(r.error ?? 'Could not open that document.'); }
      return;
    }
    if (!e.communication_id || demo) { setSheet({ entry: e, cite: c, msg: null, loading: false }); return; }
    setSheet({ entry: e, cite: c, msg: null, loading: true });
    const msg = await loadSourceMessage(e.communication_id);
    setSheet((s) => (s && s.entry === e ? { ...s, msg, loading: false, error: msg ? undefined : 'That message is no longer on file. The excerpt above is what the summary read.' } : s));
  }

  const refreshBtn = state.at === 'offline' ? null : (
    <button type="button" className="dsm-btn" onClick={() => void refresh()} disabled={busy} data-testid="deal-memory-refresh"
      aria-label={busy ? 'Refreshing the deal summary' : 'Refresh the deal summary'}>
      <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
      <span className="dsm-btn-label">{busy ? 'Reading the deal…' : 'Refresh'}</span>
    </button>
  );

  return (
    <section className="dsm" aria-label={label ? `Smart Summary for ${label}` : 'Deal Smart Summary'} data-testid="deal-memory" aria-busy={state.at === 'loading' || busy}>
      <div className="dsm-head">
        <button type="button" className="dsm-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <Sparkles size={15} strokeWidth={2} aria-hidden="true" style={{ color: 'var(--tx-mint, #0a8560)', flex: 'none' }} />
          <span className="dsm-title">Smart Summary</span>
          {label ? <span className="dsm-for" title={label}>{label}</span> : null}
          {hasBody ? (
            <span className="dsm-badges">
              {counts.conflicts ? <span className="dsm-badge" data-tone="red">{counts.conflicts} conflict{counts.conflicts === 1 ? '' : 's'}</span> : null}
              {counts.missing ? <span className="dsm-badge" data-tone="amber">{counts.missing} missing</span> : null}
              {!counts.conflicts && !counts.missing ? <span className="dsm-badge" data-tone="green">No conflicts</span> : null}
            </span>
          ) : null}
          <span className="dsm-status" data-stale={stale || undefined} role="status">{status}</span>
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" className="dsm-chev" />
        </button>
        {(open || stale) && refreshBtn}
      </div>
      {open ? (
        <div id={bodyId} className="dsm-body">
          {state.at === 'loading' ? (
            <p className="dsm-hint">Reading the summary…</p>
          ) : state.at === 'offline' ? (
            <p className="dsm-hint">The summary fills in from the contracts, emails, texts and notes on this deal once you are signed in.</p>
          ) : state.at === 'error' ? (
            <p role="alert" className="dsm-hint dsm-err">{state.error}</p>
          ) : !hasBody ? (
            <p className="dsm-hint">No summary yet. Refresh reads the contract PDFs, the deal sheet, the TC file and every email, text and note on this deal, then lists what disagrees and what is missing. It takes about a minute.</p>
          ) : (
            <DealMemoryBody memory={m!} now={now} onOpen={(c) => void openSource(c)} />
          )}
          {busy ? <p role="status" className="dsm-hint">Reading the contracts and messages. This can take a minute.</p> : null}
          {note ? <p role="status" className="dsm-hint">{note}</p> : null}
          {srcNote ? <p role="alert" className="dsm-hint dsm-err">{srcNote}</p> : null}
        </div>
      ) : null}
      {sheet ? <SourceSheet open={sheet} onClose={() => setSheet(null)} /> : null}
    </section>
  );
}

function Cites({ cites, memory, onOpen, quotes }: { cites: SourceCite[]; memory: DealMemory; onOpen: (c: SourceCite) => void; quotes?: boolean }) {
  if (!cites.length) return null;
  if (!quotes) return <div className="dsm-srcrow">{cites.map((c, i) => <SourceChip key={c.ref + i} cite={c} memory={memory} onOpen={onOpen} />)}</div>;
  return (
    <ul className="dsm-cites" aria-label="Sources">
      {cites.map((c, i) => (
        <li key={c.ref + i} className="dsm-cite">
          <SourceChip cite={c} memory={memory} onOpen={onOpen} />
          {c.quote ? <span className="dsm-quote">“{c.quote}”</span> : null}
        </li>
      ))}
    </ul>
  );
}

const STATE_TONE = { done: 'grey', overdue: 'red', upcoming: 'green' } as const;
const STATE_WORD = { done: 'Done', overdue: 'Overdue', upcoming: 'Upcoming' } as const;

function DealMemoryBody({ memory: m, now, onOpen }: { memory: DealMemory; now: number; onOpen: (c: SourceCite) => void }) {
  const nowIso = new Date(now).toISOString();
  return (
    <>
      <p className="dsm-brief" data-testid="deal-memory-brief">{m.brief}</p>

      <h3 className="dsm-h">Conflicts and missing items</h3>
      {m.issues.length ? (
        <ul className="dsm-issues" data-testid="deal-memory-issues">
          {m.issues.map((i, n) => (
            <li key={n} className="dsm-issue" data-kind={i.kind}>
              <span><span className="dsm-badge" data-tone={i.kind === 'conflict' ? 'red' : 'amber'}>{i.kind === 'conflict' ? 'Conflict' : 'Missing'}</span></span>
              <div style={{ minWidth: 0 }}>
                <p className="dsm-issue-text">{i.text}</p>
                <Cites cites={i.sources} memory={m} onOpen={onOpen} quotes />
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="dsm-hint" style={{ marginTop: 0 }}>Nothing on file disagrees, and nothing a deal at this stage needs is missing.</p>}

      <div className="dsm-grid">
        <div>
          <h3 className="dsm-h">Terms</h3>
          {m.terms.length ? (
            <dl className="dsm-terms">
              {m.terms.map((t) => (
                <React.Fragment key={t.key}>
                  <dt>{TERM_LABEL[t.key]}</dt>
                  <dd>
                    <span className="dsm-val">{t.value}</span>
                    {t.confidence < 0.6 ? <span className="dsm-low">Unsure</span> : null}
                    <Cites cites={t.sources} memory={m} onOpen={onOpen} />
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          ) : <p className="dsm-hint" style={{ marginTop: 0 }}>No terms found on the contracts or the deal yet.</p>}
        </div>
        <div>
          <h3 className="dsm-h">Timeline</h3>
          {m.timeline.length ? (
            <ol className="dsm-time">
              {m.timeline.map((e, n) => {
                const st = eventState(e, nowIso);
                return (
                  <li key={n} className="dsm-ev" data-state={st}>
                    <span className="dsm-date">{shortDay(e.date)}</span>
                    <span className="dsm-ev-label">{e.label}<Cites cites={e.sources} memory={m} onOpen={onOpen} /></span>
                    <span className="dsm-badge" data-tone={STATE_TONE[st]}>{STATE_WORD[st]}</span>
                  </li>
                );
              })}
            </ol>
          ) : <p className="dsm-hint" style={{ marginTop: 0 }}>No dates on file yet.</p>}
        </div>
      </div>

      {m.parties.length ? (
        <>
          <h3 className="dsm-h">People on the deal</h3>
          <ul className="dsm-parties">
            {m.parties.map((p, n) => (
              <li key={n} className="dsm-party">
                <div className="dsm-party-name" title={p.name}>{p.name}</div>
                <div className="dsm-party-role">{[p.role, p.company].filter(Boolean).join(' · ')}</div>
                {p.email ? <div><a className="dsm-link" href={`mailto:${p.email}`}>{p.email}</a></div> : null}
                {p.phone ? <div><a className="dsm-link" href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>{p.phone}</a></div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="dsm-foot">
        <span>Read {m.source_count} item{m.source_count === 1 ? '' : 's'} on this deal</span>
        <span aria-hidden="true">·</span>
        <span>{m.model === 'fallback' ? 'Rule checks only, no AI read' : m.model === 'demo' ? 'Sample data' : 'Written by Claude'}</span>
        {m.last_source_at ? <><span aria-hidden="true">·</span><span>Newest item {ago(m.last_source_at, now)}</span></> : null}
      </div>
    </>
  );
}

/** One Smart Summary bar per deal, for the Contracts screen: the rows and staleness read in two queries for the whole list. */
export function DealSummaryList({ workspaceId, deals, demo }: { workspaceId: number | null; deals: { dealId: number; label: string }[]; demo?: DealMemory | null }) {
  const ids = deals.map((d) => d.dealId);
  const key = ids.join(',');
  const [data, setData] = useState<{ key: string; memories: Map<number, DealMemory>; newest: Map<number, string>; error?: string } | null>(null);
  useEffect(() => {
    if (demo || workspaceId == null || !key) return;
    let alive = true;
    const list = key.split(',').map(Number);
    void Promise.all([loadDealMemories(workspaceId, list), loadNewestInputs(list)]).then(([r, n]) => {
      if (alive) setData({ key, memories: r.memories, newest: n, error: r.error });
    });
    return () => { alive = false; };
  }, [workspaceId, key, demo]);

  if (demo) return <div className="dsm-list"><DealSmartSummary workspaceId={null} dealId={demo.deal_id} demo={demo} label={deals[0]?.label} defaultOpen /></div>;
  if (!deals.length) return <p className="dsm-hint">No deals with contracts yet. A summary appears here for each deal once a contract is on it.</p>;
  if (!data || data.key !== key) return <p className="dsm-hint" role="status">Reading the summaries…</p>;
  if (data.error) return <p className="dsm-hint dsm-err" role="alert">{data.error}</p>;
  const ordered = [...deals].sort((a, b) => {
    const score = (d: number) => {
      const mm = data.memories.get(d);
      return mm ? issueCounts(mm).conflicts * 10 + issueCounts(mm).missing : -1;
    };
    return score(b.dealId) - score(a.dealId);
  });
  return (
    <div className="dsm-list">
      {ordered.map((d) => (
        <DealSmartSummary key={d.dealId} workspaceId={workspaceId} dealId={d.dealId} label={d.label}
          preloaded={{ memory: data.memories.get(d.dealId) ?? null, newestAt: data.newest.get(d.dealId) ?? null }} />
      ))}
    </div>
  );
}

