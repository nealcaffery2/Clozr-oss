// Genius Mode v2 rules.  Run:  deno run supabase/functions/_shared/genius-core.test.ts
// (or, without Deno:  node --experimental-strip-types supabase/functions/_shared/genius-core.test.ts)
import {
  type Hit, type Subject, applyDetail, buildBuyers, dropRetailEndBuyers, eventsOf, isEntity, mapHit, matchKnown, mapSkipBatch, mapSkipReapi, ownerFrom, ownerKey,
  parseFilters, salePrice, searchPlans, skipTarget, splitPeople, type Source, mapAttom, mergeAttom, tagSources,
} from './genius-core.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

const NOW = new Date('2026-09-22T12:00:00Z');
const subject: Subject = {
  address: '123 Rigsby Ave', city: 'San Antonio', state: 'TX', zip: '78210', lat: 29.4, lng: -98.47, reapi_id: '1',
  beds: 3, baths: 2, sqft: 1400, year_built: 1950, property_type: 'SFR', est_value: 200000, suggested_rent: 1600,
  arv: 220000, price: 150000, deal_id: null,
};
const row = (over: Record<string, unknown>) => ({
  id: Math.floor(Math.random() * 1e9), address: { street: '1 Test St', city: 'San Antonio', state: 'TX', zip: '78210' },
  latitude: 29.401, longitude: -98.471, propertyType: 'SFR', bedrooms: 3, bathrooms: 2, squareFeet: 1300, yearBuilt: 1955,
  lastSaleDate: '2026-03-01', lastSaleAmount: 0, lastSaleArmsLength: true, ...over,
});
const f = parseFilters({ radius_mi: 2, months: 24, kinds: ['flipper', 'landlord'] });

// ---- names ----
eq('married couple is people, not an entity', ownerFrom('Marlow, Elizabeth; Marlow, Sid'),
  { name: 'Elizabeth & Sid Marlow', entity: false, people: ['Elizabeth Marlow', 'Sid Marlow'] });
eq('an LLC is an entity', ownerFrom('ACME HOMES LLC')?.entity, true);
eq('entity words match whole words only ("Ralph" is not LP)', isEntity('Ralph Hollis'), false);
eq('person keys ignore order', ownerKey('Elizabeth Marlow', false), ownerKey('Marlow Elizabeth', false));
eq('entity keys drop the suffix', ownerKey('Acme Homes, L.L.C.', true), ownerKey('ACME HOMES LLC', true));
eq('splitPeople refuses entities', splitPeople('Smith Family Trust'), null);

// ---- bug 1: non-disclosure ----
eq('no recorded price → MLS sold price', salePrice(null, '2026-03-01', 180000, '2026-02-20'), { price: 180000, source: 'mls' });
eq('no price anywhere → null, not dropped', salePrice(null, '2026-03-01', null, null), { price: null, source: null });
eq('$10 quitclaim is not a price', mapHit(row({ lastSaleAmount: 10 })).last_sale_amount, null);
{
  const h = mapHit(row({ companyName: 'Lone Star Rentals LLC', corporateOwned: true, absenteeOwner: true, ownerOccupied: false }));
  const ev = eventsOf(h, f, subject, NOW);
  eq('a TX investor purchase with $0 recorded is kept', ev.length, 1);
  eq('...tagged non-disclosure with a null price', [ev[0].purchase.price, ev[0].purchase.non_disclosure], [null, true]);
}

// ---- bug 3: classification ----
{
  // Flipped: bought 2025-06 by an LLC, resold 2026-03 to a homeowner.
  const h = mapHit(row({
    owner1FirstName: 'Jane', owner1LastName: 'Retail', ownerOccupied: true, absenteeOwner: false,
    priorOwner: 'Quick Flip Properties LLC', priorOwnerMonthsOwned: 9, priorSaleDate: '2025-06-01', priorSaleAmount: 120000, lastSaleAmount: 235000,
  }));
  const ev = eventsOf(h, f, subject, NOW);
  eq('the flipper is the prior owner, not the retail buyer', ev.map((e) => [e.owner.name, e.purchase.role]), [['Quick Flip Properties LLC', 'flip']]);
  eq('...with buy, resale and days held', [ev[0].purchase.price, ev[0].purchase.resale_price, ev[0].purchase.days_held], [120000, 235000, 273]);
}
{
  // Same flip, but the end buyer is an LLC, so the investor rule would also keep them.
  const h = mapHit(row({
    companyName: 'Retail Holdings LLC', corporateOwned: true, ownerOccupied: false, absenteeOwner: true,
    priorOwner: 'Quick Flip Properties LLC', priorOwnerMonthsOwned: 9, priorSaleDate: '2025-06-01', priorSaleAmount: 120000, lastSaleAmount: 235000,
  }));
  const both = eventsOf(h, f, subject, NOW);
  eq('a corporate end buyer is kept until Homefull', both.map((e) => e.owner.name), ['Quick Flip Properties LLC', 'Retail Holdings LLC']);
  const hf = parseFilters({ homefull: true, kinds: ['landlord', 'builder'], strategy: 'rental' });
  eq('homefull forces flippers and a flip exit', [hf.homefull, hf.kinds, hf.strategy], [true, ['flipper'], 'flip']);
  eq('found_via is kept', parseFilters({ found_via: 'buyr' }).found_via, 'buyr');
  eq('an unknown found_via is dropped', parseFilters({ found_via: 'scraped' }).found_via, null);
  eq('homefull keeps the flipper, not the retail llc', eventsOf(h, hf, subject, NOW).map((e) => e.owner.name), ['Quick Flip Properties LLC']);
  const hold = mapHit(row({ companyName: 'Hold Co LLC', corporateOwned: true, ownerOccupied: false }));
  eq('homefull drops a landlord who is still holding', eventsOf(hold, hf, subject, NOW).length, 0);
  const relist = mapHit(row({ id: 11, companyName: 'Retail Holdings LLC', corporateOwned: true, ownerOccupied: false, mlsActive: true, mlsListingDate: '2026-06-01', lastSaleAmount: 235000 }));
  const flipOnly = mapHit(row({
    id: 11, owner1FirstName: 'Jane', owner1LastName: 'Retail', ownerOccupied: true,
    priorOwner: 'Quick Flip Properties LLC', priorOwnerMonthsOwned: 9, priorSaleDate: '2025-06-01', priorSaleAmount: 120000, lastSaleAmount: 235000,
  }));
  const named = buildBuyers([flipOnly, relist], hf, subject, [], new Map(), NOW).map((c) => c.owner_name);
  eq('homefull drops the retail buyer even when a second search row lists them', named, ['Quick Flip Properties LLC']);
  eq('dropRetailEndBuyers leaves a flip in progress alone', dropRetailEndBuyers(eventsOf(mapHit(row({ companyName: 'Hold Co LLC', corporateOwned: true, ownerOccupied: false, mlsActive: true, mlsListingDate: '2026-06-01' })), hf, subject, NOW)).length, 1);
}
{
  const h = mapHit(row({ owner1FirstName: 'Tom', owner1LastName: 'Mover', priorOwner: 'Pat Homeowner', priorOwnerMonthsOwned: 16, ownerOccupied: true }));
  eq('an individual who sold after 16 months with no margin evidence is not a flipper', eventsOf(h, f, subject, NOW).length, 0);
}
{
  const h = mapHit(row({ companyName: 'Hold Co LLC', corporateOwned: true, ownerOccupied: false, mlsActive: true, mlsListingDate: '2026-06-01' }));
  eq('an investor who re-listed after buying is a flip in progress', eventsOf(h, f, subject, NOW)[0].purchase.role, 'flip');
}
{
  const h = mapHit(row({ companyName: 'Hold Co LLC', corporateOwned: true, ownerOccupied: false }));
  eq('an investor still holding is a hold', eventsOf(h, f, subject, NOW)[0].purchase.role, 'hold');
  const d = applyDetail(h, { mlsHistory: [{ type: 'Rental', status: 'Leased', statusDate: '2026-05-01' }] });
  eq('detail: a rental listing after purchase is seen', d.rented_after_purchase, true);
}
{
  const h = mapHit(row({ companyName: 'Build It LLC', corporateOwned: true, ownerOccupied: false, yearBuilt: 2026 }));
  eq('built after purchase → builder', eventsOf(h, f, subject, NOW)[0].purchase.role, 'build');
}
{
  const h = mapHit(row({ owner1FirstName: 'Sam', owner1LastName: 'Owner', ownerOccupied: true, absenteeOwner: false }));
  eq('an owner-occupant is nobody', eventsOf(h, f, subject, NOW).length, 0);
}
{
  const h = mapHit(row({ companyName: 'Kin LLC', corporateOwned: true, ownerOccupied: false, lastSaleArmsLength: false }));
  eq('non-arm\'s-length sale dropped by default', eventsOf(h, f, subject, NOW).length, 0);
  eq('...and kept when asked for', eventsOf(h, parseFilters({ include_non_arms_length: true }), subject, NOW).length, 1);
}

// ---- grouping, exclusions, % of ARV ----
{
  const hits: Hit[] = [
    mapHit(row({ id: 1, companyName: 'Acme Homes LLC', corporateOwned: true, ownerOccupied: false, lastSaleAmount: 150000 })),
    mapHit(row({ id: 2, companyName: 'ACME HOMES, L.L.C.', corporateOwned: true, ownerOccupied: false, lastSaleAmount: 160000, lastSaleDate: '2026-08-01' })),
    mapHit(row({ id: 3, companyName: 'Equity Trust Company Custodian FBO J Doe IRA', corporateOwned: true, ownerOccupied: false })),
    mapHit(row({ id: 4, companyName: 'Cartus Financial Corp', corporateOwned: true, ownerOccupied: false })),
    mapHit(row({ id: 5, companyName: 'Invitation Homes 5 LP', corporateOwned: true, ownerOccupied: false })),
    mapHit(row({ id: 6, companyName: 'Big Lot LLC', corporateOwned: true, ownerOccupied: false, propertyType: 'LAND', lastSaleAmount: 3700000 })),
  ];
  const out = buildBuyers(hits, f, subject, [], new Map(), NOW);
  eq('one buyer per owner however spelled; custodian, relocation and institutional out; land out without Builder',
    out.map((c) => [c.owner_name, c.purchase_count]), [['Acme Homes LLC', 2]]);
  eq('% of ARV is sane', out[0].pct_of_arv, 71);
  const withInst = buildBuyers(hits, parseFilters({ ...f, include_institutional: true }), subject, [], new Map(), NOW);
  eq('institutional shows when asked', withInst.some((c) => c.institutional), true);
  eq('an outlier purchase has no % of ARV', buildBuyers([mapHit(row({ companyName: 'X LLC', corporateOwned: true, ownerOccupied: false, lastSaleAmount: 3450000 }))], f, subject, [], new Map(), NOW)[0].pct_of_arv, null);
}

// ---- matching to our buyers ----
{
  const c = buildBuyers([mapHit(row({ owner1FirstName: 'Dale', owner1LastName: 'Sutton', absenteeOwner: true, ownerOccupied: false }))], f, subject, [], new Map(), NOW);
  const m = matchKnown(c, [{ id: 7, name: 'Sutton Dale', company: null, email: null, phone_keys: [], contact_names: [] }]);
  eq('person matched regardless of name order', [m[0].matched_buyer_id, m[0].match_by], [7, 'name']);
  const byPhone = matchKnown([{ ...c[0], owner_name: 'Nobody', people: ['Nobody Here'], contacts: [{ name: null, phones: [{ number: '(210) 555-0101', type: 'Wireless', dnc: false, score: null }], emails: [], mailing: null }] }],
    [{ id: 9, name: 'Someone Else', company: null, email: null, phone_keys: ['2105550101'], contact_names: [] }]);
  eq('matched by a skip-traced phone', [byPhone[0].matched_buyer_id, byPhone[0].match_by], [9, 'phone']);
}

// ---- bug 2: filters go to REAPI ----
{
  const plans = searchPlans(parseFilters({ radius_mi: 2, months: 24, kinds: ['flipper', 'landlord'] }), 29.4, -98.47, NOW);
  eq('no LAND search without Builder', plans.some((p) => p.body.property_type === 'LAND'), false);
  eq('arm\'s-length pushed down', plans.every((p) => p.body.last_sale_arms_length === true), true);
  eq('investor signals are separate searches', plans.filter((p) => p.body.property_type === 'SFR').map((p) => p.label),
    ['flip:SFR', 'investor:SFR', 'corporate:SFR', 'absentee:SFR']);
  eq('builder brings LAND in', parseFilters({ kinds: ['builder'] }).property_types.includes('LAND'), true);
  eq('a new search is SFR only', JSON.stringify(parseFilters({}).property_types), JSON.stringify(['SFR']));
}

// ---- skip trace ----
eq('RealEstateAPI DNC string parsed conservatively', mapSkipReapi({ persons: [{ fullName: 'A B', phones: [{ phone: '2105550101', phoneFtcDnc: 'Y' }, { phone: '2105550102', phoneFtcDnc: 'N' }] }] })[0].phones.map((p) => p.dnc), [true, false]);
eq('a RealEstateAPI no-match is no hits', mapSkipReapi({ persons: [] }), []);
{
  // One result.data item, as BatchData's v3 skip trace returns it.
  const answer = (over: Record<string, unknown> = {}) => ({
    input: { requestId: '0' },
    property: { mailingAddress: { fullAddress: '1 Fallback Rd, Austin, TX 78701' } },
    persons: [{
      propertyOwner: true,
      name: { first: 'Jo', middle: 'Q', last: 'Doe', full: 'Jo Doe' },
      addresses: [
        { fullAddress: '500 Maple Ave, Hempstead, NY 11550', propertyMailingAddress: false, rank: 2 },
        { fullAddress: '9 Office Rd, Austin, TX 78701', propertyMailingAddress: true, rank: 1 },
      ],
      phones: [
        { rank: 1, number: '2105550101', type: 'Mobile', dnc: false, tcpa: false },
        { rank: 2, number: '2105550102', type: 'Land Line', dnc: true, tcpa: false },
        { rank: 3, number: '2105550103', type: 'Land Line', dnc: false, tcpa: true },
        { rank: 4, number: '', type: 'Mobile', dnc: false, tcpa: false },
      ],
      emails: [{ rank: 1, email: 'jo@doe.co', tested: true }],
      litigator: false, deceased: false,
      ...over,
    }],
    meta: { matched: true, error: false },
  });
  const [h] = mapSkipBatch(answer());
  eq('BatchData answer maps to a hit', [h.name, h.emails, h.mailing, h.phones.length, h.phones[0].type, h.phones[0].score],
    ['Jo Doe', ['jo@doe.co'], '9 Office Rd, Austin, TX 78701', 3, 'Mobile', null]);
  eq('DNC and TCPA phones stay listed, marked DNC', h.phones.map((p) => p.dnc), [false, true, true]);
  eq('every phone of a litigator is DNC', mapSkipBatch(answer({ litigator: true }))[0].phones.map((p) => p.dnc), [true, true, true]);
  eq('every phone of a deceased person is DNC', mapSkipBatch(answer({ deceased: true }))[0].phones.map((p) => p.dnc), [true, true, true]);
  eq('a genuine no-match is no hits', mapSkipBatch({ persons: [], meta: { matched: false, error: false } }), []);
  eq('an item error is no hits, never a no-match', mapSkipBatch({ persons: [{ name: { full: 'A B' }, phones: [{ number: '2105550101' }] }], meta: { matched: true, error: true } }), []);
  eq('a person with no phone or email is no hit', mapSkipBatch({ persons: [{ name: { full: 'A B' }, phones: [], emails: [] }], meta: { matched: true } }), []);
  eq('each matched person is its own hit', mapSkipBatch({ persons: [{ name: { full: 'A B' }, phones: [{ number: '2105550101' }] }, { name: { full: 'C D' }, emails: [{ email: 'c@d.co' }] }], meta: { matched: true } }).map((x) => x.name), ['A B', 'C D']);
  eq('a person with no address falls back to the property mailing address', mapSkipBatch({ ...answer(), persons: [{ name: { full: 'A B' }, phones: [{ number: '2105550101' }] }] })[0].mailing, '1 Fallback Rd, Austin, TX 78701');
}

{
  const c = buildBuyers([mapHit(row({ companyName: 'Acme Homes LLC', corporateOwned: true, ownerOccupied: false, mailAddress: { street: '9 Office Rd', city: 'Austin', state: 'TX', zip: '78701' } }))], f, subject, [], new Map(), NOW)[0];
  eq('an entity goes to BatchData', skipTarget(c)?.provider, 'batchdata');
  eq('an entity is traced at its mailing address, with no name', skipTarget(c)?.body, { propertyAddress: { street: '9 Office Rd', city: 'Austin', state: 'TX', zip: '78701' } });
  const target = (mail_parts: Record<string, string> | null) => skipTarget({ key: 'k', owner_name: 'Jo Doe', corporate: false, people: ['Jo Doe'], mail_parts: mail_parts as never, mailing: null, purchases: [] });
  eq('street + zip alone is traceable', target({ address: '5 Home Ln', city: '', state: '', zip: '78702' })?.body.propertyAddress, { street: '5 Home Ln', zip: '78702' });
  eq('street + city + state alone is traceable', target({ address: '5 Home Ln', city: 'Austin', state: 'TX', zip: '' })?.body.propertyAddress, { street: '5 Home Ln', city: 'Austin', state: 'TX' });
  eq('a street with no zip, city or state costs nothing', target({ address: '5 Home Ln', city: '', state: '', zip: '' }), null);
  eq('zip+4 is sent as 5 digits but keyed as it always was', [target({ address: '5 Home Ln', city: '', state: '', zip: '78702-1234' })?.body.propertyAddress.zip, target({ address: '5 Home Ln', city: '', state: '', zip: '78702-1234' })?.owner_key], ['78702', 'k|5 home ln 78702 1234']);
  const person = skipTarget({ key: 'k', owner_name: 'Jo Doe', corporate: false, people: ['Jo Doe'], mail_parts: { address: '5 Home Ln', city: 'Austin', state: 'TX', zip: '78702' }, mailing: null, purchases: [] });
  eq('an individual goes to RealEstateAPI', person?.provider, 'reapi');
  eq('RealEstateAPI gets its own body, by name', person?.reapi, { address: '5 Home Ln', city: 'Austin', state: 'TX', zip: '78702', first_name: 'Jo', last_name: 'Doe' });
  eq('a person is traced by name at their mailing address',
    skipTarget({ key: 'k', owner_name: 'Jo Doe', corporate: false, people: ['Jo Doe'], mail_parts: { address: '5 Home Ln', city: 'Austin', state: 'TX', zip: '78702' }, mailing: null, purchases: [] })?.body,
    { propertyAddress: { street: '5 Home Ln', city: 'Austin', state: 'TX', zip: '78702' }, name: { first: 'Jo', last: 'Doe' } });
}

// ---- ATTOM, side by side ----
{
  const sale = (id: number, line1: string, over: Record<string, unknown> = {}) => ({
    identifier: { attomId: id }, address: { line1, locality: 'SAN ANTONIO', countrySubd: 'TX', postal1: '78210' },
    location: { latitude: '29.401', longitude: '-98.471' }, summary: { propType: 'SFR', propSubType: 'SINGLE FAMILY RESIDENCE', yearBuilt: 1955 },
    building: { rooms: { beds: 3, bathsTotal: 2 }, size: { universalSize: 1380 } },
    sale: { saleTransDate: '2026-03-14', amount: { saleAmt: 182000, saleTransType: 'Resale' } }, ...over,
  });
  const owner = (name: string, corp = false) => ({ assessment: { owner: { corporateIndicator: corp ? 'Y' : 'N', owner1: { fullName: name }, mailingAddressOneLine: '9 OFFICE RD, AUSTIN, TX 78701', absenteeOwnerStatus: 'ABSENTEE (MAIL AND SITUS NOT =)' } } });
  const a1 = mapAttom(sale(11, '1 TEST ST'), owner('ACME HOMES LLC', true));
  eq('ATTOM sale maps to a hit', [a1.reapi_id, a1.address, a1.zip, a1.property_type, a1.last_sale_amount, a1.last_sale_date, a1.owner?.entity, a1.absentee], ['attom:11', '1 TEST ST', '78210', 'SFR', 182000, '2026-03-14', true, true]);
  eq('ATTOM quitclaim is not a buyer', mapAttom(sale(12, '2 TEST ST', { sale: { saleTransDate: '2026-03-14', amount: { saleAmt: 0, saleTransType: 'Quit Claim' } } }), owner('Jo Doe')).arms_length, false);
  // REAPI already has 1 Test St (same street and ZIP, spelled differently): one property, found by both.
  const hits = new Map([['500', mapHit(row({ id: 500, companyName: 'Acme Homes LLC', corporateOwned: true, lastSaleDate: '2026-03-14', lastSaleAmount: 182000 }))]]);
  const sources = new Map<string, Set<Source>>();
  const a2 = mapAttom(sale(13, '77 ELM ST'), owner('Bob Smith'));
  const m = mergeAttom(hits, [a1, a2, a2], sources);
  eq('same property is matched, not added', m, { added: 1, matched: 1 });
  eq('one hit per property', hits.size, 2);
  eq('sources per property', [...sources.get('500')!].sort(), ['attom', 'reapi']);
  const cands = tagSources(buildBuyers([...hits.values()], f, subject, [], new Map(), NOW), sources);
  const acme = cands.find((c) => c.owner_name.toLowerCase().startsWith('acme'));
  eq('Acme is one buyer, found by both', [cands.filter((c) => c.owner_name.toLowerCase().startsWith('acme')).length, acme?.sources], [1, ['attom', 'reapi']]);
}

if (failed) { console.log(`\n${failed} failed`); (globalThis as { Deno?: { exit(n: number): void } }).Deno?.exit(1); (globalThis as { process?: { exitCode: number } }).process && ((globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1); }
else console.log('\nall passed');
