// People › Submissions quick views (the chip row over the table on the Home
// Pros workspace): each is a list plus filters plus the columns that matter
// for that question, applied together through V.applyPeopleView. Stage
// views ride the stage lists that already exist; the rule views ride the
// UW triage filter (lib/submission-uwtriage.ts: UW high within 25% of their
// ask is green, 75% or more below is too far apart, no photos or no numbers
// did not qualify) and the buy box filter (lib/acme-homes-buybox.ts).
//
// Columns are PEOPLE_COLUMNS keys (useClozr.ts). `name` is the submitter on a
// submission row and is always shown; `property` carries the address.

import { UW_TRIAGE_LABEL } from './submission-uwtriage';

export type SubmissionView = {
  label: string;
  hint: string;
  list: string;
  filters?: Record<string, string>;
  cols: string[];
};

/** Submitter, the house, their number, our numbers, where it stands, how to reach them. */
const NUMBERS = ['property', 'asking', 'uwBand', 'offer', 'uwTriage', 'stage', 'phone', 'email'];

export const SUBMISSION_VIEWS: readonly SubmissionView[] = [
  { label: 'Needs underwrite', hint: 'New or in underwriting with no COMPR run yet', list: 'New Submissions', filters: { compr: 'Not run' },
    cols: ['property', 'asking', 'specs', 'stage', 'created', 'phone', 'email'] },
  { label: 'Underwriting complete', hint: 'Underwritten, no offer out yet', list: 'Underwriting Complete', cols: NUMBERS },
  { label: 'Offer made', hint: 'Our offer is out', list: 'Offer Made', cols: ['property', 'asking', 'offer', 'uwBand', 'uwTriage', 'stage', 'phone', 'email'] },
  { label: 'Underwrite declined', hint: 'Declined at underwriting', list: 'Underwrite Declined', cols: ['property', 'asking', 'uwBand', 'uwTriage', 'stage', 'phone', 'email'] },
  { label: 'Top 25%', hint: 'UW high within 25% of their ask', list: 'Total Submissions', filters: { uwTriage: UW_TRIAGE_LABEL.green },
    cols: ['offer', 'uwBand', 'asking', 'property', 'stage', 'email', 'phone'] },
  { label: 'Close offer', hint: 'Our offer within $20k of their ask', list: 'Total Submissions', filters: { attackGap: 'Within $20k', attackBasis: 'Our offer' },
    cols: ['property', 'asking', 'offer', 'uwBand', 'stage', 'phone', 'email'] },
  { label: 'Too far apart', hint: 'UW high 75% or more below their ask', list: 'Total Submissions', filters: { uwTriage: UW_TRIAGE_LABEL.tooFar },
    cols: ['property', 'asking', 'uwBand', 'uwTriage', 'stage', 'phone', 'email'] },
  { label: "Didn't qualify", hint: 'No photos from the submitter, or no numbers to underwrite', list: 'Total Submissions', filters: { uwTriage: UW_TRIAGE_LABEL.unqualified },
    cols: ['property', 'asking', 'uwTriage', 'stage', 'created', 'phone', 'email'] },
  { label: 'Outside of buy box', hint: 'Price, market, beds, baths, sqft or year outside the Acme Homes buy box', list: 'Total Submissions', filters: { buybox: 'Outside buy box' },
    cols: ['property', 'specs', 'asking', 'buybox', 'stage', 'phone', 'email'] },
];
