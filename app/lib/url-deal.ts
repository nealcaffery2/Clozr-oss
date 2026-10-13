// Which house a screen is on, in the address bar.
//
// A partner or wholesaler carries many deals on one contact, so a record, a
// deal sheet or a TC file opened on one house names that house in the hash
// (`#screen=person&id=s42&deal=d907`). Back, Forward and a reload then come
// back to the same house instead of the contact's best-ranked deal.

import { supabase } from './supabase';

/** The pieces of state that pin a screen to one deal. */
export type DealPins = {
  screen: string;
  personDealId?: string | null;
  dealSheetDealId?: string | null;
  tcDealId?: string | null;
  dispoDealId?: string | null;
};

/** The deal a screen's hash carries, or null when the screen is not on one. */
export function urlDealOf(st: DealPins): string | null {
  switch (st.screen) {
    case 'person': return st.personDealId ?? null;
    case 'dealSheet': return st.dealSheetDealId ?? null;
    case 'tc': return st.tcDealId ?? null;
    case 'dispoProperty': return st.dispoDealId ?? null;
    default: return null;
  }
}

/**
 * The pin a hash's deal restores on its screen. A screen with no deal in its
 * hash gets null, so Back to an unpinned record does not keep the house the
 * last one was pinned to.
 */
export function dealPinsFor(screen: string, deal: string | null): Omit<DealPins, 'screen'> {
  switch (screen) {
    case 'person': return { personDealId: deal };
    case 'dealSheet': return { dealSheetDealId: deal };
    case 'tc': return { tcDealId: deal };
    case 'dispoProperty': return { dispoDealId: deal };
    default: return {};
  }
}

/**
 * The list a record screen's record lives on: where a link to a record that
 * is archived (or gone) lands, instead of Home. Null for a screen that is not
 * a record.
 */
export function recordListOf(screen: string): 'people' | 'buyers' | null {
  if (screen === 'buyer') return 'buyers';
  if (screen === 'person' || screen === 'dealSheet' || screen === 'dispoProperty' || screen === 'tc') return 'people';
  return null;
}

/**
 * True when this id is a record archived out of the workspace. Archived rows
 * are never loaded up front, so this is one row read, only when a link names
 * a record the loaded data does not have.
 */
export async function isArchivedRecord(workspaceId: number, kind: 'seller' | 'buyer', id: number): Promise<boolean> {
  if (!supabase || !Number.isFinite(id)) return false;
  const q = kind === 'buyer'
    ? supabase.from('buyers').select('id').eq('workspace_id', workspaceId).eq('id', id).not('archived_at' as never, 'is', null)
    : supabase.from('sellers').select('id').eq('workspace_id', workspaceId).eq('id', id).not('archived_at', 'is', null);
  const { data } = await q.maybeSingle();
  return !!data;
}
