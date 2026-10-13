// The offer band on the record (Low offer / High offer). The rule lives in
// supabase/functions/_shared/offer-band.ts so the compr-underwrite function
// writes exactly what the card shows.

export {
  OFFER_BAND_GAP, type Band, type BandInput, bandOfRow, editOfferBand, offerBand, offerBandColumns,
} from '@/supabase/functions/_shared/offer-band';
