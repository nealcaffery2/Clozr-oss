// mime-text: a cold reply read over IMAP comes back as readable text, not MIME.
// Run with:  npx tsx tools/mime-text.test.ts
import assert from 'node:assert/strict';
import { mimeText } from '../supabase/functions/_shared/mime-text';
import { classifyReply } from '../supabase/functions/_shared/cold-campaign';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');

// Gmail reply: multipart/alternative, base64 parts, boundary on a folded header line.
const gmailHeader = 'From: Bob <bob@gmail.com>\r\nContent-Type: multipart/alternative;\r\n boundary="000000000000abc"\r\n';
const gmailBody = [
  '--000000000000abc',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('Please take me off your list. Thanks\r\n\r\nOn Tue, Alex wrote:\r\n> Hi Bob'),
  '--000000000000abc',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<div>Please take me off your list.</div>'),
  '--000000000000abc--',
].join('\r\n');
const gmail = mimeText(gmailHeader, gmailBody);
assert.ok(gmail.startsWith('Please take me off your list. Thanks'), gmail);
assert.ok(!gmail.includes('000000000000abc'));
assert.equal(classifyReply({ from: 'bob@gmail.com', subject: 'Re: hi', body: gmail }), 'unsubscribe');

// HTML only, quoted-printable, multi-byte characters.
const qp = mimeText('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n',
  '<p>Caf=C3=A9 deal, call me at 210-555-0100=\r\n today</p>');
assert.equal(qp, 'Café deal, call me at 210-555-0100 today');

// A bounce (multipart/report, nested) reads as the human part.
const bounceBody = [
  '--outer', 'Content-Type: multipart/related; boundary="inner"', '',
  '--inner', 'Content-Type: text/plain; charset="UTF-8"', '', "** Address not found **\r\nYour message wasn't delivered", '--inner--',
  '--outer', 'Content-Type: message/delivery-status', '', 'Status: 5.1.1', '--outer--',
].join('\r\n');
assert.ok(mimeText('Content-Type: multipart/report; report-type=delivery-status; boundary="outer"', bounceBody).startsWith('** Address not found **'));

// No header saved (rows stored before this fix): the boundary is read off the body.
assert.ok(mimeText('', gmailBody).startsWith('Please take me off your list.'));

// Base64 cut mid-quad by a partial FETCH decodes what is there.
const cut = b64('Interested, send me the link').replace(/\r\n/g, '').slice(0, 26); // 24 whole chars, 18 bytes
assert.ok(mimeText('Content-Type: text/plain\r\nContent-Transfer-Encoding: base64', cut).startsWith('Interested, send'));

// Plain single-part mail passes through.
assert.equal(mimeText('Content-Type: text/plain', 'yes call me\r\n'), 'yes call me');

console.log('mime-text: ok');
