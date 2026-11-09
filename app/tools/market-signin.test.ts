// Marketplace sign-in link: the token travels in the URL fragment, and the
// email and text a buyer gets pass the no-AI-slop check.
// Run: npx tsx tools/market-signin.test.ts
import assert from 'node:assert/strict';
import { marketSigninUrl, readSigninHash, signinEmail, signinText } from '../supabase/functions/_shared/market-signin.ts';
import { slopFindings, slopReport } from '../supabase/functions/_shared/no-ai-slop.ts';

const token = 'eyJ3IjoxLCJiIjo5fQ.abc-_DEF';
const url = marketSigninUrl('https://app.example.com/', token, 'Ann Marie One');
assert.equal(url, `https://app.example.com/marketplace#access=${encodeURIComponent(token)}&name=Ann`);
assert.ok(!new URL(url).search, 'the token is never in the query string');
assert.deepEqual(readSigninHash(new URL(url).hash), { token, name: 'Ann' });
assert.deepEqual(readSigninHash(`#access=${encodeURIComponent(token)}`), { token, name: null });
assert.equal(readSigninHash('#deal=12'), null);
assert.equal(readSigninHash(''), null);
assert.equal(readSigninHash(`#access=${'x'.repeat(401)}`), null);

for (const name of ['Ann One', null, '  ']) {
  const m = signinEmail({ name, url });
  for (const part of [m.subject, m.text]) {
    const f = slopFindings(part);
    assert.equal(f.length, 0, slopReport(f));
  }
  assert.ok(m.text.includes(url) && m.html.includes(url.replace(/&/g, '&amp;')), 'the email carries the link');
  assert.ok(!/<script|javascript:/i.test(m.html));
}
assert.ok(signinEmail({ name: 'Ann One', url }).text.startsWith('Hi Ann,'));
assert.ok(signinEmail({ name: '<b>x</b>', url }).html.includes('&lt;b&gt;x&lt;/b&gt;'), 'a name is escaped');

const sms = signinText(url);
assert.equal(slopFindings(sms).length, 0, slopReport(slopFindings(sms)));
assert.ok(sms.endsWith(url));

console.log('market-signin ok');
