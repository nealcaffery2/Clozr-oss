// The ingest deal mapper.  Run:  deno run supabase/functions/_shared/ingest-deal.test.ts
import { dealColumns, dealLinks, hasDealFacts, ilikeExact, nameIsAddress } from './ingest-deal.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

eq('columns: money strings, aliases, blanks left out', dealColumns({
  asking_price: '$150,000', contract_price: 140000, arv: 250000, rehab: '', dispo_fee: '12,500',
  lead_source: ' InvestorLift ', transaction_type: '', notes: 'Nice flip', unknown: 5,
}), { asking_price: 150000, offer_amount: 140000, arv: 250000, dispo_fee: 12500, lead_source: 'InvestorLift', notes: 'Nice flip' });
eq('columns: nothing', dealColumns(undefined), {});

eq('links: photos deduped, non-http dropped, listing as link', dealLinks({
  photos: ['https://img/1.jpg', 'https://img/1.jpg', 'javascript:alert(1)', 'ftp://x', 'https://img/2.jpg'],
  listing_url: 'https://investorlift.com/marketplace/deal/abc',
}), [
  { kind: 'photo', name: 'Photo 1', url: 'https://img/1.jpg' },
  { kind: 'photo', name: 'Photo 2', url: 'https://img/2.jpg' },
  { kind: 'link', name: 'Listing', url: 'https://investorlift.com/marketplace/deal/abc' },
]);

eq('facts: motivation alone is a contact fact, not a deal', hasDealFacts({ motivation: 'relocating', notes: 'x' }), false);
eq('facts: an ARV is', hasDealFacts({ arv: 1 }), true);
eq('facts: a photo is', hasDealFacts({ photos: ['https://a/b.jpg'] }), true);

eq('name: street address', nameIsAddress('1420 Mesa Verde Dr'), true);
eq('name: same as line1', nameIsAddress('1420 mesa verde', '1420 Mesa Verde'), true);
eq('name: company', nameIsAddress('Offerpad'), false);
eq('name: company with a number', nameIsAddress('7 Figure Homes LLC'), false);
eq('ilike literal', ilikeExact('a_b%c\\d'), 'a\\_b\\%c\\\\d');

if (failed) {
  console.log(`${failed} failed`);
  Deno.exit(1);
}
console.log('ingest-deal: all passed');
