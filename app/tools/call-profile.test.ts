// "From this call": the call-profile function's checks, the merge across asks,
// and the forms a profile pre-fills. No network.
import {
  dollars, emptyProfile, mergeProfiles, parseCallProfile, quoteInTranscript, tailTranscript, transcriptText,
} from '../supabase/functions/_shared/call-profile';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';
import {
  buyerGaps, buyerSeed, demoCallProfile, fillBuyBoxGaps, marketPref, priceLabel, profileBuyBox, profileRows, quickAddSeed, DEMO_BUYER_LINES,
} from '../lib/call-profile';
import { emptyBuyBox, normalizeBuyBox } from '../lib/buyer-profile';
import { quickBuyerProfile } from '../lib/crm-write';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`ok   ${name}`);
}

const lines = [
  { rep: true, text: 'Acme Homes, this is Taylor.' },
  { rep: false, text: 'Hey, Marcus Reed with Alamo Ridge Homes.' },
  { rep: false, text: 'Mostly flips in San Antonio. Anywhere from 120 to 180.' },
  { rep: false, text: 'Cash, close in ten days. marcus at alamoridge dot com' },
  { rep: true, text: '   ' },
];
const tx = transcriptText(lines);
eq('transcript lines are labelled and blanks dropped', tx.split('\n').length, 4);
eq('transcript labels', tx.split('\n')[0], 'Rep: Acme Homes, this is Taylor.');

// ---- the transcript window ----
const long = Array.from({ length: 400 }, (_, i) => `Caller: line ${i} of the call`).join('\n');
const tail = tailTranscript(long, 6000);
eq('tail is within the cap', tail.length <= 6000, true);
eq('tail starts on a whole line', tail.startsWith('Caller: line '), true);
eq('tail keeps the end', tail.endsWith('line 399 of the call'), true);
eq('short transcript is kept whole', tailTranscript('Rep: hi'), 'Rep: hi');

// ---- quotes ----
eq('quote with other punctuation and case matches', quoteInTranscript('anywhere from 120 to 180', tx), true);
eq('curly apostrophe matches', quoteInTranscript('I’ll take', "Caller: I'll take a heavy rehab"), true);
eq('invented quote does not match', quoteInTranscript('Austin and Dallas', tx), false);
eq('a word fragment does not match', quoteInTranscript('arcus', tx), false);
eq('too short to count', quoteInTranscript('a', tx), false);

// ---- dollars ----
eq('thousands spoken as hundreds', dollars(180), 180000);
eq('whole dollars stay', dollars('$235,000'), 235000);
eq('nonsense is null', dollars('lots'), null);
eq('zero is null', dollars(0), null);

// ---- parsing the model's answer ----
const raw = {
  kind: 'Buyer', confidence: 92, name: 'Marcus Reed', company: 'Alamo Ridge Homes', email: 'Marcus@AlamoRidge.com',
  buyerType: 'flipper',
  buyBox: {
    markets: ['San Antonio', 'san antonio', 'Austin'], priceMin: 180, priceMax: 120, propertyTypes: ['single family', 'castle'],
    strategies: ['fix_and_flip'], rehabTolerance: 'heavy', closingDays: 10, funding: ['cash', 'crypto'],
  },
  notes: 'Wants deals by email.',
  evidence: {
    name: 'Marcus Reed with Alamo Ridge Homes', company: 'Alamo Ridge Homes', email: 'marcus at alamoridge dot com',
    buyerType: 'Mostly flips', markets: 'Mostly flips in San Antonio', price: 'Anywhere from 120 to 180',
    propertyTypes: 'single family homes only', strategies: 'Mostly flips', rehabTolerance: 'heavy rehab is fine',
    closingDays: 'close in ten days', funding: 'Cash, close in ten days',
  },
};
const p = parseCallProfile(raw, tx, { notesOk: (s) => slopFindings(s).length === 0 });
eq('kind normalised', p.kind, 'buyer');
eq('confidence as 0-1', p.confidence, 0.92);
eq('email lowercased', p.email, 'marcus@alamoridge.com');
eq('markets deduped (case) and kept with their quote', p.buyBox.markets, ['San Antonio', 'Austin']);
eq('price ends swapped into order, read as thousands', [p.buyBox.priceMin, p.buyBox.priceMax], [120000, 180000]);
eq('unknown codes dropped', p.buyBox.funding, ['cash']);
eq('property types without a real quote are dropped', p.buyBox.propertyTypes, []);
eq('rehab without a real quote is dropped', p.buyBox.rehabTolerance, null);
eq('closing days kept', p.buyBox.closingDays, 10);
eq('evidence only for kept fields', Object.keys(p.evidence).sort(), ['buyerType', 'closingDays', 'company', 'email', 'funding', 'markets', 'name', 'price', 'strategies']);
eq('clean notes kept', p.notes, 'Wants deals by email.');

const slop = parseCallProfile({ ...raw, notes: 'A pivotal moment — he serves as a beacon for the market.' }, tx, { notesOk: (s) => slopFindings(s).length === 0 });
eq('slop notes dropped', slop.notes, null);

const bare = parseCallProfile({ kind: 'alien', name: 'R2D2', evidence: { name: 'R2D2' } }, tx);
eq('off-list kind is unknown', bare.kind, 'unknown');
eq('a name with digits is no name', bare.name, null);
eq('garbage in, empty out', parseCallProfile(null, tx), emptyProfile());

const noQuotes = parseCallProfile({ kind: 'buyer', confidence: 0.8, name: 'Marcus Reed', buyBox: { markets: ['Austin'] } }, tx);
eq('no evidence, no fields', [noQuotes.name, noQuotes.buyBox.markets], [null, []]);
eq('kind stands without a quote', noQuotes.kind, 'buyer');

// ---- merging asks ----
const first = parseCallProfile({ kind: 'buyer', confidence: 0.6, name: 'Marcus Reed', buyBox: { markets: ['San Antonio'] }, evidence: { name: 'Marcus Reed with Alamo', markets: 'flips in San Antonio' } }, tx);
const second = parseCallProfile({ kind: 'unknown', confidence: 0, buyBox: { markets: ['New Braunfels'], funding: ['cash'] }, evidence: { markets: 'New Braunfels', funding: 'Cash, close' } }, tx + '\nCaller: and New Braunfels');
const merged = mergeProfiles(first, second);
eq('an unknown later answer keeps the kind', merged.kind, 'buyer');
eq('a field the later window lost is kept', merged.name, 'Marcus Reed');
eq('lists are joined', merged.buyBox.markets, ['San Antonio', 'New Braunfels']);
eq('evidence follows the latest answer that had the field', merged.evidence.markets, 'New Braunfels');
eq('earlier evidence kept for kept fields', merged.evidence.name, 'Marcus Reed with Alamo');
const corrected = mergeProfiles(merged, parseCallProfile({ kind: 'buyer', confidence: 0.9, buyBox: { priceMin: 150, priceMax: 200 }, evidence: { price: 'Anywhere from 120 to 180' } }, tx));
eq('a later price wins', [corrected.buyBox.priceMin, corrected.buyBox.priceMax], [150000, 200000]);

// ---- the demo ----
eq('demo: nothing before the caller speaks', demoCallProfile(1).kind, 'unknown');
eq('demo: name and company after line 2', [demoCallProfile(2).name, demoCallProfile(2).company], ['Marcus Reed', 'Alamo Ridge Homes']);
const demo = demoCallProfile(DEMO_BUYER_LINES.length);
eq('demo: every scripted field survives the quote check', profileRows(demo).map((r) => r.field),
  ['name', 'company', 'email', 'buyerType', 'markets', 'price', 'propertyTypes', 'strategies', 'rehabTolerance', 'closingDays', 'funding']);
eq('demo: rows read as the card shows them', profileRows(demo).find((r) => r.field === 'price')?.value, '$120K – $180K');
eq('demo notes are clean', slopFindings(demo.notes ?? ''), []);

// ---- forms ----
eq('price labels', [priceLabel(null, 200000), priceLabel(90000, null), priceLabel(null, null), priceLabel(1_500_000, 2_000_000)], ['Up to $200K', 'From $90K', '', '$1.5M – $2M']);
eq('market prefs', ['78209', 'Texas', 'Bexar County', 'Austin, TX', 'San Antonio'].map(marketPref), [
  { name: '78209', type: 'zip' }, { name: 'TX', type: 'state' }, { name: 'Bexar County', type: 'county' }, { name: 'Austin', type: 'city', state: 'TX' }, { name: 'San Antonio', type: 'city' },
]);
const box = profileBuyBox(demo);
eq('buy box: locations', box.location_prefs.map((l) => l.name), ['San Antonio', 'New Braunfels']);
eq('buy box: price, types, strategy', [box.price, box.property_types, box.strategies], [{ min: 120000, max: 180000 }, ['single_family', 'townhouse'], ['fix_and_flip']]);
eq('buy box: economics', [box.economics.funding, box.economics.close_days, box.economics.max_rehab_level], [['cash'], 10, 'heavy']);
const seed = buyerSeed(demo, '+12105550142');
eq('buyer seed carries contact and type', [seed.name, seed.company, seed.phone, seed.email, seed.buyer_type], ['Marcus Reed', 'Alamo Ridge Homes', '+12105550142', 'marcus@alamoridge.com', 'flipper']);

const have = normalizeBuyBox({ ...emptyBuyBox(), location_prefs: [{ name: 'Austin', type: 'city' }], strategies: ['buy_and_hold'], economics: { funding: [] } });
const filled = fillBuyBoxGaps(have, box);
eq('gap fill keeps what the record has', [filled.location_prefs.map((l) => l.name), filled.strategies], [['Austin'], ['buy_and_hold']]);
eq('gap fill fills what it lacks', [filled.price, filled.economics.funding, filled.economics.close_days], [{ min: 120000, max: 180000 }, ['cash'], 10]);
const multi = normalizeBuyBox({ ...emptyBuyBox(), property_types: ['multi_family'] });
const noTypes = { ...demo, buyBox: { ...demo.buyBox, propertyTypes: [] } };
eq('gap fill adds no type the call never named', fillBuyBoxGaps(multi, profileBuyBox(noTypes, { gaps: true })).property_types, ['multi_family']);
eq('gap fill adds the types the call named', fillBuyBoxGaps(multi, profileBuyBox(demo, { gaps: true })).property_types, ['multi_family', 'single_family', 'townhouse']);

const qa = quickAddSeed('buyer', demo, '+12105550142');
eq('quick add buyer', qa, {
  addKind: 'buyer',
  seed: {
    phone: '+12105550142', email: 'marcus@alamoridge.com', name: 'Marcus Reed', company: 'Alamo Ridge Homes', type: 'Flipper',
    markets: 'San Antonio, New Braunfels', price: '$120K – $180K',
    note: 'Will not take foundation work. Wants deals sent by email. Property type: Single Family Residential, Townhouse. Strategy: Fix n\' Flip. Rehab: Up to heavy. Closes in: 10 days. Funding: Cash.',
  },
});
// The Quick Add save path reads that seed back as the same buy box.
const saved = quickBuyerProfile(qa.seed) as { buyer_type?: string | null; notes?: string | null; criteria: { location_prefs: { name: string }[]; price: unknown } };
eq('quick add save: type code', saved.buyer_type, 'flipper');
eq('quick add save: markets and price', [saved.criteria.location_prefs.map((l) => l.name), saved.criteria.price], [['San Antonio', 'New Braunfels'], { min: 120000, max: 180000 }]);
eq('quick add save: the note lands in notes', saved.notes, qa.seed.note);

eq('quick add agent is a Realtor vendor', quickAddSeed('agent', { ...emptyProfile(), name: 'Dana Ruiz', company: 'Keller Realty' }, '+15125550100'),
  { addKind: 'vendor', seed: { phone: '+15125550100', name: 'Keller Realty', contact: 'Dana Ruiz', kind: 'Realtor' } });
eq('quick add wholesaler with no company', quickAddSeed('wholesaler', { ...emptyProfile(), name: 'Joe Park' }, null),
  { addKind: 'vendor', seed: { name: 'Joe Park', kind: 'Wholesaler' } });
eq('quick add seller', quickAddSeed('seller', { ...emptyProfile(), name: 'Kara Diaz' }, '+12105550101'), { addKind: 'seller', seed: { phone: '+12105550101', name: 'Kara Diaz' } });

eq('buyer gaps', buyerGaps({ markets: [], price: '—', strategy: 'Flip', type: 'SFR' }), ['Markets', 'Price']);
eq('no buyer gaps', buyerGaps({ markets: ['DFW'], price: '$100K – $200K', strategy: 'Flip', type: 'SFR' }), []);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
