// Sign-in popups hand the session back through window.opener; COOP
// same-origin would sever them.
// Run: npx tsx tools/csp-headers.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBED_SOURCES } from '../lib/embed-hosts';

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

// The custom report Embed element: every host it accepts (lib/embed-hosts)
// must be framable under both CSP headers, the site-wide one and /sign's.
const sign = vercel.headers.find((b) => b.source === '/sign(.*)');
assert.ok(sign, '/sign header block');
const signCsp = sign!.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
const frameSrc = (policy: string) => (policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src ')) ?? '').split(/\s+/).slice(1);
for (const [label, policy] of [['site-wide', csp], ['/sign', signCsp]] as const) {
  const sources = frameSrc(policy);
  for (const src of EMBED_SOURCES) assert.ok(sources.includes(src), `${label} frame-src allows the report embed host ${src}`);
  for (const src of ["'self'", 'https://*.hcaptcha.com', 'https://docs.google.com', 'https://underwriting.example.com']) {
    assert.ok(sources.includes(src), `${label} frame-src keeps ${src}`);
  }
}
for (const src of ['https://lookerstudio.google.com', 'https://*.notion.site', 'https://airtable.com', 'https://app.hex.tech', 'https://*.metabaseapp.com', 'https://public.tableau.com']) {
  assert.ok((EMBED_SOURCES as readonly string[]).includes(src), `report embeds accept ${src}`);
}

console.log('csp-headers ok');
