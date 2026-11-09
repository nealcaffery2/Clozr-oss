// Run: npx tsx tools/email-text.test.ts
import assert from 'node:assert/strict';
import { emailGist, htmlToText } from '../lib/email-text';

const pd = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><head><title>Acme Homes sent you 912 Cordial Road</title><style type="text/css">body { width: 100% !important; }</style></head><body><div style="display: none; max-height: 0px;">Preheader text</div><table><tr><td><b>Acme Homes</b> sent you <b>912 Cordial Road - PSA</b>.</td></tr><tr><td><a href="x">Open the document</a></td></tr></table></body></html>';
const t = htmlToText(pd);
assert.ok(t.startsWith('Acme Homes sent you 912 Cordial Road - PSA .'), t);
assert.ok(!/DOCTYPE|width: 100%|Preheader/.test(t), t);
assert.ok(t.includes('Open the document'));

const reply = 'Thank you for sending.\n\nIs that correct?\n\nOn Mon, May 25, 2026 at 9:14 AM Jordan Blake <jordan@sampleoffers.com> wrote:\n> Here are the next steps\n> ...';
assert.equal(emailGist(reply), 'Thank you for sending.\n\nIs that correct?');
assert.equal(emailGist('<p>Hi&nbsp;Dan,</p><p>Sounds good.</p><div class="gmail_quote">On Tue, May 26, 2026 at 8:00 AM Dan wrote:<br>old</div>'), 'Hi Dan,\nSounds good.');
// A numeric entity past U+10FFFF (a broken newsletter, spam) is dropped, not thrown: one such row took the whole list down.
assert.equal(htmlToText('<p>hi &#1114112; there</p>'), 'hi there');
assert.equal(emailGist('<div>hi &#xFFFFFFFF; x &#0; y</div>'), 'hi x y');
assert.equal(htmlToText('<p>&#8217;tis &#x2014; fine</p>'), '\u2019tis \u2014 fine');

console.log('email-text: ok');
