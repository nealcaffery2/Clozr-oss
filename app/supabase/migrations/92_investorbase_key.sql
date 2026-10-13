-- InvestorBase subscriber key, write-only.
--
-- Account → Integrations in InvestorBase issues the key. An owner or admin
-- pastes it here. The column is not granted to the browser; investorbase-import
-- reads it with the service role. Clearing the key (empty string) disconnects.

create table if not exists public.workspace_integration_secrets (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  investorbase_api_key text,
  updated_at timestamptz not null default now()
);

alter table public.workspace_integration_secrets enable row level security;
revoke all on public.workspace_integration_secrets from public, anon, authenticated;

create or replace function public.set_investorbase_key(p_workspace_id bigint, p_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v text := nullif(btrim(coalesce(p_key, '')), '');
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can save the InvestorBase key' using errcode = '42501';
  end if;
  if v is not null and (length(v) < 8 or length(v) > 400) then
    raise exception 'that does not look like an InvestorBase API key' using errcode = '22023';
  end if;
  insert into public.workspace_integration_secrets (workspace_id, investorbase_api_key)
  values (p_workspace_id, v)
  on conflict (workspace_id) do update
    set investorbase_api_key = excluded.investorbase_api_key, updated_at = now();
  perform public.audit_event(p_workspace_id, 'investorbase.key', jsonb_build_object('connected', v is not null));
end $$;
revoke all on function public.set_investorbase_key(bigint, text) from public, anon;
grant execute on function public.set_investorbase_key(bigint, text) to authenticated;

create or replace function public.investorbase_connected(p_workspace_id bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of that workspace' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.workspace_integration_secrets
     where workspace_id = p_workspace_id and length(coalesce(investorbase_api_key, '')) >= 8
  );
end $$;
revoke all on function public.investorbase_connected(bigint) from public, anon;
grant execute on function public.investorbase_connected(bigint) to authenticated;
