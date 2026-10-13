-- 91 · Incoming submissions, underwriting pings, source score, national skip.
--
-- A new submission that still needs an offer is assigned to whoever created
-- the lead. An import stamps that same person on every row, so a batch belongs
-- to the importer.
--
-- Moving a seller to Underwriting Complete notifies the person assigned to
-- the record.
--
-- A wholesaler source gets a true count (brought, accepted, declined, closed,
-- fees) and, unless they are a national / institutional source, a weekly
-- email task asking if they have another deal. The Action plans screen also
-- inserts the New source weekly plan, which skips the National tags.

alter table public.vendors
  add column if not exists tags text[] not null default '{}',
  add column if not exists deals_brought integer not null default 0,
  add column if not exists offers_sent integer not null default 0,
  add column if not exists offers_accepted integer not null default 0,
  add column if not exists deals_declined integer not null default 0,
  add column if not exists deals_closed integer not null default 0,
  add column if not exists fees_earned numeric not null default 0;

create or replace function public.source_is_national(p_type text, p_name text, p_notes text, p_tags text[])
returns boolean
language sql immutable
as $$
  select coalesce(p_type, '') ~* 'institutional|national'
      or coalesce(p_name, '') ~* 'institutional|national'
      or coalesce(p_notes, '') ~* 'national partner|national source|\ynational\y'
      or coalesce(p_tags, '{}') && array['National', 'National partner'];
$$;

create or replace function public.refresh_vendor_source_stats(p_vendor bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_brought integer;
  v_sent integer;
  v_accepted integer;
  v_declined integer;
  v_closed integer;
  v_fees numeric;
begin
  if p_vendor is null then return; end if;
  select count(*)::integer,
         count(*) filter (where d.offer_amount is not null)::integer,
         count(*) filter (where coalesce(d.lead_stage, '') in ('Offer Accepted', 'Under Contract - Seller', 'Under Contract - Buyer', 'Closed')
                            or d.stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed'))::integer,
         count(*) filter (where d.stage = 'Terminated'
                            or coalesce(d.lead_stage, '') in ('Offer Declined', 'Underwrite Declined'))::integer,
         count(*) filter (where d.stage = 'Closed' or d.lead_stage = 'Closed')::integer,
         coalesce(sum(d.final_profit) filter (where d.stage = 'Closed' or d.lead_stage = 'Closed'), 0)
    into v_brought, v_sent, v_accepted, v_declined, v_closed, v_fees
    from public.deal_parties dp
    join public.deals d on d.id = dp.deal_id
   where dp.vendor_id = p_vendor and dp.role = 'wholesaler';
  update public.vendors
     set deals_brought = v_brought,
         offers_sent = v_sent,
         offers_accepted = v_accepted,
         deals_declined = v_declined,
         deals_closed = v_closed,
         fees_earned = v_fees,
         updated_at = now()
   where id = p_vendor;
end;
$$;

-- Weekly "any other deals?" emails. National sources get one task that says
-- not to email them, and nothing else.
create or replace function public.queue_source_followup(p_vendor bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v record;
  bodies text[] := array[
    'Business casual. Ask if they have another deal we can look at today, even if the numbers are rough.',
    'Different ask: what else are they working this week? Assignment, JV, double close, and novation are all fine.',
    'Different ask: anything new on their desk? An address and an ask is enough to underwrite.',
    'Different ask: offer to look before they shop the deal around.'
  ];
  i integer;
begin
  select * into v from public.vendors where id = p_vendor;
  if not found then return; end if;
  if v.service_type is distinct from 'Wholesaler' and v.service_type is distinct from 'Institutional seller' then
    return;
  end if;
  if exists (select 1 from public.tasks where notes like 'source-followup:' || p_vendor::text || '%') then
    return;
  end if;
  if public.source_is_national(v.service_type, v.business_name, v.notes, v.tags) then
    insert into public.tasks (workspace_id, title, task_type, priority, due_at, assigned_to, notes, created_by)
    values (v.workspace_id, 'National source — do not email', 'todo', 'normal', now(), v.created_by,
            'source-followup:' || p_vendor::text || E'\n' || v.business_name || ' is a national source. Log the deals they bring. Do not put them on the weekly email.',
            v.created_by);
    return;
  end if;
  if v.created_by is null then return; end if;
  for i in 1..4 loop
    insert into public.tasks (workspace_id, title, task_type, priority, due_at, assigned_to, notes, created_by)
    values (v.workspace_id,
            'Email ' || coalesce(v.business_name, 'source') || ' — week ' || i,
            'email', 'normal', now() + make_interval(days => (i - 1) * 7), v.created_by,
            'source-followup:' || p_vendor::text || E'\nTo: ' || coalesce(v.email, '(no email on file)') || E'\n' || bodies[i],
            v.created_by);
  end loop;
end;
$$;

create or replace function public.assign_incoming_submission()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.assigned_to is null and new.created_by is not null
     and coalesce(new.lead_stage, '') in (
       'New Submission', 'Underwriting', 'Make Offer', 'New Lead', 'Lead', 'Lead - No Contact'
     ) then
    new.assigned_to := new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists sellers_assign_incoming on public.sellers;
create trigger sellers_assign_incoming
  before insert on public.sellers
  for each row execute function public.assign_incoming_submission();

create or replace function public.notify_underwrite_complete()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_who uuid;
begin
  if tg_op = 'UPDATE'
     and new.lead_stage = 'Underwriting Complete'
     and old.lead_stage is distinct from 'Underwriting Complete' then
    v_who := coalesce(new.assigned_to, new.created_by);
    if v_who is not null then
      insert into public.notifications (workspace_id, user_id, category, title, body, seller_id)
      values (new.workspace_id, v_who, 'Underwriting', 'Underwriting complete',
              coalesce(nullif(trim(new.name), ''), 'A submission') || ' is underwriting complete.',
              new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sellers_underwrite_complete on public.sellers;
create trigger sellers_underwrite_complete
  after update of lead_stage on public.sellers
  for each row execute function public.notify_underwrite_complete();

create or replace function public.vendor_source_after_write()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.queue_source_followup(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists vendors_source_followup on public.vendors;
create trigger vendors_source_followup
  after insert on public.vendors
  for each row execute function public.vendor_source_after_write();

create or replace function public.deal_party_source_stats()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.role = 'wholesaler' and new.vendor_id is not null then
    perform public.refresh_vendor_source_stats(new.vendor_id);
    perform public.queue_source_followup(new.vendor_id);
  elsif tg_op = 'DELETE' and old.role = 'wholesaler' and old.vendor_id is not null then
    perform public.refresh_vendor_source_stats(old.vendor_id);
  elsif tg_op = 'UPDATE' and (new.vendor_id is distinct from old.vendor_id or new.role is distinct from old.role) then
    if old.vendor_id is not null then perform public.refresh_vendor_source_stats(old.vendor_id); end if;
    if new.vendor_id is not null and new.role = 'wholesaler' then perform public.refresh_vendor_source_stats(new.vendor_id); end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists deal_parties_source_stats on public.deal_parties;
create trigger deal_parties_source_stats
  after insert or update or delete on public.deal_parties
  for each row execute function public.deal_party_source_stats();

create or replace function public.deals_refresh_source_stats()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  r record;
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage
     and new.lead_stage is not distinct from old.lead_stage
     and new.offer_amount is not distinct from old.offer_amount then
    return new;
  end if;
  for r in select vendor_id from public.deal_parties where deal_id = new.id and role = 'wholesaler' and vendor_id is not null loop
    perform public.refresh_vendor_source_stats(r.vendor_id);
  end loop;
  return new;
end;
$$;

drop trigger if exists deals_refresh_source_stats on public.deals;
create trigger deals_refresh_source_stats
  after update of stage, lead_stage, offer_amount on public.deals
  for each row execute function public.deals_refresh_source_stats();

-- Catalog plans refuse to enroll a seller wearing a skip tag (National).
create or replace function public.plan_skipped_by_tag(p_tags text[], p_settings jsonb)
returns boolean
language sql immutable
as $$
  select exists (
    select 1
      from jsonb_array_elements_text(coalesce(p_settings->'skip_tags', '[]'::jsonb)) s(tag)
     where s.tag = any (coalesce(p_tags, '{}'))
  );
$$;

create or replace function public.plan_on_seller_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  e record;
  p record;
begin
  if tg_op = 'INSERT' then
    for p in select id, settings from action_plans where workspace_id = new.workspace_id and active and trigger_type = 'new_lead' loop
      if public.plan_skipped_by_tag(new.tags, p.settings) then continue; end if;
      perform plan_enroll(new.workspace_id, p.id, new.id, new.created_by);
    end loop;
    return new;
  end if;

  if new.lead_stage is distinct from old.lead_stage then
    for e in
      select en.id from enrollments en join action_plans pl on pl.id = en.plan_id
      where en.seller_id = new.id and en.status = 'active'
        and coalesce((pl.settings ->> 'stop_on_stage')::boolean, false)
    loop
      perform plan_stop_enrollment(e.id, 'stage');
    end loop;
    for p in
      select id, settings from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'stage' and trigger_value = new.lead_stage
    loop
      if public.plan_skipped_by_tag(new.tags, p.settings) then continue; end if;
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;

  if new.tags is distinct from old.tags then
    for p in
      select id, settings from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'tag'
        and trigger_value = any(new.tags) and not (trigger_value = any(coalesce(old.tags, '{}')))
    loop
      if public.plan_skipped_by_tag(new.tags, p.settings) then continue; end if;
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;
  return new;
end;
$$;

revoke execute on function public.source_is_national(text, text, text, text[]) from public, anon, authenticated;
revoke execute on function public.refresh_vendor_source_stats(bigint) from public, anon, authenticated;
revoke execute on function public.queue_source_followup(bigint) from public, anon, authenticated;
revoke execute on function public.assign_incoming_submission() from public, anon, authenticated;
revoke execute on function public.notify_underwrite_complete() from public, anon, authenticated;
revoke execute on function public.vendor_source_after_write() from public, anon, authenticated;
revoke execute on function public.deal_party_source_stats() from public, anon, authenticated;
revoke execute on function public.deals_refresh_source_stats() from public, anon, authenticated;
revoke execute on function public.plan_skipped_by_tag(text[], jsonb) from public, anon, authenticated;
revoke execute on function public.plan_on_seller_change() from public, anon, authenticated;
