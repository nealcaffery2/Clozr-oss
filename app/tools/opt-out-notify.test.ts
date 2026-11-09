// Opt-out replies ring no bell: migration 405's is_opt_out_reply (its three
// regexes run here as JS) and classifyReply, which cold-campaign-tick skips
// the cold_reply notification on.
// Run: npx tsx tools/opt-out-notify.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyReply } from '../supabase/functions/_shared/cold-campaign';

const sql = readFileSync(new URL('../supabase/migrations/405_opt_outs_dont_notify.sql', import.meta.url), 'utf8');
// Postgres ARE to JS: \m \M are word edges, (?n) makes ^ and $ match per line, '' is a quote.
const [footer, line, phrase] = [...sql.matchAll(/~\* '((?:[^']|'')+)'/g)].map(([, re]) => {
  const multiline = re.startsWith('(?n)');
  return new RegExp(re.replace('(?n)', '').replace(/\\[mM]/g, '\\b').replace(/''/g, "'"), multiline ? 'im' : 'i');
});
const isOptOut = (body: string) => !footer.test(body) && (line.test(body) || phrase.test(body));

for (const body of [
  'STOP', 'Stop.', 'STOP 🛑 ', 'Stop\n(sent with Echo)', 'Please stop. ', 'Permanently stop', 'QUIT', 'Remove', 'Unsubscribe ',
  'Please take me off your list', 'Retired, please stop texting me!', 'Wrong #.  This is not Alfred.  Remove me. ',
  'I didn’t sign up again, don’t text or call again thanks .', 'Never opted in to begin with. Spam reported',
  'Re: 3479 Marigold Ln · STOP',
]) assert.ok(isOptOut(body), body);

for (const body of [
  'yes', 'Sure', 'Stop by tomorrow?', "I'll stop bothering you", 'no thanks', 'Is there an option to change closing attorney?',
  'Hi this is SC Real Estate LLC, I saw that we just missed your call how can I help?\nReply STOP to unsubscribe.',
  '[Example Electric]: You are now opted-in to receive SMS messages. For help, reply HELP. To opt-out, reply STOP.',
  'Re: Option period ends TODAY · Sam, can we end the option early?',
]) assert.ok(!isOptOut(body), body);

const reply = (body: string) => classifyReply({ from: 'pat@buyer.test', subject: 'Re: Hello', body });
assert.equal(reply('Please remove me from this list'), 'unsubscribe');
assert.equal(reply('This is spam'), 'unsubscribe');
assert.equal(reply('Yes, send me the numbers'), 'interested');

console.log('opt-out-notify: ok');
