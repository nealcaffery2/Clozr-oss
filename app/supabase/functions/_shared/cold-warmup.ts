/**
 * Warmup sync for the cold pool. Reads Instantly for every pool mailbox,
 * stores the reading on cold_mailboxes (warmup_score, warmup_checked_at,
 * warmup_sent_14d, warmup_spam_14d, warmup_started_at), promotes a warming
 * inbox that cleared the gate to active with its ramp restarted at day 1,
 * and auto-pauses one whose warmup mail is landing in Spam.
 *
 * It also heals what it can: warmup switched off on Instantly is switched
 * back on, and an inbox it auto-paused for Spam is unpaused once the rate
 * is back under the limit. The gate's day count is the workspace's
 * deliverability.warmup_gate_days.
 *
 * Runs once a day from cold_warmup_kick() (migration 245) through the
 * cold-campaign-tick, and on demand from cold-pool's sync_warmup. A vendor
 * failure is a string on the result, never a throw: the tick must finish.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { unseal } from './google.ts';
import { instantlyClient, type FetchLike, type InstantlyClient } from './instantly.ts';
import { coldDeliverability, warmupGate, warmupGateOn, warmupSpamPause, warmupSpamPct } from './cold-campaign.ts';

type Any = any;

export type WarmupReading = {
  email: string;
  /** True when Instantly is warming the inbox; null when Instantly does not list it. */
  warming: boolean | null;
  score: number | null;
  sent14: number;
  spam14: number;
  spam_pct: number | null;
  checked_at: string;
};

export type WarmupReadResult = { readings: Map<string, WarmupReading>; error: string | null; called: boolean };

/**
 * The plain Instantly key: the workspace's own sealed key, else the project's
 * INSTANTLY_API_KEY, so one Instantly account is set once for every workspace
 * instead of pasted into each one's settings. Null when neither is set.
 */
export async function warmupKey(admin: SupabaseClient, ws: number): Promise<string | null> {
  const { data } = await admin.from('cold_warmup_secrets').select('api_key').eq('workspace_id', ws).maybeSingle();
  const stored = String((data as Any)?.api_key ?? '').trim();
  let own: string | null = null;
  if (stored) { try { own = (await unseal(stored)).trim() || null; } catch { own = null; } }
  return own ?? ((Deno.env.get('INSTANTLY_API_KEY') ?? '').trim() || null);
}

/**
 * Live readings for `emails`, keyed by lowercased email. Never throws: a
 * vendor or key problem comes back as `error` with an empty map.
 */
export async function readWarmupReadings(client: InstantlyClient, emails: readonly string[], now: Date): Promise<WarmupReadResult> {
  const readings = new Map<string, WarmupReading>();
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (!wanted.length) return { readings, error: null, called: false };
  try {
    const accounts = new Map((await client.listAccounts()).map((a) => [a.email, a]));
    const analytics = await client.warmupAnalytics(wanted, now);
    for (const email of wanted) {
      const account = accounts.get(email) ?? null;
      const stats = analytics.get(email) ?? null;
      const score = stats?.score ?? account?.warmupScore ?? null;
      const sent14 = stats?.sent ?? 0;
      const spam14 = stats?.spam ?? 0;
      readings.set(email, {
        email, warming: account ? account.warming : null, score, sent14, spam14,
        spam_pct: warmupSpamPct(sent14, spam14), checked_at: now.toISOString(),
      });
    }
    return { readings, error: null, called: true };
  } catch (err) {
    return { readings, error: err instanceof Error ? err.message.slice(0, 200) : 'Instantly did not answer.', called: true };
  }
}

export type WarmupSync = {
  ok: boolean;
  provider: string;
  /** False when the workspace does not warm through Instantly or has no key. */
  called: boolean;
  checked: number;
  promoted: string[];
  paused: string[];
  unlisted: string[];
  /** Warmup was off on Instantly and was switched back on. */
  rewarmed: string[];
  /** Auto-paused for Spam earlier, back under the limit, unpaused. */
  resumed: string[];
  error: string | null;
};

/** The sync for one workspace. `deps.fetchFn` and `deps.now` are for tests. */
export async function syncWarmup(admin: SupabaseClient, ws: number, deps?: { fetchFn?: FetchLike; now?: Date; client?: InstantlyClient }): Promise<WarmupSync> {
  const now = deps?.now ?? new Date();
  const { data: settings } = await admin.from('cold_workspace_settings').select('warmup_provider, warmup_api_base, deliverability').eq('workspace_id', ws).maybeSingle();
  const provider = String((settings as Any)?.warmup_provider ?? 'stub');
  const minDays = coldDeliverability((settings as Any)?.deliverability).warmupGateDays;
  const base: WarmupSync = { ok: true, provider, called: false, checked: 0, promoted: [], paused: [], unlisted: [], rewarmed: [], resumed: [], error: null };
  if (!warmupGateOn(provider)) return { ...base, error: 'The warmup provider is not Instantly, so nothing was synced.' };
  const key = deps?.client ? null : await warmupKey(admin, ws);
  if (!deps?.client && !key) return { ...base, ok: false, error: 'No Instantly key is saved. Add it under Warmup.' };
  const { data: boxes } = await admin.from('cold_mailboxes')
    .select('id, email, status, paused, paused_auto, paused_reason, warmup_started_at, warmup_score')
    .eq('workspace_id', ws).order('id');
  const rows = (boxes ?? []) as Any[];
  if (!rows.length) return { ...base, called: false };
  const client = deps?.client ?? instantlyClient(key ?? '', { fetchFn: deps?.fetchFn, apiBase: null });
  const read = await readWarmupReadings(client, rows.map((r) => String(r.email)), now);
  if (read.error) {
    await admin.from('cold_workspace_settings').update({ warmup_synced_at: now.toISOString(), warmup_sync_error: read.error }).eq('workspace_id', ws);
    return { ...base, ok: false, called: true, error: read.error };
  }
  const out: WarmupSync = { ...base, called: true };
  for (const row of rows) {
    const email = String(row.email).toLowerCase();
    const r = read.readings.get(email);
    if (!r) continue;
    out.checked++;
    if (r.warming == null) out.unlisted.push(email);
    else if (!r.warming && !(row.paused && !row.paused_auto)) out.rewarmed.push(email);
    const startedAt: string | null = row.warmup_started_at ?? (r.warming ? now.toISOString() : null);
    const patch: Any = {
      warmup_score: r.score == null ? null : Math.round(r.score),
      warmup_checked_at: r.checked_at,
      warmup_sent_14d: r.sent14,
      warmup_spam_14d: r.spam14,
      warmup_started_at: startedAt,
    };
    const spamWhy = warmupSpamPause(r.sent14, r.spam14);
    if (spamWhy && !row.paused) {
      Object.assign(patch, { paused: true, paused_auto: true, paused_reason: `Auto-paused: ${spamWhy}.`, paused_at: now.toISOString() });
      out.paused.push(email);
    } else if (!spamWhy && row.paused && row.paused_auto && String(row.paused_reason ?? '').startsWith('Auto-paused: warmup mail landed in Spam')) {
      Object.assign(patch, { paused: false, paused_auto: false, paused_reason: null, paused_at: null });
      out.resumed.push(email);
    } else if (row.status === 'warming' && !row.paused && warmupGate({ startedAt, score: r.score, now, minDays }).ready) {
      Object.assign(patch, { status: 'active', ramp_started_on: now.toISOString().slice(0, 10) });
      out.promoted.push(email);
    }
    const { error } = await admin.from('cold_mailboxes').update(patch).eq('id', row.id).eq('workspace_id', ws);
    if (error) console.error('warmup sync', row.id, error.message);
  }
  if (out.rewarmed.length) {
    try { await client.enableWarmup(out.rewarmed); } catch (err) {
      out.error = `Warmup is off on ${out.rewarmed.length} inbox(es) and turning it back on failed: ${err instanceof Error ? err.message.slice(0, 160) : 'Instantly did not answer'}.`;
      out.rewarmed = [];
    }
  }
  await admin.from('cold_workspace_settings').update({ warmup_synced_at: now.toISOString(), warmup_sync_error: null }).eq('workspace_id', ws);
  return out;
}
