-- The cron jobs sign edge-function calls with the vault's service key; the
-- functions' runtime env key can be a different issue of it. Lets a function
-- (service role only) check a bearer against exactly the key the cron sends.
create or replace function public.is_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_key, '') <> ''
     and p_key = (select decrypted_secret from vault.decrypted_secrets where name = 'clozr_service_role_key');
$$;
revoke all on function public.is_cron_key(text) from public, anon, authenticated;
grant execute on function public.is_cron_key(text) to service_role;
