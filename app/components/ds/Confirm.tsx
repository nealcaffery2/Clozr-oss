// The one confirm prompt, and `useConfirm()` to ask it from anywhere.
//
// Built from the archive prompt (app/clozr/ArchiveConfirm.tsx) and the record
// sheets' focus handling (app/components/record/useModal.ts): keyboard first,
// Cancel picked when it opens, ← → or Tab move between the two, Enter answers
// with the one picked, Y and N answer directly, Esc is Cancel. Focus is
// trapped inside and goes back to whatever opened it.
//
// An override (a Friday closing, an offer under asking) asks for a typed
// reason instead: `confirmReason()` resolves with the reason, or null when
// cancelled, and Confirm stays disabled until one is typed.
//
//   const { confirm, confirmReason } = useConfirm();
//   if (!(await confirm({ title: 'Delete this plan?', body: 'Its steps go too.', confirmLabel: 'Delete plan', tone: 'danger' }))) return;
//   const why = await confirmReason({ title: 'Close on a Friday?', body: 'Wires can miss the weekend.', reasonLabel: 'Why it has to be Friday' });
//
// <ConfirmProvider> is mounted once, in app/layout.tsx.
'use client';

import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '@/app/components/record/useModal';
import { btn, INK, MUTED, SHADOW } from '@/components/genius/parts';

export type ConfirmAsk = {
  title: string;
  body?: React.ReactNode;
  /** The verb that happens: "Delete plan", never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: the confirm button is red (archive, delete, discard). */
  tone?: 'default' | 'danger';
};
export type ReasonAsk = ConfirmAsk & { reasonLabel?: string; placeholder?: string };

type Pending = { n: number; ask: ReasonAsk; reason: boolean; resolve: (v: string | null) => void };
let seq = 0;
type Api = { confirm: (ask: ConfirmAsk) => Promise<boolean>; confirmReason: (ask: ReasonAsk) => Promise<string | null> };

const Ctx = createContext<Api | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The prompt on screen and the ones waiting behind it. Kept in a ref so an
  // answer resolves exactly once (state updaters can run twice).
  const current = useRef<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const open = useCallback((p: Pending) => {
    if (current.current) { queue.current.push(p); return; }
    current.current = p;
    setPending(p);
  }, []);
  const answer = useCallback((v: string | null) => {
    const done = current.current;
    current.current = queue.current.shift() ?? null;
    setPending(current.current);
    done?.resolve(v);
  }, []);
  const api = useMemo<Api>(() => ({
    confirm: (ask) => new Promise<boolean>((resolve) => open({ n: ++seq, ask, reason: false, resolve: (v) => resolve(v !== null) })),
    confirmReason: (ask) => new Promise<string | null>((resolve) => open({ n: ++seq, ask, reason: true, resolve })),
  }), [open]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {pending ? <ConfirmDialog key={pending.n} ask={pending.ask} reason={pending.reason} onAnswer={answer} /> : null}
    </Ctx.Provider>
  );
}

/** Ask the shared prompt. Outside a provider it answers No, so nothing destructive runs unconfirmed. */
export function useConfirm(): Api {
  const api = useContext(Ctx);
  return api ?? NO_PROVIDER;
}
const NO_PROVIDER: Api = { confirm: async () => false, confirmReason: async () => null };

export function ConfirmDialog({ ask, reason, onAnswer }: { ask: ReasonAsk; reason: boolean; onAnswer: (v: string | null) => void }) {
  const [pick, setPick] = useState<'no' | 'yes'>('no');
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const ready = !reason || text.trim().length > 0;
  const yes = () => { if (ready) onAnswer(reason ? text.trim() : ''); };
  const no = () => onAnswer(null);
  useFocusTrap(boxRef, no, reason ? 'textarea' : '[data-confirm-no]');
  const live = useRef({ pick, yes, no });
  useEffect(() => { live.current = { pick, yes, no }; });
  useEffect(() => { if (!reason) (pick === 'yes' ? yesRef : noRef).current?.focus(); }, [pick, reason]);

  useEffect(() => {
    if (reason) return; // typing a reason: Y and N are letters, not answers
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      const act = e.key === 'ArrowLeft' ? () => setPick('no') : e.key === 'ArrowRight' ? () => setPick('yes')
        : e.key === 'Enter' ? () => (live.current.pick === 'yes' ? live.current.yes() : live.current.no())
          : k === 'y' ? () => live.current.yes() : k === 'n' ? () => live.current.no() : null;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [reason]);

  const danger = ask.tone === 'danger';
  return (
    <div role="presentation" data-gx onClick={no}
      style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div ref={boxRef} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={ask.body ? `${id}-b` : undefined}
        data-testid="confirm" onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '400px', background: 'var(--surface, #fff)', borderRadius: '14px', padding: '16px', boxShadow: SHADOW.lg }}>
        <div id={`${id}-t`} style={{ fontSize: '15px', fontWeight: 700, color: INK, letterSpacing: '-0.015em' }}>{ask.title}</div>
        {ask.body ? <div id={`${id}-b`} style={{ fontSize: '12.5px', color: 'var(--muted, #52525b)', marginTop: '6px', lineHeight: 1.5 }}>{ask.body}</div> : null}
        {reason ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
            <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{ask.reasonLabel ?? 'Reason'}</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={ask.placeholder} rows={3}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); yes(); } }}
              style={{ font: 'inherit', fontSize: 'var(--ds-input-size, 13px)', padding: '8px 10px', borderRadius: '8px', border: 0, boxShadow: SHADOW.ring, resize: 'vertical', minHeight: '64px', color: INK }} />
          </label>
        ) : null}
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
          <button ref={noRef} type="button" data-confirm-no onClick={no} onFocus={() => setPick('no')} style={btn('ghost')}>
            {ask.cancelLabel ?? 'Cancel'}
          </button>
          <button ref={yesRef} type="button" data-testid="confirm-yes" onClick={yes} onFocus={() => setPick('yes')} disabled={!ready}
            style={{ ...btn(danger ? 'solid' : 'purple'), ...(danger ? { background: '#b91c1c', boxShadow: '0 0 0 1px #991b1b, 0 1px 2px rgba(127,29,29,.3)' } : {}) }}>
            {ask.confirmLabel ?? 'Confirm'}
          </button>
        </div>
        {!reason ? (
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '10px' }}>Enter answers · Y or N · Esc cancels</div>
        ) : (
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '10px' }}>⌘ Enter confirms · Esc cancels</div>
        )}
      </div>
    </div>
  );
}
