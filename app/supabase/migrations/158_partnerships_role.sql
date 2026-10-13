-- 158 · The partnerships workspace role.
--
-- Partnerships works partner submissions and vendors: People shows only the
-- Submissions and vendor lists, the record keeps underwriting, and there is no
-- Buyers, Dispo, Today or seller smart lists (lib/team.ts). Buyers stay out at
-- the database too: buyers_select (migration 94) names the roles that read
-- them and partnerships is not one.
--
-- For a teammate who handles partner submissions and should not see the
-- acquisitions screens. An owner or admin sets the role per member.

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role = any (array['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships']));

alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites add constraint workspace_invites_role_check
  check (role = any (array['admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships']));
