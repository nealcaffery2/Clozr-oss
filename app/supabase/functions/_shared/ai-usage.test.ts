import { assertEquals } from 'jsr:@std/assert';
import { recordUsage, usageCostCents, usageRow } from './ai-usage.ts';

Deno.test('cost: sonnet 1M in + 1M out + cache', () => {
  assertEquals(usageCostCents('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 1200);
  assertEquals(usageCostCents('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }), 270);
  assertEquals(usageCostCents('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 }), 1.4);
});

Deno.test('cost: haiku 5.5 bills a prompt over 100K at the long rate', () => {
  assertEquals(usageCostCents('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 10_000 }), 1.5);
  assertEquals(usageCostCents('claude-haiku-5-5', { input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 10_000 }), 5.75);
});

Deno.test('cost: unknown model or no usage is 0', () => {
  assertEquals(usageCostCents('gpt-9', { input_tokens: 1000 }), 0);
  assertEquals(usageCostCents('claude-sonnet-5-5', null), 0);
});

Deno.test('row: nulls and NaN become 0, ws null outside a workspace', () => {
  const r = usageRow({ feature: 'x', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: null, cache_read_input_tokens: NaN } });
  assertEquals(r, { workspace_id: null, feature: 'x', model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_cents: 0.002 });
});

Deno.test('recordUsage never throws', async () => {
  await recordUsage({ from: () => { throw new Error('db down'); } }, { ws: 1, feature: 'x', model: 'm', usage: { input_tokens: 1 } });
  await recordUsage({ from: () => ({ insert: () => Promise.resolve({ error: { message: 'nope' } }) }) }, { ws: 1, feature: 'x', model: 'm', usage: { input_tokens: 1 } });
  await recordUsage(null, { feature: 'x', model: 'm', usage: null });
});
