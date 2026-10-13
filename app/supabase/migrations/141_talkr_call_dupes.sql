-- 141: one row per Talkr call (removes the webhook's duplicate copies).
--
-- talkr-webhook keyed call events on the webhook event id while call-sync and
-- lib/call-file.ts key the same call 'call:<talkr call id>', so most calls sat
-- on the record twice and the webhook copy never got a transcript. The webhook
-- now uses 'call:<id>' too. This removes the old webhook copies that have a
-- 'call:' twin (same workspace and numbers, within three minutes), after
-- copying a filing the twin lacks. Removed rows are kept, whole, in
-- communications_dupe_backup_141; webhook copies with no twin are left alone.

create table if not exists public.communications_dupe_backup_141 (like public.communications);
alter table public.communications_dupe_backup_141 enable row level security;

create temporary table _dupes as
select distinct on (b.id) b.id as dupe_id, t.id as keep_id
  from public.communications b
  join public.communications t
    on t.workspace_id = b.workspace_id and t.source = 'talkr' and t.source_id like 'call:%'
   and t.from_phone is not distinct from b.from_phone and t.to_phone is not distinct from b.to_phone
   and abs(extract(epoch from t.occurred_at - b.occurred_at)) < 180
 where b.source = 'talkr' and b.channel in ('call', 'voicemail') and b.source_id not like 'call:%'
 order by b.id, abs(extract(epoch from t.occurred_at - b.occurred_at));

update public.communications t
   set seller_id = b.seller_id, buyer_id = b.buyer_id, property_id = coalesce(t.property_id, b.property_id)
  from _dupes d join public.communications b on b.id = d.dupe_id
 where t.id = d.keep_id and t.seller_id is null and t.buyer_id is null
   and (b.seller_id is not null or b.buyer_id is not null);

insert into public.communications_dupe_backup_141
select c.* from public.communications c join _dupes d on d.dupe_id = c.id
 where not exists (select 1 from public.communications_dupe_backup_141 k where k.id = c.id);

delete from public.communications c using _dupes d where c.id = d.dupe_id;

drop table _dupes;
