-- 391: a rep's phone audio follows them across browsers. Until now the
-- ringtone, wait music and alert choices lived in localStorage and the
-- uploaded files in IndexedDB, both per browser: an mp3 added on the desk PC
-- was the built-in tone on the laptop. Now lib/phone-audio.ts keeps the
-- prefs (minus the mic/speaker/ring device ids, which are facts about the
-- desk) in profiles.phone_audio and the files in the private phone-audio
-- bucket at <user id>/<slot>, referenced from the prefs as `sb:<path>#<at>`.
-- Safe to re-run.

alter table public.profiles add column if not exists phone_audio jsonb;

-- 10 MB cap, the same as MAX_CUSTOM_AUDIO_BYTES in lib/phone-audio.ts.
insert into storage.buckets (id, name, public, file_size_limit)
values ('phone-audio', 'phone-audio', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "phone audio: own files" on storage.objects;
create policy "phone audio: own files" on storage.objects for all to authenticated
  using (bucket_id = 'phone-audio' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'phone-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
