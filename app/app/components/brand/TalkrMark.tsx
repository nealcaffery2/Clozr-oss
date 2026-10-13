// The Talkr mark: the speech bubble with three voice bars (public/talkr/talkr-mark.svg).
// Inline SVG so it draws anywhere, with no stylesheet to load first. The bars
// are holes, so the mark sits on any background; `color` picks the brand tone:
// Talkr red #FF233B, charcoal #111111, grey #7A7A7A, or white on dark.
import React from 'react';
import { TALKR } from '@/app/clozr/brand';

const PATH =
  'M29 5h42a24 24 0 0 1 24 24v37a24 24 0 0 1-24 24H30L5 100V29A24 24 0 0 1 29 5Z' +
  'M50 22a6 6 0 0 0-6 6v44a6 6 0 0 0 12 0V28a6 6 0 0 0-6-6Z' +
  'M33 36a6 6 0 0 0-6 6v16a6 6 0 0 0 12 0V42a6 6 0 0 0-6-6Z' +
  'M67 36a6 6 0 0 0-6 6v16a6 6 0 0 0 12 0V42a6 6 0 0 0-6-6Z';

export function TalkrMark({ size = 16, color = TALKR, title }: { size?: number; color?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill={color} fillRule="evenodd" style={{ display: 'inline-block', flex: 'none', verticalAlign: 'middle' }}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={PATH} />
    </svg>
  );
}

/** The mark and the name side by side, for a label that would otherwise just say "Talkr". */
export function TalkrLabel({ size = 14, gap = 6, children = 'Talkr' }: { size?: number; gap?: number; children?: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap, whiteSpace: 'nowrap' }}><TalkrMark size={size} />{children}</span>;
}
