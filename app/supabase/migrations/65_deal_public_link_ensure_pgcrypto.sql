-- 65: publishing a deal failed on every deal that had no link yet.
--
-- deal_public_link_ensure (59) pins search_path to public, pg_temp and called
-- gen_random_bytes() bare. pgcrypto lives in the extensions schema, which is
-- not on that path, so the first publish of any deal raised "function
-- gen_random_bytes(integer) does not exist" — and the listing function turned
-- that into the 403 the campaign builder, the buyer page panel and the
-- Marketing tab hit the moment they minted buyer links. Migration 22 learned
-- the same lesson for ensure_calendar_token. Same function, the call
-- schema-qualified; grants are untouched by create or replace.
create or replace function public.deal_public_link_ensure(p_deal_id bigint, p_headline text default null, p_description text default null)
returns public.deal_public_links
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_ws bigint; v_link public.deal_public_links; v_slug text;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id;
  if v_ws is null then raise exception 'deal not found' using errcode = '22023'; end if;
  if not public.has_role(v_ws, 'owner', 'admin', 'dispositions') then
    raise exception 'only owners, admins and dispositions can publish a deal' using errcode = '42501';
  end if;

  select * into v_link from public.deal_public_links where deal_id = p_deal_id and active;
  if found then
    update public.deal_public_links set
      headline    = coalesce(nullif(trim(p_headline), ''), headline),
      description = coalesce(nullif(trim(p_description), ''), description),
      updated_at  = now()
    where id = v_link.id returning * into v_link;
    return v_link;
  end if;

  -- 9 bytes of randomness, so a link cannot be guessed from a street name.
  loop
    v_slug := lower(translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=IlO01', 'abcdefgh'));
    exit when not exists (select 1 from public.deal_public_links where slug = v_slug);
  end loop;

  insert into public.deal_public_links (workspace_id, deal_id, slug, headline, description, created_by)
  values (v_ws, p_deal_id, v_slug, nullif(trim(p_headline), ''), nullif(trim(p_description), ''), auth.uid())
  returning * into v_link;
  return v_link;
end $$;
