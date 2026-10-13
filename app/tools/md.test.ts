// The assistants' markdown (lib/md.ts): blocks, inline marks, unsafe links, half-streamed marks.
// Run: npx tsx tools/md.test.ts
import { parseInline, parseMarkdown, safeHref } from '../lib/md';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};
const T = (v: string) => ({ t: 'text', v });

eq('bold, italics, code', parseInline('**Seller side** has *two* `plans`'), [
  { t: 'strong', c: [T('Seller side')] }, T(' has '), { t: 'em', c: [T('two')] }, T(' '), { t: 'code', v: 'plans' },
]);
eq('half-streamed bold stays literal', parseInline('**Seller si'), [T('**Seller si')]);
eq('a lone asterisk stays literal', parseInline('5 * 3 = 15'), [T('5 * 3 = 15')]);
eq('snake_case is not italics', parseInline('use plan_agent_runs here'), [T('use plan_agent_runs here')]);
eq('safe link', parseInline('[Compr](https://thecompr.com/r/1)'), [{ t: 'link', href: 'https://thecompr.com/r/1', c: [T('Compr')] }]);
eq('javascript: link is just its text', parseInline('[click](javascript:alert(1))'), [T('click'), T(')')]);
eq('raw html stays text', parseInline('<img src=x onerror=alert(1)>'), [T('<img src=x onerror=alert(1)>')]);
eq('safeHref', [safeHref('https://a.b'), safeHref('mailto:x@y.z'), safeHref('data:text/html,x'), safeHref(' JavaScript:x')], ['https://a.b', 'mailto:x@y.z', null, null]);

eq('the owner\'s example: heading-ish bold line and a bullet list', parseMarkdown(
  'You have 3 plans.\n\n**Seller side**\n- **New submission needs an offer** (4 steps)\n- Cold lead (7 steps)\n\n1. First\n2. Second'), [
  { t: 'p', c: [T('You have 3 plans.')] },
  { t: 'p', c: [{ t: 'strong', c: [T('Seller side')] }] },
  { t: 'ul', items: [[{ t: 'strong', c: [T('New submission needs an offer')] }, T(' (4 steps)')], [T('Cold lead (7 steps)')]] },
  { t: 'ol', start: 1, items: [[T('First')], [T('Second')]] },
]);
eq('headings', parseMarkdown('## Today\nCall Kara'), [{ t: 'h', level: 2, c: [T('Today')] }, { t: 'p', c: [T('Call Kara')] }]);
eq('lines in a paragraph keep their breaks', parseMarkdown('one\ntwo'), [{ t: 'p', c: [T('one\ntwo')] }]);
eq('a dash mid-stream with no text yet is a paragraph', parseMarkdown('Plans:\n-'), [{ t: 'p', c: [T('Plans:\n-')] }]);
eq('empty', parseMarkdown(''), []);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
