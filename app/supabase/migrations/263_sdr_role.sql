-- 263 · The SDR workspace role.
--
-- An SDR works a contacts list (Buyers) by phone, text, email and RVM, and
-- none of the seller, deal or contract screens (lib/team.ts). Calls and texts
-- go out on the rep's own Talkr lines. At the database an SDR reads and writes
-- what dispositions does: has_role() counts an SDR as dispositions, and every
-- policy that names 'dispositions' by hand gains 'sdr' beside it. Safe to
-- re-run.

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role = any (array['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships', 'sdr']));

alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites add constraint workspace_invites_role_check
  check (role = any (array['admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships', 'sdr']));

-- An SDR passes every has_role(…, 'dispositions') check.
create or replace function public.has_role(ws bigint, variadic roles text[])
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    public.member_role(ws) = any(roles)
    or (public.member_role(ws) = 'sdr' and 'dispositions' = any(roles)),
    false)
$$;

-- Policies that read workspace_members.role themselves (buyers, buyer phones,
-- markets, scores …): 'sdr' goes in next to 'dispositions'.
do $$
declare
  p record;
  q text;
  c text;
  stmt text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') like '%''dispositions''::text%' or coalesce(with_check, '') like '%''dispositions''::text%')
       and coalesce(qual, '') not like '%''sdr''::text%'
       and coalesce(with_check, '') not like '%''sdr''::text%'
  loop
    q := replace(p.qual, '''dispositions''::text', '''dispositions''::text, ''sdr''::text');
    c := replace(p.with_check, '''dispositions''::text', '''dispositions''::text, ''sdr''::text');
    stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then stmt := stmt || ' using (' || q || ')'; end if;
    if c is not null then stmt := stmt || ' with check (' || c || ')'; end if;
    execute stmt;
  end loop;
end $$;
