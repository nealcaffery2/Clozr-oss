-- 170: the Gmail sync reads only what a run needs.
--
-- Every Gmail pass loaded every seller, buyer, vendor and deal party address
-- in the workspace (tens of thousands of rows, paged 1000 at a time) to match
-- a few dozen messages, once per mailbox every five minutes. Now:
--   google_accounts.gmail_history_id  Gmail's historyId when the mailbox was
--     last read through to now. Unchanged means nothing arrived, and the run
--     stops after one profile call.
--   gmail_people(ws, emails)  the sellers, buyers (main and other addresses),
--     vendors and deal parties for just the addresses on the messages in hand.
--   gmail_backfill_contacts(ws, after, n)  the next addresses for the history
--     backfill, in the same "updated_at|kind|id" order its cursor already
--     uses: sellers, deal parties, and buyers and vendors on a live deal.

alter table public.google_accounts add column if not exists gmail_history_id text;

create index if not exists deal_parties_ws_email_idx
  on public.deal_parties (workspace_id, lower(email))
  where email is not null and user_id is null;

create or replace function public.gmail_people(p_ws bigint, p_emails text[])
returns jsonb language sql stable set search_path = public as $$
  with e as (
    select distinct lower(x) as email from unnest(p_emails) x where x is not null and x <> ''
  ), people as (
    select 'seller' as kind, s.id, lower(s.email) as email, s.updated_at
      from sellers s join e on lower(s.email) = e.email
     where s.workspace_id = p_ws and s.email is not null
    union all
    select 'buyer', b.id, lower(b.email), b.updated_at
      from buyers b join e on lower(b.email) = e.email
     where b.workspace_id = p_ws and b.email is not null
    union all
    select 'buyer_alt', be.buyer_id, lower(be.email), be.updated_at
      from buyer_emails be join e on lower(be.email) = e.email
     where be.workspace_id = p_ws and be.email is not null
    union all
    select 'vendor', v.id, lower(v.email), v.updated_at
      from vendors v join e on lower(v.email) = e.email
     where v.workspace_id = p_ws and v.email is not null
  ), parties as (
    select dp.id, dp.deal_id, lower(dp.email) as email, dp.seller_id, dp.buyer_id, dp.vendor_id
      from deal_parties dp
     where dp.workspace_id = p_ws and dp.user_id is null
       and (lower(dp.email) in (select email from e)
         or dp.seller_id in (select id from people where kind = 'seller')
         or dp.buyer_id in (select id from people where kind in ('buyer', 'buyer_alt'))
         or dp.vendor_id in (select id from people where kind = 'vendor'))
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'email', email) order by updated_at desc nulls first, id) from people), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'deal_id', deal_id, 'email', email, 'seller_id', seller_id, 'buyer_id', buyer_id, 'vendor_id', vendor_id) order by id) from parties), '[]'::jsonb)
  );
$$;

create or replace function public.gmail_backfill_contacts(p_ws bigint, p_after text, p_limit int default 60)
returns table (key text, email text) language sql stable set search_path = public as $$
  with live as (
    select id, buyer_id, title_vendor_id from deals where workspace_id = p_ws and archived_at is null
  ), c as (
    select to_char(coalesce(s.updated_at, 'epoch'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             || '|seller|' || lpad(s.id::text, 12, '0') as key, lower(s.email) as email
      from sellers s where s.workspace_id = p_ws and s.email is not null
    union all
    select to_char(coalesce(dp.updated_at, 'epoch'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             || '|party|' || lpad(dp.id::text, 12, '0'), lower(dp.email)
      from deal_parties dp join live d on d.id = dp.deal_id
     where dp.workspace_id = p_ws and dp.email is not null and dp.user_id is null
    union all
    select to_char(coalesce(b.updated_at, 'epoch'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             || '|buyer|' || lpad(b.id::text, 12, '0'), lower(b.email)
      from buyers b
     where b.workspace_id = p_ws and b.email is not null
       and (b.id in (select buyer_id from live) or b.id in (select dp.buyer_id from deal_parties dp join live d on d.id = dp.deal_id where dp.buyer_id is not null))
    union all
    select to_char(coalesce(v.updated_at, 'epoch'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             || '|vendor|' || lpad(v.id::text, 12, '0'), lower(v.email)
      from vendors v
     where v.workspace_id = p_ws and v.email is not null
       and (v.id in (select title_vendor_id from live) or v.id in (select dp.vendor_id from deal_parties dp join live d on d.id = dp.deal_id where dp.vendor_id is not null))
  )
  select key, email from c
   where c.key collate "C" > coalesce(p_after, '') collate "C" and c.email like '%@%.%'
   order by c.key collate "C"
   limit greatest(1, least(coalesce(p_limit, 60), 500));
$$;

revoke execute on function public.gmail_people(bigint, text[]) from public, anon, authenticated;
revoke execute on function public.gmail_backfill_contacts(bigint, text, int) from public, anon, authenticated;
