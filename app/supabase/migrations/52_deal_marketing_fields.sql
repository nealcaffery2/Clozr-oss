-- 52 · What a dispo blast says about a deal.
--
-- The buyer text and email templates merge {{headline}}, {{description}},
-- {{marketing_link}} and {{garage}}; these are their homes on the deal. The
-- rest ({{arv}}, {{sqft}}, {{year_built}}, {{comps_link}}, {{photo_url}}) come
-- from columns the deal and property already have.

alter table public.deals
  add column if not exists marketing_headline    text,
  add column if not exists marketing_description text,
  add column if not exists marketing_url         text,
  add column if not exists garage_spaces         numeric;
