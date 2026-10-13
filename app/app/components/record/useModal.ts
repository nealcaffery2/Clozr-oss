'use client';

// The record's sheets behave like one: focus moves in, Tab stays inside,
// Escape closes, and focus goes back to whatever opened it. Closing plays a
// short exit before unmounting (none under reduced motion).

import { useCallback, useEffect, useRef, useState } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Mount/unmount with an exit: `closing` is true for the exit's length before `open` goes false. */
export function useExit(onClosed: () => void, ms: number) {
  const [closing, setClosing] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = useCallback(() => {
    if (reducedMotion()) { onClosed(); return; }
    setClosing(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { setClosing(false); onClosed(); }, ms);
  }, [onClosed, ms]);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return { closing, close };
}

/**
 * Trap focus inside `ref` while mounted. `onEscape` runs on Escape (the event
 * stops there, so a sheet closes before anything behind it). On unmount focus
 * returns to the element that had it when the sheet opened.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onEscape: () => void, initial?: string) {
  const esc = useRef(onEscape);
  useEffect(() => { esc.current = onEscape; }, [onEscape]);
  useEffect(() => {
    const opener = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    const root = ref.current;
    if (root) {
      const first = (initial ? root.querySelector<HTMLElement>(initial) : null) ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root;
      first.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); esc.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!el.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  // Mount/unmount only: the opener is whoever had focus when the sheet appeared.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
