-- The provider's share link puts the address in front of the lead id
-- (/r/3907-hall-dr-spring-hope-nc-27882-clozr-w11-d4257-2026-10-07). Its API
-- only knows the id, so a deal holding that link never got its provider photos
-- (compr_photos_synced_at stamped with nothing found) and its report frame
-- failed to load. Keep the link as /r/<lead id>, which opens the same report.

create or replace function public.compr_report_lead_link(p_url text)
returns text
language sql
immutable
as $$
  select case
    when p_url ~* '^https?://[^/]*underwriting\.example\.com/r/[^/?#]+-(clozr-w[0-9]+-[ds][0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}|app-[0-9]{10,}|podio-[0-9]+-[a-z0-9]+)([/?#].*)?$'
    then regexp_replace(p_url,
      '^(https?://[^/]*underwriting\.example\.com/r/)[^/?#]+-(clozr-w[0-9]+-[ds][0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}|app-[0-9]{10,}|podio-[0-9]+-[a-z0-9]+)(([/?#].*)?)$',
      '\1\3\4', 'i')
    else p_url
  end
$$;

create or replace function public.deals_compr_report_lead_link()
returns trigger
language plpgsql
as $$
begin
  new.underwriting_url := public.compr_report_lead_link(new.underwriting_url);
  new.compr_report_url := public.compr_report_lead_link(new.compr_report_url);
  return new;
end $$;

create or replace trigger deals_compr_report_lead_link
  before insert or update of underwriting_url, compr_report_url on public.deals
  for each row execute function public.deals_compr_report_lead_link();

-- Links already saved: rewrite them and let the 10-minute photo sync try again.
update public.deals
set underwriting_url = public.compr_report_lead_link(underwriting_url),
    compr_report_url = public.compr_report_lead_link(compr_report_url),
    compr_photos_synced_at = null
where underwriting_url is distinct from public.compr_report_lead_link(underwriting_url)
   or compr_report_url is distinct from public.compr_report_lead_link(compr_report_url);
