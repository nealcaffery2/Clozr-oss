// Custom report Embed URLs: which hosts the report can frame and what the
// editor says about the rest. Run: npx tsx tools/embed-hosts.test.ts
import assert from 'node:assert/strict';
import { EMBED_SERVICES, checkEmbedUrl, embedProblem } from '../lib/embed-hosts';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

const ok = (url: string) => assert.equal(checkEmbedUrl(url).ok, true, `${url} embeds`);
const refused = (url: string, reason: string) => {
  const c = checkEmbedUrl(url);
  assert.equal(c.ok, false, `${url} is refused`);
  if (!c.ok) assert.equal(c.reason, reason, `${url} is refused as ${reason}`);
};

ok('https://lookerstudio.google.com/embed/reporting/abc/page/1');
ok('https://datastudio.google.com/reporting/abc');
ok('https://docs.google.com/spreadsheets/d/e/abc/pubhtml?widget=true');
ok('https://acme.notion.site/Pipeline-123');
ok('https://airtable.com/embed/shrABC');
ok('https://web.airtable.com/embed/shrABC');
ok('https://app.hex.tech/acme/app/123/latest');
ok('https://acme.metabaseapp.com/public/dashboard/123');
ok('https://public.tableau.com/views/Sales/Overview');
ok('  https://LookerStudio.Google.com/embed/x  ');

refused('', 'empty');
refused('   ', 'empty');
refused('lookerstudio.google.com/embed/x', 'invalid');
refused('javascript:alert(1)', 'invalid');
refused('http://lookerstudio.google.com/embed/x', 'insecure');
refused('https://www.youtube.com/embed/abc', 'host');
refused('https://notion.site/x', 'host');
refused('https://evil-notion.site/x', 'host');
refused('https://lookerstudio.google.com.evil.com/x', 'host');
refused('https://lookerstudio.google.com:8443/x', 'host');
refused('https://sheets.google.com/x', 'host');

assert.equal(embedProblem(checkEmbedUrl('')), null, 'an empty field shows the hint, not an error');
assert.equal(embedProblem(checkEmbedUrl('https://airtable.com/embed/x')), null);
const host = embedProblem(checkEmbedUrl('https://www.youtube.com/embed/abc'));
assert.ok(host?.includes('www.youtube.com'), 'the refusal names the host');
assert.ok(host?.includes('Looker Studio'), 'the refusal says which services work');

for (const text of [EMBED_SERVICES, ...['nope', 'http://airtable.com/x', 'https://www.youtube.com/embed/abc'].map((u) => embedProblem(checkEmbedUrl(u)) ?? '')]) {
  assert.deepEqual(slopFindings(text), [], `plain copy: ${text}`);
}

console.log('embed-hosts ok');
