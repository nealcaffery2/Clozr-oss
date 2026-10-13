// The email a rep gets when an AI agent hands them someone.  Run:  deno run supabase/functions/_shared/rep-alert.test.ts
import { recordLink, repAlertEmail } from './rep-alert.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}
const ok = (name: string, cond: boolean) => eq(name, cond, true);

eq('a buyer link opens the buyer screen', recordLink('https://clozr.app/', 'buyer', 45), 'https://clozr.app/app#screen=buyer&id=b45');
eq('a seller link opens the person screen', recordLink('https://clozr.app', 'seller', 12), 'https://clozr.app/app#screen=person&id=s12');

const m = repAlertEmail({ subject: 'Call Ann now', lines: ['Ann is ready.', 'They said: "<yes> & send it"'], name: 'Ann', phone: '(512) 555-0199', link: 'https://clozr.app/app#screen=buyer&id=b45' });
ok('a tap-to-call button with the dialable number', m.html.includes('href="tel:5125550199"'));
ok('a button that opens the record', m.html.includes('href="https://clozr.app/app#screen=buyer&amp;id=b45"'));
ok('what they said is escaped, not markup', m.html.includes('&lt;yes&gt; &amp; send it') && !m.html.includes('<yes>'));
eq('the plain text says the same', m.text, 'Ann is ready.\nThey said: "<yes> & send it"\nCall: 5125550199\nOpen in CLOZR: https://clozr.app/app#screen=buyer&id=b45');
ok('no number: no call button', !repAlertEmail({ subject: 's', lines: ['x'], name: 'Ann', phone: null, link: 'l' }).html.includes('tel:'));

if (failed) { console.log(`\n${failed} failed`); (globalThis as { Deno?: { exit(n: number): void } }).Deno?.exit(1); }
else console.log('\nall passed');
