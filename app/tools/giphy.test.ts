// GIPHY URL allowlist and the picker's list. Run: npx tsx tools/giphy.test.ts
import assert from 'node:assert/strict';
import { GIF_SEND_MAX_BYTES, cleanGif, gifsFrom } from '../supabase/functions/_shared/giphy';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  try { assert.deepEqual(got, want); console.log('ok  ', name); } catch { failed++; console.log('FAIL', name, '\n  got ', got, '\n  want', want); }
};

const A = 'https://media2.giphy.com/media/abc123/200.gif';
eq('giphy url passes', cleanGif(A), A);
eq('query string is stripped', cleanGif(`${A}?cid=xyz&rid=200.gif`), A);
eq('bare media host passes', cleanGif('https://media.giphy.com/media/x/200.gif'), 'https://media.giphy.com/media/x/200.gif');
eq('http is refused', cleanGif(A.replace('https', 'http')), null);
eq('another host is refused', cleanGif('https://evil.com/media/abc/200.gif'), null);
eq('look-alike host is refused', cleanGif('https://media.giphy.com.evil.com/x.gif'), null);
eq('userinfo trick is refused', cleanGif('https://media.giphy.com@evil.com/x.gif'), null);
eq('path traversal chars are refused', cleanGif('https://media.giphy.com/x/<script>.gif'), null);
eq('non-string is refused', cleanGif(42), null);

const big = 'https://media1.giphy.com/media/b/200.gif';
const small = 'https://media1.giphy.com/media/b/100.gif';
const item = (size: number) => ({ id: 'b', title: 'yes', images: { fixed_height: { url: `${big}?cid=1`, size: String(size) }, fixed_height_small: { url: `${small}?cid=1` } } });
eq('light gif sends full size', gifsFrom([item(500_000)]), [{ id: 'b', title: 'yes', url: big, preview: small }]);
eq('heavy gif sends the small one', gifsFrom([item(GIF_SEND_MAX_BYTES + 1)])[0]?.url, small);
eq('off-cdn items are dropped', gifsFrom([{ id: 'x', images: { fixed_height: { url: 'https://evil.com/a.gif', size: '1' } } }]), []);
eq('garbage data is an empty list', gifsFrom({ nope: 1 }), []);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
