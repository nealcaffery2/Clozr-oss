-- 331 · rvm-tick reads earlier drops and last calls for a batch in one call.
--
-- rvm-tick judged each due drop on two reads of its own: the person's dropped
-- and answered drops in the workspace (every row), and their latest call of
-- 20 s or more in any workspace (order by occurred_at desc limit 1). Read for
-- a batch of 48 through PostgREST, those come back as every matching row and
-- hit the 1,000-row cap: the busiest sellers have well over a
-- thousand such calls between them.
--
-- rvm_gate_history(p_drop_ids) returns, per drop, only what the rules use:
--   last_talk  the latest call of 20 s or more with the drop's seller (or,
--              for a buyer drop, its buyer), any workspace, as before;
--   prior      the person's dropped and answered drops in the drop's
--              workspace, one row per (library_id, status) with the latest
--              sent_at. Which recordings they heard and when, the last drop
--              and the last answered call come out the same as from every row.
-- So one row per drop, however long the history. A buyer branch adds
-- seller_id is null, which rvm_drops_one_person already guarantees, so it can
-- use rvm_drops_person on all three columns.
--
-- Checked as plain SQL: last_talk equal to the per-drop read for
-- every drop and for the 48 busiest sellers and buyers; about 3 ms for the
-- 48 busiest sellers. Returns [{"id", "last_talk", "prior": [...]}]. Service
-- role only (rvm-tick, which reads per drop as before while this is missing).
-- Safe to re-run.

create or replace function public.rvm_gate_history(p_drop_ids bigint[])
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(json_agg(json_build_object(
           'id', d.id,
           'last_talk', coalesce(ts.occurred_at, tb.occurred_at),
           'prior', coalesce(h.prior, '[]'::json))), '[]'::json)
    from rvm_drops d
    left join lateral (
      select c.occurred_at from communications c
       where d.seller_id is not null and c.seller_id = d.seller_id and c.channel = 'call' and c.duration_s >= 20
       order by c.occurred_at desc limit 1) ts on true
    left join lateral (
      select c.occurred_at from communications c
       where d.seller_id is null and c.buyer_id = d.buyer_id and c.channel = 'call' and c.duration_s >= 20
       order by c.occurred_at desc limit 1) tb on true
    left join lateral (
      select json_agg(json_build_object('library_id', g.library_id, 'status', g.status, 'sent_at', g.sent_at)) prior
        from (select r.library_id, r.status, max(r.sent_at) sent_at
                from (select r.library_id, r.status, r.sent_at from rvm_drops r
                       where d.seller_id is not null and r.workspace_id = d.workspace_id and r.seller_id = d.seller_id
                         and r.status in ('dropped', 'answered')
                      union all
                      select r.library_id, r.status, r.sent_at from rvm_drops r
                       where d.seller_id is null and r.workspace_id = d.workspace_id and r.seller_id is null and r.buyer_id = d.buyer_id
                         and r.status in ('dropped', 'answered')) r
               group by r.library_id, r.status) g) h on true
   where d.id = any(p_drop_ids);
$$;

revoke all on function public.rvm_gate_history(bigint[]) from public, anon, authenticated;
grant execute on function public.rvm_gate_history(bigint[]) to service_role;
