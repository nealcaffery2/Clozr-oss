// HTML email: detect it, reduce it to words, and strip what an iframe must not run.
// Run with:  npx tsx tools/email-html.test.ts
import assert from 'node:assert/strict';
import { emailPlain, emailSrcDoc, htmlToPlain, looksLikeHtml, sanitizeEmailHtml } from '../lib/email-html';

const letter = 'Hi Taylor,\n\nThank you for sending this over.\n\nThanks,\nKara';
assert.equal(looksLikeHtml(letter), false);
assert.equal(emailPlain(letter), letter, 'plain mail is unchanged');
assert.equal(looksLikeHtml('<p>Hi</p>'), false, 'one tag is not a document');

const signing = `<p>Hi Robin,</p><p>Acme Homes has sent you <strong>Agreement to Buy and Sell Real Estate - 8813 Magnolia Fls</strong> to review and sign.</p><p><a href="https://example.com/sign/?t=abc" style="display:inline-block;padding:10px 16px;background:#0A8560;color:#fff;border-radius:8px;text-decoration:none">Review and sign</a></p><p style="color:#71717a;font-size:12px">Or open this link: https://example.com/sign/?t=abc</p>`;
assert.equal(looksLikeHtml(signing), true, 'a paragraph email with a link is HTML');
const signingPlain = htmlToPlain(signing);
assert.ok(signingPlain.includes('Review and sign (https://example.com/sign/?t=abc)'), 'the button stays a link');
assert.ok(!signingPlain.includes('<p'), 'tags are not the message');
assert.ok(emailSrcDoc(signing).includes('href="https://example.com/sign/?t=abc"'));

const designed = `<!DOCTYPE html><html><body>
<style>body{background:url("javascript:alert(1)"));} .x{color:red}</style>
<p>Hi Kara,</p>
<table><tr><td>Walkthrough</td><td>20 minutes</td></tr></table>
<a href="https://example.com/how-we-buy" onclick="alert(1)">Read the overview</a>
<a href="javascript:alert(1)">nope</a>
<img src="https://example.com/logo.png" onerror="alert(1)">
<img src="cid:logo">
<script>alert(1)</script>
</body></html>`;

assert.equal(looksLikeHtml(designed), true);
const plain = htmlToPlain(designed);
assert.ok(plain.includes('Hi Kara'), 'words survive');
assert.ok(plain.includes('Read the overview (https://example.com/how-we-buy)'), 'links stay readable');
assert.ok(!plain.includes('<table'), 'tags do not');
assert.ok(!plain.includes('<script'), 'a script element is not text');

const safe = sanitizeEmailHtml(designed);
assert.ok(!/<script/i.test(safe));
assert.ok(!/onclick/i.test(safe));
assert.ok(!/onerror/i.test(safe));
assert.ok(!/javascript:/i.test(safe));
assert.ok(safe.includes('href="https://example.com/how-we-buy"'));
assert.ok(safe.includes('src="https://example.com/logo.png"'));
assert.ok(!safe.includes('cid:logo'), 'a cid image with no bytes is dropped');
assert.ok(safe.includes('.x{color:red}'), 'ordinary css stays');
assert.ok(!/expression\s*\(/i.test(safe));

const doc = emailSrcDoc(designed);
assert.ok(doc.startsWith('<!DOCTYPE html>'));
assert.ok(doc.includes('target="_blank"'));
assert.ok(!/<script/i.test(doc));

const charset = '<html><body><div><table><tr><td>Offer</td></tr></table></div></body></html>';
assert.equal(looksLikeHtml(charset), true);
assert.equal(emailPlain('text/html; charset=utf-8 is just a sentence'), 'text/html; charset=utf-8 is just a sentence');

console.log('email-html.test.ts ok');
