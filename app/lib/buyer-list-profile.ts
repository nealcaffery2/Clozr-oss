// The system lists on the Buyers screen: cash buyers, the prospect holding
// pens and the realtor corpus.

import { PROSPECT_LISTS } from './prospect-lists';

/** The system lists on the rail, in order. The first is where the screen opens. */
export function buyerListIds(): string[] {
  return ['buyers', ...PROSPECT_LISTS.map((l) => l.id)];
}

export function buyerListLabelOf(id: string): string | null {
  return id === 'buyers' ? 'Buyers' : PROSPECT_LISTS.find((l) => l.id === id)?.label ?? null;
}

/** Whether a row sits on a system list. A prospect is on its holding pen and off Buyers. */
export function inBuyerList(list: string, row: { prospectList?: string | null }): boolean {
  return list === 'buyers' ? !row.prospectList : row.prospectList === list;
}

/** The list to show: the one picked when it exists, else Buyers. */
export function effectiveBuyerList(picked: string, extra: readonly string[] = []): string {
  const ids = buyerListIds();
  return ids.includes(picked) || extra.includes(picked) ? picked : ids[0];
}
