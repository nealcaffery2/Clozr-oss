-- The seller is on the deal team (migration 46 keeps the reps, buyer and
-- title company in step with the deal; this adds the seller). A deal's
-- seller changing replaces them, the same way a buyer or title change does.
-- Replaces deal_team_pull in place: no table lock, the existing deals_team_sync
-- trigger keeps calling it.

CREATE OR REPLACE FUNCTION public.deal_team_pull(n deals, o deals)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id bigint; b public.buyers; v public.vendors; s public.sellers;
begin
  perform public.deal_team_user(n, 'acquisitions', o.owner_id, n.owner_id, array[n.owner_id]);
  perform public.deal_team_user(n, 'dispositions', o.dispo_rep_id, n.dispo_rep_id, array[n.dispo_rep_id, n.dispo_rep2_id]);
  perform public.deal_team_user(n, 'dispositions', o.dispo_rep2_id, n.dispo_rep2_id, array[n.dispo_rep_id, n.dispo_rep2_id]);
  perform public.deal_team_user(n, 'tc', o.tc_rep_id, n.tc_rep_id, array[n.tc_rep_id]);

  -- Migration 119: the seller is on the team too, and follows the deal's seller.
  if n.seller_id is not null and not exists (select 1 from public.deal_parties where deal_id = n.id and role = 'seller' and seller_id = n.seller_id) then
    delete from public.deal_parties where deal_id = n.id and role = 'seller' and seller_id is not null and seller_id <> n.seller_id;
    select * into s from public.sellers where id = n.seller_id;
    if s.id is not null then
      insert into public.deal_parties (workspace_id, deal_id, role, seller_id, name, email, phone, source)
      values (n.workspace_id, n.id, 'seller', n.seller_id, s.name, s.email, s.phone, 'clozr');
    end if;
  end if;

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
      null;
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
end $function$;

-- Every live deal gets its seller on the team now.
insert into public.deal_parties (workspace_id, deal_id, role, seller_id, name, email, phone, source)
select d.workspace_id, d.id, 'seller', d.seller_id, s.name, s.email, s.phone, 'clozr'
  from public.deals d join public.sellers s on s.id = d.seller_id
 where d.stage <> 'Prospect' and d.archived_at is null
   and not exists (select 1 from public.deal_parties p where p.deal_id = d.id and p.role = 'seller' and p.seller_id = d.seller_id)
on conflict do nothing;
