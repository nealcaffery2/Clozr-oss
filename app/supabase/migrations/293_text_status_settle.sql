-- 293: outbound texts stop sitting at "queued".
--
-- Talkr sends no message.* webhooks (none in 14 days, only call.*), so a text
-- CLOZR sent kept the status Talkr gave it at send time however it ended:
-- texts Talkr had delivered or failed still read "queued". call-sync (every two minutes) now reads Talkr's
-- outbound text history for delivered and failed and settles the open rows
-- (settleTextStatuses). These indexes keep that read cheap as texting grows:
-- the open texts it looks for, and Talkr message ids in any workspace (a workspace
-- can text on another's shared lines, so it is settled from that history).
--
-- Idempotent.

create index if not exists communications_sms_open_idx
  on public.communications (occurred_at)
  where channel = 'sms' and direction = 'outbound' and source = 'talkr'
    and (status is null or status in ('queued', 'sending', 'sent'));

create index if not exists communications_talkr_msg_idx
  on public.communications (source_id)
  where source = 'talkr';
