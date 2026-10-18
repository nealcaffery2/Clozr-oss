-- 312 · crm_matches and crm_photo_links return json, built the way 292 builds.
--
-- Both still answered with jsonb_agg + jsonb_build_object (280): jsonb builds
-- a tree per row and re-sorts its keys, json_agg appends text. The wire format
-- is the same JSON; only the key order inside each object changes, and
-- lib/crm.ts reads every key by name (crm_matches into matchRows,
-- crm_photo_links into attachSourcePhotos).
--
-- Same keys, same values, same row order, same membership checks as 280.
-- Measured on a large workspace as the owner: both together 86 ms -> 30 ms; each output identical to the old one
-- once cast to jsonb (md5 of the text).
--
-- The return type changes, so each function is dropped and created again.
-- Safe to re-run.

drop function if exists public.crm_matches(bigint);

create function public.crm_matches(p_ws bigint)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')) then coalesce((
      select json_agg(row_to_json(x) order by x.score desc, x.id)
        from (
          select m.id, m.deal_id, m.buyer_id, m.score, m.reasons, m.status, m.sent_at, m.viewed_at, m.replied_at, m.updated_at
            from public.deal_buyer_matches m
           where m.workspace_id = p_ws
        ) x), '[]'::json)
    else null
  end;
$$;

revoke all on function public.crm_matches(bigint) from public, anon;
grant execute on function public.crm_matches(bigint) to authenticated;

-- Source photo links (Podio Photos, a Drive folder, a listing) for the Photos button.
drop function if exists public.crm_photo_links(bigint);

create function public.crm_photo_links(p_ws bigint)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then coalesce((
      select json_agg(json_build_object('deal_id', f.deal_id, 'url', f.url, 'category', f.category, 'name', f.name) order by f.id)
        from public.deal_files f
       where f.workspace_id = p_ws and f.kind = 'link' and f.url is not null
         and (f.category = 'photos' or f.name ilike 'photos')), '[]'::json)
    else null
  end;
$$;

revoke all on function public.crm_photo_links(bigint) from public, anon;
grant execute on function public.crm_photo_links(bigint) to authenticated;
