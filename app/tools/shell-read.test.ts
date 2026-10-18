// npx tsx tools/shell-read.test.ts
// The first-paint reads (lib/crm.ts reuseShared, joinPages; lib/lead-refresh.ts
// chunkIds) and the settings memo (lib/integrations.ts loadSettings, saveSettings).
import assert from 'node:assert/strict';
import { joinPages, reuseShared } from '../lib/crm';
import { chunkIds } from '../lib/lead-refresh';
import type { Page } from '../lib/keyset';
import { loadSettings, saveSettings } from '../lib/integrations';
import { supabase } from '../lib/supabase';

async function main() {
  // Missing sellers: 450 ids go as 200, 200, 50, and come back as one answer.
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const chunks = chunkIds(ids);
  assert.deepEqual(chunks.map((c) => c.length), [200, 200, 50]);
  assert.deepEqual(chunks.flat(), ids);
  const joined = joinPages(chunks.map((c) => ({ data: c.map((id) => ({ id })), error: null })));
  assert.equal(joined.error, null);
  assert.deepEqual((joined.data as { id: number }[]).map((r) => r.id), ids);
  // One failed request fails the read, as the single request did.
  const boom = { message: 'boom' };
  assert.equal(joinPages([{ data: [{ id: 1 }], error: null }, { data: null, error: boom }]).error, boom);
  assert.deepEqual(joinPages([]), { data: [], error: null });

  // Shared reads: the full load takes the shell's answers, and reads again only when one failed.
  type Two = { commsQ: Page; notifsQ: Page };
  const good: Two = { commsQ: { data: [1], error: null }, notifsQ: { data: [], error: null } };
  let reads = 0;
  const again = async (): Promise<Two> => { reads += 1; return { commsQ: { data: [2], error: null }, notifsQ: { data: [], error: null } }; };
  assert.equal(await reuseShared(Promise.resolve(good), again), good);
  assert.equal(reads, 0);
  const failed: Two = { commsQ: { data: null, error: boom }, notifsQ: { data: [], error: null } };
  assert.deepEqual((await reuseShared(Promise.resolve(failed), again)).commsQ.data, [2]);
  assert.equal(reads, 1);
  assert.deepEqual((await reuseShared(Promise.reject(new Error('threw')), again)).commsQ.data, [2]);
  assert.equal(reads, 2);

  // Settings: one read per workspace while it is fresh, a fresh read for a save, nothing kept from a failure.
  assert.ok(supabase, 'the client exists');
  let selects = 0;
  let failNext = false;
  let stored: Record<string, unknown> = { talkr_url: 'https://t', company: { name: 'Acme Homes' } };
  (supabase as unknown as { from: unknown }).from = (table: string) => {
    assert.equal(table, 'workspaces');
    return {
      select: () => ({
        eq: (_col: string, ws: number) => ({
          maybeSingle: async () => {
            selects += 1;
            if (failNext) { failNext = false; return { data: null, error: boom }; }
            return { data: { settings: JSON.parse(JSON.stringify({ ...stored, ws })) }, error: null };
          },
        }),
      }),
      update: (v: { settings: Record<string, unknown> }) => ({ eq: async () => { stored = v.settings; return { error: null }; } }),
    };
  };

  const [a, b] = await Promise.all([loadSettings(1), loadSettings(1)]);
  assert.equal(selects, 1, 'boot callers share one read');
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'each caller gets its own copy');
  a.company!.name = 'changed';
  assert.equal((await loadSettings(1)).company?.name, 'Acme Homes', 'one caller editing its copy leaves the others alone');
  assert.equal(selects, 1);

  await loadSettings(2);
  assert.equal(selects, 2, 'another workspace reads its own');
  await loadSettings(1);
  assert.equal(selects, 3, 'switching back reads again: one workspace is kept');

  const saved = await saveSettings(1, { places_key: 'k' });
  assert.equal(saved.ok, true);
  assert.equal(selects, 4, 'a save merges onto a fresh read');
  assert.equal(stored.talkr_url, 'https://t');
  assert.equal(stored.places_key, 'k');
  assert.equal((await loadSettings(1)).places_key, 'k', 'the next load sees the save');
  assert.equal(selects, 5);

  await saveSettings(1, {});
  failNext = true;
  assert.deepEqual(await loadSettings(1), {}, 'a failed read answers empty, as before');
  assert.equal((await loadSettings(1)).places_key, 'k', 'and is not kept');
  console.log('shell-read ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
