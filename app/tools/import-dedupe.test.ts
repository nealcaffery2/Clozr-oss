// Bulk import for buyers and vendors, and the duplicate review for all three.
//
// Pure functions, no network. Run with:  npx tsx tools/import-dedupe.test.ts

import { applyBuyerMapping, applyVendorMapping, autoMap, parseTable, type Confidences, type RecordKind } from '../lib/import';
import { classify, dbPhoneKey, defaultAction, isOpenDealStage, mergePatch, patchFor, planImportDeal, sameName, summarize, type Existing } from '../lib/import-dedupe';

let failed = 0;
const check = (name: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) failed++;
};
const mapOf = (csv: string, kind: RecordKind) => {
  const t = parseTable(csv);
  const conf: Confidences = {};
  const m = autoMap(t, kind, conf);
  return { t, m, byHeader: Object.fromEntries(t.headers.map((h, i) => [h, m[i]])), conf: Object.fromEntries(t.headers.map((h, i) => [h, conf[i]])) };
};

// ---- buyers ----
const b = mapOf(`Buyer Name,Company,Phone,Email,Buyer Type,Markets,Min Price,Max Price,Buy Box,Website,VIP,Tags,Notes,ID
Maria Lopez,Lopez Holdings LLC,(210) 555-0100,MARIA@lopez.com,Flipper,"San Antonio, 78254, TX",$80K,$350K,3/2 SFR under 1990,lopez.com,yes,"cash, fast",Closes in 10 days,IL-991`, 'buyers');
check('buyers: name/company/phone/email', b.byHeader['Buyer Name'] === 'name' && b.byHeader['Company'] === 'company' && b.byHeader['Phone'] === 'phone' && b.byHeader['Email'] === 'email', JSON.stringify(b.byHeader));
check('buyers: buyer type, markets, min/max price', b.byHeader['Buyer Type'] === 'buyer_type' && b.byHeader['Markets'] === 'markets' && b.byHeader['Min Price'] === 'min_price' && b.byHeader['Max Price'] === 'max_price');
check('buyers: buy box, website, vip, tags, notes, id', b.byHeader['Buy Box'] === 'buy_box' && b.byHeader['Website'] === 'website' && b.byHeader['VIP'] === 'vip' && b.byHeader['Tags'] === 'tags' && b.byHeader['Notes'] === 'notes' && b.byHeader['ID'] === 'source_id');
check('buyers: exact headers are high confidence', b.conf['Buyer Name'] === 'high' && b.conf['Max Price'] === 'high');
const br = applyBuyerMapping(b.t, b.m)[0];
check('buyers: $80K / $350K parse', br.min_price === 80000 && br.max_price === 350000, `${br.min_price} ${br.max_price}`);
check('buyers: markets split, type coded, vip, email lowercased', br.markets.length === 3 && br.buyer_type === 'flipper' && br.vip === true && br.email === 'maria@lopez.com', JSON.stringify(br));

const realtors = mapOf(`Buyer Name,Buyer Type,Markets\nDana Cho,Realtors,Dallas`, 'buyers');
const realtorRow = applyBuyerMapping(realtors.t, realtors.m)[0];
check('buyers: Realtors codes to realtors', realtorRow.buyer_type === 'realtors' && realtorRow.markets[0] === 'Dallas', JSON.stringify(realtorRow));
const singular = mapOf(`Name,Buyer Type\nDana,Realtor`, 'buyers');
check('buyers: Realtor singular uses the realtors slug', applyBuyerMapping(singular.t, singular.m)[0].buyer_type === 'realtors');

const range = mapOf(`Investor,Price Range,Target Areas
Sam,"$100K - $250K",Dallas`, 'buyers');
const rr = applyBuyerMapping(range.t, range.m)[0];
check('buyers: "Investor" → name, one price range column carries both ends', range.byHeader['Investor'] === 'name' && rr.min_price === 100000 && rr.max_price === 250000, JSON.stringify([range.byHeader, rr.min_price, rr.max_price]));
check('buyers: seller-only fields are not offered (Address → skip)', mapOf(`Name,Property Address\nA,1 Main St`, 'buyers').byHeader['Property Address'] !== 'full_address');

const dg = mapOf(`customer_id,full_name,company_name,phone,email,type,strategy,property_type,min_price,max_price,min_bedroom,min_year_build,finance_type,timeline_to_close,notification_method,dnd,no_follow_ups,is_blacklist,remarks,tags,no_hoa,req_garage
abc,Gina Marsh,Landshark,(956) 555-0173,,vetted_buyer,Fix n' Flip,Single Family Residential,80000,350000,3,1980,Hard Money,21+ Days,Email & SMS,1,0,0,Pays cash,vetted buyer,1,1`, 'buyers');
check('dispogenius: contact + buy box headers', dg.byHeader['full_name'] === 'name' && dg.byHeader['company_name'] === 'company' && dg.byHeader['customer_id'] === 'source_id' && dg.byHeader['strategy'] === 'strategy' && dg.byHeader['property_type'] === 'property_type' && dg.byHeader['min_bedroom'] === 'min_beds' && dg.byHeader['min_year_build'] === 'min_year' && dg.byHeader['finance_type'] === 'funding' && dg.byHeader['dnd'] === 'wants_calls' && dg.byHeader['type'] === 'vetted', JSON.stringify(dg.byHeader));
check('dispogenius: no_hoa / req_garage are restriction chips, not notes', dg.byHeader['no_hoa'] === 'restrictions' && dg.byHeader['req_garage'] === 'requirements' && dg.byHeader['remarks'] === 'notes');
const dgr = applyBuyerMapping(dg.t, dg.m)[0];
check('dispogenius: strategy/type/chips/dnd/vetted', dgr.strategies[0] === 'fix_and_flip' && dgr.property_types[0] === 'single_family' && dgr.buyer_type === 'flipper' && dgr.min_beds === 3 && dgr.min_year === 1980 && dgr.funding[0] === 'hard_money' && dgr.timeline === 21 && dgr.restrictions.includes('hoa') && dgr.requirements.includes('garage') && dgr.wants_calls === false && dgr.vetted === true && dgr.source_id === 'abc', JSON.stringify(dgr));

// ---- vendors ----
const v = mapOf(`Business Name,Contact Name,Phone,Email,Service Type,Service Area,Notes
Alamo Title,Jen Park,210-555-0199,jen@alamotitle.com,Title Company,San Antonio,Fast closer`, 'vendors');
check('vendors: business, contact, phone, email', v.byHeader['Business Name'] === 'name' && v.byHeader['Contact Name'] === 'contact_name' && v.byHeader['Phone'] === 'phone' && v.byHeader['Email'] === 'email', JSON.stringify(v.byHeader));
check('vendors: service type, area, notes', v.byHeader['Service Type'] === 'service_type' && v.byHeader['Service Area'] === 'markets' && v.byHeader['Notes'] === 'notes');
const vr = applyVendorMapping(v.t, v.m)[0];
check('vendors: record', vr.name === 'Alamo Title' && vr.contact_name === 'Jen Park' && vr.markets[0] === 'San Antonio' && vr.problem === null);
check('vendors: "Company" / "Type" headers', (() => { const x = mapOf('Company,Type\nACME Roofing,Roofer', 'vendors').byHeader; return x['Company'] === 'name' && x['Type'] === 'service_type'; })());

// ---- duplicate review ----
const existing: Existing[] = [
  { id: 1, name: 'Karen Daniels', phone: '+19365550142', email: null, address: 'k:330scenic', sourceId: null, propertyId: 50, show: [] },
  { id: 2, name: 'Ronald Moore', phone: null, email: 'ron@x.com', address: 'k:1803cypress', sourceId: 'P-7', propertyId: 51, show: [] },
];
const rows = [
  { name: 'Karen E. Daniels', phone: '(936) 555-0142', email: null, address: null, sourceId: null }, // 0 phone match
  { name: 'Ron Moore', phone: null, email: 'RON@x.com', address: null, sourceId: null }, // 1 email match
  { name: 'Someone', phone: null, email: null, address: null, sourceId: 'P-7' }, // 2 record id match
  { name: 'Karen Daniels', phone: null, email: null, address: 'k:330scenic', sourceId: null }, // 3 same address, same name
  { name: 'Luis Ortega', phone: null, email: null, address: 'k:1803cypress', sourceId: null }, // 4 same address, different seller
  { name: 'New Person', phone: '512-555-0000', email: null, address: 'k:new', sourceId: null }, // 5 new
  { name: 'New P.', phone: '5125550000', email: null, address: null, sourceId: null }, // 6 dup of 5 in file
  { name: 'Other', phone: null, email: null, address: 'k:new', sourceId: null }, // 7 same address as 5 in file
];
const m = classify(rows, existing);
check('dedupe: phone match against CLOZR', m[0].kind === 'existing' && m[0].id === 1 && m[0].by === 'phone', JSON.stringify(m[0]));
check('dedupe: email match is case-insensitive', m[1].kind === 'existing' && m[1].id === 2 && m[1].by === 'email');
check('dedupe: record id match (sync)', m[2].kind === 'existing' && m[2].id === 2 && m[2].by === 'record id');
check('dedupe: same address + same name is the same seller', m[3].kind === 'existing' && m[3].by === 'address');
check('dedupe: same address, different name is a conflict on that property', m[4].kind === 'conflict' && m[4].id === 2 && m[4].propertyId === 51, JSON.stringify(m[4]));
check('dedupe: a new row is new', m[5].kind === 'new');
check('dedupe: in-file phone duplicate points at the first row', m[6].kind === 'file' && m[6].row === 5 && m[6].by === 'phone', JSON.stringify(m[6]));
check('dedupe: in-file address duplicate', m[7].kind === 'file' && m[7].row === 5 && m[7].by === 'address');

const actions = m.map(defaultAction);
check('defaults: new creates, a repeat in the file skips', actions[5] === 'create' && actions[6] === 'skip' && actions[7] === 'skip');
check('defaults: a record CLOZR already has is never skipped silently — it waits for a choice', [0, 1, 2, 3].every((i) => actions[i] === null), JSON.stringify(actions));
check('defaults: an address conflict needs a choice', actions[4] === null);
const sum = summarize(m, actions);
check('summary: matches and conflicts are unresolved until chosen', sum.create === 1 && sum.unresolved === 5 && sum.skipped === 2, JSON.stringify(sum));
// The bulk choice ("Add new info to them") sets every existing match at once; conflicts still need their own.
const chosen = actions.map((a, i) => (m[i].kind === 'existing' ? 'fill' as const : a));
const sum2 = summarize(m, chosen);
check('summary: after the bulk choice only the conflict is open', sum2.updates === 4 && sum2.unresolved === 1, JSON.stringify(sum2));
const skipAll = actions.map((a, i) => (m[i].kind === 'existing' ? 'skip' as const : m[i].kind === 'conflict' ? 'skip' as const : a));
check('summary: Skip them is an explicit choice', summarize(m, skipAll).unresolved === 0 && summarize(m, skipAll).skipped === 7);
check('sameName loose match', sameName('Karen Elaine Daniels', 'karen daniels') && !sameName('Luis Ortega', 'Ronald Moore') && sameName('Owner of 1 Main St', 'Anyone'));

const cur = { email: null, phone: '+15125550000', notes: 'typed by a rep', tags: [] as string[] };
const inc = { email: 'a@b.com', phone: '+15125559999', notes: 'from file', tags: ['probate'], criteria: { a: 1 } };
check('patch fill: only blanks', JSON.stringify(patchFor(cur, inc, 'fill')) === JSON.stringify({ email: 'a@b.com', tags: ['probate'] }), JSON.stringify(patchFor(cur, inc, 'fill')));
check('patch overwrite: every changed non-empty value, never objects', JSON.stringify(patchFor(cur, inc, 'overwrite')) === JSON.stringify({ email: 'a@b.com', phone: '+15125559999', notes: 'from file', tags: ['probate'] }), JSON.stringify(patchFor(cur, inc, 'overwrite')));

// ---- the shared merge (import and Quick Add) ----
const tagged = { tags: ['vip', 'Probate'], notes: 'called twice', email: 'old@x.com', motivation: null };
const more = { tags: ['probate', 'june list'], notes: 'from file', email: 'new@x.com', motivation: 'tired landlord' };
check('mergePatch fill: blanks filled, tags added (case-insensitive), notes appended',
  JSON.stringify(mergePatch(tagged, more, 'fill')) === JSON.stringify({ motivation: 'tired landlord', tags: ['vip', 'Probate', 'june list'], notes: 'called twice\nfrom file' }),
  JSON.stringify(mergePatch(tagged, more, 'fill')));
check('mergePatch overwrite: values replaced, tags and notes still only added to',
  JSON.stringify(mergePatch(tagged, more, 'overwrite')) === JSON.stringify({ email: 'new@x.com', motivation: 'tired landlord', tags: ['vip', 'Probate', 'june list'], notes: 'called twice\nfrom file' }),
  JSON.stringify(mergePatch(tagged, more, 'overwrite')));
check('mergePatch: a note already there is not appended again', !('notes' in mergePatch({ notes: 'x\nfrom file' }, { notes: 'from file' }, 'fill')));
check('mergePatch: blank incoming never blanks anything', JSON.stringify(mergePatch({ email: 'a@b.com', tags: ['x'], notes: 'n' }, { email: '', tags: [], notes: '  ' }, 'overwrite')) === '{}');
check('mergePatch: empty record gets the incoming notes and tags as they are', JSON.stringify(mergePatch({ tags: null, notes: null }, { tags: ['a', 'a'], notes: 'hi' }, 'fill')) === JSON.stringify({ tags: ['a'], notes: 'hi' }));

// ---- phone as the database keys it (normalize_phone) ----
check('dbPhoneKey: 10 digits are US', dbPhoneKey('(210) 555-0100') === '+12105550100');
check('dbPhoneKey: 11 digits with the country code', dbPhoneKey('1-210-555-0100') === '+12105550100' && dbPhoneKey('+1 210 555 0100') === '+12105550100');
check('dbPhoneKey: other plausible lengths kept, implausible ones do not key', dbPhoneKey('+44 20 7946 0958') === '+442079460958' && dbPhoneKey('555-0100') === null && dbPhoneKey('') === null && dbPhoneKey(null) === null);

// ---- a matched seller's deal ----
check('open deal stages', isOpenDealStage('Under Contract Seller') && isOpenDealStage('Prospect') && !isOpenDealStage('Closed') && !isOpenDealStage('Terminated') && !isOpenDealStage('Realtor Referral'));
const row = { arv: 250000, rehab: 40000, offer: null, photos: ['https://x/1.jpg'] };
const openDeal = { id: 9, stage: 'Under Contract Seller', arv: 240000, rehab: null, offer_amount: 150000 };
const closedDeal = { id: 3, stage: 'Closed', arv: 100000, rehab: 1, offer_amount: 1 };
const fillPlan = planImportDeal(row, [openDeal, closedDeal], 'fill');
check('deal fill: the open deal gets only its empty numbers', fillPlan.kind === 'update' && fillPlan.dealId === 9 && JSON.stringify(fillPlan.patch) === JSON.stringify({ rehab: 40000 }) && fillPlan.photos.length === 1, JSON.stringify(fillPlan));
const overPlan = planImportDeal(row, [closedDeal, openDeal], 'overwrite');
check('deal overwrite: the open deal (not the newer closed one) takes every number the row has', overPlan.kind === 'update' && overPlan.dealId === 9 && JSON.stringify(overPlan.patch) === JSON.stringify({ arv: 250000, rehab: 40000 }), JSON.stringify(overPlan));
check('deal: an offer the row lacks is never blanked', overPlan.kind === 'update' && !('offer_amount' in overPlan.patch));
const makePlan = planImportDeal(row, [], 'fill');
check('deal: a seller with no deal gets one with the row numbers', makePlan.kind === 'create' && makePlan.fields.arv === 250000 && makePlan.fields.offer_amount === null, JSON.stringify(makePlan));
const closedPlan = planImportDeal(row, [closedDeal], 'overwrite');
check('deal: a seller with only closed deals keeps their numbers; photos go to the latest', closedPlan.kind === 'closed' && closedPlan.dealId === 3, JSON.stringify(closedPlan));
check('deal: a row with no numbers or photos does nothing', planImportDeal({ arv: null, rehab: null, offer: null, photos: [] }, [openDeal], 'overwrite').kind === 'none');

console.log(failed ? `\n${failed} FAILED` : '\nall import dedupe checks passed');
process.exit(failed ? 1 : 0);
