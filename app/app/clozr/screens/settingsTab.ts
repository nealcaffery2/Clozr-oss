// Which Settings section to land on when something outside Settings sends the
// rep there ("Manage scripts" in a call, "change" next to the headset). The
// shell has no URL per section, so this is a hand-off: read once when Settings
// mounts, and pushed to it when it is already open. With no hand-off, Settings
// opens on the section the rep was last on in this tab (sessionStorage), so a
// reload does not drop them back on General.
'use client';

export type TalkrSettingsTab = 'account' | 'numbers' | 'audio' | 'scripts' | 'templates' | 'calling';
export type WorkspaceSettingsTab = 'general' | 'company' | 'team' | 'roundrobin' | 'integrations' | 'agent' | 'keys' | 'floor' | 'history' | 'archive';
export type OutboundSettingsTab = 'email' | 'google' | 'keys';
export type SequencesSettingsTab = 'plans' | 'templates';
export type SettingsMain = 'workspace' | 'outbound' | 'talkr' | 'sequences';
export type SettingsTarget =
  | { main: 'workspace'; tab?: WorkspaceSettingsTab }
  | { main: 'outbound'; tab?: OutboundSettingsTab }
  | { main: 'talkr'; tab: TalkrSettingsTab }
  | { main: 'sequences'; tab?: SequencesSettingsTab };

let pending: SettingsTarget | null = null;
const listeners = new Set<(t: SettingsTarget) => void>();

export function requestSettingsTab(target: SettingsTarget): void {
  if (listeners.size) listeners.forEach((l) => l(target));
  else pending = target;
}

/** The section requested before Settings mounted, once. */
export function takeSettingsTab(): SettingsTarget | null {
  const t = pending;
  pending = null;
  return t;
}

export function onSettingsTab(fn: (t: SettingsTarget) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const LAST_KEY = 'clozr.settingsTab';
const MAINS: SettingsMain[] = ['workspace', 'outbound', 'talkr', 'sequences'];

/** The section Settings was last on in this browser tab, or null (none, or storage blocked). */
export function lastSettingsTab(): SettingsTarget | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? 'null') as { main?: unknown; tab?: unknown } | null;
    if (!raw || !MAINS.includes(raw.main as SettingsMain)) return null;
    // Settings checks the tab against its own nav and falls back to the group's first.
    return (typeof raw.tab === 'string' ? { main: raw.main, tab: raw.tab } : { main: raw.main }) as SettingsTarget;
  } catch {
    return null;
  }
}

/** Remember the section on screen for the next mount (a reload, or coming back to Settings). */
export function rememberSettingsTab(target: SettingsTarget): void {
  try {
    sessionStorage.setItem(LAST_KEY, JSON.stringify(target));
  } catch { /* private mode or storage blocked: Settings opens on General, as before */ }
}
