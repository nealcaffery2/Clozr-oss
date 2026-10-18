-- 290: a line assigned in CLOZR is assigned on Talkr, every time.
--
-- Settings → Numbers writes rep_phone_numbers; Talkr decides what a rep can
-- dial and text from. The browser pushed the Talkr side only when an admin
-- had the Numbers page open with a Talkr admin seat, so a line could sit in
-- CLOZR as someone's caller ID while Talkr had never heard of it (on the
-- carrier, on the 10DLC profile, on nobody's Talkr seat, so the rep could
-- not text from CLOZR).
--
-- Now the database does it: after rep_phone_numbers gains an owner, or an
-- owner's line is made their caller ID, talkr_line_kick() posts to the
-- talkr-line function (service role, vault key as in 284), which imports the
-- number from the carrier when Talkr lacks it, assigns it to the teammate's
-- Talkr seat, and makes it their Talkr default when it is their caller ID.
-- The call is fire-and-forget: a failure is in net._http_response and the
-- function's log, and the next assignment or Numbers-page visit tries again.
--
-- Safe to re-run.

create or replace function public.talkr_line_kick()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare v_url text; v_key text;
begin
  if new.user_id is null then return new; end if;
  -- Only a change Talkr needs to hear: a new owner, or the caller-ID flag turning on.
  if tg_op = 'UPDATE'
     and new.user_id is not distinct from old.user_id
     and (coalesce(new.is_caller_id, false) = coalesce(old.is_caller_id, false) or not coalesce(new.is_caller_id, false))
  then return new; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return new; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/talkr-line',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object(
      'action', 'assign',
      'workspace_id', new.workspace_id,
      'phone_e164', new.phone_e164,
      'user_id', new.user_id,
      'set_default', coalesce(new.is_caller_id, false),
      'label', new.label),
    timeout_milliseconds := 25000);
  return new;
end $$;

revoke all on function public.talkr_line_kick() from public, anon, authenticated;

drop trigger if exists rep_phone_numbers_talkr_sync on public.rep_phone_numbers;
create trigger rep_phone_numbers_talkr_sync
  after insert or update of user_id, is_caller_id on public.rep_phone_numbers
  for each row execute function public.talkr_line_kick();
