/**
 * The "please sign" email: it reads as a signature request, carries the
 * sender's own message (escaped, line breaks kept) in both parts, and has the
 * one big button to the signer's link.
 * Run with: deno test app/supabase/functions/_shared/emails.test.ts
 */
import { assertEquals, assertMatch, assertNotMatch } from 'jsr:@std/assert@1';
import { signingEmail } from './emails.ts';

const base = {
  company: { name: 'Acme Homes', legal: 'Acme Holdings, LLC' },
  contractName: '486 Scott Rd PSA', signerName: 'Ronald Moore', role: 'Seller',
  url: 'https://clozr.app/sign/?t=abc', senderName: 'Sam Carter',
};

Deno.test('signing request carries the sender message and the button', () => {
  const m = signingEmail({ ...base, message: 'Price is $142k.\nCall me <now>' });
  assertEquals(m.subject, 'Signature requested: 486 Scott Rd PSA');
  assertMatch(m.html, /Ronald, please review and sign/);
  assertMatch(m.html, /Sam Carter at Acme Homes<\/strong> is requesting your signature/);
  assertMatch(m.html, /Message from Sam Carter/);
  assertMatch(m.html, /Price is \$142k\.<br>Call me &lt;now&gt;/);
  assertMatch(m.html, /href="https:\/\/clozr\.app\/sign\/\?t=abc"[^>]*>Review &amp; sign/);
  assertMatch(m.text, /Message from Sam Carter:\nPrice is \$142k\.\nCall me <now>/);
});

Deno.test('no message, no sender: no empty message box, company asks', () => {
  const m = signingEmail({ ...base, message: '  ', senderName: null });
  assertNotMatch(m.html, /Message from/);
  assertMatch(m.html, /<strong[^>]*>Acme Homes<\/strong> is requesting your signature/);
});

Deno.test('reminder reads as a reminder', () => {
  const r = signingEmail({ ...base, reminder: true });
  assertEquals(r.subject, 'Reminder: please sign 486 Scott Rd PSA');
  assertMatch(r.html, />Sign now/);
});
