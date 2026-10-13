// The shell's motion, per DESIGN.md §6. Three jobs, nothing decorative:
//
//  - Press: every compact button answers a pointer press with scale(.97) in
//    140ms, so a click is felt before the network answers. One delegated
//    listener rather than a class on hundreds of inline-styled buttons.
//  - Screen change: the screen that just arrived settles in over 180ms
//    (opacity and a 4px rise), which reads as "this replaced that" instead of
//    a hard cut. It runs after the screen has actually rendered, never while
//    its chunk is still loading.
//  - The side menu's selected pill glides to the new section (sidenav.css),
//    so the eye follows where it went.
//
// Only transform and opacity animate. Keyboard actions do not animate, and
// prefers-reduced-motion turns all of it off (state never depends on motion).
'use client';

import { useEffect, useLayoutEffect, type RefObject } from 'react';

export const EASE_OUT = 'cubic-bezier(.23, 1, .32, 1)';

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Controls that already carry their own :active scale in CSS. Pressing them
 * again here would compound to .94.
 */
const OWN_PRESS = '.cz-side, [data-gx], [data-cr], .talkr-dialer .num-press, .cz-tray, .cz-btn, .cz-icon-btn, .cz-menu-trigger, .today-press, .lm-btn, .rec-press, .mk-press, .gm-btn, [class*="cz-fp-"], [data-no-press]';

/** Rows, cards and full-width bars stay still: a 700px row shrinking 3% reads as a jolt, not a press. */
const MAX_W = 280;
const MAX_H = 64;

/** Install the shared press feedback for buttons inside `root`. */
export function usePressFeedback(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const host = root.current;
    if (!host || typeof host.animate !== 'function') return;
    let held: { el: HTMLElement; anim: Animation } | null = null;

    const release = () => {
      if (!held) return;
      const { el, anim } = held;
      held = null;
      anim.cancel();
      el.animate([{ scale: '.97' }, { scale: '1' }], { duration: 140, easing: EASE_OUT });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || reducedMotion()) return;
      const el = (e.target as Element | null)?.closest?.('button, [role="button"], a.cz-press') as HTMLElement | null;
      if (!el || !host.contains(el)) return;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
      if (el.closest(OWN_PRESS)) return;
      const r = el.getBoundingClientRect();
      if (r.width > MAX_W || r.height > MAX_H) return;
      release();
      // `scale` composes with any inline transform the button already has.
      const anim = el.animate([{ scale: '1' }, { scale: '.97' }], { duration: 140, easing: EASE_OUT, fill: 'forwards' });
      held = { el, anim };
    };

    host.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('blur', release);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      held?.anim.cancel();
    };
  }, [root]);
}

let lastScreen: string | null = null;

/**
 * Rendered inside the screen's Suspense boundary, so its layout effect fires
 * only once the new screen has committed (not when its skeleton shows).
 * Settles the screen in whenever the screen key changes.
 */
export function ScreenEnter({ screen, host }: { screen: string; host: RefObject<HTMLElement | null> }) {
  useLayoutEffect(() => {
    const first = lastScreen === null;
    lastScreen = screen;
    // The first paint of a session is the page load, not a navigation.
    if (first || reducedMotion()) return;
    const el = host.current?.firstElementChild as HTMLElement | null;
    if (!el || typeof el.animate !== 'function') return;
    el.animate(
      [{ opacity: 0.4, translate: '0 4px' }, { opacity: 1, translate: '0 0' }],
      { duration: 180, easing: EASE_OUT },
    );
  }, [screen, host]);
  return null;
}

/**
 * Glide `pill` to sit under the selected item in `root`. Measured after
 * layout; the first placement and every reduced-motion placement jump.
 */
export function placePill(root: HTMLElement, pill: HTMLElement, selected: HTMLElement | null) {
  if (!selected) {
    pill.style.opacity = '0';
    delete root.dataset.pill;
    return;
  }
  const r = root.getBoundingClientRect();
  const s = selected.getBoundingClientRect();
  const x = s.left - r.left + root.scrollLeft;
  const y = s.top - r.top + root.scrollTop;
  const shown = pill.style.opacity === '1';
  pill.style.transition = shown && !reducedMotion() ? `transform 220ms ${EASE_OUT}` : 'none';
  pill.style.width = `${s.width}px`;
  pill.style.height = `${s.height}px`;
  pill.style.transform = `translate(${x}px, ${y}px)`;
  pill.style.opacity = '1';
  // The selected link drops its own fill once the pill is under it.
  root.dataset.pill = 'on';
}
