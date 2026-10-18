// The carrier check every outgoing text passes (lib/carrier-safe): trigger
// wording swapped with the meaning kept, the unsendable refused with a reason,
// the risky flagged, a rep's own reply never rewritten, and the real Acme Homes
// and Compr texts going out as they should.
// Run: npx tsx tools/carrier-safe.test.ts
import assert from 'node:assert/strict';
import { carrierCheck, carrierReport, greetingName } from '../lib/carrier-safe';

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
  const c = carrierCheck('See the house: bit.ly/3abc');
  assert.equal(c.blocked, true);
  assert.match(carrierReport(c), /shortened links/);
  assert.equal(carrierCheck("Congratulations, you've won a free home valuation").blocked, true);
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
  assert.equal(carrierCheck('here: tinyurl.com/x', { mode: 'reply' }).blocked, true);
});

test('the live Acme Homes and Compr templates pass untouched', () => {
  const clean = [
    'Compr: Hey {{first_name}}, it\'s Alex. You signed up for Compr. Want me to run one of your deals with you? Reply with an address. Reply STOP to opt out.',
    'Compr: {{first_name}}, the card on your Compr {{plan}} plan was declined. Update it in Settings, Plan and billing: thecompr.ai/app.html. Reply STOP to opt out.',
    "Hey {{first_name}}, {{rep_first_name}} again. {{address}} in {{city}} is still available. Want me to send the numbers?",
    'Hi {{first_name}}, this is {{rep_name}} with Acme Homes. Still happy to take a look at {{address}}. What is the best time today for a short call?',
  ];
  for (const t of clean) {
    const c = carrierCheck(t);
    assert.equal(c.text, t, t);
    assert.equal(c.findings.length, 0, `${t}: ${carrierReport(c, ['fix', 'warn', 'block'])}`);
  }
});

console.log(`carrier-safe: ${passed} passed`);
