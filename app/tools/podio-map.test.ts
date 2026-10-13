// The Podio importer's guesses and readers against the shapes Podio returns.
//
// Pure functions, no network. Run with:  npx tsx tools/podio-map.test.ts
// The field list is a Deals app the way Acme Homes' Podio deal sheet is laid
// out (migration 19); the values are Podio's documented item value shapes.

import {
  type PodioField, clozrStage, dealColumns, guessMapping, parseAddress, personFromItem, phoneKey, readAddress, readPeople, sellerStageFor,
} from '../supabase/functions/_shared/podio-map';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

let n = 0;
const f = (label: string, type: string): PodioField => ({ field_id: ++n, external_id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type, label });
const fields: PodioField[] = [
  f('Title', 'text'), f('Stage', 'category'), f('Property Address', 'location'), f('Seller', 'app'), f('Acquisitions Rep', 'contact'),
  f('Under Contract Price', 'money'), f('ARV', 'money'), f('Rehab Estimate', 'money'), f('Earnest Money', 'money'), f('Earnest Money Lost', 'money'),
  f('Contract Date', 'date'), f('Option Period Ends', 'date'), f('Close Date', 'date'), f('Closed On', 'date'),
  f('Dispo Rep', 'contact'), f('Dispo Rep 2', 'contact'), f('Buyer', 'app'), f("Buyer's Agent", 'app'), f('Sold Price', 'money'),
  f('Transaction Coordinator', 'contact'), f('Title Company', 'app'), f('Title Contact', 'text'), f('Title Email', 'email'), f('Title Phone', 'phone'),
  f('Photographer', 'app'), f('Photos', 'money'), f('Wholesaler', 'app'), f('Listing Agent', 'app'), f('Realtor', 'app'),
  f('Occupancy Status', 'category'), f('Condition', 'text'), f('Notes', 'text'), f('Lockbox', 'money'), f('LAC %', 'number'),
];
const m = guessMapping(fields);
const is = (target: string, label: string) => check(`${label} → ${target}`, m[target] === fields.find((x) => x.label === label)!.external_id, m[target]);

is('stage', 'Stage');
is('address', 'Property Address');
is('seller', 'Seller');
is('acquisitions', 'Acquisitions Rep');
is('offer_amount', 'Under Contract Price');
is('arv', 'ARV');
is('rehab', 'Rehab Estimate');
is('earnest_money', 'Earnest Money');
is('cogs_earnest_lost', 'Earnest Money Lost');
is('contract_date', 'Contract Date');
is('option_ends_on', 'Option Period Ends');
is('close_date', 'Close Date');
is('closed_on', 'Closed On');
is('dispositions', 'Dispo Rep');
is('dispositions2', 'Dispo Rep 2');
is('buyer', 'Buyer');
is('buyers_agent', "Buyer's Agent");
is('sold_price', 'Sold Price');
is('tc', 'Transaction Coordinator');
is('title_company', 'Title Company');
is('title_contact', 'Title Contact');
is('title_email', 'Title Email');
is('title_phone', 'Title Phone');
is('photographer', 'Photographer');
is('cogs_photos', 'Photos');
is('wholesaler', 'Wholesaler');
is('listing_agent', 'Listing Agent');
is('realtor', 'Realtor');
is('occupancy_notes', 'Occupancy Status');
is('condition_notes', 'Condition');
is('notes', 'Notes');
is('cogs_lockbox', 'Lockbox');
is('lac_pct', 'LAC %');
check('the Podio "Title" text field is not the title company', !Object.values(m).includes('title'));
check('each Podio field is used once', new Set(Object.values(m)).size === Object.values(m).length);

// Stages.
check('Under Contract Seller', clozrStage('Under Contract Seller') === 'Under Contract Seller');
check('In Escrow', clozrStage('In Escrow') === 'In Escrow');
check('Under Contract Buyer → Buyer Under Contract', clozrStage('Under Contract Buyer') === 'Buyer Under Contract');
check('"UC - Buyer" by contains', clozrStage('UC - Buyer') === 'Buyer Under Contract');
check('"under contract - seller" case-insensitive', clozrStage('under contract - seller') === 'Under Contract Seller');
check('Closed and Dead', clozrStage('Closed') === 'Closed' && clozrStage('Dead Deal') === 'Terminated');
check('New Lead has no deal stage', clozrStage('New Lead') === null);
check('seller stage for In Escrow', sellerStageFor('In Escrow') === 'Under Contract - Buyer');

// Values.
const item = {
  item_id: 9, title: '330 Vista Dr',
  fields: [
    { external_id: m.address, type: 'location', values: [{ value: '330 Vista Dr, Shepherd, TX 77371, USA', street_number: '330', street_address: 'Vista Dr', city: 'Shepherd', state: 'TX', postal_code: '77371', formatted: '330 Vista Dr, Shepherd, TX 77371, USA' }] },
    { external_id: m.offer_amount, type: 'money', values: [{ value: '110000.0000', currency: 'USD' }] },
    { external_id: m.contract_date, type: 'date', values: [{ start: '2026-06-24 00:00:00', start_date: '2026-06-24' }] },
    { external_id: m.notes, type: 'text', values: [{ value: '<p>Needs full <b>renovation</b></p>' }] },
    { external_id: m.occupancy_notes, type: 'category', values: [{ value: { id: 3, text: 'Vacant' } }] },
    { external_id: m.seller, type: 'app', values: [{ value: { item_id: 501, title: 'Karen Daniels', app: { app_id: 77 } } }, { value: { item_id: 502, title: 'Ron Daniels', app: { app_id: 77 } } }] },
    { external_id: m.acquisitions, type: 'contact', values: [{ value: { profile_id: 42, user_id: 8, name: 'Diego Ortiz III', mail: ['diego@acmehomes.com'], phone: ['9365550142'] } }] },
    { external_id: m.title_contact, type: 'text', values: [{ value: 'Courtney Hale' }] },
  ],
};
const cols = dealColumns(item, m);
check('money column', cols.offer_amount === 110000, cols.offer_amount);
check('date column', cols.contract_date === '2026-06-24', cols.contract_date);
check('html stripped from notes', cols.notes === 'Needs full renovation', cols.notes);
check('category into a text column', cols.occupancy_notes === 'Vacant');
check('unmapped columns are left out, not nulled', !('arv' in cols));
const addr = readAddress(item.fields[0]);
check('location parts', addr?.line1 === '330 Vista Dr' && addr.city === 'Shepherd' && addr.state === 'TX' && addr.zip === '77371', addr);
const text = parseAddress('1803 Cypress Lane, Houston, TX 77008');
check('text address parts', text?.line1 === '1803 Cypress Lane' && text.city === 'Houston' && text.state === 'TX' && text.zip === '77008', text);
const sellers = readPeople(item.fields[5]);
check('two referenced sellers', sellers.length === 2 && sellers[0].source_id === 'item:501' && sellers[1].name === 'Ron Daniels' && sellers[0].app_id === 77, sellers);
const acq = readPeople(item.fields[6])[0];
check('contact profile → email/phone', acq.source_id === 'profile:42' && acq.email === 'diego@acmehomes.com' && acq.phone === '9365550142', acq);
check('free-text person', readPeople(item.fields[7])[0]?.name === 'Courtney Hale');
const ref = personFromItem({ title: 'Northvale Title', fields: [
  { type: 'text', label: 'Contact Name', values: [{ value: 'Courtney' }] },
  { type: 'phone', label: 'Phone', values: [{ type: 'work', value: '+19725550100' }] },
  { type: 'email', label: 'Email', values: [{ type: 'work', value: 'closings@northvale.com' }] },
  { type: 'text', label: 'Company', values: [{ value: 'Northvale Title LLC' }] },
] });
check('referenced item → details', ref.name === 'Northvale Title' && ref.phone === '+19725550100' && ref.email === 'closings@northvale.com' && ref.company === 'Northvale Title LLC', ref);
check('phone key like normalize_phone', phoneKey('(936) 555-0142') === '+19365550142' && phoneKey('1-936-555-0142') === '+19365550142' && phoneKey('555') === null);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
