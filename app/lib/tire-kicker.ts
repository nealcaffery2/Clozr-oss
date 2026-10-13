// A tire kicker replies to almost nothing, or puts offers in and never closes.
// Either path is enough. A thin history does not count: one quiet deal, or a
// single offer that has not closed yet, is not a pattern.

export const TIRE_KICKER_MIN_SENT = 4;
/** Reply rate at or under this, once enough deals have been sent. */
export const TIRE_KICKER_MAX_RESPONSE = 25;
export const TIRE_KICKER_MIN_OFFERS = 2;

export function isTireKicker(input: {
  /** Deals sent. Null when the record only has a response percent. */
  sent: number | null;
  responsePct: number;
  offers: number;
  purchases: number;
}): boolean {
  const lowResponse = input.sent != null && input.sent >= TIRE_KICKER_MIN_SENT && input.responsePct <= TIRE_KICKER_MAX_RESPONSE;
  const neverCloses = input.offers >= TIRE_KICKER_MIN_OFFERS && input.purchases === 0;
  return lowResponse || neverCloses;
}
