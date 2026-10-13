// Marketplace access tokens.  Run:  deno run --allow-env supabase/functions/listing/access.test.ts
// The function module starts its server on import, so serve is stubbed first.
(Deno as unknown as { serve: () => unknown }).serve = () => ({});
Deno.env.set('LISTING_SECRET', 'test-secret');
const { accessToken, readAccessToken, listingToken, readListingToken } = await import('./index.ts');

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const t = await accessToken(11, 4242);
const claim = await readAccessToken(t);
eq('round trip workspace', claim?.w, 11);
eq('round trip buyer', claim?.b, 4242);
eq('expires in about 180 days', Math.round(((claim?.e ?? 0) * 1000 - Date.now()) / 86_400_000), 180);

const [body, sig] = t.split('.');
const forged = btoa(JSON.stringify({ w: 11, b: 1, e: claim?.e })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
eq('edited buyer is refused', await readAccessToken(`${forged}.${sig}`), null);
eq('bad signature is refused', await readAccessToken(`${body}.${sig.slice(0, -2)}xx`), null);
eq('junk is refused', await readAccessToken('nope'), null);
eq('non-string is refused', await readAccessToken(42), null);

const link = await listingToken({ w: 11, d: 3690, b: 4242 });
eq('campaign link token is not marketplace access', await readAccessToken(link), null);
eq('marketplace access is not a campaign link token', await readListingToken(t), null);

const expiredBody = btoa(JSON.stringify({ w: 11, b: 4242, e: Math.floor(Date.now() / 1000) - 10 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
eq('expired access is refused', await readAccessToken(`${expiredBody}.${sig}`), null);

if (failed) {
  console.log(`${failed} failed`);
  Deno.exit(1);
}
console.log('listing access ok');
