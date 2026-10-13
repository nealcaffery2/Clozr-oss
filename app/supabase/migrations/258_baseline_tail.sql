-- 258_baseline_tail: the rest of the live schema that no file in this folder
-- creates. 0_baseline restores what migrations 1–22 and 29–32 made; this file
-- carries what the live project gained outside any committed migration and
-- that has to come after the files that create its tables: the
-- deal_buyer_matches engagement counters, the dispo campaign send window and
-- stop fields, buyer automation actions, a few indexes, foreign keys and
-- triggers, and the views over them. Regenerated from the catalog; every
-- statement is guarded, so on a database that already has them it changes
-- nothing.

set check_function_bodies = off;

-- columns

alter table public.buyer_automation_rules
  add column if not exists action text default 'tag'::text not null,
  add column if not exists action_value text,
  add column if not exists level_floor smallint default 1 not null,
  add column if not exists level_ceiling smallint default 5 not null,
  add column if not exists name text;

alter table public.deal_buyer_matches
  add column if not exists track_token text default encode(gen_random_bytes(12), 'hex'::text),
  add column if not exists sends integer default 0 not null,
  add column if not exists deliveries integer default 0 not null,
  add column if not exists opens integer default 0 not null,
  add column if not exists clicks integer default 0 not null,
  add column if not exists replies integer default 0 not null,
  add column if not exists calls integer default 0 not null,
  add column if not exists page_views integer default 0 not null,
  add column if not exists photo_clicks integer default 0 not null,
  add column if not exists bounces integer default 0 not null,
  add column if not exists session_seconds integer default 0 not null,
  add column if not exists last_engaged_at timestamp with time zone,
  add column if not exists temperature text,
  add column if not exists probability smallint,
  add column if not exists pass_reason text,
  add column if not exists pass_notes text,
  add column if not exists offers integer default 0 not null;

alter table public.deal_files
  add column if not exists width integer,
  add column if not exists height integer;

alter table public.dispo_campaigns
  add column if not exists snapshot_id bigint,
  add column if not exists send_days smallint[] default '{1,2,3,4,5}'::smallint[] not null,
  add column if not exists send_start_hour smallint default 9 not null,
  add column if not exists send_end_hour smallint default 19 not null,
  add column if not exists min_delay_seconds integer default 20 not null,
  add column if not exists throttle_per_hour integer default 200 not null,
  add column if not exists sms_first boolean default true not null,
  add column if not exists pause_followups_for_unengaged boolean default true not null,
  add column if not exists exclusivity_minutes integer default 0 not null,
  add column if not exists stopped_at timestamp with time zone,
  add column if not exists stopped_by uuid,
  add column if not exists stop_reason text;

-- buyer automation rules act on more than tags: the tag is only required
-- when the action is 'tag' (buyer_automation_rules_action_value_chk below).
alter table public.buyer_automation_rules drop constraint if exists buyer_automation_rules_tag_check;
alter table public.buyer_automation_rules alter column tag drop not null;

-- constraints

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_automation_rules_action_chk' and conrelid = 'public.buyer_automation_rules'::regclass) then
    alter table public.buyer_automation_rules add constraint buyer_automation_rules_action_chk CHECK ((action = ANY (ARRAY['tag'::text, 'level_up'::text, 'level_down'::text, 'set_level'::text, 'set_status'::text, 'add_follow_up'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_automation_rules_action_value_chk' and conrelid = 'public.buyer_automation_rules'::regclass) then
    alter table public.buyer_automation_rules add constraint buyer_automation_rules_action_value_chk CHECK ((((action = 'tag'::text) AND (tag IS NOT NULL) AND ((length(btrim(tag)) >= 1) AND (length(btrim(tag)) <= 60))) OR (action = ANY (ARRAY['level_up'::text, 'level_down'::text])) OR ((action = 'set_level'::text) AND (action_value ~ '^[1-5]$'::text)) OR ((action = 'set_status'::text) AND (action_value = ANY (ARRAY['active'::text, 'inactive'::text, 'blacklisted'::text, 'unreachable'::text, 'vetted'::text, 'rejected'::text]))) OR ((action = 'add_follow_up'::text) AND (action_value IS NOT NULL))));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_automation_rules_level_bounds_chk' and conrelid = 'public.buyer_automation_rules'::regclass) then
    alter table public.buyer_automation_rules add constraint buyer_automation_rules_level_bounds_chk CHECK ((((level_floor >= 1) AND (level_floor <= 5)) AND ((level_ceiling >= 1) AND (level_ceiling <= 5)) AND (level_floor <= level_ceiling)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_buyer_matches_pass_reason_chk' and conrelid = 'public.deal_buyer_matches'::regclass) then
    alter table public.deal_buyer_matches add constraint deal_buyer_matches_pass_reason_chk CHECK (((pass_reason IS NULL) OR (pass_reason = ANY (ARRAY['price'::text, 'condition'::text, 'location'::text, 'timing'::text, 'property_type'::text, 'financing'::text, 'capacity'::text, 'other'::text]))));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_buyer_matches_temperature_chk' and conrelid = 'public.deal_buyer_matches'::regclass) then
    alter table public.deal_buyer_matches add constraint deal_buyer_matches_temperature_chk CHECK (((temperature IS NULL) OR (temperature = ANY (ARRAY['hot'::text, 'warm'::text, 'cold'::text]))));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_campaigns_window_chk' and conrelid = 'public.dispo_campaigns'::regclass) then
    alter table public.dispo_campaigns add constraint dispo_campaigns_window_chk CHECK ((((send_start_hour >= 0) AND (send_start_hour <= 23)) AND ((send_end_hour >= 1) AND (send_end_hour <= 24)) AND (send_start_hour < send_end_hour)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_rule_states_rule_id_fkey' and conrelid = 'public.buyer_rule_states'::regclass) then
    alter table public.buyer_rule_states add constraint buyer_rule_states_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES buyer_automation_rules(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_match_id_fkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_match_id_fkey FOREIGN KEY (match_id) REFERENCES deal_buyer_matches(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_run_id_fkey' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES discover_runs(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_campaigns_snapshot_id_fkey' and conrelid = 'public.dispo_campaigns'::regclass) then
    alter table public.dispo_campaigns add constraint dispo_campaigns_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES dispo_match_snapshots(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_campaign_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES dispo_campaigns(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_match_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_match_id_fkey FOREIGN KEY (match_id) REFERENCES deal_buyer_matches(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_message_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES dispo_campaign_messages(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshots_campaign_id_fkey' and conrelid = 'public.dispo_match_snapshots'::regclass) then
    alter table public.dispo_match_snapshots add constraint dispo_match_snapshots_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES dispo_campaigns(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_match_id_fkey' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_match_id_fkey FOREIGN KEY (match_id) REFERENCES deal_buyer_matches(id) ON DELETE SET NULL;
  end if;
end $$;

-- indexes

create index if not exists idx_buyers_price_band ON public.buyers USING btree (workspace_id, min_purchase_price, max_purchase_price);
create index if not exists communications_deal_idx ON public.communications USING btree (deal_id, occurred_at DESC);
create index if not exists communications_property_idx ON public.communications USING btree (property_id, occurred_at DESC);
create index if not exists communications_vendor_idx ON public.communications USING btree (vendor_id, occurred_at DESC);
create unique index if not exists uq_deal_buyer_matches_token ON public.deal_buyer_matches USING btree (track_token);
create index if not exists idx_deal_files_order ON public.deal_files USING btree (deal_id, category, "position");
create unique index if not exists uq_deal_files_cover ON public.deal_files USING btree (deal_id) WHERE is_cover;

-- triggers whose functions arrive in later files

drop trigger if exists deals_apply_stage_checklist on public.deals;
CREATE TRIGGER deals_apply_stage_checklist AFTER UPDATE OF stage ON public.deals FOR EACH ROW EXECUTE FUNCTION apply_stage_checklist();
drop trigger if exists properties_tidy on public.properties;
CREATE TRIGGER properties_tidy BEFORE INSERT OR UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION tidy_property_fields();

-- The deal-image function's public URL, for deal_hero. The project URL
-- is the Vault secret clozr_project_url (README); deal_hero is a
-- security_invoker view, so it reads the secret through this definer.
create or replace function public.clozr_project_url()
returns text
language sql
stable security definer
set search_path = ''
as $$
  select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'clozr_project_url' limit 1;
$$;
revoke all on function public.clozr_project_url() from public, anon;
grant execute on function public.clozr_project_url() to authenticated, service_role;

-- views

create or replace view public.workspace_roster with (security_invoker=true) as
 SELECT m.workspace_id,
    m.user_id,
    m.role,
    m.joined_at,
    p.full_name,
    p.title,
    p.avatar_url,
    p.email
   FROM (workspace_members m
     JOIN profiles p ON ((p.id = m.user_id)));
revoke all on public.workspace_roster from public, anon;
grant select, insert, update, delete on public.workspace_roster to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.workspace_roster to authenticated; end if; end $$;
grant all on public.workspace_roster to service_role;

create or replace view public.deal_underwrite_current with (security_invoker=true) as
 SELECT u.id,
    u.workspace_id,
    u.deal_id,
    u.source,
    u.status,
    u.arv,
    u.arv_low,
    u.arv_high,
    u.rehab,
    u.mao,
    u.mao_wholesale,
    u.mao_institutional,
    u.asking_price,
    u.target_assignment,
    u.confidence,
    u.comp_count,
    u.condition,
    u.red_flags,
    u.report_url,
    u.lead_id,
    u.notes,
    u.is_current,
    u.created_by,
    u.created_at,
    d.stage,
    d.offer_amount,
    d.property_id
   FROM (underwrites u
     JOIN deals d ON ((d.id = u.deal_id)))
  WHERE u.is_current;
revoke all on public.deal_underwrite_current from public, anon;
grant select, insert, update, delete on public.deal_underwrite_current to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.deal_underwrite_current to authenticated; end if; end $$;
grant all on public.deal_underwrite_current to service_role;

create or replace view public.deal_dispo_metrics with (security_invoker=true) as
 SELECT deal_id,
    workspace_id,
    count(*) AS buyers_reached,
    sum(sends) AS total_sends,
    sum(deliveries) AS total_delivered,
    sum(opens) AS total_opens,
    sum(clicks) AS total_clicks,
    sum(replies) AS total_replies,
    sum(calls) AS total_calls,
    sum(page_views) AS total_page_views,
    sum(photo_clicks) AS total_photo_clicks,
    sum(bounces) AS total_bounces,
    count(*) FILTER (WHERE (clicks > 0)) AS buyers_that_clicked,
    count(*) FILTER (WHERE (opens > 0)) AS buyers_that_opened,
    count(*) FILTER (WHERE (replies > 0)) AS buyers_that_replied,
    count(*) FILTER (WHERE (temperature = 'hot'::text)) AS hot_buyers,
    count(*) FILTER (WHERE (status = 'offered'::text)) AS buyers_that_offered,
    round(((100.0 * (count(*) FILTER (WHERE (opens > 0)))::numeric) / (NULLIF(count(*) FILTER (WHERE (sends > 0)), 0))::numeric), 1) AS open_rate_pct,
    round(((100.0 * (count(*) FILTER (WHERE (clicks > 0)))::numeric) / (NULLIF(count(*) FILTER (WHERE (sends > 0)), 0))::numeric), 1) AS click_through_rate_pct,
    round(((100.0 * (count(*) FILTER (WHERE (replies > 0)))::numeric) / (NULLIF(count(*) FILTER (WHERE (sends > 0)), 0))::numeric), 1) AS reply_rate_pct,
    max(last_engaged_at) AS last_engagement_at
   FROM deal_buyer_matches m
  GROUP BY deal_id, workspace_id;
revoke all on public.deal_dispo_metrics from public, anon;
grant select, insert, update, delete on public.deal_dispo_metrics to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.deal_dispo_metrics to authenticated; end if; end $$;
grant all on public.deal_dispo_metrics to service_role;

create or replace view public.deal_hero with (security_invoker=true) as
 WITH img AS (
         SELECT DISTINCT ON (df.deal_id) df.deal_id,
            df.url
           FROM deal_files df
          WHERE ((df.url IS NOT NULL) AND (COALESCE(df.kind, ''::text) <> 'link'::text) AND COALESCE(df.visible_to_buyers, true) AND ((df.content_type IS NULL) OR (df.content_type ~~ 'image/%'::text)))
          ORDER BY df.deal_id, df.is_cover DESC NULLS LAST, df."position", df.id
        ), gallery AS (
         SELECT df.deal_id,
            min(df.url) FILTER (WHERE (df.kind = 'link'::text)) AS link_url,
            count(*) AS link_count
           FROM deal_files df
          WHERE ((df.url IS NOT NULL) AND (df.category = 'photos'::text))
          GROUP BY df.deal_id
        )
 SELECT d.id AS deal_id,
    d.workspace_id,
    d.property_id,
        CASE
            WHEN (d.hero_image_url IS NOT NULL) THEN 'explicit'::text
            WHEN (img.url IS NOT NULL) THEN 'deal_photo'::text
            WHEN ((p.lat IS NOT NULL) AND (p.lng IS NOT NULL)) THEN 'street_view'::text
            WHEN ((p.line1 IS NOT NULL) AND (p.city IS NOT NULL)) THEN 'ungeocoded'::text
            ELSE 'no_address'::text
        END AS hero_kind,
        CASE
            WHEN (d.hero_image_url IS NOT NULL) THEN d.hero_image_url
            WHEN (img.url IS NOT NULL) THEN img.url
            WHEN ((p.lat IS NOT NULL) AND (p.lng IS NOT NULL)) THEN ((((public.clozr_project_url() || '/functions/v1/deal-image?deal='::text) || d.id) || '&t='::text) || deal_image_token(d.id))
            ELSE NULL::text
        END AS hero_url,
    p.lat,
    p.lng,
    p.geo_precision,
    COALESCE(g.link_url, d.photos_url) AS photos_url,
        CASE
            WHEN (COALESCE(g.link_url, d.photos_url) IS NULL) THEN NULL::text
            ELSE lower(split_part(regexp_replace(COALESCE(g.link_url, d.photos_url), '^https?://'::text, ''::text), '/'::text, 1))
        END AS photos_host,
    d.compr_report_url,
    d.podio_item_id,
    ( SELECT count(*) AS count
           FROM deal_files df2
          WHERE ((df2.deal_id = d.id) AND (df2.url IS NOT NULL) AND (COALESCE(df2.kind, ''::text) <> 'link'::text))) AS photo_count,
    COALESCE(g.link_count, (0)::bigint) AS gallery_link_count
   FROM (((deals d
     LEFT JOIN properties p ON ((p.id = d.property_id)))
     LEFT JOIN img ON ((img.deal_id = d.id)))
     LEFT JOIN gallery g ON ((g.deal_id = d.id)));
revoke all on public.deal_hero from public, anon;
grant select, insert, update, delete on public.deal_hero to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.deal_hero to authenticated; end if; end $$;
grant all on public.deal_hero to service_role;

create or replace view public.dispo_board_kpis with (security_invoker=true) as
 SELECT workspace_id,
    count(*) FILTER (WHERE ((closed_on IS NULL) AND (NOT COALESCE(terminated, false)))) AS available_deals,
    COALESCE(sum(COALESCE(assignment_fee, target_assignment)) FILTER (WHERE ((closed_on IS NULL) AND (NOT COALESCE(terminated, false)))), (0)::numeric) AS pending_estimated_profit,
    COALESCE(sum(COALESCE(buyer_emd_amount, earnest_money)) FILTER (WHERE ((closed_on IS NULL) AND (NOT COALESCE(terminated, false)) AND (NOT COALESCE(earnest_refunded, false)))), (0)::numeric) AS pending_emd_held,
    round(((100.0 * (count(*) FILTER (WHERE (closed_on IS NOT NULL)))::numeric) / (NULLIF(count(*) FILTER (WHERE ((closed_on IS NOT NULL) OR COALESCE(terminated, false))), 0))::numeric), 1) AS average_close_rate_pct,
    count(*) FILTER (WHERE (created_at > (now() - '30 days'::interval))) AS deals_created_30d
   FROM deals d
  GROUP BY workspace_id;
revoke all on public.dispo_board_kpis from public, anon;
grant select, insert, update, delete on public.dispo_board_kpis to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.dispo_board_kpis to authenticated; end if; end $$;
grant all on public.dispo_board_kpis to service_role;

create or replace view public.dispo_performance_monthly with (security_invoker=true) as
 WITH months AS (
         SELECT deals.workspace_id,
            (date_trunc('month'::text, deals.created_at))::date AS month
           FROM deals
        UNION
         SELECT deals.workspace_id,
            (date_trunc('month'::text, (deals.closed_on)::timestamp with time zone))::date AS date_trunc
           FROM deals
          WHERE (deals.closed_on IS NOT NULL)
        UNION
         SELECT deals.workspace_id,
            (date_trunc('month'::text, (deals.terminated_on)::timestamp with time zone))::date AS date_trunc
           FROM deals
          WHERE (deals.terminated_on IS NOT NULL)
        )
 SELECT m.workspace_id,
    m.month,
    count(*) FILTER (WHERE ((date_trunc('month'::text, d.created_at))::date = m.month)) AS deals_created,
    count(*) FILTER (WHERE ((date_trunc('month'::text, (d.closed_on)::timestamp with time zone))::date = m.month)) AS deals_closed,
    count(*) FILTER (WHERE (((date_trunc('month'::text, (d.terminated_on)::timestamp with time zone))::date = m.month) AND d.terminated)) AS deals_cancelled,
    COALESCE(sum(d.assignment_fee) FILTER (WHERE ((date_trunc('month'::text, (d.closed_on)::timestamp with time zone))::date = m.month)), (0)::numeric) AS assignment_fee_total,
    round(avg(d.assignment_fee) FILTER (WHERE ((date_trunc('month'::text, (d.closed_on)::timestamp with time zone))::date = m.month)), 2) AS assignment_fee_avg,
    COALESCE(sum(d.final_profit) FILTER (WHERE ((date_trunc('month'::text, (d.closed_on)::timestamp with time zone))::date = m.month)), (0)::numeric) AS net_profit_total,
    round(((100.0 * (count(*) FILTER (WHERE (((date_trunc('month'::text, (d.terminated_on)::timestamp with time zone))::date = m.month) AND d.terminated)))::numeric) / (NULLIF(count(*) FILTER (WHERE ((date_trunc('month'::text, d.created_at))::date = m.month)), 0))::numeric), 1) AS cancellation_rate_pct
   FROM (months m
     JOIN deals d ON ((d.workspace_id = m.workspace_id)))
  GROUP BY m.workspace_id, m.month;
revoke all on public.dispo_performance_monthly from public, anon;
grant select, insert, update, delete on public.dispo_performance_monthly to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.dispo_performance_monthly to authenticated; end if; end $$;
grant all on public.dispo_performance_monthly to service_role;

create or replace view public.dispo_rep_leaderboard with (security_invoker=true) as
 SELECT d.workspace_id,
    d.dispo_rep_id AS rep_id,
    p.full_name AS rep_name,
    count(*) FILTER (WHERE (d.closed_on IS NOT NULL)) AS deals_closed,
    count(*) FILTER (WHERE ((d.closed_on IS NULL) AND (NOT COALESCE(d.terminated, false)))) AS deals_open,
    COALESCE(sum(d.assignment_fee) FILTER (WHERE (d.closed_on IS NOT NULL)), (0)::numeric) AS assignment_fee_total,
    round(avg(d.assignment_fee) FILTER (WHERE (d.closed_on IS NOT NULL)), 2) AS assignment_fee_avg,
    COALESCE(sum(d.final_profit) FILTER (WHERE (d.closed_on IS NOT NULL)), (0)::numeric) AS net_profit_total,
    round(((100.0 * (count(*) FILTER (WHERE (d.closed_on IS NOT NULL)))::numeric) / (NULLIF(count(*), 0))::numeric), 1) AS close_rate_pct,
    max(d.closed_on) AS last_close_on
   FROM (deals d
     LEFT JOIN profiles p ON ((p.id = d.dispo_rep_id)))
  WHERE (d.dispo_rep_id IS NOT NULL)
  GROUP BY d.workspace_id, d.dispo_rep_id, p.full_name;
revoke all on public.dispo_rep_leaderboard from public, anon;
grant select, insert, update, delete on public.dispo_rep_leaderboard to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.dispo_rep_leaderboard to authenticated; end if; end $$;
grant all on public.dispo_rep_leaderboard to service_role;

create or replace view public.dispo_score_calibration with (security_invoker=true) as
 SELECT s.workspace_id,
    s.deal_id,
    s.buyer_id,
    s.pulled_on,
    m.score AS clozr_score,
    m.reasons AS clozr_reasons,
    b.level AS clozr_level,
    s.probability_score AS dispogenius_probability,
    s.temperature AS dispogenius_temperature,
    s.status AS dispogenius_status,
    COALESCE(s.replied, false) AS replied,
    COALESCE(s.offered, false) AS offered,
    s.offer_amount,
    s.pct_of_arv,
    (((COALESCE(s.email_opened_count, 0) + COALESCE(s.link_clicks, 0)) + COALESCE(s.call_count, 0)) + COALESCE(s.message_count, 0)) AS engagement_events
   FROM ((dispogenius_buyer_snapshots s
     LEFT JOIN deal_buyer_matches m ON (((m.deal_id = s.deal_id) AND (m.buyer_id = s.buyer_id))))
     LEFT JOIN buyers b ON ((b.id = s.buyer_id)))
  WHERE ((s.buyer_id IS NOT NULL) AND (s.deal_id IS NOT NULL));
revoke all on public.dispo_score_calibration from public, anon;
grant select, insert, update, delete on public.dispo_score_calibration to authenticated;
do $$ begin if current_setting('server_version_num')::int >= 170000 then grant maintain on public.dispo_score_calibration to authenticated; end if; end $$;
grant all on public.dispo_score_calibration to service_role;

-- realtime

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'discovery_jobs') then
    alter publication supabase_realtime add table public.discovery_jobs;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inbox_threads') then
    alter publication supabase_realtime add table public.inbox_threads;
  end if;
end $$;

-- function privileges the live project narrowed after the files that create them

revoke all on function public.ensure_calendar_token(ws bigint, rotate boolean) from public, anon, authenticated;
grant execute on function public.ensure_calendar_token(ws bigint, rotate boolean) to authenticated, service_role;
revoke all on function public.ingest_replay(p_workspace_id bigint, p_source text, p_since timestamp with time zone) from public, anon, authenticated;
grant execute on function public.ingest_replay(p_workspace_id bigint, p_source text, p_since timestamp with time zone) to authenticated, service_role;
revoke all on function public.issue_ingest_key(p_workspace_id bigint, p_name text, p_label text) from public, anon, authenticated;
grant execute on function public.issue_ingest_key(p_workspace_id bigint, p_name text, p_label text) to authenticated, service_role;
revoke all on function public.set_ingest_secret(p_id bigint, p_secret text) from public, anon, authenticated;
grant execute on function public.set_ingest_secret(p_id bigint, p_secret text) to authenticated, service_role;
revoke all on function public.tidy_property_fields() from public, anon, authenticated;
grant execute on function public.tidy_property_fields() to service_role;
