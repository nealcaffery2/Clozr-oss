// Which deal a COMPR report lands on, and the line the deal keeps about it.
// Run: npx tsx tools/compr-sync.test.ts
import { comprLeadIdOfDeal } from '../lib/compr-embed';
import { comprNote, comprReportDealId, sameStreet } from '../lib/compr-sync';

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    console.error('FAIL', name, '\n got ', g, '\n want', w);
    process.exitCode = 1;
  } else console.log('ok', name);
}

eq('note carries low/high offer band',
  comprNote({ wholesale: 175000, institutional: 210000, condition: 'C3' }),
  'COMPR · condition C3 · low $175,000 · high $210,000');

eq('note skips empty band',
  comprNote({ condition: 'C4', confidence: 82 }),
  'COMPR · condition C4 · confidence 82%');

type D = { id: string; underwritingUrl?: string | null; comprReportUrl?: string | null };
const deals: D[] = [
  { id: 'd5160', underwritingUrl: 'https://thecompr.com/r/clozr-w11-d5160-2026-10-08' },
  { id: 'd5159', underwritingUrl: 'https://thecompr.com/r/clozr-w11-d5159-2026-10-08' },
  { id: 'd5161', underwritingUrl: null },
];
const leadOf = (d: D) => comprLeadIdOfDeal(d);
const opened = { dealId: 'd5160', addr: '403 Laurel St SW' };

eq('a report lands on the deal it is the report of',
  comprReportDealId({ leadId: 'clozr-w11-d5159-2026-10-08' }, deals, leadOf, opened), 'd5159');

eq('the window\'s own deal first',
  comprReportDealId({ leadId: 'clozr-w11-d5160-2026-10-08' }, deals, leadOf, opened), 'd5160');

eq('a re-run in COMPR (new lead id) of the house the window was opened for',
  comprReportDealId({ leadId: 'app-1791471432399', address: '403 Laurel St SW, Rome, GA 30161' }, deals, leadOf, opened), 'd5160');

eq('a report on some other house is nobody\'s',
  comprReportDealId({ leadId: 'app-1', address: '82 Kensington Ct, Commerce, GA' }, deals, leadOf, opened), null);

eq('nothing opened from CLOZR and an unknown lead: nobody\'s',
  comprReportDealId({ leadId: 'app-1', address: '403 Laurel St SW' }, deals, leadOf, null), null);

eq('"123 Main St" and "123 Main Street" are one house', sameStreet('123 Main St, Dallas, TX 75201', '123 Main Street'), true);
eq('an address with no house number never matches', sameStreet('Main St', 'Main St'), false);
