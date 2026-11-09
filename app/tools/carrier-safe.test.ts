// The carrier check every outgoing text passes (lib/carrier-safe): trigger
// wording swapped with the meaning kept, the unsendable refused with a reason,
// the risky flagged, a rep's own reply never rewritten, and the real Acme Homes
// and Compr texts going out as they should.
// Run: npx tsx tools/carrier-safe.test.ts
import assert from 'node:assert/strict';
import { carrierCheck, carrierReport, greetingName, plainForSms } from '../lib/carrier-safe';
import { smsSegments } from '../lib/send-check';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const out = (t: string) => carrierCheck(t).text;

test('Compr cold outreach loses "free" and keeps its meaning', () => {
  assert.equal(
    out("Hey Alex, it's Cody with Acme Homes. Want a quick free demo? No worries if it's not your thing."),
    "Hey Alex, it's Cody with Acme Homes. Want a quick demo? No worries if it's not your thing.",
  );
  assert.equal(out("If you'd like to see Compr on one of your own deals, I can set up a free demo."), "If you'd like to see Compr on one of your own deals, I can set up a quick demo.");
  assert.equal(out('Happy to show you on a quick free demo if you would like.'), 'Happy to show you on a quick demo if you would like.');
});

test('"free" phrases that are not offers stay', () => {
  for (const t of ['Feel free to call me.', 'The house is free and clear.', 'Call our toll-free line.', 'Can you free up an hour Tuesday?']) assert.equal(out(t), t, t);
  assert.equal(out('We take it off your hands for free.'), 'We take it off your hands at no cost.');
});

test('real-estate cash wording is swapped', () => {
  assert.equal(out('We can make you a cash offer this week.'), 'We can make you an offer this week.');
  assert.equal(out('Cash offers go out Friday.'), 'Offers go out Friday.');
  assert.equal(out('We buy houses for cash.'), 'We buy houses as-is.');
  assert.equal(out('Calling all cash buyers in Tulsa'), 'Calling all buyers in Tulsa');
  // A merge key that happens to say cash is not wording.
  assert.equal(out('Asking Price: {{cash_price}}'), 'Asking Price: {{cash_price}}');
});

test('hype and pressure words are swapped', () => {
  assert.equal(out('Guaranteed close in 7 days.'), 'Firm close in 7 days.');
  assert.equal(out('Act now, this one goes fast!!!'), 'Reply when you can, this one goes fast!');
  assert.equal(out('URGENT: new deal in Dallas'), 'Soon: new deal in Dallas');
  assert.equal(out('No obligation, just a look.'), 'No pressure, just a look.');
});

test('shouting is lowered, carrier keywords and acronyms are not', () => {
  assert.equal(out('BRAND NEW listing near the HOA pool. Reply STOP to opt out.'), 'Brand new listing near the HOA pool. Reply STOP to opt out.');
  assert.equal(out('ARV is 240k, MLS comps attached.'), 'ARV is 240k, MLS comps attached.');
});

test('the greeting name: websites and placeholders become "there", real names are capitalised', () => {
  // Every one of these was in a Compr cold-outreach text queued for Oct 17.
  for (const n of ['fox2now.com', 'Byowner.com', '[site-name]', 'J', 'Dr.', 'OKC', 'SELL', 'crsolutions.net']) assert.equal(greetingName(n), 'there', n);
  assert.equal(greetingName('JAMES'), 'James');
  assert.equal(greetingName('jose'), 'Jose');
  assert.equal(greetingName('DON'), 'Don');
  assert.equal(greetingName('AMY'), 'Amy');
  assert.equal(greetingName('Michael'), null);
  assert.equal(greetingName('McGuinn'), null);
  assert.equal(greetingName('{{first_name}}'), null);
  assert.equal(out('Hey fox2now.com, Cody again.'), 'Hey there, Cody again.');
  assert.equal(out('Hi JAMES, quick question.'), 'Hi James, quick question.');
  assert.equal(out('Hi there, quick question.'), 'Hi there, quick question.');
  assert.equal(out('hey mike how are you'), 'hey mike how are you');
});

test('the unsendable is blocked with the reason', () => {
  // A shortened link (a Maps share, say) goes, with a warning; nothing with a link is refused.
  const c = carrierCheck('See the house: bit.ly/3abc');
  assert.equal(c.blocked, false);
  assert.match(carrierReport(c, ['warn']), /shortened links/);
  assert.equal(carrierCheck("Congratulations, you've won a free home valuation").blocked, false);
  assert.equal(carrierCheck('Please verify your account at our site').blocked, true);
});

test('risky but allowed is flagged, not changed', () => {
  const c = carrierCheck('Is there still a loan on the house?');
  assert.equal(c.blocked, false);
  assert.equal(c.text, 'Is there still a loan on the house?');
  assert.ok(c.findings.some((f) => f.severity === 'warn' && /lending/.test(f.why)));
  const two = carrierCheck('More Info: deals.example.com/a\nComps: deals.example.com/b');
  assert.ok(two.findings.some((f) => /more than one link/.test(f.why)));
});

test("a rep's reply in a live thread is never rewritten, only blocked", () => {
  const r = carrierCheck('Sure, we can do a cash offer. FREE inspection too!!', { mode: 'reply' });
  assert.equal(r.text, 'Sure, we can do a cash offer. FREE inspection too!!');
  assert.equal(r.blocked, false);
  assert.ok(r.findings.length >= 3 && r.findings.every((f) => f.severity === 'warn'));
  assert.equal(carrierCheck('here: https://maps.app.goo.gl/x', { mode: 'reply' }).blocked, false);
});

test('the live Acme Homes and Compr templates pass untouched', () => {
  const clean = [
    'Compr: Hey {{first_name}}, it\'s Alex. You signed up for Compr. Want me to run one of your deals with you? Reply with an address. Reply STOP to opt out.',
    'Compr: {{first_name}}, the card on your Compr {{plan}} plan was declined. Update it in Settings, Plan and billing: underwriting.example.com/app.html. Reply STOP to opt out.',
    "Hey {{first_name}}, {{rep_first_name}} again. {{address}} in {{city}} is still available. Want me to send the numbers?",
    'Hi {{first_name}}, this is {{rep_name}} with Acme Homes. Still happy to take a look at {{address}}. What is the best time today for a short call?',
  ];
  for (const t of clean) {
    const c = carrierCheck(t);
    assert.equal(c.text, t, t);
    assert.equal(c.findings.length, 0, `${t}: ${carrierReport(c, ['fix', 'warn', 'block'])}`);
  }
});

test('a dispo blast with check-mark bullets bills at 160 a segment, not 70', () => {
  const blast = '1091 Sparrow Ave, Memphis, TN 38106\nAsking Price: $45,000\n✔️ 2 Bed / 1 Bath\n✔️ 650 Sq Ft\n✔️ Built in 1930\n✔️ Vacant · Lockbox on site\nComps and photos: https://underwriting.example.com/v/abc–123\nReply STOP to opt out';
  const c = carrierCheck(blast);
  assert.equal(c.text, '1091 Sparrow Ave, Memphis, TN 38106\nAsking Price: $45,000\n- 2 Bed / 1 Bath\n- 650 Sq Ft\n- Built in 1930\n- Vacant - Lockbox on site\nComps and photos: https://underwriting.example.com/v/abc–123\nReply STOP to opt out');
  assert.equal(smsSegments(blast).unicode, true);
  // The link keeps its en dash (links are never rewritten), so this one stays UCS-2; without it the text is GSM-7.
  assert.equal(smsSegments(c.text.replace('–', '-')).unicode, false);
  assert.ok(c.findings.some((f) => f.severity === 'fix' && /✔/.test(f.found)), carrierReport(c, ['fix']));
});

test('the Compr intro\'s curly apostrophe goes plain and halves its segments', () => {
  const intro = 'Hi Adam, my name is Alex, and I’m the Sales Manager at Compr. ' + 'We help real estate investors, wholesalers and agents price a deal in minutes. '.repeat(7);
  const c = carrierCheck(intro);
  assert.ok(!c.text.includes('’') && c.text.includes("I'm"));
  assert.ok(smsSegments(c.text).segments * 2 <= smsSegments(intro).segments + 1, `${smsSegments(intro).segments} → ${smsSegments(c.text).segments}`);
});

test('quotes, dashes, ellipses and odd spaces go plain', () => {
  assert.equal(plainForSms('“Close” 10/30 – 11/2 — ok… see\u00a0you').text, '"Close" 10/30 - 11/2 - ok... see you');
  assert.deepEqual(plainForSms('plain text').swapped, []);
});

test('a rep\'s reply keeps its curly quotes (sent as typed)', () => {
  assert.equal(carrierCheck('I’m on it — call you at 3', { mode: 'reply' }).text, 'I’m on it — call you at 3');
});

test('other emoji are left alone', () => {
  assert.equal(carrierCheck('New listing 🏠 3 bed').text, 'New listing 🏠 3 bed');
});

console.log(`carrier-safe: ${passed} passed`);

// A word inside a link is never a trigger and the link is never rewritten.
{
  const c = carrierCheck('Hi John, here you go: https://yourcompany.com/congratulations-free-offer');
  assert.equal(c.blocked, false);
  assert.ok(c.text.includes('https://yourcompany.com/congratulations-free-offer'));
  assert.ok(!c.findings.some((f) => f.found.includes('congratulations')));
}
// Prize wording warns but goes through.
{
  const c = carrierCheck('Congratulations on closing!');
  assert.equal(c.blocked, false);
  assert.match(carrierReport(c, ['warn']), /prize language/);
}
