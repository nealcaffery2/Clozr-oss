// The campaign plan: who gets what, in what order, and what is skipped.
// Run with:  npx tsx tools/dispo-plan.test.ts
import assert from 'node:assert/strict';
import { buildPlan, buyerRow, type Settings } from '../lib/dispo-plan';
import type { CampaignBuyer, CampaignData } from '../lib/dispo-campaign';

const buyer = (p: Partial<CampaignBuyer>): CampaignBuyer => ({
  id: 1, name: 'Chris Anderson', company: null, phone: '+12105550100', email: 'chris@example.com', status: 'Active', vip: false, vetted: false, blacklisted: false,
  preferredChannel: 'email_and_sms', wantsFollowUps: true, tags: [], markets: [], strategies: ['fix_and_flip'], priceMin: null, priceMax: null, cities: [], zips: [],
  buyerType: null, notes: null, source: null, lastActivityAt: null, ...p,
});
const data: CampaignData = {
  deal: { id: 9, sellerId: 1, price: 200000, updatedAt: '2026-09-01', address: '1 Main St', city: 'Dallas', zip: '75211', lat: 32.75, lng: -96.9, sqft: 1500, beds: 3, baths: 2, propertyType: 'Single Family' },
  buyers: [
    buyer({}),
    buyer({ id: 2, name: 'Pat Lee', phone: null, notes: 'Past purchase: 5 Elm' }),
    buyer({ id: 3, name: 'Blocked', blacklisted: true }),
    buyer({ id: 4, name: 'Sam Roe', wantsFollowUps: false }),
    buyer({ id: 5, name: 'Found', status: 'Prospect', tags: ['buyer-prospect'], source: 'genius' }),
    buyer({ id: 6, name: 'Riley Agent', tags: ['realtors'], buyerType: 'realtors', cities: ['Dallas'], markets: ['Dallas'] }),
    buyer({ id: 7, name: 'Window Shopper', tags: ['secret-blacklist'] }),
  ],
  matches: [], offers: [], runs: [], inbound: [], photos: [], templates: [], gmail: [],
  closed: [{ buyer_id: 1, line1: '9 Oak', city: 'Dallas', zip: '75211', lat: 32.76, lng: -96.9, sqft: 1450, closed_on: '2026-06-14' }],
};
const settings: Settings = {
  intro: { mode: 'own', templateBody: "Hey {{first_name}} - It's {{rep_first_name}}. I noticed you wrapped up a flip on {{last_purchase_address}} about {{last_purchase_ago}} ago. I've got a {{property_type}} fixer project that's just {{deal_distance}} away.{{similar_size}} Want more details?", split: 'never', emoji: 'never', instructions: '', tone: 'friendly', avoid: [] },
  variations: { useImage: true, imageUrl: 'https://x.test/p.jpg', reserveLevel: 0, frequency: 'frequently' },
  brief: { order: 'sms', wait: 1, waitUnit: 'hours', sms: true, smsBody: 'Deal: {{address}} at {{price}}', email: true, emailSubject: 'New deal: {{address}}', emailBody: 'Hi {{first_name}}', emailHtml: null },
  followups: { after: 1, afterUnit: 'hours', order: 'sms', wait: 23, waitUnit: 'hours', smart: false, sms: true, smsAi: false, smsList: ['Still there {{first_name}}?'], email: true, emailAi: false, emailList: [{ subject: 'Following up', body: 'Hi again' }], pauseUnengaged: true, unengagedN: 3 },
  timezone: 'America/Chicago', startAt: '',
};
const fields = { address: '1 Main St', city: 'Dallas', price: '$200,000', property_type: 'SFH' };
const now = new Date('2026-09-14T15:00:00Z'); // 10:00 Chicago
const rows = data.buyers.map((b) => buyerRow(b, data));
const plan = buildPlan(rows, settings, fields, { repName: 'Morgan Lane', company: 'Acme Homes' }, data, {}, {}, now);

assert.deepEqual(plan.skipped, [{ name: 'Blocked', why: 'blacklisted' }, { name: 'Found', why: 'buyer prospect' }, { name: 'Window Shopper', why: 'blacklisted' }]);
assert.ok(plan.recipients.some((r) => r.buyer_id === 6), 'an in-market realtor is sent, not skipped as a prospect');
const chris = plan.recipients.find((r) => r.buyer_id === 1)!;
const intro = chris.messages.find((m) => m.kind === 'intro')!;
assert.ok(intro.body.startsWith("Hey Chris - It's Morgan. I noticed you wrapped up a flip on 9 Oak about 3 months ago. I've got a SFH fixer project that's just 0.7 miles away."), intro.body);
assert.ok(intro.body.includes("similar size"), 'similar size only when the sqft is within 20%');
assert.deepEqual(intro.media_urls, ['https://x.test/p.jpg']);
assert.deepEqual(chris.messages.map((m) => `${m.kind}:${m.channel}`), ['intro:sms', 'brief:sms', 'brief:email', 'followup:sms', 'followup:email']);
assert.ok(chris.messages.filter((m) => m.kind === 'followup').every((m) => m.only_if_no_reply));
const t = chris.messages.map((m) => Date.parse(m.send_at));
assert.ok(t.every((x, i) => !i || x >= t[i - 1]), 'in send order');

const pat = plan.recipients.find((r) => r.buyer_id === 2)!;
assert.deepEqual(pat.messages.map((m) => m.channel), ['email', 'email'], 'no phone: no intro, email brief and follow-up only');

const sam = plan.recipients.find((r) => r.buyer_id === 4)!;
assert.equal(sam.messages.filter((m) => m.kind === 'followup').length, 0, 'wants no follow-ups');
const samIntro = sam.messages.find((m) => m.kind === 'intro')!;
assert.ok(samIntro.body.startsWith("Hey Sam - it's Morgan. I've got a SFH deal in Dallas"), 'no purchase on file: generic intro, not a broken sentence');

assert.ok(Date.parse(sam.messages[0].send_at) > Date.parse(chris.messages[0].send_at), 'first texts are staggered');

const picked = buildPlan(rows, settings, fields, { repName: 'Morgan Lane', company: 'Acme Homes' }, data, {}, {}, now, {}, [5]);
assert.ok(picked.recipients.some((r) => r.buyer_id === 5), 'a hand-picked prospect is on the marketing list');
assert.equal(picked.skipped.some((s) => s.name === 'Found'), false);

console.log('dispo-plan: all assertions passed');
