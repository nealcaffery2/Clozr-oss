// Settings → Phone numbers → caller reputation: one summary shared by the
// top card, each line's badge and the open line's panel, so a save in the
// panel repaints the badge and the counts without another round trip.
'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api, type NumberReputationDto, type ReputationGrade, type ReputationSummaryDto } from '@/lib/talkr-web/api';

type State = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  summary: ReputationSummaryDto | null;
  error: string | null;
  /** The line whose panel is open. */
  open: string | null;
};

let state: State = { status: 'idle', summary: null, error: null, open: null };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

/** `refresh` asks Talkr to re-read the carrier instead of its day-old cache. */
export async function loadReputation(refresh = false): Promise<void> {
  if (!state.summary) set({ status: 'loading' });
  try {
    set({ status: 'ready', summary: await api.reputationSummary(refresh), error: null });
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Replace one line's report (after a save or a per-line refresh) and recount the badges. */
export function putNumberReputation(r: NumberReputationDto): void {
  if (!state.summary) return;
  const numbers = state.summary.numbers.map((n) => (n.id === r.id ? r : n));
  const counts = { good: 0, watch: 0, at_risk: 0 } as Record<ReputationGrade, number>;
  numbers.forEach((n) => { counts[n.grade] += 1; });
  set({ summary: { ...state.summary, numbers, counts } });
}

export const setSummary = (summary: ReputationSummaryDto) => set({ summary });
export const toggleReputationPanel = (id: string) => set({ open: state.open === id ? null : id });
export const setReputationPanel = (id: string | null) => set({ open: id });

export function useReputation(load = false): State {
  const snap = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (load && state.status === 'idle') void loadReputation();
  }, [load]);
  return snap;
}
