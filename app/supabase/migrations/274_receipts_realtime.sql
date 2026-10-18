-- Read receipts update on screen as they happen.
--
-- An email open or click (email-track bumps email_tracking) and a seller
-- opening a signing link from a text (esign stamps contract_signers.viewed_at)
-- now reach the Inbox thread, the dialer's texts and the record's Activity
-- feed without a reload (app/components/inbox/receipts.ts subscribes per
-- workspace). That needs both tables in the realtime publication. RLS still
-- decides who receives a row: email_tracking_read and contract_signers_select
-- are workspace membership, the same rule the screens already read under.
-- Idempotent.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_tracking') then
    alter publication supabase_realtime add table public.email_tracking;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contract_signers') then
    alter publication supabase_realtime add table public.contract_signers;
  end if;
end
$$;
