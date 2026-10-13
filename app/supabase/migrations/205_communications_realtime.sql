-- A record's Activity feed updates on its own: a reply synced from Gmail, a
-- text or a call filed on the open seller or buyer redraws the feed
-- (app/clozr/useRecordFeedLive.ts), and the Inbox's existing subscription
-- (components/inbox/data.ts) starts receiving rows instead of waiting for its
-- two-minute poll. That needs communications in the realtime publication.
-- RLS still decides who receives a row. Idempotent.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'communications') then
    alter publication supabase_realtime add table public.communications;
  end if;
end
$$;
