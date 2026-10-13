'use client';

/**
 * A note textarea that knows teammates: "@" opens a picker (type to filter,
 * arrows + Enter or a click), which writes an `@[Name](id)` token
 * (lib/mentions.ts). `inputRef` hands the textarea out, for an emoji button
 * that inserts at its caret.
 * Plus `MentionText`, which renders a stored body with the tokens as chips.
 */

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { insertMention, mentionQuery, mentionSegments } from '@/lib/mentions';

export type Mentionable = { id: string; name: string };

type Open = { start: number; caret: number; query: string; x: number; y: number; above: boolean };

export function MentionField({ value, onChange, team, inputRef, above = true, ...rest }: {
  value: string;
  onChange: (next: string) => void;
  team: Mentionable[];
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Open the picker above the field (a composer at the bottom) or below it. */
  above?: boolean;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [hi, setHi] = useState(0);

  const hits = open
    ? team.filter((t) => t.name.toLowerCase().includes(open.query.toLowerCase())).slice(0, 8)
    : [];

  const track = (el: HTMLTextAreaElement) => {
    const q = mentionQuery(el.value, el.selectionStart);
    if (!q) return setOpen(null);
    const r = el.getBoundingClientRect();
    if (!open || open.start !== q.start) setHi(0);
    setOpen({ ...q, caret: el.selectionStart, x: r.left, y: above ? r.top : r.bottom, above });
  };

  const pick = (m: Mentionable) => {
    if (!open) return;
    const next = insertMention(value, open.start, open.caret, m.name, m.id);
    onChange(next.text);
    setOpen(null);
    const el = ref.current;
    if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); });
  };

  const field = (
    <textarea
      {...rest}
      ref={(el) => { ref.current = el; if (inputRef) inputRef.current = el; }}
      value={value}
      onChange={(e) => { onChange(e.target.value); track(e.target); }}
      onClick={(e) => track(e.currentTarget)}
      onBlur={(e) => { setTimeout(() => setOpen(null), 120); rest.onBlur?.(e); }}
      onKeyDown={(e) => {
        if (open && hits.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault(); e.stopPropagation();
            pick(hits[Math.min(hi, hits.length - 1)]);
            return;
          }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(null); return; }
        }
        rest.onKeyDown?.(e);
      }}
    />
  );

  return (
    <>
      {field}
      {open && hits.length > 0 ? createPortal(
        <div role="listbox" aria-label="Mention a teammate" style={{
          position: 'fixed', left: open.x, zIndex: 90, minWidth: 220, maxWidth: 300, padding: 4,
          ...(open.above ? { bottom: `calc(100vh - ${open.y - 4}px)` } : { top: open.y + 4 }),
          background: '#fff', border: '1px solid #e4e4e7', borderRadius: 10,
          boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)',
        }}>
          {hits.map((m, i) => (
            <button key={m.id} type="button" role="option" aria-selected={i === hi}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(m)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', border: 0, borderRadius: 7, cursor: 'pointer', fontSize: 12.5, background: i === hi ? '#E7F8F1' : 'none', color: i === hi ? '#0A8560' : '#27272a' }}>
              <span style={{ width: 20, height: 20, borderRadius: 6, border: '1px solid #e4e4e7', background: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, color: '#52525b' }}>
                {m.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              {m.name}
            </button>
          ))}
        </div>,
        // A portal: a dialog's overflow (and its backdrop-filter) would clip a fixed popover.
        document.body,
      ) : null}
    </>
  );
}

/** A stored note body, with each mention as a highlighted chip. */
export function MentionText({ text }: { text: string }) {
  return (
    <>
      {mentionSegments(text).map((s, i) => ('id' in s ? (
        <span key={i} title={s.name} style={{ padding: '0 4px', borderRadius: 5, background: '#E7F8F1', color: '#0A8560', fontWeight: 600 }}>@{s.name}</span>
      ) : <React.Fragment key={i}>{s.text}</React.Fragment>))}
    </>
  );
}
