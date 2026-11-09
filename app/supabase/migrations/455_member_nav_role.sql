-- A member whose database rights and screen set differ. Drew Collins (owner
-- call 2026-11-03) needs admin rights so contracts, their PDFs and the buyers
-- they go to never trip RLS again (partnerships was missing from
-- doc_sources_write and the buyers policies; fixed in place the same night),
-- but the Partnerships nav: Submissions, Vendors, Contracts, the record. The
-- app draws the shell from nav_role when set; every policy keeps reading role.
alter table public.workspace_members add column if not exists nav_role text
  constraint workspace_members_nav_role_check
  check (nav_role in ('owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships', 'sdr'));

comment on column public.workspace_members.nav_role is
  'The role the app draws the shell as (nav, landing, lists) when it differs from role. RLS reads role only. Null means role.';

-- Partnerships could create a contract but not upload its PDF or add the
-- buyer it goes to. Same statements as the live fix, so a fresh database
-- matches.
alter policy doc_sources_write on storage.objects with check (
  bucket_id = 'doc-sources' and split_part(name, '/', 1) = 'ws'
  and has_role(nullif(split_part(name, '/', 2), '')::bigint,
    variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'partnerships']));
alter policy buyers_insert on public.buyers with check (workspace_id in (
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.role = any (array['owner', 'admin', 'dispositions', 'sdr', 'partnerships'])));
alter policy buyers_update on public.buyers
  using (workspace_id in (
    select m.workspace_id from public.workspace_members m
    where m.user_id = (select auth.uid())
      and m.role = any (array['owner', 'admin', 'dispositions', 'sdr', 'partnerships'])))
  with check (workspace_id in (
    select m.workspace_id from public.workspace_members m
    where m.user_id = (select auth.uid())
      and m.role = any (array['owner', 'admin', 'dispositions', 'sdr', 'partnerships'])));
alter policy buyers_select on public.buyers using (workspace_id in (
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.role = any (array['owner', 'admin', 'dispositions', 'sdr', 'tc', 'member', 'partnerships'])));

update public.workspace_members m
   set role = 'admin', nav_role = 'partnerships'
  from auth.users u
 where u.id = m.user_id
   and lower(u.email) = 'chris@yourcompany.com'
   and m.nav_role is null;
