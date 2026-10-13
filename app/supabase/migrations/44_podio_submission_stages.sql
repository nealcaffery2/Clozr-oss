-- 44 · Podio Partnerships submission stages.
--
-- The Submissions app runs a partner deal through underwriting to an offer. CLOZR's
-- seller stages (27) had Underwriting and Offer Made but not the rest, and
-- normalize_seller_stage() turns any label it doesn't know into 'Lead' — so
-- without these rows an import would silently file 1,300 declined offers as new
-- leads. None of them implies a deal (deal_stage null): the Deals files carry
-- the contracts, and the deal trigger moves a seller from here to Under Contract.
--
-- lib/stages.ts SELLER_STAGES mirrors this list and order.
--
-- normalize_seller_stage also folds runs of whitespace, so Podio's
-- "Underwriting  Complete" (two spaces) matches its label.

insert into public.seller_stages (label, sort, grp, deal_stage) values
  ('New Submission',           25,  'lead',  null),
  ('Underwriting - Need Info', 112, 'offer', null),
  ('Underwriting Complete',    115, 'offer', null),
  ('Pending Response',         135, 'offer', null),
  ('Pending Inspections',      152, 'offer', null),
  ('Offer Accepted',           155, 'offer', null),
  ('Underwrite Declined',      245, 'dead',  null),
  ('Offer Declined',           247, 'dead',  null),
  ('Auction.com',              445, 'other', null)
on conflict (label) do nothing;

create or replace function public.normalize_seller_stage(p text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select label from public.seller_stages
      where lower(label) = lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')) limit 1),
    case lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'))
      when 'new lead' then 'Lead'
      when 'contacted' then 'Contacted - Follow Up Needed'
      when 'qualified' then 'Underwriting'
      when 'appointment' then 'Appointment Set'
      when 'offer sent' then 'Offer Made'
      when 'negotiation' then 'Offer Made - Follow Up'
      when 'under contract' then 'Under Contract - Seller'
      when 'under contract seller' then 'Under Contract - Seller'
      when 'dispo' then 'Under Contract - Seller'
      when 'ready to market' then 'Under Contract - Seller'
      when 'assigned' then 'Under Contract - Buyer'
      when 'buyer under contract' then 'Under Contract - Buyer'
      when 'closing' then 'Under Contract - Buyer'
      when 'in escrow' then 'Under Contract - Buyer'
      when 'lost' then 'Dead'
      when 'realtor referral' then 'Referred to Realtor'
      else 'Lead'
    end)
$$;
