// Clozr Docs reusable sections.  Run:  npx tsx tools/doc-blocks.test.ts
import assert from 'node:assert/strict';
import { STARTER_BLOCKS, blockToken, blocksIn, expandBlocks, lockedIntact } from '../supabase/functions/_shared/doc-blocks';
import { docVars, renderVars, varsIn } from '../supabase/functions/_shared/doc-vars';

const blocks = [
  { id: 1, name: 'EMD', body: 'EMD of {{deal.inhouse_emd|currency}} with {{title.company}}.', locked: false },
  { id: 2, name: 'As-is', body: 'Sold AS IS. {{block:3}}', locked: true },
  { id: 3, name: 'TX rider', body: '{{#if property.state == "TX"}}Texas law governs.{{/if}}', locked: true },
  { id: 4, name: 'Loop', body: 'loop {{block:4}}', locked: false },
];

assert.equal(blockToken(12), '{{block:12}}');
assert.deepEqual(blocksIn('a {{block:2}} b {{ block:1 }} c {{block:2}}'), [2, 1]);

// renderVars leaves a section reference alone: it is not a variable.
assert.equal(renderVars('{{block:12}} {{sign:seller}}', docVars({}, {})).text, '{{block:12}} {{sign:seller}}');
assert.deepEqual(varsIn('{{block:12}} {{deal.emd}}'), ['deal.emd']);

// Expansion happens before variables, nests, and reports what it used.
const x = expandBlocks('1. {{block:1}}\n2. {{block:2}}', blocks);
assert.equal(x.text, '1. EMD of {{deal.inhouse_emd|currency}} with {{title.company}}.\n2. Sold AS IS. {{#if property.state == "TX"}}Texas law governs.{{/if}}');
assert.deepEqual(x.used, [{ id: 1, name: 'EMD', locked: false }, { id: 2, name: 'As-is', locked: true }, { id: 3, name: 'TX rider', locked: true }]);
assert.deepEqual(x.missing, []);
const filled = renderVars(x.text, docVars({ deal: { inhouse_emd_amount: 500 }, prop: { state: 'TX' }, title: { business_name: 'Alamo Title' } }, {})).text;
assert.equal(filled, '1. EMD of $500 with Alamo Title.\n2. Sold AS IS. Texas law governs.');

// A loop is cut, and a deleted section is reported and left visible.
assert.equal(expandBlocks('{{block:4}}', blocks).text, 'loop ');
const gone = expandBlocks('keep {{block:99}} here', blocks);
assert.equal(gone.text, 'keep {{block:99}} here');
assert.deepEqual(gone.missing, [99]);
assert.equal(expandBlocks('no sections', blocks).text, 'no sections');

// Locked sections must survive a later edit word for word.
assert.deepEqual(lockedIntact(x.text, blocks, [1, 2, 3]), []);
assert.deepEqual(lockedIntact(x.text.replace('AS IS', 'as is'), blocks, [1, 2, 3]), ['As-is']);
assert.deepEqual(lockedIntact(x.text.replace('EMD of', 'Deposit of'), blocks, [1, 2, 3]), [], 'editable sections may change');

// Starter clauses: five, named, and only real variables.
assert.equal(STARTER_BLOCKS.length, 5);
const known = new Set(Object.keys(docVars({}, {})));
for (const b of STARTER_BLOCKS) {
  assert.ok(b.name && b.body.length > 80, b.name);
  for (const v of varsIn(b.body)) assert.ok(known.has(v), `${b.name}: unknown variable ${v}`);
}

console.log('doc-blocks ok');
