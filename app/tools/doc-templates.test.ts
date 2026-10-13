// Run with:  npx tsx tools/doc-templates.test.ts
//
// The seeded templates are data, not code, so nothing type-checks them. A
// role in a {{sign:...}} block that no signer declares renders as nothing —
// the document comes out with no signature line and no one to send it to —
// and a token the engine's regex does not match prints its own brackets on a
// contract a seller signs. Both are silent, so they are checked here.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

// (workspace_id, key, name, kind, sort, signers, $body$...$body$)
const ROW = /\(null,\s*'([a-z0-9_]+)',\s*'([^']*)',\s*'([a-z]+)',\s*(\d+),\s*\n?\s*'(\[[^\n]*\])',\s*\n?\$body\$([\s\S]*?)\$body\$\)/g;
// The same shapes the engine parses (_shared/docs.ts).
const TOKEN = /\[([A-Z][A-Za-z0-9]*\.[A-Za-z0-9]+)\]/g;
const SIGN = /\{\{\s*sign:([a-z0-9_]+)\s*\}\}/g;
const KINDS = ['psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'offer', 'other'];

type Row = { key: string; name: string; kind: string; signers: { role: string; party?: string; optional?: boolean }[]; body: string };
const rows: Row[] = [];
for (const m of sql.matchAll(ROW)) {
  rows.push({ key: m[1], name: m[2], kind: m[3], signers: JSON.parse(m[5]), body: m[6] });
}

// Every document Acme Homes sends, including the ones migration 75 added.
const EXPECTED = [
  'psa', 'assignment', 'termination', 'offer_letter',
  'authorization', 'amendment', 'option', 'leaseback', 'escrow_holdback', 'seller_info', 'trec_1_4',
];
const keys = new Set(rows.map((r) => r.key));
for (const k of EXPECTED) assert.ok(keys.has(k), `template "${k}" is not seeded`);

for (const r of rows) {
  const where = `${r.key} (${r.name})`;
  assert.ok(KINDS.includes(r.kind), `${where}: kind "${r.kind}" fails the doc_templates check constraint`);
  assert.ok(r.signers.length > 0, `${where}: no signers declared`);

  const declared = new Set(r.signers.map((s) => s.role));
  const blocks = new Set(Array.from(r.body.matchAll(SIGN), (m) => m[1]));
  for (const role of blocks) assert.ok(declared.has(role), `${where}: {{sign:${role}}} has no signer declared`);
  for (const role of declared) assert.ok(blocks.has(role), `${where}: signer "${role}" has nowhere to sign`);

  // A stray bracket that the token regex misses would print literally.
  const loose = r.body.replace(TOKEN, '').match(/\[[^\]\n]{0,60}\]/g) ?? [];
  assert.deepEqual(loose, [], `${where}: ${loose.join(', ')} will print its own brackets`);

  // Dollar-quoting: a body that contains the delimiter would end the literal
  // early and take the rest of the migration with it.
  assert.ok(!r.body.includes('$body$'), `${where}: body contains the $body$ delimiter`);

  assert.ok(Array.from(r.body.matchAll(TOKEN)).length > 0, `${where}: fills nothing from the record`);
}

// The record answers these directly, so a template that asks for them must
// never come out blank on a document that has a seller and a property.
for (const key of ['psa', 'trec_1_4', 'option', 'leaseback', 'escrow_holdback']) {
  const body = rows.find((r) => r.key === key)!.body;
  assert.ok(body.includes('[Property.FullAddress]'), `${key}: does not print the property address`);
  assert.ok(body.includes('[Seller.Name]'), `${key}: does not print the seller`);
}

// The seller information sheet collects a date of birth and a Social Security
// number. Those are the title company's to take, not ours to store on a
// contract row, so they stay printed blanks rather than tokens.
const sellerInfo = rows.find((r) => r.key === 'seller_info')!.body;
assert.ok(sellerInfo.includes('SS#: ______________________'), 'seller_info: SS# is no longer a printed blank');
assert.ok(!/\[[A-Za-z]*\.?(SSN|SS|DOB|DateOfBirth)\]/.test(sellerInfo), 'seller_info: an SSN or date of birth became a stored token');

console.log(`doc-templates: ok (${rows.length} templates)`);
