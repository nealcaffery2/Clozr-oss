-- 289: every text knows who sent it and which line it left from.
--
-- The browser now writes rep_id, talkr_user_id and from_phone on every send
-- (lib/sms-record), and the Talkr mirror (lib/talkr-sync) no longer rewrites
-- a row's sender or line. This file repairs what the old paths left behind:
--
--  1. The line-owner trigger (153) fires on an UPDATE that fills from_phone
--     or to_phone too, not only on INSERT, so a row written without its
--     number and completed later still gets its rep.
--  2. Rows from the last 90 days with a from_phone and no rep are credited to
--     the line's owner, the way the trigger would have on insert. AI-agent
--     rows (ai_agent_key) stay the agent's.
--
-- Safe to re-run.

-- ---- 1. the trigger also runs when a row gains its number ---------------------------
drop trigger if exists communications_rep_from_line on public.communications;
create trigger communications_rep_from_line
  before insert or update of from_phone, to_phone on public.communications
  for each row execute function public.communications_rep_from_line();

-- ---- 2. credit the rows the old paths left without a rep -----------------------------
update public.communications c
   set rep_id = r.user_id, rep_from_line = true
  from public.rep_phone_numbers r
 where c.rep_id is null
   and c.ai_agent_key is null
   and c.channel in ('sms', 'call', 'voicemail')
   and c.occurred_at >= now() - interval '90 days'
   and r.workspace_id = c.workspace_id
   and r.user_id is not null
   and r.phone_e164 = public.normalize_phone(case when c.direction = 'inbound' then c.to_phone else c.from_phone end);

-- Who sent it, as Talkr knows them: looked up by the Inbox's sender filter and the leaderboard.
create index if not exists communications_talkr_user_idx
  on public.communications (workspace_id, talkr_user_id)
  where talkr_user_id is not null;
