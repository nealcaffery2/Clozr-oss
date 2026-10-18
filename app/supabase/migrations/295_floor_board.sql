-- 295 · The floor show's own read.
--
-- The floor show (app/clozr/FloorShow.tsx) is on every screen. It used to
-- hold the reporting reads a minute after the screen opened, so every user
-- paid for report_comms (mean about half a second) and
-- crm_offer_gaps (about the same) though the board never reads offer
-- gaps, and it re-read the whole workspace every five minutes in each visible
-- tab to keep the board fresh.
--
-- floor_board(ws, since, changed) is everything the board diffs, as one json
-- value, in place of both:
--
--   deals         every deal, the reporting columns (pipeline, escrow and the
--                 quarter and year fees read them all)
--   offers        sent since `since`, as the offers policies show them to the
--                 caller (acquisitions: inbound, or seller-side only)
--   comms         occurred since `since`, newest 10,000 (report_comms'
--                 columns), plus each new seller's first outbound touch from
--                 before `since`, so speed to lead still skips a lead that was
--                 reached before it was created
--   contracts     every contract
--   appointments  created (or, undated, starting) since `since`
--   buyers        added since `since`, the shell's buyers, for the roles that
--                 can read buyers; only when and by whom, all the board counts
--   sellers       changed since `changed` (null: none), archived ones flagged,
--                 so a new or reassigned lead reaches the board without a
--                 workspace reload
--   mail          emails filed since `changed` (null: none) that the caller
--                 may read (communications_read), for the signed-by-email
--                 contract popup
--   at            the server's clock, for the next call's `changed`
--
-- `since` is the start of the widest board window (this month, this week,
-- the last seven days), less a day. Membership is checked once with
-- my_workspace_ids(); the role rules are the tables' own policies, through
-- the same helper functions.
--
-- Measured on a large workspace (the body as plain SQL, since 38 days back,
-- changed 10 minutes back): under 400 ms for thousands of deals,
-- communications and buyers. One call every five minutes per visible tab, in
-- place of report_comms + crm_offer_gaps (about 1.1 s) and a full workspace
-- reload.
--
-- Safe to re-run.

create or replace function public.floor_board(p_ws bigint, p_since timestamptz, p_changed timestamptz default null)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
set work_mem = '32MB'
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then json_build_object(
      'at', now(),
      'deals', coalesce((
        select json_agg(row_to_json(x) order by x.id)
          from (
            select d.id, d.seller_id, d.buyer_id, d.stage, d.created_at, d.stage_entered_at, d.contract_date, d.close_date,
                   d.closed_on, d.marketing_started_on, d.owner_id, d.dispo_rep_id, d.offer_amount, d.arv, d.mao,
                   d.assignment_fee, d.dispo_fee, d.sold_price, d.wholesale_fee, d.total_cogs, d.team_commissions_paid,
                   d.deal_net_profit, d.final_profit, d.lead_source, d.market, d.marketed_price, d.coordinator
              from public.deals d
             where d.workspace_id = p_ws
          ) x), '[]'::json),
      'offers', coalesce((
        select json_agg(row_to_json(x) order by x.id)
          from (
            select o.id, o.deal_id, o.seller_id, o.buyer_id, o.direction, o.amount, o.status, o.sent_at, o.responded_at, o.created_by
              from public.offers o
             where o.workspace_id = p_ws and o.sent_at >= p_since
               and (p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member'))
                 or (p_ws in (select public.my_role_workspace_ids('acquisitions')) and o.direction = 'inbound')
                 or (p_ws in (select public.my_role_workspace_ids('acquisitions', 'partnerships')) and o.seller_id is not null and o.buyer_id is null))
          ) x), '[]'::json),
      'comms', coalesce((
        select json_agg(row_to_json(x) order by x.occurred_at desc, x.id desc)
          from (
            (select c.id, c.seller_id, c.buyer_id, c.rep_id, c.from_phone, c.to_phone, c.channel, c.direction, c.occurred_at, c.duration_s, c.status
               from public.communications c
              where c.workspace_id = p_ws and c.occurred_at >= p_since
              order by c.occurred_at desc, c.id desc
              limit 10000)
            union all
            (select distinct on (c.seller_id) c.id, c.seller_id, c.buyer_id, c.rep_id, c.from_phone, c.to_phone, c.channel, c.direction, c.occurred_at, c.duration_s, c.status
               from public.sellers s
               join public.communications c on c.seller_id = s.id
              where s.workspace_id = p_ws and s.archived_at is null and s.created_at >= p_since
                and c.workspace_id = p_ws and c.occurred_at < p_since and c.direction is distinct from 'inbound'
              order by c.seller_id, c.occurred_at, c.id)
          ) x), '[]'::json),
      'contracts', coalesce((
        select json_agg(row_to_json(x) order by x.created_at desc, x.id desc)
          from (
            select k.id, k.deal_id, k.kind, k.status, k.provider, k.sent_at, k.viewed_at, k.completed_at, k.created_at
              from public.contracts k
             where k.workspace_id = p_ws
          ) x), '[]'::json),
      'appointments', coalesce((
        select json_agg(row_to_json(x) order by x.starts_at, x.id)
          from (
            select a.id, a.seller_id, a.buyer_id, a.title, a.kind, a.starts_at, a.assigned_to, a.source, a.created_at, a.deleted_at
              from public.appointments a
             where a.workspace_id = p_ws and coalesce(a.created_at, a.starts_at) >= p_since
          ) x), '[]'::json),
      'buyers', coalesce((
        select json_agg(row_to_json(x) order by x.id)
          from (
            select b.id, b.created_at, b.created_by
              from public.buyers b
             where b.workspace_id = p_ws and b.created_at >= p_since
               and b.source is distinct from 'dispogenius-free-agents' and b.archived_at is null
               and p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member'))
          ) x), '[]'::json),
      'sellers', case when p_changed is null then '[]'::json else coalesce((
        select json_agg(row_to_json(x) order by x.id)
          from (
            select s.id, s.name, s.created_at, s.source, s.assigned_to, s.lead_stage as stage,
                   coalesce(nullif(p.line1, ''), s.property_address) as address, s.email, s.phone, s.tags,
                   s.stage_entered_at, s.archived_at
              from public.sellers s
              -- property_id is an id-only key: a definer read joins only this workspace's rows (as crm_sellers does).
              left join public.properties p on p.id = s.property_id and p.workspace_id = p_ws
             where s.workspace_id = p_ws and s.updated_at >= p_changed
          ) x), '[]'::json) end,
      'mail', case when p_changed is null then '[]'::json else coalesce((
        select json_agg(row_to_json(x) order by x.id)
          from (
            select c.id, coalesce(nullif(c.subject, ''), '(no subject)') as subject,
                   left(coalesce(nullif(c.body, ''), nullif(c.ai_notes ->> 'summary', ''), nullif(c.summary, ''), ''), 800) as body,
                   case when c.seller_id is not null then s.assigned_to else b.assigned_to end as owner_id
              from public.communications c
              left join public.sellers s on s.id = c.seller_id and s.workspace_id = p_ws
              left join public.buyers b on b.id = c.buyer_id and b.workspace_id = p_ws and c.seller_id is null
             where c.workspace_id = p_ws and c.channel = 'email' and c.created_at >= p_changed
               and (p_ws in (select public.my_email_admin_workspace_ids()) or public.can_read_email(p_ws, c.id))
          ) x), '[]'::json) end
    )
  end;
$$;

revoke all on function public.floor_board(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.floor_board(bigint, timestamptz, timestamptz) to authenticated;
