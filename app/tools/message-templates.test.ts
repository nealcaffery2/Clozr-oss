// Email templates: blocks → HTML/text, and merging into HTML escapes.
// Run with:  npx tsx tools/message-templates.test.ts
import assert from 'node:assert/strict';
import { blocksToEmail, fieldsUsed, renderEmail, toBlocks } from '../lib/message-templates';

const blocks = toBlocks([
  { type: 'heading', text: 'About {{address}}' },
  { type: 'paragraph', text: 'Hi {{first_name}},\nline two' },
  { type: 'button', label: 'Go', url: 'javascript:alert(1)' },
  { type: 'nope' },
]);
assert.equal(blocks.length, 3, 'unknown block types are dropped');

const { html, text } = blocksToEmail(blocks);
assert.ok(html.includes('<table role="presentation"'), 'table layout');
assert.ok(html.includes('Hi {{first_name}},<br>line two'), 'newlines become <br>');
assert.ok(html.includes('href="#"'), 'non-web hrefs are dropped');
assert.equal(text, 'ABOUT {{ADDRESS}}\n\nHi {{first_name}},\nline two\n\nGo: javascript:alert(1)');

const out = renderEmail({ subject: 'Re {{address}}', body_html: html, body_text: text }, { first_name: '<b>Kara</b>', address: '1 Main' });
assert.equal(out.subject, 'Re 1 Main');
assert.ok(out.html!.includes('Hi &lt;b&gt;Kara&lt;/b&gt;,'), 'merge values are escaped in HTML');
assert.ok(out.text.includes('Hi <b>Kara</b>,'), 'and left alone in text');
assert.deepEqual(fieldsUsed('{{first_name}} {address} {{first_name}}'), ['first_name', 'address']);

// A designed template with a blank field: no empty paragraph, no broken image.
const tidy = renderEmail(
  { subject: '', body_html: '<p>Hi</p><p style="x">{{purchase_note}}</p><a href="{{marketing_link}}"><img src="{{photo_url}}" alt="x"></a>', body_text: '' },
  { purchase_note: '', photo_url: '', marketing_link: 'https://x' },
);
assert.equal(tidy.html, '<p>Hi</p><a href="https://x"></a>', 'an empty paragraph and a source-less image are dropped');
const kept = renderEmail({ subject: '', body_html: '<p>{{purchase_note}}</p><img src="{{photo_url}}">', body_text: '' }, { purchase_note: 'Near you.', photo_url: 'https://i/x.jpg' });
assert.equal(kept.html, '<p>Near you.</p><img src="https://i/x.jpg">');
console.log('message-templates: ok');
