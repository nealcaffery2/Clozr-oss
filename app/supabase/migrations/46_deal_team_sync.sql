-- 46 · The deal team is editable by the whole team and stays in step with the deal.
--
-- deal_parties (40) holds everyone on a deal. The deal also keeps single
-- columns that the Deals, Dispo and Deal Sheet screens read. They now sync
-- both ways, in the database, so no screen can leave them disagreeing:
--
--   role acquisitions  <->  deals.owner_id
--   role dispositions  <->  deals.dispo_rep_id, deals.dispo_rep2_id
--   role tc            <->  deals.tc_rep_id
--   role buyer         <->  deals.buyer_id
--   role title         <->  deals.title_vendor_id + title_contact/email/phone
--
-- Deal -> team is a delta: the old value's party goes, the new value's party is
-- added, other parties of that role (a second acquisitions rep) are left alone.
-- Team -> deal recomputes the column from the parties, keeping the current
-- value while it is still on the team. A party with only a typed name (no
-- user/vendor/buyer) never moves a user or id column.
--
-- Recursion guard: a transaction-local flag (clozr.deal_team_sync) rather than
-- pg_trigger_depth(). Depth would also silence legitimate writes that arrive
-- from other triggers (a trigger that sets deals.owner_id); the flag only
-- silences the writes this sync makes itself.
--
-- RLS: any member can now edit the team (was owner/admin/tc/dispositions), the
-- same as deals_write. Buyer rows stay limited to the roles that can read
-- buyers, and a party must point at a deal in its own workspace.

-- ------------------------------------------------------------------ roles
alter table public.deal_parties drop constraint if exists deal_parties_role_check;
alter table public.deal_parties add constraint deal_parties_role_check check (role in (
  'seller','buyer','title','photographer','wholesaler','listing_agent','buyers_agent','realtor',
  'tc','acquisitions','dispositions','lender','contractor','inspector','attorney','other'));

-- ------------------------------------------------------------------- RLS
drop policy if exists deal_parties_write on public.deal_parties;
create policy deal_parties_write on public.deal_parties for all to authenticated
  using (public.is_workspace_member(workspace_id)
         and (buyer_id is null or public.has_role(workspace_id, 'owner', 'admin', 'dispositions', 'tc', 'member')))
  with check (public.is_workspace_member(workspace_id)
         and (buyer_id is null or public.has_role(workspace_id, 'owner', 'admin', 'dispositions', 'tc', 'member'))
         and exists (select 1 from public.deals d where d.id = deal_id and d.workspace_id = deal_parties.workspace_id));

-- ------------------------------------------------------- team -> deal
create or replace function public.deal_team_push(p_deal bigint, p_roles text[])
returns void language plpgsql security definer set search_path = public as $$
declare
  d public.deals;
  v_user uuid;
  v_users uuid[];
  v_buyer bigint;
  t record;
begin
  select * into d from public.deals where id = p_deal;
  if not found then return; end if;

  if 'acquisitions' = any(p_roles) then
    select p.user_id into v_user from public.deal_parties p
     where p.deal_id = d.id and p.role = 'acquisitions' and p.user_id is not null
     order by p.user_id is distinct from d.owner_id, p.id limit 1;
    update public.deals set owner_id = v_user where id = d.id and owner_id is distinct from v_user;
  end if;

  if 'dispositions' = any(p_roles) then
    v_users := array(
      select p.user_id from public.deal_parties p
       where p.deal_id = d.id and p.role = 'dispositions' and p.user_id is not null
       group by p.user_id
       order by (p.user_id is not distinct from d.dispo_rep_id) desc, (p.user_id is not distinct from d.dispo_rep2_id) desc, min(p.id));
    update public.deals set dispo_rep_id = v_users[1], dispo_rep2_id = v_users[2]
     where id = d.id and (dispo_rep_id is distinct from v_users[1] or dispo_rep2_id is distinct from v_users[2]);
  end if;

  if 'tc' = any(p_roles) then
    v_user := null;
    select p.user_id into v_user from public.deal_parties p
     where p.deal_id = d.id and p.role = 'tc' and p.user_id is not null
     order by p.user_id is distinct from d.tc_rep_id, p.id limit 1;
    update public.deals set tc_rep_id = v_user where id = d.id and tc_rep_id is distinct from v_user;
  end if;

  if 'buyer' = any(p_roles) then
    select p.buyer_id into v_buyer from public.deal_parties p
     where p.deal_id = d.id and p.role = 'buyer' and p.buyer_id is not null
     order by p.buyer_id is distinct from d.buyer_id, p.id limit 1;
    update public.deals set buyer_id = v_buyer where id = d.id and buyer_id is distinct from v_buyer;
  end if;

  if 'title' = any(p_roles) then
    select p.vendor_id, case when p.vendor_id is null then coalesce(p.name, p.company) else p.name end as contact, p.email, p.phone
      into t from public.deal_parties p
     where p.deal_id = d.id and p.role = 'title'
     order by p.vendor_id is distinct from d.title_vendor_id, p.id limit 1;
    if not found then
      update public.deals set title_vendor_id = null, title_contact = null, title_email = null, title_phone = null
       where id = d.id and (title_vendor_id, title_contact, title_email, title_phone) is distinct from (null::bigint, null::text, null::text, null::text);
    else
      update public.deals set title_vendor_id = t.vendor_id, title_contact = t.contact, title_email = t.email, title_phone = t.phone
       where id = d.id and (title_vendor_id, title_contact, title_email, title_phone) is distinct from (t.vendor_id, t.contact, t.email, t.phone);
    end if;
  end if;
end $$;

-- ------------------------------------------------------- deal -> team
-- One user column's change for a role. p_keep: the role's user columns after
-- the change, so swapping dispo 1 and 2 does not remove either rep.
create or replace function public.deal_team_user(d public.deals, p_role text, p_old uuid, p_new uuid, p_keep uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare pr public.profiles; v_id bigint;
begin
  if p_old is not distinct from p_new then return; end if;
  if p_old is not null and not coalesce(p_old = any(p_keep), false) then
    delete from public.deal_parties where deal_id = d.id and role = p_role and user_id = p_old;
  end if;
  if p_new is null or exists (select 1 from public.deal_parties where deal_id = d.id and role = p_role and user_id = p_new) then
    return;
  end if;
  select * into pr from public.profiles where id = p_new;
  -- A Podio row for the same person (source_id 'team:<email>') becomes theirs rather than a duplicate.
  select id into v_id from public.deal_parties
   where deal_id = d.id and role = p_role and user_id is null and pr.email is not null
     and (lower(source_id) = 'team:' || lower(pr.email) or lower(email) = lower(pr.email))
   order by id limit 1;
  if v_id is not null then
    update public.deal_parties set user_id = p_new, name = coalesce(name, pr.full_name), email = coalesce(email, pr.email) where id = v_id;
  else
    insert into public.deal_parties (workspace_id, deal_id, role, user_id, name, email, phone, source)
    values (d.workspace_id, d.id, p_role, p_new, pr.full_name, pr.email, pr.phone, 'clozr');
  end if;
end $$;

-- o is null for a new deal (and for the backfill).
create or replace function public.deal_team_pull(n public.deals, o public.deals)
returns void language plpgsql security definer set search_path = public as $$
declare v_id bigint; b public.buyers; v public.vendors;
begin
  perform public.deal_team_user(n, 'acquisitions', o.owner_id, n.owner_id, array[n.owner_id]);
  perform public.deal_team_user(n, 'dispositions', o.dispo_rep_id, n.dispo_rep_id, array[n.dispo_rep_id, n.dispo_rep2_id]);
  perform public.deal_team_user(n, 'dispositions', o.dispo_rep2_id, n.dispo_rep2_id, array[n.dispo_rep_id, n.dispo_rep2_id]);
  perform public.deal_team_user(n, 'tc', o.tc_rep_id, n.tc_rep_id, array[n.tc_rep_id]);

  if o.buyer_id is distinct from n.buyer_id then
    if o.buyer_id is not null then
      delete from public.deal_parties where deal_id = n.id and role = 'buyer' and buyer_id = o.buyer_id;
    end if;
    if n.buyer_id is not null and not exists (select 1 from public.deal_parties where deal_id = n.id and role = 'buyer' and buyer_id = n.buyer_id) then
      select * into b from public.buyers where id = n.buyer_id;
      insert into public.deal_parties (workspace_id, deal_id, role, buyer_id, name, company, email, phone, source)
      values (n.workspace_id, n.id, 'buyer', n.buyer_id, b.name, b.company, b.email, b.phone, 'clozr');
    end if;
  end if;

  if (n.title_vendor_id, n.title_contact, n.title_email, n.title_phone)
     is distinct from (o.title_vendor_id, o.title_contact, o.title_email, o.title_phone) then
    select id into v_id from public.deal_parties where deal_id = n.id and role = 'title'
     order by (vendor_id is not distinct from n.title_vendor_id) desc, (vendor_id is not distinct from o.title_vendor_id) desc, id limit 1;
    if n.title_vendor_id is null and n.title_contact is null and n.title_email is null and n.title_phone is null then
      if o.id is not null then delete from public.deal_parties where id = v_id; end if;
    elsif v_id is not null and o.id is null then
      null; -- backfill: a title party already exists, leave what the import wrote
    else
      select * into v from public.vendors where id = n.title_vendor_id;
      if v_id is null then
        insert into public.deal_parties (workspace_id, deal_id, role, vendor_id, name, company, email, phone, source)
        values (n.workspace_id, n.id, 'title', n.title_vendor_id, coalesce(n.title_contact, v.contact_name), v.business_name,
                coalesce(n.title_email, v.email), coalesce(n.title_phone, v.phone), 'clozr');
      else
        update public.deal_parties
           set vendor_id = n.title_vendor_id, company = coalesce(v.business_name, company),
               name = n.title_contact, email = n.title_email, phone = n.title_phone
         where id = v_id;
        if o.title_vendor_id is distinct from n.title_vendor_id and o.title_vendor_id is not null then
          delete from public.deal_parties where deal_id = n.id and role = 'title' and vendor_id = o.title_vendor_id and id <> v_id;
        end if;
      end if;
    end if;
  end if;
end $$;

-- ------------------------------------------------------------ triggers
create or replace function public.deal_parties_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare synced constant text[] := array['acquisitions','dispositions','tc','buyer','title'];
begin
  if coalesce(current_setting('clozr.deal_team_sync', true), '') = 'on' then return null; end if;
  perform set_config('clozr.deal_team_sync', 'on', true);
  if tg_op in ('UPDATE', 'DELETE') and old.role = any(synced) then
    perform public.deal_team_push(old.deal_id, array[old.role]);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.role = any(synced) then
    perform public.deal_team_push(new.deal_id, array[new.role]);
  end if;
  perform set_config('clozr.deal_team_sync', '', true);
  return null;
end $$;

drop trigger if exists deal_parties_sync on public.deal_parties;
create trigger deal_parties_sync after insert or update or delete on public.deal_parties
  for each row execute function public.deal_parties_sync();

create or replace function public.deals_team_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('clozr.deal_team_sync', true), '') = 'on' then return null; end if;
  perform set_config('clozr.deal_team_sync', 'on', true);
  perform public.deal_team_pull(new, case when tg_op = 'UPDATE' then old else null end);
  perform set_config('clozr.deal_team_sync', '', true);
  return null;
end $$;

drop trigger if exists deals_team_sync on public.deals;
create trigger deals_team_sync
  after insert or update of owner_id, dispo_rep_id, dispo_rep2_id, tc_rep_id, buyer_id,
                            title_vendor_id, title_contact, title_email, title_phone
  on public.deals for each row execute function public.deals_team_sync();

revoke all on function public.deal_team_push(bigint, text[]) from public, anon, authenticated;
revoke all on function public.deal_team_user(public.deals, text, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.deal_team_pull(public.deals, public.deals) from public, anon, authenticated;
revoke all on function public.deal_parties_sync() from public, anon, authenticated;
revoke all on function public.deals_team_sync() from public, anon, authenticated;

-- ------------------------------------------------------------ backfill
-- Idempotent: every step checks for the row it would add.
do $$
declare d public.deals; r record;
begin
  perform set_config('clozr.deal_team_sync', 'on', true);

  -- 1. Podio team rows ('team:<email>') point at the teammate with that email.
  update public.deal_parties p set user_id = m.user_id
    from public.workspace_members m join public.profiles pr on pr.id = m.user_id
   where p.user_id is null and p.role in ('acquisitions', 'dispositions', 'tc')
     and m.workspace_id = p.workspace_id and pr.email is not null
     and lower(p.source_id) = 'team:' || lower(pr.email)
     and not exists (select 1 from public.deal_parties q where q.deal_id = p.deal_id and q.role = p.role and q.user_id = m.user_id);

  -- 2. Deal columns -> parties.
  for d in select * from public.deals
            where owner_id is not null or dispo_rep_id is not null or dispo_rep2_id is not null or tc_rep_id is not null
               or buyer_id is not null or title_vendor_id is not null or title_contact is not null
               or title_email is not null or title_phone is not null
  loop
    perform public.deal_team_pull(d, null);
  end loop;

  -- 3. Parties -> empty deal columns only (a set column is never overwritten here).
  for r in
    select x.id, array_remove(array[
      case when x.owner_id is null and exists (select 1 from public.deal_parties p where p.deal_id = x.id and p.role = 'acquisitions' and p.user_id is not null) then 'acquisitions' end,
      case when x.dispo_rep2_id is null and exists (select 1 from public.deal_parties p where p.deal_id = x.id and p.role = 'dispositions' and p.user_id is not null
                                                     and p.user_id is distinct from x.dispo_rep_id) then 'dispositions' end,
      case when x.tc_rep_id is null and exists (select 1 from public.deal_parties p where p.deal_id = x.id and p.role = 'tc' and p.user_id is not null) then 'tc' end,
      case when x.buyer_id is null and exists (select 1 from public.deal_parties p where p.deal_id = x.id and p.role = 'buyer' and p.buyer_id is not null) then 'buyer' end,
      case when x.title_vendor_id is null and x.title_contact is null and x.title_email is null and x.title_phone is null
            and exists (select 1 from public.deal_parties p where p.deal_id = x.id and p.role = 'title') then 'title' end
    ], null) as roles
    from public.deals x
  loop
    if cardinality(r.roles) > 0 then perform public.deal_team_push(r.id, r.roles); end if;
  end loop;

  perform set_config('clozr.deal_team_sync', '', true);
end $$;
