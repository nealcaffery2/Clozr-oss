// Small text roles (app/DESIGN.md §3, §7): the section label and the badge.
// Both are sentence case with no letter-spacing: hierarchy comes from size,
// weight and colour, never from tracked-out capitals.
'use client';

import React from 'react';

/**
 * The label over a group of fields or a list section: 11.5px / 500 / muted.
 * Use `as="h2"` / `"h3"` when it heads a section, so the outline stays right.
 */
export function SectionLabel({ as: Tag = 'div', children, className, style, id }: {
  as?: 'div' | 'span' | 'h2' | 'h3' | 'label' | 'legend';
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
}) {
  return <Tag id={id} className={'ds-label' + (className ? ' ' + className : '')} style={style}>{children}</Tag>;
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

/**
 * A status chip: 11px / 600, radius 6, a tinted fill with matching dark text.
 * Always carries a word; colour never means something on its own. `color` and
 * `tint` override the tone for the few badges coloured by data (heat, buyer type).
 */
export function Badge({ tone = 'neutral', color, tint, title, children, className, style }: {
  tone?: BadgeTone;
  color?: string;
  tint?: string;
  title?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span title={title} className={'ds-badge ds-badge--' + tone + (className ? ' ' + className : '')}
      style={color || tint ? { ...(color ? { color } : null), ...(tint ? { background: tint } : null), ...style } : style}>
      {children}
    </span>
  );
}
