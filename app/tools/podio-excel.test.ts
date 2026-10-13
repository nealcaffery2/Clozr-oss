// The Podio Excel importer's dedupe: entity, phone, email and address normalization, and the plan it builds.
//
// Pure functions, no network. Run with:  npx tsx tools/podio-excel.test.ts

import { addressKey, buildPlan, cleanEntity, emailKey, entityKey, parseAddress, phoneKey, submissionStage, thousands, type Row } from '../lib/podio-excel';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};
const key = (raw: string) => entityKey(cleanEntity(raw).name);
const same = (label: string, xs: string[]) => { const ks = xs.map(key); check(label, new Set(ks).size === 1 && !!ks[0], ks); };
const apart = (label: string, a: string, b: string) => check(label, key(a) !== key(b), [key(a), key(b)]);

// ---- money typed in thousands
check('ARV 160 is $160,000', thousands(160) === 160000);
check('ARV 1.3 is $1.3M', thousands(1.3) === 1300000);
check('ARV 245,000 stays', thousands(245000) === 245000);
check('rehab 30 is $30,000; rehab 500 stays', thousands(30, 200) === 30000 && thousands(500, 200) === 500);
check('zero and null stay', thousands(0) === 0 && thousands(null) === null);

// ---- entities
same('Mark Spain regional suffixes, case and "Real Estate" fold', ['Mark Spain', 'Mark Spain - NC', 'mark spain - tx', 'Mark Spain -FL', 'Mark Spain - DFW', 'Mark Spain Real Estate']);
check('regional suffix becomes a market', cleanEntity('Mark Spain - NC').market === 'NC' && cleanEntity('Mark Spain - DFW').market === 'TX');
same('Offerpad case', ['Offerpad', 'offerpad']);
same('iFinder spellings', ['Ifinder', 'ifinder', 'iFinder', 'ifnder', 'ifinderoffers']);
same('LLC / Inc / punctuation', ['Barron Inc', 'barron inc', 'Barron Inc.']);
same('3-28 vs 328', ['3-28 Investments LLC', '328 Investments LLC']);
same('EXP off-market spellings', ['EXP - Offmarket', 'EXP - Off Market', 'EXP Offmarket', 'EXP', 'eXp Realty']);
same('markdown and trailing dots', ['_Quick Offer For Homes, LLC._', 'Quick Offer For Homes, LLC']);
same('home buyers tail', ['STW HOME BUYERS LLC', 'STW', 'STW Home Buyers']);
same('reviewed alias: typo', ['Arizona Property Advsiors LLC', 'Arizona Property Advisors LLC']);
same('reviewed alias: acronym', ['BSHB', 'BSHB Holdings LLC', 'Big State Home Buyers']);
same('state code tail', ['Legado Builders FL LLC', 'Legado Builders', 'Legado Builder FL LLC']);
apart('different companies stay apart: Offerpad / Offerly Homes', 'Offerpad', 'Offerly Homes');
apart('different companies stay apart: Kingstone Capital / Kingstone Capital Management', 'Kingstone Capital llc', 'Kingstone Capital Management LLC');
apart('different companies stay apart: Complete Homes / Ocean Trust (same owner)', 'Complete Homes Holdings LLC', 'Ocean Trust Property Group, LLC');
apart('different companies stay apart: Express Offers / EXP', 'Express Offers', 'EXP');
check('junk entities name nobody', key('Na') === null && key('Self') === null && key('') === null);
check('an email typed as the entity is an email', cleanEntity('[Sampleproperties@gmail.com](mailto:Sampleproperties@gmail.com)').email === 'sampleproperties@gmail.com');

// ---- phones and emails
check('phone formats → one key', new Set(['(727) 555-0180', '727-555-0180', '+1 727.555.0180', '17275550180'].map(phoneKey)).size === 1 && phoneKey('(727) 555-0180') === '7275550180');
check('placeholder phones are none', phoneKey('(000) 000-0000') === null && phoneKey('0000000000') === null && phoneKey('000-000-0000') === null && phoneKey('12345') === null);
check('email lowercased, <> stripped', emailKey('<Matt@SampleCribs.com>') === 'matt@samplecribs.com');
check("Acme Homes' own addresses and NA are not a submitter's email", emailKey('chris@yourcompany.com') === null && emailKey('NA') === null);

// ---- addresses (keys mirror public.address_key)
const k = (s: string) => { const a = parseAddress(s); return a && addressKey(a); };
check('full state name + zip', k('1102 E Kessler Avenue, Fort Worth, Texas, 76104') === '1102 E KESSLER AVE|76104', k('1102 E Kessler Avenue, Fort Worth, Texas, 76104'));
check('city typo does not change the key', k('1102 E Kessler Avenue, Fort Wort, Texas, 76104') === k('1102 E Kessler Ave, Fort Worth, TX 76104'));
check('USA suffix, ST ZIP', k('103 Pell St, Seneca, SC 29678, USA') === '103 PELL ST|29678');
check('no comma before state', k('472 N Coral Dr, Sarasota FL 34234') === '472 N CORAL DR|34234', parseAddress('472 N Coral Dr, Sarasota FL 34234'));
check('Podio repeated location', k('3235 Kemper Ave, Cincinnati, OH 45207, Cincinnati, Ohio, 45207') === '3235 KEMPER AVE|45207');
check('nbsp between parts', k('8509 Hadley Ave, Cleveland, OH 44105') === '8509 HADLEY AVE|44105');
check('no zip keys on state + city', k('210 Halcyon Blvd, Simpsonville, SC') === '210 HALCYON BLVD|SC|SIMPSONVILLE');
check('"Ct" is a street suffix, not Connecticut', parseAddress('456 Elm Ct')?.line1 === '456 Elm Ct' && parseAddress('456 Elm Ct')?.state === null);
check('county-only or portfolio is no address', parseAddress('Pasco County, Wesley Chapel, FL 33545') === null && parseAddress('Portfolio, DALLAS, Texas, 75150') === null);

// ---- stages
check('double space in "Underwriting  Complete"', submissionStage('Underwriting  Complete') === 'Underwriting Complete');
check('blank stage is a new submission', submissionStage('') === 'New Submission' && submissionStage(undefined) === 'New Submission');
check('unknown stage is null', submissionStage('Something Else') === null);

// ---- the plan
const row = (o: Partial<Record<string, string>>): Row => ({ 'Created on': '2026-09-01T10:00:00', 'Created by': 'Drew Collins', Stage: 'Offer Made', ...o } as Row);
const plan = buildPlan({
  submissions: [
    row({ 'Entity Name': 'Mark Spain - NC', 'Property Address': '425 Lakeshore Avenue, High Point, NC 27263' }),
    row({ 'Entity Name': 'mark spain', 'Property Address': '425 Lakeshore Ave, High Point, North Carolina, 27263', 'Created on': '2026-09-05T10:00:00', Stage: 'Offer Declined' }),
    row({ 'Entity Name': 'Offerpad', 'Property Address': '425 Lakeshore Ave, High Point, NC 27263' }),
    row({ 'Entity Name': 'CHH', 'Property Address': '14068 Pine Key Drive, Jacksonville, FL 32224', 'Phone - Mobile': '(727) 555-0180', 'Email - Home': 'deals@completehomes.example', 'First Name': 'Jordan', 'Last Name': 'Blake' }),
    row({ 'Entity Name': 'Ocean Trust', 'Property Address': '1 Oak St, Tampa, FL 33603', 'Phone - Mobile': '(727) 555-0180', 'First Name': 'Jordan', 'Last Name': 'Blake' }),
    row({ 'Property Address': '2 Oak St, Tampa, FL 33603', 'Phone - Work': '727-555-0180' }),
    row({ 'Entity Name': 'Chris Mercer', 'Property Address': '3 Oak St, Tulsa, OK 74105' }),
    row({ 'Entity Name': 'Barron Inc', 'Property Address': '4 Oak St, Tulsa, OK 74105', 'First Name': 'Chris', 'Last Name': 'Mercer', 'Phone - Mobile': '(000) 000-0000' }),
    row({ 'Entity Name': 'Test LLC', 'Property Address': '5 Oak St, Tulsa, OK 74105' }),
    row({ 'Entity Name': 'Offerpad', Stage: 'Underwriting  Complete', Dead: 'Mark Deal as Dead', 'Property Address': '6 Oak St, Tulsa, OK 74105' }),
  ],
  dealStage: [{ 'Deal Stage': 'Closed', Wholesaler: 'Mark Spain - NC', 'Property Address': '425 Lakeshore Ave, High Point, NC 27263', 'Purchase Price - amount': '115000', 'Disposition Price - amount': '125000', 'Closing Date - start': '2026-09-10T00:00:00', 'DIsposition Agent - name': 'Morgan Lane;\nAlex Lee', 'DIsposition Agent - mail': 'morgan@yourcompany.com;\nalex@yourcompany.com' }],
  activeDeals: [],
});
const partner = (k: string) => plan.partners.find((p) => p.key === k);
const lakeshore = plan.leads.filter((l) => l.property === '425 LAKESHORE AVE|27263');
check('one property for three spellings of one address', plan.properties.filter((p) => p.key === '425 LAKESHORE AVE|27263').length === 1);
check('same partner resubmitting an address → one lead, newest stage', lakeshore.filter((l) => l.partner === 'markspain').length === 1 && lakeshore.find((l) => l.partner === 'markspain')!.lead_stage === 'Offer Declined');
check('another partner on the same address → its own lead, both tagged', lakeshore.length === 2 && lakeshore.every((l) => l.tags.includes('Multiple sources')));
check('Mark Spain NC + mark spain → one partner with market NC', partner('markspain')?.submissions === 2 && partner('markspain')!.markets.includes('NC'));
check('Complete Homes and Ocean Trust stay two partners (listed for review)', !!partner('completehomes') && !!partner('oceantrust') && plan.review.sharedContacts.some((s) => s.contact === '7275550180'));
check('a row with no entity is attributed by phone', plan.leads.find((l) => l.property === '2 OAK ST|33603')?.partner === 'completehomes');
check('a person-name entity folds into the company that person submits for', plan.leads.find((l) => l.property === '3 OAK ST|74105')?.partner === 'barron' && !partner('chrisminter'));
check('test submissions skipped', !plan.leads.some((l) => l.property === '5 OAK ST|74105') && plan.skipped.some((s) => s.reason === 'test submission'));
check('Dead tag and double-space stage', (() => { const l = plan.leads.find((x) => x.property === '6 OAK ST|74105'); return !!l && l.tags.includes('Dead') && l.lead_stage === 'Underwriting Complete'; })());
const closed = plan.leads.find((l) => l.partner === 'markspain' && l.property === '425 LAKESHORE AVE|27263')!;
check('Deals row lands on the wholesaler\'s own lead', closed.stage_from_deal && closed.deal.stage === 'Closed' && closed.final_stage === 'Closed' && closed.deal.offer_amount === 115000 && closed.deal.closed_on === '2026-09-10');
check('dispo agents are teammates, not vendors', closed.parties.filter((p) => p.role === 'dispositions').length === 2 && closed.parties.every((p) => p.role !== 'dispositions' || (p.team && !p.partner)));
check('no duplicate party per deal + role + source', closed.parties.length === new Set(closed.parties.map((p) => p.role + p.source_id)).size);
check('every lead has a source_id, and they are unique', new Set(plan.leads.map((l) => l.source_id)).size === plan.leads.length);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
