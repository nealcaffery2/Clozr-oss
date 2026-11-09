// Portal submissions parsing. Run: npx tsx tools/portal-subs.test.ts
import { inMarkets, isEightAmCentral, markSpainLabel, parseCsv, postedSubmissions, quietThreeDays, senderLabel, sheetToSubmissions, submissionToFlat, summaryMail, summaryRecipient } from '../supabase/functions/_shared/portal-subs';
import { flatToEnvelope } from '../supabase/functions/_shared/flat';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Offerpad's daily CSV: HYPERLINK formula links, "$198,014.00" money, an unnamed sale-type column.
const offerpad = [
  'Property Link,Address,City,State,Zip Code,Market,Build Type,Bedrooms,Bathrooms,Year Built,Square Feet,Parking,Wastewater System,Solar,Pool,Suggested Value,3D Tour,',
  '"=HYPERLINK(""https://buy.offerpad.com/investor-opportunities/3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6"",""https://buy.offerpad.com/investor-opportunities/3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6"")",5965 Bramble Dr,Decatur,GA,30034,Atlanta,Single Family,3,2,1978,"1,450",Garage,Sewer,No,No,"$198,014.00",,Buy It Now',
  ',,,,,,,,,,,,,,,,,',
].join('\r\n');
const subs = sheetToSubmissions(parseCsv(offerpad), 'Offerpad', 'offerpad')!;
eq('one row, blank row skipped', subs.length, 1);
const s = subs[0];
eq('uuid from the HYPERLINK is the id', s.external_id, 'offerpad:3f2a9c1e1b2c4d5e8f90a1b2c3d4e5f6');
eq('link unwrapped', s.listing_url, 'https://buy.offerpad.com/investor-opportunities/3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6');
eq('address', [s.address, s.city, s.state, s.zip], ['5965 Bramble Dr', 'Decatur', 'GA', '30034']);
eq('numbers', [s.beds, s.baths, s.sqft, s.year_built], [3, 2, 1450, 1978]);
eq('suggested value is the arv', s.arv, 198014);
eq('build type is the property type', s.property_type, 'Single Family');
eq('unknown columns and the unnamed sale type become notes', s.notes.filter((n) => /^(Market|Pool|Sale type):/.test(n)), ['Market: Atlanta', 'Pool: No', 'Sale type: Buy It Now']);

const env = flatToEnvelope('portal', submissionToFlat(s), s.external_id);
if ('error' in env) { console.log('FAIL  envelope', env.error); failed++; } else {
  eq('wholesaler mode lands on New Submission', env.mode, 'wholesaler');
  eq('tags', env.lead?.tags, ['Portal', 'Offerpad']);
  eq('partner is the company', env.intake?.entity, 'Offerpad');
  eq('arv on the deal', env.deal?.arv, 198014);
  eq('activity names the partner', env.activity?.title, 'New submission from Offerpad');
}

// A sheet with a title row above the header, no ids: keyed on address + zip so a resend dedupes.
const sheet = [['MSRE Investor Sheet'], ['Property Address', 'City', 'ST', 'Zip', 'List Price', 'Bid'], ['12 Oak Ln', 'Raleigh', 'nc', '27601-1234', '$210k', '']];
const ms = sheetToSubmissions(sheet, 'Mark Spain NC', 'markspain:nc')!;
eq('header found below a title row', ms.length, 1);
eq('address key id', ms[0].external_id, 'markspain:nc:12oakln:27601');
eq('state upper, zip5, 210k', [ms[0].state, ms[0].zip, ms[0].asking_price], ['NC', '27601', 210000]);

eq('no address column is an unknown layout', sheetToSubmissions([['Invoice', 'Amount'], ['1', '$5']], 'X', 'x'), null);

eq('known sender', senderLabel('Offerpad <investorpartner@offerpad.com>'), 'Offerpad');
eq('subdomain of a known sender', senderLabel('a@mail.markspain.com'), 'Mark Spain');
eq('unknown sender', senderLabel('billing@csc.com'), null);
eq('full address sender', senderLabel('Jeff Holloway <jeff.holloway@brokerage.example>'), 'eXp Cash Offers');
eq('same domain, other address', senderLabel('someone@brokerage.example'), null);
eq('new partner domain', senderLabel('sparker@keystonesfr.com'), 'Keystone SFR');
eq('extra sender from config', senderLabel('deals@harborcapital.com', 'harborcapital.com=Harbor Capital'), 'Harbor Capital');

eq('8 AM CDT is 13:00 UTC', isEightAmCentral(new Date('2026-10-27T13:00:00Z')), true);
eq('14:00 UTC in CDT is 9 AM', isEightAmCentral(new Date('2026-10-27T14:00:00Z')), false);
eq('8 AM CST is 14:00 UTC', isEightAmCentral(new Date('2026-12-01T14:00:00Z')), true);
eq('Saturday', isEightAmCentral(new Date('2026-10-31T13:00:00Z')), false);

// The summary only ever goes to Sam: config cannot point it anywhere else.
eq('recipient: sam', summaryRecipient(' Sam@YourCompany.com '), 'sam@yourcompany.com');
eq('recipient: another Acme Homes address is still refused', summaryRecipient('chris@yourcompany.com'), null);
eq('recipient: outside', summaryRecipient('someone@offerpad.com'), null);
eq('recipient: empty', summaryRecipient(''), null);

eq('mark spain state from the subject', markSpainLabel('Mark Spain', 'MSRE Investor Sheet(s) Reminder - Texas'), 'Mark Spain TX');
eq('mark spain, no state', markSpainLabel('Mark Spain', 'MSRE Investor Sheets'), 'Mark Spain');
eq('other labels untouched', markSpainLabel('Offerpad', 'TX deals'), 'Offerpad');

eq('quiet: three empty runs after rows', quietThreeDays(0, [0, 0, 4]), true);
eq('quiet: never had rows', quietThreeDays(0, [0, 0, 0]), false);
eq('quiet: only two runs', quietThreeDays(0, [0, 3]), false);
eq('quiet: rows today', quietThreeDays(2, [0, 0, 4]), false);

const mail = summaryMail({
  date: new Date('2026-10-28T13:00:00Z'), live: true, assignee: 'Drew Collins',
  report: [
    { source: 'Offerpad', found: 7, created: 2, existing: 5, deduped: 0, failed: 0, lines: ['added: 5965 Bramble Dr, Decatur GA', 'already in CLOZR: 1 Main St', 'added: 9 Elm St, Austin TX'] },
    { source: 'Mark Spain TX', found: 0, created: 0, existing: 0, deduped: 0, failed: 0, lines: [], error: 'sheet not readable' },
  ],
  unknown: ['Houston_9_.xlsx from Kade Turner: sender not on the partner list'],
  compr: { queued: 2, done: 1, failed: ['deal 5615: 504 try again'] },
});
eq('subject', mail.subject, 'Submissions 10/28: 2 new, 5 already in Clozr, 1 source failed');
eq('body lists sources, compr counts and needs-you', mail.text.split('\n'), [
  'Morning Sam,', '',
  'New in Clozr (New Submission, Drew Collins):',
  '- Offerpad: 2 (5965 Bramble Dr, Decatur GA, 9 Elm St, Austin TX)',
  '', 'Already in Clozr, skipped: 5', 'Sent to Compr: 2, underwritten: 1.',
  '', 'Needs you:',
  '- Mark Spain TX: sheet not readable',
  '- Compr: deal 5615: 504 try again',
  '- Houston_9_.xlsx from Kade Turner: sender not on the partner list',
]);
eq('dry run in the subject', summaryMail({ date: new Date('2026-10-28T13:00:00Z'), live: false, assignee: 'Drew Collins', report: [], unknown: [], compr: { queued: 0, done: 0, failed: [] } }).subject, 'Submissions 10/28 (dry run): 0 new, 0 already in Clozr');

// Felix's worker POSTs rows: untrusted, state normalized, bad rows rejected by index.
const posted = postedSubmissions([
  { external_id: 'orchard:abc', source: 'Express Offers', address: ' 12 Oak St ', city: 'Carmel', state: 'In', zip: '46032', beds: 3, baths: '2.5', sqft: '1,450', asking_price: 0, arv: null, listing_url: 'javascript:alert(1)', posted_at: '2026-11-02', offer_deadline: null, notes: 'Vacant' },
  { external_id: 'orchard:def', source: 'Orchard Offers', address: null },
  'junk',
]);
eq('posted: one good row', posted.subs.length, 1);
eq('posted: state upper', posted.subs[0].state, 'IN');
eq('posted: address trimmed', posted.subs[0].address, '12 Oak St');
eq('posted: numbers', [posted.subs[0].beds, posted.subs[0].baths, posted.subs[0].sqft, posted.subs[0].asking_price, posted.subs[0].arv], [3, 2.5, 1450, undefined, undefined]);
eq('posted: non-http link dropped', posted.subs[0].listing_url, undefined);
eq('posted: notes', posted.subs[0].notes, ['Posted: 2026-11-02', 'Vacant']);
eq('posted: rejects', posted.rejected, ['row 1: needs external_id, source and address', 'row 2: needs external_id, source and address']);
eq('posted: not an array', postedSubmissions({}).rejected, ['submissions is not an array']);
eq('posted: tags + lead_source', [submissionToFlat(posted.subs[0]).tags, submissionToFlat(posted.subs[0]).lead_source], ['Portal, Express Offers', 'Express Offers']);
eq('markets: unset allows all', inMarkets('CO', ''), true);
eq('markets: in list', inMarkets('tx', 'TX, GA'), true);
eq('markets: outside', inMarkets('CO', 'TX,GA'), false);
eq('markets: no state when filtered', inMarkets(undefined, 'TX'), false);

if (failed) process.exit(1);
