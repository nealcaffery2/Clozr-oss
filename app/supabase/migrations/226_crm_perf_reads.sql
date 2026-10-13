-- 226 · Cheaper reads for the workspace load, live new leads, and a nightly
-- job that stops rewriting 417,000 rows.
--
-- deal_cover_photos(ws): one photo per deal, the one the board shows (its
-- marked cover, else its first provider photo, else its first). The load used to
-- read the workspace's 5,000 OLDEST photos (lib/crm.ts), so with 136,000 of
-- them 8 of the 9 live deals with photos showed none, and the sort under
-- `deal_files_workspace_idx` timed out 44 times a day. 191 ms on today's
-- indexes for 4,575 deals; one index row per deal with 227's cover index.
-- The gallery reads a deal's photos when it opens (lib/crm.ts loadDealGallery).
-- Invoker: RLS on deals and deal_files decides what comes back.
--
-- deal_lead_sources(ws): the distinct lead sources on deals and sellers, for
-- the deal sheet's dropdown, instead of 10,000 rows of them on every open
-- (at most 1,000, which is PostgREST's page anyway).
--
-- sellers joins the realtime publication, so an inbound lead reaches every
-- open CLOZR within seconds (lib/use-crm.ts subscribes to INSERT for its
-- workspace) instead of after someone reloads: the call-in-60-90-seconds rule.
-- RLS still decides who receives a row.
--
-- buyer_automations_apply: same rules, same results, but a buyer's rule state
-- is written only when it changes (or is new). The nightly run upserted a
-- buyer_rule_states row for every rule × every buyer, ~417,000 writes for
-- three rules, and took 56 s; almost none of them changed anything.
--
-- Idempotent.

-- One jsonb value, like seller_last_touch (113): a set-returning function is
-- cut at PostgREST's 1,000 rows, and there are 4,500+ deals.
create or replace function public.deal_cover_photos(p_workspace bigint)
returns jsonb
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'deal_id', d.id, 'url', p.url, 'source', p.source, 'is_cover', p.is_cover, 'position', p."position"
  )), '[]'::jsonb)
    from public.deals d
    cross join lateral (
      select f.url, f.source, f.is_cover, f."position"
        from public.deal_files f
       where f.deal_id = d.id and f.kind = 'photo' and f.url is not null
       order by f.is_cover desc nulls last, (f.source = 'compr') desc nulls last, f.created_at, f.id
       limit 1
    ) p
   where d.workspace_id = p_workspace;
$$;
revoke all on function public.deal_cover_photos(bigint) from public, anon;
grant execute on function public.deal_cover_photos(bigint) to authenticated;

create or replace function public.deal_lead_sources(p_workspace bigint)
returns table (source text)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select v from (
    select lead_source as v from public.deals where workspace_id = p_workspace and lead_source is not null
    union
    select source from public.sellers where workspace_id = p_workspace and source is not null
  ) x
  limit 1000;
$$;
revoke all on function public.deal_lead_sources(bigint) from public, anon;
grant execute on function public.deal_lead_sources(bigint) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sellers') then
    alter publication supabase_realtime add table public.sellers;
  end if;
end
$$;

create or replace function public.buyer_automations_apply(p_workspace_id bigint default null::bigint, p_buyer_id bigint default null::bigint)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  rl public.buyer_automation_rules;
  b public.buyers;
  v_true boolean; v_has boolean; v_changes int := 0;
  v_was boolean; v_stored boolean; v_found boolean; v_new_level smallint; v_title text; v_body text;
begin
  if auth.role() not in ('service_role') and current_user not in ('postgres', 'supabase_admin')
     and (p_workspace_id is null or not public.has_role(p_workspace_id, 'owner', 'admin', 'dispositions')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  for rl in select * from public.buyer_automation_rules
             where enabled and (p_workspace_id is null or workspace_id = p_workspace_id)
             order by workspace_id, id loop
    for b in select * from public.buyers
              where workspace_id = rl.workspace_id and (p_buyer_id is null or id = p_buyer_id) loop

      v_true := public.buyer_rule_true(rl, b);

      if rl.action = 'tag' then
        v_has := lower(rl.tag) = any (select lower(t) from unnest(coalesce(b.tags, '{}')) t);
        if v_true and not v_has then
          update public.buyers set tags = array_append(coalesce(tags, '{}'), rl.tag) where id = b.id;
          insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
          values (b.workspace_id, 'buyer', b.id, 'automation', 'Tagged "' || rl.tag || '"',
                  'Buyer automation: ' || rl.rule);
          v_changes := v_changes + 1;
        elsif not v_true and v_has and rl.remove_when_false then
          update public.buyers set tags = array(select t from unnest(tags) t where lower(t) <> lower(rl.tag))
           where id = b.id;
          insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
          values (b.workspace_id, 'buyer', b.id, 'automation', 'Untagged "' || rl.tag || '"',
                  'Buyer automation no longer true: ' || rl.rule);
          v_changes := v_changes + 1;
        end if;

      else
        -- Non-tag actions fire on the false -> true edge only.
        select was_true into v_stored from public.buyer_rule_states
         where rule_id = rl.id and buyer_id = b.id;
        v_found := found;
        v_was := coalesce(v_stored, false);

        if v_true and not v_was then
          v_title := null;

          if rl.action in ('level_up', 'level_down', 'set_level') then
            v_new_level := case rl.action
              when 'level_up'   then least(b.level + 1, rl.level_ceiling)
              when 'level_down' then greatest(b.level - 1, rl.level_floor)
              else rl.action_value::smallint end;
            if v_new_level <> b.level then
              update public.buyers
                 set level = v_new_level, level_changed_at = now()
               where id = b.id;
              v_title := format('Buyer level %s -> %s', b.level, v_new_level);
              v_body  := 'Buyer automation: ' || rl.rule;
            end if;

          elsif rl.action = 'set_status' then
            if lower(coalesce(b.status,'')) is distinct from rl.action_value then
              update public.buyers set status = rl.action_value where id = b.id;
              v_title := format('Buyer status %s -> %s', coalesce(b.status,'none'), rl.action_value);
              v_body  := 'Buyer automation: ' || rl.rule;
            end if;

          elsif rl.action = 'add_follow_up' then
            v_title := 'Follow-up queued';
            v_body  := 'Buyer automation: ' || rl.rule || ' · template ' || rl.action_value;
            insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id)
            select b.workspace_id, null, 'buyer_automation', v_title, v_body, b.id;
          end if;

          if v_title is not null then
            insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
            values (b.workspace_id, 'buyer', b.id, 'automation', v_title, v_body);
            v_changes := v_changes + 1;
          end if;
        end if;

        -- Only a new state, or one that changed, is written. An unchanged
        -- row would only be rewritten with the same values (the counter and
        -- the applied time move only on the false -> true edge above).
        if not v_found or v_true is distinct from v_stored then
          insert into public.buyer_rule_states (rule_id, buyer_id, workspace_id, was_true, last_applied_at, apply_count)
          values (rl.id, b.id, b.workspace_id, v_true,
                  case when v_true and not v_was then now() end,
                  case when v_true and not v_was then 1 else 0 end)
          on conflict (rule_id, buyer_id) do update
            set was_true = excluded.was_true,
                last_applied_at = coalesce(excluded.last_applied_at, public.buyer_rule_states.last_applied_at),
                apply_count = public.buyer_rule_states.apply_count + excluded.apply_count;
        end if;
      end if;
    end loop;

    if p_buyer_id is null then
      update public.buyer_automation_rules set last_run_at = now() where id = rl.id;
    end if;
  end loop;

  return v_changes;
end $function$;
