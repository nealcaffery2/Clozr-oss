// The side drawer (app/DESIGN.md §4, §5): Notifications, Ask CLOZR and Lane.
// One shape for all three: 400px on the right edge of a desk, the full width
// between the top bar and the tabs on a phone, with a scrim behind it there.
// It sits on --z-drawer (a `layer` lifts a drawer that opens over another)
// and draws with the md shadow and a divider on its open edge.
//
//   <Drawer label="Notifications" mobile={V.isMobile} onClose={close}
//     title="Notifications" meta="3 unread" actions={<Button …/>}>
//     …the list…
//   </Drawer>
'use client';

import React from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ds/Button';

export function Drawer({ label, mobile, onClose, closeLabel = 'Close', layer = 0, title, icon, meta, actions, children, 'data-screen-label': screenLabel, className, style }: {
  /** The dialog's accessible name. */
  label: string;
  /** Phone layout: full width between the bars, with a scrim. */
  mobile?: boolean;
  onClose: () => void;
  closeLabel?: string;
  /** 0 for the base drawer; 1 for one that opens over it (Ask, Lane). */
  layer?: 0 | 1;
  /** The head row: an icon or mark, the title, a muted meta line, then actions and Close. */
  title?: React.ReactNode;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  'data-screen-label'?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const z = layer ? 'calc(var(--z-drawer) + 1)' : 'var(--z-drawer)';
  return (
    <>
      {mobile ? <div className="ds-drawer-scrim" aria-hidden onClick={onClose} style={{ zIndex: `calc(${z} - 1)` }} /> : null}
      <aside role="dialog" aria-label={label} data-screen-label={screenLabel ?? label}
        className={'ds-drawer' + (mobile ? ' ds-drawer--phone' : '') + (className ? ' ' + className : '')} style={{ zIndex: z, ...style }}>
        {title != null ? (
          <div className="ds-drawer__head">
            {icon}
            <span className="ds-drawer__title">{title}</span>
            {meta != null && meta !== false ? <span className="ds-drawer__meta">{meta}</span> : null}
            <span className="ds-drawer__actions">
              {actions}
              <IconButton kind="ghost" size={28} label={closeLabel} onClick={onClose} icon={<X size={14} aria-hidden />} />
            </span>
          </div>
        ) : null}
        {children}
      </aside>
    </>
  );
}
