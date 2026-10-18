// The checkbox square on a multi-pick filter menu row (lib/multi-filter): a
// row with a box can be one of several picks; a row with a ✓ is the only one.
import React from 'react';

export function PickBox({ on }: { on: boolean }) {
  return (
    <span aria-hidden style={{
      width: 15, height: 15, flex: 'none', borderRadius: 4, display: 'inline-grid', placeItems: 'center', boxSizing: 'border-box',
      border: `1.5px solid ${on ? '#0A8560' : '#c4c4cc'}`, background: on ? '#0A8560' : '#fff',
    }}>
      {on ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--on-dark, #fff)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : null}
    </span>
  );
}

/** A menu row's content: the box and the label for a multi menu (except its "Any" row), the label alone otherwise. */
export function PickLabel({ multi, on, label }: { multi?: boolean; on: boolean; label: string }) {
  if (!multi || label === 'Any') return <>{label}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <PickBox on={on} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </span>
  );
}
