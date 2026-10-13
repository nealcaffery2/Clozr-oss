-- 63 · Underwriting provider marketing assets on the deal, public listing photos, marketplace opt-in.
--
-- The dispo blast merges {{photo_url}} {{marketing_link}}
-- {{photos_link}} {{comps_link}}. Those used to come from a private upload,
-- an empty marketing_url, and the seller underwriting spreadsheet. compr-underwrite
-- now writes the provider's public buyer report, tokenized photo-set URLs, and a
-- buyer CMA PDF onto the deal so the blast can actually be clicked.
--
-- The listing function lists Ready To Market deals on /listing/market (the
-- company marketplace) and buyers_list_opt_in is the join-the-list form.

alter table public.deals
  add column if not exists hero_image_url text,
  add column if not exists buyer_report_url text,
  add column if not exists compr_cma_url text;

comment on column public.deals.buyer_report_url is 'Public underwriting provider buyer report (<provider>/v/<token>). Fills {{marketing_link}}.';
comment on column public.deals.compr_cma_url is 'Downloadable buyer CMA PDF built from provider comps. Fills {{comps_link}}.';

alter table public.deal_files
  add column if not exists visible_to_buyers boolean not null default false,
  add column if not exists caption text,
  add column if not exists is_cover boolean not null default false,
  add column if not exists position integer not null default 0;

-- Public https photos (provider proxy, pasted links) can go in an email and on
-- the listing; private uploads stay off those surfaces until someone marks them.
update public.deal_files
   set visible_to_buyers = true
 where kind = 'photo'
   and url is not null
   and url like 'https://%'
   and storage_path is null
   and visible_to_buyers = false;

alter table public.deal_public_links
  add column if not exists on_marketplace boolean not null default true;

-- Public CMA PDFs (and nothing else). Path: ws/<workspace_id>/deals/<deal_id>/cma.pdf
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('deal-public', 'deal-public', true)
    on conflict (id) do nothing;
    execute 'drop policy if exists deal_public_read on storage.objects';
    execute $p$create policy deal_public_read on storage.objects for select to public
      using (bucket_id = 'deal-public')$p$;
    execute 'drop policy if exists deal_public_write on storage.objects';
    execute $p$create policy deal_public_write on storage.objects for all to authenticated
      using (bucket_id = 'deal-public' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))
      with check (bucket_id = 'deal-public' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
  end if;
end $$;

/**
 * Join the buyers list from the public marketplace. Service role only — the
 * listing function checks the honeypot and rate limit first.
 *
 * Matches an existing buyer on email or phone and refreshes them; otherwise
 * inserts. Never blanks a field. Returns { buyer_id, created }.
 */
create or replace function public.buyers_list_opt_in(
  p_workspace_id bigint,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_markets text[] default '{}',
  p_strategy text default null,
  p_sms_ok boolean default false,
  p_deal_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_name text := left(trim(coalesce(p_name, '')), 120);
  v_email text := lower(left(trim(coalesce(p_email, '')), 200));
  v_phone text := public.normalize_phone(p_phone);
  v_markets text[] := coalesce(p_markets, '{}');
  v_buyer bigint;
  v_created boolean := false;
  v_channel text;
  v_tags text[] := array['buyers-list-opt-in'];
begin
  if p_workspace_id is null or not exists (select 1 from public.workspaces where id = p_workspace_id) then
    raise exception 'workspace not found' using errcode = '22023';
  end if;
  if v_email = '' then v_email := null; end if;
  if v_name = '' then v_name := coalesce(v_email, p_phone, 'Investor'); end if;
  if v_email is null and v_phone is null then
    raise exception 'email or phone is required' using errcode = '22023';
  end if;
  v_channel := case when p_sms_ok and v_phone is not null and v_email is not null then 'email_and_sms'
                    when p_sms_ok and v_phone is not null then 'sms_only'
                    else 'email_only' end;
  if p_strategy is not null and length(trim(p_strategy)) > 0 then
    v_tags := v_tags || array[left(trim(p_strategy), 40)];
  end if;

  select id into v_buyer from public.buyers
   where workspace_id = p_workspace_id
     and ((v_email is not null and lower(email) = v_email) or (v_phone is not null and phone_key = v_phone))
   order by id limit 1;

  if v_buyer is null then
    insert into public.buyers (
      workspace_id, name, email, phone, markets, status, source, source_id,
      tags, preferred_channel, wants_calls, wants_follow_ups, wants_sold_alerts
    ) values (
      p_workspace_id, v_name, v_email, p_phone, v_markets, 'Active', 'marketplace',
      'opt-in:' || coalesce(v_email, v_phone),
      v_tags, v_channel, p_sms_ok, true, true
    ) returning id into v_buyer;
    v_created := true;
  else
    update public.buyers set
      name = case when name is null or name = '' then v_name else name end,
      email = coalesce(email, v_email),
      phone = coalesce(phone, p_phone),
      markets = case when cardinality(v_markets) > 0 then (select array(select distinct unnest(coalesce(markets, '{}') || v_markets))) else markets end,
      tags = (select array(select distinct unnest(coalesce(tags, '{}') || v_tags))),
      status = case when status ilike 'inactive' then 'Active' else status end,
      preferred_channel = case when p_sms_ok then v_channel else preferred_channel end,
      wants_follow_ups = true,
      updated_at = now()
     where id = v_buyer;
  end if;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
  values (p_workspace_id, 'buyer', v_buyer, 'opt_in',
          case when v_created then 'Joined the buyers list' else 'Updated buyers-list opt-in' end,
          case when p_deal_id is not null then 'From marketplace deal ' || p_deal_id::text else 'From the marketplace' end);

  if v_created then
    begin
      perform public.match_buyer(p_buyer_id => v_buyer);
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object('buyer_id', v_buyer, 'created', v_created);
end
$function$;

revoke all on function public.buyers_list_opt_in(bigint, text, text, text, text[], text, boolean, bigint) from public;
grant execute on function public.buyers_list_opt_in(bigint, text, text, text, text[], text, boolean, bigint) to service_role;
