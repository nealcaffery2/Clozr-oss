-- 49 · One contact per partner, every submission its own deal.
--
-- The Podio import made a seller row per submission, named after the partner
-- that sent it (hundreds of rows for a single partner). A partner is one contact;
-- what repeats is the property. Each duplicate seller had exactly one deal, so
-- the submission's own facts move onto that deal (its lead stage, asking price,
-- motivation, when it came in, its notes) and the deal is re-pointed at the
-- partner's single contact. The deal already carries its property.
--
-- The contact keeps the stage of its most recent submission. Every row that
-- pointed at a merged seller is re-pointed. _seller_merge_20260913 records
-- old → new with the old row, so the merge can be audited or undone.

alter table public.deals
  add column if not exists lead_stage   text,
  add column if not exists asking_price numeric,
  add column if not exists motivation   text,
  add column if not exists submitted_at timestamptz;

create table if not exists public._seller_merge_20260913 as
select s.id as old_id, s.id as new_id, s.* from public.sellers s where false;
revoke all on public._seller_merge_20260913 from anon, authenticated;

do $$
begin
  -- Groups: Podio submissions sharing a partner name.
  insert into public._seller_merge_20260913
  select s.id, first_value(s.id) over (partition by s.workspace_id, lower(trim(s.name)) order by s.id), s.*
  from public.sellers s
  where s.source = 'podio' and s.name <> ''
    and (s.workspace_id, lower(trim(s.name))) in (
      select workspace_id, lower(trim(name)) from public.sellers where source = 'podio' and name <> ''
      group by 1, 2 having count(*) > 1);

  -- The submission's facts onto its deal (canonical included).
  update public.deals d set
    lead_stage   = coalesce(d.lead_stage, m.lead_stage),
    asking_price = coalesce(d.asking_price, m.asking_price),
    motivation   = coalesce(d.motivation, m.motivation),
    submitted_at = coalesce(d.submitted_at, m.created_at),
    notes        = case when m.notes is null or m.notes = '' or coalesce(d.notes, '') like '%' || m.notes || '%' then d.notes
                        else concat_ws(E'\n\n', nullif(d.notes, ''), m.notes) end
  from public._seller_merge_20260913 m where d.seller_id = m.old_id;

  -- Re-point everything at the partner's one contact.
  update public.deals          t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.deal_parties   t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.communications t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.tasks          t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.appointments   t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.transactions   t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.contracts      t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.offers         t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.enrollments    t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.notifications  t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.discover_runs  t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.ingest_events  t set seller_id = m.new_id from public._seller_merge_20260913 m where t.seller_id = m.old_id and m.old_id <> m.new_id;
  update public.activity       t set entity_id = m.new_id from public._seller_merge_20260913 m where t.entity_type = 'seller' and t.entity_id = m.old_id and m.old_id <> m.new_id;

  -- The contact: latest submission's stage and property, tags and owner from all of them.
  -- Written without the stage triggers: the deals already hold their own stages.
  set local session_replication_role = replica;
  update public.sellers s set
    lead_stage  = latest.lead_stage,
    property_id = latest.property_id,
    property_address = latest.property_address,
    tags        = agg.tags,
    assigned_to = coalesce(s.assigned_to, agg.assigned_to),
    updated_at  = now()
  from (select distinct on (new_id) new_id, lead_stage, property_id, property_address from public._seller_merge_20260913 order by new_id, created_at desc, old_id desc) latest,
       (select new_id, array(select distinct unnest(array_agg(tags_flat))) as tags, (array_agg(assigned_to) filter (where assigned_to is not null))[1] as assigned_to
          from (select new_id, unnest(case when cardinality(tags) = 0 then array[null::text] else tags end) as tags_flat, assigned_to from public._seller_merge_20260913) f
         group by new_id) agg
  where s.id = latest.new_id and agg.new_id = latest.new_id;
  update public.sellers s set tags = array_remove(tags, null) where s.id in (select new_id from public._seller_merge_20260913);
  set local session_replication_role = origin;

  delete from public.sellers s using public._seller_merge_20260913 m where s.id = m.old_id and m.old_id <> m.new_id;
end $$;
