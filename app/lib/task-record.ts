// Where opening a task should land: the seller (or deal) it is on, else the
// buyer, else nowhere. Checklist tasks often carry only deal_id; buyer-plan
// tasks only buyer_id. The Tasks screen used to always open a blank person.

export type TaskRecord =
  | { kind: 'person'; id: string; dealId?: string | null }
  | { kind: 'buyer'; id: string };

export type TaskRecordLookups = {
  hasPerson: (id: string) => boolean;
  sellerOfDeal: (dealId: string) => string | null | undefined;
  hasBuyer: (id: string) => boolean;
};

/**
 * The record a task opens. Prefer a seller already on the task; else the
 * deal's seller; else a buyer. A person id with no loaded row still opens —
 * the shell may be about to load it (archived, just created).
 */
export function taskRecordOf(
  t: { personId?: string | null; dealId?: string | null; buyerId?: string | null },
  look: TaskRecordLookups,
): TaskRecord | null {
  const personId = String(t.personId ?? '').trim();
  const dealId = String(t.dealId ?? '').trim();
  const buyerId = String(t.buyerId ?? '').trim();

  if (personId && look.hasPerson(personId)) return { kind: 'person', id: personId, dealId: dealId || null };
  if (dealId) {
    const fromDeal = look.sellerOfDeal(dealId);
    if (fromDeal && look.hasPerson(fromDeal)) return { kind: 'person', id: fromDeal, dealId };
    if (personId) return { kind: 'person', id: personId, dealId };
    // Deal with no seller in the graph: the deal sheet still opens on the deal.
    return { kind: 'person', id: '', dealId };
  }
  if (personId) return { kind: 'person', id: personId, dealId: dealId || null };
  if (buyerId && look.hasBuyer(buyerId)) return { kind: 'buyer', id: buyerId };
  return null;
}
