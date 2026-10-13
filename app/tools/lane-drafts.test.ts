// Lane drafts must come back on the stub path Casey hits in /demo.
// Run with:  npx tsx tools/lane-drafts.test.ts
import { D } from '../lib/clozr-types';
import { askLane, laneContext } from '../lib/lane';

const tx = D.transactions[0];
if (!tx) throw new Error('sample graph has no transaction');
const ctx = laneContext(tx, {
  address: '2207 Willow Street, Dallas, TX',
  seller: 'Patricia Hale',
  buyer: 'Harbor Capital',
  state: 'TX',
});

let failed = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};

const emd = await askLane({ question: 'The buyer EMD is late. Draft what I send.', context: ctx, history: [] });
check(emd.stubbed, 'demo path is stubbed');
check(emd.drafts.length >= 1, 'EMD chase returns a draft');
check(emd.drafts.some((d) => d.channel === 'sms' || d.channel === 'email'), 'EMD draft is sendable');

const post = await askLane({ question: 'Write the Podio/Discord status post for this file in the day-marker format.', context: ctx, history: [] });
check(post.drafts.some((d) => d.channel === 'post' && d.body.includes('Willow')), 'status post draft names the file');

if (failed) {
  console.log(failed + ' failed');
  process.exit(1);
}
console.log('ok');
