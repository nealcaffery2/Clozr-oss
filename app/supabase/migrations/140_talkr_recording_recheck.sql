-- 140: a second look at Talkr calls marked unrecorded too early.
--
-- call-sync gave up on a call whose recording had not landed yet on its first
-- look ('no_recording', finished), so recent calls lost their recording,
-- transcript and score. The function now waits 15 minutes before calling a call
-- unrecorded; this reopens the last two weeks' 'no_recording' calls so the next
-- ticks fetch what Talkr has.

update public.communications
   set intel_synced_at = null, intel_attempts = 0, transcript_status = null
 where source = 'talkr' and channel in ('call', 'voicemail') and source_id like 'call:%'
   and transcript_status = 'no_recording' and occurred_at > now() - interval '14 days';
