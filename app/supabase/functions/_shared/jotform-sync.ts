/**
 * The Jotform auto-sync's pure rules (jotform-import `sync`), shared with the
 * assert check app/tools/jotform-sync.test.ts (`npx tsx`).
 */

/** Jotform's account-local "YYYY-MM-DD HH:MM:SS" → ISO (close enough: both sides of every comparison go through it). */
export const jotIso = (t: string | null | undefined) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : undefined);

/**
 * Which submissions a sync applies: new ones, and ones edited in Jotform since
 * the ledger last applied them (ingest_events.source_updated_at, migration 132).
 * A submission the ledger has with no updated_at recorded is re-applied once
 * when Jotform has one: ingest_apply_flat patches it if the content changed and
 * dedupes it if not, and either way the updated_at is recorded.
 */
export function needsApply(sub: { updated_at?: string | null }, known: { source_updated_at: string | null } | undefined): boolean {
  if (!known) return true;
  const upd = jotIso(sub.updated_at);
  if (!upd) return false;
  return !known.source_updated_at || Date.parse(upd) > Date.parse(known.source_updated_at);
}
