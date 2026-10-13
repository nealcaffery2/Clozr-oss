-- 115 · Clozr Docs template library (docs/esign spec: template library + content blocks)
--
--   * doc_folders: one folder tree for templates and one for contracts
--     (`scope`), nested by parent_id. Deleting a folder moves what was in it
--     up to its parent; that is done by the contracts function, and the FKs
--     below only make sure nothing points at a folder that is gone.
--   * doc_content_blocks: the clause library. A template places a section as
--     {{block:<id>}}; it is pasted in before variables are filled.
--   * doc_templates gains versions. A family is the root row plus every row
--     whose parent_id points at it. The current version has superseded_at
--     null; an older one keeps its text, goes inactive, and has its key parked
--     as `<key>~v<n>` so the (workspace, key) unique index and every lookup by
--     key keep landing on the current version. Also: folder, archive, and the
--     defaults the New contract form starts from.
--   * contracts records the template version it was made from, and can be
--     filed in a folder.
--
-- Usage ("used 12×") is counted from contracts.template_id, per workspace, so
-- there is no counter here to drift. No seed rows: the starter clauses are a
-- button on the Sections tab.

-- ---------------------------------------------------------------- folders
create table if not exists public.doc_folders (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  scope         text not null default 'templates',
  name          text not null,
  parent_id     bigint references public.doc_folders(id) on delete set null,
  sort          integer not null default 0,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint doc_folders_scope_chk check (scope in ('templates', 'contracts')),
  constraint doc_folders_name_chk check (length(btrim(name)) between 1 and 120)
);
create index if not exists doc_folders_ws_idx on public.doc_folders (workspace_id, scope, parent_id);
alter table public.doc_folders enable row level security;
drop policy if exists doc_folders_select on public.doc_folders;
create policy doc_folders_select on public.doc_folders for select
  using (public.is_workspace_member(workspace_id));
-- Template folders are the admins' (like templates); contract folders belong
-- to everyone who can send contracts (like contracts).
drop policy if exists doc_folders_write on public.doc_folders;
create policy doc_folders_write on public.doc_folders for all
  using (case when scope = 'contracts'
    then public.has_role(workspace_id, 'owner','admin','acquisitions','dispositions','tc')
    else public.has_role(workspace_id, 'owner','admin') end)
  with check (case when scope = 'contracts'
    then public.has_role(workspace_id, 'owner','admin','acquisitions','dispositions','tc')
    else public.has_role(workspace_id, 'owner','admin') end);
drop trigger if exists doc_folders_touch on public.doc_folders;
create trigger doc_folders_touch before update on public.doc_folders for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- clause library
create table if not exists public.doc_content_blocks (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  name          text not null,
  body          text not null default '',
  tags          text[] not null default '{}',
  locked        boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint doc_content_blocks_name_chk check (length(btrim(name)) between 1 and 160)
);
create index if not exists doc_content_blocks_ws_idx on public.doc_content_blocks (workspace_id, name);
alter table public.doc_content_blocks enable row level security;
drop policy if exists doc_content_blocks_select on public.doc_content_blocks;
create policy doc_content_blocks_select on public.doc_content_blocks for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists doc_content_blocks_write on public.doc_content_blocks;
create policy doc_content_blocks_write on public.doc_content_blocks for all
  using (public.has_role(workspace_id, 'owner','admin'))
  with check (public.has_role(workspace_id, 'owner','admin'));
drop trigger if exists doc_content_blocks_touch on public.doc_content_blocks;
create trigger doc_content_blocks_touch before update on public.doc_content_blocks for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- templates
alter table public.doc_templates
  add column if not exists folder_id bigint references public.doc_folders(id) on delete set null,
  add column if not exists version integer not null default 1,
  add column if not exists parent_id bigint references public.doc_templates(id) on delete set null,
  add column if not exists superseded_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists default_expiry_days integer,
  add column if not exists reminder_policy jsonb,
  add column if not exists default_signing_order text;
alter table public.doc_templates drop constraint if exists doc_templates_signing_order_chk;
alter table public.doc_templates add constraint doc_templates_signing_order_chk
  check (default_signing_order is null or default_signing_order in ('parallel', 'sequential'));
alter table public.doc_templates drop constraint if exists doc_templates_expiry_chk;
alter table public.doc_templates add constraint doc_templates_expiry_chk
  check (default_expiry_days is null or default_expiry_days between 1 and 365);
create index if not exists doc_templates_family_idx on public.doc_templates (parent_id) where parent_id is not null;
create index if not exists doc_templates_folder_idx on public.doc_templates (folder_id) where folder_id is not null;

-- ---------------------------------------------------------------- contracts
alter table public.contracts
  add column if not exists template_version integer,
  add column if not exists folder_id bigint references public.doc_folders(id) on delete set null;
create index if not exists contracts_folder_idx on public.contracts (workspace_id, folder_id) where folder_id is not null;
create index if not exists contracts_template_idx on public.contracts (workspace_id, template_id) where template_id is not null;
