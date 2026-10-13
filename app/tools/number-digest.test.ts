// Number-guard digest: notify on a new topic, not on new wording. Run: npx tsx tools/number-digest.test.ts
import { digestTopic, newDigestTopics } from '../supabase/functions/_shared/number-digest';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// The live workspace's digests on Sep 30 and Oct 1: the same list, reworded.
const sep30 = [
  'The 10DLC campaign was rejected: campaign: Your account must have at least $6.00 to perform this operation. A rejected campaign cannot be edited — correct the facts and file again (Settings → Phone numbers → 10DLC).',
  'Caller name (CNAM): 2 of 3 lines list an outbound caller name. Carriers show it on landlines and some mobiles; changes take days to propagate.',
  '10DLC campaign: No campaign yet. It describes what you text (use case, sample messages, opt-in) and takes days to weeks to approve. https://portal.telnyx.com/',
  'Lines on the campaign: 0 of 3 texting lines are assigned to an approved campaign. https://portal.telnyx.com/',
  'San Antonio (+12105550163) is not on a 10DLC campaign — its texts are filtered and refused by the gate.',
  'Acme Homes main (+12105550161) is not on a 10DLC campaign — its texts are filtered and refused by the gate.',
  'Sam · Telnyx (+13465550164) is not on a 10DLC campaign — its texts are filtered and refused by the gate.',
  "Enterprise: Field 'job_title' is not allowed in this request.",
];
const oct1 = [
  '10DLC is waiting on your Telnyx balance, not on the carriers: Telnyx needs at least $6.00 on the account to pay the 10DLC registry fee.',
  'Caller name (CNAM): 1 of 3 lines list an outbound caller name. Carriers show it on landlines and some mobiles; changes take days to propagate.',
  ...sep30.slice(2, 7),
];

eq('every 10DLC standing line is one topic', [sep30[0], oct1[0], 'No 10DLC brand is registered — texts are filtered', '10DLC brand is filed but no campaign is approved yet (none submitted).'].map(digestTopic), ['10dlc', '10dlc', '10dlc', '10dlc']);
eq('a line is keyed by its number and what is wrong', digestTopic(sep30[4]), '+12105550163:campaign');
eq('spam on a line', digestTopic('San Antonio (+12105550163): high spam risk (telemarketing).'), '+12105550163:spam');
eq('checklist counts do not change the topic', digestTopic(sep30[1]), digestTopic(oct1[1]));
eq('reworded and shorter list is not news', newDigestTopics(oct1, sep30, sep30.join('\n')), []);
eq('a new line is news', newDigestTopics([...oct1, 'Westside (+12105550100) is not on a 10DLC campaign — its texts are filtered.'], sep30, null), ['+12105550100:campaign']);
eq('first digest ever is news', newDigestTopics(oct1, undefined, null).length > 0, true);
eq('an old run without its list compares text', newDigestTopics(oct1, undefined, oct1.join('\n')), []);
eq('nothing open, nothing to post', newDigestTopics([], sep30, null), []);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
