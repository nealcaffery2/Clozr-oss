-- Whose phone number is whose: outbound texts and calls credited to the rep.
--
-- Podio (smrtPhone) messages arrive with our number but rarely with the rep,
-- so the Activity feed credited them to "Podio". rep_phone_numbers maps each
-- of the workspace's numbers to the member who uses it (user_id), or just a
-- name for a line nobody in CLOZR owns (a market line, a company line, a rep
-- who has left). communications.rep_id is filled from it:
--   * on insert, when the row has no rep: outbound by from_phone, inbound by
--     to_phone (who the caller or texter reached);
--   * once, for every stored row with no rep (the backfill below).
-- The feed shows the rep's name, else the line's name.
--
-- No numbers are seeded here.

create table if not exists public.rep_phone_numbers (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  phone_e164   text not null,
  user_id      uuid references auth.users(id) on delete set null,
  label        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, phone_e164)
);

alter table public.rep_phone_numbers enable row level security;

drop policy if exists rep_phone_numbers_read on public.rep_phone_numbers;
create policy rep_phone_numbers_read on public.rep_phone_numbers for select
  using (workspace_id in (select public.my_workspace_ids()));

drop policy if exists rep_phone_numbers_write on public.rep_phone_numbers;
create policy rep_phone_numbers_write on public.rep_phone_numbers for all
  using (exists (select 1 from public.workspace_members m where m.workspace_id = rep_phone_numbers.workspace_id and m.user_id = auth.uid() and m.role in ('owner','admin')))
  with check (exists (select 1 from public.workspace_members m where m.workspace_id = rep_phone_numbers.workspace_id and m.user_id = auth.uid() and m.role in ('owner','admin')));

-- The rep on a message from the line it used.
create or replace function public.communications_rep_from_line()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ours text;
begin
  if new.rep_id is not null or new.channel not in ('sms','call','voicemail') then return new; end if;
  v_ours := public.normalize_phone(case when new.direction = 'inbound' then new.to_phone else new.from_phone end);
  if v_ours is null then return new; end if;
  select r.user_id into new.rep_id
    from public.rep_phone_numbers r
   where r.workspace_id = new.workspace_id and r.phone_e164 = v_ours and r.user_id is not null;
  return new;
end $function$;

drop trigger if exists communications_rep_from_line on public.communications;
create trigger communications_rep_from_line before insert on public.communications
  for each row execute function public.communications_rep_from_line();

-- No lines are seeded: a workspace adds its own rows to rep_phone_numbers.

-- The backfill: every stored message with no rep, from the line it used.
update public.communications c
   set rep_id = r.user_id
  from public.rep_phone_numbers r
 where c.rep_id is null
   and c.channel in ('sms','call','voicemail')
   and r.workspace_id = c.workspace_id
   and r.user_id is not null
   and r.phone_e164 = public.normalize_phone(case when c.direction = 'inbound' then c.to_phone else c.from_phone end);
