-- 272 · Contract requests from the dialer.
--
-- Acquisitions presses Request contract on a call;
-- the popup fills from the seller or buyer on the line, the app makes a DRAFT
-- contract through the contracts function (nothing goes out for signature),
-- and the TC is told at once, with a big alert in the middle of her screen.
--
-- 1. contract_requests: one row per press. The draft it made (contract_id,
--    null when the record could not make one), who asked, the party, the
--    address, price, closing date, EMD, other fill-ins, the rep's notes, the
--    call summary (or its last transcript lines) and Talkr's call id, so the
--    TC can listen in or barge while the call is still up. The Contracts
--    screen shows the notes and summary on the draft.
-- 2. notifications.contract_id and notifications.payload: the bell row opens
--    the draft, and the TC's alert reads the request from its own row.
-- 3. request_contract(ws, request): files the request and notifies every
--    member with the tc role; with none, workspace_tc() (the workspace's
--    first TC); with neither, the owner. Never the person asking. Writes a
--    line on the seller's and deal's activity. lib/contract-request.ts
--    tcRecipients names the same people in the popup.
--
-- Notifications already stream to the app (migration 56); the alert and its
-- sound ride that INSERT. Safe to re-run.

create table if not exists public.contract_requests (
  id            bigserial primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  contract_id   bigint references public.contracts(id) on delete set null,
  requested_by  uuid references auth.users(id) on delete set null default auth.uid(),
  kind          text not null default 'psa',
  template_id   bigint,
  template_name text,
  seller_id     bigint references public.sellers(id) on delete set null,
  buyer_id      bigint references public.buyers(id) on delete set null,
  deal_id       bigint references public.deals(id) on delete set null,
  party         jsonb not null default '{}'::jsonb,
  address       text,
  price         numeric(14,2),
  closing_date  date,
  emd           numeric(14,2),
  terms         jsonb not null default '{}'::jsonb,
  notes         text,
  summary       text,
  call_id       text,
  notified      uuid[] not null default '{}',
  status        text not null default 'open' check (status in ('open', 'seen', 'done', 'cancelled')),
  seen_by       uuid references auth.users(id) on delete set null,
  seen_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists contract_requests_ws_created on public.contract_requests (workspace_id, created_at desc);
create index if not exists contract_requests_contract on public.contract_requests (contract_id) where contract_id is not null;
create index if not exists contract_requests_seller on public.contract_requests (seller_id) where seller_id is not null;
create index if not exists contract_requests_buyer on public.contract_requests (buyer_id) where buyer_id is not null;
create index if not exists contract_requests_deal on public.contract_requests (deal_id) where deal_id is not null;
create index if not exists contract_requests_requested_by on public.contract_requests (requested_by) where requested_by is not null;
create index if not exists contract_requests_seen_by on public.contract_requests (seen_by) where seen_by is not null;

alter table public.contract_requests enable row level security;

-- Everyone in the workspace reads them (the TC, the rep, the Contracts screen).
-- Rows are written by request_contract only; a member may mark one seen or done.
drop policy if exists contract_requests_read on public.contract_requests;
create policy contract_requests_read on public.contract_requests for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));

drop policy if exists contract_requests_update on public.contract_requests;
create policy contract_requests_update on public.contract_requests for update to authenticated
  using (workspace_id in (select public.my_workspace_ids()))
  with check (workspace_id in (select public.my_workspace_ids()));

revoke all on public.contract_requests from anon, authenticated;
grant select, update (status, seen_by, seen_at, contract_id) on public.contract_requests to authenticated;

alter table public.notifications
  add column if not exists contract_id bigint references public.contracts(id) on delete set null,
  add column if not exists payload jsonb;

create index if not exists notifications_contract_id_idx on public.notifications (contract_id) where contract_id is not null;

create or replace function public.request_contract(p_workspace_id bigint, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  r          jsonb := coalesce(p_request, '{}'::jsonb);
  v_contract bigint := nullif(r->>'contract_id', '')::bigint;
  v_seller   bigint := nullif(r->>'seller_id', '')::bigint;
  v_buyer    bigint := nullif(r->>'buyer_id', '')::bigint;
  v_deal     bigint := nullif(r->>'deal_id', '')::bigint;
  v_kind     text := coalesce(nullif(r->>'kind', ''), 'psa');
  v_name     text;
  v_party    text := left(coalesce(nullif(trim(r->'party'->>'name'), ''), ''), 200);
  v_address  text := left(coalesce(nullif(trim(r->>'address'), ''), ''), 300);
  v_street   text;
  v_title    text;
  v_body     text;
  v_id       bigint;
  v_to       uuid[];
  v_payload  jsonb;
begin
  if v_uid is null or not exists (
       select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = v_uid) then
    raise exception 'not a member of that workspace' using errcode = '42501';
  end if;

  -- Only ids from this workspace stay on the request.
  if v_contract is not null and not exists (select 1 from public.contracts c where c.id = v_contract and c.workspace_id = p_workspace_id) then v_contract := null; end if;
  if v_seller is not null and not exists (select 1 from public.sellers s where s.id = v_seller and s.workspace_id = p_workspace_id) then v_seller := null; end if;
  if v_buyer is not null and not exists (select 1 from public.buyers b where b.id = v_buyer and b.workspace_id = p_workspace_id) then v_buyer := null; end if;
  if v_deal is not null and not exists (select 1 from public.deals d where d.id = v_deal and d.workspace_id = p_workspace_id) then v_deal := null; end if;
  if v_kind not in ('psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'offer', 'other') then v_kind := 'other'; end if;

  select coalesce(nullif(trim(p.full_name), ''), p.email, 'A teammate') into v_name from public.profiles p where p.id = v_uid;
  v_name := coalesce(v_name, 'A teammate');
  v_street := nullif(trim(split_part(v_address, ',', 1)), '');
  v_title := left('Contract request from ' || split_part(v_name, ' ', 1) || coalesce(' · ' || coalesce(v_street, nullif(v_party, '')), ''), 120);

  -- Who hears about it: the TC role; else workspace_tc(); else the owner. Never the asker.
  select coalesce(array_agg(m.user_id order by m.joined_at, m.user_id), '{}') into v_to
    from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.role = 'tc' and m.user_id <> v_uid;
  if cardinality(v_to) = 0 then
    select coalesce(array_agg(x), '{}') into v_to
      from (select public.workspace_tc(p_workspace_id) as x) t where x is not null and x <> v_uid;
  end if;
  if cardinality(v_to) = 0 then
    select coalesce(array_agg(w.owner_id), '{}') into v_to
      from public.workspaces w where w.id = p_workspace_id and w.owner_id is not null and w.owner_id <> v_uid;
  end if;

  insert into public.contract_requests (
    workspace_id, contract_id, requested_by, kind, template_id, template_name, seller_id, buyer_id, deal_id,
    party, address, price, closing_date, emd, terms, notes, summary, call_id, notified)
  values (
    p_workspace_id, v_contract, v_uid, v_kind, nullif(r->>'template_id', '')::bigint, left(nullif(r->>'template_name', ''), 200),
    v_seller, v_buyer, v_deal,
    coalesce(r->'party', '{}'::jsonb), nullif(v_address, ''), nullif(r->>'price', '')::numeric, nullif(r->>'closing_date', '')::date,
    nullif(r->>'emd', '')::numeric, coalesce(r->'terms', '{}'::jsonb), left(nullif(r->>'notes', ''), 4000), left(nullif(r->>'summary', ''), 6000),
    left(nullif(r->>'call_id', ''), 120), v_to)
  returning id into v_id;

  v_body := concat_ws(' · ',
    nullif(v_party, ''),
    case when nullif(r->>'price', '') is not null then '$' || to_char(nullif(r->>'price', '')::numeric, 'FM999,999,999') end,
    case when nullif(r->>'closing_date', '') is not null then 'close ' || to_char(nullif(r->>'closing_date', '')::date, 'Mon FMDD') end,
    case when v_contract is not null then 'draft ready' else 'no draft yet' end);
  v_payload := r || jsonb_build_object('request_id', v_id, 'contract_id', v_contract, 'requested_by', v_uid, 'requester_name', v_name, 'title', v_title);

  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, buyer_id, deal_id, contract_id, payload)
  select p_workspace_id, u, 'Contract request', v_title, v_body, v_seller, v_buyer, v_deal, v_contract, v_payload
    from unnest(v_to) as u;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
  select p_workspace_id, e.t, e.id, 'contract', 'Contract requested from the call',
         left(concat_ws(E'\n\n', nullif(v_body, ''), nullif(r->>'notes', ''), nullif(r->>'summary', '')), 4000), v_uid
    from (values ('seller', v_seller), ('buyer', v_buyer), ('deal', v_deal)) as e(t, id)
   where e.id is not null;

  return jsonb_build_object(
    'id', v_id,
    'contract_id', v_contract,
    'notified', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(nullif(trim(p.full_name), ''), p.email)))
                            from public.profiles p where p.id = any(v_to)), '[]'::jsonb));
end $$;

revoke all on function public.request_contract(bigint, jsonb) from public, anon;
grant execute on function public.request_contract(bigint, jsonb) to authenticated;
