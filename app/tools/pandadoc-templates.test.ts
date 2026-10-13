// Run with:  npx tsx tools/pandadoc-templates.test.ts
import assert from 'node:assert/strict';
import { pickPandaDocTemplate } from '../lib/pandadoc-templates';

const templates = [
  { id: 'psa', name: 'TX Residential Purchase Agreement' },
  { id: 'asn', name: 'Assignment of Contract' },
  { id: 'off', name: 'Acme Homes Cash Offer Letter' },
  { id: 'loi', name: 'Letter of Intent' },
];

assert.equal(pickPandaDocTemplate(templates, 'asn')?.id, 'asn');
assert.equal(pickPandaDocTemplate(templates, 'missing')?.id, 'off');
assert.equal(pickPandaDocTemplate(templates)?.id, 'off');
assert.equal(pickPandaDocTemplate([{ id: 'a', name: 'Disclosure' }, { id: 'b', name: 'PSA' }])?.id, 'b');
assert.equal(pickPandaDocTemplate([]), null);
assert.equal(pickPandaDocTemplate(templates, null)?.name, 'Acme Homes Cash Offer Letter');

console.log('pandadoc-templates: ok');
