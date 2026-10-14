/**
 * An interval that runs only while the tab is visible.
 * It starts when the tab is showing, stops when the tab hides, and runs `fn`
 * once when the tab is shown again so a clock can catch up from the real time.
 * The caller clears it on unmount.
 */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  if (typeof document === 'undefined') return () => undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const start = () => {
    if (timer != null || document.hidden) return;
    timer = setInterval(() => {
      if (document.hidden) { stopTimer(); return; }
      fn();
    }, ms);
  };
  const onVis = () => {
    if (document.hidden) stopTimer();
    else { fn(); start(); }
  };
  start();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stopTimer();
    document.removeEventListener('visibilitychange', onVis);
  };
}
