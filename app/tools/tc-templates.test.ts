// The TC templates (lib/tc-templates.ts) and migration 401: no source merge
// tag left unconverted, every {{field}} one CLOZR fills, and the migration is
// what the generator writes.
// Run with:  npx tsx tools/tc-templates.test.ts
import assert from 'node:assert/strict';
import { MERGE_FIELDS } from '../lib/message-templates';
import { fieldsFor } from '../lib/sms';
import { TC_TEMPLATES, tcTemplateRows } from '../lib/tc-templates';
import { tcTemplatesSql } from './tc-templates-sql';

// The open-source build ships 401 empty (it seeded one workspace); check the generator's SQL.
const sql = tcTemplatesSql();

// Every $t$…$t$ string in the migration: names, subjects, text, HTML, blocks.
const strings = [...sql.matchAll(/\$t\$([\s\S]*?)\$t\$/g)].map((m) => m[1]);
assert.ok(strings.length > 21 * 3, 'the migration quotes its template text');

// A known field is a template chip, or one every send fills (lib/sms fieldsFor: the contact's phone and email).
const KNOWN = new Set([
  ...MERGE_FIELDS.map((f) => f.token.slice(2, -2)),
  ...Object.keys(fieldsFor({ sellerId: null, name: 'A B', phone: '' } as Parameters<typeof fieldsFor>[0], {}, '')),
]);
for (const s of strings) {
  assert.doesNotMatch(s, /%[a-z_]+%/i, `an unconverted %tag% in: ${s.slice(0, 80)}`);
  assert.doesNotMatch(s, /\{\{\s*[A-Z][a-z]+ [A-Z][a-z]+\s*\}\}/, `a source {{First Name}} tag in: ${s.slice(0, 80)}`);
  for (const m of s.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) assert.ok(KNOWN.has(m[1]), `{{${m[1]}}} is not a CLOZR merge field`);
  // The sender is the rep's own name field, never the TC's name typed in.
  assert.doesNotMatch(s, /Casey|\[TC NAME\]|\[STREET NAME\]|\[PHONE NUMBER\]|\[Seller first name\]/, `a hard-coded name or blank in: ${s.slice(0, 80)}`);
}

// The typo fixes.
const all = strings.join('\n');
for (const typo of ['sen out', 'last think', 'reivew', 'a offer', 'a end buyer']) assert.ok(!all.includes(typo), `typo left: ${typo}`);

// Shape: 21 templates (18 numbered, three split in two), unique names, all category TC.
const rows = tcTemplateRows();
assert.equal(rows.length, 21);
assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'names are unique (the migration skips by name)');
for (const r of rows) {
  assert.equal(r.category, 'TC');
  assert.ok(r.name.startsWith('TC: ') && r.name.length <= 120, r.name);
  assert.ok(r.body_text.trim(), `${r.name} has a body`);
  if (r.channel === 'email') {
    assert.ok(r.subject && r.body_html && r.blocks, `${r.name}: an email has a subject, HTML and blocks`);
  } else {
    assert.equal(r.subject, null);
    assert.equal(r.body_html, null);
  }
  for (const f of r.merge_fields) assert.ok(KNOWN.has(f), `${r.name}: ${f}`);
}
// The review link is a real link in the thank-you emails.
for (const name of ['TC: Seller thank-you after closing', 'TC: Buyer thank-you after closing']) {
  const r = rows.find((x) => x.name === name)!;
  assert.ok(r.body_html!.includes('href="https://www.yourcompany.com/congratulations"'), `${name} links the review page`);
}
assert.ok(TC_TEMPLATES.some((t) => t.audience === 'buyer') && TC_TEMPLATES.some((t) => t.audience === 'general'));
console.log('tc-templates: ok');
