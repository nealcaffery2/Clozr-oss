// The one Back link on every record and sub-screen.
//
// Where it goes is decided by useClozr's `backFor(fallback)` (lib/nav-hash
// `backAction`): the address carries `from=<screen>[:id]`, so when the entry
// before this one in the tab's history is that place it steps back with
// history.back() (browser Back and this link then agree, no loop); otherwise
// it replaces this entry with `from`, or with the screen's own fallback.
//
//   <BackLink to={V.backFor('people')} />
'use client';

import React from 'react';

export type BackTarget = {
  /** What the link says after "Back to": a screen ("Deals") or a record ("Jane Smith"). */
  label: string;
  go: () => void;
};

export function BackLink({ to, style }: { to: BackTarget; style?: React.CSSProperties }) {
  return (
    <button type="button" className="ds-back" onClick={to.go} aria-label={`Back to ${to.label}`} title={`Back to ${to.label}`} style={style}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      <span className="ds-back-label">{to.label}</span>
    </button>
  );
}
