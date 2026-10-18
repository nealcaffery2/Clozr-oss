-- 275 · Talkr calls and texts stay in the workspace they belong to.
--
-- Two workspaces with the same owner can share one Talkr org: the same lines,
-- the same dialer, and reps working both. Talkr hands one workspace every
-- call and thread in the org, so a call for the other workspace's contact
-- could land in the wrong one: the server mirror (call-sync) filed every org
-- call there, unfiled when the number matched no record, and the browser
-- mirror could copy a text onto a record that only shares the number. The
-- line cannot tell the two apart; the person on the other end can, by being a
-- contact in one workspace and not the other.
--
--   * workspaces.settings.talkr.elsewhere: ids of other workspaces with the
--     same owner whose contacts this workspace leaves alone. Settings > Talkr
--     edits it.
--   * talkr_elsewhere(ws, numbers, source_ids): for a member of `ws` (or the
--     service role), which numbers are a contact (seller, seller phone or
--     buyer) in one of those workspaces and in no record of `ws`, and which
--     Talkr ids (`call:...`, `msg:...`) are already filed on a record there.
--     The Inbox, the dialer and the browser mirror filter with it; call-sync
--     files such calls in that workspace instead (_shared/talkr-elsewhere.ts).
--   * talkr_settle_elsewhere(ws, since): service role only. A Talkr call or
--     text in `ws` that the other workspace filed on its own record (its
--     dialer or composer placed it) is that workspace's: the transcript,
--     score and recording link carry over to its copy where it has none, and
--     the copy in `ws` goes. An unfiled call or text in `ws` with someone who
--     is a contact only there moves there, onto that contact. call-sync runs
--     it each tick for the last two days. Safe to re-run.

-- The workspaces `p_workspace` leaves alone: listed in its settings, same owner, not itself.
create or replace function public.talkr_elsewhere_ids(p_workspace bigint)
 returns bigint[]
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(array_agg(distinct o.id order by o.id), '{}'::bigint[])
    from public.workspaces w
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(w.settings->'talkr'->'elsewhere') = 'array' then w.settings->'talkr'->'elsewhere' else '[]'::jsonb end
    ) e(v)
    join public.workspaces o on o.id::text = btrim(e.v) and o.id <> w.id and o.owner_id = w.owner_id
   where w.id = p_workspace;
$function$;
revoke all on function public.talkr_elsewhere_ids(bigint) from public, anon, authenticated;

-- A seller, a seller's other phone, or a buyer in the workspace has this number (E.164, as phone_key holds it).
create or replace function public.talkr_is_contact(p_workspace bigint, p_phone text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (select 1 from public.sellers s where s.workspace_id = p_workspace and s.phone_key = p_phone)
      or exists (select 1 from public.buyers b where b.workspace_id = p_workspace and b.phone_key = p_phone)
      or exists (select 1 from public.seller_phones sp where sp.workspace_id = p_workspace and sp.phone_key = p_phone);
$function$;
revoke all on function public.talkr_is_contact(bigint, text) from public, anon, authenticated;

create or replace function public.talkr_elsewhere(p_workspace bigint, p_numbers text[] default '{}', p_source_ids text[] default '{}')
 returns table(kind text, key text, workspace_id bigint)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_others bigint[];
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = auth.uid()) then
    return;
  end if;
  v_others := public.talkr_elsewhere_ids(p_workspace);
  if cardinality(v_others) = 0 then return; end if;

  return query
    select 'number'::text, n.k,
           (select o.id from unnest(v_others) o(id) where public.talkr_is_contact(o.id, n.k) order by o.id limit 1)
      from (select distinct public.normalize_phone(x) as k from unnest((coalesce(p_numbers, '{}'::text[]))[1:500]) x) n
     where n.k is not null
       and not public.talkr_is_contact(p_workspace, n.k)
       and exists (select 1 from unnest(v_others) o(id) where public.talkr_is_contact(o.id, n.k));

  return query
    select distinct on (c.source_id) 'source'::text, c.source_id, c.workspace_id
      from public.communications c
     where c.workspace_id = any(v_others)
       and c.source = 'talkr'
       and c.source_id = any((coalesce(p_source_ids, '{}'::text[]))[1:500])
       and (c.seller_id is not null or c.buyer_id is not null)
     order by c.source_id, c.workspace_id;
end $function$;
revoke all on function public.talkr_elsewhere(bigint, text[], text[]) from public, anon;
grant execute on function public.talkr_elsewhere(bigint, text[], text[]) to authenticated, service_role;

create or replace function public.talkr_settle_elsewhere(p_workspace bigint, p_since timestamptz default null)
 returns table(merged integer, moved integer)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_others bigint[];
  v_merged integer := 0;
  v_moved integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'talkr_settle_elsewhere: service role only';
  end if;
  v_others := public.talkr_elsewhere_ids(p_workspace);
  if cardinality(v_others) = 0 then
    return query select 0, 0;
    return;
  end if;

  -- Filed there on a record: that copy keeps what this one learned, and this one goes.
  with dup as (
    select distinct on (h.id) h.id as here_id, t.id as there_id
      from public.communications h
      join public.communications t
        on t.source = 'talkr' and t.source_id = h.source_id and t.workspace_id = any(v_others)
       and (t.seller_id is not null or t.buyer_id is not null)
     where h.workspace_id = p_workspace and h.source = 'talkr' and h.channel in ('call', 'voicemail', 'sms')
       and (p_since is null or h.occurred_at >= p_since)
     order by h.id, t.workspace_id
  ), kept as (
    update public.communications t
       set from_phone          = coalesce(t.from_phone, h.from_phone),
           to_phone            = coalesce(t.to_phone, h.to_phone),
           summary             = coalesce(t.summary, h.summary),
           duration_s          = coalesce(t.duration_s, h.duration_s),
           recording_url       = coalesce(t.recording_url, h.recording_url),
           recording_id        = coalesce(t.recording_id, h.recording_id),
           transcript          = coalesce(t.transcript, h.transcript),
           transcript_status   = coalesce(t.transcript_status, h.transcript_status),
           transcript_segments = coalesce(t.transcript_segments, h.transcript_segments),
           call_sections       = coalesce(t.call_sections, h.call_sections),
           ai_notes            = coalesce(t.ai_notes, h.ai_notes),
           call_score          = coalesce(t.call_score, h.call_score),
           score_overall       = coalesce(t.score_overall, h.score_overall),
           coaching_review     = coalesce(t.coaching_review, h.coaching_review),
           intel_synced_at     = coalesce(t.intel_synced_at, h.intel_synced_at),
           intel_attempts      = greatest(t.intel_attempts, h.intel_attempts),
           talkr_user_id       = coalesce(t.talkr_user_id, h.talkr_user_id),
           -- The rep Talkr named, never a line owner's credit (the line is shared).
           rep_id              = coalesce(t.rep_id, case when h.rep_from_line then null else h.rep_id end)
      from dup d
      join public.communications h on h.id = d.here_id
     where t.id = d.there_id
    returning d.here_id
  )
  delete from public.communications x using kept k where x.id = k.here_id;
  get diagnostics v_merged = row_count;

  -- Unfiled here, with someone who is a contact only there: it moves there, onto that contact.
  with cand as (
    select c.id, n.k,
           (select o.id from unnest(v_others) o(id) where public.talkr_is_contact(o.id, n.k) order by o.id limit 1) as dest
      from public.communications c
      cross join lateral (select public.normalize_phone(case when c.direction = 'inbound' then c.from_phone else c.to_phone end) as k) n
     where c.workspace_id = p_workspace and c.source = 'talkr' and c.channel in ('call', 'voicemail', 'sms')
       and c.seller_id is null and c.buyer_id is null and c.vendor_id is null and c.deal_id is null
       and (p_since is null or c.occurred_at >= p_since)
       and n.k is not null
       and not public.talkr_is_contact(p_workspace, n.k)
  ), placed as (
    select cand.id, cand.dest,
           coalesce(
             (select s.id from public.sellers s where s.workspace_id = cand.dest and s.phone_key = cand.k order by s.id limit 1),
             (select sp.seller_id from public.seller_phones sp where sp.workspace_id = cand.dest and sp.phone_key = cand.k order by sp.seller_id limit 1)
           ) as seller_id,
           (select b.id from public.buyers b where b.workspace_id = cand.dest and b.phone_key = cand.k order by b.id limit 1) as buyer_id
      from cand
     where cand.dest is not null
  )
  update public.communications c
     set workspace_id  = p.dest,
         seller_id     = p.seller_id,
         buyer_id      = case when p.seller_id is null then p.buyer_id end,
         property_id   = null,
         rep_id        = case when c.rep_from_line then null else c.rep_id end,
         rep_from_line = false
    from placed p
   where c.id = p.id
     and not exists (
       select 1 from public.communications t
        where t.workspace_id = p.dest and t.source = c.source and t.source_id = c.source_id
     );
  get diagnostics v_moved = row_count;

  return query select v_merged, v_moved;
end $function$;
revoke all on function public.talkr_settle_elsewhere(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.talkr_settle_elsewhere(bigint, timestamptz) to service_role;
