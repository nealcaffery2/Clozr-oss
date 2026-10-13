// The flat (Zapier / Jotform) mapper.  Run:  deno run supabase/functions/_shared/flat.test.ts
import { type FlatEnvelope, flatToEnvelope, jotAnswersFromApi, jotAnswersFromRaw, jotformToFlat } from './flat.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}
const env = (r: ReturnType<typeof flatToEnvelope>) => r as FlatEnvelope;

// lead.create — flat Zapier fields, aliases and money strings.
const lead = env(flatToEnvelope('zapier', {
  event: 'lead.create', 'First Name': 'Kara', last_name: 'Mitchell', Phone: '(210) 555-0136', email: 'KARA@example.com',
  address: '123 Oakview Dr', city: 'San Antonio', state: 'TX', zip: '78254', asking_price: '$235,000',
  tags: 'facebook, hot', stage: 'Lead', lead_source: 'FB ads',
}, 'z1'));
eq('lead mode', lead.mode, 'lead');
eq('lead person', lead.person, { name: 'Kara Mitchell', phone: '(210) 555-0136', email: 'kara@example.com' });
eq('lead property', lead.property, { line1: '123 Oakview Dr', city: 'San Antonio', state: 'TX', zip: '78254' });
eq('lead price', lead.deal?.asking_price, 235000);
eq('lead tags', lead.lead, { stage: 'Lead', tags: ['facebook', 'hot'] });
eq('lead source in notes', lead.deal?.notes, 'Lead source: FB ads');

// Unknown event and an empty lead are refused, not guessed.
eq('bad event', 'error' in flatToEnvelope('zapier', { event: 'lead.delete' }, 'x'), true);
eq('empty lead', 'error' in flatToEnvelope('zapier', { event: 'lead.create' }, 'x'), true);
// A Zap whose mapped fields were empty sends "//" and ", ": that is an empty lead too, not a person named "//".
eq('punctuation-only lead', 'error' in flatToEnvelope('zapier', { event: 'wholesaler.create', name: '//', address: '//', city: ' , ', lead_source: 'X (Zapier)' }, 'x'), true);

// email.opened attaches only; it never carries a name or property to create from.
const open = env(flatToEnvelope('zapier', { event: 'email.opened', email: 'Kara@Example.com', subject: 'Your offer' }, 'o1'));
eq('open mode', open.mode, 'attach');
eq('open person', open.person, { email: 'kara@example.com' });
eq('open activity', open.activity, { kind: 'email_open', title: 'Opened: Your offer' });
eq('attach needs contact', 'error' in flatToEnvelope('zapier', { event: 'note.add', body: 'hi' }, 'x'), true);

// buyer.create
const buyer = env(flatToEnvelope('zapier', { event: 'buyer.create', name: 'Ace Homes', budget: '300k', markets: ['78254', '78209'] }, 'b1'));
eq('buyer', buyer.buyer, { name: 'Ace Homes', markets: ['78254', '78209'], max_purchase_price: 300000 });

// Jotform webhook: rawRequest JSON string, standard widgets plus custom questions.
const raw = JSON.stringify({
  slug: 'submit/123', q3_fullName: { first: 'Luis', last: 'Ortega' }, q4_phoneNumber: { full: '(512) 555-0188' },
  q5_email: 'luis@example.com', q6_address: { addr_line1: '9 Elm St', addr_line2: '', city: 'Austin', state: 'TX', postal: '78701' },
  q7_askingPrice: '180000', q8_whyAre: 'Divorce', q9_timeline: 'ASAP', q10_propertyCondition: 'Needs roof',
});
const jf = jotformToFlat(jotAnswersFromRaw(raw), { submissionId: '5812', formTitle: 'Sell My House' });
eq('jot flat', jf, {
  event: 'lead.create', external_id: '5812', lead_source: 'Jotform: Sell My House', first_name: 'Luis', last_name: 'Ortega',
  phone: '(512) 555-0188', email: 'luis@example.com', address: '9 Elm St', city: 'Austin', state: 'TX', zip: '78701',
  asking_price: 180000, timeline: 'ASAP', condition: 'Needs roof', notes: 'Why Are: Divorce',
});
const je = env(flatToEnvelope('jotform', jf, '5812'));
eq('jot envelope person', je.person?.name, 'Luis Ortega');
eq('jot seller facts', je.seller, { timeline: 'ASAP', condition: 'Needs roof' });
eq('jot notes kept', je.deal?.notes, 'Why Are: Divorce\nLead source: Jotform: Sell My House');

// Disposition request: the Jotform Chris was typing by hand. Opinion prices
// follow the thousands/millions rule (1.60 → $1,600,000). A year stuffed into
// Bedrooms is not a bedroom count, so it stays in the notes.
const dispo = jotformToFlat([
  { name: 'phone', label: 'Phone Mobile', type: 'control_phone', answer: { full: '(575) 555-0165' } },
  { name: 'email', label: 'Email Home', type: 'control_email', answer: 'abc.acquisitions@example.com' },
  { name: 'entity', label: 'Entity Name', answer: 'A.B.C Exit Holdings' },
  { name: 'disposition', label: 'Disposition Request', answer: 'Request Disposition' },
  { name: 'location', label: 'Location', answer: '..' },
  { name: 'portfolio', label: 'One Property or Portfolio?', answer: 'One Property' },
  { name: 'notes', label: 'Notes', answer: 'Gate code 1234' },
  { name: 'type', label: 'Property Type', answer: 'SFR' },
  { name: 'year', label: 'Year Build', answer: '1976' },
  { name: 'beds', label: 'Bedrooms', answer: '2400' },
  { name: 'baths', label: 'Bathrooms', answer: '2.5' },
  { name: 'sqft', label: 'Square Footage', answer: '3,134' },
  { name: 'garage', label: 'Garage Info', answer: 'Garage, Carport. Garage spaces: 2 Carport spaces: 2' },
  { name: 'photos', label: 'Photos', answer: 'https://drive.google.com/drive/folders/1EXAMPLEfolderIdForPhotos000000' },
  { name: 'occ', label: 'Occupied?', answer: 'Yes - Occupied by Owner' },
  { name: 'ask', label: 'What price are you asking? (Your contract price including your fee)', answer: '$925,000.00' },
  { name: 'close', label: 'Closing Date Needed', answer: 'Wed 30 September 2026, 12:00 AM' },
  { name: 'arv', label: 'ARV in your opinion', answer: '$1.60' },
  { name: 'rehab', label: 'Rehab in your opinion', answer: '$300,000.00' },
  { name: 'leaseEnd', label: 'If leased, MTM or when is lease end?', answer: '..' },
  { name: 'mls', label: 'Listed on MLS?', answer: 'No' },
  { name: 'il', label: 'Have you put the property on Investorlift?', answer: 'No' },
  { name: 'leaseAmt', label: 'If leased, lease amount?', answer: '' },
  { name: 'why', label: 'Reason for selling if you have it', answer: 'Seller is motivated' },
  { name: 'contract', label: 'Copy of purchase contract', answer: 'https://example.com/contract.pdf' },
  { name: 'tape', label: 'If Portfolio, Please upload data tape or bulk info', answer: 'https://example.com/tape.xlsx' },
], { submissionId: '9001', formTitle: 'Disposition Request', creates: 'wholesaler' });
eq('dispo event', dispo.event, 'wholesaler.create');
eq('dispo entity', dispo.entity_name, 'A.B.C Exit Holdings');
eq('dispo phone', dispo.phone, '(575) 555-0165');
eq('dispo type', dispo.property_type, 'Single Family');
eq('dispo year', dispo.year_built, 1976);
eq('dispo beds rejected', dispo.beds, undefined);
eq('dispo baths', dispo.baths, 2.5);
eq('dispo sqft', dispo.sqft, 3134);
eq('dispo garage spaces', dispo.garage_spaces, 2);
eq('dispo asking', dispo.asking_price, 925000);
eq('dispo arv millions', dispo.arv, 1600000);
eq('dispo rehab', dispo.rehab, 300000);
eq('dispo close', dispo.desired_close, 'September 30, 2026');
eq('dispo occupancy', dispo.occupancy, 'Yes - Occupied by Owner');
eq('dispo motivation', dispo.motivation, 'Seller is motivated');
eq('dispo blank lease dropped', String(dispo.notes ?? '').includes('lease end'), false);
eq('dispo form notes', dispo.form_notes, 'Gate code 1234');
eq('dispo stray beds kept', dispo.notes, 'Bedrooms: 2400');
const de = env(flatToEnvelope('jotform', dispo, '9001'));
eq('dispo mode', de.mode, 'wholesaler');
eq('dispo record name', de.person?.name, 'A.B.C Exit Holdings');
eq('dispo intake entity', de.intake?.entity, 'A.B.C Exit Holdings');
eq('dispo intake arv', de.intake?.arv, 1600000);
eq('dispo photos', de.intake?.photos, 'https://drive.google.com/drive/folders/1EXAMPLEfolderIdForPhotos000000');
eq('dispo intake year without an address', de.intake?.year_built, 1976);
eq('dispo intake sqft', de.intake?.sqft, 3134);
eq('dispo intake type', de.intake?.property_type, 'Single Family');

// Jotform API answers carry real labels; a buyer-configured key makes a buyer.
const api = jotAnswersFromApi({
  '1': { name: 'heading', text: 'Buyer list', type: 'control_head' },
  '2': { name: 'name', text: 'Name', type: 'control_fullname', answer: { first: 'Dee', last: 'Park' } },
  '3': { name: 'phone', text: 'Cell', type: 'control_phone', answer: { area: '210', phone: '5550100' } },
  '4': { name: 'maxBudget', text: 'Max budget', type: 'control_textbox', answer: '$250,000' },
  '5': { name: 'buyAreas', text: 'Areas you buy', type: 'control_textbox', answer: 'Bexar, Comal' },
  '6': { name: 'strategy', text: 'Strategy', type: 'control_checkbox', answer: ['Flip', 'Rental'] },
});
const bf = jotformToFlat(api, { submissionId: '77', formTitle: 'Buyers', creates: 'buyer' });
eq('jot buyer flat', bf, {
  event: 'buyer.create', external_id: '77', lead_source: 'Jotform: Buyers', first_name: 'Dee', last_name: 'Park',
  phone: '2105550100', max_purchase_price: 250000, markets: 'Bexar, Comal', notes: 'Strategy: Flip, Rental',
});

console.log(failed ? `${failed} flat-mapper failures` : 'all flat-mapper checks passed');
if (failed) Deno.exit(1);
