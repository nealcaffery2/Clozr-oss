// The buyer lists mapper (Podio xlsx + DispoGenius CSV + Buyer Locations): names, dedupe, buy box, SQL. Pure, no network.
//
//   npx tsx tools/buyers-excel.test.ts

import { buildPlan, buyerSql, cleanName, compatibleNames, findTarget, insertRow, patchFor, type ExistingBuyer } from '../lib/buyers-excel';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

check('placeholder surname dropped', cleanName('Darnell Null') === 'Darnell' && cleanName('Jacob Dillon?') === 'Jacob Dillon');
check('same person, typos', compatibleNames('Mathew Brandt', 'Matthew Brandt') && compatibleNames('Roy T McInley', 'Roy Mclinley') && compatibleNames('Quinn Brown', 'Quinn Unk'));
check('spouses and partners stay apart', !compatibleNames('Pedro Ruiz', 'Selene Ruiz') && !compatibleNames('Juana Rios', 'Juan Vargas') && !compatibleNames('Sam Carter', 'Benny Buyer (sam)'));

const base = { 'Buyer Status': 'Buyer', 'Strategy': "Fix n' Flip,Buy n' Hold,Subto,Addition Plays", 'Property Type': 'Single Family Residential,Manufactured Homes,Town House' };
const plan = buildPlan({ podio: [
  { ...base, 'Buyer Name': 'Darnell Null', 'Buyer Phone Number - Home': '+13145550170', 'Market State': 'Texas', 'Market City': 'San Antonio', 'Mark': 'Bexar County',
    'Buyer Market Location Type': 'City', 'Buying Locations 2': 'San Antonio', 'Buying Locations 3': 'Texas', 'Max Price': 500000, 'Min Year Build': 1900, 'Max Year Build': 2024,
    'Min Sqft': 10000, 'Max Sqft': 10000, 'Min Bedrooms': '2', 'Min Bathroom': 'Any', 'Who Created the buyer? - name': 'Morgan Lane', 'Who Created the buyer? - mail': 'morgan@yourcompany.com' },
  { 'Buyer Status': 'A-List Buyer', 'Buyer Name': 'Darnell', 'Buyer Phone Number - Work': '(314) 555-0170', 'Buyer Email - Home': "O'Neil@Example.com", 'Buyer Notes': 'Pays fast',
    'Buying Locations 1 - City': 'Houston', 'Buying Locations 1 - State': 'Texas', 'Buyer Bought Address': '1 Main St, Houston, TX' },
  { ...base, 'Buyer Name': 'Selene Ruiz', 'Buyer Phone Number - Home': '3145550170' },
  { 'Buyer Name': 'Drew Collins', 'Company Name': 'Amherst', 'Buyer Phone Number - Home': '2105550100' },
  { 'Buyer Name': 'Dana Cole', 'Company Name': 'Amherst', 'Buyer Phone Number - Home': '2105550199' },
  { 'Buyer Name': 'NULL' },
] });
const j = plan.buyers.find((b) => b.name === 'Darnell')!;
check('6 rows → 4 buyers, 1 folded, 1 skipped', plan.buyers.length === 4 && plan.merges.length === 1 && plan.skipped.length === 1, [plan.buyers.length, plan.merges.length, plan.skipped.length]);
check('merged on E.164 phone, keeps both rows data', !!j && j.rows.join() === 'podio row 2,podio row 3' && j.phone === '+13145550170' && j.email === "o'neil@example.com" && j.vip && /Pays fast/.test(j.notes ?? '') && /Past purchase/.test(j.notes ?? ''));
check('markets: city at Podio granularity + Buying Locations 1', JSON.stringify(j.criteria.location_prefs) === JSON.stringify([{ name: 'San Antonio', type: 'city', state: 'TX', restricted: false }, { name: 'Houston', type: 'city', state: 'TX', restricted: false }]), j.criteria.location_prefs);
check('folded buy-area states from city prefs', j.criteria.locations.states.join() === 'TX', j.criteria.locations.states);
check('strategies, types, unmapped strategy to criteria notes', j.criteria.strategies.join() === 'fix_and_flip,buy_and_hold,subject_to' && j.criteria.property_types.join() === 'single_family,mobile_home,townhouse' && /Addition Plays/.test(j.criteria.notes ?? ''));
check('price kept, junk sqft/year defaults dropped, beds 2 / baths Any', j.max_purchase_price === 500000 && j.criteria.sqft.min == null && j.criteria.sqft.max == null && j.criteria.year_built.min == null && j.criteria.beds.min === 2 && j.criteria.baths.min == null);
check('shared phone, different person kept apart and listed', plan.buyers.some((b) => b.name === 'Selene Ruiz') && plan.review.keptApart.length === 1);
check('same company, different names stay apart', plan.buyers.filter((b) => b.company === 'Amherst').length === 2);
check('tags, status, creator', j.tags.join() === 'podio-buyers,A-List Buyer' && j.status === 'active' && j.created_by_email === 'morgan@yourcompany.com');
const sql = buyerSql(j, 11);
check('SQL escapes quotes and is guarded against duplicates', sql.includes("'o''neil@example.com'") && sql.includes('where not exists (select 1 from t)') && sql.includes("b.source in ('podio', 'dispogenius') and b.source_id = any(v.source_ids)"));
check('source_id stable across runs', buildPlan({ podio: [{ 'Buyer Name': 'A B', 'Buyer Phone Number - Home': '2105550100' }] }).buyers[0].source_id === buildPlan({ podio: [{ 'Buyer Name': 'A B', 'Buyer Phone Number - Home': '(210) 555-0100' }] }).buyers[0].source_id);

// ---- DispoGenius + Buyer Locations fold into the same buyers
const dg = { customer_id: 'abc123', full_name: 'Mathew Brandt', first_name: 'Mathew', last_name: 'Brandt', company_name: 'NULL', email: 'NULL', phone: '+16365550171',
  type: 'vetted_buyer', max_price: '250000', min_price: 'No Min', min_sqft: 'No Min', max_sqft: 'No Max', min_year_build: 'No Min', max_year_build: 'No Max', min_bedroom: '3', min_bathroom: 'Any',
  strategy: "Buy n' Hold", property_type: 'Single Family Residential', tags: 'vetted buyer,prospecting', is_active: '1', is_blacklist: '0', is_deleted: '0', dnd: '1', no_follow_ups: '0',
  notification_method: 'Email & SMS', finance_type: 'Hard Money', timeline_to_close: '21+ Days', no_hoa: '1', req_garage: '1', buyer_added: '2025-11-21' };
const both = buildPlan({
  dispogenius: [dg, { ...dg, customer_id: 'gone', full_name: 'Deleted Person', phone: '+12105550000', is_deleted: '1' }],
  podio: [{ 'Buyer Name': 'Matthew Brandt', 'Company Name': 'Blue Ridge Assets LLC', 'Buyer Phone Number - Home': '(636) 555-0171', 'Max Price': 500000, 'Min Bedrooms': '2',
    'Market State': 'Missouri', 'Market City': 'St. Louis', 'Buyer Market Location Type': 'City' }],
  locations: [
    { full_name: 'Mathew Brandt', phone: '+16365550171', address: 'St. Charles, MO 63301, USA', city: 'St. Charles', county: 'St. Charles County', state: 'Missouri', restrict: 0, type: 'Zip Code' },
    { full_name: 'Mathew Brandt', phone: 'NULL', address: 'St. Louis, MO, USA', city: 'St. Louis', county: 'NULL', state: 'Missouri', restrict: 0, type: 'City' },
    { full_name: 'Nobody Here', phone: 'NULL', address: 'Texas, USA', city: 'NULL', county: 'NULL', state: 'Texas', restrict: 1, type: 'State' },
  ],
});
const m = both.buyers[0];
check('DispoGenius + Podio → one buyer, deleted row skipped', both.buyers.length === 1 && both.skipped.length === 1 && both.skipped[0].reason === 'deleted in DispoGenius', [both.buyers.length, both.skipped]);
check('DispoGenius id is the source id; Podio hash kept for re-runs', m.source === 'dispogenius' && m.source_id === 'dispogenius:abc123' && m.source_ids.length === 2);
check('DispoGenius wins single values; company from Podio', m.max_purchase_price === 250000 && m.criteria.beds.min === 3 && m.company === 'Blue Ridge Assets LLC');
check('contact prefs and flags', !m.wants_calls && m.wants_follow_ups && m.preferred_channel === 'email_and_sms' && m.vetted_at === '2025-11-21' && m.tags.includes('dnd') && m.tags.includes('prospecting'));
check('no_/req_ flags, funding, timeline', m.criteria.restrictions.join() === 'hoa' && m.criteria.requirements.join() === 'garage' && m.criteria.economics.funding?.join() === 'hard_money' && m.criteria.timeline_days === 21);
check('locations: zip added, duplicate city folded', JSON.stringify(m.criteria.location_prefs.map((p) => `${p.type}:${p.name}`)) === JSON.stringify(['city:St. Louis', 'zip:63301']), m.criteria.location_prefs);
check('location stats: 1 by phone, 1 by name, 1 unmatched with reason', both.locations.byPhone === 1 && both.locations.byName === 1 && both.locations.unmatched[0]?.reason === 'no phone, and no buyer with this name', both.locations);
check('SQL matches either source id and applies do-not-call', buyerSql(m, 11).includes('b.source_id = any(v.source_ids)') && buyerSql(m, 11).includes('wants_calls = b.wants_calls and v.wants_calls'));

// ---- test records, and --apply's matching (same rules as the SQL)
const withTest = buildPlan({ podio: [{ 'Buyer Name': 'Sam Carter', 'Buyer Phone Number - Home': '2175550172' }, { 'Buyer Name': 'Lena Ward', 'Buyer Email - Work': 'lward@acmehomesgroup.com' }] });
check('owner-confirmed test record excluded; look-alike only listed', withTest.buyers.map((b) => b.name).join() === 'Lena Ward' && withTest.excluded[0]?.name === 'Sam Carter' && withTest.review.possibleTests[0]?.name === 'Lena Ward', [withTest.excluded, withTest.review.possibleTests]);

const ex = (o: Partial<ExistingBuyer>): ExistingBuyer => ({ id: 1, name: 'X', company: null, phone: null, phone_key: null, email: null, source: null, source_id: null, buyer_type: null, website: null, notes: null,
  buy_box: null, min_purchase_price: null, max_purchase_price: null, criteria: {}, markets: [], status: 'active', preferred_channel: 'email_and_sms', tags: [], vip: false, vetted_at: null,
  blacklisted_at: null, wants_calls: true, wants_follow_ups: true, ...o });
const now = '2026-01-01T00:00:00.000Z';
check('apply: earlier-run row wins over a phone match', findTarget([ex({ id: 5, phone_key: m.phone }), ex({ id: 9, source: 'podio', source_id: m.source_ids[1] })], m)?.row.id === 9);
check('apply: never fills another imported buyer (shared phone, different person)', findTarget([ex({ id: 5, phone_key: m.phone, source: 'podio', source_id: 'buyers-list:someoneelse' })], m) === null);
const drew = ex({ id: 6, name: 'Drew Collins', company: 'Amherst', notes: 'keep me' });
const fill = patchFor(drew, { ...m, name: 'Drew Collins', company: 'Amherst' }, false, now);
check('apply: existing buyer only filled, notes kept, do-not-call applied, source untouched', findTarget([drew], { ...m, phone: null, email: null, name: 'Drew Collins', company: 'Amherst' })?.ours === false
  && fill.notes === undefined && fill.phone === m.phone && fill.wants_calls === false && fill.source === undefined && (fill.tags as string[]).includes('dispogenius'), fill);
const again = ex({ ...insertRow(m, 11, null, now), id: 7 } as never);
check('apply: re-run of an unchanged buyer patches nothing', Object.keys(patchFor(again, m, true, now)).length === 0, patchFor(again, m, true, now));

const xl = buildPlan({
  dispogenius: [{ ...dg, customer_id: 'xlsx1', full_name: 'Gina Marsh', phone: '19565550173', dnd: 1, is_active: 0, no_hoa: 1, is_deleted: 0 }],
  locations: [{ full_name: 'Gina Marsh', phone: '19565550173', address: 'Hidalgo County, TX, USA', city: '', county: 'Hidalgo County', STATE: 'Texas', restrict: 0, type: 'County' }],
});
const gina = xl.buyers[0];
check('xlsx numbers and STATE header', !!gina && !gina.wants_calls && gina.status === 'inactive' && gina.criteria.restrictions.includes('hoa')
  && gina.criteria.location_prefs.some((p) => p.type === 'county' && p.name === 'Hidalgo County' && p.state === 'TX'), gina && { wants_calls: gina.wants_calls, status: gina.status, restrictions: gina.criteria.restrictions, locs: gina.criteria.location_prefs });

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
