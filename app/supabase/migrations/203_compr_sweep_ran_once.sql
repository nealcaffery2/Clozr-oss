-- 203: a house the underwriting provider already ran is not run again by
-- the sweep.
--
-- The 2-minute sweep (176, 184) picks a deal with no provider report link. A
-- run whose reply came back without a report URL saved no link, so the deal
-- looked un-run and was run again the next day under a new lead id. This
-- makes the sweep:
--
-- 1. skip any deal with a run in the ledger (compr_underwrites, 143) in the
--    last 14 days, link or not, so one missed write can never become a
--    daily run, and
-- 2. skip a property whose street has no house number ("Durham, NC 27701"):
--    the provider would price whatever house it geocoded to.
--
-- (In the hosted product this also restored report links from the ledger on
-- existing deals; that one-time data repair is not part of the open-source
-- release.)

create or replace function public.compr_photo_sweep_candidates(p_workspace_id bigint, p_limit integer default 15)
returns table(deal_id bigint, seller_id bigint)
language sql stable security definer set search_path to 'public'
as $function$
  select d.id, d.seller_id
  from public.deals d
  where d.workspace_id = p_workspace_id
    and d.archived_at is null and d.seller_id is not null and d.property_id is not null
    -- 203: no house number, no run (compr-underwrite refuses it too).
    and exists (select 1 from public.properties p where p.id = d.property_id and p.line1 ~ '^\s*\d')
    -- A declined or dead house is not worth a run.
    and coalesce(d.lead_stage, '') not in ('Offer Declined', 'Underwrite Declined', 'Dead')
    and coalesce(d.underwriting_url, '') not ilike '%underwriting.example.com%'
    and coalesce(d.compr_report_url, '') not ilike '%underwriting.example.com%'
    -- 203: ran in the last two weeks, link or not, means done.
    and not exists (
      select 1 from public.compr_underwrites u
       where u.deal_id = d.id and u.source = 'run' and u.created_at > now() - interval '14 days')
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
$function$;
revoke execute on function public.compr_photo_sweep_candidates(bigint, integer) from public, anon, authenticated;
