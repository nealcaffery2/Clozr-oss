-- 386: Plan sends take turns between workspaces and channels.
--
-- plan_send_claim handed out the oldest due steps first across every
-- workspace. With one workspace's backlog in front (Compr had 1,200 overdue
-- steps, 566 of them emails waiting on full inboxes and re-queued every 15
-- minutes), another workspace's texts waited behind all of it: Acme Homes'
-- 307 intro texts sent nothing for an hour. The claim now ranks each due
-- step within its own workspace and channel and takes the first of every
-- line before the second of any, oldest first inside each. Same filters,
-- same columns, same locking. Safe to re-run.

create or replace function public.plan_send_claim(p_limit integer default 20)
returns table(task_id bigint, workspace_id bigint, enrollment_id bigint, plan_step_id bigint, seller_id bigint, buyer_id bigint, assigned_to uuid, created_by uuid, notes text, deal_id bigint, channel text, subject text, step_title text, config jsonb, plan_name text, plan_settings jsonb)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
  with ready as (
    select tk.id as id, tk.due_at as due_at,
           row_number() over (partition by tk.workspace_id, s.channel order by tk.due_at, tk.id) as turn
      from public.tasks tk
      join public.enrollments en on en.id = tk.enrollment_id
      join public.action_plan_steps s on s.id = tk.plan_step_id
      join public.action_plans p on p.id = en.plan_id
      join public.workspaces w on w.id = tk.workspace_id
     where tk.done = false
       and tk.due_at <= now()
       and en.status = 'active'
       and s.channel in ('email', 'sms', 'tag', 'assign', 'stage')
       and (tk.plan_claim_at is null or tk.plan_claim_at < now() - interval '10 minutes')
       and (
         coalesce(p.settings->>'auto_send', '') = 'true'
         or (
           coalesce(p.settings->>'auto_send', '') <> 'false'
           and coalesce(w.settings->>'buyer_profile', '') = 'compr'
         )
       )
  ),
  due as (
    select tk.id as id
      from public.tasks tk
      join ready r on r.id = tk.id
     order by r.turn, r.due_at, r.id
     limit least(greatest(coalesce(p_limit, 20), 1), 40)
     for update of tk skip locked
  ),
  claimed as (
    update public.tasks t
       set plan_claim_at = now()
      from due
     where t.id = due.id
    returning t.id, t.workspace_id, t.enrollment_id, t.plan_step_id, t.seller_id, t.buyer_id,
              t.assigned_to, t.created_by, t.notes, t.deal_id
  )
  select c.id, c.workspace_id, c.enrollment_id, c.plan_step_id, c.seller_id, c.buyer_id,
         c.assigned_to, coalesce(c.created_by, en.created_by), c.notes, c.deal_id,
         s.channel, s.subject, s.title, s.config, p.name, p.settings
    from claimed c
    join public.enrollments en on en.id = c.enrollment_id
    join public.action_plan_steps s on s.id = c.plan_step_id
    join public.action_plans p on p.id = en.plan_id;
end $function$;
