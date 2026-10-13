// Public records through Claude: the deed, owner and listing normalizers, and
// the ATTOM owner reader across assessment/detail and property/detailowner.
// No network: the agent's answers are fixtures shaped like the schemas.
//
//   npx tsx tools/records-agent.test.ts

import { attomOwnerName, mapAttom } from '../supabase/functions/_shared/genius-core';
import { normalizeAgentDeeds, normalizeListing, normalizeOwner } from '../supabase/functions/_shared/records-agent';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ---- deeds ------------------------------------------------------------------------------------------
const deeds = normalizeAgentDeeds({
  index_url: 'https://clevelandcounty-rod.example/search',
  note: null,
  transactions: [
    { grantor: 'Carolina Acme Homes LLC', grantee: 'Smith Rentals LLC', date: '03/14/2026', price: '$142,000', address: '12 Oak St, Shelby NC', doc_type: 'DEED', instrument: '2026-1234', source_url: null },
    { grantor: 'Carolina Acme Homes LLC', grantee: 'Smith Rentals LLC', date: '2026-03-14', price: 142000, address: null, doc_type: 'DEED', instrument: '2026-1234', source_url: null },
    { grantor: 'Somebody Else', grantee: 'Jones', date: '2026-01-01', price: null, address: null, doc_type: null, instrument: null, source_url: null },
    { grantor: 'CAROLINA ACME HOMES', grantee: 'carolina acme homes', date: '2026-02-01', price: null, address: null, doc_type: null, instrument: null, source_url: null },
    { grantor: '', grantee: 'X', date: null, price: null, address: null, doc_type: null, instrument: null, source_url: null },
  ],
}, 'Cleveland', 'nc', ['Carolina Acme Homes LLC']);
eq('deeds: one row per instrument, strangers and self-deeds dropped', deeds.transactions.length, 1);
eq('deeds: US date to ISO', deeds.transactions[0]?.date, '2026-03-14');
eq('deeds: price parsed from a money string', deeds.transactions[0]?.price, 142000);
eq('deeds: state upper case', deeds.transactions[0]?.state, 'NC');
eq('deeds: source falls back to the index page', deeds.transactions[0]?.source_url, 'https://clevelandcounty-rod.example/search');
eq('deeds: garbage in, empty out', normalizeAgentDeeds(null, 'X', 'NC', ['A']).transactions, []);

// ---- owner ------------------------------------------------------------------------------------------
const o = normalizeOwner({ owner: '  JOHN  Q DOE ', owner2: null, mailing: '344 Copper Ridge, Shelby NC 28150', last_sale_date: '7/1/2019', last_sale_price: '189,500', parcel_id: '12345', source_url: 'not a url', note: null });
eq('owner: spaces collapsed', o.owner, 'JOHN Q DOE');
eq('owner: sale date to ISO', o.last_sale_date, '2019-07-01');
eq('owner: sale price parsed', o.last_sale_price, 189500);
eq('owner: a bad URL is dropped', o.source_url, null);

// ---- listing ----------------------------------------------------------------------------------------
const l = normalizeListing({ listing_url: 'https://www.redfin.com/x', photo_urls: ['https://ssl.cdn-redfin.com/a.jpg', 'https://ssl.cdn-redfin.com/a.jpg', 'https://x.com/page', 'ftp://bad.jpg'], remarks: 'Fully renovated', renovated: true, confidence: 4, signals: ['new LVP', '', 'quartz counters'] });
eq('listing: photos deduped, only image URLs', l.photo_urls, ['https://ssl.cdn-redfin.com/a.jpg']);
eq('listing: confidence clamped', l.confidence, 1);
eq('listing: empty signals dropped', l.signals, ['new LVP', 'quartz counters']);
eq('listing: unknown verdict is null', normalizeListing({ renovated: 'maybe' }).renovated, null);

// ---- ATTOM owner ------------------------------------------------------------------------------------
// The shape this account's assessment/detail sends (no owner block), then property/detailowner's.
const assessmentNoOwner = { identifier: { attomId: 1 }, assessment: { market: { mktttlvalue: 210000 } } };
const detailOwner = { owner: { corporateIndicator: 'N', owner1: { lastNameAndSuffix: 'DOE', firstNameAndMi: 'JOHN Q' }, mailingAddressOneLine: '344 COPPER RIDGE, SHELBY, NC 28150', absenteeOwnerStatus: 'O' } };
eq('attom: no owner on the assessment reads as blank', attomOwnerName(assessmentNoOwner), '');
eq('attom: detailowner name from first and last', attomOwnerName(detailOwner), 'JOHN Q DOE');
const sale = { identifier: { attomId: 1 }, address: { line1: '344 COPPER RIDGE', locality: 'SHELBY', countrySubd: 'nc', postal1: '28150' }, sale: { saleTransDate: '2025-05-01', amount: { saleamt: 250000 } } };
const hit = mapAttom(sale, { ...assessmentNoOwner, owner: detailOwner.owner });
check('attom: mapAttom finds the owner placed at the top', !!hit.owner && /DOE/i.test(hit.owner.name), hit.owner);
eq('attom: mailing from detailowner', hit.owner_mailing, '344 COPPER RIDGE, SHELBY, NC 28150');
eq('attom: market value still read from the assessment', hit.est_value, 210000);
eq('attom: owner-occupied flag read', hit.absentee, false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
