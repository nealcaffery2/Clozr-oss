-- People in the team's mail who are not in CLOZR yet.
--
-- The Gmail sync (_shared/google.ts, _shared/contact-suggest.ts) notes every
-- agent, escrow officer or title rep it sees on a teammate's mail that is not
-- a seller, buyer, vendor or teammate. Someone at a title company we already
-- work with (same email domain as a Title Company vendor) is added as a
-- vendor under that company straight away (status `auto`). Everyone else is
-- an `open` suggestion the TC (and owners and admins) add or dismiss from the
-- Inbox. A dismissed address is never suggested again.
--
-- google_accounts.gmail_relink_before: the relink pass also walks back
-- through older mail that never found a deal, a page per run, oldest edge
-- here; null starts again from the newest.
--
-- Additive, safe to re-run.

create table if not exists public.contact_suggestions (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  email         text not null,
  name          text,
  company       text,
  kind          text not null default 'agent',
  deal_id       bigint references public.deals(id) on delete set null,
  user_id       uuid,
  subject       text,
  seen_count    integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  status        text not null default 'open',
  vendor_id     bigint references public.vendors(id) on delete set null,
  resolved_by   uuid,
  resolved_at   timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contact_suggestions_kind_check') then
    alter table public.contact_suggestions
      add constraint contact_suggestions_kind_check check (kind in ('agent', 'title', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contact_suggestions_status_check') then
    alter table public.contact_suggestions
      add constraint contact_suggestions_status_check check (status in ('open', 'added', 'dismissed', 'auto'));
  end if;
end $$;

-- email is stored lower-cased by the sync, so a plain unique key serves on conflict.
create unique index if not exists contact_suggestions_ws_email on public.contact_suggestions (workspace_id, email);
create index if not exists contact_suggestions_open on public.contact_suggestions (workspace_id, last_seen_at desc) where status = 'open';

alter table public.contact_suggestions enable row level security;

drop policy if exists contact_suggestions_select on public.contact_suggestions;
-- Mailbox-scoped like the mail itself (can_read_email, migration 107): owners,
-- admins and the TC see the team's; anyone else only what their own mailbox found.
create policy contact_suggestions_select on public.contact_suggestions
  for select to authenticated
  using (
    workspace_id in (select public.my_role_workspace_ids(variadic array['owner', 'admin', 'tc']))
    or (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))
  );

grant select on public.contact_suggestions to authenticated;
grant all on public.contact_suggestions to service_role;

alter table public.google_accounts
  add column if not exists gmail_relink_before timestamptz;

-- The sync's write: one row per address seen this run. A new address is
-- inserted; a known one counts another sighting and keeps its status, so a
-- dismissed person stays dismissed and an added one stays added.
create or replace function public.contact_suggestions_note(p_ws bigint, p_rows jsonb)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with r as (
    select lower(trim(x->>'email')) as email, nullif(x->>'name', '') as name, nullif(x->>'company', '') as company,
           coalesce(nullif(x->>'kind', ''), 'agent') as kind, nullif(x->>'deal_id', '')::bigint as deal_id,
           nullif(x->>'user_id', '')::uuid as user_id, left(nullif(x->>'subject', ''), 300) as subject,
           coalesce(nullif(x->>'seen_at', '')::timestamptz, now()) as seen_at,
           coalesce(nullif(x->>'status', ''), 'open') as status, nullif(x->>'vendor_id', '')::bigint as vendor_id
      from jsonb_array_elements(p_rows) x
  ), ins as (
    insert into public.contact_suggestions as c
      (workspace_id, email, name, company, kind, deal_id, user_id, subject, first_seen_at, last_seen_at, status, vendor_id)
    select distinct on (email) p_ws, email, name, company, kind, deal_id, user_id, subject, seen_at, seen_at, status, vendor_id
      from r where email like '%@%'
     order by email, seen_at desc
    on conflict (workspace_id, email) do update
      set seen_count   = c.seen_count + 1,
          last_seen_at = greatest(c.last_seen_at, excluded.last_seen_at),
          name         = coalesce(c.name, excluded.name),
          company      = coalesce(c.company, excluded.company),
          deal_id      = coalesce(c.deal_id, excluded.deal_id),
          subject      = case when excluded.last_seen_at >= c.last_seen_at then coalesce(excluded.subject, c.subject) else c.subject end
    returning 1
  )
  select count(*)::int from ins
$$;
revoke all on function public.contact_suggestions_note(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.contact_suggestions_note(bigint, jsonb) to service_role;

-- Add or dismiss a suggestion. Add makes a vendor (Realtor, or Title Company
-- under `company`) and, when the mail was on a deal, puts them on that deal,
-- so the next sync files their mail and the backfill reads their history.
create or replace function public.contact_suggestion_resolve(
  p_id bigint, p_action text, p_kind text default null, p_name text default null, p_company text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.contact_suggestions;
  k text;
  v_id bigint;
  nm text;
  co text;
begin
  select * into s from public.contact_suggestions where id = p_id for update;
  if not found then raise exception 'no such suggestion'; end if;
  -- The same rule as reading it: the TC, owners and admins, or the teammate whose mailbox found it.
  if not (public.has_role(s.workspace_id, variadic array['owner', 'admin', 'tc'])
          or (s.user_id = auth.uid() and public.has_role(s.workspace_id, variadic array['owner', 'admin', 'tc', 'dispositions', 'acquisitions', 'member']))) then
    raise exception 'not allowed to change that suggestion';
  end if;
  if s.status not in ('open') then
    return jsonb_build_object('ok', true, 'status', s.status, 'vendor_id', s.vendor_id);
  end if;

  if p_action = 'dismiss' then
    update public.contact_suggestions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'dismissed');
  elsif p_action <> 'add' then
    raise exception 'action is add or dismiss';
  end if;

  k := coalesce(nullif(p_kind, ''), s.kind);
  if k not in ('agent', 'title', 'other') then k := 'other'; end if;
  nm := coalesce(nullif(trim(p_name), ''), s.name);
  co := coalesce(nullif(trim(p_company), ''), s.company);

  -- Already a vendor by this address (added elsewhere since): use that one.
  select id into v_id from public.vendors
   where workspace_id = s.workspace_id and lower(trim(email)) = s.email
   order by id limit 1;
  if v_id is null then
    insert into public.vendors (workspace_id, business_name, contact_name, email, service_type, source, source_id, created_by)
    values (s.workspace_id, coalesce(co, nm, s.email), nm, s.email,
            case k when 'title' then 'Title Company' when 'agent' then 'Realtor' else 'Other' end,
            'gmail', 'suggestion:' || s.id, auth.uid())
    returning id into v_id;
  end if;

  if s.deal_id is not null then
    insert into public.deal_parties (workspace_id, deal_id, role, vendor_id, name, company, email, source, source_id)
    values (s.workspace_id, s.deal_id, case k when 'title' then 'title' when 'agent' then 'realtor' else 'other' end,
            v_id, nm, co, s.email, 'gmail', 'suggestion:' || s.id)
    on conflict do nothing;
  end if;

  update public.contact_suggestions
     set status = 'added', vendor_id = v_id, kind = k, name = nm, company = co, resolved_by = auth.uid(), resolved_at = now()
   where id = s.id;
  return jsonb_build_object('ok', true, 'status', 'added', 'vendor_id', v_id);
end $$;

revoke all on function public.contact_suggestion_resolve(bigint, text, text, text, text) from public, anon;
grant execute on function public.contact_suggestion_resolve(bigint, text, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
