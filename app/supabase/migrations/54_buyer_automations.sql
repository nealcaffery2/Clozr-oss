-- 54 · Buyer trigger events: tag buyers from what they actually did.
--
-- Buyers → Automations (components/BuyerAutomations.tsx) switches each rule
-- on, names the tag it applies, and whether the tag comes off again when the
-- rule stops being true. buyer_automations_apply() evaluates the rules and is
-- idempotent: a tag is added only if missing, removed only if present, and
-- each change is one activity row on the buyer.
--
-- It runs daily (pg_cron clozr-buyer-automations, 11:17 UTC) for every
-- workspace, and for one buyer right after the events that can change an
-- answer: a deal sent or replied to or marked (deal_buyer_matches), an offer.
--
-- Definitions, all from real rows:
--   deals sent       deal_buyer_matches.sent_at, newest first
--   responded        that match's replied_at (set by a text or email back, migration 53)
--   interested       match status in interested / offered / under_contract / closed
--   not interested   match status 'not_interested' (a rep's mark, or a reply that reads as a pass)
--   no status        replied, still matched / sent / viewed, and no offer on that deal
--   asking price     deals.marketed_price, else sold_price, else offer_amount + assignment_fee
--   active again     buyers.active_again_at (the profile's "Inactive until" date)

create table if not exists public.buyer_automation_rules (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  rule               text not null check (rule in ('no_response', 'not_interested', 'not_sent', 'active_again', 'no_status', 'lowball')),
  enabled            boolean not null default false,
  n                  integer not null default 3 check (n between 1 and 365),
  pct                integer not null default 80 check (pct between 1 and 100),
  tag                text not null check (length(trim(tag)) between 1 and 60),
  remove_when_false  boolean not null default false,
  last_run_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, rule)
);
alter table public.buyer_automation_rules enable row level security;
drop policy if exists buyer_automation_rules_select on public.buyer_automation_rules;
create policy buyer_automation_rules_select on public.buyer_automation_rules for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions', 'tc', 'member'));
drop policy if exists buyer_automation_rules_write on public.buyer_automation_rules;
create policy buyer_automation_rules_write on public.buyer_automation_rules for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'));
grant select, insert, update, delete on public.buyer_automation_rules to authenticated;
drop trigger if exists buyer_automation_rules_touch on public.buyer_automation_rules;
create trigger buyer_automation_rules_touch before update on public.buyer_automation_rules
  for each row execute function public.touch_updated_at();

/** Is one rule true for one buyer right now. */
create or replace function public.buyer_rule_true(p_rule public.buyer_automation_rules, p_buyer public.buyers)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_count int; v_hits int;
begin
  case p_rule.rule
  when 'no_response' then
    select count(*), count(*) filter (where replied_at is null) into v_count, v_hits
      from (select replied_at from public.deal_buyer_matches where buyer_id = p_buyer.id and sent_at is not null order by sent_at desc limit p_rule.n) x;
    return v_count = p_rule.n and v_hits = p_rule.n;
  when 'not_interested' then
    select count(*), count(*) filter (where status = 'not_interested') into v_count, v_hits
      from (select status from public.deal_buyer_matches where buyer_id = p_buyer.id and sent_at is not null order by sent_at desc limit p_rule.n) x;
    return v_count = p_rule.n and v_hits = p_rule.n;
  when 'no_status' then
    select count(*), count(*) filter (where replied_at is not null and status in ('matched', 'sent', 'viewed')
             and not exists (select 1 from public.offers o where o.buyer_id = p_buyer.id and o.deal_id = x.deal_id and o.direction = 'inbound'))
      into v_count, v_hits
      from (select deal_id, replied_at, status from public.deal_buyer_matches where buyer_id = p_buyer.id and sent_at is not null order by sent_at desc limit p_rule.n) x;
    return v_count = p_rule.n and v_hits = p_rule.n;
  when 'not_sent' then
    return not exists (select 1 from public.deal_buyer_matches where buyer_id = p_buyer.id and sent_at >= now() - make_interval(days => p_rule.n));
  when 'active_again' then
    return p_buyer.active_again_at is not null and p_buyer.active_again_at > now() and p_buyer.active_again_at <= now() + make_interval(days => p_rule.n);
  when 'lowball' then
    select count(*), count(*) filter (where amount <= asking * p_rule.pct / 100.0) into v_count, v_hits
      from (select o.amount,
                   coalesce(d.marketed_price, d.sold_price, d.offer_amount + coalesce(d.assignment_fee, 0)) as asking
              from public.offers o join public.deals d on d.id = o.deal_id
             where o.buyer_id = p_buyer.id and o.direction = 'inbound' and o.amount is not null
               and coalesce(d.marketed_price, d.sold_price, d.offer_amount) is not null
             order by o.sent_at desc limit p_rule.n) x;
    return v_count = p_rule.n and v_hits = p_rule.n;
  else
    return false;
  end case;
end $$;
revoke execute on function public.buyer_rule_true(public.buyer_automation_rules, public.buyers) from public, anon, authenticated;

/**
 * Apply every enabled rule in a workspace (or all workspaces), optionally to
 * one buyer. Returns tags added + removed.
 */
create or replace function public.buyer_automations_apply(p_workspace_id bigint default null, p_buyer_id bigint default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare rl public.buyer_automation_rules; b public.buyers; v_true boolean; v_has boolean; v_changes int := 0;
begin
  if auth.role() not in ('service_role') and current_user not in ('postgres', 'supabase_admin')
     and (p_workspace_id is null or not public.has_role(p_workspace_id, 'owner', 'admin', 'dispositions')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for rl in select * from public.buyer_automation_rules
             where enabled and (p_workspace_id is null or workspace_id = p_workspace_id) order by workspace_id, id loop
    for b in select * from public.buyers
              where workspace_id = rl.workspace_id and (p_buyer_id is null or id = p_buyer_id) loop
      v_true := public.buyer_rule_true(rl, b);
      v_has := lower(rl.tag) = any (select lower(t) from unnest(coalesce(b.tags, '{}')) t);
      if v_true and not v_has then
        update public.buyers set tags = array_append(coalesce(tags, '{}'), rl.tag) where id = b.id;
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
        values (b.workspace_id, 'buyer', b.id, 'automation', 'Tagged "' || rl.tag || '"', 'Buyer automation: ' || rl.rule);
        v_changes := v_changes + 1;
      elsif not v_true and v_has and rl.remove_when_false then
        update public.buyers set tags = array(select t from unnest(tags) t where lower(t) <> lower(rl.tag)) where id = b.id;
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
        values (b.workspace_id, 'buyer', b.id, 'automation', 'Untagged "' || rl.tag || '"', 'Buyer automation no longer true: ' || rl.rule);
        v_changes := v_changes + 1;
      end if;
    end loop;
    if p_buyer_id is null then update public.buyer_automation_rules set last_run_at = now() where id = rl.id; end if;
  end loop;
  return v_changes;
end $$;
revoke execute on function public.buyer_automations_apply(bigint, bigint) from public, anon;
grant execute on function public.buyer_automations_apply(bigint, bigint) to authenticated, service_role;

-- After campaign events: re-check that one buyer.
create or replace function public.buyer_automations_after_event()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.buyer_id is null then return new; end if;
  if exists (select 1 from public.buyer_automation_rules where workspace_id = new.workspace_id and enabled) then
    perform public.buyer_automations_apply(new.workspace_id, new.buyer_id);
  end if;
  return new;
end $$;
revoke execute on function public.buyer_automations_after_event() from public, anon, authenticated;

drop trigger if exists deal_buyer_matches_automations on public.deal_buyer_matches;
create trigger deal_buyer_matches_automations
  after insert or update of sent_at, replied_at, status on public.deal_buyer_matches
  for each row execute function public.buyer_automations_after_event();
drop trigger if exists offers_automations on public.offers;
create trigger offers_automations after insert on public.offers
  for each row execute function public.buyer_automations_after_event();

select cron.unschedule('clozr-buyer-automations') where exists (select 1 from cron.job where jobname = 'clozr-buyer-automations');
select cron.schedule('clozr-buyer-automations', '17 11 * * *', 'select public.buyer_automations_apply()');
