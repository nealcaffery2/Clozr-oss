// The settings forms' state: for every agent, what is saved, what is being
// edited, and what follows from the two (errors, dirty). Keyed by agent_key so
// switching agents keeps each one's unsaved edits; `view(key)` is the one agent
// a screen is showing. Edits go through `set(path, value)` or `update(fn)`.
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  blockingErrors, defaultSettings, hasErrors, isDirty, validateSettings, type AgentSettings, type FieldErrors,
} from '@/lib/voice-agent';
import { setIn } from '@/lib/voice-agent-console';

type Slot = { saved: AgentSettings; draft: AgentSettings; server: FieldErrors };
const EMPTY = defaultSettings();
const blank: Slot = { saved: EMPTY, draft: EMPTY, server: {} };

export type FormView = {
  saved: AgentSettings; draft: AgentSettings;
  /** Everything to show beside fields: what the form checks plus what the server refused on the last save. */
  errors: FieldErrors;
  /** True when a save would be refused, so the Save button waits. Guidance (a missing destination) does not block. */
  invalid: boolean; dirty: boolean;
  set: (path: (string | number)[], value: unknown) => void;
  update: (fn: (d: AgentSettings) => AgentSettings) => void;
  discard: () => void; reseed: (s: AgentSettings) => void; setServerErrors: (e: FieldErrors) => void;
};

export function useAgentForms() {
  const [slots, setSlots] = useState<Record<string, Slot>>({});

  const view = useCallback((key: string): FormView => {
    const slot = slots[key] ?? blank;
    const patch = (fn: (cur: Slot) => Slot) => setSlots((all) => ({ ...all, [key]: fn(all[key] ?? blank) }));
    const client = validateSettings(slot.draft);
    const errors: FieldErrors = { ...client, ...slot.server };
    return {
      saved: slot.saved, draft: slot.draft, errors, invalid: hasErrors(blockingErrors(client)), dirty: isDirty(slot.saved, slot.draft),
      // An edit clears what the server said about the previous text: it may no longer be true.
      set: (path, value) => patch((c) => ({ ...c, draft: setIn(c.draft, path, value), server: {} })),
      update: (fn) => patch((c) => ({ ...c, draft: fn(c.draft), server: {} })),
      discard: () => patch((c) => ({ ...c, draft: c.saved, server: {} })),
      reseed: (s) => patch(() => ({ saved: s, draft: s, server: {} })),
      setServerErrors: (e) => patch((c) => ({ ...c, server: e })),
    };
  }, [slots]);

  const dirtyKeys = useMemo(() => Object.keys(slots).filter((k) => isDirty(slots[k]!.saved, slots[k]!.draft)), [slots]);
  const forget = useCallback((key: string) => setSlots((all) => { const rest = { ...all }; delete rest[key]; return rest; }), []);
  const has = useCallback((key: string) => key in slots, [slots]);
  return { view, dirtyKeys, forget, has };
}
