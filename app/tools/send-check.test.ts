// The pre-send check in the plan editor. Run: npx tsx tools/send-check.test.ts
import { checkMessage, plainPunctuation, smsSegments } from '../lib/send-check';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('a short plain text is green', checkMessage('Hi {{first_name}}, want me to run a deal for you this week?', 'sms').green, true);
eq('160 plain characters is one text', smsSegments('a'.repeat(160)), { unicode: false, segments: 1 });
eq('161 plain characters is two', smsSegments('a'.repeat(161)).segments, 2);
eq('a curly apostrophe makes it Unicode', smsSegments('I’m here').unicode, true);
eq('plain punctuation swaps curly quotes', plainPunctuation('I’m “here”'), 'I\'m "here"');

// Alex's blast as written: bold, curly quotes, two links, 673 characters.
const alex = `Hi {{first_name}}\n\nMy name is Alex, and I’m the Sales Manager at Compr.\n\nWe help real estate investors, wholesalers, agents, and other real estate professionals find comps, estimate rehab costs, and put together a defendable offer in typically 60 seconds or less.\n\n**Want to see what the results look like?** Check out a sample report here:\n\nhttps://underwriting.example.com/demo\n\nI’d love to show you how it works with a quick 15-minute walkthrough and run a free analysis on a property you’re currently working on.\n\nWould you be open to connecting sometime this week?\n\nYou can grab a time that works best for you here:\nhttps://cal.com/alex-nxi9u2/30min\n\nBest,\nAlex\nSales Manager | Compr`;
const c = checkMessage(alex, 'sms');
eq('the blast is not green', c.green, false);
eq('it is red for length', c.issues.some((i) => i.level === 'red' && /texts long/.test(i.what)), true);
eq('it names the bold', c.issues.some((i) => /bold/.test(i.what)), true);
eq('it names the two links', c.issues.some((i) => /2 links/.test(i.what)), true);
eq('Fix it drops the bold and curly quotes', /\*\*|’/.test(c.fixed), false);
eq('an email with bold is flagged, not a carrier issue', checkMessage('**Hi** there', 'email').issues.map((i) => i.level), ['amber']);

if (failed) { console.error(`send-check: ${failed} failed`); process.exit(1); }
console.log('send-check: ok');
