-- 200 · Settings → Numbers, rebuilt around people (smrtPhone's layout).
--
-- Additive only: one column on rep_phone_numbers, two new tables, two new
-- functions and one new trigger. Nothing existing is redefined.
--
-- 1. rep_phone_numbers.is_caller_id: the line a person calls and texts from.
--    At most one per person (partial unique index). Handing a line to someone
--    else clears its flag. A person with exactly one line gets it set here;
--    people with several pick one on the Numbers tab.
-- 2. set_line_caller_id(workspace, phone): admins for anyone, a rep for their
--    own line. Talkr's own caller ID (default_phone_number_id) is set by the
--    app in the same click.
-- 3. line_sms_flows: per line, who its texts go to and an optional auto-reply
--    (always, or outside business hours, at most once per texter per N hours).
--    Members read, owners and admins write. No row = today's routing.
-- 4. line_sms_auto_replies: each auto-reply talkr-webhook claimed and sent,
--    keyed by the inbound event so a redelivery never texts twice.
-- 5. sms_flow_after_inbound: an inbound text on a line whose flow names people
--    notifies those people instead of the one 159's inbox trigger picked.

-- 1 ────────────────────────────────────────────────────────────────────────────
alter table public.rep_phone_numbers add column if not exists is_caller_id boolean not null default false;

create unique index if not exists rep_phone_numbers_one_caller_id
  on public.rep_phone_numbers (workspace_id, user_id) where is_caller_id and user_id is not null;

create or replace function public.rep_phone_numbers_caller_id_follows_owner()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.user_id is distinct from old.user_id then new.is_caller_id := false; end if;
  return new;
end $function$;

drop trigger if exists rep_phone_numbers_caller_id_follows_owner on public.rep_phone_numbers;
create trigger rep_phone_numbers_caller_id_follows_owner
  before update of user_id on public.rep_phone_numbers
  for each row execute function public.rep_phone_numbers_caller_id_follows_owner();

update public.rep_phone_numbers r
   set is_caller_id = true
 where r.user_id is not null
   and not r.is_caller_id
   and not exists (select 1 from public.rep_phone_numbers o
                    where o.workspace_id = r.workspace_id and o.user_id = r.user_id and o.phone_e164 <> r.phone_e164);

-- 2 ────────────────────────────────────────────────────────────────────────────
create or replace function public.set_line_caller_id(p_workspace bigint, p_phone text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.rep_phone_numbers
   where workspace_id = p_workspace and phone_e164 = p_phone;
  if not found then raise exception 'that line is not on this workspace' using errcode = 'P0002'; end if;
  if v_owner is null then raise exception 'a company line cannot be a caller ID; give it an owner first' using errcode = '22023'; end if;
  if v_owner is distinct from auth.uid() and not public.has_role(p_workspace, 'owner', 'admin') then
    raise exception 'only the line''s owner or an admin can change this' using errcode = '42501';
  end if;
  update public.rep_phone_numbers set is_caller_id = false, updated_at = now()
   where workspace_id = p_workspace and user_id = v_owner and is_caller_id and phone_e164 <> p_phone;
  update public.rep_phone_numbers set is_caller_id = true, updated_at = now()
   where workspace_id = p_workspace and phone_e164 = p_phone;
end $function$;

revoke all on function public.set_line_caller_id(bigint, text) from public, anon;
grant execute on function public.set_line_caller_id(bigint, text) to authenticated;

-- 3 ────────────────────────────────────────────────────────────────────────────
create table if not exists public.line_sms_flows (
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  phone_e164         text not null check (phone_e164 ~ '^\+1\d{10}$'),
  -- Talkr's id for the line: the auto-reply goes out from it.
  talkr_number_id    text,
  -- Who a text to this line notifies. Empty = the default (159): the rep on
  -- the conversation, else the line's owner, else the record's rep.
  notify_user_ids    uuid[] not null default '{}',
  auto_reply_enabled boolean not null default false,
  auto_reply_body    text check (auto_reply_body is null or length(auto_reply_body) <= 480),
  auto_reply_when    text not null default 'always' check (auto_reply_when in ('always', 'after_hours')),
  -- { "timezone": "America/Chicago", "days": { "mon": ["09:00","17:00"], … } }; a missing day is closed.
  hours              jsonb,
  cooldown_hours     integer not null default 24 check (cooldown_hours between 0 and 720),
  updated_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, phone_e164)
);

alter table public.line_sms_flows enable row level security;

drop policy if exists line_sms_flows_read on public.line_sms_flows;
create policy line_sms_flows_read on public.line_sms_flows for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = line_sms_flows.workspace_id and m.user_id = (select auth.uid())));

drop policy if exists line_sms_flows_write on public.line_sms_flows;
create policy line_sms_flows_write on public.line_sms_flows for all to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = line_sms_flows.workspace_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')))
  with check (exists (select 1 from public.workspace_members m
                  where m.workspace_id = line_sms_flows.workspace_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')));

-- 4 ────────────────────────────────────────────────────────────────────────────
create table if not exists public.line_sms_auto_replies (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  line_e164    text not null,
  to_e164      text not null,
  -- The inbound Talkr event id: one reply per inbound text, however often it is delivered.
  inbound_ref  text not null,
  status       text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  error        text,
  created_at   timestamptz not null default now(),
  unique (workspace_id, inbound_ref)
);

create index if not exists line_sms_auto_replies_recent
  on public.line_sms_auto_replies (workspace_id, line_e164, to_e164, created_at desc);

alter table public.line_sms_auto_replies enable row level security;

drop policy if exists line_sms_auto_replies_read on public.line_sms_auto_replies;
create policy line_sms_auto_replies_read on public.line_sms_auto_replies for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = line_sms_auto_replies.workspace_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')));

-- 5 ────────────────────────────────────────────────────────────────────────────
-- communications_inbox (BEFORE INSERT) has already notified one person in this
-- statement. When the line's flow names people, the notification moves to
-- them: same title and body, the default recipient's row dropped unless they
-- are on the list. Former members on the list are skipped; a list with nobody
-- left keeps the default.
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
   where n.workspace_id = new.workspace_id and n.category = 'inbound_sms' and n.phone_key = v_theirs and n.created_at >= now()
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
     and n.created_at >= now() and not (n.user_id = any (v_users));

  insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, phone_key)
  select new.workspace_id, u, 'inbound_sms', v_title, v_body, new.buyer_id, new.seller_id, v_theirs
    from unnest(v_users) u
   where not exists (select 1 from public.notifications n
                      where n.workspace_id = new.workspace_id and n.category = 'inbound_sms' and n.phone_key = v_theirs
                        and n.created_at >= now() and n.user_id = u);
  return null;
end $function$;

create or replace trigger communications_sms_flow
  after insert on public.communications
  for each row
  when (new.channel = 'sms' and new.direction = 'inbound'
        and (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day'))
  execute function public.sms_flow_after_inbound();
