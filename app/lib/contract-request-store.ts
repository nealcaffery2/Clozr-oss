// Client state the contract request shares across the shell: the dialer's
// popup, the TC's alert queue, the draft Contracts should open next, and the
// sample data's local requests (the demo saves nothing to the database).
'use client';

import { useSyncExternalStore } from 'react';
import type { RequestPayload } from './contract-request';

/** One alert in the TC's queue. `notificationId` is notifications.id ('n' + id in the bell); null in the demo. */
export type RequestAlert = {
  key: string;
  notificationId: number | null;
  payload: RequestPayload;
  createdAt: number;
  /** The sample data shows the TC's alert to the person who asked, labelled as the TC's view. */
  demoAs: string | null;
};

/** A request kept in this browser on the sample data, standing in for the draft contract. */
export type DemoRequest = { id: string; payload: RequestPayload; createdAt: number; tcName: string };

type State = {
  /** `seq` changes on every open, so the popup starts fresh each time. */
  dialog: { phone: string | null; seq: number } | null;
  alerts: RequestAlert[];
  /** The contract the Contracts screen opens next: a contracts.id, or a demo request id. */
  pending: number | string | null;
  demo: DemoRequest[];
};

let state: State = { dialog: null, alerts: [], pending: null, demo: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const SERVER: State = { dialog: null, alerts: [], pending: null, demo: [] };

export function useRequestStore(): State {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

/** Request contract: open the popup for the call, or for the number loaded in the dialer. */
let dialogSeq = 0;
export const openRequestDialog = (phone: string | null = null) => { dialogSeq += 1; set({ dialog: { phone, seq: dialogSeq } }); };
export const closeRequestDialog = () => set({ dialog: null });

/** Queue an alert once; a second copy of the same notification is ignored. */
export function pushAlert(a: RequestAlert): void {
  if (state.alerts.some((x) => x.key === a.key)) return;
  set({ alerts: [...state.alerts, a] });
}
export const dropAlert = (key: string) => set({ alerts: state.alerts.filter((a) => a.key !== key) });

export const setPendingContract = (id: number | string | null) => set({ pending: id });

let demoSeq = 0;
export function addDemoRequest(payload: RequestPayload, tcName: string): DemoRequest {
  demoSeq += 1;
  const r: DemoRequest = { id: `demo-${demoSeq}`, payload, createdAt: Date.now(), tcName };
  set({ demo: [r, ...state.demo] });
  return r;
}

/** ActiveCall listens for this and starts its own live (warm) transfer to that Talkr user. */
export const WARM_TRANSFER_EVENT = 'clozr:warm-transfer';
export function requestWarmTransfer(talkrUserId: string): void {
  // `id`: two mounted call cards (the dialer and its slide-out) start one transfer, not two.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(WARM_TRANSFER_EVENT, { detail: { userId: talkrUserId, id: `${Date.now()}:${Math.random()}` } }));
}

/** Tests only: back to empty. */
export const resetRequestStore = () => { state = { ...SERVER }; demoSeq = 0; listeners.forEach((fn) => fn()); };
