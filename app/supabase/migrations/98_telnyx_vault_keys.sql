-- 98: the Telnyx credentials Talkr already runs on (talkr-platform
-- runtime_settings) are copied into CLOZR's Vault as telnyx_api_key,
-- telnyx_public_key and telnyx_messaging_profile_id, so ten-dlc-register,
-- ten-dlc-events and caller-registry work without anyone pasting the key into
-- Edge Function secrets a second time. A function secret of the same name still
-- wins. The values are stored with vault.create_secret and are not in this file.
-- Service role only, and only these three names.

create or replace function public.telnyx_vault_setting(p_name text)
returns text
language sql
stable
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = p_name
    and p_name in ('telnyx_api_key', 'telnyx_public_key', 'telnyx_messaging_profile_id')
  limit 1
$$;

revoke all on function public.telnyx_vault_setting(text) from public, anon, authenticated;
grant execute on function public.telnyx_vault_setting(text) to service_role;
