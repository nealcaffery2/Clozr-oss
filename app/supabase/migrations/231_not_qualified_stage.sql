-- 231 · Not Qualified, the seller stage for "no offer".
--
-- The acquisitions SOP ends a call one of three ways once the rep has
-- underwritten the house: Offer accepted, Declined, or No offer. No offer is
-- either Follow Up or Not Qualified, and seller_stages (27, 44) had nothing
-- that meant Not Qualified: the closest dead stages say why a seller is out
-- (Not Selling, Asking Retail / Not Motivated, Negative Equity), not that we
-- passed on the house. normalize_seller_stage() turns a label it does not know
-- into 'Lead', so without this row the outcome would file the seller as a new
-- lead. Dead group, no deal stage, sorted after the other "why they're out"
-- stages. lib/stages.ts SELLER_STAGES mirrors it.
--
-- Safe to run again.

insert into public.seller_stages (label, sort, grp, deal_stage) values
  ('Not Qualified', 275, 'dead', null)
on conflict (label) do nothing;
