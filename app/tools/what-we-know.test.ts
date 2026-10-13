// What we know rows for a disposition form.  Run: npx tsx tools/what-we-know.test.ts
import { dueDiligence, whatWeKnowFields } from '../lib/what-we-know';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

const base = {
  motivation: 'Seller is motivated', timeline: '—', condition: '—', occupancy: 'Yes - Occupied by Owner',
  mortgage: '—', asking: '$925,000', desiredClose: 'September 30, 2026', decisionMakers: '—',
  property: { beds: 0, baths: 2.5, sqft: 3134, year: 1976, type: 'Single Family' },
  intake: {
    entity: 'A.B.C Exit Holdings', disposition: 'Request Disposition', portfolio: 'One Property',
    notes: 'Gate code 1234', garage: 'Garage spaces: 2',
    photos: 'https://drive.google.com/drive/folders/12yd', arv: 1600000, rehab: 300000,
    mls: 'No', investorlift: 'No', contract: 'https://example.com/contract.pdf',
  },
};

const rows = whatWeKnowFields(base);
const by = Object.fromEntries(rows.map((r) => [r.field, r.v]));
eq('entity', by['intake.entity'], 'A.B.C Exit Holdings');
eq('arv: the form\'s until COMPR runs', by['deal.arv'], '$1,600,000');
eq('rehab: the form\'s until COMPR runs', by['deal.rehab'], '$300,000');
eq('arv is read-only', !!rows.find((r) => r.field === 'deal.arv')?.readOnly, true);
eq('due diligence first', rows.slice(0, 4).map((r) => r.field), ['condition', 'motivation', 'asking_price', 'timeline']);
eq('due diligence done count', dueDiligence(rows), { done: 2, of: 4 });
eq('asking edits as a number', rows.find((r) => r.field === 'asking_price')?.value, 925000);
eq('one notes field', rows.filter((r) => /notes/.test(r.field)).map((r) => r.field), ['notes']);
eq('form notes shown under it', rows.find((r) => r.field === 'notes')?.note, 'From the form: Gate code 1234');
eq('sqft', by['property.sqft'], '3,134');
eq('year', by['property.year'], '1976');
eq('beds empty', by['property.beds'], '—');
eq('baths', by['property.baths'], '2.5');
eq('occupied', by.occupancy, 'Yes - Occupied by Owner');
eq('reason', by.motivation, 'Seller is motivated');
eq('contract', by['intake.contract'], 'https://example.com/contract.pdf');
eq('blank location', by['intake.location'], '—');

const fromDeal = whatWeKnowFields({ ...base, intake: { arv: 1 } }, { arv: 900000, rehab: null });
eq('the deal\'s arv wins', fromDeal.find((r) => r.field === 'deal.arv')?.v, '$900,000');
eq('no form note once COMPR has it', fromDeal.find((r) => r.field === 'deal.arv')?.note, undefined);

const noAddress = whatWeKnowFields({
  ...base,
  property: { beds: 0, baths: 0, sqft: 0, year: 0, type: '—' },
  intake: { ...base.intake, beds: 3, baths: 2.5, sqft: 3134, year_built: 1976, property_type: 'Single Family' },
});
const bare = Object.fromEntries(noAddress.map((r) => [r.field, r.v]));
eq('beds from intake when the property is empty', bare['property.beds'], '3');
eq('sqft from intake', bare['property.sqft'], '3,134');
eq('year from intake', bare['property.year'], '1976');
eq('type from intake', bare['property.type'], 'Single Family');

console.log(failed ? `${failed} what-we-know failures` : 'all what-we-know checks passed');
if (failed) process.exit(1);
