// Phone and email checks for adding a buyer by hand.
// Run: npx tsx tools/buyer-contact.test.ts
import { buyerContactProblem, isValidEmail, isValidUsPhone } from '../lib/buyer-contact';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('plain email', isValidEmail('chris@collinshomes.com'), true);
eq('email with padding', isValidEmail('  chris@collinshomes.co  '), true);
eq('email without @', isValidEmail('chris.collinshomes.com'), false);
eq('email without dot domain', isValidEmail('chris@collinshomes'), false);
eq('email with space', isValidEmail('chris collins@collinshomes.com'), false);
eq('empty email', isValidEmail(''), false);

eq('ten digits', isValidUsPhone('2145550201'), true);
eq('formatted', isValidUsPhone('(214) 555-0201'), true);
eq('leading 1', isValidUsPhone('1-214-555-0201'), true);
eq('E.164', isValidUsPhone('+12145550201'), true);
eq('seven digits', isValidUsPhone('555-0201'), false);
eq('eleven digits not starting 1', isValidUsPhone('22145550201'), false);
eq('letters', isValidUsPhone('214-555-CALL'), false);

eq('new buyer, both fine', buyerContactProblem({ phone: '(214) 555-0201', email: 'a@b.co' }), null);
eq('new buyer, neither', buyerContactProblem({}), 'Add the buyer\'s phone number and email.');
eq('new buyer, no phone', buyerContactProblem({ email: 'a@b.co' }), 'Add the buyer\'s phone number.');
eq('new buyer, no email', buyerContactProblem({ phone: '2145550201', email: ' ' }), 'Add the buyer\'s email.');
eq('new buyer, bad phone', buyerContactProblem({ phone: '555', email: 'a@b.co' }), 'Phone needs 10 digits, like (214) 555-0201.');
eq('new buyer, bad email', buyerContactProblem({ phone: '2145550201', email: 'a@b' }), 'Email needs to look like name@company.com.');
eq('existing buyer, phone only', buyerContactProblem({ phone: '2145550201' }, false), null);
eq('existing buyer, email only', buyerContactProblem({ email: 'a@b.co' }, false), null);
eq('existing buyer, neither', buyerContactProblem({}, false), 'Add a phone number or an email.');
eq('existing buyer, bad email still caught', buyerContactProblem({ email: 'a@b' }, false), 'Email needs to look like name@company.com.');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
