-- 369: Cal.com bookings for Compr's onboarding call.
--
-- cal-webhook receives Cal.com's booking webhooks (created, rescheduled,
-- cancelled, no-show). Every person on the booking who is not the host
-- becomes or matches a buyer in the workspace, the meeting becomes (or
-- links to) an appointment on the host's calendar, and cal-tick sends the
-- confirmation, the 60 minute and the 5 minute reminder by email (Resend,
-- reply-to the organizer) and by text (Talkr, as the host). After the call,
-- a contact tagged compr-no-show, marked no-show in Cal.com, or with no
-- sign they showed two hours after the end, is enrolled in
-- "Compr · Missed demo".
--
-- Double bookings: Cal.com writes the event to the host's own Google
-- calendar, which CLOZR already pulls as a read-only feed. The appointment
-- row is a mirror of that event (google_calendar_id = the host's calendar,
-- never CLOZR's own), so CLOZR never writes a second copy, and the pull
-- adopts the row by iCalUID instead of inserting another.
--
-- Safe to re-run.

-- ---- appointments ----------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_source_check;
alter table public.appointments add constraint appointments_source_check check (source in ('clozr', 'google', 'calcom'));
alter table public.appointments add column if not exists ical_uid text;
create index if not exists appointments_ws_ical_uid_idx on public.appointments (workspace_id, ical_uid) where ical_uid is not null;

-- ---- bookings --------------------------------------------------------------------
create table if not exists public.cal_bookings (
  id               bigserial primary key,
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  uid              text not null,
  ical_uid         text,
  status           text not null default 'booked' check (status in ('booked', 'rescheduled', 'cancelled')),
  event_slug       text,
  title            text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  meeting_url      text,
  location         text,
  organizer_email  text,
  organizer_name   text,
  host_user_id     uuid references auth.users(id) on delete set null,
  appointment_id   bigint references public.appointments(id) on delete set null,
  -- [{ name, email, phone, time_zone, buyer_id, no_show }]
  attendees        jsonb not null default '[]'::jsonb check (jsonb_typeof(attendees) = 'array'),
  rescheduled_from text,
  cancel_reason    text,
  showed_at        timestamptz,
  no_show_at       timestamptz,
  no_show_source   text check (no_show_source in ('cal', 'tag', 'auto')),
  outcome_at       timestamptz,
  payload          jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, uid)
);
create index if not exists cal_bookings_open_idx on public.cal_bookings (starts_at) where status = 'booked' and outcome_at is null;

alter table public.cal_bookings enable row level security;
drop policy if exists cal_bookings_select on public.cal_bookings;
create policy cal_bookings_select on public.cal_bookings
  for select to authenticated using (workspace_id in (select public.my_workspace_ids()));

-- One row per reminder per person per channel: the claim that keeps a rerun
-- or two overlapping ticks from sending the same reminder twice.
create table if not exists public.cal_booking_sends (
  id           bigserial primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  booking_id   bigint not null references public.cal_bookings(id) on delete cascade,
  buyer_id     bigint not null,
  kind         text not null check (kind in ('confirm', 'h1', 'm5', 'check', 'missed')),
  channel      text not null check (channel in ('email', 'sms', 'task')),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason       text,
  provider_id  text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (booking_id, buyer_id, kind, channel)
);

alter table public.cal_booking_sends enable row level security;
drop policy if exists cal_booking_sends_select on public.cal_booking_sends;
create policy cal_booking_sends_select on public.cal_booking_sends
  for select to authenticated using (workspace_id in (select public.my_workspace_ids()));

-- ---- the tick --------------------------------------------------------------------
-- Every minute while a booking is upcoming or waiting on its outcome. Vault
-- key as in 284.
create or replace function public.cal_kick()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1 from public.cal_bookings b
     where b.status = 'booked' and b.outcome_at is null
       and b.starts_at <= now() + interval '65 minutes'
       and b.ends_at >= now() - interval '3 days'
  ) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/cal-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;

revoke all on function public.cal_kick() from public, anon, authenticated;

select cron.unschedule('clozr-cal-tick') where exists (select 1 from cron.job where jobname = 'clozr-cal-tick');
select cron.schedule('clozr-cal-tick', '* * * * *', 'select public.cal_kick()');

-- ---- the missed demo plan ----------------------------------------------------------
-- Enrolled by cal-tick. Stops on a reply or a connected call; a new booking
-- stops it too (cal-webhook). Sends on its own, as every Compr plan does.
with made as (
  insert into public.action_plans (workspace_id, name, description, trigger_type, trigger_event, active, created_by, settings)
  select w.id, $t$Compr · Missed demo$t$, $t$Booked the Compr onboarding call and did not show. Win them back with a free underwrite on an address they are working, then rebook.$t$, 'manual', 'Missed Cal.com onboarding call', true, w.owner_id, '{"stop_on_reply":true,"stop_on_call":true,"stop_on_stage":false,"auto_send":true,"tone":"plain, direct, from the Compr rep","audience":"buyer","compr_bucket":"missed_demo"}'::jsonb
    from public.workspaces w
   where w.settings->>'buyer_profile' = 'compr'
     and not exists (select 1 from public.action_plans a where a.workspace_id = w.id and a.settings->>'compr_bucket' = 'missed_demo')
  returning id, workspace_id
)
insert into public.action_plan_steps (workspace_id, plan_id, position, channel, delay_minutes, delay_hours, title, body, subject, config)
select m.workspace_id, m.id, s.position, s.channel, s.delay_minutes, s.delay_hours, s.title, s.body, s.subject, s.config
  from made m
 cross join (values
    (0, 'sms', 10, 0, $t$Missed you text$t$, $t$Compr: {{first_name}}, {{rep_name}} here. Looks like we missed each other on the Compr call. No problem. Text me an address you're working and I'll run a free underwrite on it today: comps, ARV, repairs and an offer price.$t$, null, '{"priority":"normal"}'::jsonb),
    (1, 'email', 50, 1, $t$Missed you email$t$, $t$Missed you today, so here's a free underwrite

{{first_name}}, we had a Compr walkthrough on the calendar and missed each other. It happens.

Rather than ask you to sit through a demo, let me show you on a deal you care about. Reply with one or two addresses you're looking at and I'll send back the full Compr underwrite: the comps we used and why, the ARV, a repair estimate from the photos, and the max offer at your numbers.

No call needed. If you'd still like the walkthrough, pick a new time here: https://cal.com/team/compr/onboarding-call

{{rep_name}}

You get this because you booked a Compr call.
Compr, 4266 Example Dr W Suite 201, San Antonio, TX 78228
Not for you? Reply "stop" and I will take you off the list.$t$, $t$Missed you today, here's a free underwrite$t$, '{"priority":"normal"}'::jsonb),
    (2, 'call', 1380, 23, $t$Missed demo call$t$, $t$They booked the Compr onboarding call and did not show. Call once. Ask what deals they are working this week and offer to underwrite one live on the phone. If they pick a time, book it on https://cal.com/team/compr/onboarding-call while you have them.$t$, null, '{"priority":"high"}'::jsonb),
    (3, 'sms', 1440, 24, $t$Free underwrite text$t$, $t$Compr: {{first_name}}, still happy to underwrite a deal for you free. Send me the address and I'll text back comps, ARV and a max offer. Or grab a new time: cal.com/team/compr/onboarding-call$t$, null, '{"priority":"normal"}'::jsonb),
    (4, 'email', 2880, 48, $t$Three addresses email$t$, $t$Send me 3 addresses

{{first_name}}, quick offer while you're sourcing.

Send me the three addresses on your list right now, the ones you're unsure about. I'll run each one through Compr and send back a report you can open on your phone: sold comps with the reason each one counts, ARV, repairs, and the most you can pay and still hit your spread.

You'll see in two minutes what the walkthrough would have taken thirty to show.

Reply with the addresses, or book the call when it suits you: https://cal.com/team/compr/onboarding-call

{{rep_name}}

You get this because you booked a Compr call.
Compr, 4266 Example Dr W Suite 201, San Antonio, TX 78228
Not for you? Reply "stop" and I will take you off the list.$t$, $t$Send me 3 addresses$t$, '{"priority":"normal"}'::jsonb),
    (5, 'sms', 4320, 72, $t$Last nudge text$t$, $t$Compr: {{first_name}}, {{rep_name}} again. Got a deal this week you want a second set of eyes on? Text me the address and you'll have the underwrite back today.$t$, null, '{"priority":"normal"}'::jsonb),
    (6, 'email', 10080, 168, $t$Close the loop email$t$, $t$Should I close your file?

{{first_name}}, I haven't heard back since our Compr call fell through, so I'll stop following up after this one.

If the timing was just off, the offer stands: reply with any address and I'll underwrite it for you free. And if you'd rather see it live, the calendar is here: https://cal.com/team/compr/onboarding-call

{{rep_name}}

You get this because you booked a Compr call.
Compr, 4266 Example Dr W Suite 201, San Antonio, TX 78228
Not for you? Reply "stop" and I will take you off the list.$t$, $t$Should I close your file?$t$, '{"priority":"normal"}'::jsonb)
 ) as s(position, channel, delay_minutes, delay_hours, title, body, subject, config);

-- Templates still pointing at the old onboarding link.
update public.message_templates
   set body_text = replace(body_text, 'cal.com/compr/compr-onboarding-call', 'cal.com/team/compr/onboarding-call'),
       body_html = replace(body_html, 'cal.com/compr/compr-onboarding-call', 'cal.com/team/compr/onboarding-call')
 where body_text like '%cal.com/compr/compr-onboarding-call%' or body_html like '%cal.com/compr/compr-onboarding-call%';
update public.action_plan_steps
   set body = replace(body, 'cal.com/compr/compr-onboarding-call', 'cal.com/team/compr/onboarding-call')
 where body like '%cal.com/compr/compr-onboarding-call%';
