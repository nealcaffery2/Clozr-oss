-- 58 · The record's hero photo, from the provider.
--
-- The underwriting provider picks a front exterior for its report (vision's front_photo_index,
-- else the first photo). compr-underwrite copies a browser-loadable URL to it
-- here after a run, and the seller record shows it ahead of Street View. A
-- Street View tile is never stored: the record already draws its own.
--
-- Written by the edge function with the service role; members read it with
-- the deal.

alter table public.deals add column if not exists hero_image_url text;
