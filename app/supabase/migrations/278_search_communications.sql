-- 278 · search_communications: find a word or phrase in every call transcript,
-- call summary, text, email and voicemail of a workspace.
--
--   search_communications(ws, q, channels default null, max default 20, since default null)
--
-- q is read like a web search (websearch_to_tsquery, english stemming):
-- `roof` also finds "roofs" and "roofing", `"new roof"` is a phrase, `roof
-- -leak` leaves out rows that say leak, `roof or foundation` is either.
-- channels narrows to some of call / sms / email / voicemail / note; since
-- keeps only messages at or after that time, before the cap. At most
-- 50 rows, best match first, then newest.
--
-- Each row carries the record it is on (seller, or buyer, with its name) and
-- a snippet around the match. The matched words in the snippet sit between
-- chr(2) and chr(3), which the app turns into highlights.
--
-- SECURITY INVOKER: the caller's own row security applies, so a rep finds only
-- the messages they can already open (migration 107's mailbox visibility
-- included). The match uses communications_search_idx (277).

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
  rank real
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
         h.rank
    from hits h
    cross join query
    left join public.sellers s on s.id = h.seller_id
    left join public.buyers b on b.id = h.buyer_id
   order by h.rank desc, h.occurred_at desc
$$;

revoke all on function public.search_communications(bigint, text, text[], integer, timestamptz) from public, anon;
grant execute on function public.search_communications(bigint, text, text[], integer, timestamptz) to authenticated, service_role;
