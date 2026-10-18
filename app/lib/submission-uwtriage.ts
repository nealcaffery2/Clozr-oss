// Underwriting triage for partner submissions: how close UW high is to their
// ask, and whether they sent photos. COMPR-only or Street View does not count
// as submitter photos.

import { room } from './attack-gap';
import { isGalleryImage, photosLineUrls } from './house-photos';

export type UwTriageBucket = 'green' | 'decline' | 'review';

const COMPR_PHOTO = /thecompr\.com\/api\/photo/i;

export type SubmitterPhotoDeal = {
  sourcePhotos?: string[];
  photosUrl?: string | null;
  photos?: string[];
  notes?: string | null;
};

export type SubmitterPhotoPerson = {
  intake?: Record<string, unknown> | null;
  notes?: string | null;
};

const positive = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** True when the wholesaler sent a photo link, folder, listing, or an upload — not COMPR alone. */
export function hasSubmitterPhotos(deal: SubmitterPhotoDeal, person?: SubmitterPhotoPerson | null): boolean {
  if (/^https?:\/\//i.test(String(deal.photosUrl ?? '').trim())) return true;
  if ((deal.sourcePhotos ?? []).some((u) => String(u ?? '').trim())) return true;
  const intake = person?.intake?.photos;
  if (typeof intake === 'string' && /^https?:\/\//i.test(intake.trim())) return true;
  if (photosLineUrls(person?.notes).length) return true;
  if (photosLineUrls(deal.notes).length) return true;
  if ((deal.photos ?? []).some((u) => isGalleryImage(u) && !COMPR_PHOTO.test(u ?? ''))) return true;
  return false;
}

/** UW high (institutional band) as a fraction of ask we are short: 0 = at ask, 1 = $0 high. */
export function askShortfallPct(ask: number | null | undefined, high: number | null | undefined): number | null {
  if (!positive(ask) || !positive(high)) return null;
  const gap = room(high, ask);
  if (gap == null) return null;
  if (gap >= 0) return 0;
  return (-gap) / ask;
}

export function uwTriageBucket(
  ask: number | null | undefined,
  high: number | null | undefined,
  deal: SubmitterPhotoDeal,
  person?: SubmitterPhotoPerson | null,
): UwTriageBucket | null {
  if (!hasSubmitterPhotos(deal, person)) return 'decline';
  if (!positive(ask)) return null;
  const shortfall = askShortfallPct(ask, high);
  if (shortfall == null) return 'review';
  if (shortfall <= 0.25) return 'green';
  if (shortfall >= 0.75) return 'decline';
  return 'review';
}

export const UW_TRIAGE_LABEL: Record<UwTriageBucket, string> = {
  green: 'Top 25% green',
  decline: 'Decline bucket',
  review: 'Review',
};

export type DealUwTriageInput = SubmitterPhotoDeal & {
  asking?: number | null;
  institutional?: number | null;
};

export function uwTriageForDeal(deal: DealUwTriageInput, person?: SubmitterPhotoPerson | null): UwTriageBucket | null {
  return uwTriageBucket(deal.asking, deal.institutional, deal, person);
}

export function uwTriageLabelFromDeal(deal: DealUwTriageInput, person?: SubmitterPhotoPerson | null): string | null {
  const b = uwTriageForDeal(deal, person);
  return b ? UW_TRIAGE_LABEL[b] : null;
}

export function uwTriageHint(bucket: UwTriageBucket | null, shortfall: number | null, noPhotos: boolean): string {
  if (noPhotos) return 'No photos from the submitter — fast decline.';
  if (bucket === 'green') return 'UW high within 25% of their ask.';
  if (bucket === 'decline' && shortfall != null) return `UW high is ${Math.round(shortfall * 100)}% below their ask (outside top 25%).`;
  if (bucket === 'decline') return 'Outside the offer range — fast decline.';
  return 'Between 25% and 75% below ask — normal underwriting queue.';
}
