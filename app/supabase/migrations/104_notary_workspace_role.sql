-- 104 · Allow the notary workspace role on roster and invites.
--
-- Migration 94 added notary commission columns and the digital-seal flow, and
-- Settings / add-teammate already accept role = 'notary'. The CHECK constraints
-- from migration 17 still listed only the original roles, so adding a notary
-- failed on workspace_invites upsert with a generic 500
-- ("Something went wrong on our side").

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role = any (array['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary']));

alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites add constraint workspace_invites_role_check
  check (role = any (array['admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary']));
