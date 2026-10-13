-- A line's owner owns its calls and texts, before and after they are set.
--
-- Migration 153 credits a message to the rep whose line it used, but only on
-- insert and once in a backfill, and only for lines that had an owner then.
-- Lines added or given an owner later (some had none) left every
-- earlier call on them with no rep, so Reporting showed them as Unassigned.
-- 26,276 calls and texts in workspace 11 had no rep, all but 23 on a known line.
--
--   * communications.rep_from_line: true when the rep came from the line, not
--     from Talkr or a person. Only those rows follow the line when its owner
--     changes; a rep someone set by hand is never overwritten.
--   * Giving a line an owner (insert, or update of user_id / phone_e164)
--     credits every call, text and voicemail on it with no rep, and moves the
--     ones it credited before. Clearing the owner takes those back to no rep.
--     Deleting the line does the same.
--   * Lines with no owner whose name starts with exactly one member's first
--     name get that member ("Sam", "Sam Main" → sam).
--   * line_rep_gaps(workspace): per line, how many calls and texts on it still
--     have no rep, for Settings → Numbers.

alter table public.communications add column if not exists rep_from_line boolean not null default false;

-- The insert-time fill from 153, now marking what it filled.
create or replace function public.communications_rep_from_line()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ours text;
  v_rep uuid;
begin
  if new.rep_id is not null or new.channel not in ('sms','call','voicemail') then return new; end if;
  v_ours := public.normalize_phone(case when new.direction = 'inbound' then new.to_phone else new.from_phone end);
  if v_ours is null then return new; end if;
  select r.user_id into v_rep
    from public.rep_phone_numbers r
   where r.workspace_id = new.workspace_id and r.phone_e164 = v_ours and r.user_id is not null;
  if v_rep is not null then
    new.rep_id := v_rep;
    new.rep_from_line := true;
  end if;
  return new;
end $function$;

-- Rows 153's backfill filled: smrtPhone (Podio) messages whose rep is their line's owner.
update public.communications c
   set rep_from_line = true
  from public.rep_phone_numbers r
 where not c.rep_from_line
   and c.source = 'podio'
   and c.channel in ('sms','call','voicemail')
   and r.workspace_id = c.workspace_id
   and r.user_id is not null
   and c.rep_id = r.user_id
   and r.phone_e164 = public.normalize_phone(case when c.direction = 'inbound' then c.to_phone else c.from_phone end);

-- Re-credit one line's messages to its current owner (or to nobody).
create or replace function public.recredit_line(p_workspace bigint, p_phone text, p_owner uuid)
 returns void
 language sql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  update public.communications c
     set rep_id = p_owner, rep_from_line = p_owner is not null
   where c.workspace_id = p_workspace
     and c.channel in ('sms','call','voicemail')
     and (c.rep_id is null or c.rep_from_line)
     and c.rep_id is distinct from p_owner
     and public.normalize_phone(case when c.direction = 'inbound' then c.to_phone else c.from_phone end) = p_phone;
$function$;
revoke all on function public.recredit_line(bigint, text, uuid) from public, anon, authenticated;

create or replace function public.rep_phone_numbers_recredit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recredit_line(old.workspace_id, old.phone_e164, null);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.phone_e164 is distinct from new.phone_e164 then
    perform public.recredit_line(old.workspace_id, old.phone_e164, null);
  end if;
  perform public.recredit_line(new.workspace_id, new.phone_e164, new.user_id);
  return new;
end $function$;

drop trigger if exists rep_phone_numbers_recredit on public.rep_phone_numbers;
create trigger rep_phone_numbers_recredit
  after insert or delete or update of user_id, phone_e164 on public.rep_phone_numbers
  for each row execute function public.rep_phone_numbers_recredit();

-- Ownerless lines named for exactly one member: that member.
with firsts as (
  select m.workspace_id, m.user_id, lower(split_part(btrim(coalesce(p.full_name, '')), ' ', 1)) as first
    from public.workspace_members m join public.profiles p on p.id = m.user_id
), unique_firsts as (
  select workspace_id, first, min(user_id::text)::uuid as user_id
    from firsts where first <> '' group by 1, 2 having count(*) = 1
)
update public.rep_phone_numbers r
   set user_id = u.user_id, updated_at = now()
  from unique_firsts u
 where r.user_id is null
   and u.workspace_id = r.workspace_id
   and u.first = lower(split_part(btrim(r.label), ' ', 1));

-- Lines whose old messages the trigger above did not see (an owner set before
-- this file): credit what still has no rep.
do $$
declare l record;
begin
  for l in select workspace_id, phone_e164, user_id from public.rep_phone_numbers where user_id is not null loop
    perform public.recredit_line(l.workspace_id, l.phone_e164, l.user_id);
  end loop;
end $$;

-- Settings → Numbers: calls and texts on each line that still have no rep.
create or replace function public.line_rep_gaps(p_workspace bigint)
 returns table (phone_e164 text, unowned bigint)
 language sql
 stable
 security invoker
 set search_path to 'public', 'pg_temp'
as $function$
  select public.normalize_phone(case when c.direction = 'inbound' then c.to_phone else c.from_phone end) as phone_e164, count(*) as unowned
    from public.communications c
   where c.workspace_id = p_workspace
     and c.rep_id is null
     and c.channel in ('sms','call','voicemail')
   group by 1;
$function$;
grant execute on function public.line_rep_gaps(bigint) to authenticated;
