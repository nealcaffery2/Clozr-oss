/**
 * Reoon ahead of the send (deliverability `verify_sweep`, pg_cron every five
 * minutes, migration 379).
 *
 * Send-time verification (mailguard verifyAtSend) checks an address the
 * moment a send reaches it, one batch at a time; 10,800 of Compr's buyers had
 * never been checked, so a drip or a campaign spent its first minutes on
 * Reoon and parked whatever failed only once it was due. The sweep checks
 * them before that: buyers on an active plan first, then the most recently
 * active, SWEEP_BATCH addresses a run, in every workspace whose buyer list is
 * Compr's (settings.buyer_profile = 'compr') or that turned it on
 * (settings.reoon_sweep = true).
 *
 * An address already in email_verifications is copied onto the row, not
 * paid for again. A Reoon task still running when the run ends is kept in
 * cold_workspace_settings.reoon_sweep_task and read first next time. An address
 * Reoon returns nothing for is written `unknown` (parked), so it is not
 * picked again every run.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { everyRow } from './every-row.ts';
import { MISSING_KEY_ERROR, VERIFY_PROVIDER, normalizeEmail, readBulk, startBulk, writeVerification, type ReoonDeps, type VerifyResult } from './reoon.ts';

type Any = any;

export const SWEEP_BATCH = 200;
/** Reads of a fresh task inside one run: about 20 seconds. */
const SWEEP_POLLS = 10;

type Pending = { task_id: number | string; emails: string[]; started_at: string };
export type SweepOutcome = { workspace_id: number; checked: number; from_cache: number; pending: boolean; left: number | null; error?: string };

async function store(admin: SupabaseClient, ws: number, results: VerifyResult[]): Promise<string | null> {
  if (!results.length) return null;
  const at = new Date().toISOString();
  const { error } = await admin.from('email_verifications').upsert(
    results.map((r) => ({ workspace_id: ws, email: r.email, status: r.status, safe: r.safe, provider: r.provider, verified_at: at })),
    { onConflict: 'workspace_id,email' },
  );
  if (error) return `email_verifications: ${error.message}`;
  const rows = await writeVerification(admin, ws, results);
  return rows.ok ? null : rows.error;
}

/** Its own column, so a settings save elsewhere is never overwritten by this one. */
async function setPending(admin: SupabaseClient, ws: number, pending: Pending | null) {
  await admin.from('cold_workspace_settings').upsert({ workspace_id: ws, reoon_sweep_task: pending }, { onConflict: 'workspace_id' });
}

/** Finished results, with every address Reoon left out written `unknown`. */
function withMissing(results: VerifyResult[], missing: string[]): VerifyResult[] {
  return [...results, ...missing.map((email): VerifyResult => ({ email, status: 'unknown', safe: false, provider: VERIFY_PROVIDER }))];
}

/** Unchecked buyer addresses: on an active plan first, then the most recently active. */
async function nextAddresses(admin: SupabaseClient, ws: number, limit: number): Promise<{ emails: string[]; badIds: number[] }> {
  const picked = new Map<string, number>();
  const badIds: number[] = [];
  const take = (rows: { id: number; email: string | null }[]) => {
    for (const r of rows) {
      if (picked.size >= limit) return;
      const e = normalizeEmail(r.email);
      if (!e) badIds.push(r.id);
      else if (!picked.has(e)) picked.set(e, r.id);
    }
  };
  const enr = await everyRow<{ buyer_id: number }>(() => admin.from('enrollments').select('buyer_id').eq('workspace_id', ws).eq('status', 'active').not('buyer_id', 'is', null).order('id')).catch(() => [] as { buyer_id: number }[]);
  const onPlan = [...new Set(enr.map((r) => r.buyer_id))];
  for (let i = 0; i < onPlan.length && picked.size < limit; i += 300) {
    const { data } = await admin.from('buyers').select('id, email').eq('workspace_id', ws).is('archived_at', null).is('email_verified_at', null)
      .not('email', 'is', null).neq('email', '').in('id', onPlan.slice(i, i + 300));
    take((data ?? []) as { id: number; email: string | null }[]);
  }
  if (picked.size < limit) {
    const { data } = await admin.from('buyers').select('id, email').eq('workspace_id', ws).is('archived_at', null).is('email_verified_at', null)
      .not('email', 'is', null).neq('email', '').order('last_activity_at', { ascending: false, nullsFirst: false }).limit(limit * 2);
    take((data ?? []) as { id: number; email: string | null }[]);
  }
  return { emails: [...picked.keys()], badIds };
}

async function sweepOne(admin: SupabaseClient, ws: number, key: string, deps: ReoonDeps): Promise<SweepOutcome> {
  const out: SweepOutcome = { workspace_id: ws, checked: 0, from_cache: 0, pending: false, left: null };
  // A task the last run left running comes first.
  const { data: cws } = await admin.from('cold_workspace_settings').select('reoon_sweep_task').eq('workspace_id', ws).maybeSingle();
  const held = (cws?.reoon_sweep_task ?? undefined) as Pending | undefined;
  if (held?.task_id != null) {
    const r = await readBulk(held.task_id, held.emails ?? [], key, { ...deps, polls: 1 });
    if (!r.ok && r.pending) {
      // A day is long enough; after that the task is dropped and its addresses come up again.
      if (Date.now() - Date.parse(held.started_at) < 86_400_000) { out.pending = true; return out; }
    } else if (r.ok) {
      const err = await store(admin, ws, withMissing(r.results, r.missing));
      if (err) { out.error = err; return out; }
      out.checked += r.results.length + r.missing.length;
    } else {
      out.error = r.error;
    }
    await setPending(admin, ws, null);
    return out;
  }

  const { emails, badIds } = await nextAddresses(admin, ws, SWEEP_BATCH);
  if (badIds.length) {
    await admin.from('buyers').update({ email_status: 'invalid_syntax', email_safe_to_send: false, email_verified_at: new Date().toISOString(), email_verify_provider: 'syntax' })
      .eq('workspace_id', ws).in('id', badIds);
  }
  if (!emails.length) { out.left = 0; return out; }

  // Already verified elsewhere in this workspace (a send-time check): copy it, do not pay again.
  const { data: cached } = await admin.from('email_verifications').select('email, status, safe, provider').eq('workspace_id', ws).in('email', emails);
  const known = ((cached ?? []) as Any[]).filter((c) => c.provider === VERIFY_PROVIDER)
    .map((c) => ({ email: String(c.email), status: String(c.status), safe: c.safe === true, provider: VERIFY_PROVIDER }) as VerifyResult);
  if (known.length) {
    const rows = await writeVerification(admin, ws, known);
    if (!rows.ok) { out.error = rows.error; return out; }
    out.from_cache = known.length;
  }
  const fresh = emails.filter((e) => !known.some((k) => k.email === e));
  if (!fresh.length) return out;

  const started = await startBulk(fresh, key, deps.fetch ?? fetch);
  if (!started.ok) { out.error = started.error; return out; }
  const r = await readBulk(started.task_id, fresh, key, { ...deps, polls: deps.polls ?? SWEEP_POLLS });
  if (!r.ok && r.pending) {
    await setPending(admin, ws, { task_id: started.task_id, emails: fresh, started_at: new Date().toISOString() });
    out.pending = true;
    return out;
  }
  if (!r.ok) { out.error = r.error; return out; }
  const err = await store(admin, ws, withMissing(r.results, r.missing));
  if (err) { out.error = err; return out; }
  out.checked = r.results.length + r.missing.length;
  return out;
}

export async function reoonSweep(admin: SupabaseClient, deps: ReoonDeps = {}): Promise<{ ok: boolean; error?: string; workspaces: SweepOutcome[] }> {
  const env = deps.env ?? Deno.env;
  const key = (env.get('REOON_API_KEY') ?? '').trim();
  if (!key) return { ok: false, error: MISSING_KEY_ERROR, workspaces: [] };
  const { data, error } = await admin.from('workspaces').select('id, settings');
  if (error) return { ok: false, error: error.message, workspaces: [] };
  const on = ((data ?? []) as { id: number; settings: Record<string, unknown> | null }[]).filter((w) => {
    const s = w.settings ?? {};
    return s.reoon_sweep !== false && (s.buyer_profile === 'compr' || s.reoon_sweep === true);
  });
  const workspaces: SweepOutcome[] = [];
  for (const w of on) {
    try {
      const r = await sweepOne(admin, Number(w.id), key, deps);
      if (!r.pending && !r.error && r.left === null) {
        const { count } = await admin.from('buyers').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id).is('archived_at', null)
          .is('email_verified_at', null).not('email', 'is', null).neq('email', '');
        r.left = count ?? null;
      }
      workspaces.push(r);
    } catch (err) {
      workspaces.push({ workspace_id: Number(w.id), checked: 0, from_cache: 0, pending: false, left: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: workspaces.every((w) => !w.error), workspaces };
}
