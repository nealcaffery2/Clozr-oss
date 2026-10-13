-- AI agents hand a positive call to the rep working the lead.
--
-- New agents default to live transfer on, warm, ringing the rep who switched
-- the AI agent on for the record (else its assigned rep), with "book the
-- soonest time today" when that rep is tied up or does not pick up. This
-- turns the same on in the draft of every existing agent that never set up a
-- transfer (switched off and no destination). An agent with a destination of
-- its own is left as its owner set it, and so is any agent whose role starts
-- with compr (a demo-setting agent that books on one calendar).
--
-- Only the draft changes; the console shows "Unpublished changes" and the
-- next Publish sends it to ElevenLabs. Safe to re-run.

update public.voice_agent_settings
set settings = settings
      || jsonb_build_object('live_transfer',
           coalesce(settings->'live_transfer', '{}'::jsonb)
           || jsonb_build_object(
                'enabled', true,
                'mode', 'warm',
                'fallback', 'book_callback',
                'destinations', jsonb_build_array(jsonb_build_object(
                  'id', 'rep', 'label', 'The rep working the lead', 'number', '', 'type', 'rep_assigned', 'ring_timeout_s', 25)),
                'triggers', coalesce(settings#>'{live_transfer,triggers}', '{}'::jsonb)
                  || jsonb_build_object('asks_for_person', true, 'hot_lead', true)))
      || jsonb_build_object('tools',
           coalesce(settings->'tools', '{}'::jsonb)
           || jsonb_build_object('transfer', coalesce(settings#>'{tools,transfer}', '{}'::jsonb) || jsonb_build_object('enabled', true))),
    updated_at = now()
where role not like 'compr%'
  and coalesce((settings#>>'{live_transfer,enabled}')::boolean, false) = false
  and jsonb_array_length(coalesce(settings#>'{live_transfer,destinations}', '[]'::jsonb)) = 0;
