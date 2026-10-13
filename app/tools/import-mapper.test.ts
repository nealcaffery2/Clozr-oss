// The importer's matcher against the exports it claims to know.
//
// Pure functions, no network. Run with:  npx tsx tools/import-mapper.test.ts
// Each case is a header row the way that system actually exports it, and the
// mapping the matcher must produce without any human correction.

import { applyMapping, autoMap, parseTable, splitFullAddress } from '../lib/import';
import { parseLinks } from '../lib/deal-files';

let failed = 0;
const check = (name: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) failed++;
};

// Photo links: one cell, many links, any separator; trailing punctuation dropped, duplicates once.
{
  const got = parseLinks('https://drive.google.com/a?id=1, https://x.com/p.jpg; https://x.com/p.jpg\nsee https://companycam.com/p/9).');
  check('photo links parsed from one cell', JSON.stringify(got) === JSON.stringify(['https://drive.google.com/a?id=1', 'https://x.com/p.jpg', 'https://companycam.com/p/9']), JSON.stringify(got));
  const t = parseTable('Name,Address,Photos\nAnn,1 Main St,https://a.com/1.jpg https://a.com/2.jpg\n');
  const recs = applyMapping(t, autoMap(t));
  check('Photos column maps to photo links', recs[0]?.photos?.length === 2, JSON.stringify(recs[0]?.photos));
}
const mapOf = (csv: string) => {
  const t = parseTable(csv);
  const m = autoMap(t);
  return Object.fromEntries(t.headers.map((h, i) => [h, m[i]]));
};

// Podio "Deals" export, roughly as its CSV comes out.
const podio = mapOf(`Title,Property Address,Market,Acquisitions Rep,Related Contact,Phone,Email,Under Contract Price,ARV,Rehab Estimate,Contract Date,Notes
Under Contract Seller,"330 Vista Dr Shepherd, TX 77371",Texas,Diego Ortiz III,Karen Elaine Daniels,936-555-0142,karen@example.com,110000,60000,40000,2026-06-24,Needs full renovation`);
check('Podio: Related Contact → name', podio['Related Contact'] === 'name', podio['Related Contact']);
check('Podio: Property Address → full_address', podio['Property Address'] === 'full_address');
check('Podio: Under Contract Price → offer', podio['Under Contract Price'] === 'offer');
check('Podio: ARV / Rehab Estimate', podio['ARV'] === 'arv' && podio['Rehab Estimate'] === 'rehab');
check('Podio: Contract Date → created (a date), or kept as extra info', podio['Contract Date'] === 'created' || podio['Contract Date'] === 'extra');
check('Podio: Acquisitions Rep is no lead field: kept as extra info, not dropped', podio['Acquisitions Rep'] === 'extra', podio['Acquisitions Rep']);

// PropStream.
const ps = mapOf(`Address,City,State,Zip,Owner 1 First Name,Owner 1 Last Name,Owner Mailing Phone 1,Bedrooms,Bathrooms,Building Sqft,Year Built,APN,Estimated Value
123 Oak St,San Antonio,TX,78254,Maria,Lopez,(210) 555-0100,3,2,1580,1994,04812-000-0140,265000`);
check('PropStream: Address (with separate city) → full_address or addr', ['full_address', 'addr'].includes(ps['Address']), ps['Address']);
check('PropStream: first/last name', ps['Owner 1 First Name'] === 'first_name' && ps['Owner 1 Last Name'] === 'last_name');
check('PropStream: "Owner Mailing Phone 1" → phone', ps['Owner Mailing Phone 1'] === 'phone', ps['Owner Mailing Phone 1']);
check('PropStream: beds/baths/sqft/year/apn', ps['Bedrooms'] === 'beds' && ps['Bathrooms'] === 'baths' && ps['Building Sqft'] === 'sqft' && ps['Year Built'] === 'year' && ps['APN'] === 'apn');
// An AVM is the as-is value, not the after-repair value: it is a property fact, and it no longer opens a deal per row.
check('PropStream: Estimated Value → est. value (a property fact, not ARV)', ps['Estimated Value'] === 'est_value', ps['Estimated Value']);

// DealMachine.
const dm = mapOf(`Property Address Line 1,Property City,Property State,Property Zip,Owner Name,Phone 1,Phone 2,Lead Status,Tags
9021 Brookhollow,Dallas,TX,75204,Harold Kim,214-555-0303,214-555-0304,Hot,"probate, vacant"`);
check('DealMachine: address parts', dm['Property Address Line 1'] === 'addr' && dm['Property City'] === 'city' && dm['Property State'] === 'st' && dm['Property Zip'] === 'zip');
check('DealMachine: two phones', dm['Phone 1'] === 'phone' && dm['Phone 2'] === 'phone2', `${dm['Phone 1']} / ${dm['Phone 2']}`);
check('DealMachine: Lead Status → stage, Tags → tags', dm['Lead Status'] === 'stage' && dm['Tags'] === 'tags');

// Headers the matcher has never seen: values have to carry it.
const weird = mapOf(`Col A,Col B,Col C,Col D
Jane Roe,jane@x.com,(512) 555-0111,78701
John Roe,john@x.com,512-555-0112,78702
Amy Roe,amy@x.com,5125550113,78703`);
check('Unknown headers: email by value', weird['Col B'] === 'email', weird['Col B']);
check('Unknown headers: phone by value', weird['Col C'] === 'phone', weird['Col C']);
check('Unknown headers: zip by value', weird['Col D'] === 'zip', weird['Col D']);

// A paste from a spreadsheet is tab-separated.
const tsv = parseTable('Name\tPhone\tAddress\nA B\t210-555-0100\t1 Main St, Austin, TX 78701');
check('TSV paste: tab delimiter detected', tsv.delimiter === '\t' && tsv.headers.length === 3);

// Quoted fields with commas and embedded quotes.
const q = parseTable('Name,Notes\n"Smith, John","She said ""maybe"" — call Tuesday"');
check('CSV: quoted comma and doubled quote', q.rows[0][0] === 'Smith, John' && q.rows[0][1] === 'She said "maybe" — call Tuesday', JSON.stringify(q.rows[0]));

// applyMapping: full address splits, money parses, stage normalises.
const t = parseTable(`Seller,Address,Asking,Status
Karen Daniels,"330 Vista Dr, Shepherd, TX 77371","$110,000",Under Contract
Nobody,,,`);
const recs = applyMapping(t, autoMap(t));
check('split full address', recs[0].addr === '330 Vista Dr' && recs[0].city === 'Shepherd' && recs[0].st === 'TX' && recs[0].zip === '77371', JSON.stringify([recs[0].addr, recs[0].city, recs[0].st, recs[0].zip]));
check('money "$110,000" → 110000', recs[0].asking === 110000, String(recs[0].asking));
check('"Under Contract" → Under Contract stage', recs[0].stage === 'Under Contract', String(recs[0].stage));
check('a row with a name but nothing else still imports', recs[1].problem === null);
check('splitFullAddress without commas', splitFullAddress('330 Vista Dr Shepherd TX 77371').zip === '77371');

// Mark Spain's listing sheet: Location is the metro (the city is in the address), Link is the listing / photos.
{
  const ms = parseTable(`Address,Location,Ask price,Beds,Baths,Sq ft,Year built,Link
"1425 Canopy Lane, Rocky Mount, NC, 27804",Raleigh,200000,3,2,1526,1978,https://www.markspain.com/listing/1
"156 S Calder Ave, Newton, NC, 28658",Charlotte,250000,3,4,1495,1948,
"3917 Pond Road, Charlotte, NC, 28269",Charlotte,310000,3,2,1590,1980,`);
  const conf: Record<number, string> = {};
  const m = autoMap(ms, 'sellers', conf as never);
  const want = ['full_address', 'market', 'asking', 'beds', 'baths', 'sqft', 'year', 'photos'];
  check('Mark Spain: every column mapped', ms.headers.every((_, i) => m[i] === want[i]), JSON.stringify(m));
  check('Mark Spain: every column sure', ms.headers.every((_, i) => conf[i] === 'high'), JSON.stringify(conf));
  const r = applyMapping(ms, m)[0];
  check('Mark Spain: address split, market kept as a fact', r.addr === '1425 Canopy Lane' && r.city === 'Rocky Mount' && r.zip === '27804' && r.facts.market === 'Raleigh', JSON.stringify([r.addr, r.city, r.facts]));
  check('Mark Spain: the link imports', r.photos[0] === 'https://www.markspain.com/listing/1', JSON.stringify(r.photos));
  const li = mapOf('Name,Address,LinkedIn Profile,Zillow URL\nA,1 Main St,https://linkedin.com/in/a,https://zillow.com/h/1');
  check('LinkedIn / Zillow URL are not photo links', li['LinkedIn Profile'] !== 'photos' && li['Zillow URL'] !== 'photos', JSON.stringify(li));
  // "Location" holding the address itself is still the address.
  const loc = mapOf('Name,Location\nA,1 Main St Austin TX 78701\nB,2 Oak Ave Austin TX 78702');
  check('Location with street addresses → full address', loc['Location'] === 'full_address', loc['Location']);
}

// Podio Partnerships › Submissions export: Phone/Email with their kind, money as "- amount" / "- currency".
{
  const po = parseTable(`Property Address,First Name,Entity Name,Phone - Mobile,Email - Work,Listed on MLS?,Have you put the property on Investorlift? ,One Property or Portfolio?,Notes,Property Type,Year Build,Bedrooms,Bathrooms,Square Footage,Garage Info,Photos,What price are you asking? (Your contract price including your fee) - amount,What price are you asking? (Your contract price including your fee) - currency,Stage,ARV in your opinion - amount,Reason for selling if you have it,Last Name,Occupied?
"228 Miller Hollow Rd, Pineville, MO 64856",Ann,Kingston,(417) 555-0100,ann@kingston.com,No,Yes,One Property,Roof 2019,Single Family,1984,3,2,1450,2 car attached,https://drive.google.com/drive/folders/1EXAMPLEfolderIdForImport00000,"145,000",US,New Submission,"210,000",Tired landlord,Lee,Tenant`);
  const conf: Record<number, string> = {};
  const m = autoMap(po, 'sellers', conf as never);
  const by = Object.fromEntries(po.headers.map((h, i) => [h.trim(), m[i]]));
  const want: Record<string, string> = {
    'Property Address': 'full_address', 'First Name': 'first_name', 'Entity Name': 'submitter', 'Phone - Mobile': 'phone', 'Email - Work': 'email',
    'Listed on MLS?': 'listed_mls', 'Have you put the property on Investorlift?': 'on_investorlift', 'One Property or Portfolio?': 'portfolio',
    Notes: 'notes', 'Property Type': 'property_type', 'Year Build': 'year', Bedrooms: 'beds', Bathrooms: 'baths', 'Square Footage': 'sqft',
    'Garage Info': 'garage', Photos: 'photos', 'What price are you asking? (Your contract price including your fee) - amount': 'asking',
    'What price are you asking? (Your contract price including your fee) - currency': 'skip', Stage: 'stage', 'ARV in your opinion - amount': 'arv',
    'Reason for selling if you have it': 'motivation', 'Last Name': 'last_name', 'Occupied?': 'occupancy',
  };
  const wrong = Object.entries(want).filter(([h, t]) => by[h] !== t).map(([h, t]) => `${h}: ${by[h]} (want ${t})`);
  check('Podio Submissions: every column mapped', !wrong.length, wrong.join('; '));
  check('Podio Submissions: nothing left to check', po.headers.every((_, i) => conf[i] === 'high'), JSON.stringify(conf));
  const r = applyMapping(po, m)[0];
  check('Podio: partner, contact and asking', r.submitter === 'Kingston' && r.name === 'Ann Lee' && r.email === 'ann@kingston.com' && r.asking === 145000 && r.arv === 210000, JSON.stringify([r.submitter, r.name, r.email, r.asking, r.arv]));
  const master = parseTable(`Property Address,Vendor Entity Name\n1 Main St Austin TX 78701,Mark Spain - NC\n2 Oak Ave Dallas TX 75201,CHH`);
  const mm = autoMap(master, 'sellers');
  check('Vendor Entity Name maps to the partner, not extra', mm[1] === 'submitter', mm[1]);
  check('each row keeps its own vendor', applyMapping(master, mm).map((row) => row.submitter).join('|') === 'Mark Spain - NC|CHH');
  check('Podio: the Drive photo folder imports', r.photos[0] === 'https://drive.google.com/drive/folders/1EXAMPLEfolderIdForImport00000', JSON.stringify(r.photos));
  check('Podio: sheet facts kept', r.facts.garage === '2 car attached' && r.facts.listed_mls === false && r.facts.on_investorlift === true && r.facts.portfolio === 'One Property' && r.facts.occupancy === 'Tenant' && r.year === 1984, JSON.stringify([r.facts, r.year]));
  check('Podio: currency column not kept as extra', !Object.keys(r.extra).length, JSON.stringify(r.extra));
}

console.log(failed ? `\n${failed} FAILED` : '\nall mapper checks passed');
process.exit(failed ? 1 : 0);
