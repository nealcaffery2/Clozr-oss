// The outbound opt-out line.  Run:  deno run supabase/functions/_shared/sms-compliance.test.ts
import { hasOptOut, segments, withOptOut } from './sms-compliance.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

eq('a first touch gains the line',
  withOptOut('Hi Mark, it is Morgan with Acme Homes about a deal in Converse.'),
  'Hi Mark, it is Morgan with Acme Homes about a deal in Converse. Reply STOP to opt out.');

// Idempotent, because a retry must not stack the line twice.
eq('a body that already says STOP is left alone',
  withOptOut('Deal in Converse. Reply STOP to opt out.'),
  'Deal in Converse. Reply STOP to opt out.');
eq('appending twice changes nothing',
  withOptOut(withOptOut('Deal in Converse.')),
  'Deal in Converse. Reply STOP to opt out.');
eq('a rep who worded it their own way keeps their wording',
  withOptOut('Deal in Converse. Text STOP any time and I will stop.'),
  'Deal in Converse. Text STOP any time and I will stop.');
eq('an unsubscribe instruction also counts',
  withOptOut('Deal in Converse. Reply unsubscribe to stop these.'),
  'Deal in Converse. Reply unsubscribe to stop these.');

// "stopped by" is prose, not an opt-out instruction, and the message would go
// out with no way to opt out if we matched it.
eq('STOP inside another word does not count',
  hasOptOut('I stopped by the property this morning.'), false);
eq('STOP as a word counts whatever its case', hasOptOut('reply stop to opt out'), true);

eq('trailing whitespace is trimmed before appending',
  withOptOut('Deal in Converse.   '), 'Deal in Converse. Reply STOP to opt out.');
eq('an empty body stays empty rather than becoming a bare opt-out', withOptOut('   '), '');

// Segment counts, for the log line that explains why one text cost two.
eq('a short GSM message is one segment', segments('Hi Mark'), 1);
eq('160 GSM characters is still one segment', segments('a'.repeat(160)), 1);
eq('161 GSM characters is two', segments('a'.repeat(161)), 2);
eq('an emoji forces UCS-2, so 70 characters is the limit', segments(`${'a'.repeat(69)}🙂`), 1);
eq('71 UCS-2 characters is two segments', segments(`${'a'.repeat(70)}🙂`), 2);
eq('an empty body is no segments', segments(''), 0);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
