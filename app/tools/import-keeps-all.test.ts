// An import keeps every column of the file (migration 134).
//
// Pure functions, no network. Run with:  npx tsx tools/import-keeps-all.test.ts
//
// A full PropStream export header row maps every field without a hand; phones
// and emails after the first are split out in file order with their type and
// DNC / litigator flags; whatever has no field is kept as extra info by its
// header; Add new info / Override cover the new fields; the submissions and
// buyer imports keep their extras too.

import {
  applyBuyerMapping, applyMapping, applyVendorMapping, autoMap, foldInto, headerKeys, isoDay, keptSummary, numberedContact,
  parseTable, propertyImportFields, sellerImportColumns, withUnit, type ImportRecord, type Target,
} from '../lib/import';
import { mergeObject, mergePatch } from '../lib/import-dedupe';
import { factRows, factText, importLines, isMissingColumn, withoutImportColumns } from '../lib/import-extras';
import { dncUpdates } from '../lib/seller-phones';
import { canonicalVendorName, findIndexedVendor, indexVendors, mainSubmitter, submissionNotes, vendorNamesOf } from '../lib/submission-import';
import { photoLinkRow } from '../lib/deal-files';

let failed = 0;
const check = (name: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) failed++;
};
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const csvRow = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

// ---- a full PropStream export ------------------------------------------------

const PROPSTREAM: [string, Target, string][] = [
  ['Address', 'full_address', '4410 Ridgecrest Dr'],
  ['Unit #', 'unit', '4'],
  ['City', 'city', 'San Antonio'],
  ['State', 'st', 'TX'],
  ['Zip', 'zip', '78228'],
  ['County', 'county', 'Bexar'],
  ['APN', 'apn', '04812-000-0140'],
  ['Owner Occupied', 'owner_occupied', 'No'],
  ['Owner 1 First Name', 'first_name', 'Maria'],
  ['Owner 1 Last Name', 'last_name', 'Lopez'],
  ['Owner 2 First Name', 'owner2_first', 'Jose'],
  ['Owner 2 Last Name', 'owner2_last', 'Lopez'],
  ['Mailing Care of Name', 'extra', 'c/o Lopez Trust'],
  ['Mailing Address', 'mail_addr', '900 Elm St'],
  ['Mailing Unit #', 'mail_unit', 'Apt 2'],
  ['Mailing City', 'mail_city', 'Houston'],
  ['Mailing State', 'mail_st', 'TX'],
  ['Mailing Zip', 'mail_zip', '77008'],
  ['Mailing County', 'extra', 'Harris'],
  ['Do Not Mail', 'do_not_mail', 'Yes'],
  ['Property Type', 'property_type', 'Single Family Residential'],
  ['Bedrooms', 'beds', '3'],
  ['Total Bathrooms', 'baths', '2.5'],
  ['Building Sqft', 'sqft', '1,450'],
  ['Lot Size Sqft', 'lot_sqft', '6,970'],
  ['Effective Year Built', 'year', '1978'],
  ['Total Assessed Value', 'assessed_value', '$151,200'],
  ['Last Sale Recording Date', 'last_sale_date', '3/14/2009'],
  ['Last Sale Amount', 'last_sale_price', '$92,000'],
  ['Total Open Loans', 'open_loans', '1'],
  ['Est. Remaining balance of Open Loans', 'loan_balance', '$41,300'],
  ['Est. Value', 'est_value', '$189,000'],
  ['Est. Loan-to-Value', 'ltv', '21.9'],
  ['Est. Equity', 'est_equity', '$147,700'],
  ['Monthly Rent', 'monthly_rent', '$1,650'],
  ['MLS Status', 'mls_status', 'Expired'],
  ['MLS Date', 'mls_date', '2025-11-02'],
  ['MLS Amount', 'mls_amount', '$199,900'],
  ['Lien Amount', 'lien_amount', '0'],
  ['Vacant', 'vacant', 'Yes'],
  ['Absentee', 'absentee', 'Yes'],
  ['Marketing Lists', 'tags', 'Vacant; High Equity'],
  ['Date Added to List', 'created', '9/30/2026'],
  ['Phone 1', 'phone', '(210) 555-0101'],
  ['Phone 1 Type', 'phone_type', 'Wireless'],
  ['Phone 1 DNC', 'phone_dnc', 'No'],
  ['Phone 1 Litigator', 'phone_dnc', 'No'],
  ['Phone 2', 'phone2', '210-555-0102'],
  ['Phone 2 Type', 'phone_type', 'Landline'],
  ['Phone 2 DNC', 'phone_dnc', 'Yes'],
  ['Phone 2 Litigator', 'phone_dnc', 'No'],
  ['Phone 3', 'phone', '210.555.0103'],
  ['Phone 3 Type', 'phone_type', 'Wireless'],
  ['Phone 3 DNC', 'phone_dnc', 'No'],
  ['Phone 3 Litigator', 'phone_dnc', 'Yes'],
  ['Phone 4', 'phone', '2105550104'],
  ['Phone 4 Type', 'phone_type', 'VOIP'],
  ['Phone 4 DNC', 'phone_dnc', ''],
  ['Phone 4 Litigator', 'phone_dnc', ''],
  ['Phone 5', 'phone', '(210) 555-0101'],
  ['Phone 5 Type', 'phone_type', ''],
  ['Phone 5 DNC', 'phone_dnc', 'DNC'],
  ['Phone 5 Litigator', 'phone_dnc', ''],
  ['Email 1', 'email', 'maria@example.com'],
  ['Email 2', 'email', 'MLOPEZ@example.com'],
  ['Email 3', 'email', 'maria@example.com'],
  ['Email 4', 'email', 'm.lopez@work.example'],
];
const psTable = parseTable([csvRow(PROPSTREAM.map((c) => c[0])), csvRow(PROPSTREAM.map((c) => c[2]))].join('\n'));
const psMap = autoMap(psTable);
const wrong = PROPSTREAM.map(([h, want], i) => [h, want, psMap[i]] as const).filter(([, want, got]) => want !== got);
check(`PropStream: every one of ${PROPSTREAM.length} columns maps on its own`, !wrong.length, wrong.map(([h, w, g]) => `${h}: ${g} (want ${w})`).join('; '));
check('PropStream: no column is dropped', !Object.values(psMap).includes('skip'));

const ps = applyMapping(psTable, psMap)[0];
check('PropStream: name, address with its unit', ps.name === 'Maria Lopez' && ps.addr === '4410 Ridgecrest Dr #4' && ps.city === 'San Antonio' && ps.st === 'TX' && ps.zip === '78228', JSON.stringify([ps.name, ps.addr, ps.city]));
check('PropStream: owner 2', ps.owner2 === 'Jose Lopez', String(ps.owner2));
check('PropStream: mailing address, unit added, do not mail', JSON.stringify(ps.mailing) === JSON.stringify({ line1: '900 Elm St Apt 2', city: 'Houston', st: 'TX', zip: '77008' }) && ps.doNotMail === true, JSON.stringify(ps.mailing));
check('PropStream: main phone and its type', ps.phone === '(210) 555-0101' && ps.phoneKind === 'mobile' && ps.phoneDnc === true,
  `${ps.phone} ${ps.phoneKind} ${ps.phoneDnc} (Phone 5 repeats Phone 1 marked DNC: the flag is kept)`);
check('PropStream: phones 2–4 in file order with type and DNC / litigator, the repeat once',
  JSON.stringify(ps.otherPhones) === JSON.stringify([
    { phone: '210-555-0102', kind: 'landline', dnc: true },
    { phone: '210.555.0103', kind: 'mobile', dnc: true },
    { phone: '2105550104', kind: 'voip', dnc: false },
  ]), JSON.stringify(ps.otherPhones));
check('PropStream: phone2 is still the second number', ps.phone2 === '210-555-0102');
check('PropStream: first email is the main one, the rest kept once in order', ps.email === 'maria@example.com' && JSON.stringify(ps.otherEmails) === JSON.stringify(['MLOPEZ@example.com', 'm.lopez@work.example']), JSON.stringify(ps.otherEmails));
check('PropStream: house columns', ps.beds === 3 && ps.baths === 2.5 && ps.sqft === 1450 && ps.year === 1978 && ps.apn === '04812-000-0140'
  && ps.propertyType === 'Single Family Residential' && ps.county === 'Bexar' && ps.lotSqft === 6970, JSON.stringify([ps.beds, ps.baths, ps.sqft, ps.lotSqft]));
check('PropStream: value, loans, sale, MLS and flags are facts',
  JSON.stringify(ps.facts) === JSON.stringify({
    est_value: 189000, assessed_value: 151200, est_equity: 147700, ltv: 21.9, open_loans: 1, loan_balance: 41300, lien_amount: 0, monthly_rent: 1650,
    last_sale_date: '2009-03-14', last_sale_price: 92000, mls_status: 'Expired', mls_date: '2025-11-02', mls_amount: 199900,
    vacant: true, absentee: true, owner_occupied: false,
  }), JSON.stringify(ps.facts));
check('PropStream: est. value is not the ARV (no deal per row)', ps.arv === null);
check('PropStream: marketing lists are tags', JSON.stringify(ps.tags) === JSON.stringify(['Vacant', 'High Equity']));
check('PropStream: the columns with no field are kept by header', JSON.stringify(ps.extra) === JSON.stringify({ 'Mailing Care of Name': 'c/o Lopez Trust', 'Mailing County': 'Harris' }), JSON.stringify(ps.extra));
check('PropStream: preview says what else is kept', keptSummary(ps) === '+3 phones · +2 emails · owner 2 · mailing address · 16 property facts · 2 extra', String(keptSummary(ps)));

// What the seller and the property are written with.
const cols = sellerImportColumns(ps);
check('seller columns: mailing, do not mail, owner 2, other emails lowercased, extra',
  JSON.stringify(cols) === JSON.stringify({
    mailing_line1: '900 Elm St Apt 2', mailing_city: 'Houston', mailing_state: 'TX', mailing_zip: '77008', do_not_mail: true, owner2_name: 'Jose Lopez',
    other_emails: ['mlopez@example.com', 'm.lopez@work.example'], import_extra: { 'Mailing Care of Name': 'c/o Lopez Trust', 'Mailing County': 'Harris' },
  }), JSON.stringify(cols));
const pf = propertyImportFields(ps);
check('property fields: columns it has, facts for the rest', pf.property_type === 'Single Family Residential' && pf.county === 'Bexar' && pf.lot_sqft === 6970 && pf.baths === 2.5
  && typeof pf.facts === 'object' && Object.keys(pf.facts as object).length === 16, JSON.stringify(pf));

// A file with none of it writes exactly what it did before.
const plain = applyMapping(parseTable('Name,Phone\nAnn Lee,210-555-0100'), autoMap(parseTable('Name,Phone\nAnn Lee,210-555-0100')))[0];
check('a plain file adds no new seller columns (an older database still imports it)', JSON.stringify(sellerImportColumns(plain)) === '{}' && !('facts' in propertyImportFields(plain)));

// ---- header variants -----------------------------------------------------------

const variants: [string, Target][] = [
  ['Phone1', 'phone'], ['Mobile 1', 'phone'], ['Landline 2', 'phone'], ['Cell Phone 3', 'phone'], ['Phone Number 4', 'phone'], ['Owner Mailing Phone 1', 'phone'],
  ['Phone Type 1', 'phone_type'], ['Phone1_DNC', 'phone_dnc'], ['Phone 2 Litigator', 'phone_dnc'], ['Phone 3 Carrier', 'extra'],
  ['Email 2', 'email'], ['Email Address 3', 'email'], ['Email3', 'email'],
];
for (const [h, want] of variants) check(`numbered header "${h}" → ${want}`, numberedContact(h) === want, String(numberedContact(h)));
check('not a numbered contact: "Phone", "Market", "Owner 2 First Name"', numberedContact('Phone') === null && numberedContact('Market') === null && numberedContact('Owner 2 First Name') === null);

const v = parseTable(`Owner Name,Phone1,Phone2,Phone3,Email,Email 2,Mail Address,Mail City,Mail State,Mail Zip,Property Type,Lot Size Acres,Estimated Equity,Est. Equity %,Tax Amount,Random Thing
Al Ray,210-555-0201,210-555-0202,210-555-0203,al@x.com,al2@x.com,"77 Pine Rd, Austin, TX 78701",,,,Condo,0.25,"$80,000",42%,"$3,100",blue`);
const vm = autoMap(v);
const vb = Object.fromEntries(v.headers.map((h, i) => [h, vm[i]]));
check('variants: Phone1/2/3 → phone, phone2, phone', vb.Phone1 === 'phone' && vb.Phone2 === 'phone2' && vb.Phone3 === 'phone', JSON.stringify(vb));
check('variants: Email, Email 2 → email both', vb.Email === 'email' && vb['Email 2'] === 'email');
check('variants: Mail Address / City / State / Zip', vb['Mail Address'] === 'mail_addr' && vb['Mail City'] === 'mail_city' && vb['Mail State'] === 'mail_st' && vb['Mail Zip'] === 'mail_zip', JSON.stringify(vb));
check('variants: Property Type, Lot Size Acres, Estimated Equity', vb['Property Type'] === 'property_type' && vb['Lot Size Acres'] === 'lot_sqft' && vb['Estimated Equity'] === 'est_equity');
check('variants: a % column and unknown money and text are kept as extra, never the asking price', vb['Est. Equity %'] === 'extra' && vb['Tax Amount'] === 'extra' && vb['Random Thing'] === 'extra', JSON.stringify(vb));
const vr = applyMapping(v, vm)[0];
check('variants: a one-column mailing address splits', JSON.stringify(vr.mailing) === JSON.stringify({ line1: '77 Pine Rd', city: 'Austin', st: 'TX', zip: '78701' }), JSON.stringify(vr.mailing));
check('variants: acres become square feet', vr.lotSqft === 10890, String(vr.lotSqft));
check('variants: extras by header', vr.extra['Est. Equity %'] === '42%' && vr.extra['Tax Amount'] === '$3,100' && vr.extra['Random Thing'] === 'blue', JSON.stringify(vr.extra));
check('variants: three phones and two emails', vr.phone === '210-555-0201' && vr.otherPhones.length === 2 && vr.otherEmails.length === 1);

// One cell with two numbers; two columns on one single-value field.
const two = parseTable('Name,Phone,City,City\nBo,"210-555-0301, 512-555-0302",Austin,Round Rock');
const twoMap = { 0: 'name', 1: 'phone', 2: 'city', 3: 'city' } as Record<number, Target>;
const tr = applyMapping(two, twoMap)[0];
check('a cell holding two numbers is two phones', tr.phone === '210-555-0301' && tr.otherPhones[0]?.phone === '512-555-0302', JSON.stringify([tr.phone, tr.otherPhones]));
check('a second column on a one-value field is kept, not dropped', tr.city === 'Austin' && tr.extra['City (2)'] === 'Round Rock', JSON.stringify(tr.extra));
check('a column a person chose not to import is left out', !('Name' in applyMapping(two, { ...twoMap, 0: 'skip' })[0].extra));
check('header keys are unique', JSON.stringify(headerKeys(['Notes', 'notes', '', 'Notes'])) === JSON.stringify(['Notes', 'notes (2)', 'Column 3', 'Notes (3)']));
check('isoDay: US dates, ISO, words kept', isoDay('3/4/09') === '2009-03-04' && isoDay('2019-03-14T00:00:00') === '2019-03-14' && isoDay('last spring') === 'last spring');
check('withUnit: added once', withUnit('1 Main St', '4') === '1 Main St #4' && withUnit('1 Main St #4', '4') === '1 Main St #4' && withUnit('1 Main St', 'Apt 4') === '1 Main St Apt 4' && withUnit('1 Main St Unit 4', 'Unit 4') === '1 Main St Unit 4');

// ---- duplicate rows in one file merge without losing a number --------------------

const dupT = parseTable('Name,Phone,Email,Vacant,Color\nAnn Lee,210-555-0401,ann@x.com,Yes,red\nAnn Lee,210-555-0402,ann2@x.com,,blue');
const [d1, d2] = applyMapping(dupT, autoMap(dupT));
const folded = foldInto(d1, d2) as ImportRecord;
check('merge: the duplicate\'s phone and email become other ones', folded.phone === '210-555-0401' && folded.otherPhones.some((p) => p.phone === '210-555-0402') && folded.otherEmails.includes('ann2@x.com'), JSON.stringify([folded.otherPhones, folded.otherEmails]));
check('merge: bags merge key by key, the first row wins', folded.extra.Color === 'red' && folded.facts.vacant === true);

// ---- Add new info / Override -------------------------------------------------------

const onFile = {
  name: 'Maria Lopez', mailing_line1: null, mailing_city: 'Houston', owner2_name: 'Jose', do_not_mail: null,
  other_emails: ['old@x.com'], import_extra: { 'Mailing County': 'Harris', Note: 'typed' }, tags: ['vip'], notes: 'n',
};
const incoming = {
  mailing_line1: '900 Elm St', mailing_city: 'Katy', owner2_name: 'Jose Lopez', do_not_mail: true,
  other_emails: ['OLD@x.com', 'new@x.com'], import_extra: { 'Mailing County': 'Fort Bend', 'Care of': 'Trust', Note: '' }, tags: [], notes: '',
};
const opts = { lists: ['tags', 'other_emails'], append: ['notes'], objects: ['import_extra'] };
const fill = mergePatch(onFile, incoming, 'fill', opts);
check('Add new info: only empty fields fill; emails added once; extra keys added, none replaced',
  same(fill, {
    mailing_line1: '900 Elm St', do_not_mail: true, other_emails: ['old@x.com', 'new@x.com'],
    import_extra: { 'Mailing County': 'Harris', Note: 'typed', 'Care of': 'Trust' },
  }), JSON.stringify(fill));
const over = mergePatch(onFile, incoming, 'overwrite', opts);
check('Override: given values written, emails still only added, extra keys replaced, a blank never clears',
  same(over, {
    mailing_line1: '900 Elm St', mailing_city: 'Katy', owner2_name: 'Jose Lopez', do_not_mail: true, other_emails: ['old@x.com', 'new@x.com'],
    import_extra: { 'Mailing County': 'Fort Bend', Note: 'typed', 'Care of': 'Trust' },
  }), JSON.stringify(over));
check('mergePatch: blank new fields change nothing', JSON.stringify(mergePatch(onFile, { mailing_city: '', other_emails: [], import_extra: {} }, 'overwrite', opts)) === '{}');
check('mergeObject: facts fill and overwrite', JSON.stringify(mergeObject({ est_value: 1, vacant: true }, { est_value: 2, ltv: 30 }, 'fill')) === JSON.stringify({ est_value: 1, vacant: true, ltv: 30 })
  && JSON.stringify(mergeObject({ est_value: 1 }, { est_value: 2 }, 'overwrite')) === JSON.stringify({ est_value: 2 })
  && mergeObject({ est_value: 1 }, { est_value: 1 }, 'overwrite') === null && mergeObject(null, null, 'fill') === null);
check('property facts merge the same way (objects)', JSON.stringify(mergePatch({ beds: 3, facts: { est_value: 1 } }, { beds: 4, baths: 2, facts: { est_value: 2, ltv: 5 } }, 'fill', { lists: [], append: [], objects: ['facts'] }))
  === JSON.stringify({ baths: 2, facts: { est_value: 1, ltv: 5 } }));

// ---- a database without migration 134 ---------------------------------------------

check('missing column recognised', isMissingColumn({ code: 'PGRST204', message: "Could not find the 'mailing_city' column of 'sellers' in the schema cache" }, ['mailing_city'])
  && !isMissingColumn({ message: 'duplicate key value' }, ['mailing_city']) && !isMissingColumn(null, ['x']));
const legacy = withoutImportColumns({ name: 'A', notes: 'hi', mailing_line1: '1 Main', mailing_city: 'Austin', mailing_state: 'TX', other_emails: ['b@x.com'], import_extra: { Color: 'red' } });
check('older database: the new columns go into the notes, nothing lost',
  !('mailing_line1' in legacy) && !('import_extra' in legacy) && legacy.notes === 'hi\nFrom the import:\nMailing address: 1 Main, Austin, TX\nOther emails: b@x.com\nColor: red', JSON.stringify(legacy.notes));
check('importLines: nothing to say is nothing', importLines({ name: 'x' }).length === 0);
check('facts read back for the record', JSON.stringify(factRows({ est_value: 189000, ltv: 21.94, open_loans: 1, vacant: true, last_sale_date: '2009-03-14', junk: 1 }))
  === JSON.stringify([{ k: 'Est. value', v: '$189,000' }, { k: 'Est. loan-to-value', v: '21.9%' }, { k: 'Open loans', v: '1' }, { k: 'Last sale date', v: 'Mar 14, 2009' }, { k: 'Vacant', v: 'Yes' }]),
  JSON.stringify(factRows({ est_value: 189000, ltv: 21.94, open_loans: 1, vacant: true, last_sale_date: '2009-03-14' })));
check('factText: negative equity, an open-loans dollar total', factText('est_equity', -5000) === '-$5,000' && factText('open_loans', 120000) === '$120,000');

// ---- DNC flags on numbers already on file --------------------------------------------

const rows = [{ id: 1, phone: '+12105550102', is_dnc: false }, { id: 2, phone: '+12105550103', is_dnc: true }];
const plan = dncUpdates('+12105550101', rows, [
  { phone: '(210) 555-0101', kind: 'mobile', dnc: true }, { phone: '210-555-0102', dnc: true }, { phone: '210.555.0103', dnc: true }, { phone: '210-555-0104', dnc: false },
]);
check('DNC: a number on file is marked, one already marked is left, the primary gets a DNC row', JSON.stringify(plan.flag) === '[1]' && plan.primary?.phone === '+12105550101' && plan.primary.kind === 'mobile', JSON.stringify(plan));
check('DNC: a primary already on file as a row is not added twice', dncUpdates('+12105550102', rows, [{ phone: '2105550102', dnc: true }]).primary === null);
check('DNC: no flags, nothing to do', JSON.stringify(dncUpdates('+12105550101', rows, [{ phone: '2105550102' }])) === JSON.stringify({ flag: [], primary: null }));

// ---- submissions, buyers and vendors keep their extras ------------------------------

const sub = parseTable(`Property Address,City,State,Zip,Owner Name,Phone 1,Phone 2,Email 2,List Price,Occupancy,Lockbox Code,Est. Value
4410 Ridgecrest Dr,San Antonio,TX,78228,Kim Ray,210-555-0501,210-555-0502,kim2@x.com,"$189,000",Tenant,1234,"$200,000"`);
const sr = applyMapping(sub, autoMap(sub))[0];
const sn = submissionNotes(sr) ?? '';
check('submission notes keep other phones, emails, facts and extra columns', sn.includes('Other phones: +12105550502') && sn.includes('· kim2@x.com')
  && sn.includes('Est. value: $200,000') && sn.includes('Occupied: Tenant') && sn.includes('Lockbox Code: 1234'), sn);

const bt = parseTable(`Buyer Name,Phone,Phone 2,Phone 3,Email,Email 2,Markets,Favorite Color
Sam Reed,512-555-0111,512-555-0112,512-555-0113,sam@x.com,sam2@x.com,Austin,green`);
const bm = autoMap(bt, 'buyers');
const br = applyBuyerMapping(bt, bm)[0];
check('buyers: phone 3 and email 2 kept, unknown column kept as extra', br.phone === '512-555-0111' && br.phone2 === '512-555-0112' && JSON.stringify(br.otherPhones) === '["512-555-0113"]'
  && JSON.stringify(br.otherEmails) === '["sam2@x.com"]' && br.extra['Favorite Color'] === 'green' && !Object.values(bm).includes('skip'), JSON.stringify([br.otherPhones, br.otherEmails, br.extra, bm]));

const vt = parseTable(`Business Name,Phone,Phone 2,Email,Office Hours
Alamo Title,210-555-0199,210-555-0198,jen@alamo.com,9-5`);
const vrec = applyVendorMapping(vt, autoMap(vt, 'vendors'))[0];
check('vendors: second phone and unknown column kept', JSON.stringify(vrec.otherPhones) === '["210-555-0198"]' && vrec.extra['Office Hours'] === '9-5', JSON.stringify(vrec));

// A partner's sheet: its facts show on the record, each row goes to the partner it names.
check('partner sheet facts listed with labels', JSON.stringify(factRows({ market: 'Raleigh', garage: '2 car', listed_mls: false, on_investorlift: true, portfolio: 'One Property' }))
  === JSON.stringify([{ k: 'Market', v: 'Raleigh' }, { k: 'Garage', v: '2 car' }, { k: 'Listed on MLS', v: 'No' }, { k: 'On InvestorLift', v: 'Yes' }, { k: 'One property or portfolio', v: 'One Property' }]));
check('vendor per row: the partner named, else the one picked', JSON.stringify(vendorNamesOf([{ submitter: 'Kingston ' }, { submitter: null }, { submitter: '' }], ' Offerpad')) === '["Kingston","Offerpad","Offerpad"]');
check('vendor entity column left as extra still names the row', JSON.stringify(vendorNamesOf([{ submitter: null, extra: { 'Vendor Entity Name': 'Mark Spain - NC' } }, { submitter: '', extra: { 'Vendor Entity Name': 'CHH' } }, { extra: {} }], 'Offerpad')) === '["Mark Spain - NC","CHH","Offerpad"]');
check('NA in the entity column is nobody, so the fallback vendor is used', vendorNamesOf([{ submitter: 'NA' }], 'Offerpad')[0] === 'Offerpad');
check('main partner is the most common, first spelling kept', mainSubmitter([{ submitter: 'Kingston' }, { submitter: 'Acme' }, { submitter: 'kingston' }, {}]) === 'Kingston');
check('no partner column → no prefill', mainSubmitter([{}, { submitter: ' ' }]) === '');
{
  const idx = indexVendors([
    { id: 9, business_name: 'Offerpad', service_type: 'Institutional seller' },
    { id: 1, business_name: 'Offerpad', service_type: 'Institutional seller' },
    { id: 4, business_name: 'Mark Spain', service_type: 'Institutional seller' },
    { id: 7, business_name: 'Complete Homes Holdings LLC', service_type: 'Wholesaler' },
  ]);
  check('Mark Spain - NC is the Mark Spain already on file', findIndexedVendor(idx, 'Mark Spain - NC')?.id === 4);
  check('CHH is Complete Homes', findIndexedVendor(idx, 'CHH')?.id === 7);
  check('duplicate Offerpad keeps the original row', findIndexedVendor(idx, 'offerpad')?.id === 1);
  check('a new spelling is stored as the known name', canonicalVendorName('Mark Spain - NC') === 'Mark Spain' && canonicalVendorName('CHH') === 'Complete Homes Holdings LLC');
}
{
  const notes = submissionNotes({ name: 'Ann Lee', phone: '4175550100', email: 'ann@k.com', submitter: 'Kingston', facts: {}, extra: {} } as never) ?? '';
  check('a partner form labels its contact, not the owner', notes.startsWith('Partner contact: Ann Lee') && !notes.includes('Owner:'), notes);
}

// Photo links: an image is a photo. A folder or a listing page is a link under photos
// (the Photos button opens it; a Drive folder is still read into its images).
{
  const folder = photoLinkRow(1, 2, 'https://drive.google.com/drive/folders/abc');
  check('Drive folder → link filed under photos', folder.kind === 'link' && folder.category === 'photos' && folder.name === 'Photos', JSON.stringify(folder));
}
check('direct image → photo', photoLinkRow(1, 2, 'https://x.com/a/front.JPG?w=1').kind === 'photo');
{
  const row = photoLinkRow(1, 2, 'https://www.markspain.com/listing/1');
  check('listing page → link filed under photos', row.kind === 'link' && 'category' in row && row.category === 'photos', JSON.stringify(row));
}
check('a malformed % in a link does not throw', photoLinkRow(1, 2, 'https://x.com/a%E0%A4%A.jpg').name.length > 0);

console.log(failed ? `\n${failed} FAILED` : '\nall import keeps-everything checks passed');
process.exit(failed ? 1 : 0);
