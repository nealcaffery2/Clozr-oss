// The ⌘K command bar: verbs first, then records.
//
// It replaces the old search palette only. Quick Add, the header's product
// links and the Tools menu, and People's own search box all stay; the bar adds
// verbs on top of them ("new lead" opens the same create dialog as Quick Add).
//
// What is typed, the second list (Tab's "more actions", a rep to assign, a
// stage) and the picked row live here, so a keystroke re-renders the bar and
// not the app. The rows come from command-rows.ts (pure) over the view-model's
// cmdData; running one goes back through V.runCommand, or, for the two
// hand-offs to the seller record, through V.openRecordComposer and
// V.openOfferSheet, which the record reads.
//
// Past three letters the bar also searches what was said: every call
// transcript, text, email and voicemail in the workspace (lib/comm-search.ts,
// migration 278), listed last under "In calls and messages" with the words
// around the match. The record lists never wait on it.
//
// Details that matter in something used hundreds of times a day: no open or
// close animation (it is there in the frame it was asked for); the input keeps
// focus; the picked row stays scrolled into view; the mouse only takes the
// selection when it actually moves; ⏎ never fires mid-IME composition; Tab
// stays inside; Escape backs out of a second list, then closes and gives focus
// back to where it was.
'use client';

import React, { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react';
import { toggleTheme } from '@/lib/theme';
import type { ClozrView } from './view';
import type { Mark } from '@/lib/command';
import { Mark as Glyph } from '@/components/ds/mark';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { buildCommandRows, rowText, type CmdRow } from './command-rows';
import { hitTitle, searchConversations, searchable, snippetParts, type CommHit } from '@/lib/comm-search';
import { BUYR, COMPR, DEAL_MACHINE, LANE, TALKR } from './brand';
import './command-bar.css';

/** The row's dot: whose product does the work. */
const MARK: Record<Mark, string> = {
  talkr: TALKR,
  compr: COMPR,
  lane: LANE,
  genius: 'var(--c-genius)',
  dealMachine: DEAL_MACHINE,
  buyr: BUYR,
  clozr: 'var(--c-accent)',
  neutral: 'var(--subtle, #a1a1aa)',
};

/** A message's icon, by channel. */
const GLYPH: Record<string, string> = { call: 'Call', sms: 'SMS out', email: 'Email', voicemail: 'Voicemail', note: 'Note' };

/** The words around the match, the match itself bold. */
function Snippet({ text }: { text: string }) {
  return <>{snippetParts(text).map((p, i) => (p.hit ? <mark key={i} className="clozr-cmd-hit">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export function CommandBar({ V }: { V: ClozrView }) {
  const data = V.cmdData;
  const [q, setQ] = useState(V.searchQ);
  const [step, setStep] = useState<string | null>(null);
  /** What was typed before a second list opened, to put back when it closes. */
  const [before, setBefore] = useState('');
  const [sel, setSel] = useState(0);
  const [mod] = useState(() => (isMac() ? '⌘' : 'Ctrl'));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** A row ran: whatever it opened takes focus, so it is not handed back. */
  const ran = useRef(false);
  /** Where the pointer was last seen; a mousemove that did not move is the list scrolling under it. */
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const result = useMemo(() => (data ? buildCommandRows(data, q, step) : null), [data, q, step]);

  // What was said: searched a beat after typing stops, never on the sample graph or in a second list.
  const ws = V.liveIds?.workspaceId ?? null;
  const convQ = !step && ws != null && searchable(q) ? q.trim() : '';
  // Keyed by workspace too: a switch with the bar open never shows the last workspace's matches.
  const [conv, setConv] = useState<{ ws: number; q: string; hits: CommHit[] | null } | null>(null);
  useEffect(() => {
    if (!convQ || ws == null) return;
    let live = true;
    const t = setTimeout(() => {
      void searchConversations(ws, convQ).then((hits) => { if (live) setConv({ ws, q: convQ, hits }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [convQ, ws]);
  const convState: 'off' | 'loading' | 'error' | 'done' = !convQ ? 'off' : conv?.q !== convQ || conv.ws !== ws ? 'loading' : conv.hits === null ? 'error' : 'done';
  const convRows = useMemo<CmdRow[]>(() => {
    if (convState !== 'done' || !conv?.hits || !data) return [];
    const may = (screen: string) => data.can[screen] !== false;
    return conv.hits.flatMap((h): CmdRow[] => {
      const row = { id: 'clozr-cmd-conv-' + h.id, label: hitTitle(h), sub: h.snippet, mark: 'neutral' as const, dot: 'var(--muted, #52525b)', glyph: GLYPH[h.channel] ?? 'Note' };
      const action = h.sellerId != null && may('people') ? { t: 'open' as const, rec: 'person' as const, id: 's' + h.sellerId }
        : h.buyerId != null && may('buyers') ? { t: 'open' as const, rec: 'buyer' as const, id: 'b' + h.buyerId }
          : null;
      if (!action) {
        // Filed on a deal only: its seller's record pinned to the deal, or the deal sheet when it has no seller.
        if (h.dealId == null || !may('dealSheet')) return [];
        const dealId = 'd' + h.dealId;
        const seller = data.deals.find((d) => d.dealId === dealId)?.id ?? '';
        return [{ ...row, action: { t: 'deal', id: seller && may('people') ? seller : '', where: 'person', dealId } }];
      }
      // Tab lists the record's actions when the bar has it loaded, as on its own row.
      const loaded = action.rec === 'person' ? data.people.some((p) => p.id === action.id) : data.buyers.some((b) => b.id === action.id);
      return [{ ...row, action, ...(loaded ? { more: action.rec + ':' + action.id } : {}) }];
    });
  }, [conv, convState, data]);
  const rows = useMemo(() => [...(result?.groups.flatMap((g) => g.rows) ?? []), ...convRows], [result, convRows]);
  const at = Math.min(sel, Math.max(0, rows.length - 1));
  const current: CmdRow | undefined = rows[at];

  // Focus moves in before the first paint, and goes back on a dismissal.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      if (ran.current) return;
      if (before && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // The picked row stays in view; the first one brings its group label with it.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !current) return;
    if (at === 0) { list.scrollTop = 0; return; }
    document.getElementById(current.id)?.scrollIntoView({ block: 'nearest' });
  }, [current, at]);

  if (!result) return null;

  const type = (text: string) => { setQ(text); setSel(0); };
  /** Into a second list (the query starts empty), or back out of it (the query comes back). */
  const enter = (next: string | null) => {
    if (next && !step) setBefore(q);
    setStep(next);
    setQ(next ? '' : before);
    setSel(0);
  };
  const close = () => V.closeSearch();

  const run = (row: CmdRow | undefined, alt: boolean) => {
    const a = alt ? row?.alt?.action : row?.action;
    if (!a) return;
    if (a.t === 'step') return enter(a.step);
    if (a.t === 'type') return type(a.text);
    if (a.t === 'theme') { close(); toggleTheme(); return; }
    ran.current = true;
    // The seller record reads these two: the composer on that channel, focused; the Make offer sheet.
    if (a.t === 'compose') { close(); V.openRecordComposer(a.pid, a.channel); return; }
    if (a.t === 'offer') { close(); V.openOfferSheet(a.pid); return; }
    V.runCommand(a);
  };

  /** Tab: every action for the picked row's record (else the top one). */
  const more = () => {
    // A message whose record is not loaded has no actions list; never fall through to another record's.
    if (current && !current.more && current.id.startsWith('clozr-cmd-conv-')) return;
    const key = current?.more ?? rows.find((r) => r.more)?.more;
    if (key && step !== 'more:' + key) enter('more:' + key);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // An IME is still composing: its Enter picks a candidate, not a row.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = rows.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setSel((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(current, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Backspace' && !q && step) {
      e.preventDefault();
      enter(null);
    }
  };

  // Escape and Tab are read on the whole dialog, so they work wherever focus is inside it.
  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (step) enter(null);
      else close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.target !== inputRef.current) inputRef.current?.focus();
      else if (e.shiftKey) { if (step) enter(null); } else more();
    }
  };

  const mobile = V.isMobile;
  const title = result.title;
  let gi = 0;

  /** One row; a message that matched shows the words around the match. */
  const renderRow = (r: CmdRow, said = false) => {
    const selected = r.id === current?.id;
    return (
      <div
        key={r.id}
        id={r.id}
        role="option"
        aria-selected={selected}
        aria-label={rowText(r)}
        aria-describedby={r.sub ? r.id + '-sub' : undefined}
        className="clozr-cmd-row"
        onMouseMove={(e) => {
          const p = pointer.current;
          pointer.current = { x: e.screenX, y: e.screenY };
          if (!p || (p.x === e.screenX && p.y === e.screenY)) return;
          const i = rows.indexOf(r);
          if (i !== at) setSel(i);
        }}
        onClick={(e) => run(r, e.metaKey || e.ctrlKey)}
      >
        {r.mark === 'compr'
          ? <span style={{ display: 'inline-flex', flex: 'none' }}><ComprIcon size={14} /></span>
          : <span style={{ color: r.dot ?? MARK[r.mark], display: 'inline-flex', flex: 'none' }}><Glyph label={r.glyph ?? r.label} /></span>}
        <span className="clozr-cmd-text">
          <span className="clozr-cmd-title">
            {r.verb ? <span className="clozr-cmd-verb">{r.verb} </span> : null}
            {r.label}
          </span>
          {r.sub ? <span id={r.id + '-sub'} className={'clozr-cmd-sub' + (r.num ? ' clozr-cmd-num' : '') + (said ? ' clozr-cmd-snip' : '')}>{said ? <Snippet text={r.sub} /> : r.sub}</span> : null}
        </span>
        {selected && !mobile ? <span className="clozr-cmd-enter" aria-hidden>↵</span> : null}
      </div>
    );
  };

  return (
    <div
      className="clozr-cmd-backdrop"
      data-mobile={mobile || undefined}
      // A click outside closes it; the press itself keeps the caret in the input.
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        data-screen-label="Command bar"
        className="clozr-cmd"
        data-mobile={mobile || undefined}
        onKeyDown={onPanelKey}
        // Clicks inside keep the caret in the input.
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
      >
        <div className="clozr-cmd-field">
          <label htmlFor="clozr-cmd-input" className="clozr-cmd-label">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="clozr-cmd-sr">{title ?? 'Search or type a command'}</span>
          </label>
          {title ? <span className="clozr-cmd-chip" aria-hidden>{title}</span> : null}
          <input
            id="clozr-cmd-input"
            ref={inputRef}
            className="clozr-cmd-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="clozr-cmd-list"
            aria-autocomplete="list"
            aria-activedescendant={current?.id}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            value={q}
            placeholder={result.placeholder}
            onChange={(e) => type(e.target.value)}
            onKeyDown={onInputKey}
          />
          {mobile ? (
            <button type="button" className="clozr-cmd-cancel" onClick={close}>Cancel</button>
          ) : (
            <button type="button" className="clozr-cmd-esc" onClick={close} aria-label="Close" tabIndex={-1}>esc</button>
          )}
        </div>
        <div id="clozr-cmd-list" ref={listRef} role="listbox" aria-label={title ? 'Actions' : 'Commands and records'} className="clozr-cmd-list">
          {result.groups.map((g) => {
            const gid = 'clozr-cmd-g' + gi++;
            return (
              <div key={gid} role="group" aria-labelledby={gid}>
                <div id={gid} role="presentation" className="clozr-cmd-group">{g.label}</div>
                {g.rows.map((r) => renderRow(r))}
              </div>
            );
          })}
          {convState !== 'off' && !(convState === 'done' && !rows.length) ? (
            <div role="group" aria-labelledby="clozr-cmd-g-conv" aria-busy={convState === 'loading'}>
              <div id="clozr-cmd-g-conv" role="presentation" className="clozr-cmd-group">In calls and messages</div>
              {convRows.map((r) => renderRow(r, true))}
              {convState === 'done' && convRows.length ? null : (
                <div role="status" className="clozr-cmd-status">
                  {convState === 'loading' ? 'Searching calls, texts and emails…'
                    : convState === 'error' ? 'Calls and messages did not load. Check your connection and type again to retry.'
                      : `No calls or messages mention “${convQ}”.`}
                </div>
              )}
            </div>
          ) : null}
          {!rows.length && convState !== 'loading' && convState !== 'error' ? (
            <div className="clozr-cmd-empty">{convState === 'done' ? `No records, calls or messages match “${convQ}”.` : result.empty}</div>
          ) : null}
        </div>
        {!mobile ? (
          <div className="clozr-cmd-foot" aria-hidden>
            <span><kbd className="clozr-cmd-kbd">↑↓</kbd>move</span>
            <span><kbd className="clozr-cmd-kbd">↵</kbd>{current?.action.t === 'step' || current?.action.t === 'type' ? 'next' : 'run'}</span>
            {current?.alt ? <span><kbd className="clozr-cmd-kbd">{mod}↵</kbd>{current.alt.label}</span> : null}
            {step ? <span><kbd className="clozr-cmd-kbd">esc</kbd>back</span> : <span><kbd className="clozr-cmd-kbd">tab</kbd>more actions</span>}
            <span className="clozr-cmd-foot-note">Verbs first, then records</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
