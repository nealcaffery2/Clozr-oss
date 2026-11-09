-- 415 · Two Claude calls that repeated without anything new to read.
--
-- 1. Lead memory (migration 110) rebuilt a record's brief whenever any
--    activity row landed on it. Most of those rows are automation bookkeeping:
--    a plan starting ("Started "Email Cold Blast"", 404 in three days), a plan
--    step skipped, the AI agent stopping, Lane noting it read the file. None of
--    them changes the conversation the brief summarises, but each one cost a
--    full read of the history. Those kinds no longer mark a record dirty;
--    messages, calls, notes, offers and every other activity still do.
--
-- 2. Gmail routing (_shared/google.ts relinkEmail) put the newest unfiled
--    emails to the model on every sync, every 5 minutes, because a "none of
--    these deals" answer was not kept. communications.deal_ai_tried holds the
--    candidate deal ids the model answered none for; the email is asked again
--    only when that list changes.
--
-- Additive, safe to re-run.

alter table public.communications add column if not exists deal_ai_tried text;

create or replace function public.lead_memory_dirty(p_limit integer default 15, p_window interval default interval '3 days')
returns table (workspace_id bigint, record_kind text, record_id bigint, last_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  with touches as (
    select c.workspace_id, 'seller'::text as record_kind, c.seller_id as record_id, max(c.created_at) as last_at
      from public.communications c
     where c.seller_id is not null and c.created_at > now() - p_window
     group by c.workspace_id, c.seller_id
    union all
    select c.workspace_id, 'buyer'::text, c.buyer_id, max(c.created_at)
      from public.communications c
     where c.buyer_id is not null and c.created_at > now() - p_window
       and (c.direction = 'inbound' or c.channel in ('call', 'voicemail', 'note'))
     group by c.workspace_id, c.buyer_id
    union all
    select a.workspace_id, a.entity_type, a.entity_id, max(a.created_at)
      from public.activity a
     where a.entity_type in ('seller', 'buyer') and a.created_at > now() - p_window
       and a.kind not in ('plan', 'ai_agent')
       and not (a.kind = 'tc' and a.title like 'Lane ·%')
     group by a.workspace_id, a.entity_type, a.entity_id
    union all
    select o.workspace_id, 'seller'::text, o.seller_id, max(o.updated_at)
      from public.offers o
     where o.seller_id is not null and o.updated_at > now() - p_window
     group by o.workspace_id, o.seller_id
    union all
    select o.workspace_id, 'buyer'::text, o.buyer_id, max(o.updated_at)
      from public.offers o
     where o.buyer_id is not null and o.updated_at > now() - p_window
     group by o.workspace_id, o.buyer_id
  ), latest as (
    select t.workspace_id, t.record_kind, t.record_id, max(t.last_at) as last_at
      from touches t
     group by t.workspace_id, t.record_kind, t.record_id
  )
  select l.workspace_id, l.record_kind, l.record_id, l.last_at
    from latest l
    left join public.lead_memory m
      on m.workspace_id = l.workspace_id and m.record_kind = l.record_kind and m.record_id = l.record_id
   where m.updated_at is null or l.last_at > m.updated_at
   order by l.last_at desc
   limit greatest(1, least(coalesce(p_limit, 15), 100));
$$;
revoke execute on function public.lead_memory_dirty(integer, interval) from public, anon, authenticated;
