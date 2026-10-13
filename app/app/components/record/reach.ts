'use client';

// Who the docked quick text / quick email box is talking to, when it is not
// the seller record that is open.
//
// A module store rather than view-model state because the buttons that open
// it live everywhere (buyer rows, the dispo results table, the deal team
// card, the inbox) and several of them never see the view model. The one
// host (QuickReach, mounted on the shell) reads it, so there is one box and
// one dock no matter who opened it.

import { useSyncExternalStore } from 'react';
import type { Recipient } from '@/lib/sms';

export type ReachChannel = 'text' | 'email';

export type ReachTarget = {
  name: string;
  phone?: string | null;
  email?: string | null;
  /** Filing ids. Resolved from the phone or email through the CRM when left out. */
  sellerId?: number | null;
  buyerId?: number | null;
  vendorId?: number | null;
  dealId?: number | null;
  /** Merge-field values for templates; the CRM's when left out. */
  recipient?: Recipient;
  /** Which template list to offer. */
  audience?: 'seller' | 'buyer' | 'any';
  /** A prefilled draft: a signing link, a reply's subject. */
  subject?: string;
  body?: string;
  /** The RFC Message-ID being answered, so a reply threads in Gmail. */
  inReplyTo?: string | null;
  /** A blank compose: the rep types the number or address. */
  editableTo?: boolean;
  onSent?: () => void;
};

export type ReachState = { channel: ReachChannel; target: ReachTarget; nonce: number } | null;

let state: ReachState = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openReach(channel: ReachChannel, target: ReachTarget) {
  state = { channel, target, nonce: (state?.nonce ?? 0) + 1 };
  emit();
}

export function closeReach() {
  if (!state) return;
  state = null;
  emit();
}

// Whether the shell's box is mounted. A page without it (a standalone route)
// keeps the plain sms: / mailto: link rather than a button that does nothing.
let hosts = 0;
export function registerReachHost(): () => void {
  hosts += 1;
  return () => { hosts -= 1; };
}

/** An sms: or mailto: link's onClick: open the docked box instead, when there is one. */
export function reachClick(e: { preventDefault: () => void; stopPropagation: () => void }, channel: ReachChannel, target: ReachTarget) {
  e.stopPropagation();
  if (!hosts) return;
  e.preventDefault();
  openReach(channel, target);
}

export function useReach(): ReachState {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => state,
    () => null,
  );
}
