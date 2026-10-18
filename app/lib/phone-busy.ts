// Whether this tab's phone has a call up or an active dial session.
// useTalkrPhone sets it. Only then can a second answer reach this tab, so a
// hidden tab keeps the busy-drop recording's URL fresh only while it is true
// (VoicemailDrop useArmBusyDrop).

let busy = false;
const listeners = new Set<() => void>();

export function setPhoneBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  listeners.forEach((fn) => fn());
}

export function phoneBusy(): boolean {
  return busy;
}

/** Runs `fn` each time the flag changes. Returns the unsubscribe. */
export function onPhoneBusy(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
