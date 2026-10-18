-- 291: a reply reaches the rep who reached out, in the workspace it belongs to.
--
--  1. Texts that go out on rotating pool lines belong to no one in
--     rep_phone_numbers, so a contact's reply named nobody and the bell row
--     went to the workspace owner. The rep who last texted, called or emailed
--     that number now gets it, before the record's rep and the owner.
--  2. A reply by email made no notification at all. One that answers an email
--     a rep sent that contact in the last 45 days now notifies that rep
--     ("Email reply"). Bounces and auto-replies are left out.
--  3. Workspaces that share a Talkr org: talkr_elsewhere (275) sent a number
--     to the other workspace only when this one had no record of it. Now,
--     when both have the contact, the workspace that reached out to them last
--     keeps it. call-sync also files inbound texts now (it only did calls), so
--     a reply lands in the right workspace without anyone having it open.
--  4. tasks.automated: an action-plan step the plan sends by itself (email,
--     text, tag, assign, stage on an auto-sending plan, the same rule as
--     plan_send_claim; ringless drops and AI-agent steps, which their own ticks
--     run). The task lists leave these out, so they show only the steps a
--     person has to do by hand.
--
-- Safe to re-run.

-- ---- outbound lookups by number -------------------------------------------------------
create index if not exists communications_out_to_idx
  on public.communications (workspace_id, to_phone, occurred_at desc)
  where direction = 'outbound';

-- The rep who last reached this number (or this record) in the workspace, in the last 30 days.
create or replace function public.last_outreach_rep(p_workspace bigint, p_phone text, p_buyer bigint default null, p_seller bigint default null)
 returns uuid
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select rep_id from (
    select c.rep_id, c.occurred_at from public.communications c
     where p_phone is not null and c.workspace_id = p_workspace and c.to_phone = p_phone
       and c.direction = 'outbound' and c.rep_id is not null and c.occurred_at > now() - interval '30 days'
     order by c.occurred_at desc limit 1
  ) a
  union all
  select rep_id from (
    select c.rep_id, c.occurred_at from public.communications c
     where p_buyer is not null and c.buyer_id = p_buyer and c.workspace_id = p_workspace
       and c.direction = 'outbound' and c.rep_id is not null and c.channel <> 'note' and c.occurred_at > now() - interval '30 days'
     order by c.occurred_at desc limit 1
  ) b
  union all
  select rep_id from (
    select c.rep_id, c.occurred_at from public.communications c
     where p_seller is not null and c.seller_id = p_seller and c.workspace_id = p_workspace
       and c.direction = 'outbound' and c.rep_id is not null and c.channel <> 'note' and c.occurred_at > now() - interval '30 days'
     order by c.occurred_at desc limit 1
  ) s
  limit 1;
$function$;
revoke all on function public.last_outreach_rep(bigint, text, bigint, bigint) from public, anon, authenticated;

-- When this workspace last reached out to a number (calls, texts, drops).
create or replace function public.last_outreach_at(p_workspace bigint, p_phone text)
 returns timestamptz
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select max(c.occurred_at) from public.communications c
   where c.workspace_id = p_workspace and c.to_phone = p_phone and c.direction = 'outbound'
     and c.occurred_at > now() - interval '30 days';
$function$;
revoke all on function public.last_outreach_at(bigint, text) from public, anon, authenticated;

-- ---- 1. the text's bell row goes to the rep who reached out -------------------------------
create or replace function public.inbox_on_communication()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_theirs text;
  v_ours   text;
  v_match  record;
  v_thread public.inbox_threads;
  v_body   text := lower(btrim(coalesce(new.body, '')));
  v_inbound boolean := new.direction = 'inbound';
  v_assignee uuid;
begin
  if new.channel not in ('sms','call','voicemail') or coalesce(new.direction,'') not in ('inbound','outbound') then
    return new;
  end if;
  v_theirs := public.normalize_phone(case when v_inbound then new.from_phone else new.to_phone end);
  v_ours   := public.normalize_phone(case when v_inbound then new.to_phone else new.from_phone end);
  if v_theirs is null then return new; end if;

  -- A sync that sends the same message again (Podio every 10 minutes, a
  -- webhook retry) is an upsert on (workspace_id, source, source_id): this
  -- BEFORE INSERT trigger still runs for it. The message already counted;
  -- nothing more to do.
  if new.source_id is not null and exists (
       select 1 from public.communications c
        where c.workspace_id = new.workspace_id and c.source = new.source and c.source_id = new.source_id) then
    return new;
  end if;

  if new.buyer_id is null and new.seller_id is null then
    select * into v_match from public.match_contact_by_phone(new.workspace_id, v_theirs);
    new.buyer_id  := v_match.buyer_id;
    new.seller_id := case when v_match.buyer_id is null then v_match.seller_id end;
  end if;

  select coalesce(
           (select coalesce(assigned_to, owner_id) from public.buyers  where id = new.buyer_id),
           (select coalesce(assigned_to, owner_id) from public.sellers where id = new.seller_id))
    into v_assignee;

  insert into public.inbox_threads as t (
    workspace_id, phone_key, our_phone, buyer_id, seller_id, assigned_to,
    unread_count, last_message_at, last_inbound_at, last_outbound_at,
    last_direction, last_channel, last_preview, awaiting_reply_since)
  values (
    new.workspace_id, v_theirs, v_ours, new.buyer_id, new.seller_id, v_assignee,
    case when v_inbound and (new.channel <> 'call' or new.status in ('missed','no_answer','no-answer')) then 1 else 0 end,
    new.occurred_at,
    case when v_inbound then new.occurred_at end,
    case when not v_inbound then new.occurred_at end,
    new.direction, new.channel, left(coalesce(new.body, new.summary, initcap(new.channel)), 160),
    case when v_inbound and new.channel = 'sms' then new.occurred_at end)
  on conflict (workspace_id, phone_key) do update set
    our_phone        = coalesce(excluded.our_phone, t.our_phone),
    buyer_id         = coalesce(t.buyer_id, excluded.buyer_id),
    seller_id        = coalesce(t.seller_id, excluded.seller_id),
    assigned_to      = coalesce(t.assigned_to, excluded.assigned_to),
    unread_count     = t.unread_count + excluded.unread_count,
    status           = case when v_inbound then 'open' else t.status end,
    last_inbound_at  = greatest(t.last_inbound_at, excluded.last_inbound_at),
    last_outbound_at = greatest(t.last_outbound_at, excluded.last_outbound_at),
    awaiting_reply_since = case
                             when not v_inbound then null
                             when new.channel = 'sms' then coalesce(t.awaiting_reply_since, excluded.awaiting_reply_since)
                             else t.awaiting_reply_since end,
    last_message_at  = greatest(t.last_message_at, excluded.last_message_at),
    last_direction   = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_direction else t.last_direction end,
    last_channel     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_channel   else t.last_channel   end,
    last_preview     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_preview   else t.last_preview   end,
    updated_at       = now()
  returning * into v_thread;

  new.thread_id := v_thread.id;

  if v_inbound and new.channel = 'sms' then
    if v_body in ('stop','stopall','unsubscribe','cancel','end','quit','revoke','optout','opt out','stop all') then
      update public.inbox_threads set opted_out_at = coalesce(opted_out_at, new.occurred_at) where id = v_thread.id;
      update public.buyer_phones set is_dnc = true, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    elsif v_body in ('start','unstop','subscribe') then
      update public.inbox_threads set opted_out_at = null where id = v_thread.id;
      update public.buyer_phones set is_dnc = false, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    end if;

    insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, phone_key, created_at)
    select new.workspace_id,
           -- Whose conversation: the rep on the text, else the owner of the line it
           -- came in on (rep_phone_numbers, migration 153: the line trigger runs
           -- after this one, so the line is looked up here), else the rep who last
           -- reached out to them (a shared pool line names nobody), else the
           -- record's rep, the thread's, the workspace owner. One person, never the team.
           coalesce(new.rep_id,
                    (select r.user_id from public.rep_phone_numbers r
                      where r.workspace_id = new.workspace_id and r.user_id is not null
                        and right(regexp_replace(r.phone_e164, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_ours, ''), '\D', '', 'g'), 10)
                      limit 1),
                    public.last_outreach_rep(new.workspace_id, v_theirs, new.buyer_id, new.seller_id),
                    v_assignee, v_thread.assigned_to, w.owner_id),
           'inbound_sms',
           'New text from ' || coalesce(
              (select name from public.buyers where id = new.buyer_id),
              (select name from public.sellers where id = new.seller_id),
              v_theirs),
           left(coalesce(new.body, ''), 200),
           new.buyer_id, new.seller_id, v_theirs,
           -- A text filed late (the server mirror catching up) is dated when it came in.
           least(now(), coalesce(new.occurred_at, now()))
      from public.workspaces w where w.id = new.workspace_id;
  end if;

  return new;
end $function$;

-- sms_flow_after_inbound (200) finds the row above by created_at >= now();
-- a late text's row is dated earlier, so it looks by the number and the minute instead.
create or replace function public.sms_flow_after_inbound()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_line   text := public.normalize_phone(new.to_phone);
  v_theirs text := public.normalize_phone(new.from_phone);
  v_users  uuid[];
  v_title  text;
  v_body   text;
  v_at     timestamptz := least(now(), coalesce(new.occurred_at, now()));
begin
  if new.channel <> 'sms' or new.direction is distinct from 'inbound' or v_line is null or v_theirs is null then
    return null;
  end if;
  select array_agg(u) into v_users
    from public.line_sms_flows f, unnest(f.notify_user_ids) u
   where f.workspace_id = new.workspace_id and f.phone_e164 = v_line
     and exists (select 1 from public.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = u);
  if v_users is null then return null; end if;

  select n.title, n.body into v_title, v_body
    from public.notifications n
   where n.workspace_id = new.workspace_id and n.category = 'inbound_sms' and n.phone_key = v_theirs and n.created_at >= v_at
   limit 1;
  if v_title is null then
    v_title := 'New text from ' || coalesce(
      (select name from public.buyers where id = new.buyer_id),
      (select name from public.sellers where id = new.seller_id),
      v_theirs);
    v_body := left(coalesce(new.body, ''), 200);
  end if;

  delete from public.notifications n
   where n.workspace_id = new.workspace_id and n.category = 'inbound_sms' and n.phone_key = v_theirs
     and n.created_at >= v_at and not (n.user_id = any (v_users));

  insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, phone_key, created_at)
  select new.workspace_id, u, 'inbound_sms', v_title, v_body, new.buyer_id, new.seller_id, v_theirs, v_at
    from unnest(v_users) u
   where not exists (select 1 from public.notifications n
                      where n.workspace_id = new.workspace_id and n.category = 'inbound_sms' and n.phone_key = v_theirs
                        and n.created_at >= v_at and n.user_id = u);
  return null;
end $function$;

-- ---- 2. a reply by email --------------------------------------------------------------------
-- The reply's own words: tags, styles and the quoted thread ("On … wrote:") left out.
create or replace function public.email_reply_text(p_body text)
 returns text
 language sql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
  select left(btrim(regexp_replace(
           split_part(split_part(
             regexp_replace(regexp_replace(regexp_replace(coalesce(p_body, ''), '<head.*?</head>', ' ', 'gi'), '<style.*?</style>', ' ', 'gi'), '<[^>]+>', ' ', 'g'),
             ' wrote:', 1), '-----Original Message', 1),
           '(&nbsp;|\s)+', ' ', 'g')), 200);
$function$;

create or replace function public.notify_email_reply()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rep  uuid;
  v_subj text := coalesce(new.subject, '');
  v_text text;
  v_name text;
begin
  if new.channel <> 'email' or new.direction is distinct from 'inbound' then return null; end if;
  if new.buyer_id is null and new.seller_id is null then return null; end if;
  -- A mailbox import of old mail is history, not news.
  if new.occurred_at < now() - interval '2 days' then return null; end if;
  if v_subj ~* '^(delivery status notification|undeliver|mail delivery|returned mail|failure notice|automatic reply|auto(matic)?[- ]?reply|out of (the )?office)'
     or coalesce(new.from_email, '') ~* '(mailer-daemon|postmaster|no-?reply)' then
    return null;
  end if;
  -- A reply: someone here emailed this contact in the last 45 days. That rep is whose it is.
  select c.rep_id into v_rep
    from public.communications c
   where c.workspace_id = new.workspace_id and c.channel = 'email' and c.direction = 'outbound'
     and c.rep_id is not null and c.occurred_at < new.occurred_at and c.occurred_at > new.occurred_at - interval '45 days'
     and ((new.buyer_id is not null and c.buyer_id = new.buyer_id) or (new.seller_id is not null and c.seller_id = new.seller_id))
   order by c.occurred_at desc limit 1;
  if v_rep is null then return null; end if;
  v_rep := coalesce(new.rep_id, v_rep);
  if exists (select 1 from public.notifications n
              where n.workspace_id = new.workspace_id and n.category = 'Email reply' and n.payload->>'comm_id' = new.id::text) then
    return null;
  end if;
  v_text := public.email_reply_text(new.body);
  v_name := coalesce((select name from public.buyers where id = new.buyer_id), (select name from public.sellers where id = new.seller_id), new.from_email, 'a contact');
  insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, payload, created_at)
  values (new.workspace_id, v_rep, 'Email reply', 'Email reply from ' || v_name,
          left(case when v_subj <> '' and v_text <> '' then v_subj || ' · ' || v_text else coalesce(nullif(v_text, ''), v_subj) end, 220),
          new.buyer_id, new.seller_id, jsonb_build_object('comm_id', new.id),
          least(now(), coalesce(new.occurred_at, now())));
  return null;
end $function$;

drop trigger if exists communications_email_reply on public.communications;
create trigger communications_email_reply
  after insert on public.communications
  for each row when (new.channel = 'email' and new.direction = 'inbound')
  execute function public.notify_email_reply();

-- ---- 3. a contact in both workspaces belongs to the one that reached out last ---------------
create or replace function public.talkr_elsewhere(p_workspace bigint, p_numbers text[] default '{}', p_source_ids text[] default '{}')
 returns table(kind text, key text, workspace_id bigint)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_others bigint[];
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = auth.uid()) then
    return;
  end if;
  v_others := public.talkr_elsewhere_ids(p_workspace);
  if cardinality(v_others) = 0 then return; end if;

  return query
    with n as (
      select distinct public.normalize_phone(x) as k from unnest((coalesce(p_numbers, '{}'::text[]))[1:500]) x
    ), there as (
      select n.k, o.id as ws, public.talkr_is_contact(p_workspace, n.k) as here_too
        from n cross join lateral (
          select o.id from unnest(v_others) o(id) where public.talkr_is_contact(o.id, n.k) order by o.id limit 1
        ) o
       where n.k is not null
    )
    select 'number'::text, t.k, t.ws
      from there t
     where not t.here_too
        -- A contact here too: theirs when they reached out last (and recently).
        or coalesce(public.last_outreach_at(t.ws, t.k), '-infinity') > coalesce(public.last_outreach_at(p_workspace, t.k), '-infinity');

  return query
    select distinct on (c.source_id) 'source'::text, c.source_id, c.workspace_id
      from public.communications c
     where c.workspace_id = any(v_others)
       and c.source = 'talkr'
       and c.source_id = any((coalesce(p_source_ids, '{}'::text[]))[1:500])
       and (c.seller_id is not null or c.buyer_id is not null)
     order by c.source_id, c.workspace_id;
end $function$;
revoke all on function public.talkr_elsewhere(bigint, text[], text[]) from public, anon;
grant execute on function public.talkr_elsewhere(bigint, text[], text[]) to authenticated, service_role;

-- ---- 4. tasks the plan does by itself ---------------------------------------------------------
alter table public.tasks add column if not exists automated boolean not null default false;

create or replace function public.task_is_automated(p_step bigint, p_workspace bigint)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select s.channel in ('rvm', 'ai_agent')
        or (s.channel in ('email', 'sms', 'tag', 'assign', 'stage')
            and coalesce(p.settings->>'auto_send', '') = 'true')
      from public.action_plan_steps s
      join public.action_plans p on p.id = s.plan_id
     where s.id = p_step
  ), false);
$function$;

create or replace function public.tasks_mark_automated()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  new.automated := new.plan_step_id is not null and public.task_is_automated(new.plan_step_id, new.workspace_id);
  return new;
end $function$;

drop trigger if exists tasks_mark_automated on public.tasks;
create trigger tasks_mark_automated
  before insert or update of plan_step_id on public.tasks
  for each row execute function public.tasks_mark_automated();

update public.tasks t
   set automated = true
 where t.plan_step_id is not null and not t.automated
   and public.task_is_automated(t.plan_step_id, t.workspace_id);

create index if not exists tasks_open_manual_idx
  on public.tasks (workspace_id, due_at, id) where not automated;
