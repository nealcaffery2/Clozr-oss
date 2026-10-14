-- 268 · Cold campaigns that keep themselves fed, and replies that go back to
-- the rep whose inbox sent the mail.
--
-- 1. cold_campaigns.auto_enroll: cold_auto_enroll(campaign) keeps an active
--    tag campaign topped up to 600 contacts that have not had step 1 yet.
--    Same rules as Launch (cold-pool): not on the suppression list, no role
--    address (info@, sales@ …, ROLE_LOCAL_PARTS in _shared/cold-campaign.ts),
--    no catch-all, when the workspace's cold settings say so. A workspace with
--    settings.require_verified_email only takes verified addresses. Nobody is
--    enrolled twice in any cold campaign of the workspace.
-- 2. cold_mailboxes.user_id: the rep an inbox sends as. cold-campaign-tick
--    routes a reply to the contact's assigned rep, else this rep, and assigns
--    the contact to this rep when nobody had them (replyOwner, assignOnReply).
--
-- cold_autopilot() runs 1 for every active auto_enroll campaign, every 30
-- minutes (pg_cron). Nothing changes until a campaign has auto_enroll on and
-- is launched. Safe to re-run.

alter table public.cold_mailboxes add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cold_campaigns add column if not exists auto_enroll boolean not null default false;

create index if not exists cold_enrollments_ws_email_idx on public.cold_enrollments (workspace_id, email);

create or replace function public.cold_auto_enroll(p_campaign bigint, p_buffer int default 600)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  c record;
  v_fresh int;
  v_room int;
  v_verified boolean;
  v_roles boolean;
  v_catch boolean;
  v_added int;
  -- ROLE_LOCAL_PARTS in supabase/functions/_shared/cold-campaign.ts
  v_role_parts constant text[] := array[
    'info', 'admin', 'administrator', 'sales', 'support', 'hello', 'contact', 'office', 'team',
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse', 'webmaster',
    'marketing', 'hr', 'jobs', 'billing', 'accounts', 'enquiries', 'inquiries', 'help',
    'mail', 'officeadmin', 'security', 'privacy', 'legal', 'newsletter'];
begin
  select * into c from public.cold_campaigns
   where id = p_campaign and status = 'active' and auto_enroll and audience_kind = 'tag'
     and coalesce(audience_tag, '') <> '';
  if not found then return 0; end if;
  if not exists (select 1 from public.cold_steps where campaign_id = p_campaign) then return 0; end if;

  select count(*) into v_fresh from public.cold_enrollments
   where campaign_id = p_campaign and status = 'active' and last_sent_at is null;
  v_room := p_buffer - v_fresh;
  if v_room <= 0 then return 0; end if;

  select coalesce((settings->>'require_verified_email')::boolean, false) into v_verified
    from public.workspaces where id = c.workspace_id;
  select coalesce((deliverability->>'suppress_roles')::boolean, true),
         coalesce((deliverability->>'suppress_catch_all')::boolean, true)
    into v_roles, v_catch
    from public.cold_workspace_settings where workspace_id = c.workspace_id;
  v_roles := coalesce(v_roles, true);
  v_catch := coalesce(v_catch, true);

  insert into public.cold_enrollments
    (workspace_id, campaign_id, buyer_id, email, state, status, step_position, next_send_at)
  select c.workspace_id, p_campaign, x.id, x.email, null, 'active', 1, now()
    from (
      select distinct on (lower(trim(b.email))) b.id, lower(trim(b.email)) as email
        from public.buyers b
       where b.workspace_id = c.workspace_id
         and b.archived_at is null and b.blacklisted_at is null
         and b.tags @> array[c.audience_tag]
         and coalesce(b.email, '') like '%_@_%'
         and case when v_verified then b.email_safe_to_send is true else b.email_safe_to_send is not false end
         and (not v_catch or coalesce(lower(b.email_status), '') <> 'catch_all')
         and (not v_roles or split_part(split_part(lower(trim(b.email)), '@', 1), '+', 1) <> all(v_role_parts))
       order by lower(trim(b.email)), b.id
    ) x
   where not exists (select 1 from public.cold_enrollments e where e.workspace_id = c.workspace_id and e.email = x.email)
     and not exists (select 1 from public.email_suppressions s where s.workspace_id = c.workspace_id and s.email = x.email)
   order by x.id
   limit v_room
  on conflict do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end $$;
revoke execute on function public.cold_auto_enroll(bigint, int) from public, anon, authenticated;

create or replace function public.cold_autopilot()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  k record;
  out jsonb := '{}'::jsonb;
begin
  for k in select id from public.cold_campaigns where status = 'active' and auto_enroll loop
    out := out || jsonb_build_object(k.id::text, public.cold_auto_enroll(k.id));
  end loop;
  return out;
end $$;
revoke execute on function public.cold_autopilot() from public, anon, authenticated;

select cron.unschedule('clozr-cold-autopilot') where exists (select 1 from cron.job where jobname = 'clozr-cold-autopilot');
select cron.schedule('clozr-cold-autopilot', '*/30 * * * *', 'select public.cold_autopilot()');

notify pgrst, 'reload schema';
