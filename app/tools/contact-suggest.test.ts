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
  { business_name: 'Sample Title', email: 'dana@sampletitle.com' },
  { business_name: 'Ridge Title', email: 'pat@cptx-demo.com; closings@cptx-demo.com' },
  { business_name: 'Somebody', email: 'someone@gmail.com' },
  { business_name: '', email: 'x@nameless.com' },
]);
eq('title domains from vendors, split lists, no freemail, no nameless', Array.from(titles.entries()), [['sampletitle.com', 'Sample Title'], ['cptx-demo.com', 'Ridge Title']]);

const kind = (e: string, name: string | null, text: string) => {
  const c = classifyStranger(e, name, text, titles);
  return c ? [c.kind, c.company, c.known_company] : null;
};
eq('a new person at a title company we use is title under that company', kind('Evan@SampleTitle.com', 'Evan Moss', ''), ['title', 'Sample Title', true]);
eq('second address on a vendor row counts too', kind('closer@cptx-demo.com', null, ''), ['title', 'Ridge Title', true]);
eq('an unknown title shop by its domain', kind('jane@exampletitle.com', 'Jane', ''), ['title', null, false]);
eq('an escrow domain word', kind('amy@exampleescrow.com', 'Amy', ''), ['title', null, false]);
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
