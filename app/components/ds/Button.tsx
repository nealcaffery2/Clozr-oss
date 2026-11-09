// Buttons (app/DESIGN.md §7). The class-based twin of genius/parts `btn()`,
// so hover, press, focus and disabled come from ds.css instead of being
// re-typed in every inline style.
//
//   kind     primary  the one CLOZR-green action a view has
//            solid    ink: a confirming row action ("Add to buyers")
//            ghost    white with the ring shadow: everything else
//            danger   red: deletes and other actions that cannot be undone
//   size     32 (default) or 28
//
// Disabled is 50% opacity with no hover. Loading keeps the label and adds
// aria-busy; pass the label that says what is happening ("Saving…").
// On touch screens every button is at least 44px tall (--hit-min).
'use client';

import React from 'react';

export type ButtonKind = 'primary' | 'solid' | 'ghost' | 'danger';
export type ButtonSize = 32 | 28;

type BaseProps = {
  kind?: ButtonKind;
  size?: ButtonSize;
  /** An icon before the label (aria-hidden SVG, 13–14px). */
  icon?: React.ReactNode;
  /** An icon after the label: a chevron for a control that opens something. */
  iconRight?: React.ReactNode;
  busy?: boolean;
};

export function buttonClass(kind: ButtonKind = 'ghost', size: ButtonSize = 32, extra?: string) {
  return 'ds-btn ds-btn--' + kind + (size === 28 ? ' ds-btn--sm' : '') + (extra ? ' ' + extra : '');
}

export const Button = React.forwardRef<HTMLButtonElement, BaseProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { kind = 'ghost', size = 32, icon, iconRight, busy, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(kind, size, className)} aria-busy={busy || undefined} {...rest}>
      {icon}
      {children}
      {iconRight}
    </button>
  );
});

/** A link that looks like a button (same kinds and sizes). */
export function ButtonLink({ kind = 'ghost', size = 32, icon, iconRight, className, children, ...rest }: BaseProps & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass(kind, size, className)} {...rest}>
      {icon}
      {children}
      {iconRight}
    </a>
  );
}

/**
 * An icon-only button. `label` is required: it becomes the aria-label and the
 * tooltip. The box is `size` square (24, 28 or 32) and never under --hit-min,
 * so it is 44px on touch screens.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, {
  label: string;
  icon: React.ReactNode;
  size?: 24 | 28 | 32;
  /** ghost draws the ring; plain is bare until hovered (toolbars, rows). */
  kind?: 'ghost' | 'plain';
  pressed?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>>(function IconButton(
  { label, icon, size = 28, kind = 'plain', pressed, className, title, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={title ?? label} aria-pressed={pressed}
      className={'ds-icon-btn ds-icon-btn--' + kind + ' ds-icon-btn--' + size + (className ? ' ' + className : '')} {...rest}>
      {icon}
    </button>
  );
});
