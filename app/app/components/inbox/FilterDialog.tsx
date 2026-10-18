'use client';

// Filter threads (SmarterContact's Filter contacts modal): include or exclude
// labels, when they last responded, their area code, a Talkr tag (campaigns
// tag the contacts they reach), the rep, the channel. Reset, Save filter
// (named, it lands in the rail), Apply. A native dialog: Escape closes it,
// focus stays inside, the page behind is inert.

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { EMPTY_FILTER, type InboxFilter, filterCount } from '@/lib/inbox-folders';

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className="ax-fchip" aria-pressed={on} onClick={onClick}>{children}</button>;
}

export function FilterDialog({ value, labels, tags, owners, onApply, onSave, onClose }: {
  value: InboxFilter;
  /** Every label the list carries right now: dispositions, stages, heat words. */
  labels: string[];
  tags: string[];
  owners: string[];
  onApply: (f: InboxFilter) => void;
  onSave: (name: string, f: InboxFilter) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState<InboxFilter>(value);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', cancel);
    return () => d.removeEventListener('cancel', cancel);
  }, [onClose]);
  const set = (p: Partial<InboxFilter>) => setF((x) => ({ ...x, ...p }));
  const flip = (key: 'include' | 'exclude', l: string) => set({ [key]: f[key].includes(l) ? f[key].filter((x) => x !== l) : [...f[key], l] } as Partial<InboxFilter>);
  const n = filterCount(f);
  return (
    <dialog ref={ref} className="ax-dialog" aria-labelledby="ax-filter-title" onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <form method="dialog" className="ax-dialog-in" onSubmit={(e) => { e.preventDefault(); onApply(f); }}>
        <header className="ax-dialog-head">
          <h2 id="ax-filter-title">Filter threads</h2>
          <button type="button" className="ax-icon-btn" aria-label="Close" onClick={onClose}><X size={16} strokeWidth={2.25} aria-hidden /></button>
        </header>
        <div className="ax-dialog-body">
          <fieldset className="ax-fset">
            <legend>
              Include threads with
              <select value={f.includeMode} onChange={(e) => set({ includeMode: e.target.value as 'any' | 'all' })} aria-label="Any or all of the included labels" className="ax-fsel">
                <option value="any">any</option>
                <option value="all">all</option>
              </select>
              of these labels
            </legend>
            <div className="ax-fchips">
              {labels.map((l) => <Toggle key={l} on={f.include.includes(l)} onClick={() => flip('include', l)}>{l}</Toggle>)}
              {labels.length === 0 ? <span className="ax-fnone">No labels on this inbox yet</span> : null}
            </div>
          </fieldset>
          <fieldset className="ax-fset">
            <legend>Exclude threads with any of these labels</legend>
            <div className="ax-fchips">
              {labels.map((l) => <Toggle key={l} on={f.exclude.includes(l)} onClick={() => flip('exclude', l)}>{l}</Toggle>)}
            </div>
          </fieldset>
          <fieldset className="ax-fset">
            <legend>Last response from them</legend>
            <div className="ax-frow">
              <label className="ax-flabel">From<input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
              <label className="ax-flabel">To<input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
            </div>
          </fieldset>
          <div className="ax-frow">
            <label className="ax-flabel">Area code<input inputMode="numeric" maxLength={3} placeholder="210" value={f.areaCode} onChange={(e) => set({ areaCode: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></label>
            <label className="ax-flabel">Campaign tag
              <select value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
                <option value="">Any</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="ax-flabel">Assigned rep
              <select value={f.owner} onChange={(e) => set({ owner: e.target.value })}>
                <option value="">Any</option>
                {owners.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="ax-fset">
            <legend>Channel</legend>
            <div className="ax-fchips">
              {([['', 'Any'], ['sms', 'Text'], ['email', 'Email'], ['call', 'Call']] as const).map(([v, l]) => (
                <Toggle key={v} on={f.channel === v} onClick={() => set({ channel: v })}>{l}</Toggle>
              ))}
            </div>
          </fieldset>
        </div>
        <footer className="ax-dialog-foot">
          <button type="button" className="ax-tool" onClick={() => setF(EMPTY_FILTER)} disabled={n === 0}>Reset</button>
          <span className="ax-dialog-grow" role="status">{n ? `${n} filter${n === 1 ? '' : 's'} set` : 'Nothing set'}</span>
          {naming ? (
            <span className="ax-fsave">
              <label className="ax-flabel">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot, no reply" /></label>
              <button type="button" className="ax-tool" onClick={() => setNaming(false)}>Cancel</button>
              <button type="button" className="ax-tool ax-tool-dark" disabled={!name.trim() || n === 0} onClick={() => { onSave(name.trim(), f); onClose(); }}>Save</button>
            </span>
          ) : (
            <button type="button" className="ax-tool" disabled={n === 0} onClick={() => setNaming(true)}>Save filter</button>
          )}
          <button type="submit" className="ax-tool ax-tool-accent">Apply</button>
        </footer>
      </form>
    </dialog>
  );
}
