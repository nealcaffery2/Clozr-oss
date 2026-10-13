// Ref callback for an absolutely positioned menu: if it would open past the
// viewport edge, flip it to hang from the other side of its trigger.
export function keepInView(el: HTMLElement | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) {
    el.style.left = 'auto';
    el.style.right = '0';
  } else if (r.left < 8) {
    el.style.left = '0';
    el.style.right = 'auto';
  }
}
