-- 102: which network accepted the ringless drop, and a vault reader for those accounts.
--
-- rvm-tick tries Drop Cowboy, then Slybroadcast, then a Telnyx machine-detect
-- call. provider records which one accepted the job. The secrets stay in
-- Vault (or in the function's environment) and only the service role can read
-- them: dropcowboy_team_id, dropcowboy_secret, dropcowboy_brand_id,
-- dropcowboy_voice_id, slybroadcast_uid, slybroadcast_password.

alter table public.rvm_drops add column if not exists provider text;

create or replace function public.rvm_provider_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = p_name
    and p_name in (
      'dropcowboy_team_id',
      'dropcowboy_secret',
      'dropcowboy_brand_id',
      'dropcowboy_voice_id',
      'slybroadcast_uid',
      'slybroadcast_password'
    )
  limit 1
$$;

revoke all on function public.rvm_provider_secret(text) from public, anon, authenticated;
grant execute on function public.rvm_provider_secret(text) to service_role;
