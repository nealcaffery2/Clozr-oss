// The underwriter's offer band: high = COMPR's offer (the MAO), low = high
// − $20k. A person who types the low or the high on the CLOZR record owns
// that number: a COMPR run, a slider moved in COMPR or a sync changes the MAO
// and whatever still follows it, never a figure someone set by hand. Each
// side is owned on its own, so a hand-set high still pulls an untouched low
// along with it.
//
// Pure and runtime-neutral: the browser (lib/offer-band.ts), crm-write's
// COMPR sync and the compr-underwrite function all write the band through
// these, so the card and the deal row agree.

export const OFFER_BAND_GAP = 20_000;

export type BandInput = {
  /** COMPR's offer (deals.mao). */
  mao?: number | null;
  /** The stored low (deals.wholesale_offer). */
  low?: number | null;
  /** The stored high (deals.institutional_offer). */
  high?: number | null;
  /** A person set the low (deals.offer_low_set_at is not null). */
  lowSet?: boolean;
  /** A person set the high (deals.offer_high_set_at is not null). */
  highSet?: boolean;
};

export type Band = {
  mao: number | null;
  low: number | null;
  high: number | null;
  /** The low shown is the one a person typed. */
  lowSet: boolean;
  /** The high shown is the one a person typed. */
  highSet: boolean;
};

const money = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;

/**
 * The band to show and store. With a MAO, the high is the MAO unless a person
 * set it, and the low is the high − $20k unless a person set it. Without one,
 * the stored figures stand (an older row COMPR wrote low and high swapped on
 * is put right), and a lone figure gets its partner $20k away.
 */
export function offerBand(i: BandInput): Band {
  const mao = money(i.mao);
  const storedLow = money(i.low);
  const storedHigh = money(i.high);
  const highSet = !!i.highSet && storedHigh != null;
  const lowSet = !!i.lowSet && storedLow != null;

  if (mao != null && mao >= 0) {
    const high = highSet ? storedHigh : mao;
    const low = lowSet ? storedLow : Math.max(0, (high ?? mao) - OFFER_BAND_GAP);
    return { mao, low, high, lowSet, highSet };
  }

  let low = storedLow;
  let high = storedHigh;
  if (!lowSet && !highSet && low != null && high != null && low > high) [low, high] = [high, low];
  if (high != null && low == null) low = Math.max(0, high - OFFER_BAND_GAP);
  else if (low != null && high == null && !lowSet) { high = low; low = Math.max(0, high - OFFER_BAND_GAP); }
  return { mao: null, low, high, lowSet, highSet };
}

/**
 * A person typed (or cleared) the low or the high. Typing owns that side;
 * clearing it hands the side back to COMPR, so the next figure is derived
 * again. The other side keeps whoever owned it.
 */
export function editOfferBand(cur: BandInput, which: 'low' | 'high', amount: number | null): Band {
  const n = money(amount);
  const next: BandInput = which === 'high'
    ? { ...cur, high: n, highSet: n != null }
    : { ...cur, low: n, lowSet: n != null };
  return offerBand(next);
}

/** The deal columns for a band. Null figures are left off, so a write never blanks one. */
export function offerBandColumns(b: Band): { wholesale_offer?: number; institutional_offer?: number } {
  return {
    ...(b.low != null ? { wholesale_offer: b.low } : {}),
    ...(b.high != null ? { institutional_offer: b.high } : {}),
  };
}

/** The band a deal row already carries, read for a COMPR write that is about to change its MAO. */
export function bandOfRow(row: {
  mao?: number | string | null; wholesale_offer?: number | string | null; institutional_offer?: number | string | null;
  offer_low_set_at?: string | null; offer_high_set_at?: string | null;
} | null | undefined): BandInput {
  const num = (v: number | string | null | undefined) => (v == null || v === '' ? null : Number(v));
  return {
    mao: num(row?.mao),
    low: num(row?.wholesale_offer),
    high: num(row?.institutional_offer),
    lowSet: !!row?.offer_low_set_at,
    highSet: !!row?.offer_high_set_at,
  };
}
