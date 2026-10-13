// The one-screen campaign plan: a recipe's steps become each buyer's messages
// on the channels they can take, timed into the send window, follow-ups only
// after no reply.
//
//   npx tsx tools/quick-campaign.test.ts

import type { BuyerRow } from '../lib/dispo-plan';
import type { CampaignData } from '../lib/dispo-campaign';
import { BUILTIN_PRESETS, buildQuickPlan, defaultCopy, parseSteps, recipeWords } from '../lib/quick-campaign';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const deal: CampaignData['deal'] = {
  id: 7, address: '123 Oak St', city: 'San Antonio', state: 'TX', zip: '78210', price: 150000, arv: 220000, beds: 3, baths: 2, sqft: 1400, propertyType: 'single_family',
  lat: 29.4, lng: -98.47, updatedAt: '2026-10-01T00:00:00Z', sellerId: null,
} as unknown as CampaignData['deal'];
const data: CampaignData = { deal, buyers: [], matches: [], offers: [], closed: [], runs: [], inbound: [], photos: [], templates: [], gmail: [] };
const row = (id: number, over: Partial<BuyerRow['b']> = {}): BuyerRow => ({
  b: { id, name: `Buyer ${id}`, company: null, phone: '+12105550100', email: `b${id}@x.com`, status: 'Active', vip: false, vetted: true, blacklisted: false, preferredChannel: 'email_and_sms', wantsFollowUps: true, tags: [], markets: [], strategies: ['fix_and_flip'], priceMin: null, priceMax: null, cities: ['San Antonio'], zips: [], buyerType: 'flipper', notes: null, source: null, lastActivityAt: null, ...over },
  stats: { dealsSent: 0, dealsReplied: 0, dealsOffered: 0, closed: 0, purchases: 0, vip: false, vetted: true, score: 70 },
  purchases: [], facts: { firstName: `B${id}`, lastPurchase: null, strategies: ['fix_and_flip'], buyerType: 'flipper' } as unknown as BuyerRow['facts'],
  lastSentThisDeal: null, match: null, level: 2, levelLabel: 'Warm', probability: 40,
} as unknown as BuyerRow);

const copy = defaultCopy([]);
const fields = { first_name: '', address: '123 Oak St', city: 'San Antonio', price: '$150,000', beds: '3', baths: '2', deal_link: 'https://x.y/d', rep_first_name: 'Morgan', company: 'Acme Homes' };
const ctx = { repName: 'Morgan Carter', company: 'Acme Homes' };
const now = new Date('2026-10-09T15:00:00Z');
const base = { copy, dealFields: fields, ctx, data, links: {}, ai: {}, aiIntro: false, tz: 'America/Chicago', now };
const machine = BUILTIN_PRESETS.find((p) => p.key === 'machine')!;
const all = { sms: true, email: true, rvm: true, ai_call: true };

{
  const plan = buildQuickPlan({ ...base, rows: [row(1)], preset: machine, channels: all });
  const m = plan.recipients[0]?.messages ?? [];
  eq('the full machine gives a buyer every step', m.map((x) => `${x.kind}:${x.channel}`).join(','), 'intro:sms,brief:email,brief:sms,brief:rvm,followup:sms,followup:ai_call,followup:email');
  check('steps are timed in order', m.every((x, i) => !i || Date.parse(x.send_at) >= Date.parse(m[i - 1].send_at)));
  eq('only_if_no_reply follows the recipe', m.filter((x) => x.only_if_no_reply).map((x) => x.channel).join(','), 'rvm,sms,ai_call,email');
  check('the voicemail and the call carry the rendered deal', /123 Oak St/.test(m.find((x) => x.channel === 'rvm')!.body) && /\$150,000/.test(m.find((x) => x.channel === 'ai_call')!.body));
  check('the email brief has a subject and the deal in the body', /123 Oak St/.test(m.find((x) => x.channel === 'email')!.subject ?? '') && /123 Oak St/.test(m.find((x) => x.channel === 'email')!.body));
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1)], preset: machine, channels: { ...all, rvm: false, ai_call: false } });
  const m = plan.recipients[0]?.messages ?? [];
  check('channels switched off drop their steps', m.every((x) => x.channel === 'sms' || x.channel === 'email') && m.length === 5);
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1, { preferredChannel: 'email_only' })], preset: machine, channels: all });
  const m = plan.recipients[0]?.messages ?? [];
  check('an email-only buyer gets only the emails', m.every((x) => x.channel === 'email') && m.length === 2, m.map((x) => x.channel));
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1, { phone: null, email: null })], preset: machine, channels: all });
  check('a buyer with no way to reach them is skipped with a reason', plan.recipients.length === 0 && plan.skipped[0]?.why === 'no phone', plan.skipped);
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1, { wantsFollowUps: false })], preset: machine, channels: all });
  check('no follow-ups for a buyer who asked for none', plan.recipients[0].messages.every((x) => x.kind !== 'followup'));
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1), row(2), row(3)], preset: machine, channels: all });
  const firsts = plan.recipients.map((r) => Date.parse(r.messages[0].send_at));
  check('buyers are staggered, not blasted in the same second', new Set(firsts).size === 3, firsts);
  const email = BUILTIN_PRESETS.find((p) => p.key === 'email')!;
  const e = buildQuickPlan({ ...base, rows: [row(1), row(2)], preset: email, channels: all });
  check('an email-only recipe goes out together', e.recipients[0].messages[0].send_at === e.recipients[1].messages[0].send_at);
}
{
  const plan = buildQuickPlan({ ...base, rows: [row(1)], preset: machine, channels: all, aiIntro: true, ai: { 1: { intro: 'Hey B1, written for you' } } });
  check('an AI intro replaces the template when asked', plan.recipients[0].messages[0].body === 'Hey B1, written for you');
}
eq('parseSteps clamps and defaults', JSON.stringify(parseSteps([{ channel: 'sms', kind: 'followup', after_hours: -3 }, { channel: 'fax', kind: 'brief' }, { channel: 'rvm', kind: 'brief', after_hours: 2, only_if_no_reply: true }])),
  JSON.stringify([{ channel: 'sms', kind: 'followup', after_hours: 0, only_if_no_reply: true }, { channel: 'rvm', kind: 'brief', after_hours: 2, only_if_no_reply: true }]));
eq('recipeWords reads a recipe', recipeWords(machine.steps), '3 texts, 2 emails, a voicemail and an AI call over 2 days');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
