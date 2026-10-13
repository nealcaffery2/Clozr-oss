-- 67: every call lands on the record with its recording, transcript, AI notes
-- and coaching score — without a browser having to be open.
--
-- Until now a call reached the Activity tab only when the rep's browser
-- happened to mirror Talkr's history after the call (lib/talkr-sync.ts), and
-- the transcript, notes and score were fetched live from Talkr each time the
-- row was opened, never stored. A call made with CLOZR closed never appeared.
--
-- Now supabase/functions/call-sync runs every two minutes (pg_cron →
-- pg_net, like the dispo campaign tick): it reads Talkr's call history as the
-- workspace owner, files each call on the seller or buyer whose number it is,
-- then for every recorded call pulls the transcript, the AI notes and the
-- coaching score once they are ready, and copies the MP3 into the private
-- call-recordings bucket so the record can play it without a Talkr session.
--
-- transcript_status: null (not looked at yet), 'processing' (Talkr still
-- working), 'completed', 'failed', 'no_recording', 'not_configured' (Talkr has
-- no transcription key). intel_attempts caps the retries per call.

alter table public.communications
  add column if not exists recording_id text,
  add column if not exists transcript text,
  add column if not exists transcript_status text,
  add column if not exists ai_notes jsonb,
  add column if not exists call_score jsonb,
  add column if not exists score_overall integer,
  add column if not exists intel_attempts integer not null default 0,
  add column if not exists intel_synced_at timestamptz;

create index if not exists communications_intel_pending_idx
  on public.communications (workspace_id, occurred_at desc)
  where source = 'talkr' and channel in ('call', 'voicemail') and intel_synced_at is null;

-- Where the sync stands, per workspace; Settings reads it.
create table if not exists public.call_sync_state (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  calls_seen integer not null default 0,
  intel_done integer not null default 0,
  intel_pending integer not null default 0,
  configured boolean not null default false
);
alter table public.call_sync_state enable row level security;
drop policy if exists call_sync_state_read on public.call_sync_state;
create policy call_sync_state_read on public.call_sync_state for select
  using (exists (select 1 from public.workspace_members m where m.workspace_id = call_sync_state.workspace_id and m.user_id = auth.uid()));

-- Private bucket for the copied MP3s: <workspace_id>/<talkr call id>.mp3.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('call-recordings', 'call-recordings', false, 104857600, array['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm'])
on conflict (id) do nothing;

drop policy if exists "call recordings: members read" on storage.objects;
create policy "call recordings: members read" on storage.objects for select
  using (
    bucket_id = 'call-recordings'
    and exists (
      select 1 from public.workspace_members m
      where m.user_id = auth.uid() and m.workspace_id::text = split_part(name, '/', 1)
    )
  );

-- The kick: every two minutes, POST to the edge function with the service key
-- from the vault (same pattern as dispo_campaign_kick).
create or replace function public.call_sync_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/call-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.call_sync_kick() from public, anon, authenticated;

select cron.unschedule('clozr-call-sync') where exists (select 1 from cron.job where jobname = 'clozr-call-sync');
select cron.schedule('clozr-call-sync', '*/2 * * * *', 'select public.call_sync_kick()');
