// A search box over a big list. The box shows each keystroke at once, and the
// list is filtered once typing pauses: with 11,000 records, filtering the
// whole CRM on every letter made typing lag a quarter second a key.
'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * `value` is the committed query (what the list filters on), `commit` sets it.
 * Returns the text to show in the box and its change handler. A change to
 * `value` from elsewhere (a list switch clearing it, the command bar filling
 * it) shows in the box straight away.
 */
export function useDebouncedText(value: string, commit: (v: string) => void, ms = 180) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  // Adjusting state during render is React's pattern for following a prop.
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const commitRef = useRef(commit);
  useEffect(() => { commitRef.current = commit; });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onChange = (next: string) => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    // Clearing the box is a deliberate act; show the whole list at once.
    if (!next) { commitRef.current(next); return; }
    timer.current = setTimeout(() => commitRef.current(next), ms);
  };
  return [text, onChange] as const;
}
