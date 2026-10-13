// Run:  npx tsx tools/buyr-comments.test.ts
import { prospectsFromPaste } from '../lib/buyr-comments';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

const rows = prospectsFromPaste([
  'Jane Doe: send the deal to jane@buyer.com',
  'cash buyer mike@flip.co looking in SA',
  'deals@yourcompany.com',
  'Jane Doe: jane@buyer.com again',
].join('\n'));

eq('paste keeps the named buyer and the bare email', rows.map((r) => [r.name, r.email]), [
  ['Jane Doe', 'jane@buyer.com'],
  ['mike@flip.co', 'mike@flip.co'],
]);
eq('our deals@ address is skipped', rows.some((r) => r.email === 'deals@yourcompany.com'), false);
eq('the same email is filed once', rows.filter((r) => r.email === 'jane@buyer.com').length, 1);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
