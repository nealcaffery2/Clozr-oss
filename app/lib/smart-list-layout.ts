// Smart-list rail: drag changes the order, right-click pins a list to the top.
// The four lists that used to paint a dark dot are the default pins, so the
// rail looks the same until someone moves it. The saved order is the full
// sequence; pins are a subset that always render first, in that same order.

export const DEFAULT_PINNED_LISTS = ['Needs attention', 'My Leads', 'New Leads', 'Hot Leads', 'Follow Up Today'];

/** Defaults, then any saved labels that still exist, unknowns dropped, missing defaults appended. */
export function orderSmartLists(defaults: string[], savedOrder: string[]): string[] {
  const known = new Set(defaults);
  const base = savedOrder.filter((l) => known.has(l));
  for (const l of defaults) if (!base.includes(l)) base.push(l);
  return base;
}

/** Pinned labels float to the top and keep their relative order. */
export function layoutSmartLists(defaults: string[], savedOrder: string[], pinned: string[]): string[] {
  const base = orderSmartLists(defaults, savedOrder);
  const pinSet = new Set(pinned.filter((l) => base.includes(l)));
  return [...base.filter((l) => pinSet.has(l)), ...base.filter((l) => !pinSet.has(l))];
}

/**
 * Drop `from` in front of `before`. Landing on a pinned row pins `from`;
 * landing on an unpinned row unpins it. The returned order is the new full
 * sequence (pins included), which layoutSmartLists will float again.
 */
export function applySmartListDrop(
  displayed: string[], pinned: string[], from: string, before: string,
): { order: string[]; pinned: string[] } {
  if (!from || from === before || !displayed.includes(from) || !displayed.includes(before)) {
    return { order: displayed, pinned };
  }
  const pinSet = new Set(pinned);
  const next = displayed.filter((l) => l !== from);
  const at = next.indexOf(before);
  if (at < 0) return { order: displayed, pinned };
  next.splice(at, 0, from);
  if (pinSet.has(before)) pinSet.add(from);
  else pinSet.delete(from);
  return { order: next, pinned: next.filter((l) => pinSet.has(l)) };
}

export function togglePinnedList(pinned: string[], label: string): string[] {
  return pinned.includes(label) ? pinned.filter((l) => l !== label) : [...pinned, label];
}
