-- 437 · inbox_blast_tags: which deal blasts reached the people in the Inbox.
--
-- Morgan works buyer replies in the Inbox and nothing on a thread said it was
-- an answer to a blast, or which deal. The Inbox sends the numbers and email
-- addresses it is showing; this returns, per buyer and deal, the deal's
-- street and when a blast text or email last went to them, plus the buyer's
-- status (a "Prospect" gets its own chip). Only recipients a message was
-- actually sent to count: a queued blast has not reached anyone yet.
--
-- Matching uses the stored keys and their indexes: phone_key
-- (normalize_phone, 296/297) and the lowercased email (298). Security
-- invoker, so dispo_campaign_recipients' RLS decides who sees what. Capped at
-- 500 numbers and 500 addresses per call; the Inbox asks in pages of 200.

create or replace function public.inbox_blast_tags(
  ws bigint,
  phones text[] default '{}',
  emails text[] default '{}'
)
returns table (
  phone_key text,
  email text,
  buyer_id bigint,
  buyer_status text,
  deal_id bigint,
  line1 text,
  last_sent_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with keys as (
    select
      array(select distinct k from (select public.normalize_phone(p) as k from unnest(coalesce(phones, '{}'::text[])) p) x where k is not null limit 500) as ph,
      array(select distinct e from (select lower(trim(a)) as e from unnest(coalesce(emails, '{}'::text[])) a) y where e like '%_@_%' limit 500) as em
  ),
  hit as (
    select r.id, r.phone_key, r.email, r.buyer_id, r.deal_id
      from public.dispo_campaign_recipients r, keys
     where r.workspace_id = ws and r.phone_key = any (keys.ph)
    union
    select r.id, r.phone_key, r.email, r.buyer_id, r.deal_id
      from public.dispo_campaign_recipients r, keys
     where r.workspace_id = ws and r.email = any (keys.em)
  ),
  sent as (
    select h.phone_key, h.email, h.buyer_id, h.deal_id, max(m.sent_at) as last_sent_at
      from hit h
      join public.dispo_campaign_messages m on m.recipient_id = h.id and m.sent_at is not null
     group by h.phone_key, h.email, h.buyer_id, h.deal_id
  )
  select s.phone_key, s.email, s.buyer_id, b.status, s.deal_id,
         coalesce(nullif(trim(p.line1), ''), 'Deal ' || s.deal_id) as line1,
         s.last_sent_at
    from sent s
    left join public.buyers b on b.id = s.buyer_id
    left join public.deals d on d.id = s.deal_id
    left join public.properties p on p.id = d.property_id
   order by s.last_sent_at desc
$$;

revoke all on function public.inbox_blast_tags(bigint, text[], text[]) from public, anon;
grant execute on function public.inbox_blast_tags(bigint, text[], text[]) to authenticated, service_role;
