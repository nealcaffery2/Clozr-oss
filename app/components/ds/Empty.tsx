// What a screen shows when there is nothing on it.
//
// A CRM with no records is the normal first hour of using one, not an error —
// so these say what will fill the screen rather than apologising. The one thing
// they must never do is look the same as a failed load, which is why `failed`
// is a separate, louder state: "you have no leads" and "we could not reach the
// database" are opposite facts that otherwise render identically.
//
// EmptyState is the primitive (DESIGN.md §7: says what to do next, with one
// action). Empty is the older call shape and draws through it.

import React from 'react';
import { Button } from '@/components/ds/Button';

export function EmptyState({ title, hint, action, compact = false, icon, className, style }: {
  /** What will be here, in a sentence: "No buyers yet". */
  title: React.ReactNode;
  /** What fills it, or how. Muted, at most a couple of lines. */
  hint?: React.ReactNode;
  /** The one next step. A primary button; there is never a second. */
  action?: { label: string; onClick: () => void };
  compact?: boolean;
  /** An optional 20px line icon above the title. */
  icon?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={'ds-empty' + (compact ? ' ds-empty--compact' : '') + (className ? ' ' + className : '')} style={style}>
      {icon ? <div className="ds-empty__icon" aria-hidden="true">{icon}</div> : null}
      <div className="ds-empty__title">{title}</div>
      {hint ? <div className="ds-empty__hint">{hint}</div> : null}
      {action ? <Button kind="primary" onClick={action.onClick} className="ds-empty__action">{action.label}</Button> : null}
    </div>
  );
}

export function Empty({
  title, hint, action, actionLabel, failed = false, onRetry, compact = false,
}: {
  title: string;
  hint?: string;
  action?: () => void;
  actionLabel?: string;
  failed?: boolean;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (failed) {
    return (
      <div className={'ds-empty' + (compact ? ' ds-empty--compact' : '')} role="alert">
        <div className="ds-empty__title" style={{ color: 'var(--tx-red, #b91c1c)' }}>
          Couldn&rsquo;t load your workspace
        </div>
        <div className="ds-empty__hint">
          This is a connection problem, not an empty CRM — your records are still there.
        </div>
        {onRetry ? <Button kind="ghost" onClick={onRetry} className="ds-empty__action">Try again</Button> : null}
      </div>
    );
  }
  return <EmptyState title={title} hint={hint} compact={compact} action={action && actionLabel ? { label: actionLabel, onClick: action } : undefined} />;
}

/**
 * The same thing inside a table, so the column headers stay put and the message
 * sits under them instead of replacing the whole table.
 */
export function EmptyRow({ colSpan, ...rest }: { colSpan: number } & React.ComponentProps<typeof Empty>) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: 0 }}>
        <Empty {...rest} />
      </td>
    </tr>
  );
}
