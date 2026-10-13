-- 163 · Low offer, high offer and offer price follow Podio both ways; Make
-- offer reaches Podio; Partnerships makes offers.
--
-- Asked for by the owner on 2026-10-05.
--
-- * Podio → CLOZR: the sync (podio-import, podio-sync.ts readSubmission) now
--   reads "UW Suggested Low Offer" into deals.wholesale_offer and "UW Suggested
--   High Offer" into deals.institutional_offer (the low / high on the Offer
--   card). Submissions' sync cursor is cleared once below, so the next runs
--   read every item again and fill the amounts already in Podio (the sync's
--   rule: a CLOZR value is not overwritten by one Podio has not changed).
-- * CLOZR → Podio: podio_outbox (160) takes a second kind of row, 'values':
--   the amounts a person changed in CLOZR (typing over the low or high, a
--   provider run, Make offer), merged into one pending row per item. The trigger
--   podio_outbox_values queues them; podio-import marks its own writes with
--   the request header x-clozr-source: podio, so Podio's amounts are never
--   sent back to Podio, and an amount the ledger says Podio already has is
--   not queued.
-- * Make offer: the offers function writes with the service role, so the
--   submission's move to Offer Made (offers_after_write, 145) was logged with
--   no person and never went to Podio. offers_after_write now names the
--   offer's maker (clozr.actor, transaction-local) and stage_events_log reads
--   it when there is no signed-in user, so the move and the offer price both
--   reach Podio on the next run. A new offer on a submission at Underwrite
--   Declined or Offer Declined now moves it to Offer Made too.
-- * Partnerships (158) can make offers and record counters on
--   sellers and submissions, like acquisitions (the offers function's role
--   list follows).

-- ------------------------------------------------------------ Partnerships
drop policy if exists offers_seller_acquisitions on public.offers;
create policy offers_seller_acquisitions on public.offers for all to authenticated
  using (public.has_role(workspace_id, variadic array['acquisitions', 'partnerships']) and seller_id is not null and buyer_id is null)
  with check (public.has_role(workspace_id, variadic array['acquisitions', 'partnerships']) and seller_id is not null and buyer_id is null);

-- ------------------------------------------------------------ who made the move
create or replace function public.stage_events_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ins boolean := tg_op = 'INSERT';
  -- The signed-in user; else the person a server-side write named (offers_after_write).
  v_by uuid := coalesce(auth.uid(), nullif(current_setting('clozr.actor', true), '')::uuid);
begin
  if tg_table_name = 'sellers' then
    if new.lead_stage is not null and (ins or new.lead_stage is distinct from old.lead_stage) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'seller', new.id, 'lead_stage', case when ins then null else old.lead_stage end, new.lead_stage, v_by);
    end if;
  elsif tg_table_name = 'deals' then
    -- Prospect is where every deal starts; reaching it is not a stage move.
    if new.stage is not null and ((ins and new.stage <> 'Prospect') or (not ins and new.stage is distinct from old.stage)) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'deal', new.id, 'stage', case when ins then null else old.stage end, new.stage, v_by);
    end if;
    if new.lead_stage is not null and (ins or new.lead_stage is distinct from old.lead_stage) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'deal', new.id, 'lead_stage', case when ins then null else old.lead_stage end, new.lead_stage, v_by);
    end if;
  elsif tg_table_name = 'buyers' then
    -- Older rows say 'active', newer ones 'Active': a change of case is not a move.
    if new.status is not null and lower(new.status) is distinct from lower(old.status) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'buyer', new.id, 'status', old.status, new.status, v_by);
    end if;
  end if;
  return null;
end $$;
revoke all on function public.stage_events_log() from public, anon, authenticated;

-- 145's function, with the offer's maker named for the writes it makes.
create or replace function public.offers_after_write()
returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare
  cur_sort integer;
  v_deal_stage text;
  v_title text;
begin
  if pg_trigger_depth() > 1 or new.seller_id is null then return new; end if;

  -- A counter from the seller or partner: a line on the timeline, nothing else.
  if new.direction = 'inbound' then
    if tg_op = 'INSERT' and new.buyer_id is null then
      v_title := 'Counter ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—');
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
      values (new.workspace_id, 'seller', new.seller_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      if new.deal_id is not null and exists (select 1 from public.deals where id = new.deal_id and lead_stage is not null) then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
        values (new.workspace_id, 'deal', new.deal_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      end if;
    end if;
    return new;
  end if;
  if new.direction <> 'outbound' then return new; end if;

  -- The stage moves and the offer price below are this person's (stage_events_log,
  -- podio_outbox_values), also when the offers function wrote the row.
  if new.created_by is not null then perform set_config('clozr.actor', new.created_by::text, true); end if;

  if new.deal_id is not null and new.amount is not null then
    update public.deals set offer_amount = new.amount, updated_at = now() where id = new.deal_id;
  end if;
  if tg_op = 'INSERT' then
    select s.sort into cur_sort from public.sellers x join public.seller_stages s on s.label = x.lead_stage where x.id = new.seller_id;
    if cur_sort is null or cur_sort < 130 then
      update public.sellers set lead_stage = 'Offer Made' where id = new.seller_id;
    end if;
    v_title := 'Offer made ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—') || coalesce(' · ' || new.basis, '');
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
    values (new.workspace_id, 'seller', new.seller_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);

    -- The partner submission the offer is on.
    if new.deal_id is not null then
      select lead_stage into v_deal_stage from public.deals where id = new.deal_id;
      if v_deal_stage is not null then
        -- A new offer after a decline reopens it (Underwrite Declined, Offer Declined); accepted, in inspections or at auction stays.
        if v_deal_stage in ('New Submission', 'Lead', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete', 'Pending Response',
                            'Underwrite Declined', 'Offer Declined') then
          update public.deals set lead_stage = 'Offer Made', updated_at = now() where id = new.deal_id;
        end if;
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
        values (new.workspace_id, 'deal', new.deal_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      end if;
    end if;
  end if;

  perform set_config('clozr.actor', '', true);
  return new;
end $$;

-- ------------------------------------------------------------ the outbox's amounts
alter table public.podio_outbox add column if not exists kind text not null default 'stage';
alter table public.podio_outbox add column if not exists vals jsonb;
alter table public.podio_outbox alter column to_stage drop not null;
alter table public.podio_outbox drop constraint if exists podio_outbox_kind_check;
alter table public.podio_outbox add constraint podio_outbox_kind_check
  check ((kind = 'stage' and to_stage is not null) or (kind = 'values' and vals is not null));

-- 160's enqueue: a newer stage move supersedes only stage rows, never queued amounts.
create or replace function public.podio_outbox_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.entity_type <> 'deal' or new.field <> 'lead_stage' or new.changed_by is null
     or coalesce(btrim(new.to_stage), '') = '' then
    return null;
  end if;
  if not exists (select 1 from public.podio_items pi
                  where pi.deal_id = new.entity_id and pi.workspace_id = new.workspace_id and pi.app_key = 'submissions') then
    return null;
  end if;
  update public.podio_outbox o set status = 'superseded', done_at = now(), result = 'A newer move of this submission replaced it.'
   where o.deal_id = new.entity_id and o.workspace_id = new.workspace_id and o.status = 'pending' and o.kind = 'stage';
  insert into public.podio_outbox (workspace_id, item_id, deal_id, kind, to_stage, podio_stage_at_move, moved_at, moved_by)
  select new.workspace_id, pi.item_id, pi.deal_id, 'stage', btrim(new.to_stage), pi.podio_stage, new.changed_at, new.changed_by
    from public.podio_items pi
   where pi.deal_id = new.entity_id and pi.workspace_id = new.workspace_id and pi.app_key = 'submissions';
  return null;
end $$;
revoke all on function public.podio_outbox_enqueue() from public, anon, authenticated;

-- A submission's low offer, high offer or offer price changed outside the Podio
-- sync: queued for its Submissions items, merged into the item's pending row.
create or replace function public.podio_outbox_values() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src text;
  v_vals jsonb := '{}';
  v_item jsonb;
  v_by uuid := coalesce(auth.uid(), nullif(current_setting('clozr.actor', true), '')::uuid);
  r record;
begin
  -- podio-import's own writes are Podio's amounts already.
  begin
    v_src := nullif(current_setting('request.headers', true), '')::json ->> 'x-clozr-source';
  exception when others then v_src := null;
  end;
  if v_src = 'podio' then return null; end if;

  if new.wholesale_offer is not null and new.wholesale_offer is distinct from old.wholesale_offer then
    v_vals := v_vals || jsonb_build_object('wholesale_offer', new.wholesale_offer);
  end if;
  if new.institutional_offer is not null and new.institutional_offer is distinct from old.institutional_offer then
    v_vals := v_vals || jsonb_build_object('institutional_offer', new.institutional_offer);
  end if;
  if new.offer_amount is not null and new.offer_amount is distinct from old.offer_amount then
    v_vals := v_vals || jsonb_build_object('offer_amount', new.offer_amount);
  end if;
  if v_vals = '{}'::jsonb then return null; end if;

  for r in select pi.item_id, pi.applied from public.podio_items pi
            where pi.deal_id = new.id and pi.workspace_id = new.workspace_id and pi.app_key = 'submissions' loop
    -- Leave out what the ledger says Podio already has.
    select jsonb_object_agg(e.key, e.value) into v_item
      from jsonb_each(v_vals) e
     where not (coalesce(r.applied ->> e.key, '') ~ '^-?[0-9]+(\.[0-9]+)?$'
                and abs((r.applied ->> e.key)::numeric - (e.value #>> '{}')::numeric) < 0.005);
    if v_item is null then continue; end if;
    update public.podio_outbox o
       set vals = o.vals || v_item, moved_at = now(), moved_by = coalesce(v_by, o.moved_by), attempts = 0, result = null
     where o.workspace_id = new.workspace_id and o.item_id = r.item_id and o.kind = 'values' and o.status = 'pending';
    if not found then
      insert into public.podio_outbox (workspace_id, item_id, deal_id, kind, vals, moved_at, moved_by)
      values (new.workspace_id, r.item_id, new.id, 'values', v_item, now(), v_by);
    end if;
  end loop;
  return null;
end $$;
revoke all on function public.podio_outbox_values() from public, anon, authenticated;

drop trigger if exists podio_outbox_values on public.deals;
create trigger podio_outbox_values after update of wholesale_offer, institutional_offer, offer_amount on public.deals
  for each row execute function public.podio_outbox_values();

-- ------------------------------------------------------------ backfill from Podio
-- One full read of Submissions, so the low / high already in Podio fill in (the
-- pass after it goes back to reading only what Podio touched). Run again, it
-- only costs another read.
update public.podio_connections
   set sync_cursor = sync_cursor - 'submissions'
 where sync_cursor ? 'submissions';
