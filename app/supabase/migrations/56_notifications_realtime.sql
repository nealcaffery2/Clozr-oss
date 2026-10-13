-- Notification sounds: an @mention plays the rep's "mention" sound the moment
-- migration 43's trigger inserts it (app/components/talkr/useCrmSounds.ts).
-- That needs INSERTs on notifications in the realtime publication. RLS still
-- decides who receives a row; the client also checks user_id is theirs.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
