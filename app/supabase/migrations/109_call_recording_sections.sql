-- 109: the smart call player's data, stored once per call.
--
-- transcript_segments: the timed transcript, [{start, end, speaker, text}]
--   with start/end in seconds from the start of the recording and speaker
--   'rep' | 'contact' | 'unknown'. call-sync writes Talkr's recording
--   segments; the dialer writes the live Deepgram lines at hang-up until the
--   recording transcript replaces them. Before this, only flat text was kept,
--   so the player could not sync the transcript to playback.
-- call_sections: the chapters (lib/call-media.ts StoredSections), computed by
--   the call-sections function once and reused until the transcript grows.
-- call_origin: who placed the call when it was not a rep on the softphone
--   ('ai_agent' for a Talkr AI Assistant call), so the record can say so.
--   call-sync never writes it, so its upsert cannot erase it.
--
-- Idempotent. The browser reads these with select('*') and writes them in a
-- separate best-effort update, so a project without this migration keeps
-- working with estimated times and keyword sections.

alter table public.communications
  add column if not exists transcript_segments jsonb,
  add column if not exists call_sections jsonb,
  add column if not exists call_origin text;
