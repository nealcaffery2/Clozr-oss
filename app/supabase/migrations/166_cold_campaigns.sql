-- 166 · Workspace cold-email pool and prospect campaigns.
--
-- Separate from per-rep Gmail (google_accounts) and Resend blast senders
-- (email_senders). A workspace owns domains and mailboxes. A campaign is an
-- audience of buyers plus a sequence, not a deal. The worker is
-- cold-campaign-tick, kicked every minute by cold_campaign_kick().
--
--   cold_domains            sending domains and the last DNS check
--   cold_mailboxes          pool mailboxes (google_oauth, microsoft_oauth, smtp)
--   cold_mailbox_secrets    sealed SMTP/IMAP passwords and OAuth tokens
--   cold_oauth_states       one-time OAuth state for connecting a pool mailbox
--   cold_campaigns          audience + schedule
--   cold_steps              sequence steps, with A/B variants in jsonb
--   cold_enrollments        one buyer in one campaign
--   cold_sends              one attempt, what the caps count
--   cold_replies            a polled reply and its classification
--   cold_workspace_settings blocked-domain extras, fallback zone, warmup config,
--                           Instantly warmup filter tag, rotation cursor
--
-- Mailbox defaults match the first pool: 20 sends a day, a linear ramp from
-- 5 over about 3 weeks, and a 4 to 11 minute gap. Primary-inbox policy
-- (plain text, link limits, spam lint, rest days, pause thresholds) lives
-- on cold_workspace_settings.deliverability. SMTP/IMAP app passwords
-- (InboxKit Google Workspace) are the first way in.
--   cold_warmup_secrets     sealed key for a future warmup vendor
--
-- Members read. Owners and admins write the configuration. Secrets and the
-- claim/kick functions are service role only. The worker always blocks the
-- company's own primary domains (its built-in list); blocked_extra only adds
-- more.

-- ----------------------------------------------------------------- domains
create table if not exists public.cold_domains (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  domain         text   not null check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  daily_cap      integer not null default 500 check (daily_cap between 1 and 10000),
  tracking_domain text check (tracking_domain is null or tracking_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  dkim_selectors text[] not null default '{}',
  score          smallint check (score between 0 and 100),
  blocking       text[] not null default '{}',
  report         jsonb,
  checked_at     timestamptz,
  paused         boolean not null default false,
  paused_reason  text,
  paused_at      timestamptz,
  paused_auto    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, domain)
);
create index if not exists cold_domains_ws_idx on public.cold_domains (workspace_id);

-- --------------------------------------------------------------- mailboxes
create table if not exists public.cold_mailboxes (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  domain_id          bigint not null references public.cold_domains(id) on delete cascade,
  email              text   not null check (email = lower(email) and position('@' in email) > 1),
  display_name       text,
  signature          text,
  provider           text   not null check (provider in ('google_oauth', 'microsoft_oauth', 'smtp')),
  status             text   not null default 'pending' check (status in ('pending', 'warming', 'active', 'paused', 'error', 'disconnected')),
  daily_cap          integer not null default 20 check (daily_cap between 1 and 2000),
  hourly_cap         integer not null default 6 check (hourly_cap between 1 and 500),
  min_gap_seconds    integer not null default 240 check (min_gap_seconds between 0 and 3600),
  -- Null uses the workspace warmup_daily (default 20). Cold plus this stays at the combined ceiling (default 40).
  warmup_daily       integer check (warmup_daily is null or warmup_daily between 0 and 80),
  timezone           text   not null default 'America/Chicago',
  ramp_enabled       boolean not null default true,
  ramp_start         integer not null default 5 check (ramp_start between 1 and 2000),
  ramp_increase_pct  numeric(5,2) not null default 20 check (ramp_increase_pct between 0 and 100),
  ramp_target        integer not null default 20 check (ramp_target between 1 and 2000),
  ramp_started_on    date    not null default current_date,
  paused             boolean not null default false,
  paused_reason      text,
  paused_at          timestamptz,
  paused_auto        boolean not null default false,
  smtp_host          text,
  smtp_port          integer,
  smtp_username      text,
  imap_host          text,
  imap_port          integer,
  imap_username      text,
  last_polled_at     timestamptz,
  last_error         text,
  connected_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, email)
);
create index if not exists cold_mailboxes_ws_idx on public.cold_mailboxes (workspace_id);
create index if not exists cold_mailboxes_domain_idx on public.cold_mailboxes (domain_id);

-- ------------------------------------------------------------------ secrets
create table if not exists public.cold_mailbox_secrets (
  mailbox_id        bigint primary key references public.cold_mailboxes(id) on delete cascade,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  smtp_password     text,
  imap_password     text,
  refresh_token     text,
  access_token      text,
  access_expires_at timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists public.cold_oauth_states (
  state        text primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null,
  provider     text not null check (provider in ('google_oauth', 'microsoft_oauth')),
  origin       text,
  created_at   timestamptz not null default now()
);

create table if not exists public.cold_warmup_secrets (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  api_key      text,
  updated_at   timestamptz not null default now()
);

-- -------------------------------------------------------------- campaigns
create table if not exists public.cold_campaigns (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces(id) on delete cascade,
  name                text   not null check (length(btrim(name)) between 1 and 120),
  status              text   not null default 'draft' check (status in ('draft', 'active', 'paused', 'done')),
  audience_kind       text   not null check (audience_kind in ('tag', 'saved_view')),
  audience_tag        text,
  saved_view_id       bigint references public.saved_views(id) on delete set null,
  window_start        smallint not null default 9 check (window_start between 0 and 23),
  window_end          smallint not null default 17 check (window_end between 1 and 24),
  window_days         smallint[] not null default '{1,2,3,4,5}',
  fallback_timezone   text   not null default 'America/Chicago',
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (window_end > window_start),
  check (window_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(window_days) > 0),
  check (audience_kind <> 'tag' or length(btrim(coalesce(audience_tag, ''))) > 0)
);
create index if not exists cold_campaigns_ws_idx on public.cold_campaigns (workspace_id);

create table if not exists public.cold_steps (
  id                   bigint generated always as identity primary key,
  workspace_id         bigint not null references public.workspaces(id) on delete cascade,
  campaign_id          bigint not null references public.cold_campaigns(id) on delete cascade,
  position             integer not null check (position between 1 and 20),
  delay_business_days  integer not null default 0 check (delay_business_days between 0 and 60),
  subject              text not null,
  body                 text not null,
  variants             jsonb not null default '[]'::jsonb,
  unique (campaign_id, position)
);
create index if not exists cold_steps_campaign_idx on public.cold_steps (campaign_id);

create table if not exists public.cold_enrollments (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  campaign_id        bigint not null references public.cold_campaigns(id) on delete cascade,
  buyer_id           bigint references public.buyers(id) on delete set null,
  email              text not null check (email = lower(email) and position('@' in email) > 1),
  state              text,
  status             text not null default 'active' check (status in ('active', 'replied', 'bounced', 'unsubscribed', 'suppressed', 'completed', 'stopped')),
  stop_reason        text,
  step_position      integer not null default 1,
  next_send_at       timestamptz not null default now(),
  last_sent_at       timestamptz,
  thread_message_id  text,
  provider_thread_id text,
  -- The mailbox that sent step 1. Follow-ups stay on it. One sender per recipient.
  mailbox_id         bigint references public.cold_mailboxes(id) on delete set null,
  ooo_until          timestamptz,
  enrolled_at        timestamptz not null default now(),
  stopped_at         timestamptz,
  unique (campaign_id, email)
);
create index if not exists cold_enrollments_due_idx on public.cold_enrollments (next_send_at) where status = 'active';
create index if not exists cold_enrollments_buyer_idx on public.cold_enrollments (buyer_id);
-- One active sequence per address, across every campaign and mailbox in the workspace.
create unique index if not exists cold_enrollments_one_active_email
  on public.cold_enrollments (workspace_id, email)
  where status = 'active';

create table if not exists public.cold_sends (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces(id) on delete cascade,
  campaign_id         bigint not null references public.cold_campaigns(id) on delete cascade,
  enrollment_id       bigint not null references public.cold_enrollments(id) on delete cascade,
  step_position       integer not null,
  mailbox_id          bigint not null references public.cold_mailboxes(id) on delete cascade,
  to_email            text not null,
  from_email          text not null,
  subject             text,
  variant_key         text,
  body_hash           text,
  recipient_provider  text check (recipient_provider is null or recipient_provider in ('gmail', 'google_workspace', 'outlook', 'other')),
  rfc_message_id      text,
  provider_message_id text,
  in_reply_to         text,
  status              text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'bounced', 'replied')),
  error               text,
  sent_at             timestamptz not null default now(),
  bounced_at          timestamptz,
  replied_at          timestamptz,
  complained_at       timestamptz
);
create index if not exists cold_sends_mailbox_idx on public.cold_sends (mailbox_id, sent_at desc);
create index if not exists cold_sends_enrollment_idx on public.cold_sends (enrollment_id, sent_at desc);
create index if not exists cold_sends_rfc_idx on public.cold_sends (workspace_id, rfc_message_id) where rfc_message_id is not null;

create table if not exists public.cold_replies (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces(id) on delete cascade,
  mailbox_id          bigint not null references public.cold_mailboxes(id) on delete cascade,
  enrollment_id       bigint references public.cold_enrollments(id) on delete set null,
  send_id             bigint references public.cold_sends(id) on delete set null,
  buyer_id            bigint references public.buyers(id) on delete set null,
  provider_message_id text not null,
  from_email          text,
  subject             text,
  snippet             text,
  classification      text not null check (classification in ('interested', 'not_interested', 'out_of_office', 'unsubscribe', 'bounce', 'other')),
  complaint           boolean not null default false,
  -- Buyer's assigned_to, else the buyer owner, else the workspace owner. The inbox row uses the same person.
  assigned_to         uuid,
  communication_id    bigint references public.communications(id) on delete set null,
  received_at         timestamptz not null default now(),
  unique (mailbox_id, provider_message_id)
);
create index if not exists cold_replies_ws_idx on public.cold_replies (workspace_id, received_at desc);

create table if not exists public.cold_workspace_settings (
  workspace_id      bigint primary key references public.workspaces(id) on delete cascade,
  blocked_extra     text[] not null default '{}',
  fallback_timezone text not null default 'America/Chicago',
  warmup_provider      text not null default 'stub',
  warmup_api_base      text,
  instantly_warmup_tag text check (instantly_warmup_tag is null or char_length(btrim(instantly_warmup_tag)) between 4 and 80),
  physical_address     text,
  deliverability       jsonb not null default '{
    "plain_text_first": true,
    "open_tracking": false,
    "click_tracking": false,
    "step1_links": "block",
    "max_links_after_step1": 1,
    "spam_lint_block": true,
    "spam_score_limit": 60,
    "gap_min_seconds": 240,
    "gap_max_seconds": 660,
    "daily_ceiling": 20,
    "jitter_pct": 15,
    "ramp_days": 21,
    "skip_weekends": true,
    "rest_days": true,
    "bounce_pause_rate": 0.02,
    "bounce_min_sample": 50,
    "any_complaint_pauses": true,
    "complaint_pause_rate": 0.001,
    "recipient_domain_daily_cap": 3,
    "warmup_daily": 20,
    "combined_daily_ceiling": 40,
    "low_reply_rate": 0.01,
    "low_reply_sample": 50,
    "primary_rate_floor": 0.8,
    "body_repeat_limit": 3,
    "body_repeat_window_minutes": 30,
    "provider_share": 0.6,
    "suppress_roles": true,
    "suppress_catch_all": true,
    "require_physical_address": true,
    "ooo_hold_business_days": 4
  }'::jsonb,
  rotation_cursor      integer not null default 0,
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------------- health
create or replace view public.cold_mailbox_health
with (security_invoker = true) as
select m.id as mailbox_id, m.workspace_id, m.domain_id, m.email, m.provider, m.status, m.paused,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and s.status <> 'failed') as sent_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and (s.status = 'bounced' or s.bounced_at is not null)) as bounced_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and (s.status = 'replied' or s.replied_at is not null)) as replied_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and s.complained_at is not null) as complaints_7d
  from public.cold_mailboxes m
  left join public.cold_sends s on s.mailbox_id = m.id
 group by m.id;

create or replace view public.cold_domain_health
with (security_invoker = true) as
select d.id as domain_id, d.workspace_id, d.domain, d.paused, d.score, d.checked_at,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and s.status <> 'failed') as sent_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and (s.status = 'bounced' or s.bounced_at is not null)) as bounced_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and (s.status = 'replied' or s.replied_at is not null)) as replied_7d,
       count(s.id) filter (where s.sent_at > now() - interval '7 days' and s.complained_at is not null) as complaints_7d
  from public.cold_domains d
  left join public.cold_mailboxes m on m.domain_id = d.id
  left join public.cold_sends s on s.mailbox_id = m.id
 group by d.id;

-- ------------------------------------------------------------------ access
alter table public.cold_domains enable row level security;
alter table public.cold_mailboxes enable row level security;
alter table public.cold_mailbox_secrets enable row level security;
alter table public.cold_oauth_states enable row level security;
alter table public.cold_warmup_secrets enable row level security;
alter table public.cold_campaigns enable row level security;
alter table public.cold_steps enable row level security;
alter table public.cold_enrollments enable row level security;
alter table public.cold_sends enable row level security;
alter table public.cold_replies enable row level security;
alter table public.cold_workspace_settings enable row level security;

revoke all on public.cold_domains, public.cold_mailboxes, public.cold_mailbox_secrets, public.cold_oauth_states,
  public.cold_warmup_secrets, public.cold_campaigns, public.cold_steps, public.cold_enrollments, public.cold_sends,
  public.cold_replies, public.cold_workspace_settings from anon, authenticated;

grant select on public.cold_domains, public.cold_mailboxes, public.cold_campaigns, public.cold_steps,
  public.cold_enrollments, public.cold_sends, public.cold_replies, public.cold_workspace_settings to authenticated;
grant select on public.cold_mailbox_health, public.cold_domain_health to authenticated;

drop policy if exists cold_domains_select on public.cold_domains;
create policy cold_domains_select on public.cold_domains for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_domains_write on public.cold_domains;
create policy cold_domains_write on public.cold_domains for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists cold_mailboxes_select on public.cold_mailboxes;
create policy cold_mailboxes_select on public.cold_mailboxes for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_mailboxes_write on public.cold_mailboxes;
create policy cold_mailboxes_write on public.cold_mailboxes for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists cold_campaigns_select on public.cold_campaigns;
create policy cold_campaigns_select on public.cold_campaigns for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_campaigns_write on public.cold_campaigns;
create policy cold_campaigns_write on public.cold_campaigns for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists cold_steps_select on public.cold_steps;
create policy cold_steps_select on public.cold_steps for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_steps_write on public.cold_steps;
create policy cold_steps_write on public.cold_steps for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists cold_enrollments_select on public.cold_enrollments;
create policy cold_enrollments_select on public.cold_enrollments for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_sends_select on public.cold_sends;
create policy cold_sends_select on public.cold_sends for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_replies_select on public.cold_replies;
create policy cold_replies_select on public.cold_replies for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists cold_workspace_settings_select on public.cold_workspace_settings;
create policy cold_workspace_settings_select on public.cold_workspace_settings for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists cold_workspace_settings_write on public.cold_workspace_settings;
create policy cold_workspace_settings_write on public.cold_workspace_settings for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));
-- secrets and oauth states: RLS on, no policy, no grant.

drop trigger if exists cold_domains_touch on public.cold_domains;
create trigger cold_domains_touch before update on public.cold_domains for each row execute function public.touch_updated_at();
drop trigger if exists cold_mailboxes_touch on public.cold_mailboxes;
create trigger cold_mailboxes_touch before update on public.cold_mailboxes for each row execute function public.touch_updated_at();
drop trigger if exists cold_campaigns_touch on public.cold_campaigns;
create trigger cold_campaigns_touch before update on public.cold_campaigns for each row execute function public.touch_updated_at();
drop trigger if exists cold_workspace_settings_touch on public.cold_workspace_settings;
create trigger cold_workspace_settings_touch before update on public.cold_workspace_settings for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------- claim
-- The earlier signature in this file is replaced in place. 166 is unapplied, so the drop is only for a re-run of this script.
drop function if exists public.cold_send_claim(bigint, bigint, bigint, bigint, bigint, integer, text, text, text, text, text, timestamptz, integer, integer, integer, integer, text, text);

create or replace function public.cold_send_claim(
  p_workspace bigint, p_mailbox bigint, p_domain bigint, p_campaign bigint, p_enrollment bigint,
  p_step integer, p_to text, p_from text, p_subject text, p_variant text, p_in_reply_to text,
  p_day_start timestamptz, p_mailbox_daily integer, p_mailbox_hourly integer, p_domain_daily integer, p_gap_seconds integer,
  p_body_hash text default null, p_recipient_provider text default null,
  p_recipient_domain_cap integer default null, p_recipient_day_start timestamptz default null
) returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today integer; v_hour integer; v_oldest timestamptz; v_last timestamptz; v_domain integer; v_id bigint;
  v_pinned bigint; v_recip_domain text; v_recip_today integer;
begin
  perform pg_advisory_xact_lock(420166, (p_mailbox % 2147483647)::integer);
  perform pg_advisory_xact_lock(420167, (p_domain % 2147483647)::integer);
  select mailbox_id into v_pinned
    from public.cold_enrollments
   where id = p_enrollment and workspace_id = p_workspace;
  if v_pinned is not null and v_pinned <> p_mailbox then
    return jsonb_build_object('ok', false, 'reason', 'pinned_sender');
  end if;
  if exists (
    select 1 from public.cold_enrollments
     where workspace_id = p_workspace and lower(email) = lower(p_to) and status = 'active' and id <> p_enrollment
  ) then
    return jsonb_build_object('ok', false, 'reason', 'active_sequence');
  end if;
  v_recip_domain := lower(split_part(p_to, '@', 2));
  v_recip_today := 0;
  -- Same free-inbox list as deliverability-rules.ts FREE_MAIL. Company domains only.
  if p_recipient_domain_cap is not null and p_recipient_day_start is not null
     and v_recip_domain <> ''
     and v_recip_domain not in (
       'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
       'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com'
     )
  then
    perform pg_advisory_xact_lock(420168, hashtext(v_recip_domain));
    select count(*) into v_recip_today
      from public.cold_sends
     where workspace_id = p_workspace
       and sent_at >= p_recipient_day_start
       and status <> 'failed'
       and lower(split_part(to_email, '@', 2)) = v_recip_domain;
    if v_recip_today + 1 > p_recipient_domain_cap then
      return jsonb_build_object('ok', false, 'reason', 'recipient_domain_cap', 'recipient_domain_today', v_recip_today);
    end if;
  end if;
  select count(*) filter (where sent_at >= p_day_start and status <> 'failed'),
         count(*) filter (where sent_at >= now() - interval '1 hour' and status <> 'failed'),
         min(sent_at) filter (where sent_at >= now() - interval '1 hour' and status <> 'failed'),
         max(sent_at) filter (where status <> 'failed')
    into v_today, v_hour, v_oldest, v_last
    from public.cold_sends
   where mailbox_id = p_mailbox and sent_at >= least(p_day_start, now() - interval '1 hour');
  select count(*) into v_domain
    from public.cold_sends s
    join public.cold_mailboxes m on m.id = s.mailbox_id
   where m.domain_id = p_domain and s.sent_at >= p_day_start and s.status <> 'failed';
  if v_today + 1 > p_mailbox_daily or v_hour + 1 > p_mailbox_hourly or v_domain + 1 > p_domain_daily
     or (p_gap_seconds > 0 and v_last is not null and v_last > now() - make_interval(secs => p_gap_seconds))
  then
    return jsonb_build_object('ok', false, 'today', v_today, 'last_hour', v_hour, 'hour_oldest', v_oldest,
      'last_sent_at', v_last, 'domain_today', v_domain, 'recipient_domain_today', v_recip_today);
  end if;
  insert into public.cold_sends (workspace_id, campaign_id, enrollment_id, step_position, mailbox_id, to_email, from_email, subject, variant_key, in_reply_to, body_hash, recipient_provider, status)
  values (p_workspace, p_campaign, p_enrollment, p_step, p_mailbox, lower(p_to), lower(p_from), p_subject, p_variant, p_in_reply_to, p_body_hash, p_recipient_provider, 'queued')
  returning id into v_id;
  update public.cold_enrollments
     set mailbox_id = p_mailbox
   where id = p_enrollment and mailbox_id is null;
  return jsonb_build_object('ok', true, 'id', v_id, 'today', v_today, 'last_hour', v_hour, 'domain_today', v_domain);
end $$;
revoke all on function public.cold_send_claim(bigint, bigint, bigint, bigint, bigint, integer, text, text, text, text, text, timestamptz, integer, integer, integer, integer, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.cold_send_claim(bigint, bigint, bigint, bigint, bigint, integer, text, text, text, text, text, timestamptz, integer, integer, integer, integer, text, text, integer, timestamptz) to service_role;

-- -------------------------------------------------------------------- kick
create or replace function public.cold_campaign_kick()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.cold_enrollments where status = 'active' and next_send_at <= now())
     and not exists (
       select 1 from public.cold_mailboxes
        where status in ('active', 'warming') and paused = false
          and (last_polled_at is null or last_polled_at < now() - interval '5 minutes')
     )
  then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/cold-campaign-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke all on function public.cold_campaign_kick() from public, anon, authenticated;

select cron.unschedule('clozr-cold-campaign-kick') where exists (select 1 from cron.job where jobname = 'clozr-cold-campaign-kick');
select cron.schedule('clozr-cold-campaign-kick', '* * * * *', 'select public.cold_campaign_kick()');
