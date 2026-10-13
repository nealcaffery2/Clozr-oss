-- 62 · Resend as the dispo blast pipe.
--
-- Campaigns used to require a connected Gmail account. Blasts now go through
-- Resend on a sending subdomain (deals.example.com) so they do not
-- share reputation with 1:1 Gmail or the company root. Suppressions, the
-- sending window, the daily ramp and one-click unsubscribe still apply.
-- Bounces and complaints arrive on /deliverability/resend (Svix).

create table if not exists public.email_senders (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  provider           text not null default 'resend' check (provider in ('resend')),
  from_email         text not null check (from_email = lower(from_email) and from_email like '%@%'),
  from_name          text,
  domain             text not null,
  active             boolean not null default true,
  daily_cap          integer  not null default 200 check (daily_cap between 1 and 2000),
  hourly_cap         integer  not null default 40  check (hourly_cap between 1 and 500),
  min_gap_seconds    integer  not null default 20  check (min_gap_seconds between 0 and 3600),
  window_start       smallint not null default 8   check (window_start between 0 and 23),
  window_end         smallint not null default 18  check (window_end between 1 and 24),
  window_days        smallint[] not null default '{1,2,3,4,5}',
  timezone           text     not null default 'America/Chicago',
  ramp_enabled       boolean  not null default true,
  ramp_start         integer  not null default 30  check (ramp_start between 1 and 2000),
  ramp_increase_pct  numeric(5,2) not null default 20 check (ramp_increase_pct between 0 and 100),
  ramp_target        integer  not null default 200 check (ramp_target between 1 and 2000),
  ramp_started_on    date     not null default current_date,
  paused             boolean  not null default false,
  paused_reason      text,
  paused_at          timestamptz,
  paused_auto        boolean  not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, provider),
  check (window_end > window_start),
  check (window_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(window_days) > 0)
);
create index if not exists email_senders_ws_idx on public.email_senders (workspace_id);

alter table public.email_senders enable row level security;
revoke all on public.email_senders from anon, authenticated;
grant select on public.email_senders to authenticated;
drop policy if exists email_senders_select on public.email_senders;
create policy email_senders_select on public.email_senders for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop trigger if exists email_senders_touch on public.email_senders;
create trigger email_senders_touch before update on public.email_senders
  for each row execute function public.touch_updated_at();

alter table public.dispo_campaigns
  add column if not exists email_provider text not null default 'gmail'
    check (email_provider in ('resend', 'gmail')),
  add column if not exists email_sender_id bigint references public.email_senders(id) on delete set null;

alter table public.email_send_log
  alter column account_id drop not null,
  add column if not exists sender_id bigint references public.email_senders(id) on delete set null,
  add column if not exists provider_id text;
create index if not exists email_send_log_provider_idx on public.email_send_log (provider_id) where provider_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_send_log_who'
  ) then
    alter table public.email_send_log
      add constraint email_send_log_who check (account_id is not null or sender_id is not null);
  end if;
end $$;

create index if not exists email_send_log_sender_idx on public.email_send_log (sender_id, sent_at desc);

drop function if exists public.email_send_claim(bigint, bigint, text[], text, timestamptz, integer, integer, integer);
create or replace function public.email_send_claim(
  p_workspace bigint, p_account bigint, p_recipients text[], p_kind text,
  p_day_start timestamptz, p_daily integer, p_hourly integer, p_gap_seconds integer,
  p_sender bigint default null
) returns jsonb language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_n      integer := coalesce(cardinality(p_recipients), 0);
  v_today  integer;
  v_hour   integer;
  v_oldest timestamptz;
  v_last   timestamptz;
  v_ok     boolean;
  v_ids    bigint[];
  v_lock   bigint := coalesce(p_sender, p_account);
begin
  if v_lock is null then
    raise exception 'account or sender is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(420042, (v_lock % 2147483647)::integer);
  if p_sender is not null then
    select count(*) filter (where sent_at >= p_day_start),
           count(*) filter (where sent_at >= now() - interval '1 hour'),
           min(sent_at) filter (where sent_at >= now() - interval '1 hour'),
           max(sent_at)
      into v_today, v_hour, v_oldest, v_last
      from public.email_send_log
     where sender_id = p_sender and sent_at >= least(p_day_start, now() - interval '1 hour');
  else
    select count(*) filter (where sent_at >= p_day_start),
           count(*) filter (where sent_at >= now() - interval '1 hour'),
           min(sent_at) filter (where sent_at >= now() - interval '1 hour'),
           max(sent_at)
      into v_today, v_hour, v_oldest, v_last
      from public.email_send_log
     where account_id = p_account and sent_at >= least(p_day_start, now() - interval '1 hour');
  end if;
  v_ok := p_kind = 'transactional' or (
    v_today + v_n <= p_daily
    and v_hour + v_n <= p_hourly
    and (p_gap_seconds = 0 or v_last is null or v_last <= now() - make_interval(secs => p_gap_seconds)));
  if v_ok and v_n > 0 then
    with ins as (
      insert into public.email_send_log (workspace_id, account_id, sender_id, recipient, kind)
      select p_workspace, p_account, p_sender, lower(trim(r)), p_kind from unnest(p_recipients) r
      returning id)
    select array_agg(id) into v_ids from ins;
  end if;
  return jsonb_build_object('ok', v_ok, 'today', v_today, 'last_hour', v_hour, 'hour_oldest', v_oldest,
                            'last_sent_at', v_last, 'ids', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;
revoke execute on function public.email_send_claim(bigint, bigint, text[], text, timestamptz, integer, integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.email_send_claim(bigint, bigint, text[], text, timestamptz, integer, integer, integer, bigint) to service_role;

create or replace function public.dispo_campaign_launch(
  p_workspace_id bigint, p_deal_id bigint, p_settings jsonb, p_delivery jsonb, p_recipients jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_campaign bigint; v_account bigint := nullif(p_delivery->>'email_account_id', '')::bigint;
  v_provider text := coalesce(nullif(p_delivery->>'email_provider', ''), 'gmail');
  v_sender bigint := nullif(p_delivery->>'email_sender_id', '')::bigint;
  r jsonb; m jsonb; b record; v_rec bigint; v_channel text; v_kind text; v_send timestamptz; v_n int := 0; v_msgs int := 0;
  v_media text[];
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin', 'dispositions') then
    raise exception 'only owners, admins and dispositions can launch campaigns' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals where id = p_deal_id and workspace_id = p_workspace_id) then
    raise exception 'deal not found' using errcode = '22023';
  end if;
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 or jsonb_array_length(p_recipients) > 2000 then
    raise exception 'recipients must be 1 to 2000 buyers' using errcode = '22023';
  end if;
  if v_provider not in ('resend', 'gmail') then
    raise exception 'email_provider must be resend or gmail' using errcode = '22023';
  end if;
  if v_account is not null and not exists (
    select 1 from public.google_accounts a where a.id = v_account and a.workspace_id = p_workspace_id
       and a.status = 'active' and a.gmail_send
       and (a.user_id = auth.uid() or public.has_role(p_workspace_id, 'owner', 'admin'))
  ) then
    raise exception 'that Gmail account cannot send for you' using errcode = '42501';
  end if;
  if v_provider = 'resend' then
    if v_sender is null then
      select id into v_sender from public.email_senders
       where workspace_id = p_workspace_id and provider = 'resend' and active
       order by id limit 1;
    elsif not exists (
      select 1 from public.email_senders s
       where s.id = v_sender and s.workspace_id = p_workspace_id and s.provider = 'resend' and s.active
    ) then
      raise exception 'that Resend sender is not available' using errcode = '22023';
    end if;
  end if;

  insert into public.dispo_campaigns (workspace_id, deal_id, created_by, settings, timezone, from_phone_number_id, from_phone, email_account_id, email_provider, email_sender_id, from_name, starts_at)
  values (p_workspace_id, p_deal_id, auth.uid(), coalesce(p_settings, '{}'::jsonb),
          coalesce(nullif(p_delivery->>'timezone', ''), 'America/Chicago'),
          nullif(p_delivery->>'from_phone_number_id', ''), nullif(p_delivery->>'from_phone', ''), v_account,
          v_provider, v_sender,
          left(nullif(regexp_replace(coalesce(p_delivery->>'from_name', ''), '[\r\n<>"]', '', 'g'), ''), 80),
          greatest(now(), coalesce((p_delivery->>'starts_at')::timestamptz, now())))
  returning id into v_campaign;

  for r in select * from jsonb_array_elements(p_recipients) loop
    select id, phone, email, preferred_channel, wants_follow_ups, blacklisted_at, status into b
      from public.buyers where id = (r->>'buyer_id')::bigint and workspace_id = p_workspace_id;
    continue when b.id is null or b.blacklisted_at is not null or lower(coalesce(b.status, '')) = 'inactive';
    insert into public.dispo_campaign_recipients (workspace_id, campaign_id, deal_id, buyer_id, phone, email, level, probability)
    values (p_workspace_id, v_campaign, p_deal_id, b.id, nullif(b.phone, ''), nullif(lower(b.email), ''),
            nullif(r->>'level', '')::smallint, nullif(r->>'probability', '')::smallint)
    on conflict (campaign_id, buyer_id) do nothing
    returning id into v_rec;
    continue when v_rec is null;
    v_n := v_n + 1;
    for m in select * from jsonb_array_elements(coalesce(r->'messages', '[]'::jsonb)) loop
      v_channel := m->>'channel'; v_kind := m->>'kind';
      continue when v_channel not in ('sms', 'email') or v_kind not in ('intro', 'brief', 'followup');
      continue when v_channel = 'sms' and (nullif(b.phone, '') is null or b.preferred_channel = 'email_only' or length(coalesce(m->>'body', '')) > 1600);
      continue when v_channel = 'email' and (
        nullif(b.email, '') is null
        or b.preferred_channel = 'sms_only'
        or (v_provider = 'gmail' and v_account is null)
        or (v_provider = 'resend' and v_sender is null)
        or nullif(trim(coalesce(m->>'subject', '')), '') is null
      );
      continue when v_kind = 'followup' and not coalesce(b.wants_follow_ups, true);
      continue when nullif(trim(coalesce(m->>'body', '')), '') is null;
      v_send := least(greatest(coalesce((m->>'send_at')::timestamptz, now()), now()), now() + interval '30 days');
      select coalesce(array_agg(u), '{}') into v_media
        from (select jsonb_array_elements_text(coalesce(m->'media_urls', '[]'::jsonb)) u limit 5) x where u ~ '^https://';
      insert into public.dispo_campaign_messages (workspace_id, campaign_id, recipient_id, buyer_id, channel, kind, seq, subject, body, body_html, media_urls, send_at, only_if_no_reply)
      values (p_workspace_id, v_campaign, v_rec, b.id, v_channel, v_kind, coalesce((m->>'seq')::smallint, 0),
              case when v_channel = 'email' then left(regexp_replace(m->>'subject', '[\r\n]+', ' ', 'g'), 300) end,
              left(m->>'body', 20000), case when v_channel = 'email' then left(m->>'body_html', 400000) end,
              case when v_channel = 'sms' then v_media else '{}' end, v_send, coalesce((m->>'only_if_no_reply')::boolean, v_kind = 'followup'));
      v_msgs := v_msgs + 1;
    end loop;
  end loop;

  if v_msgs = 0 then
    raise exception 'nothing to send: every buyer was skipped (blacklisted, inactive, no phone or email for the channel, or channel preference)' using errcode = '22023';
  end if;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
  values (p_workspace_id, 'deal', p_deal_id, 'campaign', 'Campaign launched · ' || v_n || ' buyers', v_msgs || ' messages queued', auth.uid());
  return v_campaign;
end $$;
revoke execute on function public.dispo_campaign_launch(bigint, bigint, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.dispo_campaign_launch(bigint, bigint, jsonb, jsonb, jsonb) to authenticated;
