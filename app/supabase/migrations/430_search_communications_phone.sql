-- 430 · search_communications returns the other side's phone.
--
-- The ⌘K bar dropped every hit with no seller, buyer or deal on it: a text
-- from someone who is not in CLOZR yet had nowhere to open. With the number
-- it opens that conversation in the Inbox. Same function as 278 plus one
-- column at the end; the return type changes, so it is dropped first.

drop function if exists public.search_communications(bigint, text, text[], integer, timestamptz);

create or replace function public.search_communications(
  ws bigint,
  q text,
  channels text[] default null,
  max integer default 20,
  since timestamptz default null
)
returns table (
  id bigint,
  channel text,
  direction text,
  occurred_at timestamptz,
  duration_s integer,
  seller_id bigint,
  buyer_id bigint,
  deal_id bigint,
  record_name text,
  snippet text,
  rank real,
  phone text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with query as (
    select websearch_to_tsquery('english'::regconfig, left(coalesce(q, ''), 200)) as tsq
  ),
  hits as (
    select c.id, c.channel, c.direction, c.occurred_at, c.duration_s, c.seller_id, c.buyer_id, c.deal_id,
           c.subject, c.summary, c.body, c.transcript,
           case when c.direction = 'outbound' then c.to_phone else c.from_phone end as phone,
           ts_rank(public.comm_search_doc(c.subject, c.summary, c.body, c.transcript), query.tsq) as rank
      from public.communications c, query
     where c.workspace_id = ws
       and numnode(query.tsq) > 0
       and public.comm_search_doc(c.subject, c.summary, c.body, c.transcript) @@ query.tsq
       and (channels is null or c.channel = any (channels))
       and (since is null or c.occurred_at >= since)
     order by rank desc, c.occurred_at desc
     limit least(greatest(coalesce(max, 20), 1), 50)
  )
  select h.id, h.channel, h.direction, h.occurred_at, h.duration_s::integer, h.seller_id, h.buyer_id, h.deal_id,
         coalesce(nullif(s.name, ''), nullif(b.name, ''), nullif(b.company, '')) as record_name,
         ts_headline('english'::regconfig,
           left(concat_ws(' · ', nullif(h.subject, ''), nullif(h.summary, ''),
             nullif(regexp_replace(coalesce(h.body, ''), '<[^>]*>', ' ', 'g'), ''), nullif(h.transcript, '')), 100000),
           query.tsq,
           'StartSel=' || chr(2) || ', StopSel=' || chr(3) || ', MaxWords=22, MinWords=10, MaxFragments=1, FragmentDelimiter=" … "') as snippet,
         h.rank,
         h.phone
    from hits h
    cross join query
    left join public.sellers s on s.id = h.seller_id
    left join public.buyers b on b.id = h.buyer_id
   order by h.rank desc, h.occurred_at desc
$$;

revoke all on function public.search_communications(bigint, text, text[], integer, timestamptz) from public, anon;
grant execute on function public.search_communications(bigint, text, text[], integer, timestamptz) to authenticated, service_role;
