// Run: npx tsx tools/activity-user-filter.test.ts
import { filterActivityByUser } from '../lib/activity-user-filter';

const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

const feed = [
  { id: 'n1', actor: 'Casey', isSms: false },
  { id: 'in1', actor: 'System', isSms: true, toRep: 'Casey' },
  { id: 'out1', actor: 'Casey', isSms: true },
  { id: 'in2', actor: 'System', isSms: true, toRep: 'Morgan' },
  { id: 'out2', actor: 'Morgan', isSms: true },
  { id: 'c1', actor: 'Morgan', isSms: false },
];

eq('Casey gets her text chain, not Morgan’s', filterActivityByUser(feed, 'Casey').map((r) => r.id), ['n1', 'in1', 'out1']);
eq('Morgan block', filterActivityByUser(feed, 'Morgan').map((r) => r.id), ['in2', 'out2', 'c1']);
eq('Any', filterActivityByUser(feed, 'Any').length, feed.length);

console.log('activity-user-filter ok');
