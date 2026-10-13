// Sign-in popups hand the session back through window.opener; COOP
// same-origin would sever them.
// Run: npx tsx tools/csp-headers.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vercel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

const all = vercel.headers.find((b) => b.source === '/(.*)');
assert.ok(all, 'site-wide header block');
const header = (key: string) => all!.headers.find((h) => h.key === key)?.value;

assert.equal(
  header('Cross-Origin-Opener-Policy'),
  'same-origin-allow-popups',
  'sign-in popups must keep window.opener',
);

const csp = header('Content-Security-Policy') ?? '';
assert.match(csp, /frame-ancestors 'none'/, 'Clozr itself stays unframeable');
assert.doesNotMatch(csp, /frame-src [^;]*https:\/\/accounts\.google\.com/, 'Google sign-in stays a popup, not a framed redirect');

console.log('csp-headers ok');
