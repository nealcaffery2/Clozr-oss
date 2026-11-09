// One row in ai_usage per Claude call: feature, model, tokens, cost. Never
// throws; a logging failure must not fail the feature that made the call.
import { MODEL_PRICES } from './models.ts';

/** The `usage` block of an Anthropic Messages response (SDK or raw JSON). */
export type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | null | undefined;

export type UsageRow = {
  workspace_id: number | null; feature: string; model: string;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  cost_cents: number;
};

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Cost in cents, 4 decimals; 0 for a model not in MODEL_PRICES. */
export function usageCostCents(model: string, u: AnthropicUsage): number {
  const card = MODEL_PRICES[model];
  if (!card || !u) return 0;
  const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  const p = card.long && prompt > card.long.over ? card.long : card;
  const usd = (n(u.input_tokens) * p.input + n(u.output_tokens) * p.output
    + n(u.cache_read_input_tokens) * p.cacheRead + n(u.cache_creation_input_tokens) * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 100 * 10_000) / 10_000;
}

export function usageRow(opts: { ws?: number | null; feature: string; model: string; usage: AnthropicUsage }): UsageRow {
  const u = opts.usage ?? {};
  return {
    workspace_id: Number.isFinite(opts.ws) ? Number(opts.ws) : null,
    feature: opts.feature, model: opts.model,
    input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens),
    cache_read_tokens: n(u.cache_read_input_tokens), cache_write_tokens: n(u.cache_creation_input_tokens),
    cost_cents: usageCostCents(opts.model, u),
  };
}

// deno-lint-ignore no-explicit-any
type Admin = { from: (t: string) => any };

// The function's env, read through globalThis: records-agent.ts (and the
// tools/*.test.ts that import it) type-check under the app's tsconfig, where
// there is no Deno global.
const env = (k: string) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);

let envAdmin: Admin | null | undefined;
/** A service-role client from the function's env, for helpers that have none in scope. */
async function adminFromEnv(): Promise<Admin | null> {
  if (envAdmin !== undefined) return envAdmin;
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  // Loaded here, not at the top: a test or a helper that passes its own admin never pulls the client in.
  const { createClient } = await import('jsr:@supabase/supabase-js@2');
  const client: Admin | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  envAdmin = client;
  return client;
}

/**
 * Insert one ai_usage row. `admin` is a service-role client; null means
 * one from the env. Pass the response's `model` and `usage`; `ws` null for
 * calls outside a workspace.
 */
export async function recordUsage(admin: Admin | null | undefined, opts: { ws?: number | null; feature: string; model: string; usage: AnthropicUsage }): Promise<void> {
  try {
    if (!opts.usage) return;
    const db = admin ?? await adminFromEnv();
    if (!db) return;
    const { error } = await db.from('ai_usage').insert(usageRow(opts));
    if (error) console.error('ai_usage insert', error.message);
  } catch (e) {
    console.error('ai_usage', String(e));
  }
}
