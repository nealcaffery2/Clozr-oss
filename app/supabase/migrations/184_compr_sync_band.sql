-- 184 · The underwriting provider in step with CLOZR: a hand-set offer band stays, and every new
-- submission reaches the provider with its photos, a few at a time.
--
-- 1. deals.offer_low_set_at / offer_high_set_at: when a person typed the low
--    or the high on the CLOZR record. The provider writes the MAO and whatever still
--    follows it (high = MAO, low = high − $20k), never a side a person set;
--    clearing the field hands that side back. Podio's UW Suggested fields do
--    not count: a band Podio's sync wrote follows the provider's offer.
--    CLOZR never logged who typed a band, so the ones already typed on the
--    record are told apart by where they came from: a person's edit CLOZR
--    pushed on to Podio (podio_outbox 'values' with moved_by), or a round
--    figure on a deal Podio's sync never wrote (the provider's figures are never
--    round, and the Podio Excel import puts the UW high in mao, not here).
--    A typed high could otherwise show under a lower provider MAO. The
--    bands Podio's sync wrote are left to follow the provider.
-- 2. compr_photo_sweep_candidates: every New Submission / Underwriting house
--    with no provider report, photos or not. The sweep skipped any house that
--    had photos, so the Drive photos CLOZR had already read never reached
--    the provider and those houses opened on an empty search instead of a report.
-- 3. compr_photo_sweep_kick every 2 minutes (was hourly at :07), houses sent
--    one at a time (about 30 runs an hour): fifteen at once filled the provider's two-run
--    engine, and 13 of 15 came back "engine busy" every hour on 2026-10-08,
--    each one then parked for a day. deals.compr_sweep_tries counts the busy
--    or timed-out tries in a row, so such a house goes back in line in a few
--    minutes, three tries a day at most.

alter table public.deals
  add column if not exists offer_low_set_at timestamptz,
  add column if not exists offer_high_set_at timestamptz,
  add column if not exists compr_sweep_tries smallint not null default 0;

comment on column public.deals.offer_low_set_at is
  'When a person set the low offer (wholesale_offer) on the CLOZR record. Null: the low follows the high minus $20k.';
comment on column public.deals.offer_high_set_at is
  'When a person set the high offer (institutional_offer) on the CLOZR record. Null: the high is the provider''s offer (mao).';

with typed as (
  select d.id,
    d.wholesale_offer is not null and d.wholesale_offer % 1000 = 0 and (
      exists (select 1 from public.podio_outbox o where o.deal_id = d.id and o.kind = 'values' and o.moved_by is not null
                and o.vals -> 'wholesale_offer' = to_jsonb(d.wholesale_offer))
      or (coalesce(d.source, '') <> 'podio' and not exists (select 1 from public.podio_items p where p.deal_id = d.id))
    ) as low,
    d.institutional_offer is not null and d.institutional_offer % 1000 = 0 and (
      exists (select 1 from public.podio_outbox o where o.deal_id = d.id and o.kind = 'values' and o.moved_by is not null
                and o.vals -> 'institutional_offer' = to_jsonb(d.institutional_offer))
      or (coalesce(d.source, '') <> 'podio' and not exists (select 1 from public.podio_items p where p.deal_id = d.id))
    ) as high
  from public.deals d
  where d.offer_low_set_at is null and d.offer_high_set_at is null
    and (d.wholesale_offer is not null or d.institutional_offer is not null)
    and not (d.mao is not null and d.institutional_offer = d.mao and d.wholesale_offer = d.mao - 20000)
)
update public.deals d
   set offer_low_set_at = case when t.low then coalesce(d.updated_at, now()) end,
       offer_high_set_at = case when t.high then coalesce(d.updated_at, now()) end
  from typed t
 where t.id = d.id and (t.low or t.high);

create or replace function public.compr_photo_sweep_candidates(p_workspace_id bigint, p_limit integer default 15)
returns table (deal_id bigint, seller_id bigint) language sql stable security definer set search_path = public as $$
  select d.id, d.seller_id
  from public.deals d
  where d.workspace_id = p_workspace_id
    and d.archived_at is null and d.seller_id is not null and d.property_id is not null
    -- A declined or dead house is not worth a run.
    and coalesce(d.lead_stage, '') not in ('Offer Declined', 'Underwrite Declined', 'Dead')
    and coalesce(d.underwriting_url, '') not ilike '%underwriting.example.com%'
    and coalesce(d.compr_report_url, '') not ilike '%underwriting.example.com%'
    and (
      -- A house being underwritten goes to the provider whatever photos it has: they go with it.
      d.lead_stage in ('New Submission', 'Underwriting', 'Underwriting - Need Info')
      -- Anything else only for its photos: a link and nothing in the album yet.
      or (d.photos_url is not null and not exists (select 1 from public.deal_files f where f.deal_id = d.id and f.kind = 'photo'))
    )
    and (d.compr_photos_synced_at is null or d.compr_photos_synced_at < now() - interval '1 day')
  -- Houses being underwritten now first, then accepted, then offers out.
  order by case
      when d.lead_stage in ('New Submission', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete') then 0
      when d.lead_stage = 'Offer Accepted' then 1
      else 2 end,
    d.submitted_at desc nulls last, d.id desc
  limit greatest(1, least(coalesce(p_limit, 15), 15))
$$;
revoke execute on function public.compr_photo_sweep_candidates(bigint, integer) from public, anon, authenticated;
grant execute on function public.compr_photo_sweep_candidates(bigint, integer) to service_role;

create or replace function public.compr_photo_sweep_kick(p_workspace_id bigint default null)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text; w record; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return 0; end if;
  for w in
    select ws.id as workspace_id from public.workspaces ws
    where (p_workspace_id is null or ws.id = p_workspace_id)
      and exists (select 1 from public.compr_photo_sweep_candidates(ws.id, 1))
  loop
    -- The function runs the houses one after another and starts another only
    -- when the one before answered fast, so a tick is about one real run.
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/compr-underwrite',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('action', 'photo_sweep', 'workspace_id', w.workspace_id, 'limit', 3),
      timeout_milliseconds := 60000);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.compr_photo_sweep_kick(bigint) from public, anon, authenticated;

select cron.unschedule('clozr-compr-photo-sweep') where exists (select 1 from cron.job where jobname = 'clozr-compr-photo-sweep');
select cron.schedule('clozr-compr-photo-sweep', '*/2 * * * *', 'select public.compr_photo_sweep_kick()');
