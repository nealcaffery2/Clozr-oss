-- 42 — Email deliverability: domains, mailbox protection, the send log,
-- suppressions, and the warm-up provider key.
--
-- Email leaves CLOZR from each rep's own Google account. Reputation is what
-- decides whether it reaches the inbox, so this migration gives the server
-- what it needs to protect it on every send:
--
--   email_domains          each sending domain and its last DNS check (SPF,
--                          DKIM, DMARC, blocklists): score, launch-blocking
--                          failures, the full report
--   mailbox_settings       per connected mailbox: caps, spacing, window,
--                          warm-up ramp, paused + why. One row per
--                          google_accounts row, created on first use
--   email_send_log         one row per recipient per send, per mailbox — what
--                          the caps count and what bounces are matched to
--   email_suppressions     addresses CLOZR will not email: hard bounces,
--                          unsubscribes, manual. Checked before every send
--   deliverability_secrets the warm-up provider API key. Service role only
--
-- Every table is readable by workspace members and writable by nobody but the
-- service role: changes go through the `deliverability` edge function, which
-- checks the caller's role (owner/admin for caps and domains). A rep raising
-- their own daily cap is exactly the thing this exists to stop.
--
-- email_send_claim() is the one place a send is counted: it locks the
-- mailbox, counts, and inserts the log rows in one transaction, so two tabs
-- sending at once cannot both slip under the cap.

-- ------------------------------------------------------------------ domains
create table if not exists public.email_domains (
  id               bigint generated always as identity primary key,
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  domain           text   not null check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  source           text   not null default 'manual' check (source in ('google','manual')),
  dkim_selectors   text[] not null default '{}',
  tracking_domain  text,
  uses_resend      boolean not null default false,
  score            smallint check (score between 0 and 100),
  blocking         text[] not null default '{}',
  report           jsonb,
  checked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, domain)
);

-- ---------------------------------------------------------------- mailboxes
create table if not exists public.mailbox_settings (
  account_id         bigint primary key references public.google_accounts(id) on delete cascade,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  -- Google Workspace allows 2,000 a day; a consumer Gmail 500. Far below
  -- either is where reputation is kept.
  daily_cap          integer  not null default 150 check (daily_cap between 1 and 2000),
  hourly_cap         integer  not null default 30  check (hourly_cap between 1 and 500),
  min_gap_seconds    integer  not null default 60  check (min_gap_seconds between 0 and 3600),
  window_start       smallint not null default 8   check (window_start between 0 and 23),
  window_end         smallint not null default 18  check (window_end between 1 and 24),
  window_days        smallint[] not null default '{1,2,3,4,5}',
  timezone           text     not null default 'America/Chicago',
  ramp_enabled       boolean  not null default true,
  ramp_start         integer  not null default 20  check (ramp_start between 1 and 2000),
  ramp_increase_pct  numeric(5,2) not null default 20 check (ramp_increase_pct between 0 and 100),
  ramp_target        integer  not null default 150 check (ramp_target between 1 and 2000),
  ramp_started_on    date     not null default current_date,
  paused             boolean  not null default false,
  paused_reason      text,
  paused_at          timestamptz,
  paused_auto        boolean  not null default false,
  updated_at         timestamptz not null default now(),
  check (window_end > window_start),
  check (window_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(window_days) > 0)
);
create index if not exists mailbox_settings_ws_idx on public.mailbox_settings (workspace_id);

-- ----------------------------------------------------------------- send log
create table if not exists public.email_send_log (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  account_id     bigint not null references public.google_accounts(id) on delete cascade,
  recipient      text   not null,
  kind           text   not null check (kind in ('one_to_one','bulk','transactional')),
  sent_at        timestamptz not null default now(),
  bounced_at     timestamptz,
  bounce_status  text
);
create index if not exists email_send_log_account_idx on public.email_send_log (account_id, sent_at desc);
create index if not exists email_send_log_recipient_idx on public.email_send_log (account_id, recipient, sent_at desc);
create index if not exists email_send_log_ws_idx on public.email_send_log (workspace_id);

-- ------------------------------------------------------------- suppressions
create table if not exists public.email_suppressions (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  email        text   not null check (email = lower(email) and email like '%@%'),
  reason       text   not null check (reason in ('hard_bounce','unsubscribe','complaint','manual')),
  note         text,
  account_id   bigint references public.google_accounts(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, email)
);
create index if not exists email_suppressions_account_idx on public.email_suppressions (account_id);
create index if not exists email_suppressions_created_by_idx on public.email_suppressions (created_by);

-- ------------------------------------------------------------------ secrets
create table if not exists public.deliverability_secrets (
  workspace_id  bigint primary key references public.workspaces(id) on delete cascade,
  mailreach_key text,                       -- sealed (AES-GCM) by the edge function
  updated_at    timestamptz not null default now()
);

-- --------------------------------------------------------------- access
alter table public.email_domains          enable row level security;
alter table public.mailbox_settings       enable row level security;
alter table public.email_send_log         enable row level security;
alter table public.email_suppressions     enable row level security;
alter table public.deliverability_secrets enable row level security;
revoke all on public.email_domains, public.mailbox_settings, public.email_send_log,
              public.email_suppressions, public.deliverability_secrets from anon, authenticated;
grant select on public.email_domains, public.mailbox_settings, public.email_send_log, public.email_suppressions to authenticated;

drop policy if exists email_domains_select on public.email_domains;
create policy email_domains_select on public.email_domains for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists mailbox_settings_select on public.mailbox_settings;
create policy mailbox_settings_select on public.mailbox_settings for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists email_send_log_select on public.email_send_log;
create policy email_send_log_select on public.email_send_log for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists email_suppressions_select on public.email_suppressions;
create policy email_suppressions_select on public.email_suppressions for select to authenticated using (public.is_workspace_member(workspace_id));
-- deliverability_secrets: RLS on, no policy, no grant — service role only.

drop trigger if exists email_domains_touch on public.email_domains;
create trigger email_domains_touch before update on public.email_domains for each row execute function public.touch_updated_at();
drop trigger if exists mailbox_settings_touch on public.mailbox_settings;
create trigger mailbox_settings_touch before update on public.mailbox_settings for each row execute function public.touch_updated_at();
drop trigger if exists deliverability_secrets_touch on public.deliverability_secrets;
create trigger deliverability_secrets_touch before update on public.deliverability_secrets for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ the claim
-- Counts every kind (a signing link still uses the mailbox) but only refuses
-- one_to_one and bulk. The caller passes limits already computed from the
-- mailbox settings and the ramp (supabase/functions/_shared/deliverability-rules.ts).
create or replace function public.email_send_claim(
  p_workspace bigint, p_account bigint, p_recipients text[], p_kind text,
  p_day_start timestamptz, p_daily integer, p_hourly integer, p_gap_seconds integer
) returns jsonb language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_n      integer := coalesce(cardinality(p_recipients), 0);
  v_today  integer;
  v_hour   integer;
  v_oldest timestamptz;
  v_last   timestamptz;
  v_ok     boolean;
  v_ids    bigint[];
begin
  perform pg_advisory_xact_lock(420042, (p_account % 2147483647)::integer);
  select count(*) filter (where sent_at >= p_day_start),
         count(*) filter (where sent_at >= now() - interval '1 hour'),
         min(sent_at) filter (where sent_at >= now() - interval '1 hour'),
         max(sent_at)
    into v_today, v_hour, v_oldest, v_last
    from public.email_send_log
   where account_id = p_account and sent_at >= least(p_day_start, now() - interval '1 hour');
  v_ok := p_kind = 'transactional' or (
    v_today + v_n <= p_daily
    and v_hour + v_n <= p_hourly
    and (p_gap_seconds = 0 or v_last is null or v_last <= now() - make_interval(secs => p_gap_seconds)));
  if v_ok and v_n > 0 then
    with ins as (
      insert into public.email_send_log (workspace_id, account_id, recipient, kind)
      select p_workspace, p_account, lower(trim(r)), p_kind from unnest(p_recipients) r
      returning id)
    select array_agg(id) into v_ids from ins;
  end if;
  return jsonb_build_object('ok', v_ok, 'today', v_today, 'last_hour', v_hour, 'hour_oldest', v_oldest,
                            'last_sent_at', v_last, 'ids', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;
revoke execute on function public.email_send_claim(bigint, bigint, text[], text, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.email_send_claim(bigint, bigint, text[], text, timestamptz, integer, integer, integer) to service_role;
