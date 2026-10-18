// Which replies the bell calls good. Run: npx tsx tools/reply-tone.test.ts
import { isImportant, replyTone } from '../lib/reply-tone';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Real Compr replies from 2026-10-14.
eq('yes sounds good', replyTone('Yes sounds good'), 'good');
eq('a do-not-contact', replyTone('I didn’t sign up again, don’t text or call again thanks .'), 'bad');
eq('a phone’s canned reply', replyTone("Sorry, I can't talk right now."), 'auto');
eq('in meeting', replyTone('In meeting'), 'auto');
eq('a competitor’s missed-call bot', replyTone('Hi this is SC Real Estate LLC, I saw that we just missed your call how can I help?\nReply STOP to unsubscribe.'), 'auto');
eq('a calendar accept', replyTone('Accepted: Compr - 15 Min Live Demo ( Kamil ) @ Mon Oct 19'), 'good');
eq('stop', replyTone('STOP'), 'bad');
eq('not interested', replyTone('Not interested, thanks'), 'bad');
eq('wrong number', replyTone('wrong number'), 'bad');
eq('who is this', replyTone('who is this'), 'bad');
eq('a question about price', replyTone('How much does it cost?'), 'good');
eq('send info', replyTone('Send info'), 'good');
eq('can I call you later', replyTone('Can I call you later?'), null);
eq('a reaction', replyTone('Liked “Alex is currently out of office until 8AM CST”'), 'auto');
eq('empty', replyTone(''), null);

eq('a good text is important', isImportant({ cat: 'inbound_sms', tone: 'good' }), true);
eq('a bad text is not', isImportant({ cat: 'inbound_sms', tone: 'bad' }), false);
eq('a plain text is not', isImportant({ cat: 'SMS', tone: null }), false);
eq('a good email reply is', isImportant({ cat: 'Email reply', tone: 'good' }), true);
eq('a mention is', isImportant({ cat: 'Mention' }), true);
eq('a missed call is', isImportant({ cat: 'Call' }), true);
eq('number health is not', isImportant({ cat: 'Number health' }), false);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
