// Quick Add keeps what was typed when the dialog is put away (lib/quick-add-draft).
// Run with: npx tsx tools/quick-add-draft.test.ts

import assert from 'node:assert/strict';
import { draftFor, dropDraft, hasTyped, keepDraft } from '../lib/quick-add-draft';

// Only something typed is worth keeping: the seed alone, or blanks, are not a draft.
assert.equal(hasTyped({}, {}), false);
assert.equal(hasTyped({ personId: 's1' }, { personId: 's1' }), false);
assert.equal(hasTyped({}, { name: '   ' }), false);
assert.equal(hasTyped({}, { name: 'Kara' }), true);
assert.equal(hasTyped({ personId: 's1' }, { personId: 's2' }), true);
assert.deepEqual(keepDraft({}, 'seller', {}, { name: '' }), {});
assert.deepEqual(keepDraft({ seller: { seed: {}, form: { name: 'Old' } } }, 'seller', {}, {}), {});

// Put away with a name typed, reopened from the menu: the name is back.
const d1 = keepDraft({}, 'seller', {}, { name: 'Kara Mitchell', phone: '210' });
assert.deepEqual(draftFor(d1, 'seller', {})?.form, { name: 'Kara Mitchell', phone: '210' });
// Another kind does not get it.
assert.equal(draftFor(d1, 'buyer', {}), null);

// A task typed on Kara's record comes back on her record, and from the menu…
const d2 = keepDraft({}, 'task', { personId: 's1' }, { personId: 's1', title: 'Send comps' });
assert.equal(draftFor(d2, 'task', { personId: 's1' })?.form.title, 'Send comps');
assert.equal(draftFor(d2, 'task', {})?.form.title, 'Send comps');
// …and keeps the record it was for, so putting it away again from the menu still belongs to her.
assert.deepEqual(draftFor(d2, 'task', {})?.seed, { personId: 's1' });
// From Ronald's record his own task starts fresh.
assert.equal(draftFor(d2, 'task', { personId: 's2' }), null);

// An address edit belongs to the one record it was typed on, never the menu.
const d3 = keepDraft({}, 'address', { personId: 's1', was: '1 Oak' }, { personId: 's1', was: '1 Oak', addr: '2 Elm' });
assert.equal(draftFor(d3, 'address', { personId: 's1', was: '1 Oak' })?.form.addr, '2 Elm');
assert.equal(draftFor(d3, 'address', {}), null);
assert.equal(draftFor(d3, 'address', { personId: 's2' }), null);

// Saved or cleared: gone, and the others stay.
const both = { ...d1, ...d2 };
assert.deepEqual(Object.keys(dropDraft(both, 'seller')), ['task']);
assert.equal(dropDraft(d2, 'seller'), d2);

console.log('quick-add-draft: all checks passed');
