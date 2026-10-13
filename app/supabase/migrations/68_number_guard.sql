-- 68: the number guard — every business day, every line's reputation, 10DLC
-- standing and STIR/SHAKEN attestation are read from Talkr, the protective
-- settings are enforced, and anything that got worse is put in front of the
-- admins as a notification. Nobody has to remember to open Settings.
--
-- What it enforces (workspaces.settings->'number_guard', defaults in
-- supabase/functions/number-guard): pause_on_warning on every line, a daily
-- call and text cap per line, and "block" for texting from a line that is not
-- on an approved 10DLC campaign. What it cannot do from here: file the brand,
-- campaign or LOA with Telnyx, or ask the analytics networks to re-evaluate a
-- flagged number — those calls need the carrier credential, which lives in
-- Talkr, so the guard names them in its digest with the link to do them.

create table if not exists public.number_health (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  talkr_number_id text not null,
  phone_e164 text not null,
  label text,
  grade text,                       -- good | watch | at_risk
  paused boolean not null default false,
  spam_risk text,                   -- low | medium | high | null (not enrolled / no data)
  spam_category text,
  attestation_a_7d numeric,         -- share of signed calls that got Attestation A, 0..1
  attestation_calls_7d integer,
  ten_dlc_assigned boolean,
  ten_dlc_status text,
  campaign_approved boolean,
  sms_failure_rate_7d numeric,
  warnings jsonb not null default '[]'::jsonb,
  checked_at timestamptz,
  snapshot jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, talkr_number_id)
);
alter table public.number_health enable row level security;
drop policy if exists number_health_read on public.number_health;
create policy number_health_read on public.number_health for select
  using (exists (select 1 from public.workspace_members m where m.workspace_id = number_health.workspace_id and m.user_id = auth.uid()));

create table if not exists public.number_guard_runs (
  id bigserial primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  numbers integer not null default 0,
  issues integer not null default 0,
  enforced integer not null default 0,
  summary jsonb,
  error text
);
create index if not exists number_guard_runs_ws_idx on public.number_guard_runs (workspace_id, ran_at desc);
alter table public.number_guard_runs enable row level security;
drop policy if exists number_guard_runs_read on public.number_guard_runs;
create policy number_guard_runs_read on public.number_guard_runs for select
  using (exists (select 1 from public.workspace_members m where m.workspace_id = number_guard_runs.workspace_id and m.user_id = auth.uid()));

create or replace function public.number_guard_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/number-guard',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.number_guard_kick() from public, anon, authenticated;

-- 13:07 UTC, business days: 8:07 in Central time before the phones get busy.
select cron.unschedule('clozr-number-guard') where exists (select 1 from cron.job where jobname = 'clozr-number-guard');
select cron.schedule('clozr-number-guard', '7 13 * * 1-5', 'select public.number_guard_kick()');
