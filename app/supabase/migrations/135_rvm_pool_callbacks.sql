-- 135: the ringless-voicemail number pool, and callbacks credited to the drop.
--
-- caller_lines gains a pool ('rvm' for ringless drops, 'dialer' for live
-- calls, null for neither), the state the line serves, a hard daily cap and
-- the day its warm-up started. Today's count is not stored: rvm-tick counts
-- rvm_drops.from_e164 sent since local midnight (index below), and lib/rvm-pool.ts
-- turns days-since-ramp-start into today's cap. Admins set the four columns
-- through caller_line_set(); everything else on the row stays the
-- caller-registry function's.
--
-- rvm_drops gains blast_id (one bulk send), notes (best-effort side effects,
-- such as telling Talkr), and the callback that answered it. The trigger on
-- communications credits an inbound call, voicemail or text from the same
-- seller or buyer within seven days of a delivered drop to that drop
-- (rvm_drops.callback_*, communications.rvm_drop_id) and tells whoever queued
-- the drop. Safe to run again.

alter table public.caller_lines
  add column if not exists pool text,
  add column if not exists market_state text,
  add column if not exists daily_cap integer,
  add column if not exists ramp_started_at date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'caller_lines_pool_check') then
    alter table public.caller_lines add constraint caller_lines_pool_check check (pool is null or pool in ('rvm', 'dialer'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'caller_lines_daily_cap_check') then
    alter table public.caller_lines add constraint caller_lines_daily_cap_check check (daily_cap is null or daily_cap between 0 and 5000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'caller_lines_market_state_check') then
    alter table public.caller_lines add constraint caller_lines_market_state_check check (market_state is null or market_state ~ '^[A-Z]{2}$');
  end if;
end $$;

-- An admin marks a line for a pool. Creates the row when the registry has not
-- seen the number yet; never touches the registry's own columns.
create or replace function public.caller_line_set(
  p_workspace bigint, p_phone text, p_pool text, p_state text, p_daily_cap integer, p_ramp_started_at date
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_phone text; v_pool text; v_state text;
begin
  if not public.has_role(p_workspace, 'owner', 'admin') then
    raise exception 'admins only' using errcode = '42501';
  end if;
  v_phone := '+' || regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_phone) = 11 then v_phone := '+1' || substr(v_phone, 2); end if;
  if v_phone !~ '^\+1\d{10}$' then raise exception 'not a US number: %', p_phone; end if;
  v_pool := nullif(lower(trim(coalesce(p_pool, ''))), '');
  v_state := nullif(upper(trim(coalesce(p_state, ''))), '');
  insert into public.caller_lines (workspace_id, phone_e164, pool, market_state, daily_cap, ramp_started_at)
  values (p_workspace, v_phone, v_pool, v_state, p_daily_cap,
          case when v_pool = 'rvm' then coalesce(p_ramp_started_at, current_date) else p_ramp_started_at end)
  on conflict (workspace_id, phone_e164) do update
    set pool = excluded.pool,
        market_state = excluded.market_state,
        daily_cap = excluded.daily_cap,
        ramp_started_at = case
          when excluded.pool = 'rvm' and p_ramp_started_at is null then coalesce(caller_lines.ramp_started_at, current_date)
          else excluded.ramp_started_at end;
end $$;
revoke all on function public.caller_line_set(bigint, text, text, text, integer, date) from public, anon;
grant execute on function public.caller_line_set(bigint, text, text, text, integer, date) to authenticated;

alter table public.rvm_drops
  add column if not exists blast_id text,
  add column if not exists notes text,
  add column if not exists callback_at timestamptz,
  add column if not exists callback_channel text,
  add column if not exists callback_comm_id bigint;

create index if not exists rvm_drops_blast on public.rvm_drops (workspace_id, blast_id) where blast_id is not null;
create index if not exists rvm_drops_from_sent
  on public.rvm_drops (workspace_id, from_e164, sent_at desc)
  where from_e164 is not null;
create index if not exists rvm_drops_seller_sent on public.rvm_drops (seller_id, sent_at desc) where seller_id is not null and status = 'dropped';
create index if not exists rvm_drops_buyer_sent on public.rvm_drops (buyer_id, sent_at desc) where buyer_id is not null and status = 'dropped';

alter table public.communications
  add column if not exists rvm_drop_id bigint references public.rvm_drops(id) on delete set null;

-- An inbound call, voicemail or text within seven days of a delivered drop to
-- the same person is that drop's callback. Never fails the insert.
create or replace function public.rvm_after_inbound()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_drop record; v_name text; v_when text;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('call', 'voicemail', 'sms') then return new; end if;
  if new.seller_id is null and new.buyer_id is null then return new; end if;
  begin
    select d.id, d.created_by, d.sent_at, d.seller_id, d.buyer_id, d.callback_at into v_drop
      from public.rvm_drops d
     where d.workspace_id = new.workspace_id
       and d.status = 'dropped'
       and ((new.seller_id is not null and d.seller_id = new.seller_id) or (new.buyer_id is not null and d.buyer_id = new.buyer_id))
       and d.sent_at <= coalesce(new.occurred_at, now())
       and d.sent_at >= coalesce(new.occurred_at, now()) - interval '7 days'
     order by d.sent_at desc
     limit 1;
    if not found then return new; end if;
    v_when := to_char(v_drop.sent_at at time zone 'America/Chicago', 'Mon FMDD');
    -- On the record's activity log: the call or text says which drop it answered.
    update public.communications
       set rvm_drop_id = v_drop.id,
           summary = coalesce(nullif(summary, ''), case when new.channel = 'sms' then 'Texted back' else 'Called back' end || ' after the ringless voicemail of ' || v_when)
     where id = new.id and rvm_drop_id is null;
    if v_drop.callback_at is not null then return new; end if;
    update public.rvm_drops
       set callback_at = coalesce(new.occurred_at, now()), callback_channel = new.channel, callback_comm_id = new.id
     where id = v_drop.id and callback_at is null;
    if v_drop.created_by is not null then
      if new.seller_id is not null then
        select name into v_name from public.sellers where id = new.seller_id;
      else
        select coalesce(nullif(trim(company), ''), name) into v_name from public.buyers where id = new.buyer_id;
      end if;
      insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, buyer_id)
      values (new.workspace_id, v_drop.created_by, 'RVM',
              case when new.channel = 'sms' then 'Texted back after your RVM' else 'Called back after your RVM' end,
              coalesce(nullif(trim(v_name), ''), 'Someone') || ' answered your ringless voicemail from ' || v_when || '.',
              new.seller_id, new.buyer_id);
    end if;
  exception when others then
    raise warning 'rvm_after_inbound: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public.rvm_after_inbound() from public, anon, authenticated;
create or replace trigger communications_rvm_inbound after insert on public.communications
  for each row execute function public.rvm_after_inbound();
