-- 264 · What Lane's 9am read made of each late TC line.
--
-- lane-checkin reads the last two weeks of each late file's emails, texts and
-- call transcripts and marks every late line `waiting` (stuck on title, the
-- seller, the buyer), `looks_done` (the contact shows it happened, the line is
-- not ticked) or `needs_tc`. The day's fire pings skip the first two, so the
-- TC is only pinged about work that is hers. One array per workspace per day:
-- [{ key: "<transaction id>:<line id>", verdict, why }]. Additive.

alter table public.lane_checkins
  add column if not exists verdicts jsonb not null default '[]'::jsonb;
