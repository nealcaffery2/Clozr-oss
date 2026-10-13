// Notification dismiss rules. Run: npx tsx tools/notif-dismiss.test.ts
import { dismissDelay, forRep, mergeDismissed, notificationDbIds, visibleNotifs } from '../lib/notif-dismiss';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const items = [
  { id: 'n12', cat: 'Offer', unread: true },
  { id: 'n4', cat: 'Seller', unread: false },
  { id: 'bell-call-c1', cat: 'Call', unread: true },
  { id: 'bell-sms-c2', cat: 'SMS', unread: true },
  { id: 'n9', cat: 'TC', unread: true },
];

eq('db ids skip bell rows', notificationDbIds(['n12', 'bell-call-c1', 'bell-sms-c2', 'n9', 'nope']), [12, 9]);
eq('merge keeps earlier dismissals', mergeDismissed({ n1: true }, ['n12']), { n1: true, n12: true });
eq('empty merge is the same map', mergeDismissed({ n1: true }, []), { n1: true });
eq('first row leaves immediately', dismissDelay(0), 0);
eq('later rows wait', dismissDelay(3), 138);
eq('a long pile does not wait forever', dismissDelay(40), 14 * 46);

eq('only unread, and not ones already dismissed', visibleNotifs(items, { 'bell-call-c1': true }, 'All', {}).map((n) => n.id), ['n12', 'bell-sms-c2', 'n9']);
eq('category filter', visibleNotifs(items, {}, 'SMS', {}).map((n) => n.id), ['bell-sms-c2']);
eq('muted category stays out', visibleNotifs(items, {}, 'All', { Call: true }).map((n) => n.id), ['n12', 'bell-sms-c2', 'n9']);

// A rep's bell: theirs, their records, and the floor; not a teammate's seller or buyer.
const bell = [
  { id: 'a', direct: true, link: { screen: 'person', id: 's2' } },
  { id: 'b', link: { screen: 'person', id: 's1' } },
  { id: 'c', link: { screen: 'person', id: 's2' } },
  { id: 'd', link: { screen: 'buyer', id: 'b1' } },
  { id: 'e', link: { screen: 'buyer', id: 'b2' } },
  { id: 'f', link: { screen: 'leaderboard', id: '' } },
  { id: 'g', link: { screen: 'dispoProperty', id: 's9' } },
  { id: 'h', link: { screen: 'person', id: 's3' } },
];
const sellers = new Map<string, string | null>([['s1', 'u1'], ['s2', 'u2'], ['s3', null]]);
const buyers = new Map<string, string | null>([['b1', 'u1'], ['b2', 'u2']]);
eq('forRep: addressed, my seller, my buyer; not a teammate\'s, the floor or a dispo deal', forRep(bell, 'u1', sellers, buyers).map((n) => n.id), ['a', 'b', 'd']);
// A text or call is whose conversation it is, whoever the record belongs to; owners and admins included.
const msgs = [
  { id: 'm1', owner: 'u1', link: { screen: 'person', id: 's2' } },
  { id: 'm2', owner: 'u2', link: { screen: 'person', id: 's1' } },
  { id: 'm3', owner: null, link: { screen: 'person', id: 's1' } },
  { id: 'm4', owner: null, link: { screen: 'person', id: 's3' } },
];
eq('forRep: my line, not my teammate\'s line on my seller; no rep falls back to the assigned rep', forRep(msgs, 'u1', sellers, buyers).map((n) => n.id), ['m1', 'm3']);
eq('forRep: nobody\'s and unassigned goes to the workspace owner only', forRep(msgs, 'boss', sellers, buyers, true).map((n) => n.id), ['m4']);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
