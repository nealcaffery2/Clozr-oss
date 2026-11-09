-- Verify an address before the first send to it, and remember the verdict.
--
-- The send guard (mailguard.ts verifyAtSend) checks an address no row has a
-- verdict for: syntax, the domain's mail servers, then Reoon. Every verdict
-- lands here, keyed by workspace and lower-cased address, so an address on
-- no buyer or seller row (or only on rows Reoon did not write) is checked
-- once, not on every send. email_safety_flags reads this table alongside the
-- contact rows. Hard bounces stay on email_suppressions (the guard refuses
-- them before this check).

create table if not exists public.email_verifications (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  email text not null,
  status text not null,
  safe boolean not null,
  provider text not null,
  verified_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

alter table public.email_verifications enable row level security;

drop policy if exists email_verifications_select on public.email_verifications;
create policy email_verifications_select on public.email_verifications
  for select using (workspace_id in (select public.my_workspace_ids()));

create or replace function public.email_safety_flags(p_ws bigint, p_emails text[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with want as (
    select distinct lower(trim(e)) as email from unnest(coalesce(p_emails, '{}')) as e where e like '%@%'
  ),
  found as (
    select lower(b.email) as email, b.email_safe_to_send as safe
      from public.buyers b join want w on lower(b.email) = w.email
     where b.workspace_id = p_ws and b.email is not null
    union all
    select lower(c.email), c.email_safe_to_send
      from public.buyer_contacts c join want w on lower(c.email) = w.email
     where c.workspace_id = p_ws and c.email is not null
    union all
    select lower(s.email), s.email_safe_to_send
      from public.sellers s join want w on lower(s.email) = w.email
     where s.workspace_id = p_ws and s.email is not null
    union all
    select be.email_key, be.email_safe_to_send
      from public.buyer_emails be join want w on be.email_key = w.email
     where be.workspace_id = p_ws
    union all
    select v.email, v.safe
      from public.email_verifications v join want w on v.email = w.email
     where v.workspace_id = p_ws
  )
  select coalesce(jsonb_agg(jsonb_build_object('email', email, 'safe', safe)), '[]'::jsonb) from found;
$$;

revoke all on function public.email_safety_flags(bigint, text[]) from public, anon, authenticated;
grant execute on function public.email_safety_flags(bigint, text[]) to service_role;
