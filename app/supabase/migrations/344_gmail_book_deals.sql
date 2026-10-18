-- 344 · The Gmail address book reads its deals in one call.
--
-- Every Gmail pass (_shared/google.ts loadBook: the five-minute upkeep per
-- mailbox, and the minute lane whenever mail arrives) read every live deal of
-- the workspace through PostgREST, 1,000 rows a page: several pages on
-- a large workspace, each one a full scan, sort and property
-- lookup for every deal before the offset (hundreds of pages an hour, one
-- of the largest statements in pg_stat_statements). Mailboxes run in isolates of their own, so the book cannot be
-- shared between them in memory.
--
-- gmail_book_deals(p_ws) answers the same rows as one json array: the
-- columns the pages selected (created_at only ordered them), the house as
-- {"line1": ...} or null as PostgREST embedded it, live deals only, newest
-- first then highest id, as the pages were ordered. One scan, one hash join,
-- one sort: about 60 ms on a large workspace as plain SQL.
--
-- Service role only (google-sync); loadBook pages as before while this is
-- missing. Reads only. Safe to re-run.

create or replace function public.gmail_book_deals(p_ws bigint)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(json_agg(json_build_object(
           'id', d.id, 'seller_id', d.seller_id, 'buyer_id', d.buyer_id, 'title_vendor_id', d.title_vendor_id,
           'title_email', d.title_email, 'property_id', d.property_id, 'stage', d.stage,
           'properties', case when p.id is null then null else json_build_object('line1', p.line1) end)
         order by d.created_at desc, d.id desc), '[]'::json)
    from deals d
    -- property_id is an id-only key: only this workspace's house (the #428 rule).
    left join properties p on p.id = d.property_id and p.workspace_id = p_ws
   where d.workspace_id = p_ws and d.archived_at is null;
$$;

revoke all on function public.gmail_book_deals(bigint) from public, anon, authenticated;
grant execute on function public.gmail_book_deals(bigint) to service_role;
