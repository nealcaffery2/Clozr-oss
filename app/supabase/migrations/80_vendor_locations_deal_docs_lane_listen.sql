-- 80 · Vendors by company, location and main contact · email attachments on
--      the deal · Lane listens to the file.
--
-- 1. Vendors. A vendor row has always been one contact at one company, so a
--    title company with two escrow officers was two unrelated rows and a
--    photographer's town lived only inside the notes ("Office: Knoxville TN").
--    Finding who covers a market meant reading notes. Each contact now carries
--    its location, and one contact per company and location can be the main
--    point of contact:
--
--      city, state      where this contact works. Backfilled from the Podio
--                       "Office:" / "Service area:" note and, failing that, a
--                       single-state market.
--      office_address   the office line itself when the note had one.
--      is_main_poc      the one to call first for that company in that state.
--                       Backfilled where a company has exactly one contact in
--                       a state (nothing to choose) and for the two title reps
--                       Lane already routes to (Evan Lipp, Title Source, TX;
--                       Patrick Whaley, Title Partners). Anything else is
--                       left for the team to star.
--
-- 2. Deal files learn what they are and where they came from. `category` has
--    existed since the listing work; it now also holds a transaction document
--    type (title_commitment, closing_disclosure, …). An attachment the Gmail
--    sync pulls off a deal's email keeps the message it came on
--    (communication_id) and its Gmail attachment key (source_id), so a
--    re-sync and a second teammate's mailbox never file it twice.
--
-- 3. Lane listens. lane_updates holds what Lane took from new calls, texts,
--    emails and tasks on an open file: a checklist line evidenced done, a date
--    that moved, a task to add or close, a title company to put on the deal.
--    High-confidence checklist ticks and task completions apply on their own
--    (status 'applied', with the evidence and a one-click undo); everything
--    else waits for the TC ('pending'). transactions.lane_heard_through is how
--    far Lane has read, so nothing is read twice.

-- ------------------------------------------------------------------ vendors
alter table public.vendors
  add column if not exists city           text,
  add column if not exists state          text,
  add column if not exists office_address text,
  add column if not exists is_main_poc    boolean not null default false;

create index if not exists vendors_type_state_idx on public.vendors (workspace_id, service_type, state);

do $$
declare r record; office text; c text; st text;
begin
  for r in select id, notes, markets from public.vendors where city is null and state is null loop
    office := nullif(trim(substring(r.notes from '(?:Office|Service area):\s*([^|]+)')), '');
    c := null; st := null;
    if office is not null then
      -- "…, Coos Bay, OR 97420, USA"
      c  := substring(office from ',\s*([^,]+),\s*[A-Z]{2}\s*\d{5}');
      st := substring(office from ',?\s*([A-Z]{2})\s*\d{5}');
      -- "Knoxville TN" / "Dawson, PA, USA" / "Charlotte (Wadesboro) NC"
      if st is null then
        st := substring(office from '^[^,\d]*?,?\s*([A-Z]{2})(?:,\s*USA)?\s*$');
        if st is not null then c := nullif(trim(both ', ' from substring(office from '^([^,\d]*?),?\s*[A-Z]{2}(?:,\s*USA)?\s*$')), ''); end if;
      end if;
      c := nullif(regexp_replace(c, '^(?:STE|Suite|Ste\.?)\s*\S+\s+', '', 'i'), '');
    end if;
    if st is null and cardinality(r.markets) = 1 and r.markets[1] ~ '^[A-Z]{2}$' then st := r.markets[1]; end if;
    update public.vendors
       set city = c, state = st,
           office_address = case when office ~ '\d' then office end
     where id = r.id;
  end loop;
end $$;

-- One main contact per company per state.
create unique index if not exists vendors_main_poc_uniq
  on public.vendors (workspace_id, service_type, lower(trim(business_name)), coalesce(state, ''))
  where is_main_poc;

-- Singletons: the only contact a company has in a state is its main contact.
update public.vendors v set is_main_poc = true
 where v.service_type in ('Title Company', 'Attorney', 'Hard Money Lender', 'Novation Realtor')
   and not v.is_main_poc
   and (select count(*) from public.vendors x
         where x.workspace_id = v.workspace_id and x.service_type = v.service_type
           and lower(trim(x.business_name)) = lower(trim(v.business_name))
           and coalesce(x.state, '') = coalesce(v.state, '') and x.status <> 'archived') = 1;

-- The title reps the playbook routes to.
update public.vendors v set is_main_poc = (lower(v.contact_name) like 'evan lipp%')
 where v.service_type = 'Title Company' and lower(trim(v.business_name)) = 'title source' and v.state = 'TX';
update public.vendors v set is_main_poc = true
 where v.service_type = 'Title Company' and lower(v.contact_name) like 'patrick whaley%'
   and not exists (select 1 from public.vendors x where x.id <> v.id and x.is_main_poc and x.workspace_id = v.workspace_id
                   and x.service_type = v.service_type and lower(trim(x.business_name)) = lower(trim(v.business_name))
                   and coalesce(x.state, '') = coalesce(v.state, ''));

-- Starring a new main contact un-stars the old one in the same group.
create or replace function public.vendor_set_main_poc(p_vendor bigint, p_on boolean default true)
returns void language plpgsql security invoker set search_path = public as $$
declare v public.vendors;
begin
  select * into v from public.vendors where id = p_vendor;
  if not found then raise exception 'vendor % not found', p_vendor; end if;
  if p_on then
    update public.vendors set is_main_poc = false
     where workspace_id = v.workspace_id and service_type is not distinct from v.service_type
       and lower(trim(business_name)) = lower(trim(v.business_name))
       and coalesce(state, '') = coalesce(v.state, '') and id <> v.id and is_main_poc;
  end if;
  update public.vendors set is_main_poc = p_on, updated_at = now() where id = v.id;
end $$;
revoke all on function public.vendor_set_main_poc(bigint, boolean) from public, anon;
grant execute on function public.vendor_set_main_poc(bigint, boolean) to authenticated;

-- --------------------------------------------------------------- deal files
alter table public.deal_files
  add column if not exists communication_id bigint references public.communications(id) on delete set null,
  add column if not exists source_id        text;
create unique index if not exists deal_files_deal_source_uniq on public.deal_files (deal_id, source_id) where source_id is not null;

-- ---------------------------------------------------------------- lane listen
alter table public.transactions
  add column if not exists lane_heard_through timestamptz;

create table if not exists public.lane_updates (
  id              bigint generated always as identity primary key,
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  transaction_id  bigint not null references public.transactions(id) on delete cascade,
  deal_id         bigint references public.deals(id) on delete cascade,
  seller_id       bigint references public.sellers(id) on delete set null,
  -- tick: {item_id, label}   date: {field, value}   task_add: {title, due_in_days}
  -- task_done: {task_id, title}   party: {role, company, name, email, phone, vendor_id}
  -- note: {text}
  kind            text not null check (kind in ('tick', 'date', 'task_add', 'task_done', 'party', 'note')),
  payload         jsonb not null default '{}'::jsonb,
  summary         text not null,
  evidence        text,
  confidence      text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  source_comm_ids bigint[] not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'applied', 'dismissed', 'undone')),
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists lane_updates_tx_idx on public.lane_updates (transaction_id, created_at desc);
create index if not exists lane_updates_pending_idx on public.lane_updates (workspace_id, status) where status = 'pending';

alter table public.lane_updates enable row level security;
drop policy if exists lane_updates_read on public.lane_updates;
create policy lane_updates_read on public.lane_updates for select to authenticated
  using (public.is_workspace_member(workspace_id));
-- Members decide (accept, dismiss, undo); only Lane (service role) writes new rows.
drop policy if exists lane_updates_decide on public.lane_updates;
create policy lane_updates_decide on public.lane_updates for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
grant select, update (status, decided_by, decided_at) on public.lane_updates to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lane_updates') then
    execute 'alter publication supabase_realtime add table public.lane_updates';
  end if;
end $$;

-- Every ten minutes, off the five-minute Gmail pull so the mail it files is there to hear.
create or replace function public.lane_listen_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/lane-listen',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"listen_all"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.lane_listen_kick() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('clozr-lane-listen') where exists (select 1 from cron.job where jobname = 'clozr-lane-listen');
    perform cron.schedule('clozr-lane-listen', '4-54/10 * * * *', 'select public.lane_listen_kick()');
  end if;
end $$;
