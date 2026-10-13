// Long lists render a page of rows at a time and add the next page as the
// scroll nears the bottom. A workspace with 11,000 buyers put every row (and
// every cell in it) into the DOM at once, which froze or crashed the tab.
// The data is all still in memory, so search, filters, sort, select-all and
// keyboard walking see every row; only what is drawn is capped.
'use client';

import { useCallback, useState } from 'react';

export const REVEAL_PAGE = 100;

/** The nearest ancestor that scrolls, so the observer can look ahead inside it. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/**
 * How many of `total` rows to draw. Starts at one page, grows a page each time
 * the sentinel scrolls within reach, and goes back to one page when `resetKey`
 * changes (another list, search or sort). `focus` is a row the keyboard cursor
 * is on; the window always reaches it.
 */
export function useReveal(total: number, resetKey: string, focus = 0, page = REVEAL_PAGE) {
  const [state, setState] = useState({ key: resetKey, limit: page });
  // A new list starts over at the top. Adjusting state during render is
  // React's pattern for resetting on a prop change without an extra paint.
  let limit = state.key === resetKey ? state.limit : page;
  if (state.key !== resetKey) setState({ key: resetKey, limit: page });
  if (focus >= limit) {
    limit = Math.ceil((focus + 1) / page) * page;
    setState({ key: resetKey, limit });
  }
  const shown = Math.min(limit, total);
  const more = shown < total;

  const grow = useCallback(() => {
    setState((s) => (s.limit >= total ? s : { ...s, limit: s.limit + page }));
  }, [page, total]);

  // The sentinel is the row at the foot of the list. React 19 runs the
  // cleanup a callback ref returns, so the observer goes with the row. The
  // ref changes with `shown`, so each new page re-observes: an observer
  // reports once on start, which keeps paging while the foot is still in
  // reach (a tall screen, a short page) instead of waiting for a scroll.
  const sentinel = useCallback((el: HTMLElement | null) => {
    if (!el || typeof IntersectionObserver === 'undefined' || shown >= total) return;
    // Look ahead ~a screen so the next page is drawn before it is reached.
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) grow(); },
      { root: scrollParent(el), rootMargin: '0px 0px 800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [grow, shown, total]);

  return { shown, total, more, sentinel, showMore: grow };
}
