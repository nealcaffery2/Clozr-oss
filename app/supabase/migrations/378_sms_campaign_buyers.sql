-- 378: Bulk SMS campaigns (368) for buyers.
--
-- A campaign texts sellers or buyers, never both: `contact_kind`. Compr's
-- contacts are buyers, so until now its 23,000 numbers could only be texted
-- from the Buyers bulk composer: the browser looping, 200 at most, the tab
-- left open. A buyer campaign goes through the same server path as a seller
-- one: recipients, the scheduled-send expander, the reply and status triggers.
--
-- sms_campaign_recipients.buyer_id is the buyer a row texts.
-- sms_campaign_fill_buyers(campaign, buyer ids, dry) builds the list with the
-- buyer exclusions: blacklisted (blacklisted_at or the secret-blacklist tag),
-- a DNC tag or a buyer_phones is_dnc row, a landline, an opted-out thread or a
-- contact_opt_outs sms/all row, duplicates, and, when the campaign's
-- `opted_in_only` is on, anyone without buyers.opted_in_at.
--
-- Idempotent; safe to re-run. The lock timeout makes a busy buyers table fail
-- the run fast (the workflow retries) instead of holding up the API call, as
-- 377 did.

set lock_timeout = '10s';

alter table public.sms_campaigns add column if not exists contact_kind text not null default 'seller';
alter table public.sms_campaigns drop constraint if exists sms_campaigns_contact_kind_check;
alter table public.sms_campaigns add constraint sms_campaigns_contact_kind_check check (contact_kind in ('seller', 'buyer'));
alter table public.sms_campaigns add column if not exists opted_in_only boolean not null default false;

alter table public.sms_campaign_recipients add column if not exists buyer_id bigint references public.buyers(id) on delete cascade;
create index if not exists sms_campaign_recipients_buyer_idx on public.sms_campaign_recipients (buyer_id) where buyer_id is not null;

create or replace function public.sms_campaign_fill_buyers(p_campaign bigint, p_buyer_ids bigint[], p_dry boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws bigint;
  v_kind text;
  v_opt boolean;
  v_out jsonb;
begin
  select workspace_id, contact_kind, opted_in_only into v_ws, v_kind, v_opt from public.sms_campaigns where id = p_campaign;
  if v_ws is null or v_ws not in (select public.my_workspace_ids()) then
    raise exception 'campaign not found';
  end if;
  if v_kind <> 'buyer' then
    raise exception 'this campaign texts sellers';
  end if;
  create temp table if not exists _fillb (buyer_id bigint, phone text, phone_key text, state text, why text) on commit drop;
  delete from _fillb;
  insert into _fillb
  select b.id, n.phone, public.normalize_phone(n.phone),
         -- The first two-letter market ("TX", "Dallas, TX") names the zone the window is read in.
         (select upper(m[1]) from unnest(coalesce(b.markets, '{}')) mk, regexp_match(mk, '(?:^|[ ,])([A-Za-z]{2})$') m limit 1),
         case
           when n.phone is null then 'no_phone'
           when b.blacklisted_at is not null or 'secret-blacklist' = any(coalesce(b.tags, '{}')) then 'blacklisted'
           when exists (select 1 from unnest(coalesce(b.tags, '{}')) t where t ~* '^(dnc|do.?not.?call)$') then 'dnc'
           when exists (select 1 from public.buyer_phones bp where bp.buyer_id = b.id and bp.phone_key = public.normalize_phone(n.phone) and bp.is_dnc) then 'dnc'
           when exists (select 1 from public.buyer_phones bp where bp.buyer_id = b.id and bp.phone_key = public.normalize_phone(n.phone) and bp.kind = 'landline') then 'landline'
           when exists (select 1 from public.inbox_threads it where it.workspace_id = v_ws and it.phone_key = public.normalize_phone(n.phone) and it.opted_out_at is not null) then 'opted_out'
           when exists (select 1 from public.contact_opt_outs o where o.workspace_id = v_ws and o.phone_key = public.normalize_phone(n.phone) and coalesce(o.channel, 'sms') in ('sms', 'all', 'text')) then 'opted_out'
           when v_opt and b.opted_in_at is null then 'not_opted_in'
           when exists (select 1 from public.sms_campaign_recipients r where r.campaign_id = p_campaign and r.phone = n.phone) then 'duplicate'
           else 'ok'
         end
    from public.buyers b
    cross join lateral (
      select case when length(regexp_replace(coalesce(b.phone, ''), '\D', '', 'g')) >= 10
                  then '+1' || right(regexp_replace(b.phone, '\D', '', 'g'), 10) end as phone
    ) n
   where b.workspace_id = v_ws and b.archived_at is null and b.id = any(p_buyer_ids);
  -- Two buyers on one number: the first keeps it (one pass, not a pairwise scan).
  update _fillb f set why = 'duplicate'
    from (select buyer_id, row_number() over (partition by phone order by buyer_id) rn from _fillb where why = 'ok') d
   where d.buyer_id = f.buyer_id and d.rn > 1;
  select coalesce(jsonb_object_agg(why, n), '{}'::jsonb) into v_out
    from (select case when why = 'ok' then 'added' else why end why, count(*) n from _fillb group by 1) x;
  if not p_dry then
    insert into public.sms_campaign_recipients (campaign_id, workspace_id, buyer_id, phone, phone_key, state)
    select p_campaign, v_ws, buyer_id, phone, phone_key, state from _fillb where why = 'ok'
    on conflict (campaign_id, phone) do nothing;
    update public.sms_campaigns c
       set total_count = (select count(*) from public.sms_campaign_recipients r where r.campaign_id = c.id),
           excluded = v_out - 'added', updated_at = now()
     where c.id = p_campaign;
  end if;
  return v_out;
end $$;
grant execute on function public.sms_campaign_fill_buyers(bigint, bigint[], boolean) to authenticated;
