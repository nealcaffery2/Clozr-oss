-- 92: caller-registry reads the Firecrawl key from Vault when the function
-- secret FIRECRAWL_API_KEY is unset. The key itself is stored with
-- vault.create_secret(..., 'firecrawl_api_key') and is not in this file.
-- Service role only, so a signed-in member cannot read it through the API.

create or replace function public.caller_registry_firecrawl_key()
returns text
language sql
stable
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'firecrawl_api_key'
  limit 1
$$;

revoke all on function public.caller_registry_firecrawl_key() from public, anon, authenticated;
grant execute on function public.caller_registry_firecrawl_key() to service_role;
