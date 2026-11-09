// A Quick Add text field. Address fields suggest addresses as you type, in
// CLOZR's own list: Google Places (New) with the workspace's key, else (no key,
// or Google refuses it) the same Google suggestions COMPR's search box uses
// (lib/places comprSuggest). Picking one fills street, city, state and ZIP.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { type PlaceParts, type Suggestion, comprPlace, comprSuggest, googlePlace, googleSuggest } from '@/lib/places';

type Field = {
  key: string; value: string; ph: string; addr?: boolean;
  set: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Given, the field keeps what is typed to itself and hands it over a beat after typing stops, on blur, and on flushAddInputs(). */
  setValue?: (v: string) => void;
};

// Quick Add's form lives in the CLOZR view's state, so handing it every
// keystroke redrew the whole app per letter. Buffered fields hand it over
// when typing pauses; anything that reads the form first (Enter, Save) calls
// flushAddInputs() so nothing typed is left behind.
const COMMIT_MS = 150;
const pending = new Set<() => void>();
export function flushAddInputs() {
  for (const commit of [...pending]) commit();
}

export function AddInput({ f, placesKey, onPlace, style }: {
  f: Field; placesKey: string | null | undefined; onPlace: (p: PlaceParts) => void; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const buffered = !!f.setValue;
  const [text, setText] = useState(f.value);
  const [shown, setShown] = useState(f.value);
  // What this field last handed over. That coming back is not news; any other
  // new value from outside (Clear, an address pick, a draft) replaces the box.
  const [sent, setSent] = useState(f.value);
  if (f.value !== shown) { setShown(f.value); if (f.value !== sent) setText(f.value); }
  const value = buffered ? text : f.value;
  const setValueRef = useRef(f.setValue);
  useEffect(() => { setValueRef.current = f.setValue; }, [f.setValue]);
  const timer = useRef<number | null>(null);
  const commitRef = useRef<(() => void) | null>(null);
  const hold = (v: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    const commit = () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
      pending.delete(commit);
      commitRef.current = null;
      setSent(v);
      setValueRef.current?.(v);
    };
    if (commitRef.current) pending.delete(commitRef.current);
    commitRef.current = commit;
    pending.add(commit);
    timer.current = window.setTimeout(commit, COMMIT_MS);
  };
  useEffect(() => () => { commitRef.current?.(); }, []);
  // The latest onPlace, kept in a ref so a pick always calls the current one.
  // Written from an effect, not during render.
  const onPlaceRef = useRef(onPlace);
  useEffect(() => { onPlaceRef.current = onPlace; }, [onPlace]);

  // ---- address suggestions in our own list ----
  // Google Places (New) with the workspace key; if Google refuses it (the key
  // lacks that API, or there is no key), COMPR's Google suggestions instead.
  const viaCompr = !!f.addr;
  const google = useRef<boolean>(!!placesKey);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const typed = useRef(false);
  useEffect(() => {
    if (!viaCompr || !typed.current) return;
    const q = value.trim();
    let live = true;
    const t = window.setTimeout(() => {
      if (q.length < 3) { setItems([]); return; }
      const ask = google.current && placesKey
        ? googleSuggest(placesKey, q).catch(() => { google.current = false; return comprSuggest(q); })
        : comprSuggest(q);
      void ask.then((r) => { if (live) { setItems(r); setHi(0); setOpen(r.length > 0); } }).catch(() => {});
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [viaCompr, value, placesKey]);
  const pick = (s: Suggestion) => {
    setOpen(false); setItems([]); typed.current = false;
    const get = google.current && placesKey ? googlePlace(placesKey, s.place_id).catch(() => comprPlace(s)) : comprPlace(s);
    void get.then((p) => { if (p) onPlaceRef.current(p); }).catch(() => {});
  };

  const input = (
    <input
      ref={ref}
      value={value}
      onChange={(e) => {
        typed.current = true;
        if (buffered) { setText(e.target.value); hold(e.target.value); } else f.set(e);
      }}
      onKeyDown={viaCompr && open ? (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
        else if (e.key === 'Enter' && items[hi]) { e.preventDefault(); pick(items[hi]); }
        else if (e.key === 'Escape') setOpen(false);
      } : undefined}
      onBlur={() => {
        commitRef.current?.();
        if (viaCompr) window.setTimeout(() => setOpen(false), 150);
      }}
      placeholder={f.addr ? 'Start typing an address…' : f.ph}
      autoComplete={f.addr ? 'off' : undefined}
      role={viaCompr ? 'combobox' : undefined}
      aria-expanded={viaCompr ? open : undefined}
      aria-controls={viaCompr ? `addr-list-${f.key}` : undefined}
      aria-autocomplete={viaCompr ? 'list' : undefined}
      style={style}
    />
  );
  if (!viaCompr) return input;
  return (
    <div style={{ position: 'relative' }}>
      {input}
      {open && items.length ? (
        <ul id={`addr-list-${f.key}`} role="listbox" style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, top: 'calc(100% + 4px)', margin: 0, padding: '4px', listStyle: 'none', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: '240px', overflow: 'auto' }}>
          {items.map((s, i) => (
            <li key={s.place_id} role="option" aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setHi(i)}
              style={{ padding: '7px 9px', borderRadius: '7px', cursor: 'pointer', background: i === hi ? 'var(--mint-dim, #e7f8f1)' : 'transparent', fontSize: '13px', color: 'var(--ink, #18181b)' }}>
              <span style={{ fontWeight: 600 }}>{s.main}</span>
              {s.secondary ? <span style={{ color: 'var(--meta, #71717a)', fontSize: '12px' }}> · {s.secondary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
