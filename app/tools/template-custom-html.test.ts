// Email templates with their own hand-made HTML keep it on save; block-built
// ones are rebuilt from their blocks. Production lost the Acme Homes dispo
// blast design to a one-word edit before this (migration 403 restored it).
// Run with:  npx tsx tools/template-custom-html.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blocksToEmail, isCustomHtml, templateRow, textToBlocks, toBlocks, type TemplateDraft } from '../lib/message-templates';

// The design migration 64 stores for "Dispo blast · Acme Homes deal".
const sql = readFileSync(new URL('../supabase/migrations/64_dispo_purchase_note.sql', import.meta.url), 'utf8');
const blast = /body_html = \$html\$([\s\S]*?)\$html\$/.exec(sql)?.[1] ?? '';
assert.ok(blast.includes('<!DOCTYPE html>'), 'the migration-64 HTML is found');
const blastText = /body_text = \$text\$([\s\S]*?)\$text\$/.exec(sql)?.[1] ?? '';
assert.ok(blastText.includes('Call me for more information.'), 'and its text part');

const base: TemplateDraft = {
  id: 7, name: 'Dispo blast · Acme Homes deal', channel: 'email', audience: 'buyer', category: 'dispo-blast',
  subject: 'Off market in {{city}}', body_text: blastText, body_html: blast, blocks: null, shared: true,
};

// ---- detection ----------------------------------------------------------------
assert.equal(isCustomHtml({ body_html: blast, blocks: null }), true, 'migration-64 design with no blocks is custom');
assert.equal(isCustomHtml({ body_html: blast, blocks: [] }), true, 'empty blocks too');
assert.equal(isCustomHtml({ body_html: blast, blocks: [{ type: 'paragraph', text: blastText }] }), true, 'blocks that would not build it');

const blocks = toBlocks([{ type: 'heading', text: 'About {{address}}' }, { type: 'paragraph', text: 'Hi {{first_name}}' }, { type: 'signature' }]);
const built = blocksToEmail(blocks);
assert.equal(isCustomHtml({ body_html: built.html, blocks }), false, 'block-built (CLOZR look) is not custom');
assert.equal(isCustomHtml({ body_html: blocksToEmail(blocks, 'compr').html, blocks }), false, 'block-built (Compr look) is not custom');
assert.equal(isCustomHtml({ body_html: blocksToEmail(toBlocks([{ type: 'paragraph', text: 'older copy' }])).html, blocks }), false,
  'CLOZR-shell HTML from other blocks still counts as block-built');
assert.equal(isCustomHtml({ body_html: null, blocks }), false, 'no HTML is not custom');
assert.equal(isCustomHtml({ body_html: '   ', blocks: null }), false, 'blank HTML is not custom');
const relationship = textToBlocks('Hi {{first_name}},\n\nStill looking at deals?\n\n{{rep_name}}');
assert.equal(isCustomHtml({ body_html: blocksToEmail(relationship, 'compr').html, blocks: relationship }), false,
  'Compr blocks with their own HTML (migration 360) are block-built');

// ---- saving -------------------------------------------------------------------
// A block-built template regenerates from its blocks, whatever stale HTML the draft carries.
const edited = toBlocks([{ type: 'paragraph', text: 'New words for {{first_name}}' }]);
const r1 = templateRow({ ...base, body_html: built.html, blocks: edited, customHtml: false }, 'default');
assert.equal(r1.body_html, blocksToEmail(edited).html, 'block-built HTML is regenerated');
assert.equal(r1.body_text, 'New words for {{first_name}}');
assert.deepEqual(r1.blocks, edited);

// A custom-HTML template keeps its design; the text part comes from its blocks.
const opened = [{ id: 'p', type: 'paragraph' as const, text: blastText }];
const r2 = templateRow({ ...base, blocks: opened, customHtml: true }, 'default');
assert.equal(r2.body_html, blast, 'custom HTML is kept on save');
assert.equal(r2.body_text, blastText, 'the text part is the stand-in paragraph, unchanged');

// Fixing one word in the text keeps the design byte for byte.
const fixed = [{ id: 'p', type: 'paragraph' as const, text: blastText.replace('Call me', 'Text me') }];
const r3 = templateRow({ ...base, blocks: fixed, customHtml: true }, 'default');
assert.equal(r3.body_html, blast);
assert.ok(r3.body_text.includes('Text me for more information.'));

// An edited design is saved as edited.
const newHtml = blast.replace('Off market in {{city}}', 'Just listed in {{city}}');
assert.notEqual(newHtml, blast);
assert.equal(templateRow({ ...base, body_html: newHtml, blocks: opened, customHtml: true }, 'default').body_html, newHtml);

// In the Compr look the text keeps one footer, not two.
const comprText = blocksToEmail(relationship, 'compr').text;
const r4 = templateRow({ ...base, body_html: '<html><body>lifecycle</body></html>', body_text: comprText, blocks: [{ id: 'p', type: 'paragraph', text: comprText }], customHtml: true }, 'compr');
assert.equal(r4.body_text, comprText, 'no second Compr footer');

// Custom with the HTML cleared falls back to the blocks.
const r5 = templateRow({ ...base, body_html: '', blocks: edited, customHtml: true }, 'default');
assert.equal(r5.body_html, blocksToEmail(edited).html);

// merge_fields counts the tokens in the HTML too, and nothing from its CSS.
const fields = new Set(r2.merge_fields);
for (const f of ['city', 'asking_price', 'arv', 'first_name', 'marketing_link', 'purchase_note']) assert.ok(fields.has(f), `merge_fields has ${f}`);
const htmlOnly = templateRow({ ...base, body_text: 'Hi', body_html: '<p>{{photo_url}}</p>', blocks: [{ id: 'p', type: 'paragraph', text: 'Hi' }], customHtml: true }, 'default');
assert.deepEqual([...htmlOnly.merge_fields].sort(), ['city', 'photo_url'], 'HTML-only tokens are listed');
const known = new Set(fieldsOf(blast));
assert.deepEqual(r2.merge_fields.filter((f) => !known.has(f) && !blastText.includes(`{{${f}}}`) && f !== 'city'), [], 'no CSS words read as fields');

// SMS is untouched.
const sms = templateRow({ ...base, channel: 'sms', subject: null, body_text: 'Hi {{first_name}}', body_html: blast, blocks: null, customHtml: true }, 'default');
assert.equal(sms.body_html, null);
assert.equal(sms.body_text, 'Hi {{first_name}}');

/** Strict {{double-brace}} tokens, the way the design writes them. */
function fieldsOf(s: string): string[] {
  return [...s.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
}

console.log('template-custom-html: ok');
