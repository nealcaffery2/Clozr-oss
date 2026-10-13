// Lane's chats: the address search and which chat an exchange is filed in
// (supabase/functions/_shared/lane-chat.ts).
import { addressPatterns, chatTitle, ilikeSafe, routeFor, sameSubject } from '../supabase/functions/_shared/lane-chat';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); } else console.log(`PASS  ${name}`);
};

eq('as typed first, then number + street word', addressPatterns('123 Main Street, San Antonio TX'), ['%123%main%street%', '%123%main%']);
eq('direction and suffix dropped', addressPatterns('4410 N. Elm Dr'), ['%4410%n.%elm%dr%', '%4410%elm%']);
eq('one pattern when nothing to drop', addressPatterns('123 Main'), ['%123%main%']);
eq('a name is searched as typed', addressPatterns('Maria Lopez'), ['%maria%lopez%']);
eq('filter syntax is stripped', ilikeSafe('12 Oak (rear), *x*'), '12 Oak rear x');
eq('empty gives nothing', addressPatterns('  ,  '), []);

const A = { seller_id: 1, deal_id: 10, address: '12 Oak St' };
const B = { seller_id: 2, deal_id: 20, address: '9 Elm Dr' };
eq('same seller is the same property', sameSubject(A, { seller_id: 1, deal_id: null, address: null }), true);
eq('different sellers differ', sameSubject(A, B), false);
eq('deal decides when there is no seller', sameSubject({ seller_id: null, deal_id: 20, address: null }, B), true);

eq('nothing named: keep', routeFor({ subject: A, messages: 4 }, null), 'keep');
eq('same property: keep', routeFor({ subject: A, messages: 4 }, { ...A }), 'keep');
eq('unfiled chat: pin', routeFor({ subject: null, messages: 4 }, B), 'pin');
eq('empty chat opened on a record: re-pin', routeFor({ subject: A, messages: 0 }, B), 'pin');
eq('another property with history: move', routeFor({ subject: A, messages: 2 }, B), 'move');

eq('titled by address', chatTitle(A, 'whatever'), '12 Oak St');
eq('titled by the question until then', chatTitle(null, 'What is closing this week?'), 'What is closing this week?');
eq('long questions are cut', chatTitle(null, 'x'.repeat(80)).length, 60);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
