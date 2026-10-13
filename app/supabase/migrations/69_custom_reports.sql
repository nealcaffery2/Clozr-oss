-- 69: custom reports — the report builder on Reporting → Custom reports.
--
-- A report is one row: its pages, blocks (each a saved engine spec from
-- lib/report-catalog.ts or a custom metric formula), theme and date settings
-- are one JSON document in `definition`, so a save is a single write. Custom
-- metrics are formulas over two to four specs. A schedule emails the report
-- on a cadence through supabase/functions/report-mail, kicked hourly by
-- pg_cron the way the dispo tick and the call sync are.
--
-- Members read every report of their workspace except another person's
-- private one; the owner, or a workspace owner/admin, edits and deletes.

create table if not exists public.reports (
  id bigserial primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  name text not null,
  owner_id uuid references auth.users(id) on delete set null,
  is_private boolean not null default false,
  is_template boolean not null default false,
  created_from text not null default 'blank',   -- blank | template | clone | dashboard
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reports_ws_idx on public.reports (workspace_id, updated_at desc);
create index if not exists reports_owner_idx on public.reports (owner_id);

alter table public.reports enable row level security;
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated
  using (public.is_workspace_member(workspace_id) and (not is_private or owner_id = (select auth.uid())));
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and owner_id = (select auth.uid()));
drop policy if exists reports_update on public.reports;
create policy reports_update on public.reports for update to authenticated
  using (public.is_workspace_member(workspace_id) and (owner_id = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin')))
  with check (public.is_workspace_member(workspace_id) and (owner_id = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin')));
drop policy if exists reports_delete on public.reports;
create policy reports_delete on public.reports for delete to authenticated
  using (public.is_workspace_member(workspace_id) and (owner_id = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin')));
grant select, insert, update, delete on public.reports to authenticated;
drop trigger if exists reports_touch on public.reports;
create trigger reports_touch before update on public.reports for each row execute function public.touch_updated_at();

create table if not exists public.custom_metrics (
  id bigserial primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  display_format text not null default 'int',   -- int | float | pct | usd
  formula jsonb not null default '[]'::jsonb,   -- lib/report-engine.ts Token[]
  polarity text not null default 'up',          -- up: increase is positive · down: decrease is positive
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists custom_metrics_ws_idx on public.custom_metrics (workspace_id, name);
alter table public.custom_metrics enable row level security;
drop policy if exists custom_metrics_select on public.custom_metrics;
create policy custom_metrics_select on public.custom_metrics for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists custom_metrics_insert on public.custom_metrics;
create policy custom_metrics_insert on public.custom_metrics for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
drop policy if exists custom_metrics_update on public.custom_metrics;
create policy custom_metrics_update on public.custom_metrics for update to authenticated
  using (public.is_workspace_member(workspace_id) and (created_by = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin')))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists custom_metrics_delete on public.custom_metrics;
create policy custom_metrics_delete on public.custom_metrics for delete to authenticated
  using (public.is_workspace_member(workspace_id) and (created_by = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin')));
grant select, insert, update, delete on public.custom_metrics to authenticated;
drop trigger if exists custom_metrics_touch on public.custom_metrics;
create trigger custom_metrics_touch before update on public.custom_metrics for each row execute function public.touch_updated_at();

create table if not exists public.report_schedules (
  report_id bigint primary key references public.reports(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  frequency text not null default 'weekly',     -- daily | weekly | monthly | quarterly | annually
  at_time text not null default '10:00',        -- HH:MM in tz
  tz text not null default 'America/Chicago',
  date_preset text not null default 'Last week',
  comparison text not null default 'previous',
  use_widget_dates boolean not null default true,
  from_email text,
  subject text,
  recipients text[] not null default '{}',
  message text,
  enabled boolean not null default true,
  next_run_at timestamptz,                      -- null: due on the mailer's next pass, which then aligns it to the cadence
  last_run_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists report_schedules_due_idx on public.report_schedules (next_run_at) where enabled;
alter table public.report_schedules enable row level security;
drop policy if exists report_schedules_select on public.report_schedules;
create policy report_schedules_select on public.report_schedules for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists report_schedules_write on public.report_schedules;
create policy report_schedules_write on public.report_schedules for all to authenticated
  using (public.is_workspace_member(workspace_id) and exists (
    select 1 from public.reports r where r.id = report_schedules.report_id
      and (r.owner_id = (select auth.uid()) or public.has_role(r.workspace_id, 'owner', 'admin'))))
  with check (public.is_workspace_member(workspace_id) and exists (
    select 1 from public.reports r where r.id = report_schedules.report_id
      and (r.owner_id = (select auth.uid()) or public.has_role(r.workspace_id, 'owner', 'admin'))));
grant select, insert, update, delete on public.report_schedules to authenticated;
drop trigger if exists report_schedules_touch on public.report_schedules;
create trigger report_schedules_touch before update on public.report_schedules for each row execute function public.touch_updated_at();

-- The kick: every hour at :05, POST to the mailer with the service key from
-- the vault (same pattern as call_sync_kick). The mailer sends what is due.
create or replace function public.report_mail_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/report-mail',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.report_mail_kick() from public, anon, authenticated;

select cron.unschedule('clozr-report-mail') where exists (select 1 from cron.job where jobname = 'clozr-report-mail');
select cron.schedule('clozr-report-mail', '5 * * * *', 'select public.report_mail_kick()');
