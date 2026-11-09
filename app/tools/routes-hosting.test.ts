// Hosting for the operator app's paths (lib/routes.ts): vercel.json serves
// /app/... and /demo/... as their page, keeps them noindex and uncached, and
// sends the old dead links (/clozr, /docs?contract=N) somewhere real;
// next.config.ts serves the same paths in dev.
// Run: npx tsx tools/routes-hosting.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Rule = { source: string; destination: string; has?: { type: string; key: string; value?: string }[]; permanent?: boolean };
const hosting = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../vercel.json'), 'utf8')) as {
  rewrites: Rule[]; redirects: Rule[]; headers: { source: string; headers: { key: string; value: string }[] }[];
};
const SHELL_REWRITES = [
  { source: '/app/:path+', destination: '/app' },
  { source: '/demo/:path+', destination: '/demo' },
];
for (const want of SHELL_REWRITES) {
  assert.ok(hosting.rewrites.some((r) => r.source === want.source && r.destination === want.destination), `vercel.json rewrites ${want.source}`);
}
// Dev and `vinext start` serve the same paths: next.config.ts carries the same two rewrites.
const nextConfig = (await import('../next.config')).default as { rewrites?: () => Promise<{ source: string; destination: string }[]> };
assert.ok(nextConfig.rewrites, 'next.config.ts has rewrites');
const devRewrites = await nextConfig.rewrites!();
assert.deepEqual(
  devRewrites.map((r) => `${r.source} -> ${r.destination}`).sort(),
  hosting.rewrites.filter((r) => r.destination.startsWith('/')).map((r) => `${r.source} -> ${r.destination}`).sort(),
  'next.config.ts and vercel.json rewrite the same app paths',
);

// Every app and demo path is noindex and never cached; the sign-in pages too.
const headersFor = (path: string) => hosting.headers
  .filter((b) => new RegExp('^' + b.source + '$').test(path))
  .flatMap((b) => b.headers);
for (const path of ['/app', '/app/people/s42', '/app/deals/d7/tc', '/demo', '/demo/deals', '/login', '/login/reset', '/playground/jev-triage']) {
  const hs = headersFor(path);
  assert.ok(hs.some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)), `${path} is noindex`);
  assert.ok(hs.some((h) => h.key === 'Cache-Control' && h.value === 'no-store'), `${path} is no-store`);
  assert.ok(hs.some((h) => h.key === 'Content-Security-Policy'), `${path} has the CSP`);
}
assert.ok(!headersFor('/apple').some((h) => h.key === 'X-Robots-Tag'), 'a path that only starts like /app is not the app');
assert.ok(!headersFor('/').some((h) => h.value === 'no-store'), 'the marketing page stays cacheable');

// Old links that were dead: calendar events (/clozr/) and declined-contract emails (/docs/?contract=N).
const redirect = (source: string) => hosting.redirects.find((r) => r.source === source);
assert.equal(redirect('/clozr')?.destination, '/app/calendar', '/clozr goes to the calendar');
assert.equal(redirect('/clozr/:rest*')?.destination, '/app/calendar', '/clozr/... goes to the calendar');
const docs = redirect('/docs');
assert.equal(docs?.destination, '/app/contracts/k:id', '/docs?contract=N goes to the contract');
assert.deepEqual(docs?.has, [{ type: 'query', key: 'contract', value: '(?<id>\\d+)' }], '/docs matches a numeric contract query');
assert.ok(hosting.redirects.every((r) => r.permanent === false), 'redirects stay temporary, so a later change is not cached in browsers');

console.log('routes-hosting ok');
