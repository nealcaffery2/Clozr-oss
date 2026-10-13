// Ingest keys — the credentials Deal Machine, Talkr, COMPR and buyr use to
// post into CLOZR.
//
// The key itself is only ever readable at the moment it is minted: the database
// stores a SHA-256 and a 12-character prefix, so a lost key is reissued rather
// than recovered. That is why `issueKey` returns the plaintext and nothing else
// ever does.

import { SUPABASE_URL, supabase } from './supabase';

/** The sources CLOZR knows how to receive. Adding one is a name, not a schema. */
export const INGEST_SOURCES = [
  { name: 'deal_machine', label: 'Deal Machine', hint: 'Chrome extension: scraped deals with photos, partner contacts and cash buyers' },
  { name: 'talkr', label: 'Talkr', hint: 'Calls, texts, transcripts and AI call notes' },
  { name: 'compr', label: 'COMPR', hint: 'Underwriting — ARV, rehab and MAO' },
  { name: 'buyr', label: 'buyr', hint: 'Cash buyers from deed sniping and Facebook comments. They land in Buyer Prospects, not the vetted buyer list.' },
  { name: 'flipradar', label: 'FlipRadar', hint: 'Alerts' },
  { name: 'zapier', label: 'Zapier / Webhook', hint: 'Flat JSON from Zapier, Make, n8n or any app — see Zapier & webhooks' },
  { name: 'jotform', label: 'Jotform', hint: 'One key per form; paste the ?key= URL into the form’s WebHooks' },
  { name: 'dashboard', label: 'TV dashboard', hint: 'Read-only: the Acme Homes leaderboard pulls its numbers from /leaderboard with this key (migration 85)' },
] as const;

export type IngestKey = {
  id: number;
  name: string;
  label: string | null;
  key_prefix: string;
  active: boolean;
  last_used_at: string | null;
  created_at: string;
  /** Talkr's webhook signing secret is set; the secret itself never leaves the database. */
  has_signing_secret: boolean;
  /** What a Jotform or Zapier key files a submission as. */
  creates: 'seller' | 'wholesaler' | 'buyer';
  /** Whether a sender's `options.run_compr` is honoured for this key (migration 55). */
  auto_compr: 'on' | 'off';
  /** A Jotform API key is stored for backfill; the key itself never leaves the database. */
  has_api_key: boolean;
  /** The acquisitions round robin new leads on this key are dealt to, as an id, or 'off' (migration 121). */
  round_robin: string;
  /** Jotform: the form pulled every five minutes, or 'off' (migration 121). */
  sync_form: string;
};


export type MintedKey = { id: number; name: string; key: string; prefix: string };

/** Where the senders post. Derived from the project URL so it can't drift. */
export function ingestUrl(): string {
  return SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/ingest` : '';
}

/** The columns every deployment has. `auto_compr` arrives with migration 72. */
const KEY_COLUMNS = 'id, name, label, key_prefix, active, last_used_at, created_at, has_signing_secret, creates, has_api_key';

export async function listKeys(workspaceId: number): Promise<IngestKey[]> {
  if (!supabase) return [];
  // The view, not the table: ingest_sources holds key_hash and the Talkr
  // signing secret, and SELECT on it is revoked from authenticated so neither
  // can reach the browser even by accident.
  const read = (columns: string) => supabase!
    .from('ingest_sources_public')
    .select(columns)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  // Code and migrations ship independently here — Vercel deploys on merge,
  // the SQL is applied by hand — so a deployment that has not had migration 72
  // applied yet must still list its keys. Asking for a column the view does
  // not have is a 42703 that takes `data` to null with it, which would empty
  // the Ingest keys panel and make every key look like it had vanished. Ask
  // for it, and fall back to the set without it.
  // Same again for migration 121's round_robin and sync_form.
  const withRr = await read(`${KEY_COLUMNS}, auto_compr, round_robin, sync_form`);
  if (!withRr.error) return (withRr.data as unknown as IngestKey[]) ?? [];

  const withCompr = await read(`${KEY_COLUMNS}, auto_compr`);
  if (!withCompr.error) {
    return ((withCompr.data as unknown as Omit<IngestKey, 'round_robin' | 'sync_form'>[]) ?? [])
      .map((k) => ({ ...k, round_robin: 'off', sync_form: 'off' }));
  }

  const { data } = await read(KEY_COLUMNS);
  return ((data as unknown as Omit<IngestKey, 'auto_compr' | 'round_robin' | 'sync_form'>[]) ?? [])
    .map((k) => ({ ...k, auto_compr: 'on' as const, round_robin: 'off', sync_form: 'off' }));
}

export async function issueKey(
  workspaceId: number,
  name: string,
  label: string,
): Promise<{ ok: boolean; key?: MintedKey; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('issue_ingest_key', {
    p_workspace_id: workspaceId,
    p_name: name,
    p_label: label || null,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, key: data as MintedKey };
}

/** Disabling is reversible and keeps the audit trail; deleting is not offered. */
export async function setKeyActive(
  id: number,
  active: boolean,
): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('ingest_sources').update({ active }).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/**
 * Store Talkr's webhook signing secret so deliveries can be verified.
 *
 * It is Talkr's secret, not ours — it is issued over there when the webhook
 * subscription is created, and pasted in here. Write-only from the client: the
 * value is never selectable again, only its presence.
 */
export async function setSigningSecret(
  id: number,
  secret: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('set_ingest_secret', { p_id: id, p_secret: secret });
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** The ingest URL with the key in the query, for senders that cannot set headers (Jotform). */
export function ingestKeyUrl(key: string): string {
  return ingestUrl() ? `${ingestUrl()}?key=${encodeURIComponent(key)}` : '';
}

/**
 * Key settings an owner or admin can change: what a Jotform key creates, whether
 * a sender's `options.run_compr` is honoured (Deal Machine's Auto-run COMPR),
 * the Jotform API key for backfill, the key's acquisitions round robin and
 * the Jotform form it auto-syncs (migration 121). All but the API key read back from
 * `ingest_sources_public`; the API key is write-only.
 */
export async function setKeySetting(
  id: number,
  key: 'creates' | 'auto_compr' | 'jotform_api_key' | 'round_robin' | 'sync_form',
  value: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('set_ingest_setting', { p_id: id, p_key: key, p_value: value });
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Where the TV dashboard pulls the leaderboard from (the `dashboard` key). */
export function leaderboardUrl(): string {
  return SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/leaderboard` : '';
}

/** Where Talkr's webhook subscription should point. */
export function talkrWebhookUrl(): string {
  return SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/talkr-webhook` : '';
}
