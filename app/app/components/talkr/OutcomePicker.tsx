'use client';

/**
 * How did the call go: the eight outcomes, the chip that says when or why,
 * the text, and "This will", which is the plan the save runs.
 *
 * One component in four places, and only one mounted at a time: Today's rail
 * on a desk (`rail`), the wrap-up in the slide-out and the Dialer screen
 * (`card`), the full-screen phone's wrap-up (`phone`), and the phone's "Log
 * outcome" sheet (`sheet`). The host keys it by call or seller, so its state
 * resets between calls.
 *
 * Keys, while armed (the call is in wrap-up, or Log without calling armed
 * it): 1-8 pick or clear an outcome, Enter saves, ⌘/Ctrl+Enter saves from a
 * text field, ←/→ move along the chips, T toggles the text, N jumps to the
 * notes, Esc in the notes comes back here. It stands down for the shell's own
 * chords (a Quick Add Q then 1 is a new seller, never an outcome), inside any
 * field, and while search, Quick Add, a create dialog, Ask or Lane is open.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import type { OutcomeLedger, WrapKey } from '@/app/clozr/useClozr';
import { OFFER_OUTCOMES, OUTCOMES, type OutcomeDef, type OutcomeKey } from '@/lib/call-outcomes';
import { firstName } from '@/lib/call-coaching';
import { advancesAfterSave } from '@/lib/dial-engine';
import { CoachingReviewCard } from './CoachingReviewCard';
import { WrapFieldsCard } from './DialerParts';
import { useMinuteTick } from './ProspectTime';
import { useSoftphone } from './softphoneAdapter';

export type OutcomeTarget = NonNullable<ClozrView['outcomeTarget']>;
type Variant = 'rail' | 'card' | 'phone' | 'sheet';

const INK = '#18181B';
const MUTED = '#52525B';
const MINT = '#0A8560';
const MINT_TEXT = '#08694C';
const MINT_TINT = '#E7F8F1';
const LINE = '#E4E4E7';
const CONTROL = '#D4D4D8';

const KBD: React.CSSProperties = {
  minWidth: 18, textAlign: 'center', fontSize: 11, fontWeight: 600, lineHeight: 1.4, fontFamily: 'inherit',
  color: MUTED, background: '#F4F4F5', border: `1px solid ${LINE}`, borderRadius: 4, padding: '1px 5px',
};

/** Set by a save, so the next picker (the next call, the next row) takes focus. */
let refocus = false;

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={MINT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

export function OutcomePicker({
  V, target, variant, armed, canPick = armed, saveLabel, counter, facts, onFocusNotes, onSkip, onSaved, onCancel, heading = 'How did it go?',
  children, below, offer, plans, keysInside = false,
}: {
  V: ClozrView;
  target: OutcomeTarget;
  variant: Variant;
  /** Keys, Enter and Save act. */
  armed: boolean;
  /** Outcomes can be clicked: ahead of time during a call, or once armed. */
  canPick?: boolean;
  saveLabel: string;
  counter?: string;
  facts?: Partial<Record<WrapKey, string>>;
  onFocusNotes?: () => void;
  /** The call's wrap-up can be closed without an outcome (the phone and the desk wrap-up). */
  onSkip?: () => void;
  onSaved?: () => void;
  /** Log without calling: back out. */
  onCancel?: () => void;
  heading?: string;
  /** Between "This will" and Save. */
  children?: ReactNode;
  /** After Save (the desk wrap-up's summary and coaching). */
  below?: ReactNode;
  /**
   * The SOP's offer outcomes (Offer accepted, Declined, No offer): `only` on
   * the record's outcome bar, `also` under the eight once an offer is out.
   */
  offer?: 'only' | 'also';
  /** Drip plans a Declined can enroll the seller in. */
  plans?: { id: string; name: string }[];
  /**
   * Keys act only while focus is inside the picker. The record sets it: there
   * ⌘ Enter sends from the composer and the arrows walk the list.
   */
  keysInside?: boolean;
}) {
  const { notes, setNotes } = useSoftphone();
  const [sel, setSel] = useState<OutcomeKey | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [textOn, setTextOn] = useState<boolean | null>(null);
  const [pickAt, setPickAt] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [enrollId, setEnrollId] = useState<string>('');
  const [ledger, setLedger] = useState<OutcomeLedger | null>(null);
  const [busy, setBusy] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const tick = useMinuteTick();
  const touch = variant === 'phone' || variant === 'sheet';

  const plan = sel && tick !== null
    ? target.plan(sel, {
      chip, textOn, pickAt: pickAt || null, notes, facts, now: new Date(tick),
      reason, enroll: plans?.find((pl) => pl.id === enrollId) ?? null,
    })
    : null;
  // A partial save locks the outcome, so a retry cannot stack a second task.
  const locked = !!ledger && !ledger.saved && ledger.failed.length > 0;
  const canSave = armed && !!plan && !plan.blocked && !busy;

  const pick = useCallback((k: OutcomeKey) => {
    if (locked) return;
    setSel((cur) => (cur === k ? null : k));
    setChip(null);
    setTextOn(null);
    setReason(null);
    setEnrollId('');
  }, [locked]);

  const save = useCallback(async () => {
    if (!armed || !plan || plan.blocked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await target.save(plan, { notes, facts, clearNotes: () => setNotes(''), ledger });
      if (result.saved) {
        refocus = true;
        onSaved?.();
      } else setLedger(result);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [armed, plan, target, notes, facts, setNotes, ledger, onSaved]);

  // The window handler reads the latest of everything through refs.
  const live = useRef({ V, plan, save, pick, onFocusNotes });
  useEffect(() => {
    live.current = { V, plan, save, pick, onFocusNotes };
  });

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      const { V: v, plan: p, save: doSave, pick: doPick, onFocusNotes: notesFocus } = live.current;
      if (e.defaultPrevented || e.repeat) return;
      if (v.searchOpen || v.quickAddOpen || v.addOpen || v.aiOpen || v.laneOpen) return;
      const el = e.target as HTMLElement | null;
      if (keysInside && !(el && rootRef.current?.contains(el))) return;
      const tag = el?.tagName ?? '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        void doSave();
        return;
      }
      if (typing) {
        if (e.key === 'Escape' && el?.hasAttribute('data-call-notes')) {
          el.blur();
          headRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The record's offer bar shows only the offer outcomes: 1-8 have nothing to pick there.
      if (/^[1-8]$/.test(e.key) && offer !== 'only') {
        e.preventDefault();
        doPick(OUTCOMES[Number(e.key) - 1]!.key);
        return;
      }
      if (e.key === 'Enter') {
        // A focused button or link acts on its own Enter; the Save button saves through its click.
        if (tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault();
        void doSave();
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && p && p.chips.length) {
        e.preventDefault();
        const i = Math.max(0, p.chips.findIndex((c) => c.id === p.chip));
        const next = p.chips[(i + (e.key === 'ArrowRight' ? 1 : p.chips.length - 1)) % p.chips.length]!;
        setChip(next.id);
        return;
      }
      if (e.key.toLowerCase() === 't' && p?.text) {
        e.preventDefault();
        setTextOn(!p.text.on);
        return;
      }
      if (e.key.toLowerCase() === 'n' && notesFocus) {
        e.preventDefault();
        notesFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, offer, keysInside]);

  // Entering wrap-up puts focus on the heading, unless the rep is mid-sentence in a field.
  useEffect(() => {
    if (keysInside || (!armed && !refocus)) return;
    const a = document.activeElement as HTMLElement | null;
    const typing = !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable);
    if (!typing && variant !== 'phone') headRef.current?.focus({ preventScroll: true });
    refocus = false;
  }, [armed, variant, keysInside]);

  // ---- look -------------------------------------------------------------
  const btnH = touch ? 50 : 40;
  const radius = touch ? 10 : 6;
  const pad = variant === 'rail' ? '0 20px' : '0';

  const outcomeButton = (o: OutcomeDef) => {
    const on = sel === o.key;
    const keyed = !touch && o.n > 0;
    return (
      <button
        key={o.key}
        type="button"
        data-testid={`outcome-${o.key}`}
        aria-pressed={on}
        aria-keyshortcuts={keyed ? String(o.n) : undefined}
        disabled={!canPick || (locked && !on)}
        onClick={() => pick(o.key)}
        className="clozr-outcome"
        style={{
          minHeight: btnH, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
          // Off (no call yet): quieter, but never lighter than the lightest text allowed.
          borderRadius: radius, border: `1px solid ${on ? MINT : canPick ? CONTROL : LINE}`, background: on ? MINT_TINT : canPick ? '#FFFFFF' : '#FAFAFA',
          color: on ? MINT_TEXT : canPick ? INK : '#71717A', fontSize: touch ? 15 : 13, fontWeight: 500, lineHeight: 1.3, fontFamily: 'inherit', textAlign: 'left',
          cursor: canPick ? 'pointer' : 'default',
        }}
      >
        {keyed && <kbd style={KBD}>{o.n}</kbd>}
        <span>{o.label}</span>
      </button>
    );
  };
  const offerRow = offer ? (
    <div role="group" aria-label="How the offer went" style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 6, marginTop: offer === 'also' ? 12 : 0 }}>
      {offer === 'also' && <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>How the offer went</span>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: touch ? 8 : 6 }}>
        {OFFER_OUTCOMES.map(outcomeButton)}
      </div>
    </div>
  ) : null;
  const outcomeButtons = (
    <>
      {offer !== 'only' && (
        <div style={{ padding: pad, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: touch ? 8 : 6 }}>
          {OUTCOMES.map(outcomeButton)}
        </div>
      )}
      {offerRow}
    </>
  );

  const chipGroupLabel = !plan ? '' : plan.key === 'appt' ? 'Walkthrough when'
    : plan.key === 'nooffer' ? 'What next' : plan.key === 'declined' ? 'Follow up when'
      : plan.chipKind === 'reason' ? 'Reason' : plan.key === 'followup' ? 'Follow up when' : 'Call back when';
  // The record's offer bar is three buttons until one is picked.
  const willBox = offer === 'only' && !plan ? null : (
    <div
      data-testid="outcome-will"
      aria-live="polite"
      style={{
        margin: variant === 'rail' ? '16px 20px 0' : '12px 0 0', padding: 14, borderRadius: 10, background: '#FAFAFA',
        border: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>This will</span>
      {!plan && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, fontWeight: 500, color: MUTED }}>
          {canPick
            ? 'Pick what happened. The stage, the follow-up and the text are set for you, and shown here before you save.'
            : `Call ${target.first} to log how it went.`}
        </p>
      )}
      {plan && (
        <>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {plan.lines.map((l) => (
              <li key={l} style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.4, fontWeight: 500, color: INK }}>
                <Check />
                <span>{l}</span>
              </li>
            ))}
          </ul>
          {plan.chips.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span id={`chips-${target.key}`} style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>{chipGroupLabel}</span>
              {!touch && plan.chips.length > 1 && (
                <span aria-hidden style={{ display: 'inline-flex', gap: 4 }}><kbd style={KBD}>←</kbd><kbd style={KBD}>→</kbd></span>
              )}
            </div>
            <div role="group" aria-labelledby={`chips-${target.key}`} aria-keyshortcuts={touch ? undefined : 'ArrowLeft ArrowRight'} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {plan.chips.map((c) => {
                const on = plan.chip === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`outcome-chip-${c.id}`}
                    aria-pressed={on}
                    disabled={locked}
                    onClick={() => setChip(c.id)}
                    style={{
                      minHeight: touch ? 44 : 32, padding: '0 10px', borderRadius: 999, border: `1px solid ${on ? INK : CONTROL}`,
                      background: on ? INK : '#FFFFFF', color: on ? '#FFFFFF' : INK, fontSize: touch ? 13 : 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            </div>
          )}
          {plan.reasons && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: MUTED }}>
              {plan.key === 'declined' ? 'Why they said no' : 'Why there is no offer'}
              <select
                data-testid="outcome-reason"
                value={reason ?? ''}
                disabled={locked}
                onChange={(e) => setReason(e.target.value || null)}
                style={{ height: touch ? 44 : 36, border: `1px solid ${CONTROL}`, borderRadius: 6, padding: '0 10px', fontSize: touch ? 16 : 13, fontFamily: 'inherit', color: INK, background: '#FFFFFF' }}
              >
                <option value="">Pick a reason</option>
                {plan.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}
          {plan.key === 'declined' && plans && plans.length > 0 && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: MUTED }}>
              Drip plan
              <select
                data-testid="outcome-drip"
                value={enrollId}
                disabled={locked}
                onChange={(e) => setEnrollId(e.target.value)}
                style={{ height: touch ? 44 : 36, border: `1px solid ${CONTROL}`, borderRadius: 6, padding: '0 10px', fontSize: touch ? 16 : 13, fontFamily: 'inherit', color: INK, background: '#FFFFFF' }}
              >
                <option value="">No drip</option>
                {plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
              </select>
            </label>
          )}
          {plan.chip === 'pick' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600, color: MUTED }}>
              Walkthrough time
              <input
                type="datetime-local"
                value={pickAt}
                onChange={(e) => setPickAt(e.target.value)}
                style={{ height: touch ? 44 : 36, border: `1px solid ${CONTROL}`, borderRadius: 6, padding: '0 10px', fontSize: touch ? 16 : 13, fontFamily: 'inherit', color: INK, background: '#FFFFFF' }}
              />
            </label>
          )}
          {plan.text && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                type="button"
                role="switch"
                aria-checked={plan.text.on}
                data-testid="outcome-text"
                aria-keyshortcuts={touch ? undefined : 'T'}
                disabled={locked}
                onClick={() => setTextOn(!plan.text!.on)}
                style={{ alignSelf: 'flex-start', minHeight: touch ? 44 : 32, display: 'inline-flex', alignItems: 'center', gap: 8, padding: 0, border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, color: INK, cursor: 'pointer' }}
              >
                <span aria-hidden style={{ width: 28, height: 16, borderRadius: 999, background: plan.text.on ? MINT : CONTROL, position: 'relative', flexShrink: 0 }}>
                  <span style={{ position: 'absolute', top: 2, left: plan.text.on ? 14 : 2, width: 12, height: 12, borderRadius: 999, background: '#FFFFFF' }} />
                </span>
                Text {target.first}
                {!touch && <kbd style={KBD}>T</kbd>}
              </button>
              <p style={{ margin: 0, padding: '10px 12px', borderRadius: 6, background: '#FFFFFF', border: `1px solid ${LINE}`, fontSize: 13, fontWeight: 400, lineHeight: 1.55, color: plan.text.on ? '#3F3F46' : '#71717A', maxWidth: '72ch' }}>
                {plan.text.body}
              </p>
            </div>
          )}
          <p style={{ margin: 0, fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED }}>{plan.talkrLine}</p>
          {plan.blocked && <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#B45309' }}>{plan.blocked}</p>}
        </>
      )}
      {locked && ledger && (
        <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, fontWeight: 500, color: '#B91C1C' }}>
          {(() => {
            const failed = new Set(ledger.failed.map((f) => f.step));
            const saved = Object.keys(ledger.ok).filter((k) => !failed.has(k) && k !== 'talkr');
            return `${saved.length ? `Saved: ${saved.map(stepWord).join(', ')}. ` : ''}Not saved: ${ledger.failed.map((f) => `${f.label} (${f.message})`).join(', ')}. Nothing was texted.`;
          })()}
        </p>
      )}
    </div>
  );

  const label = busy ? 'Saving…' : locked ? 'Retry' : saveLabel;
  const saveButton = (testId: string, style: React.CSSProperties = {}) => (
    <button
      type="button"
      data-testid={testId}
      aria-keyshortcuts={touch ? undefined : 'Enter'}
      disabled={!canSave}
      onClick={() => void save()}
      style={{
        height: touch ? 50 : 44, borderRadius: touch ? 10 : 6, border: 0, background: canSave ? MINT : '#F4F4F5', color: canSave ? '#FFFFFF' : MUTED,
        fontSize: touch ? 15 : 13, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        cursor: canSave ? 'pointer' : 'default', ...style,
      }}
    >
      {label}
      {!touch && (
        <kbd style={{ ...KBD, background: 'transparent', color: canSave ? '#FFFFFF' : MUTED, borderColor: canSave ? 'rgba(255,255,255,.7)' : CONTROL }}>⏎</kbd>
      )}
    </button>
  );
  const quiet = (text: string, onClick: () => void, testId?: string, style: React.CSSProperties = {}) => (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{ height: touch ? 50 : 36, padding: '0 14px', borderRadius: touch ? 10 : 6, border: `1px solid ${CONTROL}`, background: '#FFFFFF', color: INK, fontSize: touch ? 15 : 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', ...style }}
    >
      {text}
    </button>
  );
  const caption = !armed && canPick
    ? 'Pick ahead if you like. Save after you hang up.'
    : 'Two actions per call: an outcome, then Enter.';

  const header = (
    <div style={{ padding: variant === 'rail' ? '20px 20px 12px' : '0 0 12px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <h2 ref={headRef} tabIndex={-1} style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.3, color: INK, outline: 'none' }}>{heading}</h2>
      {counter && <span style={{ fontSize: 12, fontWeight: 500, color: MUTED, whiteSpace: 'nowrap' }}>{counter}</span>}
    </div>
  );

  if (variant === 'phone') {
    return (
      <div data-testid="outcome-picker" style={{ display: 'flex', flexDirection: 'column' }}>
        {header}
        {outcomeButtons}
        {willBox}
        {children}
        <div
          data-testid="wrap-footer"
          style={{
            position: 'sticky', bottom: 0, zIndex: 2, margin: '16px -16px 0', padding: '12px 16px max(env(safe-area-inset-bottom, 0px), 12px)',
            background: '#FFFFFF', borderTop: `1px solid ${LINE}`, display: 'flex', gap: 8,
          }}
        >
          {quiet('Skip', () => onSkip?.(), 'wrap-skip', { flex: 1 })}
          {saveButton('wrap-save', { flex: 2 })}
        </div>
      </div>
    );
  }

  if (variant === 'rail') {
    return (
      <div data-testid="outcome-picker" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        {header}
        {outcomeButtons}
        {willBox}
        {children}
        <div style={{ marginTop: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid #F0F0F1' }}>
          {saveButton('outcome-save')}
          {onCancel && quiet('Cancel', onCancel, 'outcome-cancel', { height: 32, border: 0, color: MUTED })}
          <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: MUTED, textAlign: 'center' }}>{caption}</p>
        </div>
      </div>
    );
  }

  // card (the desk wrap-up) and sheet (the phone's Log outcome)
  return (
    <div ref={rootRef} data-testid="outcome-picker" style={{ display: 'flex', flexDirection: 'column' }}>
      {header}
      {outcomeButtons}
      {willBox}
      {children}
      <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {onSkip && quiet('Skip', onSkip, 'outcome-skip', touch ? { flex: 1 } : { border: 0, color: MUTED })}
        {onCancel && quiet('Cancel', onCancel, 'outcome-cancel', touch ? { flex: 1 } : { border: 0, color: MUTED })}
        {saveButton('outcome-save', touch ? { flex: 2 } : { padding: '0 16px', height: 36 })}
      </div>
      {below}
    </div>
  );
}

const stepWord = (step: string) => ({
  claim: 'claim', stage: 'stage', 'task-done': 'task completion', 'task-move': 'follow-up time', 'task-new': 'follow-up task', appointment: 'appointment',
  enroll: 'drip plan',
} as Record<string, string>)[step] ?? step.replace(/^tag:/, '') + ' tag';

/**
 * The wrap-up for a call with a seller: the outcome picker in place of the
 * Talkr disposition grid, with the summary, the call's CRM fields and the
 * coaching card still there. Buyers and unknown numbers keep the grid.
 */
export function SellerWrapUp({
  V, target, mobile = false, onOpenRecord,
}: {
  V: ClozrView;
  target: OutcomeTarget;
  mobile?: boolean;
  onOpenRecord?: () => void;
}) {
  const { notes, setNotes, authed, me } = useSoftphone();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [edits, setEdits] = useState<Partial<Record<WrapKey, string>>>({});
  const call = V.talkrPhone.sp.call;
  const callId = authed && call && call.id !== 'unknown' ? call.id : null;
  const noAnswer = V.wrapNoAnswer;
  const session = V.talkrPhone.session.session;
  // Match saveOutcome: CLOZR queue always advances; a Talkr campaign does in power and the self-advancing modes.
  const sessionOn = !!V.queueSession || (!!session && session.state !== 'paused' && advancesAfterSave(V.talkrPhone.session.campaign?.mode ?? session.mode));

  const facts = Object.fromEntries(V.wrapFields.map((f) => [f.key, edits[f.key] ?? f.v])) as Partial<Record<WrapKey, string>>;
  const transcriptText = V.transcript.map((l) => `${l.who}: ${l.text}`).join('\n');
  const notesBox = (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, fontSize: 12, fontWeight: 600, color: MUTED }}>
      Notes, saved with the outcome
      <textarea
        ref={noteRef}
        data-call-notes
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Asking price, timeline, condition, who decides"
        rows={3}
        style={{ border: `1px solid ${CONTROL}`, borderRadius: 6, background: '#FFFFFF', padding: '10px 12px', fontFamily: 'inherit', fontSize: mobile ? 16 : 13, fontWeight: 400, lineHeight: 1.55, color: INK, resize: 'vertical', minHeight: mobile ? 96 : 72 }}
      />
    </label>
  );
  const extras = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <div style={{ background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>Call summary</span>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 400, lineHeight: 1.55, color: INK, maxWidth: '72ch' }}>{V.summaryText}</p>
      </div>
      {!noAnswer && V.wrapFields.length > 0 && <WrapFieldsCard V={V} edits={edits} setEdits={setEdits} mobile={mobile} />}
      {!noAnswer && (
        <CoachingReviewCard
          demo={!authed}
          auto={!!callId}
          transcript={transcriptText}
          repName={firstName(me?.display_name, 'Rep')}
          prospectName={firstName(V.callTarget?.name, 'Prospect')}
          workspaceId={V.liveIds?.workspaceId}
          talkrCallId={callId}
          source="live"
        />
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="seller-wrap">
      {/* The phone's own header already says who and how long; a desk wrap-up says it here. */}
      {!mobile && (
      <div style={{ background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 10, padding: 16, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3, color: INK }}>{target.name}</span>
          <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, color: MUTED }}>{target.stage}, {V.wrapStatusLine}</span>
        </div>
        {V.callRecord && (
          <button
            type="button"
            onClick={onOpenRecord ?? V.callRecord.open}
            style={{ height: 32, padding: '0 12px', borderRadius: 6, border: `1px solid ${CONTROL}`, background: '#FFFFFF', color: INK, fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0 }}
          >
            Open record
          </button>
        )}
      </div>
      )}
      {(() => {
        const picker = (
          <OutcomePicker
            key={target.key}
            V={V}
            target={target}
            variant={mobile ? 'phone' : 'card'}
            armed
            saveLabel={mobile ? (sessionOn ? 'Save & next call' : 'Save') : sessionOn ? 'Save and call next' : 'Save'}
            facts={facts}
            onFocusNotes={() => noteRef.current?.focus()}
            onSkip={V.dismissWrap}
            below={mobile ? undefined : extras}
          >
            {notesBox}
            {mobile ? extras : null}
          </OutcomePicker>
        );
        // On the phone the picker sits on the grouped background, so its
        // sticky footer can run edge to edge; on a desk it is a card.
        return mobile ? picker : (
          <div style={{ background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 10, padding: 16 }}>{picker}</div>
        );
      })()}
    </div>
  );
}
