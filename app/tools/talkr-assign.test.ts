// Who may own a newly bought line.  Run:  npx tsx tools/talkr-assign.test.ts
import { assignmentBlock } from '../lib/talkr-assign';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got !== want) { console.log(`FAIL  ${name}\n      got  ${got}\n      want ${want}`); failed++; }
  else console.log(`PASS  ${name}`);
}

eq('an active seat can own a line', assignmentBlock('active'), 'ok');
eq('an invited seat is activated, not rejected', assignmentBlock('invited'), 'activate');
eq('a pending seat is activated too', assignmentBlock('pending'), 'activate');
eq('a disabled seat stays off', assignmentBlock('disabled'), 'disabled');
eq('nobody selected is not a person', assignmentBlock(null), 'missing');
eq('an empty status is not a person', assignmentBlock(''), 'missing');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
