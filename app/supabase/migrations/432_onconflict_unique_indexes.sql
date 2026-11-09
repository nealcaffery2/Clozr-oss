-- 432 · The unique keys six upserts rely on, for a database built from this folder.
--
-- These tables predate the folder, and the live database has the unique
-- constraints their `on conflict` targets need under names we do not know:
--   tasks (enrollment_id, plan_step_id)             plan_enroll (34), cal-booking-run
--   communications (workspace_id, source, source_id) rvm-tick and 28 more filers
--   workspace_invites (workspace_id, email)          add-teammate
--   workspace_members (workspace_id, user_id)        add-teammate
--   buyer_phones (buyer_id, phone)                   lib/genius
--   dispogenius_buyer_snapshots (dispogenius_deal_id, dispogenius_buyer_id, pulled_on)
--                                                    dispogenius-sync
-- A database built from the folder alone (a Supabase branch, a fresh project)
-- had none of them, so every one of those upserts failed with "no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- For each target: when the table exists and no valid, non-partial unique
-- index or constraint on exactly those columns exists (matched by column
-- list, in any order, never by name), create one. On the live database every
-- check matches and nothing is built, so no table is locked. Safe to re-run.

do $$
declare
  t record;
  have boolean;
begin
  for t in
    select * from (values
      ('tasks',                       array['enrollment_id', 'plan_step_id'],                                  'tasks_enrollment_step_uidx'),
      ('communications',              array['workspace_id', 'source', 'source_id'],                            'communications_ws_source_uidx'),
      ('workspace_invites',           array['workspace_id', 'email'],                                          'workspace_invites_ws_email_uidx'),
      ('workspace_members',           array['workspace_id', 'user_id'],                                        'workspace_members_ws_user_uidx'),
      ('buyer_phones',                array['buyer_id', 'phone'],                                              'buyer_phones_buyer_phone_uidx'),
      ('dispogenius_buyer_snapshots', array['dispogenius_deal_id', 'dispogenius_buyer_id', 'pulled_on'],       'dispogenius_buyer_snapshots_deal_buyer_day_uidx')
    ) as v(tbl, cols, idx)
  loop
    if to_regclass('public.' || t.tbl) is null then
      raise notice '432: public.% does not exist here; nothing to do', t.tbl;
      continue;
    end if;

    select exists (
      select 1
      from pg_index i
      where i.indrelid = to_regclass('public.' || t.tbl)
        and i.indisunique and i.indisvalid
        and i.indpred is null and i.indexprs is null
        and (select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
             where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
            = (select array_agg(c order by c) from unnest(t.cols) as c)
    ) into have;

    if have then
      continue;
    end if;

    execute format('create unique index if not exists %I on public.%I (%s)',
      t.idx, t.tbl, (select string_agg(format('%I', c), ', ') from unnest(t.cols) as c));
    raise notice '432: created % on public.% (%)', t.idx, t.tbl, array_to_string(t.cols, ', ');
  end loop;
end $$;
