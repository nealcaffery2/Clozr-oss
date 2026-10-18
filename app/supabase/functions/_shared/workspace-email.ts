/**
 * Per-workspace email credentials, so each workspace sends and reads with its
 * own accounts instead of the project's.
 *
 *   deliverability_secrets.resend_key             Resend API key (blasts)
 *   deliverability_secrets.resend_webhook_secret  that Resend account's webhook signing secret
 *   deliverability_secrets.inboxkit_key           InboxKit API key (mailbox health, cold DNS)
 *   cold_warmup_secrets.api_key                   Instantly key (cold-warmup.ts warmupKey)
 *   workspaces.settings.blast_from                "Acme Homes <deals@deals.yourcompany.com>"
 *
 * Every key is sealed with google.ts seal() and never returned to the
 * browser. A workspace that has not set one falls back to the project secret
 * (RESEND_API_KEY, MAIL_FROM_BLASTS, INBOXKIT_API_KEY, INSTANTLY_API_KEY).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { seal, unseal } from './google.ts';
import { type EnvLike, parseFrom, suggestBlastFrom, workspaceResendEnv } from './resend-rules.ts';
import { transactionalFrom } from './resend.ts';
import { listInboxkitWorkspaces } from './inboxkit.ts';

type Any = any;

export type SecretColumn = 'resend_key' | 'resend_webhook_secret' | 'inboxkit_key';

/** The plain value, or null when unset or unreadable. */
export async function workspaceSecret(admin: SupabaseClient, ws: number, column: SecretColumn): Promise<string | null> {
  const { data, error } = await admin.from('deliverability_secrets').select(column).eq('workspace_id', ws).maybeSingle();
  if (error) { console.error('deliverability_secrets read', column, error.message); return null; }
  const stored = String((data as Any)?.[column] ?? '').trim();
  if (!stored) return null;
  try { return (await unseal(stored)).trim() || null; } catch { return null; }
}

/** Seal and store, or clear with null. Other columns on the row are kept. */
export async function setWorkspaceSecret(admin: SupabaseClient, ws: number, column: SecretColumn, plain: string | null): Promise<void> {
  const value = plain && plain.trim() ? await seal(plain.trim()) : null;
  const { error } = await admin.from('deliverability_secrets').upsert({ workspace_id: ws, [column]: value }, { onConflict: 'workspace_id' });
  if (error) throw error;
}

export type WorkspaceResend = {
  env: EnvLike;
  /** The workspace saved its own Resend key. */
  ownKey: boolean;
  /** settings.blast_from, parsed. Null when the workspace uses the project sender. */
  ownFrom: string | null;
  company: string;
};

/** The env every blast for `ws` sends with. */
export async function resendEnvFor(admin: SupabaseClient, ws: number): Promise<WorkspaceResend> {
  const [key, { data: row }] = await Promise.all([
    workspaceSecret(admin, ws, 'resend_key'),
    admin.from('workspaces').select('name, settings').eq('id', ws).maybeSingle(),
  ]);
  const settings = ((row as Any)?.settings ?? {}) as Any;
  const ownFrom = parseFrom(typeof settings.blast_from === 'string' ? settings.blast_from : null)?.from ?? null;
  return {
    env: workspaceResendEnv(Deno.env, { key, from: ownFrom }),
    ownKey: !!key,
    ownFrom,
    company: String(settings?.company?.name || (row as Any)?.name || ''),
  };
}

/**
 * Resend env for contract signing mail. Uses the workspace key and blast_from
 * when set; otherwise keeps the workspace key but falls back to the project's
 * MAIL_FROM or a suggested deals@ sender so a workspace with its own Resend
 * account is not stuck silent (blasts still require blast_from).
 */
export async function signingResendEnv(admin: SupabaseClient, ws: number): Promise<EnvLike> {
  const r = await resendEnvFor(admin, ws);
  if (transactionalFrom(r.env)) return r.env;
  const { data: row } = await admin.from('workspaces').select('name, settings').eq('id', ws).maybeSingle();
  const settings = ((row as Any)?.settings ?? {}) as Any;
  const company = settings?.company ?? {};
  const key = (r.env.get('RESEND_API_KEY') ?? '').trim();
  const from = r.ownFrom
    ?? suggestBlastFrom(company.name || (row as Any)?.name, company.email)
    ?? transactionalFrom(Deno.env)?.from
    ?? null;
  if (!key || !from) return r.env;
  return workspaceResendEnv(Deno.env, { key, from });
}

/** Every webhook signing secret to try: the project's, then each workspace's own. */
export async function resendWebhookSecrets(admin: SupabaseClient): Promise<string[]> {
  const out: string[] = [];
  const project = (Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '').trim();
  if (project) out.push(project);
  const { data } = await admin.from('deliverability_secrets').select('resend_webhook_secret').not('resend_webhook_secret', 'is', null).limit(200);
  for (const r of (data ?? []) as Any[]) {
    try {
      const s = (await unseal(String(r.resend_webhook_secret))).trim();
      if (s && !out.includes(s)) out.push(s);
    } catch { /* unreadable: skip */ }
  }
  return out;
}

export type KeySource = { key: string | null; own: boolean };

/** The workspace's InboxKit key, else INBOXKIT_API_KEY. */
export async function inboxkitKey(admin: SupabaseClient, ws: number): Promise<KeySource> {
  const own = await workspaceSecret(admin, ws, 'inboxkit_key');
  if (own) return { key: own, own: true };
  return { key: (Deno.env.get('INBOXKIT_API_KEY') ?? '').trim() || null, own: false };
}

/**
 * The InboxKit workspaces to read for `ws`: the one cold-pool saved, else
 * every workspace on the key (a domain or mailbox is looked up in each).
 */
export async function inboxkitWorkspaceUids(admin: SupabaseClient, ws: number, key: string): Promise<string[]> {
  const { data } = await admin.from('cold_workspace_settings').select('inboxkit_workspace_uid').eq('workspace_id', ws).maybeSingle();
  const saved = String((data as Any)?.inboxkit_workspace_uid ?? '').trim();
  if (saved) return [saved];
  return (await listInboxkitWorkspaces(key)).map((w) => w.uid);
}
