-- 448 · webhook_record_paths: the link in a webhook payload opens the record.
--
-- Every Zapier and webhook payload carries `url` from webhook_record_url
-- (migration 41), and it said `/app?seller=N`, `/app?deal=N`, `/app?buyer=N`.
-- The app now addresses its screens by path, so the link is the path the app
-- writes itself: /app/people/sN, /app/deals/dN, /app/buyers/bN
-- (app/lib/routes.ts). Payloads already delivered keep working: the app still
-- reads the old query (parseLegacy) and moves the address bar to the path.
--
-- Same signature, language and volatility. The triggers in 41, 116 and 296
-- call it by name and pick this up unchanged. `create or replace` keeps the
-- grants (revoked from public, anon and authenticated in 41) but drops the
-- search_path 207 set, so it is set again here; the revoke is repeated so the
-- file says the whole contract. Safe to re-run.

create or replace function public.webhook_record_url(p_kind text, p_id bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_id is null then null
    when p_kind = 'seller' then 'https://your-clozr-site.example.com/app/people/s' || p_id
    when p_kind = 'deal' then 'https://your-clozr-site.example.com/app/deals/d' || p_id
    when p_kind = 'buyer' then 'https://your-clozr-site.example.com/app/buyers/b' || p_id
    else 'https://your-clozr-site.example.com/app'
  end
$$;

revoke all on function public.webhook_record_url(text, bigint) from public, anon, authenticated;
