-- Compr's $997 plan is called Team (owner call 2026-11-01). The stored Compr
-- campaign templates still said Institutional; the tier key stays institutional.
update public.message_templates
   set name      = replace(name, 'Institutional', 'Team'),
       subject   = replace(coalesce(subject, ''), 'Institutional', 'Team'),
       body_text = replace(coalesce(body_text, ''), 'Institutional', 'Team'),
       body_html = replace(coalesce(body_html, ''), 'Institutional', 'Team'),
       blocks    = case when blocks is null then null else replace(blocks::text, 'Institutional', 'Team')::jsonb end,
       updated_at = now()
 where category like 'compr-%'
   and (name ilike '%Institutional%' or coalesce(body_text, '') ilike '%Institutional%'
        or coalesce(body_html, '') ilike '%Institutional%' or coalesce(blocks::text, '') ilike '%Institutional%');
