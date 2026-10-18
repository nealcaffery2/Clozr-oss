import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type TelnyxSetting = 'TELNYX_API_KEY' | 'TELNYX_PUBLIC_KEY' | 'TELNYX_MESSAGING_PROFILE_ID' | 'TELNYX_CONNECTION_ID';

/**
 * The function secret, else the Vault copy of what Talkr runs on (migration
 * 98). Null when neither is set. Throws when the Vault read fails, so a
 * caller holds or errors instead of acting as if Telnyx is not set up.
 * `admin` must be the service-role client.
 */
export async function telnyxSetting(admin: SupabaseClient, name: TelnyxSetting): Promise<string | null> {
  const env = Deno.env.get(name)?.trim();
  if (env) return env;
  const { data, error } = await admin.rpc('telnyx_vault_setting', { p_name: name.toLowerCase() });
  if (error) throw new Error(`could not read ${name.toLowerCase()} from Vault: ${error.message}`);
  return typeof data === 'string' && data.trim() ? data.trim() : null;
}
