'use client';

// The notice a composer shows when a merge field would go out blank:
// "Beds, Baths and Sq ft are empty on 123 Oak St", a link to the place that
// holds them, and a box per property fact that saves straight to it. Used by
// the record's email composer and the dispo blast builders. Copy and field
// sources come from lib/merge-gaps.

import React, { useId, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { MERGE_SOURCES, gapNotice, labelOf } from '@/lib/merge-gaps';

type SaveResult = { ok: true } | { ok: false; message?: string };

export function MergeGapNotice({
  blank, where, openLabel = 'Open property facts', onOpen, onSave, onUse, extra, next, testId = 'merge-gaps',
}: {
  /** Field names that would render blank, e.g. ['beds', 'sqft']. */
  blank: string[];
  /** The house or record they are missing on. */
  where: string;
  openLabel?: string;
  /** Goes to where the fields are edited. */
  onOpen?: () => void;
  /** Saves one property fact ('property.beds' …) on the record. */
  onSave?: (field: string, name: string, value: string) => Promise<SaveResult>;
  /** Fills a field for this send only (no record has a place for it, or the rep would rather not save). */
  onUse?: (name: string, value: string) => void;
  /** A second line under the sentence (a bulk send's count). */
  extra?: React.ReactNode;
  /** What to do, when filling in here is not it (no deal attached yet). */
  next?: string;
  testId?: string;
}) {
  if (!blank.length) return null;
  const fixable = blank.filter((b) => (onSave && MERGE_SOURCES[b]?.field) || onUse);
  return (
    <div role="status" className="mgap" data-testid={testId}>
      <style>{CSS}</style>
      <div className="mgap-head">
        <TriangleAlert size={14} aria-hidden className="mgap-icon" />
        <div style={{ minWidth: 0 }}>
          <p className="mgap-text">{gapNotice(blank, where)} {next ?? `${blank.length === 1 ? 'It goes' : 'They go'} out blank unless you fill ${blank.length === 1 ? 'it' : 'them'} in.`}</p>
          {extra ? <p className="mgap-extra">{extra}</p> : null}
        </div>
      </div>
      {fixable.length ? (
        <div className="mgap-fills">
          {fixable.map((b) => <GapFill key={b} name={b} onSave={onSave && MERGE_SOURCES[b]?.field ? (v) => onSave(MERGE_SOURCES[b].field!, b, v) : undefined} onUse={onUse ? (v) => onUse(b, v) : undefined} />)}
        </div>
      ) : null}
      {onOpen ? <button type="button" className="mgap-link" onClick={onOpen}>{openLabel}</button> : null}
    </div>
  );
}

function GapFill({ name, onSave, onUse }: { name: string; onSave?: (v: string) => Promise<SaveResult>; onUse?: (v: string) => void }) {
  const id = useId();
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = labelOf(name);
  const submit = async () => {
    const value = v.trim();
    if (!value) return;
    setErr(null);
    if (!onSave) { onUse?.(value); setV(''); return; }
    setBusy(true);
    const r = await onSave(value);
    setBusy(false);
    if (!r.ok) { setErr(r.message || 'That did not save.'); return; }
    onUse?.(value);
    setV('');
  };
  return (
    <form className="mgap-fill" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor={id} className="mgap-label">{label}</label>
      <div className="mgap-row">
        <input id={id} className="mgap-input" value={v} inputMode={name === 'property_type' ? 'text' : 'decimal'} autoComplete="off"
          aria-invalid={!!err} aria-describedby={err ? id + '-err' : undefined} onChange={(e) => setV(e.target.value)} />
        <button type="submit" className="mgap-save" disabled={!v.trim() || busy}>{busy ? 'Saving…' : onSave ? 'Save' : 'Use'}</button>
      </div>
      {err ? <span id={id + '-err'} role="alert" className="mgap-err">{err}</span> : null}
    </form>
  );
}

const CSS = `
.mgap { display: grid; gap: 8px; padding: 10px 12px; margin: 8px 0 0; border: 1px solid var(--warn-line, #f1d58a); border-radius: 10px; background: var(--warn-bg, #fff6df); color: var(--warn-ink, #8a3f0a); min-width: 0; }
.mgap-head { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
.mgap-icon { flex: none; margin-top: 2px; color: var(--tx-amber, #b45309); }
.mgap-text { margin: 0; font-size: 12.5px; line-height: 1.45; font-weight: 500; overflow-wrap: anywhere; text-wrap: pretty; }
.mgap-extra { margin: 2px 0 0; font-size: 12px; line-height: 1.45; font-variant-numeric: tabular-nums; text-wrap: pretty; }
.mgap-fills { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; }
.mgap-fill { display: grid; gap: 4px; min-width: 0; margin: 0; }
.mgap-label { font-size: 11.5px; font-weight: 500; color: var(--ink-2, #3f3f46); }
.mgap-row { display: flex; gap: 4px; min-width: 0; }
.mgap-input { flex: 1; width: 0; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--line, #e4e4e7); border-radius: 8px; background: var(--surface, #fff); color: var(--ink, #18181b); font: 500 13px/1 inherit; font-variant-numeric: tabular-nums; }
.mgap-input:focus-visible, .mgap-save:focus-visible, .mgap-link:focus-visible { outline: 2px solid var(--accent, #0A8560); outline-offset: 1px; }
.mgap-save { flex: none; height: 28px; min-width: 44px; padding: 0 10px; border: 1px solid var(--line, #e4e4e7); border-radius: 8px; background: var(--surface, #fff); color: var(--ink, #18181b); font: 600 12px/1 inherit; cursor: pointer; }
.mgap-save:disabled { color: var(--muted, #71717a); cursor: default; }
.mgap-err { font-size: 11.5px; color: var(--tx-red, #b91c1c); }
/* The amber ink, not the accent: green on the warning tint is 4.3:1. */
.mgap-link { justify-self: start; min-height: 24px; padding: 0; border: 0; background: none; color: var(--warn-ink, #8a3f0a); font: 600 12.5px/1.4 inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
@media (max-width: 640px) { .mgap-input { font-size: 16px; height: 32px; } .mgap-save { height: 32px; } }
`;
