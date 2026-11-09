-- 439 · A completed DocuSign or Dotloop envelope from a known buyer puts that
-- buyer on the deal.
--
-- 5323 Sage Hill Rd (deal 5366) was assigned to New Western. Their agent sent
-- the end-buyer contract through DocuSign and the "Completed:" email sat in
-- communications from 2026-10-23 until the buyer was added by hand on
-- 2026-10-30. The email names the property and the sender's address, and that
-- address was already a buyer record.
--
-- 1. esign_addr_norm(text): lowercase words, punctuation dropped, Road/Rd,
--    Street/St, Drive/Dr and the other suffixes and directions folded.
-- 2. esign_envelope(from, subject, body): for a completed DocuSign envelope
--    ("Completed:" subject from docusign.net) or a signed Dotloop document
--    (dotloop.com, someone else "has signed", or fully signed / executed; our
--    own "You have signed ..." notice is not the buyer signing), the
--    provider, the envelope name and the sender's name and email. Else null.
-- 3. esign_signed_contract(communication id, apply): finds the one open deal
--    (not Closed, not Terminated, not archived; a non-Prospect deal wins over
--    Prospect duplicates) whose properties.line1 appears in the subject.
--    Sender email is a buyer in the workspace: one deal_parties row, role
--    'buyer', source 'docusign' / 'dotloop', source_id the communication id,
--    is_poc; deal_parties_sync (46) sets deals.buyer_id. The stage is left
--    alone. The TC and dispo rep get a 'TC' bell row. Sender is not a buyer
--    (listing agent, title, seller side, our own team): no party, one 'TC'
--    bell row to the TC (else dispo rep, else owner) to file it. No deal or
--    more than one: nothing but a log line. apply = false only reports.
-- 4. Trigger communications_esign_signed (after insert, inbound email from
--    those senders, last 60 days). Never fails the insert.
-- 5. Backfill: runs step 3 once over the last 60 days of completed envelopes.
--
-- Idempotent: a buyer already on the deal (by buyer id or email) is not added
-- again and nobody is notified twice; a non-buyer envelope notifies once per
-- deal and envelope name, so a re-read or a second mailbox adds nothing.
-- Safe to re-run.

create or replace function public.esign_addr_norm(p text) returns text
language sql immutable set search_path = pg_temp as $$
  select ' ' || btrim(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', ' ', 'g')),
      '\mroad\M', 'rd', 'g'), '\mstreet\M', 'st', 'g'), '\mdrive\M', 'dr', 'g'),
      '\mavenue\M', 'ave', 'g'), '\mlane\M', 'ln', 'g'), '\mcourt\M', 'ct', 'g'),
      '\mcircle\M', 'cir', 'g'), '\mboulevard\M', 'blvd', 'g'), '\mplace\M', 'pl', 'g'),
      '\mterrace\M', 'ter', 'g'), '\mhighway\M', 'hwy', 'g'), '\mparkway\M', 'pkwy', 'g'),
      '\mtrail\M', 'trl', 'g'), '\m(north|south|east|west)\M', '', 'g'),
      '\m([nsew])\M', '', 'g'),
    '\s+', ' ', 'g')) || ' ';
$$;

create or replace function public.esign_envelope(p_from text, p_subject text, p_body text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_text text; v_m text[]; v_provider text; v_env text;
begin
  if p_from ~* '[@.]docusign\.net$' and p_subject ~* '^\s*completed:' then
    v_provider := 'docusign';
    v_env := btrim(regexp_replace(p_subject, '^\s*completed:\s*(complete with docusign:\s*)?', '', 'i'));
  elsif p_from ~* '[@.]dotloop\.com$'
        and p_subject !~* '^\s*you have\M'
        and p_subject ~* '(\mhas (signed|completed)\M|\mall parties have (signed|completed)\M|\mfully (signed|executed)\M)' then
    v_provider := 'dotloop';
    v_env := btrim(p_subject);
  else
    return null;
  end if;
  v_text := regexp_replace(public.reply_text(p_body), '&#?[a-z0-9]+;', ' ', 'gi');
  if v_provider = 'docusign' then
    v_m := regexp_match(v_text, 'View Completed Document\s+(.+?)\s+([^\s@]+@[^\s@]+\.[a-z]{2,})\s+All parties have completed', 'i');
    if v_m is null then
      v_m := array[(regexp_match(v_text, 'sent to you by (.+?) who is using', 'i'))[1], null];
    end if;
  else
    -- Dotloop's signed notice names the loop's people, not an address.
    v_m := array[(regexp_match(v_text, 'signature verification\s+(.+?)\s+IN LOOP', 'i'))[1],
                 (regexp_match(v_text, '([^\s@<>"]+@(?!(?:[a-z0-9-]+\.)*dotloop\.com)[^\s@<>"]+\.[a-z]{2,})', 'i'))[1]];
  end if;
  return jsonb_build_object('provider', v_provider, 'envelope', v_env,
    'name', nullif(btrim(v_m[1]), ''), 'email', lower(nullif(btrim(v_m[2]), '')));
end $$;

create or replace function public.esign_signed_contract(p_comm_id bigint, p_apply boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record; e jsonb; v_subject text; v_deals bigint[]; d record; b record;
  v_email text; v_who text; v_line text; v_domain text; v_company text; v_out jsonb; v_users uuid[];
begin
  select id, workspace_id, from_email, subject, body into c from public.communications where id = p_comm_id;
  if c.id is null then return null; end if;
  e := public.esign_envelope(c.from_email, c.subject, c.body);
  if e is null then return null; end if;
  v_out := e || jsonb_build_object('communication_id', c.id);

  v_subject := public.esign_addr_norm(c.subject);
  select array_agg(x.id order by x.id) into v_deals from (
    select dl.id, dl.stage = 'Prospect' as prospect
      from public.deals dl join public.properties p on p.id = dl.property_id
     where dl.workspace_id = c.workspace_id
       and dl.stage not in ('Closed', 'Terminated') and not dl.terminated and dl.archived_at is null
       and split_part(p.line1, ',', 1) ~ '^\s*\d'
       and length(public.esign_addr_norm(split_part(p.line1, ',', 1))) > 6
       and strpos(v_subject, public.esign_addr_norm(split_part(p.line1, ',', 1))) > 0) x
   where not x.prospect or not exists (
     select 1 from public.deals d2 join public.properties p2 on p2.id = d2.property_id
      where d2.workspace_id = c.workspace_id and d2.stage not in ('Closed', 'Terminated', 'Prospect')
        and not d2.terminated and d2.archived_at is null
        and split_part(p2.line1, ',', 1) ~ '^\s*\d'
        and length(public.esign_addr_norm(split_part(p2.line1, ',', 1))) > 6
        and strpos(v_subject, public.esign_addr_norm(split_part(p2.line1, ',', 1))) > 0);
  if coalesce(array_length(v_deals, 1), 0) <> 1 then
    raise log 'esign_signed_contract: communication % matched % open deals', c.id, coalesce(array_length(v_deals, 1), 0);
    return v_out || jsonb_build_object('outcome', 'no_single_deal', 'deals', to_jsonb(coalesce(v_deals, '{}')));
  end if;

  select dl.id, dl.tc_rep_id, dl.dispo_rep_id, dl.owner_id, p.line1 into d
    from public.deals dl join public.properties p on p.id = dl.property_id where dl.id = v_deals[1];
  v_out := v_out || jsonb_build_object('deal_id', d.id);
  v_line := d.line1;
  v_email := e ->> 'email';
  if p_apply then perform pg_advisory_xact_lock(hashtext('esign_signed_contract'), d.id::int); end if;

  -- A known buyer, never one of our own people.
  select bu.id, bu.name, bu.company, bu.phone into b
    from public.buyers bu
   where v_email is not null and bu.workspace_id = c.workspace_id and lower(bu.email) = v_email
     and not exists (select 1 from public.workspace_members m join public.profiles pr on pr.id = m.user_id
                      where m.workspace_id = c.workspace_id and lower(pr.email) = v_email)
   order by (bu.archived_at is null) desc, bu.last_activity_at desc nulls last, bu.id desc
   limit 1;

  v_who := coalesce(e ->> 'name', b.name, v_email, 'Someone') || coalesce(' (' || v_email || ')', '');

  if b.id is not null then
    if exists (select 1 from public.deal_parties dp
                where dp.deal_id = d.id and dp.role = 'buyer'
                  and (dp.buyer_id in (select bu.id from public.buyers bu where bu.workspace_id = c.workspace_id and lower(bu.email) = v_email)
                       or lower(dp.email) = v_email)) then
      return v_out || jsonb_build_object('outcome', 'already_on_deal', 'buyer_id', b.id);
    end if;
    v_out := v_out || jsonb_build_object('outcome', 'buyer_added', 'buyer_id', b.id);
    if not p_apply then return v_out; end if;

    v_domain := split_part(v_email, '@', 2);
    v_company := coalesce(nullif(btrim(b.company), ''),
      case when v_domain !~* '^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|comcast|att|sbcglobal|bellsouth|proton|protonmail)\.'
           then initcap(split_part(v_domain, '.', 1)) end);
    insert into public.deal_parties (workspace_id, deal_id, role, buyer_id, name, company, email, phone, source, source_id, is_poc)
    values (c.workspace_id, d.id, 'buyer', b.id, coalesce(nullif(btrim(b.name), ''), e ->> 'name'), v_company, v_email, b.phone,
            e ->> 'provider', c.id::text, true);

    v_users := array(select distinct u from unnest(array[d.tc_rep_id, d.dispo_rep_id]) u where u is not null);
    if cardinality(v_users) = 0 and d.owner_id is not null then v_users := array[d.owner_id]; end if;
    insert into public.notifications (workspace_id, user_id, category, title, body, deal_id, buyer_id, payload)
    select c.workspace_id, u, 'TC',
           'Buyer added from signed contract: ' || coalesce(nullif(btrim(b.name), ''), v_who) || ' on ' || v_line,
           left(v_who || ' sent "' || (e ->> 'envelope') || '" through ' || initcap(e ->> 'provider')
                || ' and every party signed. Added as the buyer on this deal. Stage unchanged.', 300),
           d.id, b.id,
           jsonb_build_object('kind', 'esign_signed', 'outcome', 'buyer_added', 'provider', e ->> 'provider',
                              'envelope', e ->> 'envelope', 'signer_email', v_email, 'communication_id', c.id)
      from unnest(v_users) u;
    return v_out;
  end if;

  if exists (select 1 from public.notifications n
              where n.workspace_id = c.workspace_id and n.deal_id = d.id and n.category = 'TC'
                and n.payload ->> 'kind' = 'esign_signed'
                and lower(n.payload ->> 'envelope') = lower(e ->> 'envelope')) then
    return v_out || jsonb_build_object('outcome', 'already_notified');
  end if;
  v_out := v_out || jsonb_build_object('outcome', 'tc_notified', 'user_id', coalesce(d.tc_rep_id, d.dispo_rep_id, d.owner_id));
  if not p_apply or coalesce(d.tc_rep_id, d.dispo_rep_id, d.owner_id) is null then return v_out; end if;
  insert into public.notifications (workspace_id, user_id, category, title, body, deal_id, payload)
  values (c.workspace_id, coalesce(d.tc_rep_id, d.dispo_rep_id, d.owner_id), 'TC',
          'Signed contract on ' || v_line || ': file it',
          left(v_who || ' sent "' || (e ->> 'envelope') || '" through ' || initcap(e ->> 'provider')
               || '. The sender is not a buyer in CLOZR, so nobody was added to the deal.', 300),
          d.id,
          jsonb_build_object('kind', 'esign_signed', 'outcome', 'needs_filing', 'provider', e ->> 'provider',
                             'envelope', e ->> 'envelope', 'signer_email', v_email, 'communication_id', c.id));
  return v_out;
end $$;

revoke execute on function public.esign_signed_contract(bigint, boolean) from public, anon, authenticated;

create or replace function public.esign_signed_after_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.esign_signed_contract(new.id, true);
  return new;
exception when others then
  -- Never fail the insert of the email itself.
  raise warning 'esign_signed_after_insert: %', sqlerrm;
  return new;
end $$;

revoke execute on function public.esign_signed_after_insert() from public, anon, authenticated;

drop trigger if exists communications_esign_signed on public.communications;
create trigger communications_esign_signed after insert on public.communications
  for each row when (new.channel = 'email' and new.direction = 'inbound'
                     and new.from_email ~* '[@.](docusign\.net|dotloop\.com)$'
                     and new.occurred_at > now() - interval '60 days')
  execute function public.esign_signed_after_insert();

-- One-time backfill over what already arrived. Re-running it is a no-op.
do $$
declare r record; v jsonb;
begin
  for r in select id from public.communications
            where channel = 'email' and direction = 'inbound'
              and from_email ~* '[@.](docusign\.net|dotloop\.com)$'
              and occurred_at > now() - interval '60 days'
            order by occurred_at
  loop
    begin
      v := public.esign_signed_contract(r.id, true);
      if v is not null then raise notice 'esign backfill: %', v; end if;
    exception when others then
      raise warning 'esign backfill %: %', r.id, sqlerrm;
    end;
  end loop;
end $$;
