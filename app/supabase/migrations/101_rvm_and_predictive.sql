-- 101: voicemail library, ringless-voicemail queue, and RVM as an action-plan step.
--
-- A plan step with channel 'rvm' queues a row in rvm_drops, dated like every
-- other step. rvm-tick (kicked once a minute) decides, from the person's
-- local window, do-not-call, and how recently they were talked to or dropped,
-- whether to send it. With a Telnyx call-control connection it places the
-- call and leaves the recording when a machine answers. Without one the row
-- becomes 'ready' and the dialer's RVM tab walks it with a voicemail drop.
--
-- telnyx_connection_id is the fourth Vault name telnyx_vault_setting may read.

alter table public.action_plan_steps drop constraint if exists action_plan_steps_channel_check;
alter table public.action_plan_steps add constraint action_plan_steps_channel_check
  check (channel in ('sms', 'email', 'call', 'task', 'wait', 'stage', 'tag', 'assign', 'compr_report', 'rvm'));

create table if not exists public.vm_library (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  name           text not null,
  script         text not null default '',
  audio_path     text,
  seconds        integer,
  variant_group  text not null default 'default',
  audience       text not null default 'seller',
  active         boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists vm_library_workspace on public.vm_library (workspace_id, active, name);

create table if not exists public.rvm_drops (
  id               bigint generated always as identity primary key,
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  seller_id        bigint references public.sellers(id) on delete cascade,
  buyer_id         bigint references public.buyers(id) on delete cascade,
  phone_e164       text,
  library_id       bigint references public.vm_library(id) on delete set null,
  script           text,
  variant_group    text not null default 'default',
  status           text not null default 'queued',
  skip_reason      text,
  last_error       text,
  scheduled_at     timestamptz not null default now(),
  sent_at          timestamptz,
  enrollment_id    bigint references public.enrollments(id) on delete set null,
  plan_step_id     bigint,
  provider_call_id text,
  webhook_token    text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint rvm_drops_one_person check ((seller_id is null) <> (buyer_id is null)),
  constraint rvm_drops_status check (status in ('queued', 'sending', 'ready', 'dialing', 'dropped', 'skipped', 'answered', 'failed'))
);
create index if not exists rvm_drops_due on public.rvm_drops (status, scheduled_at);
create index if not exists rvm_drops_person on public.rvm_drops (workspace_id, seller_id, buyer_id);

alter table public.vm_library enable row level security;
alter table public.rvm_drops enable row level security;

drop policy if exists vm_library_rw on public.vm_library;
create policy vm_library_rw on public.vm_library for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists rvm_drops_rw on public.rvm_drops;
create policy rvm_drops_rw on public.rvm_drops for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.vm_library to authenticated;
grant select, insert, update, delete on public.rvm_drops to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('vm-library', 'vm-library', false, 8388608, array['audio/webm','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/x-m4a'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists vm_library_audio on storage.objects';
    execute $p$create policy vm_library_audio on storage.objects for all to authenticated
      using (bucket_id = 'vm-library' and public.is_workspace_member(split_part(name, '/', 1)::bigint))
      with check (bucket_id = 'vm-library' and public.is_workspace_member(split_part(name, '/', 1)::bigint))$p$;
  end if;
end $$;

create or replace function public.telnyx_vault_setting(p_name text)
returns text
language sql
stable
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = p_name
    and p_name in ('telnyx_api_key', 'telnyx_public_key', 'telnyx_messaging_profile_id', 'telnyx_connection_id')
  limit 1
$$;
revoke all on function public.telnyx_vault_setting(text) from public, anon, authenticated;
grant execute on function public.telnyx_vault_setting(text) to service_role;

-- plan_enroll as in 39, plus an rvm_drops row for an RVM step.
create or replace function public.plan_enroll(p_workspace bigint, p_plan bigint, p_seller bigint, p_actor uuid)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_enr bigint;
  v_seller record;
  v_prop record;
  v_first text;
  v_fields jsonb;
  v_offset integer := 0;
  st record;
  v_title text;
  v_type text;
  v_assignee uuid;
  v_phone text;
  v_lib bigint;
begin
  if exists (select 1 from enrollments where plan_id = p_plan and seller_id = p_seller and status = 'active') then
    return null;
  end if;
  select * into v_seller from sellers where id = p_seller and workspace_id = p_workspace;
  if not found then return null; end if;
  if not exists (select 1 from action_plans where id = p_plan and workspace_id = p_workspace) then return null; end if;

  select line1, city, state, zip into v_prop from properties where id = v_seller.property_id;
  v_first := split_part(btrim(coalesce(v_seller.name, '')), ' ', 1);
  v_fields := jsonb_build_object(
    'first_name', v_first,
    'name', coalesce(v_seller.name, ''),
    'contact_name', coalesce(v_seller.name, ''),
    'address', coalesce(v_prop.line1, v_seller.property_address, ''),
    'city', coalesce(v_prop.city, ''),
    'state', coalesce(v_prop.state, ''),
    'zip', coalesce(v_prop.zip, ''),
    'postal_code', coalesce(v_prop.zip, '')
  );
  v_phone := nullif(regexp_replace(coalesce(v_seller.phone, ''), '\D', '', 'g'), '');
  if v_phone is not null and length(v_phone) = 10 then v_phone := '1' || v_phone; end if;
  if v_phone is not null and length(v_phone) = 11 and left(v_phone, 1) = '1' then v_phone := '+' || v_phone; else v_phone := null; end if;

  insert into enrollments (workspace_id, plan_id, seller_id, created_by)
  values (p_workspace, p_plan, p_seller, p_actor)
  returning id into v_enr;

  for st in select * from action_plan_steps where plan_id = p_plan order by position loop
    v_offset := v_offset + coalesce(st.delay_minutes, 0);
    if st.channel = 'wait' then continue; end if;

    v_type := case st.channel
      when 'sms' then 'text' when 'call' then 'call' when 'email' then 'email'
      when 'compr_report' then 'compr_report' when 'rvm' then 'rvm' else 'todo' end;
    v_title := case st.channel
      when 'sms'    then 'Text ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'call'   then 'Call ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'email'  then 'Email ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'stage'  then 'Move ' || v_first || ' to ' || coalesce(st.config->>'stage', 'stage')
      when 'tag'    then 'Tag ' || v_first || ' "' || coalesce(st.config->>'tag', '') || '"'
      when 'assign' then 'Reassign ' || v_first
      when 'compr_report' then 'Send underwriting ' || case when st.config->>'audience' = 'buyer' then 'buyer' else 'seller' end || ' report' || case when st.config->>'audience' = 'buyer' then ' for ' || v_first else ' to ' || v_first end
      when 'rvm'    then 'RVM ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      else coalesce(nullif(st.title, ''), 'Follow up with ' || v_first)
    end;

    v_assignee := null;
    begin
      v_assignee := nullif(st.config->>'assignee', '')::uuid;
    exception when others then v_assignee := null;
    end;

    insert into tasks (workspace_id, seller_id, title, task_type, priority, due_at, assigned_to, notes, enrollment_id, plan_step_id, created_by)
    values (
      p_workspace, p_seller, v_title, v_type,
      coalesce(nullif(st.config->>'priority', ''), 'normal'),
      now() + make_interval(mins => v_offset),
      coalesce(v_assignee, v_seller.assigned_to, p_actor),
      plan_render_merge(st.body, v_fields),
      v_enr, st.id, p_actor
    )
    on conflict (enrollment_id, plan_step_id) do nothing;

    if st.channel = 'rvm' then
      v_lib := null;
      begin
        v_lib := nullif(st.config->>'library_id', '')::bigint;
      exception when others then v_lib := null;
      end;
      insert into rvm_drops (workspace_id, seller_id, phone_e164, library_id, script, variant_group, scheduled_at, enrollment_id, plan_step_id, created_by)
      values (
        p_workspace, p_seller, v_phone, v_lib,
        plan_render_merge(st.body, v_fields),
        coalesce(nullif(st.config->>'variant_group', ''), 'default'),
        now() + make_interval(mins => v_offset),
        v_enr, st.id, p_actor
      );
    end if;
  end loop;

  return v_enr;
end;
$$;

create or replace function public.rvm_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.rvm_drops where status = 'queued' and scheduled_at <= now()) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/rvm-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 8000);
end $$;
revoke execute on function public.rvm_kick() from public, anon, authenticated;

select cron.unschedule('clozr-rvm-tick') where exists (select 1 from cron.job where jobname = 'clozr-rvm-tick');
select cron.schedule('clozr-rvm-tick', '* * * * *', 'select public.rvm_kick()');
