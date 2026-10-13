// What a screen shows when there is nothing on it.
//
// A CRM with no records is the normal first hour of using one, not an error —
// so these say what will fill the screen rather than apologising. The one thing
// they must never do is look the same as a failed load, which is why `failed`
// is a separate, louder state: "you have no leads" and "we could not reach the
// database" are opposite facts that otherwise render identically.

import React from 'react';

const MINT = '#0A8560';

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
      <div style={{ padding: compact ? '20px 16px' : '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#b91c1c' }}>
          Couldn&rsquo;t load your workspace
        </div>
        <div style={{ margin: '5px auto 0', maxWidth: '380px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.55 }}>
          This is a connection problem, not an empty CRM — your records are still there.
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginTop: '14px', height: '32px', padding: '0 14px', borderRadius: '9px',
              border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px',
              fontWeight: 600, color: '#18181b', cursor: 'pointer',
            }}
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ padding: compact ? '22px 16px' : '44px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#3f3f46' }}>{title}</div>
      {hint ? (
        <div style={{ margin: '5px auto 0', maxWidth: '400px', fontSize: '12.5px', color: '#a1a1aa', lineHeight: 1.55 }}>
          {hint}
        </div>
      ) : null}
      {action && actionLabel ? (
        <button
          type="button"
          onClick={action}
          style={{
            marginTop: '14px', height: '32px', padding: '0 14px', borderRadius: '9px',
            border: `1px solid ${MINT}`, background: MINT, color: '#fff',
            fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
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
