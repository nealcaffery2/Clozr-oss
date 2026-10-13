// The merge fields a text is sent with.
//
// These run against the real renderer in lib/sms.ts, because the rule that
// matters is the one the send path uses: fill what we know, leave alone what
// we do not. A blanked {not_a_field} in a seller's text is worse than a
// visible one — the seller sees the gap either way, and the rep cannot tell
// what happened.
import { renderMerge } from '../lib/sms';

const fields = {
  first_name: 'Maria',
  name: 'Maria Lopez',
  address: '4100 Dale St',
  city: '',
  rep_name: 'Sam Carter',
};

const cases: [string, string, string][] = [
  ['plan builder braces', 'Hi {{first_name}}, about {{address}} —', 'Hi Maria, about 4100 Dale St —'],
  ['talkr template braces', 'Hi {first_name}, this is {rep_name}', 'Hi Maria, this is Sam Carter'],
  ['inner spaces', 'Hi {{ first_name }}!', 'Hi Maria!'],
  ['case insensitive', 'Hi {FIRST_NAME}', 'Hi Maria'],
  // A known-but-empty field renders empty and the gap it left is closed,
  // which is why the space before the full stop goes too.
  ['known but empty renders empty', 'City: {city}.', 'City:.'],
  ['unknown field is left alone', 'Unknown {nope} stays', 'Unknown {nope} stays'],
  ['prose in braces is not a field', 'Price is $100 {not a field}', 'Price is $100 {not a field}'],
  ['no fields at all', 'Still thinking about selling?', 'Still thinking about selling?'],
];

let failed = 0;
for (const [name, input, want] of cases) {
  const got = renderMerge(input, fields);
  if (got !== want) {
    failed++;
    console.log(`FAIL ${name}\n  in:   ${input}\n  got:  ${got}\n  want: ${want}`);
  }
}

// A field we know but have no value for leaves a hole. Closing it is only
// allowed where a substitution actually blanked something: text nobody
// substituted into must survive exactly as typed, spaces and all.
const gaps: [string, Record<string, string>, string][] = [
  ['blank field before punctuation', { address: '' }, 'Still selling {address}?'],
  ['blank field mid sentence', { address: '' }, 'About {address} — any thoughts?'],
  // A campaign's {{purchase_note}} on its own line, for a buyer with nothing on file.
  ['blank field alone on a line', { purchase_note: '' }, 'Headline\n{{purchase_note}}\n\nAddress: 1 Main'],
  ['blank field alone on an indented line', { purchase_note: '' }, 'Headline\n {{purchase_note}}\nAddress'],
  ['blank field between sentences', { purchase_note: '' }, 'Fits what you buy. {{purchase_note}} Want details?'],
  ['filled field keeps its line', { purchase_note: "It's 3 miles from 4 Pine." }, 'Headline\n{{purchase_note}}\n\nAddress'],
];
const wantGaps = ['Still selling?', 'About — any thoughts?', 'Headline\n\nAddress: 1 Main', 'Headline\nAddress', 'Fits what you buy. Want details?', "Headline\nIt's 3 miles from 4 Pine.\n\nAddress"];
gaps.forEach(([name, f, input], i) => {
  const got = renderMerge(input, f);
  if (got !== wantGaps[i]) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${got}\n  want: ${wantGaps[i]}`);
  }
});

// Untouched text keeps its own spacing, even the odd-looking kind.
const untouched = 'Really ?  Two spaces and a {nope} stay';
if (renderMerge(untouched, { first_name: 'Maria' }) !== untouched) {
  failed++;
  console.log('FAIL untouched text was reformatted');
}

console.log(failed ? `${failed} merge-field failures` : 'all merge-field checks passed (including gaps)');
if (failed) process.exit(1);
