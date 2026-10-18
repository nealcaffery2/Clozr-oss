// A Genius pull into a dispo campaign: the owners one saved run found for a
// house, skip-traced where they are not yet (owners traced before come back
// free from the cache), added to the buyer list or matched to the buyer
// already on file, and handed back as buyer ids for the campaign's audience.
// The same steps as Genius › Add to buyers (components/GeniusMode addMany),
// without the map around them.

import { type Candidate, type Run, addCandidate, applyTraceToBuyer, hasSkipTraceContact, saveCandidates, skipTrace } from './genius';
import { logRun } from './data-runs';
import { deliverability } from './deliverability';

export type ImportCounts = {
  total: number;
  /** Already a buyer on file. */
  onFile: number;
  /** Traced, with a phone or email to reach. */
  reachable: number;
  /** Never traced: each costs a skip trace unless the cache has them. */
  untraced: number;
  /** Traced and nothing found: left out. */
  noContact: number;
};

export function importCounts(cands: Candidate[]): ImportCounts {
  return {
    total: cands.length,
    onFile: cands.filter((c) => !!c.matched_buyer_id).length,
    reachable: cands.filter(hasSkipTraceContact).length,
    untraced: cands.filter((c) => !c.contacts).length,
    noContact: cands.filter((c) => !!c.contacts && !hasSkipTraceContact(c)).length,
  };
}

export type ImportStep = { phase: 'trace' | 'add' | 'verify'; done: number; of: number };
export type ImportResult = {
  ids: number[];
  added: number;
  /** On file already; their record got the trace. */
  matched: number;
  traced: number;
  cached: number;
  /** Traced and nothing to reach them by. */
  noContact: number;
  /** Set when the skip trace stopped part way; the owners traced before it still come in. */
  message: string | null;
  /** Emails checked with the workspace's verifier (Reoon) after the add, and how many came back safe to send. */
  verified: { checked: number; safe: number; error: string | null };
};

/** Run `fn` over `xs`, `n` at a time, in order of completion. */
async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) await fn(xs[i++]);
  }));
}

/**
 * `trace` off adds only the owners the pull already traced; the untraced stay
 * out and cost nothing. It is on only when nobody in the pull is traced yet.
 */
export async function importRun(workspaceId: number, run: Run, userId: string | null, onStep: (s: ImportStep) => void, opts: { trace: boolean } = { trace: true }): Promise<ImportResult> {
  const byKey = new Map(run.candidates.map((c) => [c.key, c]));
  const need = opts.trace ? run.candidates.filter((c) => !c.contacts) : [];
  let traced = 0; let cached = 0; let message: string | null = null;
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25);
    onStep({ phase: 'trace', done: i, of: need.length });
    const r = await skipTrace(workspaceId, chunk, run.run_id);
    if (!r.ok) { message = r.message; break; }
    for (const c of chunk) {
      const x = r.data.results[c.key];
      if (x && 'hits' in x) {
        byKey.set(c.key, { ...c, contacts: x.hits, contacts_at: x.at });
        traced++;
        if (x.cached) cached++;
      }
    }
  }
  if (need.length) {
    onStep({ phase: 'trace', done: need.length, of: need.length });
    void logRun(workspaceId, { kind: 'skiptrace', entity: 'buyer', label: `Campaign import skip trace · ${traced} prospect${traced === 1 ? '' : 's'}`, total: need.length, succeeded: traced, failed: need.length - traced, credits: Math.max(0, traced - cached), detail: { cached, source: 'genius', run_id: run.run_id } });
  }

  const all = run.candidates.map((c) => byKey.get(c.key) ?? c);
  const ready = all.filter(hasSkipTraceContact);
  const noContact = all.filter((c) => !!c.contacts && !hasSkipTraceContact(c)).length;
  const ids: number[] = []; const made: Record<string, number> = {};
  let added = 0; let matched = 0; let done = 0;
  const via = run.filters.found_via ?? null;
  await pool(ready, 4, async (c) => {
    if (c.matched_buyer_id) {
      await applyTraceToBuyer(workspaceId, c.matched_buyer_id, c).catch(() => null);
      ids.push(c.matched_buyer_id);
      matched++;
    } else {
      const r = await addCandidate(workspaceId, c, userId, via).catch(() => ({ ok: false, id: undefined } as { ok: boolean; id?: number }));
      // A duplicate phone or email comes back refused, with the id of the buyer already on file.
      if (r.id) { ids.push(r.id); made[c.key] = r.id; if (r.ok) added++; else matched++; }
    }
    onStep({ phase: 'add', done: ++done, of: ready.length });
  });

  // The run remembers which buyer each owner became, and the phones the trace found, so Genius shows them too.
  if (run.run_id && (traced || Object.keys(made).length)) {
    await saveCandidates(workspaceId, run.run_id, all.map((c) => (made[c.key] ? { ...c, matched_buyer_id: made[c.key], match_by: c.match_by ?? 'name' } : c))).catch(() => null);
  }
  const unique = Array.from(new Set(ids));
  return { ids: unique, added, matched, traced, cached, noContact, message, verified: await verifyBuyers(workspaceId, unique, onStep) };
}

/**
 * Skip-trace emails are someone's best guess, so they go through the same
 * power-mode check as every other address before a campaign mails them:
 * only "safe" is sent, the rest are parked on the buyer record.
 */
async function verifyBuyers(workspaceId: number, ids: number[], onStep: (s: ImportStep) => void): Promise<ImportResult['verified']> {
  let checked = 0; let safe = 0;
  for (let i = 0; i < ids.length; i += 200) {
    onStep({ phase: 'verify', done: i, of: ids.length });
    const r = await deliverability<{ results: { safe: boolean }[] }>(workspaceId, 'verify_emails', { buyer_ids: ids.slice(i, i + 200) });
    if (!r.ok) return { checked, safe, error: r.message };
    checked += r.data.results.length;
    safe += r.data.results.filter((x) => x.safe).length;
  }
  return { checked, safe, error: null };
}
