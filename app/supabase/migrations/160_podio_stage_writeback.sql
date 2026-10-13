-- 160 · A submission moved in CLOZR is moved in Podio too.
--
-- The live sync (132) only reads Podio. A person moving a submission in CLOZR
-- (1001 Green Acre: Underwrite Declined → Offer Declined) left the Podio item
-- on its old Category, so Podio's views, the Submissions counts built on the
-- ledger, and the record disagreed. Now every such move goes back to Podio.
--
--   podio_outbox            one row per Podio Submissions item to move: the
--                           CLOZR stage, when and by whom it was set, and the
--                           item's Podio stage as the ledger had it then
--                           (podio_stage_at_move). status pending → sending →
--                           done | skipped (Podio has no such stage, or Podio
--                           changed it after the move: the later change wins,
--                           as the sync's own rule) | failed (after 5 tries) |
--                           superseded (a newer move of the same deal).
--                           Members read; only the function writes.
--   podio_outbox_enqueue    AFTER INSERT on stage_events (125): a deal's
--                           lead_stage moved by a person (changed_by set) queues
--                           every Submissions item on that deal. The sync's own
--                           moves are the System's (changed_by null) and are
--                           never sent back.
--   podio-import            the service-role run (pg_cron clozr-podio-sync, every
--                           ten minutes) sends the queue first, then syncs; the
--                           Submissions history pass waits while anything is
--                           queued so the write-back has that app's Podio budget.
--   podio_push_backlog(ws, dry_run)  queues the moves people made before this
--                           migration (deal still on the stage a person last set,
--                           Podio on another). dry_run (default) only counts.
--                           Service role only.

create table if not exists public.podio_outbox (
  id                  bigserial primary key,
  workspace_id        bigint not null,
  item_id             bigint not null,
  deal_id             bigint,
  to_stage            text not null,
  podio_stage_at_move text,
  moved_at            timestamptz not null default now(),
  moved_by            uuid,
  status              text not null default 'pending'
                      check (status in ('pending', 'sending', 'done', 'skipped', 'failed', 'superseded')),
  attempts            integer not null default 0,
  claimed_until       timestamptz,
  result              text,
  done_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists podio_outbox_queue_idx on public.podio_outbox (workspace_id, id) where status in ('pending', 'sending');
create index if not exists podio_outbox_deal_idx on public.podio_outbox (deal_id) where status in ('pending', 'sending');
create index if not exists podio_outbox_item_idx on public.podio_outbox (workspace_id, item_id);

alter table public.podio_outbox enable row level security;
drop policy if exists podio_outbox_select on public.podio_outbox;
create policy podio_outbox_select on public.podio_outbox for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.podio_outbox to authenticated;

create or replace function public.podio_outbox_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.entity_type <> 'deal' or new.field <> 'lead_stage' or new.changed_by is null
     or coalesce(btrim(new.to_stage), '') = '' then
    return null;
  end if;
  if not exists (select 1 from public.podio_items pi
                  where pi.deal_id = new.entity_id and pi.workspace_id = new.workspace_id and pi.app_key = 'submissions') then
    return null;
  end if;
  update public.podio_outbox o set status = 'superseded', done_at = now(), result = 'A newer move of this submission replaced it.'
   where o.deal_id = new.entity_id and o.workspace_id = new.workspace_id and o.status = 'pending';
  insert into public.podio_outbox (workspace_id, item_id, deal_id, to_stage, podio_stage_at_move, moved_at, moved_by)
  select new.workspace_id, pi.item_id, pi.deal_id, btrim(new.to_stage), pi.podio_stage, new.changed_at, new.changed_by
    from public.podio_items pi
   where pi.deal_id = new.entity_id and pi.workspace_id = new.workspace_id and pi.app_key = 'submissions';
  return null;
end $$;
revoke all on function public.podio_outbox_enqueue() from public, anon, authenticated;

drop trigger if exists podio_outbox_enqueue on public.stage_events;
create trigger podio_outbox_enqueue after insert on public.stage_events
  for each row execute function public.podio_outbox_enqueue();

-- The moves people made that Podio has not had: the deal is still on the stage a
-- person last set, and the Podio item says something else.
create or replace function public.podio_backlog_rows(p_ws bigint)
returns table (item_id bigint, deal_id bigint, to_stage text, podio_stage text, changed_at timestamptz, changed_by uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with lastp as (
    select distinct on (e.entity_id) e.entity_id, e.to_stage, e.changed_at, e.changed_by
      from public.stage_events e
     where e.workspace_id = p_ws and e.entity_type = 'deal' and e.field = 'lead_stage' and e.changed_by is not null
     order by e.entity_id, e.changed_at desc, e.id desc)
  select pi.item_id, pi.deal_id, btrim(d.lead_stage), pi.podio_stage, lp.changed_at, lp.changed_by
    from public.podio_items pi
    join public.deals d on d.id = pi.deal_id
    join lastp lp on lp.entity_id = d.id and btrim(lp.to_stage) = btrim(d.lead_stage)
   where pi.workspace_id = p_ws and pi.app_key = 'submissions'
     and lower(regexp_replace(btrim(coalesce(pi.podio_stage, '')), '\s+', ' ', 'g'))
         <> lower(regexp_replace(btrim(d.lead_stage), '\s+', ' ', 'g'))
     and not exists (select 1 from public.podio_outbox o
                      where o.workspace_id = p_ws and o.item_id = pi.item_id and o.status in ('pending', 'sending'))
$$;
revoke all on function public.podio_backlog_rows(bigint) from public, anon, authenticated;

create or replace function public.podio_push_backlog(p_ws bigint, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows jsonb; v_n integer;
begin
  select count(*) into v_n from public.podio_backlog_rows(p_ws);
  select coalesce(jsonb_agg(t), '[]') into v_rows from (
    select coalesce(b.podio_stage, '(blank)') as podio, b.to_stage as clozr, count(*) as items
      from public.podio_backlog_rows(p_ws) b group by 1, 2 order by 3 desc) t;
  if not p_dry_run then
    insert into public.podio_outbox (workspace_id, item_id, deal_id, to_stage, podio_stage_at_move, moved_at, moved_by)
    select p_ws, b.item_id, b.deal_id, b.to_stage, b.podio_stage, b.changed_at, b.changed_by from public.podio_backlog_rows(p_ws) b;
  end if;
  return jsonb_build_object('dry_run', p_dry_run, 'items', v_n, 'moves', v_rows);
end $$;
revoke all on function public.podio_push_backlog(bigint, boolean) from public, anon, authenticated;
grant execute on function public.podio_push_backlog(bigint, boolean) to service_role;
