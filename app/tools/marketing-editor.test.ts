// The campaign builder's message editor and Genius import, the pure parts:
// the sections a message splits into, the guard on an AI edit, the carrier
// review before a push (texts and emails), the suggested wording applied to a
// designed email's words only, the email photo's centred 3:2 crop, and the
// counts a Genius pull shows before it is added.
// Run: npx tsx tools/marketing-editor.test.ts
import assert from 'node:assert/strict';
import { fixHtmlWords, fixWords, mergeTokens, messageSections, reviewMessage, reviseProblem, sectionLabel } from '../lib/message-revise';
import { coverCrop, emailablePhoto, heroPath } from '../lib/email-photo';
import { importCounts } from '../lib/genius-import';
import type { Candidate } from '../lib/genius';
import { htmlToText } from '../lib/email-text';
import { SAMPLE_EMAIL_HTML, SAMPLE_EMAIL_SUBJECT, SAMPLE_EMAIL_TEXT } from '../components/dispo-campaign/sample-email';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('merge fields are listed once each, in order', () => {
  assert.deepEqual(mergeTokens('Hi {{first_name}}, {{ address }} at {{price}}. {{first_name}}'), ['first_name', 'address', 'price']);
});

test('an AI edit needs words, a message, and a section still in it', () => {
  assert.equal(reviseProblem({ instruction: ' ', text: 'x' }), 'Say what you want to change first.');
  assert.equal(reviseProblem({ instruction: 'shorter', text: '' }), 'There is no message to change.');
  assert.match(reviseProblem({ instruction: 'shorter', text: 'Hi there.', section: 'Gone.' }) ?? '', /no longer in the message/);
  assert.equal(reviseProblem({ instruction: 'shorter', text: 'Hi there.', section: 'Hi there.' }), null);
  assert.equal(reviseProblem({ instruction: 'shorter', text: '', html: '<p>Hi</p>' }), null);
});

test('a message splits into its lines, and a long line into sentences', () => {
  const sms = 'Hi {{first_name}}, new deal: {{address}} at {{price}}.\nPhotos: {{deal_link}}\nReply YES for details.';
  assert.deepEqual(messageSections(sms), ['Hi {{first_name}}, new deal: {{address}} at {{price}}.', 'Photos: {{deal_link}}', 'Reply YES for details.']);
  const long = 'We just got {{address}} under contract at {{price}} and it needs light work. The numbers are on the page. Reply if you want a walkthrough this week.';
  assert.equal(messageSections(long).length, 3);
  assert.deepEqual(messageSections('One line only.'), []);
  assert.deepEqual(messageSections('{{address}}\nHi {{first_name}}, it is open.\nReply YES.'), ['Hi {{first_name}}, it is open.', 'Reply YES.']);
  assert.equal(sectionLabel('a'.repeat(60)).length, 42);
});

test('a text with trigger words gets the carrier review and a suggested version', () => {
  const r = reviewMessage('Deal brief by text', 'brief-sms', 'sms', 'Hi {{first_name}}, CASH OFFER on {{address}}!! Act now.');
  assert.ok(r);
  assert.equal(r!.target, 'brief-sms');
  assert.ok(r!.suggestion && !/cash offer/i.test(r!.suggestion) && !r!.suggestion.includes('!!'));
  assert.ok(r!.suggestion!.includes('{{first_name}}') && r!.suggestion!.includes('{{address}}'));
  assert.equal(reviewMessage('x', 'brief-sms', 'sms', 'Hi {{first_name}}, new deal at {{address}}. Reply YES for details.'), null);
});

test('an email is not marked down for carrying several links, but a text is', () => {
  const two = 'Photos https://deals.example.com/a and comps https://deals.example.com/b';
  assert.equal(reviewMessage('Email', 'brief-email', 'email', two), null);
  assert.ok(reviewMessage('Text', 'brief-sms', 'sms', two));
});

test('a link shortener blocks with no suggestion to apply', () => {
  const r = reviewMessage('Text', 'brief-sms', 'sms', 'See it: https://bit.ly/abc');
  assert.ok(r?.check.blocked);
});

test('the suggested wording lands in a designed email without touching a tag', () => {
  const r = reviewMessage('Email', 'brief-email', 'email', 'New deal\nGUARANTEED returns, cash offer welcome')!;
  const html = '<td style="FONT-WEIGHT:BOLD"><a href="https://x.example/GUARANTEED">GUARANTEED returns</a>, cash offer welcome</td>';
  const out = fixHtmlWords(html, r.check.findings);
  assert.ok(out.includes('style="FONT-WEIGHT:BOLD"') && out.includes('href="https://x.example/GUARANTEED"'));
  assert.ok(!/>GUARANTEED returns/.test(out) && !/cash offer/.test(out));
  assert.equal(fixWords('Subject: GUARANTEED returns', r.check.findings), 'Subject: Firm returns');
});

test('the email photo is cropped to 3:2 around its centre', () => {
  assert.deepEqual(coverCrop(4000, 2000), { sx: 500, sy: 0, sw: 3000, sh: 2000 });
  assert.deepEqual(coverCrop(1200, 1600), { sx: 0, sy: 400, sw: 1200, sh: 800 });
  assert.deepEqual(coverCrop(1200, 800), { sx: 0, sy: 0, sw: 1200, sh: 800 });
  assert.deepEqual(coverCrop(0, 10), { sx: 0, sy: 0, sw: 0, sh: 0 });
  assert.equal(heroPath(7, 5156, 1), 'ws/7/deals/5156/email/hero-1.jpg');
});

test('only a public https photo can go in an email', () => {
  assert.ok(emailablePhoto('https://x.supabase.co/storage/v1/object/public/deal-public/ws/1/a.jpg'));
  assert.ok(!emailablePhoto('https://x.supabase.co/storage/v1/object/sign/deal-files/a.jpg?token=1'));
  assert.ok(!emailablePhoto('http://example.com/a.jpg'));
  assert.ok(!emailablePhoto(null));
});

test('a Genius pull counts who is on file, reachable, untraced and empty', () => {
  const base = { key: '', matched_buyer_id: null, contacts: null, contacts_at: null } as unknown as Candidate;
  const c = (o: Partial<Candidate>) => ({ ...base, ...o }) as Candidate;
  const hit = (phone: string | null, email: string | null) => [{ name: 'A', phones: phone ? [{ number: phone, type: 'mobile', dnc: false, score: 90 }] : [], emails: email ? [email] : [], mailing: null }];
  const counts = importCounts([
    c({ key: 'a', matched_buyer_id: 3, contacts: hit('2105550188', null) as never }),
    c({ key: 'b', contacts: hit(null, 'b@example.com') as never }),
    c({ key: 'c' }),
    c({ key: 'd', contacts: [] as never }),
  ]);
  assert.deepEqual(counts, { total: 4, onFile: 1, reachable: 2, untraced: 1, noContact: 1 });
});

test('the sample deal blast passes as written: capital headings and its "not guaranteed" disclosure are left alone', () => {
  assert.equal(reviewMessage('Email', 'brief-email', 'email', `${SAMPLE_EMAIL_SUBJECT}\n${htmlToText(SAMPLE_EMAIL_HTML)}`), null);
  assert.equal(reviewMessage('Email', 'brief-email', 'email', `${SAMPLE_EMAIL_SUBJECT}\n${SAMPLE_EMAIL_TEXT}`), null);
});

test('a swap never touches the negated copy of the same word', () => {
  const r = reviewMessage('Email', 'brief-email', 'email', 'Returns guaranteed. Figures are not guaranteed.')!;
  assert.equal(fixWords('Returns guaranteed. Figures are not guaranteed.', r.check.findings), 'Returns firm. Figures are not guaranteed.');
});

console.log(`marketing-editor: ${passed} passed`);
