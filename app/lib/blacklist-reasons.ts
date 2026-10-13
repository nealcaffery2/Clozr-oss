// Why someone is on the secret blacklist (migration 106). The blacklist itself
// is still the tag in lib/secret-list.ts; this is the note beside it. Every
// read and write fails open: a database without the table still blacklists,
// it just cannot say why.

import { supabase } from './supabase';

export const BLACKLIST_REASONS = [
  'Asked not to be contacted',
  'Rude or abusive',
  'Backed out of a contract',
  'Wholesaler posing as a buyer',
  'Bad contact info',
  'Competitor',
  'Scam or fraud risk',
  'Other',
] as const;

export type BlacklistKind = 'seller' | 'buyer';

const key = (kind: BlacklistKind, id: number) => `${kind}:${id}`;
const numeric = (uiId: string) => Number(uiId.replace(/^[a-z]+/i, ''));

/** Reasons given this session, so demo mode and a slow reload still show them. */
const local = new Map<string, string>();

/** A missing table or column is "not migrated yet", not a failure to show. */
const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''));

export function reasonKindOf(rowKind: 'Person' | 'Buyer'): BlacklistKind {
  return rowKind === 'Buyer' ? 'buyer' : 'seller';
}

export async function saveBlacklistReason(
  workspaceId: number | null, kind: BlacklistKind, uiIds: string[], reason: string,
): Promise<{ ok: boolean; message?: string }> {
  const text = reason.trim().slice(0, 500);
  if (!text) return { ok: true };
  const ids = uiIds.map(numeric).filter(Number.isFinite);
  for (const id of ids) local.set(key(kind, id), text);
  if (!supabase || workspaceId == null || !ids.length) return { ok: true };
  const { error } = await supabase.from('blacklist_reasons').upsert(
    ids.map((record_id) => ({ workspace_id: workspaceId, record_kind: kind, record_id, reason: text, created_at: new Date().toISOString() })),
    { onConflict: 'workspace_id,record_kind,record_id' },
  );
  if (error && !missing(error)) return { ok: false, message: error.message };
  return { ok: true };
}

/** Every reason in the workspace, keyed "seller:12" / "buyer:5". */
export async function loadBlacklistReasons(workspaceId: number | null): Promise<Map<string, string>> {
  const out = new Map(local);
  if (!supabase || workspaceId == null) return out;
  const { data, error } = await supabase.from('blacklist_reasons')
    .select('record_kind, record_id, reason').eq('workspace_id', workspaceId).limit(5000);
  if (error) return out;
  for (const r of data ?? []) {
    out.set(key(r.record_kind, r.record_id), r.reason);
  }
  for (const [k, v] of local) out.set(k, v);
  return out;
}

export function reasonFor(reasons: Map<string, string>, kind: BlacklistKind, uiId: string): string {
  return reasons.get(key(kind, numeric(uiId))) ?? '';
}
