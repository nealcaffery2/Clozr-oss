-- 260 · "Last contact" as two columns on the seller, kept by a trigger.
--
-- Every full load of the CRM ran seller_last_touch(ws) (167): one lateral
-- index probe into communications per live seller, on every open of People
-- and every save that reloaded the workspace.
--
-- The answer is a property of the seller, so it lives on the row:
-- sellers.last_touch_at and sellers.last_touch_channel are the time and
-- channel of the seller's newest communication. communications_last_touch
-- keeps them: after an insert, a delete, or an update that moves a row to
-- another seller or changes when or how it happened, the seller (and the one
-- the row left) is recomputed from one probe of communications_seller_idx
-- and written only when the value changed, so a Podio backfill of old
-- history does not rewrite the seller. The write bumps sellers.updated_at
-- (sellers_touch), which is what lets crm_sellers' delta (259) carry the new
-- last touch to the client on the next reload.
--
-- crm_sellers (259) returns the two columns on the row, so the client has no
-- separate read. seller_last_touch stays for the paged fallback (a client
-- that paged the table) and now reads the columns: one index scan of
-- sellers, no probe per seller. Security definer on the trigger: a rep whose
-- role can file a communication may not be allowed to update the seller, and
-- the touch must land either way. One thing changes for a rep whose role
-- cannot read some emails (can_read_email): the old function skipped those,
-- this one counts them, so "Last contact" can say EMAIL · 2d ago for a mail
-- they cannot open. Only the time and the channel show; the mail itself
-- stays behind its policy.
--
-- The backfill runs over sellers in id ranges of 5,000 so one statement
-- stays well under a statement timeout.
-- Safe to re-run: columns and trigger are idempotent, and the backfill
-- writes only rows whose value differs.

alter table public.sellers
  add column if not exists last_touch_at timestamptz,
  add column if not exists last_touch_channel text;

-- One seller's newest communication onto the seller. Null seller: nothing.
-- No communication left: both columns null.
create or replace function public.seller_last_touch_set(p_seller bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
begin
  if p_seller is null then return; end if;
  select channel, occurred_at into c
    from public.communications
   where seller_id = p_seller
   order by occurred_at desc, id desc
   limit 1;
  update public.sellers
     set last_touch_at = c.occurred_at, last_touch_channel = c.channel
   where id = p_seller
     and (last_touch_at is distinct from c.occurred_at or last_touch_channel is distinct from c.channel);
end $$;

revoke all on function public.seller_last_touch_set(bigint) from public, anon, authenticated;

create or replace function public.communications_last_touch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.seller_last_touch_set(old.seller_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.seller_id is distinct from old.seller_id) then
    perform public.seller_last_touch_set(new.seller_id);
  end if;
  return null;
end $$;

drop trigger if exists communications_last_touch on public.communications;
create trigger communications_last_touch
  after insert or delete or update of seller_id, occurred_at, channel on public.communications
  for each row execute function public.communications_last_touch();

-- Backfill, by seller id range. Each batch is one DISTINCT ON pass over the
-- communications of those sellers on communications_seller_idx.
do $$
declare
  lo bigint;
  hi bigint;
  step constant bigint := 5000;
begin
  select min(id), max(id) into lo, hi from public.sellers;
  if lo is null then return; end if;
  while lo <= hi loop
    update public.sellers s
       set last_touch_at = c.occurred_at, last_touch_channel = c.channel
      from (select distinct on (seller_id) seller_id, channel, occurred_at
              from public.communications
             where seller_id >= lo and seller_id < lo + step
             order by seller_id, occurred_at desc, id desc) c
     where s.id = c.seller_id and s.id >= lo and s.id < lo + step
       and (s.last_touch_at is distinct from c.occurred_at or s.last_touch_channel is distinct from c.channel);
    lo := lo + step;
  end loop;
end $$;

-- The same answer as before, from the columns: one scan of the live sellers.
create or replace function public.seller_last_touch(p_workspace bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'channel', s.last_touch_channel,
    'occurred_at', s.last_touch_at
  )), '[]'::jsonb)
  from public.sellers s
  where s.workspace_id = p_workspace
    and s.archived_at is null
    and s.last_touch_at is not null;
$$;

-- crm_sellers (259) with the two columns on the row. Same body otherwise.
create or replace function public.crm_sellers(p_ws bigint, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then jsonb_build_object(
      'ids', case when p_since is null then null else coalesce((
        select jsonb_agg(s.id order by s.id)
          from public.sellers s
         where s.workspace_id = p_ws and s.archived_at is null), '[]'::jsonb) end,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) || jsonb_build_object('properties', (
                 select jsonb_build_object(
                   'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                   'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                   'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng)
                   from public.properties p where p.id = x.property_id and p.workspace_id = p_ws))
               order by x.created_at desc, x.id desc)
          from (
            select s.id, s.name, s.email, s.phone, s.property_address, s.asking_price, s.motivation, s.timeline,
                   s.condition, s.occupancy, s.mortgage, s.desired_close, s.decision_makers, s.intake, s.lead_stage,
                   s.stage_entered_at, s.notes, s.source, s.created_at, s.created_by, s.property_id, s.assigned_to,
                   s.tags, s.updated_at, s.underwriter_id, s.last_touch_at, s.last_touch_channel
              from public.sellers s
             where s.workspace_id = p_ws and s.archived_at is null
               and (p_since is null or s.updated_at >= p_since
                    or exists (select 1 from public.properties p where p.id = s.property_id and p.workspace_id = p_ws and p.updated_at >= p_since))
          ) x), '[]'::jsonb))
    else null
  end;
$$;

revoke all on function public.crm_sellers(bigint, timestamptz) from public, anon;
grant execute on function public.crm_sellers(bigint, timestamptz) to authenticated, service_role;
