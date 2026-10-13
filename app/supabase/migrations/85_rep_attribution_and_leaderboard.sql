-- 85 · Who made the call — and the leaderboard feed the TV board pulls.
--
-- Every leaderboard CLOZR draws (the Sales leaderboard screen, Reporting's
-- Team tab, the office TV) ranks reps on calls, texts, conversations, offers,
-- contracts and closings. Deals and offers already carry a rep (owner_id,
-- dispo_rep_id, created_by). Communications did not: a call row knew the
-- seller it was with and nothing about which rep dialled. The board credited
-- calls through sellers.assigned_to, which is wrong the moment a lead manager
-- or a second rep touches a record, and zero for calls to numbers that are
-- not a record yet.
--
-- `communications.rep_id` is that column. call-sync fills it from Talkr's
-- user_id on each call (mapped to the CLOZR member with that email), the
-- SMS/email writers set it to the signed-in rep, and this migration backfills
-- what it can from the seller's assigned rep so history is not blank. The
-- engine (lib/leaderboard.ts) still falls back to the assigned rep when the
-- column is null, so nothing goes to zero while call-sync catches up.
--
-- The feed: `ingest_sources` gains a read-only source named `dashboard`. A key
-- with that name is what an office TV dashboard sends to the `leaderboard`
-- edge function; the ingest function refuses to write for it. Minted from
-- Settings → Ingest keys like every other key.

alter table public.communications
  add column if not exists rep_id uuid references auth.users(id) on delete set null,
  add column if not exists talkr_user_id text;

create index if not exists communications_rep_period_idx
  on public.communications (workspace_id, rep_id, occurred_at desc);

comment on column public.communications.rep_id is
  'The CLOZR member who handled it: the Talkr user on a call, the signed-in rep on a text or email. Null when unknown; the leaderboard falls back to the seller''s assigned rep.';
comment on column public.communications.talkr_user_id is
  'Talkr''s user id for the rep on a call, kept so a member who joins CLOZR later can be credited on re-sync.';

-- Backfill: the seller's assigned rep, for rows that have nothing better.
update public.communications c
   set rep_id = s.assigned_to
  from public.sellers s
 where c.rep_id is null
   and c.seller_id = s.id
   and s.assigned_to is not null;

-- ---- the dashboard's read-only key ----------------------------------------------
-- ingest_sources.name is free text (the app's INGEST_SOURCES list is the
-- catalogue), so nothing structural changes. A trigger stops a `dashboard` key
-- from ever being granted a signing secret or write settings — it reads.
create or replace function public.ingest_sources_dashboard_readonly() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.name = 'dashboard' and new.settings ? 'signing_secret' then
    raise exception 'a dashboard key is read-only and takes no signing secret';
  end if;
  return new;
end $$;
revoke all on function public.ingest_sources_dashboard_readonly() from public, anon, authenticated;
drop trigger if exists ingest_sources_dashboard_readonly on public.ingest_sources;
create trigger ingest_sources_dashboard_readonly before insert or update on public.ingest_sources
  for each row execute function public.ingest_sources_dashboard_readonly();

-- ---- board settings ------------------------------------------------------------------
-- workspaces.settings gains, all optional, read by the leaderboard engine:
--   leaderboard_tz            IANA zone the board's "today" is measured in (default America/Chicago)
--   leaderboard_goals         { monthlyClosed, pipelineTotal, terminationPercentMax }
--   leaderboard_exclude       [user ids] left off the board (an owner who does not sell)
--   leaderboard_manual_badges { "<user id or lower-case name>": ["one-shot-one-kill", …] }
-- No schema change: settings is jsonb. Documented here so the keys have a home.
