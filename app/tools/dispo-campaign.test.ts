// The Marketing tab's pure half (components/dispo-campaign/logic.ts): the
// audience and who is left out, the plan summary and its launch sentence,
// merge-field checks, the results funnel — and the /demo sample data, which
// has to agree with the Overview tab's funnel.
// Run with:  npx tsx tools/dispo-campaign.test.ts
import assert from 'node:assert/strict';
import { buildPlan, buyerRow, DEFAULT_FILTERS, type Settings } from '../lib/dispo-plan';
import type { CampaignBuyer, CampaignData, CampaignResults } from '../lib/dispo-campaign';
import {
  audienceView, cadenceLabel, channelRows, channelWords, funnel, launchSentence, mergeCheck, planSummary, repliedBuyers, smsSegments, tzLabel, whenLabel,
} from '../components/dispo-campaign/logic';
import { demoFor, demoMarketing, demoIntro } from '../components/dispo-campaign/demo-data';

// ---- SMS segments
assert.equal(smsSegments(''), 0);
assert.equal(smsSegments('a'.repeat(160)), 1, 'GSM-7 fits 160');
assert.equal(smsSegments('a'.repeat(161)), 2, 'then 153 a segment');
assert.equal(smsSegments('a'.repeat(306)), 2);
assert.equal(smsSegments('a'.repeat(307)), 3);
assert.equal(smsSegments('It’s here'), 1, 'a curly apostrophe is UCS-2, still one segment when short');
assert.equal(smsSegments('’' + 'a'.repeat(70)), 2, 'UCS-2 fits 70');
assert.equal(smsSegments('{'.repeat(80)), 1, 'extension characters count twice: 160');
assert.equal(smsSegments('{'.repeat(81)), 2);

// ---- audience
const buyer = (p: Partial<CampaignBuyer>): CampaignBuyer => ({
  id: 1, name: 'Chris Anderson', company: null, phone: '+12105550100', email: 'chris@example.com', status: 'Active', vip: false, vetted: false, blacklisted: false,
  preferredChannel: 'email_and_sms', wantsFollowUps: true, tags: [], markets: [], strategies: ['fix_and_flip'], priceMin: null, priceMax: null, cities: [], zips: [],
  buyerType: null, notes: null, source: null, lastActivityAt: null, ...p,
});
const m = (buyer_id: number, score: number, sent_at: string | null = null) => ({ deal_id: 9, buyer_id, score, reasons: [], status: 'matched', sent_at, replied_at: null, updated_at: '2026-09-20' });
const data: CampaignData = {
  deal: { id: 9, sellerId: 1, price: 200000, updatedAt: '2026-09-01', address: '1 Main St', city: 'Dallas', zip: '75211', lat: 32.75, lng: -96.9, sqft: 1500, beds: 3, baths: 2, propertyType: 'Single Family' },
  buyers: [
    buyer({ id: 1, name: 'Chris Anderson' }),
    buyer({ id: 2, name: 'Pat Lee', phone: null }),
    buyer({ id: 3, name: 'Dee Nott', tags: ['DNC'] }),
    buyer({ id: 4, name: 'Sent Before' }),
    buyer({ id: 5, name: 'Low Score' }),
    buyer({ id: 6, name: 'No Match' }),
  ],
  matches: [m(1, 90), m(2, 80), m(3, 70), m(4, 88, '2026-09-10'), m(5, 40)],
  offers: [], runs: [], inbound: [], photos: [], templates: [], gmail: [], closed: [],
};
const rows = data.buyers.map((b) => buyerRow(b, data));
const v = audienceView(rows, DEFAULT_FILTERS, {}, data.deal.price);
assert.deepEqual(v.matched.map((r) => r.b.id).sort(), [1, 2, 3, 4], 'matched: score 55+');
assert.deepEqual(v.others.map((r) => r.b.id).sort(), [5, 6]);
assert.deepEqual(v.audience.map((r) => r.b.id).sort(), [1, 2, 3], 'already sent is left out by default');
assert.deepEqual(v.filtered, [['already sent this deal', 1]]);
const byHand = audienceView(rows, DEFAULT_FILTERS, { 4: true, 1: false, 6: true }, data.deal.price);
assert.deepEqual(byHand.audience.map((r) => r.b.id).sort(), [2, 3, 4, 6], 'ticks by hand win over the filters, both ways');
assert.equal(byHand.byHand, 3);
assert.deepEqual(byHand.filtered, [], 'a buyer set by hand is not counted as filtered');

// ---- the plan, summed
const settings: Settings = {
  intro: { mode: 'own', templateBody: "Hey {{first_name}} - it's {{rep_first_name}}. Got a deal in {{city}}.", split: 'never', emoji: 'never', instructions: '', tone: 'friendly', avoid: [] },
  variations: { useImage: false, imageUrl: '', reserveLevel: 0, frequency: 'frequently' },
  brief: { order: 'sms', wait: 1, waitUnit: 'hours', sms: true, smsBody: 'Deal: {{address}} at {{price}}', email: true, emailSubject: 'New deal: {{address}}', emailBody: 'Hi {{first_name}}', emailHtml: null },
  followups: { after: 1, afterUnit: 'hours', order: 'sms', wait: 23, waitUnit: 'hours', smart: false, sms: true, smsAi: false, smsList: ['Still there?'], email: true, emailAi: false, emailList: [{ subject: 'Following up', body: 'Hi again' }], pauseUnengaged: true, unengagedN: 3 },
  timezone: 'America/Chicago', startAt: '',
};
const now = new Date('2026-09-14T15:00:00Z'); // 10:00 Central, inside the window
const fields = { address: '1 Main St', city: 'Dallas', price: '$200,000', arv: '' };
const plan = buildPlan(v.audience, settings, fields, { repName: 'Morgan Lane', company: 'Acme Homes' }, data, {}, {}, now);
const s = planSummary(plan);
assert.equal(s.buyers, 2, 'the DNC buyer is skipped');
assert.deepEqual(s.skipped, [['do not contact', 1]]);
assert.equal(s.smsBuyers, 1, 'Pat has no phone');
assert.equal(s.emailBuyers, 2);
assert.equal(s.texts, 3, 'Chris: intro, brief, follow-up');
assert.equal(s.emails, 4, 'brief and follow-up, each');
assert.equal(s.messages, 7);
assert.equal(s.segments, 3);
assert.equal(s.followupBuyers, 2);
assert.equal(s.firstSend, now.getTime(), 'first send is now, inside the window');

// ---- words
assert.equal(tzLabel('America/Chicago'), 'Central');
assert.equal(tzLabel('America/Los_Angeles'), 'Pacific');
assert.equal(whenLabel(now.getTime(), 'America/Chicago', now), 'now');
assert.equal(whenLabel(Date.parse('2026-09-14T20:30:00Z'), 'America/Chicago', now), '3:30 PM');
assert.equal(whenLabel(Date.parse('2026-09-15T14:00:00Z'), 'America/Chicago', now), 'tomorrow 9:00 AM');
assert.equal(whenLabel(Date.parse('2026-09-17T14:00:00Z'), 'America/Chicago', now), 'Thu 9:00 AM');
assert.equal(channelWords(3, 2), 'by text and email');
assert.equal(channelWords(0, 2), 'by email');
assert.equal(launchSentence(s, 'America/Chicago', now), 'Send to 2 buyers by text and email, starting now');
const later = new Date('2026-09-14T03:00:00Z'); // 10 PM Central: the window is shut
const night = planSummary(buildPlan(v.audience, settings, fields, {}, data, {}, {}, later));
assert.equal(launchSentence(night, 'America/Chicago', later), 'Send to 2 buyers by text and email, starting tomorrow 9:00 AM Central');
const early = new Date('2026-09-14T08:00:00Z'); // 3 AM Central: today, at the window
assert.equal(launchSentence(planSummary(buildPlan(v.audience, settings, fields, {}, data, {}, {}, early)), 'America/Chicago', early), 'Send to 2 buyers by text and email, starting 9:00 AM Central');
assert.equal(launchSentence({ buyers: 0, smsBuyers: 0, emailBuyers: 0, firstSend: null }, 'America/Chicago', now), 'Nobody to send to');
assert.equal(cadenceLabel(settings), 'Text after 1 hour with no reply, then email 23 hours later');
assert.equal(cadenceLabel({ ...settings, followups: { ...settings.followups, sms: false } }), 'Email after 1 hour with no reply');
assert.equal(cadenceLabel({ ...settings, followups: { ...settings.followups, smsList: [''], email: false } }), 'No follow-ups', 'an empty template sends nothing');

// ---- merge fields
const known = { first_name: 'Chris', address: '1 Main St', arv: '', listing_url: 'x' };
assert.deepEqual(mergeCheck('Hi {{first_name}}, {{adress}} at {{arv}} {{listing_url}}', known, fields), { unknown: ['adress'], blank: ['arv'] });
assert.deepEqual(mergeCheck('Hi {first_name}', known, fields), { unknown: [], blank: [] }, 'single braces too');

// ---- results
const results: Pick<CampaignResults, 'recipients' | 'messages'> = {
  recipients: [
    { id: 1, campaign_id: 7, buyer_id: 1, replied_at: '2026-09-14T16:00:00Z', replied_channel: 'sms', status: 'interested' },
    { id: 2, campaign_id: 7, buyer_id: 2, replied_at: null, replied_channel: null, status: 'active' },
    { id: 3, campaign_id: 7, buyer_id: 3, replied_at: '2026-09-14T17:00:00Z', replied_channel: 'email', status: 'offered' },
    { id: 4, campaign_id: 8, buyer_id: 1, replied_at: '2026-09-15T17:00:00Z', replied_channel: 'sms', status: 'replied' },
  ] as CampaignResults['recipients'],
  messages: [
    { campaign_id: 7, recipient_id: 1, channel: 'sms', status: 'delivered' },
    { campaign_id: 7, recipient_id: 1, channel: 'email', status: 'sent' },
    { campaign_id: 7, recipient_id: 2, channel: 'sms', status: 'failed' },
    { campaign_id: 7, recipient_id: 3, channel: 'email', status: 'delivered' },
    { campaign_id: 8, recipient_id: 4, channel: 'sms', status: 'queued' },
  ] as CampaignResults['messages'],
};
assert.deepEqual(funnel(results, 1, 2), { sent: 2, delivered: 2, viewed: 2, replied: 3, offers: 1, interested: 2, optedOut: 0 });
assert.equal(funnel(results, 0, null, 7).replied, 2, 'one campaign');
assert.deepEqual(channelRows(results).map((r) => [r.ch, r.sent, r.delivered, r.replied, r.queued, r.failed]), [['sms', 1, 1, 2, 1, 1], ['email', 2, null, 1, 0, 0]]);
assert.deepEqual(repliedBuyers(results).map((r) => r.id), [4, 3], 'newest first, one row per buyer');

// ---- the demo agrees with the Overview tab (Sent 243, Delivered 236, Clicked 67, Replied 21, Offer 4)
const demo = demoMarketing((slug) => `https://x.test/listing/${slug}`, new Date('2026-09-23T15:00:00Z'));
const df = funnel(demo.results, demo.results.offers, demo.viewed);
assert.deepEqual([df.sent, df.delivered, df.viewed, df.replied, df.offers], [243, 236, 67, 21, 4], JSON.stringify(df));
assert.equal(demo.results.campaigns[0].status, 'running');
assert.ok(demo.results.messages.some((x) => x.status === 'queued' && Date.parse(x.send_at) > Date.parse('2026-09-23T15:00:00Z')), 'something is still to send');
const drows = demo.data.buyers.map((b) => buyerRow(b, demo.data));
const dv = audienceView(drows, DEFAULT_FILTERS, {}, demo.data.deal.price);
assert.equal(dv.audience.length, 64, 'the buyers matched since the last send');
assert.deepEqual(dv.filtered[0], ['already sent this deal', 243]);
assert.equal(dv.audience[0].b.name, 'Marisol Vega', 'the preview opens on the best buyer');
assert.equal(dv.audience[0].level, 5);
assert.ok(dv.audience.filter((r) => r.level === 5).length <= 3, 'Closers are few');
assert.ok(dv.audience[0].facts.lastPurchase?.distanceMi != null, 'a real distance for the purchase note');
assert.equal(demoFor('d6', '2207 Willow Street', (x) => x), demoMarketing((x) => x), 'Willow is the full demo');
assert.equal(demoFor('d9', '1520 Easton Avenue', (x) => x).results.campaigns.length, 0, 'other samples open on the composer');
assert.ok(Object.keys(demo.links).length === demo.data.buyers.length, 'a tracked link per buyer');
// Tone changes the words and keeps the facts.
const facts = { first: 'Marisol', rep: 'Morgan', note: "It's 0.6 miles from the flip you did at 394 Granger St.", city: 'Dallas', type: 'SFH' };
const tones = ['casual', 'professional', 'friendly', 'direct', 'urgent'].map((t) => demoIntro(t, facts));
assert.equal(new Set(tones).size, 5, 'every tone reads differently');
assert.ok(tones.every((t) => t.includes('394 Granger St') && t.includes('Marisol')));
assert.ok(!demoIntro('casual', { ...facts, first: '' }).includes('Hey  '), 'no name: no gap');

console.log('dispo-campaign: all assertions passed');
