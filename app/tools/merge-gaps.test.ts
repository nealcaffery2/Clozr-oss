// Blank merge fields: which ones a send would show empty, the words the
// composer says about them, and how a spec line renders when some or all of
// beds, baths and sq ft are missing. Run: npx tsx tools/merge-gaps.test.ts
import assert from 'node:assert/strict';
import {
  MERGE_SOURCES, blankFields, bulkGapSummary, dealGaps, factFields, gapNotice, listLabels, sourceLine, specsLine,
} from '../lib/merge-gaps';
import { renderMerge } from '../lib/sms';
import { renderEmail, MERGE_FIELDS } from '../lib/message-templates';
import { dispoFields } from '../lib/dispo-fields';
import type { Person } from '../lib/clozr-types';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

// ---- detection ----------------------------------------------------------------
test('empty and missing known fields are blank; unknown and filled are not', () => {
  const body = 'Hi {{first_name}}, {{address}} is {{beds}} bd / {{baths}} ba, {{sqft}} sqft. {{nope}}';
  const got = blankFields([body], { first_name: 'Ann', address: '12 Oak St', beds: '', baths: '2' });
  assert.deepEqual(got, ['beds', 'sqft']);
});
test('subject and html are checked together, once each', () => {
  assert.deepEqual(blankFields(['New deal {{beds}}', '<p>{{beds}} {{arv}}</p>'], { beds: '', arv: '' }), ['beds', 'arv']);
});
test('skip leaves out blanks that are blank by design', () => {
  assert.deepEqual(blankFields(['{{purchase_note}} {{sqft}}'], { purchase_note: '', sqft: '' }, ['purchase_note']), ['sqft']);
});
test('dealGaps keeps deal and property fields, drops buyer and sender ones', () => {
  assert.deepEqual(dealGaps(['beds', 'purchase_note', 'arv', 'rep_phone', 'first_name']), ['beds', 'arv']);
});
test('every chip in the template editor has a source line', () => {
  for (const f of MERGE_FIELDS) assert.ok(sourceLine(f.token), `no source for ${f.token}`);
  assert.equal(sourceLine('{{beds}}'), "{{beds}} comes from the property's Beds on the deal.");
  assert.equal(sourceLine('{{made_up}}'), null);
  assert.equal(MERGE_SOURCES.sqft.field, 'property.sqft');
});

// ---- copy ---------------------------------------------------------------------
test('notice names the fields and the house', () => {
  assert.equal(listLabels(['beds']), 'Beds');
  assert.equal(listLabels(['beds', 'baths']), 'Beds and Baths');
  assert.equal(gapNotice(['beds', 'baths', 'sqft'], '123 Oak St'), 'Beds, Baths and Sq ft are empty on 123 Oak St.');
  assert.equal(gapNotice(['sqft'], ''), 'Sq ft is empty on this deal.');
  assert.equal(gapNotice([], 'x'), '');
});
test('bulk summary counts recipients per field', () => {
  assert.deepEqual(bulkGapSummary({ sqft: 12 }, 40), ["12 of 40 buyers' emails would show blank Sq ft because the deal has none."]);
  assert.deepEqual(bulkGapSummary({ beds: 40, baths: 40 }, 40), ["All 40 buyers' emails would show blank Beds and Baths because the deal has none."]);
  assert.deepEqual(bulkGapSummary({ beds: 1 }, 1), ["The buyer's email would show blank Beds because the deal has none."]);
  assert.deepEqual(bulkGapSummary({ address: 3, sqft: 9 }, 10, 'sellers'), [
    "9 of 10 sellers' emails would show blank Sq ft because the deal has none.",
    "3 of 10 sellers' emails would show blank Address because the deal has none.",
  ]);
  assert.deepEqual(bulkGapSummary({ first_name: 2 }, 5), ["2 of 5 buyers' emails would show blank First name because their record has none."]);
  assert.deepEqual(bulkGapSummary({}, 5), []);
  assert.deepEqual(bulkGapSummary({ beds: 4, first_name: 1 }, 4, 'buyers', { noDeal: true }), [
    "All 4 buyers' emails would show the merge tags for Beds as typed because no deal is attached.",
    "1 of 4 buyers' emails would show blank First name because their record has none.",
  ]);
});
test('new copy passes the no-AI-slop check', () => {
  const lines = [
    gapNotice(['beds', 'baths', 'sqft'], '123 Oak St') + ' They go out blank unless you fill them in.',
    ...bulkGapSummary({ sqft: 12, beds: 40 }, 40),
    ...Object.keys(MERGE_SOURCES).map((k) => sourceLine(k)!),
    'Point at a field to see where its value comes from.',
    'Save a value on the property, use one for this campaign only, or take the field out.',
    'Every buyer who gets it sees those spots blank.',
    'This deal has no property row yet. Set its address on the record first.',
    'Open property facts',
    "Open the deal's property facts",
    'Pick the deal above, or take those fields out of the message.',
    'No deal is ready to attach, so take those fields out of the message.',
    ...bulkGapSummary({ beds: 4 }, 4, 'buyers', { noDeal: true }),
    'No beds, baths or sq ft on file',
  ];
  for (const l of lines) assert.deepEqual(slopFindings(l), [], l);
});

// ---- rendering ----------------------------------------------------------------
test('specs line drops the empty parts, and is empty when all are', () => {
  assert.equal(specsLine({ beds: 3, baths: 2, sqft: '1,400' }), '3 bd / 2 ba / 1,400 sf');
  assert.equal(specsLine({ beds: 3, baths: 0, sqft: '1,400' }), '3 bd / 1,400 sf');
  assert.equal(specsLine({ beds: null, baths: '', sqft: '' }), '');
  assert.deepEqual(factFields({ beds: 3, baths: 2, sqft: 1525, year: 1955, type: 'SFR' }),
    { beds: '3', baths: '2', sqft: '1,525', year_built: '1955', property_type: 'SFR', specs: '3 bd / 2 ba / 1,525 sf', beds_baths: '3 bd / 2 ba' });
  assert.equal(factFields({ beds: 0, baths: 0, sqft: 0, year: 0, type: '—' }).specs, '');
});

const none = { beds: '', baths: '', sqft: '', year_built: '', arv: '', asking_price: '$185,000', price: '$185,000', address: '12 Oak St', city: 'Decatur', purchase_note: '' };
const LINE = 'Asking {{asking_price}} · ARV {{arv}} · {{beds}} bd / {{baths}} ba · {{sqft}} sqft · built {{year_built}}\n\nFull deal: x';
test('a spec line with nothing on file keeps only what is there', () => {
  assert.equal(renderMerge(LINE, none), 'Asking $185,000\n\nFull deal: x');
});
test('a spec line with some facts keeps those, with no stray units or separators', () => {
  assert.equal(renderMerge(LINE, { ...none, beds: '3', sqft: '1,400' }), 'Asking $185,000 · 3 bd · 1,400 sqft\n\nFull deal: x');
  assert.equal(renderMerge(LINE, { ...none, beds: '3', baths: '2', sqft: '1,400', year_built: '1955', arv: '$290,000' }),
    'Asking $185,000 · ARV $290,000 · 3 bd / 2 ba · 1,400 sqft · built 1955\n\nFull deal: x');
});
test('brackets and comma lists close up around blanks', () => {
  assert.equal(renderMerge('We got {{address}} at {{price}} ({{beds}} bd / {{baths}} ba). {{purchase_note}}\n\nPhotos', none),
    'We got 12 Oak St at $185,000.\n\nPhotos');
  assert.equal(renderMerge('We got {{address}} at {{price}} ({{beds}} bd / {{baths}} ba). Next', { ...none, baths: '2' }),
    'We got 12 Oak St at $185,000 (2 ba). Next');
  assert.equal(renderMerge('New in {{city}}: {{address}}, {{beds}}/{{baths}}, {{sqft}} sf. {{price}}, ARV {{arv}}. Photos', none),
    'New in Decatur: 12 Oak St. $185,000. Photos');
});
test('a list after a colon starts at the first filled item', () => {
  const t = 'Here is what we have on {{address}}: {{beds}} bd / {{baths}} ba, {{sqft}} sqft, built {{year_built}}. Reply';
  assert.equal(renderMerge(t, { ...none, year_built: '1972' }), 'Here is what we have on 12 Oak St: built 1972. Reply');
  assert.equal(renderMerge(t, { ...none, beds: '3', year_built: '1972' }), 'Here is what we have on 12 Oak St: 3 bd, built 1972. Reply');
  assert.equal(renderMerge('{{beds}} bd, {{sqft}} sqft, ready now', none), 'ready now');
});
test('{{specs}} renders the whole line or nothing', () => {
  assert.equal(renderMerge('{{address}}\n{{specs}}\nCall me', { ...none, specs: '' }), '12 Oak St\nCall me');
  assert.equal(renderMerge('{{address}} ({{specs}})', { ...none, specs: '' }), '12 Oak St');
  assert.equal(renderMerge('{{address}} ({{specs}})', { ...none, specs: '3 bd / 2 ba' }), '12 Oak St (3 bd / 2 ba)');
});
test('ordinary sentences are left alone', () => {
  assert.equal(renderMerge('Hi {{first_name}}, about {{address}}.', { first_name: '', address: '12 Oak St' }), 'Hi, about 12 Oak St.');
  assert.equal(renderMerge('Price 3 / 4 of ARV · call me', {}), 'Price 3 / 4 of ARV · call me');
});
test('the property card block in HTML drops empty beds and baths', () => {
  const html = '<div><strong>{{asking_price}}</strong> &nbsp;·&nbsp; {{beds}} bd &nbsp;·&nbsp; {{baths}} ba</div></td>';
  assert.equal(renderEmail({ subject: '', body_html: html, body_text: '' }, none).html, '<div><strong>$185,000</strong></div></td>');
  assert.equal(renderEmail({ subject: '', body_html: html, body_text: '' }, { ...none, beds: '3' }).html, '<div><strong>$185,000</strong> &nbsp;·&nbsp; 3 bd</div></td>');
});

// ---- the root cause: the deal's own house ---------------------------------------
const seller = (): Person => ({
  id: 'p1', name: 'Partner', stage: '', score: null, assigned: null, source: '', phone: '', email: '', lastComm: '', lastCommTs: null, nextTask: '',
  offer: null, created: '', tags: [], market: '', motivation: '', timeline: '', condition: '', occupancy: '', mortgage: '', asking: '', desiredClose: '', decisionMakers: '',
  // The partner's card shows another house (a wholesaler's seller row carries many).
  property: { addr: '9 Other Rd', city: 'Decatur', st: 'GA', zip: '30032', beds: 3, baths: 2, sqft: 1768, year: 1987, lot: '', type: 'SFR', img: '', apn: '' },
});
test("dispoFields reads the deal's own property, not the seller's other house", () => {
  const f = dispoFields({ home: { beds: 3, baths: 2, sqft: 1525, year: 1955, type: 'SFR' } }, seller(), '12 Oak St', 185000);
  assert.equal(f.sqft, '1,525');
  assert.equal(f.year_built, '1955');
  assert.equal(f.specs, '3 bd / 2 ba / 1,525 sf');
});
test("a deal whose house has no facts stays blank instead of borrowing the seller's", () => {
  const f = dispoFields({ home: { beds: 0, baths: 0, sqft: 0, year: 0, type: '—' } }, seller(), '12 Oak St', 185000);
  assert.equal(f.beds, '');
  assert.equal(f.sqft, '');
  assert.deepEqual(dealGaps(blankFields(['{{beds}} bd / {{baths}} ba · {{sqft}} sqft'], f)), ['beds', 'baths', 'sqft']);
});
test('a deal with no property row falls back to the person', () => {
  assert.equal(dispoFields({}, seller(), '9 Other Rd', 1).sqft, '1,768');
});

console.log(`merge-gaps: ${passed} checks passed`);
