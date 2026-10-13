// Run: npx tsx tools/prospect-lists.test.ts
import { isBuyerProspect, isDmProspect, prospectListId } from '../lib/prospect-lists';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('real buyer stays put', prospectListId(['cash'], 'Active', 'Manual'), null);
eq('buyr tag', prospectListId(['buyer-prospect'], 'Prospect', 'buyr'), 'buyer-prospect');
eq('capital tag', prospectListId(['Capital-Raise-Prospect'], 'Active', null), 'capital-raise-prospect');
eq('realtors tag sits on its own list', prospectListId(['realtors'], 'Active', null), 'realtors');
eq('buyer type Realtors files the list without a tag', prospectListId([], 'Active', 'import', { buyerType: 'realtors' }), 'realtors');
eq('singular realtor type uses the same list', prospectListId([], 'Active', 'import', { buyerType: 'realtor' }), 'realtors');
eq('vetted realtor stays on the realtors list', prospectListId(['realtors'], 'Active', 'import', { vetted: true }), 'realtors');
eq('genius source, not yet vetted', prospectListId(['genius'], 'Active', 'genius'), 'buyer-prospect');
eq('investorbase source waits on buyer prospects', prospectListId(['investorbase'], 'Prospect', 'investorbase'), 'buyer-prospect');
eq('vetted genius is a real buyer', prospectListId(['genius', 'buyer-prospect'], 'Active', 'genius', { vetted: true }), null);
eq('vip stays on the buyer list', prospectListId(['buyer-prospect'], 'Prospect', 'buyr', { vip: true }), null);
eq('inactive is not a prospect list', prospectListId(['buyer-prospect'], 'Inactive', 'buyr'), null);
eq('status Prospect defaults to buyer prospects', prospectListId([], 'Prospect', 'Manual'), 'buyer-prospect');

eq('campaign skip on tag', isBuyerProspect(['buyer-prospect'], 'Active', 'Manual'), true);
eq('campaign skip on capital raise tag', isBuyerProspect(['capital-raise-prospect'], 'Active', 'Manual'), true);
eq('campaign skip on genius source', isBuyerProspect(['genius'], 'Active', 'genius'), true);
eq('realtors tag is not a holding pen', isBuyerProspect(['realtors'], 'Active', 'import'), false);
eq('worked buyer is not skipped', isBuyerProspect([], 'Active', 'Manual'), false);

eq('deal machine source', isDmProspect('deal_machine', []), true);
eq('dm tag', isDmProspect('Manual', ['dm-prospect']), true);
eq('other lead', isDmProspect('talkr', ['Hot']), false);

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('prospect-lists: all passed');
