// Read receipts: the pixel, the link rewriting, the path parser.  Run:  deno run supabase/functions/_shared/email-track.test.ts
import { countsAsOpen, instrument, isToken, newToken, parsePath } from './email-track.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const base = 'https://p.supabase.co/functions/v1/email-track';
const tok = 'a'.repeat(48);

eq('token: 48 hex', isToken(newToken()), true);
eq('token: two differ', newToken() === newToken(), false);

const html = '<p>See <a href="https://ex.com/a?x=1&amp;y=2">this</a> and <a class="b" href=\'http://ex.com/b\'>that</a>, '
  + '<a href="mailto:me@ex.com">mail me</a>, <a href="https://p.supabase.co/functions/v1/deliverability/unsubscribe?t=z">unsubscribe</a></p>';
const out = instrument(html, tok, base);
eq('links: http(s) only, unsubscribe left alone, &amp; decoded', out.links, ['https://ex.com/a?x=1&y=2', 'http://ex.com/b']);
eq('links: rewritten in place', out.html.includes(`href="${base}/c/${tok}/0"`) && out.html.includes(`href='${base}/c/${tok}/1'`), true);
eq('links: mailto kept', out.html.includes('href="mailto:me@ex.com"'), true);
eq('links: unsubscribe kept', out.html.includes('deliverability/unsubscribe?t=z'), true);
eq('pixel: appended once', out.html.split(`${base}/o/${tok}.gif`).length - 1, 1);
eq('pixel: inside </body> when there is one', instrument('<html><body>x</body></html>', tok, base).html.endsWith('/></body></html>'), true);

eq('path: open', parsePath(`/email-track/o/${tok}.gif`), { kind: 'open', token: tok });
eq('path: open under /functions/v1', parsePath(`/functions/v1/email-track/o/${tok}.gif`), { kind: 'open', token: tok });
eq('path: click', parsePath(`/email-track/c/${tok}/3`), { kind: 'click', token: tok, idx: 3 });
eq('path: click without an index', parsePath(`/email-track/c/${tok}`), null);
eq('path: short token', parsePath('/email-track/o/abc.gif'), null);
eq('path: something else', parsePath('/email-track/x'), null);

const sent = new Date('2026-01-01T00:00:00Z');
eq('open: the first seconds do not count', countsAsOpen(sent, new Date('2026-01-01T00:00:03Z')), false);
eq('open: later does', countsAsOpen(sent, new Date('2026-01-01T00:01:00Z')), true);

if (failed) { console.log(`${failed} failed`); Deno.exit(1); }
console.log('email-track: all passed');
