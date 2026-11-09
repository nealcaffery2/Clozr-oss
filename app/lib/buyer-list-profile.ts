// What a workspace's Buyers screen holds, by `workspaces.settings.buyer_profile`
// (migration 249).
//
// Unset is the real-estate desk: cash buyers, the prospect holding pens and
// the realtor corpus, with the buy-box columns. `compr` is the Compr
// workspace, where the same table holds Compr customers and prospects: every
// view shows name, phone, email, market, last activity, type and status, and
// the rail is seven buckets (owner call 2026-10-27), each contact on exactly
// one: Not contacted, In an action plan, Contacted, Interested, Not
// interested, Free trial, Paid users, plus All contacts. The stage
// (buyers.status, migration 417 keeps it current) and the compr-in-plan,
// compr-free-trial and compr-paid tags decide which.
'use client';

import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { PROSPECT_LISTS } from './prospect-lists';

export type BuyerListProfile = 'default' | 'compr';

export const COMPR_NOT_CONTACTED_LIST = 'compr-not-contacted';
export const COMPR_IN_PLAN_LIST = 'compr-in-plan';
export const COMPR_CONTACTED_LIST = 'compr-contacted';
export const COMPR_INTERESTED_LIST = 'compr-interested';
export const COMPR_NOT_INTERESTED_LIST = 'compr-not-interested';
export const COMPR_TRIAL_LIST = 'compr-trial';
export const COMPR_TRIAL_LABEL = 'Free trial';
export const COMPR_PAID_LIST = 'compr-paid';
export const COMPR_PAID_LABEL = 'Paid users';
/** Every contact in a Compr workspace. */
export const COMPR_ALL_LIST = 'compr-all';
/** On a contact while an action plan runs for them (migration 417). */
export const COMPR_IN_PLAN_TAG = 'compr-in-plan';
export const COMPR_TRIAL_TAG = 'compr-free-trial';
export const COMPR_PAID_TAG = 'compr-paid';

const COMPR_LISTS: [id: string, label: string][] = [
  [COMPR_NOT_CONTACTED_LIST, 'Not contacted'],
  [COMPR_IN_PLAN_LIST, 'In an action plan'],
  [COMPR_CONTACTED_LIST, 'Contacted'],
  [COMPR_INTERESTED_LIST, 'Interested'],
  [COMPR_NOT_INTERESTED_LIST, 'Not interested'],
  [COMPR_TRIAL_LIST, COMPR_TRIAL_LABEL],
  [COMPR_PAID_LIST, COMPR_PAID_LABEL],
  [COMPR_ALL_LIST, 'All contacts'],
];

/** On a paid plan now: the sync keeps `compr-paid` once earned and puts the trial tag back when a plan lapses. */
export const isComprPaying = (tags: readonly string[]) => tags.includes(COMPR_PAID_TAG) && !tags.includes(COMPR_TRIAL_TAG);

/** The profile a workspace's `settings.buyer_profile` names. Anything unknown is the default. */
export function buyerListProfileOf(value: unknown): BuyerListProfile {
  return value === 'compr' ? 'compr' : 'default';
}

/** The system lists on the rail, in order. The first is where the screen opens. */
export function buyerListIds(profile: BuyerListProfile): string[] {
  return profile === 'compr' ? COMPR_LISTS.map(([id]) => id) : ['buyers', ...PROSPECT_LISTS.map((l) => l.id)];
}

export function buyerListLabelOf(id: string, profile: BuyerListProfile): string | null {
  if (profile === 'compr') return COMPR_LISTS.find(([x]) => x === id)?.[1] ?? null;
  return id === 'buyers' ? 'Buyers' : PROSPECT_LISTS.find((l) => l.id === id)?.label ?? null;
}

type ListRow = { prospectList?: string | null; stage?: string | null; comprTrial?: boolean; comprPaid?: boolean; comprInPlan?: boolean };

/** A Compr contact's one bucket, first match wins: paid, trial, what they said, on a plan, reached, or not yet. */
export function comprBucketOf(row: ListRow): string {
  const stage = row.stage ?? '';
  if (row.comprPaid || stage === 'Paid') return COMPR_PAID_LIST;
  if (row.comprTrial || stage === 'Free trial') return COMPR_TRIAL_LIST;
  if (stage === 'Not interested') return COMPR_NOT_INTERESTED_LIST;
  if (stage === 'Interested') return COMPR_INTERESTED_LIST;
  if (row.comprInPlan) return COMPR_IN_PLAN_LIST;
  if (stage === 'Contacted') return COMPR_CONTACTED_LIST;
  return COMPR_NOT_CONTACTED_LIST;
}

/**
 * Whether a row sits on a system list. In the default profile a prospect is
 * on its holding pen and off Buyers. In the Compr profile every contact is on
 * All contacts and on its one bucket (comprBucketOf).
 */
export function inBuyerList(list: string, row: ListRow, profile: BuyerListProfile): boolean {
  if (profile === 'compr') return list === COMPR_ALL_LIST || comprBucketOf(row) === list;
  return list === 'buyers' ? !row.prospectList : row.prospectList === list;
}

/** The list to show: the one picked when the profile has it, else the profile's first. */
export function effectiveBuyerList(picked: string, profile: BuyerListProfile, extra: readonly string[] = []): string {
  const ids = buyerListIds(profile);
  return ids.includes(picked) || extra.includes(picked) ? picked : ids[0];
}

const cacheKey = (ws: number) => `clozr.buyerProfile.${ws}`;

/**
 * The workspace's profile. Remembered on this device so the screen does not
 * flash the other columns on load; the database answer wins when it lands.
 * Only the one key is read, so no other workspace setting reaches the browser.
 */
export function useBuyerListProfile(workspaceId: number | null): BuyerListProfile {
  const [loaded, setLoaded] = useState<{ ws: number | null; profile: BuyerListProfile }>({ ws: null, profile: 'default' });
  useEffect(() => {
    if (workspaceId == null || !supabase) return;
    let alive = true;
    void supabase.from('workspaces').select('buyer_profile:settings->>buyer_profile').eq('id', workspaceId).maybeSingle()
      .then(({ data, error }) => {
        if (!alive || error) return;
        const profile = buyerListProfileOf((data as { buyer_profile?: unknown } | null)?.buyer_profile);
        try { localStorage.setItem(cacheKey(workspaceId), profile); } catch { /* not remembered */ }
        setLoaded({ ws: workspaceId, profile });
      });
    return () => { alive = false; };
  }, [workspaceId]);
  if (workspaceId == null) return 'default';
  if (loaded.ws === workspaceId) return loaded.profile;
  try { return buyerListProfileOf(localStorage.getItem(cacheKey(workspaceId))); } catch { return 'default'; }
}
