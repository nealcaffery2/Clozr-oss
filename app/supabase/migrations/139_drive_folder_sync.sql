-- A Google Drive deals folder, kept on the deals (docs/drive-sync.md).
--
-- A team can keep every deal's paperwork and photos in a shared Drive folder
-- (Dispositions › Deals › Wholesale › Wholesale Active Contracts › "123 Main
-- St, Springfield, TX 78000" › files and a Photos folder). drive-photos'
-- `tree` action walks that folder with a teammate's Google connection (Drive
-- read-only, granted on its own from Settings → Google), matches each
-- address-named folder to the deal on that property, and files every document
-- and photo under it on the deal (deal_files, source 'drive'). Nothing is
-- copied or deleted: each row links to the Drive file.
--
-- One row per workspace: which folder, whose connection, and the walk's state
-- (folders seen with their parent and deal, folders still to list, the last
-- pass, address folders no deal matched yet).

create table if not exists public.drive_sync (
  workspace_id   bigint primary key references public.workspaces(id) on delete cascade,
  account_id     bigint references public.google_accounts(id) on delete set null,
  root_folder_id text not null,
  root_name      text,
  drive_id       text,
  enabled        boolean not null default true,
  state          jsonb not null default '{}'::jsonb,
  last_run_at    timestamptz,
  last_error     text,
  last_notes     jsonb,
  lock_until     timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.drive_sync enable row level security;
drop policy if exists drive_sync_select on public.drive_sync;
create policy drive_sync_select on public.drive_sync for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.drive_sync from anon, authenticated;
grant select (workspace_id, root_folder_id, root_name, enabled, last_run_at, last_error, last_notes, updated_at) on public.drive_sync to authenticated;

create or replace function public.drive_tree_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.drive_sync where enabled and account_id is not null) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/drive-photos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tree"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.drive_tree_kick() from public, anon, authenticated;

select cron.unschedule('clozr-drive-tree-sync') where exists (select 1 from cron.job where jobname = 'clozr-drive-tree-sync');
select cron.schedule('clozr-drive-tree-sync', '7-57/10 * * * *', 'select public.drive_tree_kick()');
