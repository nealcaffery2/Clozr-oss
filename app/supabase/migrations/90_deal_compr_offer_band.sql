-- 90: The provider's wholesale (low) and institutional (high) offer band on the deal.
-- MAO stays the presented / underwriting number; these two are the floor and
-- ceiling the provider paints for the underwriter, shown under the Offer card.

alter table public.deals
  add column if not exists wholesale_offer numeric,
  add column if not exists institutional_offer numeric;

comment on column public.deals.wholesale_offer is
  'Underwriting provider wholesale / low offer band for the underwriter.';
comment on column public.deals.institutional_offer is
  'Underwriting provider institutional / high offer band for the underwriter.';
