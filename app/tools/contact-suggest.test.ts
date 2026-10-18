// New contacts from the team's mail: who is an agent, who is title, who is nobody to suggest.
import { classifyStranger, namesOf, titleDomains } from '../supabase/functions/_shared/contact-suggest';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`ok   ${name}`);
}

const titles = titleDomains([
  { business_name: 'Title Source', email: 'closings@thetitlesource.com' },
  { business_name: 'Capital Title', email: 'escrow1@ctot.com; escrow2@ctot.com' },
  { business_name: 'Somebody', email: 'someone@gmail.com' },
  { business_name: '', email: 'x@nameless.com' },
]);
eq('title domains from vendors, split lists, no freemail, no nameless', Array.from(titles.entries()), [['thetitlesource.com', 'Title Source'], ['ctot.com', 'Capital Title']]);

const kind = (e: string, name: string | null, text: string) => {
  const c = classifyStranger(e, name, text, titles);
  return c ? [c.kind, c.company, c.known_company] : null;
};
eq('a new person at a title company we use is title under that company', kind('Evan@TheTitleSource.com', 'Evan Lipp', ''), ['title', 'Title Source', true]);
eq('second address on a vendor row counts too', kind('closer@ctot.com', null, ''), ['title', 'Capital Title', true]);
eq('an unknown title shop by its domain', kind('jane@alamotitle.com', 'Jane', ''), ['title', null, false]);
eq('an escrow domain word', kind('amy@lonestarescrow.com', 'Amy', ''), ['title', null, false]);
eq('a national underwriter subdomain', kind('officer@tx.stewart.com', null, ''), ['title', null, false]);
eq('a brokerage domain', kind('rick@kw.com', 'Rick', ''), ['agent', null, false]);
eq('a realty domain word', kind('sam@alamorealty.net', null, ''), ['agent', null, false]);
eq('a gmail agent by the words on the mail', kind('agentjoe@gmail.com', 'Joe', 'Re: 123 Main St - listing agent here, MLS shows'), ['agent', null, false]);
eq('a gmail escrow officer by the words', kind('sara@yahoo.com', 'Sara', 'Wire instructions and earnest money receipt'), ['title', null, false]);
eq('a gmail person with nothing to go on', kind('mom@gmail.com', 'Mom', 'dinner sunday'), null);
eq('no words given (unfiled mail): gmail person is skipped', kind('agentjoe@gmail.com', 'Joe', ''), null);
eq('no-reply is never suggested', kind('no-reply@kw.com', null, 'listing'), null);
eq('notifications is never suggested', kind('notifications@stewart.com', null, ''), null);
eq('a plain company with no signal', kind('bob@acme-plumbing.com', 'Bob', 'invoice attached'), null);

const names = namesOf('"Doe, Jane" <JANE@x.com>, Bob Smith <bob@y.com>, plain@z.com, "<odd>" <o@w.com>');
eq('display names: quoted last-first flipped, plain kept, bare address has none', Array.from(names.entries()), [['jane@x.com', 'Jane Doe'], ['bob@y.com', 'Bob Smith'], ['o@w.com', '<odd>']]);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
