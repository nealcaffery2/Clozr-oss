-- 76: 10DLC registration, filed from CLOZR instead of by hand in a portal.
--
-- Migration 68 built the guard that reads every line's 10DLC standing every
-- morning and tells the admins what is wrong. What it could not do was fix the
-- one thing it kept reporting: a workspace with no brand and no campaign, whose
-- texts carriers filter. Its own header says why — filing needs the carrier
-- credential, which lives in Talkr.
--
-- That was an architecture decision, not a limit of the carrier. Filing is
-- three calls (brand, campaign, assign a messaging profile) and three webhook
-- event types, so this migration gives the facts a home and the filing a
-- ledger, and supabase/functions/ten-dlc-register does the calls.
--
-- Where the facts live: workspaces.settings->'ten_dlc', because they are
-- workspace configuration a human types once — legal name, EIN, address, the
-- consent story, the sample messages. See docs/10dlc-automation.md.
--
-- What is deliberately not here: a polling cron. Telnyx pushes brand, campaign
-- and phone-number events to ten-dlc-events, and the guard's own daily read of
-- the reputation summary is the backstop when a webhook is missed.

-- One row per workspace: where its filing has got to.
create table if not exists public.ten_dlc_registrations (
  workspace_id          bigint primary key references public.workspaces(id) on delete cascade,
  -- draft → submitting → brand_pending → campaign_pending → assigning → active
  -- failed is terminal until a human changes the facts and files again.
  status                text not null default 'draft'
                          check (status in ('draft', 'submitting', 'brand_pending', 'campaign_pending', 'assigning', 'active', 'failed')),
  brand_id              text,              -- Telnyx brand id
  tcr_brand_id          text,              -- TCR's own id (BXXXXXX), what carriers quote back
  brand_status          text,
  campaign_id           text,
  tcr_campaign_id       text,
  campaign_status       text,
  messaging_profile_id  text,              -- whose numbers join the campaign
  assignment_task_id    text,              -- phoneNumberAssignmentByProfile is async
  assignment_status     text,
  last_error            text,
  -- Telnyx names the offending fields on a rejection; keeping them is the
  -- difference between "your brand failed" and "your EIN has 8 digits".
  reasons               jsonb not null default '[]'::jsonb,
  submitted_by          uuid references auth.users(id) on delete set null,
  submitted_at          timestamptz,
  brand_filed_at        timestamptz,
  campaign_filed_at     timestamptz,
  active_at             timestamptz,
  updated_at            timestamptz not null default now()
);

alter table public.ten_dlc_registrations enable row level security;
drop policy if exists ten_dlc_registrations_read on public.ten_dlc_registrations;
create policy ten_dlc_registrations_read on public.ten_dlc_registrations for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = ten_dlc_registrations.workspace_id and m.user_id = (select auth.uid())));
-- Writes are the edge functions' only: every one of them is a carrier fact we
-- were told, never something a member may assert.

-- The raw webhook ledger. Telnyx delivers at least once and out of order, so
-- the event id is the dedupe key and a redelivery is a no-op.
create table if not exists public.ten_dlc_events (
  event_id      text primary key,
  workspace_id  bigint references public.workspaces(id) on delete cascade,
  event_type    text,                      -- 10dlc.brand.update | 10dlc.campaign.update | 10dlc.phone_number.update
  payload_type  text,                      -- REGISTRATION | TCR_BRAND_UPDATE | ...
  status        text,
  occurred_at   timestamptz,
  received_at   timestamptz not null default now(),
  payload       jsonb not null
);
create index if not exists ten_dlc_events_ws_idx on public.ten_dlc_events (workspace_id, received_at desc);

alter table public.ten_dlc_events enable row level security;
drop policy if exists ten_dlc_events_read on public.ten_dlc_events;
create policy ten_dlc_events_read on public.ten_dlc_events for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = ten_dlc_events.workspace_id and m.user_id = (select auth.uid())));

-- Keep updated_at honest without every writer remembering to.
create or replace function public.ten_dlc_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.ten_dlc_touch() from public, anon, authenticated;

drop trigger if exists ten_dlc_registrations_touch on public.ten_dlc_registrations;
create trigger ten_dlc_registrations_touch before update on public.ten_dlc_registrations
  for each row execute function public.ten_dlc_touch();
