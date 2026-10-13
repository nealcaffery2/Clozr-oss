-- 51 · Profile photos.
--
-- A teammate's photo is shown to their whole team (activity log, inbox, team
-- lists), so the avatars bucket is public-read. Each person writes only their
-- own folder: avatars/<auth uid>/<file>. profiles.avatar_url holds either that
-- public URL or their Google photo (set when they connect Google).

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists avatars_own_write on storage.objects';
    execute $p$create policy avatars_own_write on storage.objects for all to authenticated
      using (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text)
      with check (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text)$p$;
  end if;
end $$;
