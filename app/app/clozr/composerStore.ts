'use client';

// The shared composer's text, outside the workspace state.
//
// Every composer in the app (the seller record's Text · Email · Note box, the
// buyer record's text line, the TC note, Talkr and the Inbox) writes the same
// string. As a field on ClozrState each keystroke was a set() on the whole
// state and so a rebuild of the view model; the seller Composer debounced it,
// the buyer and TC inputs did not and lagged by the width of a V rebuild per
// character. Here the inputs subscribe to the string alone, and the view
// model reads it when a send asks for it.

import { useSyncExternalStore } from 'react';

let text = '';
const listeners = new Set<() => void>();

export function getComposerText(): string { return text; }

export function setComposerText(next: string) {
  if (next === text) return;
  text = next;
  for (const l of listeners) l();
}

/** Empty the box if it still holds `body`, the text a send or save has just taken. */
export function clearComposerIf(body: string) {
  if (text.trim() === body.trim()) setComposerText('');
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
function getServer(): string { return ''; }

/** What the composer holds; re-renders the caller on every keystroke, so only the input should use it. */
export function useComposerText(): string {
  return useSyncExternalStore(subscribe, getComposerText, getServer);
}
