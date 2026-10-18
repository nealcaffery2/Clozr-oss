'use client';

// One small popover menu for the Inbox: the label dropdown on a thread row,
// Assign and Sequence in the bulk bar, the assignee chip on a thread. A
// trigger button and a list under it; Escape, a click outside or a pick
// closes it, arrows move between the items.

import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

export type MenuItem = {
  label: string;
  run: () => void;
  /** A checkmark: the item is already on. */
  on?: boolean;
  disabled?: boolean;
  hint?: string;
  /** A swatch before the label (a label chip's colour). */
  swatch?: string;
};

export function Menu({ label, title, items, heading, empty = 'Nothing to pick from yet', align = 'start', className = '', chip = false, children }: {
  /** The trigger's content. */
  label: ReactNode;
  /** A tooltip and the accessible name when `label` is an icon alone. */
  title?: string;
  items: MenuItem[];
  heading?: string;
  empty?: string;
  align?: 'start' | 'end';
  className?: string;
  /** Draw the trigger as a label chip rather than a toolbar button. */
  chip?: boolean;
  /** Anything after the list (a text field, a note). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); (root.current?.querySelector('button') as HTMLElement | null)?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]:not([disabled])') ?? [])];
        if (!list.length) return;
        e.preventDefault();
        const at = list.indexOf(document.activeElement as HTMLElement);
        list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]:not([disabled])')?.focus();
  }, [open]);
  return (
    <span ref={root} className={`ax-menu ${className}`} data-open={open || undefined}>
      <button type="button" className={chip ? 'ax-chip-btn' : 'ax-tool'} aria-haspopup="menu" aria-expanded={open} aria-controls={id} title={title} aria-label={typeof label === 'string' ? undefined : title}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        {label}
      </button>
      {open && (
        <div id={id} role="menu" className="ax-menu-pop" data-align={align} onClick={(e) => e.stopPropagation()}>
          {heading ? <p className="ax-menu-h">{heading}</p> : null}
          {items.length === 0 ? <p className="ax-menu-empty">{empty}</p> : items.map((it) => (
            <button key={it.label} type="button" role="menuitemcheckbox" className="ax-menu-item" disabled={it.disabled} aria-checked={!!it.on} title={it.hint}
              onClick={() => { it.run(); setOpen(false); }}>
              {it.swatch ? <span className="ax-menu-swatch" style={{ background: it.swatch }} aria-hidden /> : null}
              <span className="ax-menu-label">{it.label}</span>
              {it.on ? <Check size={13} strokeWidth={2.5} aria-hidden /> : null}
            </button>
          ))}
          {children}
        </div>
      )}
    </span>
  );
}
