// The Dispo Genius mapping rules.  Run:  deno run supabase/functions/_shared/dispogenius-map.test.ts
import { arvOf, clampScore, dealPatch, matchBuyer, matchStatus, phoneKey, splitAddress } from './dispogenius-map.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

// ---- addresses ----
eq('address splits on the trailing STATE ZIP',
  splitAddress('123 Main St, Austin, TX 78701'),
  { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' });
eq('a comma in the street stays in line1',
  splitAddress('123 Main St, Apt 4B, Austin, TX 78701'),
  { line1: '123 Main St, Apt 4B', city: 'Austin', state: 'TX', zip: '78701' });
eq('ZIP+4 keeps the five-digit zip',
  splitAddress('9 Oak Ln, Dallas, TX 75211-1234'),
  { line1: '9 Oak Ln', city: 'Dallas', state: 'TX', zip: '75211' });
eq('lowercase state is normalised',
  splitAddress('9 Oak Ln, Dallas, tx 75211')?.state, 'TX');
// The rule that matters: never invent a city or state from a shape we do not
// recognise, because a wrong address_key merges two different properties.
eq('an unrecognisable tail stays whole in line1',
  splitAddress('Lot 7 County Road 12'),
  { line1: 'Lot 7 County Road 12', city: '', state: '', zip: '' });
eq('a two-part address is not split',
  splitAddress('123 Main St, Austin'),
  { line1: '123 Main St, Austin', city: '', state: '', zip: '' });
eq('blank is null', splitAddress('   '), null);

// ---- ARV ----
eq('a range averages', arvOf({ is_arv_range: true, low_end_arv: 325000, high_end_arv: 350000 }), 337500);
eq('a half-open range takes the end it has', arvOf({ is_arv_range: true, low_end_arv: 325000, high_end_arv: null }), 325000);
eq('a single value is used as is', arvOf({ is_arv_range: false, arv_price: 310000 }), 310000);
eq('no ARV is null', arvOf({ is_arv_range: false, arv_price: null }), null);

// ---- status, which is CHECK-constrained in Postgres ----
const LEGAL = ['matched', 'sent', 'viewed', 'interested', 'not_interested', 'offered', 'under_contract', 'closed'];
eq('Interested maps through', matchStatus('Interested'), 'interested');
eq('Offer Received is an offer', matchStatus('Offer Received'), 'offered');
eq('Offer Accepted is under contract', matchStatus('Offer Accepted'), 'under_contract');
eq('an unknown status falls back rather than breaking the insert', matchStatus('Rocket Surgery'), 'matched');
eq('null falls back', matchStatus(null), 'matched');
eq('every mapping is a legal column value',
  ['Interested', 'Offer Received', 'Offer Accepted', 'Pending', 'Closed', 'anything else', null]
    .every((v) => LEGAL.includes(matchStatus(v))), true);

// ---- score, CHECK (score between 0 and 100) ----
eq('a normal score is kept', clampScore(67), 67);
eq('over 100 is clamped', clampScore(180), 100);
eq('negative is clamped', clampScore(-5), 0);
eq('missing is zero', clampScore(null), 0);
eq('a fraction rounds', clampScore(66.6), 67);

// ---- buyer matching: phone first, then email ----
const byPhone = new Map([['5551234567', 11]]);
const byEmail = new Map([['a@b.com', 22]]);
const buyer = (p: string | null, e: string | null) => ({ full_name: 'X', phone: p, email: e, type: null, is_active: true });
eq('phone wins over email', matchBuyer(buyer('(555) 123-4567', 'a@b.com'), byPhone, byEmail), { id: 11, by: 'phone' });
eq('email is the fallback', matchBuyer(buyer(null, 'A@B.com'), byPhone, byEmail), { id: 22, by: 'email' });
eq('no match is null', matchBuyer(buyer('5559999999', 'z@z.com'), byPhone, byEmail), null);
eq('formatting does not defeat the phone key', phoneKey('+1 (555) 123-4567'), '5551234567');
eq('a too-short number is not a key', phoneKey('123'), null);

// ---- deal patch: only what Dispo Genius knows ----
eq('blank and null fields are left out, so an import never blanks a CLOZR value',
  dealPatch({ asking_price: 255000, arv_price: null, is_arv_range: false, assignment_fee: null, notes: '' }),
  { asking_price: 255000 });

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) throw new Error(`${failed} failed`);
