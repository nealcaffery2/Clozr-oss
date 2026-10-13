// Click-to-edit, the Follow Up Boss way: a field reads as text until you click
// it, then it is an input in the same place.
//
// - Saves on blur or Enter (⌘/Ctrl+Enter in a textarea, change in a select).
//   Esc cancels and never saves, not even on the blur that follows.
// - Optimistic: the new value shows at once. If the save fails it goes back
//   and the error stays under the field until the next edit.
// - Money reads through lib/money (185k, $1.25m); phone and email are checked,
//   and a blank one is refused rather than silently erased.
// - The draft is keyed by record id + field, outside React state, so a parent
//   re-render, a realtime refresh or a remount never throws away typing.
// - A user who can't edit sees plain text, with the reason as a tooltip.
//
// It generalises components/ContactField.tsx and the record's BandField /
// EditableName (app/components/record/PropertyCard.tsx).
//
// onSave resolves on success (with anything: the saved row, nothing) and
// fails by throwing or by resolving `{ ok: false, message }`, so patchRecord's
// result can be returned as is. The caller patches local state itself.
//
//   <InlineField recordId={p.id} field="asking" label="Asking" type="money" value={p.askingNum}
//     onSave={async (v) => {
//       const r = await patchRecord('sellers', p.id, { asking_price: v });
//       if (r.ok) crm.patchLocal('people', { id: p.id, asking: formatDollars(v as number | null) });
//       return r;
//     }} />
'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { formatDollars, parseDollars } from '@/lib/money';

export type InlineType = 'text' | 'money' | 'number' | 'date' | 'select' | 'phone' | 'email' | 'textarea';
export type InlineValue = string | number | null;
export type InlineOption = { value: string; label: string; group?: string };
/** Resolves on success (the saved row, or nothing); throws or resolves `{ ok: false, message }` on failure. */
export type InlineSave = (next: InlineValue) => Promise<unknown>;

/** A save's answer as ok or a message: patchRecord's `{ ok: false }` and a throw both fail. */
function saveOutcome(r: unknown): { ok: boolean; message?: string } {
  if (r && typeof r === 'object' && 'ok' in r && (r as { ok: unknown }).ok === false) {
    const m = (r as { message?: unknown }).message;
    return { ok: false, message: typeof m === 'string' ? m : undefined };
  }
  return { ok: true };
}

/** Typing in progress, by `recordId:field`. Survives re-renders and remounts. */
const drafts = new Map<string, string>();

/** What the input starts with for a stored value. */
function toDraft(type: InlineType, v: InlineValue): string {
  if (v === null || v === undefined) return '';
  if (type === 'money' && typeof v === 'number') return v.toLocaleString('en-US');
  return String(v);
}

/** What was typed, as the value to save, or an error that says how to fix it. */
export function readInline(type: InlineType, raw: string, opts?: { allowBlank?: boolean }): { value: InlineValue; error?: string } {
  const t = raw.trim();
  switch (type) {
    case 'money': {
      const r = parseDollars(t);
      return r.error ? { value: null, error: r.error } : { value: r.value };
    }
    case 'number': {
      if (!t) return { value: null };
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? { value: n } : { value: null, error: 'Enter a number' };
    }
    case 'phone': {
      if (!t) return opts?.allowBlank ? { value: null } : { value: null, error: 'A phone number can’t be blank. Esc keeps the old one' };
      const digits = t.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return { value: null, error: 'Enter a full phone number, area code first' };
      return { value: t };
    }
    case 'email': {
      if (!t) return opts?.allowBlank ? { value: null } : { value: null, error: 'An email can’t be blank. Esc keeps the old one' };
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? { value: t.toLowerCase() } : { value: null, error: 'That isn’t an email address' };
    }
    case 'date':
      if (!t) return { value: null };
      return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t + 'T12:00:00')) ? { value: t } : { value: null, error: 'Pick a date' };
    default:
      return { value: t || null };
  }
}

function shown(type: InlineType, v: InlineValue, options?: InlineOption[]): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return typeof v === 'number' ? formatDollars(v) : String(v);
  if (type === 'number' && typeof v === 'number') return v.toLocaleString('en-US');
  if (type === 'select') return options?.find((o) => o.value === v)?.label ?? String(v);
  if (type === 'date') {
    const d = new Date(String(v) + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return String(v);
}

export function InlineField({
  recordId, field, label, type, value, onSave, options, readOnly, placeholder = 'Add', showLabel = false, allowBlank = false,
  format, width,
}: {
  recordId: string;
  field: string;
  /** Visible when showLabel, and always the accessible name. */
  label: string;
  type: InlineType;
  /** The stored value: a number for money/number, 'YYYY-MM-DD' for a date. */
  value: InlineValue;
  onSave: InlineSave;
  options?: InlineOption[];
  /** Why this user can't edit it ("Only admins can change the owner"); falsy means editable. */
  readOnly?: string | false | null;
  placeholder?: string;
  showLabel?: boolean;
  /** Lets a phone or email be cleared. Off by default so a slip never erases one. */
  allowBlank?: boolean;
  /** Overrides the read-mode text. */
  format?: (v: InlineValue) => string;
  width?: number | string;
}) {
  const key = `${recordId}:${field}`;
  const [draft, setDraftState] = useState<string | null>(() => drafts.get(key) ?? null);
  const [optimistic, setOptimistic] = useState<{ v: InlineValue; base: InlineValue } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const setInput = (el: { focus: () => void } | null) => { inputRef.current = el; };
  const id = useId();

  const setDraft = (d: string | null) => {
    if (d === null) drafts.delete(key); else drafts.set(key, d);
    setDraftState(d);
  };
  // A different record in the same slot picks up its own draft, not this one's.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setDraftState(drafts.get(key) ?? null);
    setOptimistic(null);
    setError(null);
  }
  // The saved value arrived from the parent: the optimistic copy has done its job.
  const current = optimistic && optimistic.base === value ? optimistic.v : value;
  if (optimistic && optimistic.base !== value) setOptimistic(null);

  useEffect(() => {
    if (draft !== null) inputRef.current?.focus();
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = () => {
    if (readOnly || busy) return;
    cancelled.current = false;
    setError(null);
    setDraft(toDraft(type, current));
  };
  const cancel = () => {
    cancelled.current = true;
    setDraft(null);
    setError(null);
  };
  const commit = async (raw?: string) => {
    if (cancelled.current) { cancelled.current = false; return; }
    const text = raw ?? draft;
    if (text === null) return;
    const read = readInline(type, text, { allowBlank });
    if (read.error) { setError(read.error); return; }
    setDraft(null);
    if (read.value === (current ?? null) || (read.value === null && (current === '' || current === null))) { setError(null); return; }
    setOptimistic({ v: read.value, base: value });
    setError(null);
    setBusy(true);
    let r: { ok: boolean; message?: string };
    try { r = saveOutcome(await onSave(read.value)); } catch (e) { r = { ok: false, message: e instanceof Error ? e.message : 'The save didn’t go through' }; }
    setBusy(false);
    if (!r.ok) {
      setOptimistic(null);
      setError(r.message || 'The save didn’t go through. Try again');
    }
  };

  const text = format ? format(current) : shown(type, current, options);
  const errId = `${id}-err`;
  const labelEl = showLabel ? <span id={`${id}-l`} className="ds-inline-label">{label}</span> : null;

  if (readOnly) {
    return (
      <span className="ds-inline" data-readonly="" title={readOnly} style={width ? { width } : undefined}>
        {labelEl}
        <span className="ds-inline-text" aria-label={`${label}: ${text || 'empty'}`}>{text || <span className="ds-inline-empty">—</span>}</span>
      </span>
    );
  }

  const inputType = type === 'money' ? 'text' : type === 'phone' ? 'tel' : type === 'email' ? 'email' : type === 'date' ? 'date' : type === 'number' ? 'text' : 'text';
  const onKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key === 'Enter' && (type !== 'textarea' || e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); }
  };
  const common = {
    id: `${id}-in`,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errId : undefined,
    disabled: busy,
    onKeyDown: onKey,
    onBlur: () => void commit(),
  } as const;

  return (
    <span className="ds-inline" data-editing={draft !== null ? '' : undefined} style={width ? { width } : undefined}>
      {labelEl}
      {draft === null ? (
        <button type="button" className="ds-inline-text" onClick={begin} aria-label={`${label}: ${text || 'empty'}. Edit`}
          aria-describedby={error ? errId : undefined} data-busy={busy ? '' : undefined}>
          {text || <span className="ds-inline-empty">{placeholder}</span>}
        </button>
      ) : type === 'select' ? (
        <select {...common} ref={setInput} className="ds-inline-input" value={draft}
          onChange={(e) => { setDraft(e.target.value); void commit(e.target.value); }}>
          {!options?.some((o) => o.value === draft) ? <option value={draft}>{draft || 'None'}</option> : null}
          {groupOptions(options ?? []).map(([g, opts]) => (g
            ? <optgroup key={g} label={g}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
            : opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
        </select>
      ) : type === 'textarea' ? (
        <textarea {...common} ref={setInput} className="ds-inline-input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <input {...common} ref={setInput} className="ds-inline-input" type={inputType} value={draft}
          inputMode={type === 'money' || type === 'number' ? 'decimal' : undefined}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }} />
      )}
      {error ? <span id={errId} role="alert" className="ds-inline-error">{error}</span> : null}
    </span>
  );
}

function groupOptions(options: InlineOption[]): [string, InlineOption[]][] {
  const out: [string, InlineOption[]][] = [];
  for (const o of options) {
    const g = o.group ?? '';
    const last = out[out.length - 1];
    if (last && last[0] === g) last[1].push(o); else out.push([g, [o]]);
  }
  return out;
}
