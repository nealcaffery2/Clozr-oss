-- 294 · The Talkr call mirror writes only what changed.
--
-- call-sync upserted two days of Talkr call history (up to 200 calls per
-- workspace) every two minutes through PostgREST. An upsert on a row that is
-- already there is an UPDATE even when every value is the same: hundreds
-- of thousands of updates on communications a week, each one WAL, about 18 index entries
-- and a Realtime event to every open tab. The relink of unfiled calls was one
-- UPDATE request per row.
--
-- talkr_mirror_calls(p_ws, p_rows, p_relink) does both in one call:
--
--   1. Update the rows already there, only where a value differs. Same
--      columns as the old upsert: seller_id, buyer_id, channel, direction,
--      occurred_at, from_phone, to_phone, body, duration_s, status,
--      talkr_user_id always; summary and rep_id only when the row carries
--      one (a null here means call-sync had none, so the stored value stays).
--      The old upsert always listed from_phone / to_phone, so the line-owner
--      trigger (153, 289) credited a rep-less call to its line's owner on
--      every run; a row with no rep whose line now has an owner still counts
--      as changed, so that credit still lands.
--   2. Insert the rows not there yet (on conflict do nothing, for a webhook
--      that files the same call in between). New rows go through the insert
--      triggers as before.
--   3. Relink: p_relink is [{id, seller_id, buyer_id}], one UPDATE for all,
--      only rows in this workspace whose filing differs.
--
-- Returns {"written": n, "relinked": n}: rows actually inserted or updated.
-- A second run with no new calls writes 0. Service role only (call-sync).

create or replace function public.talkr_mirror_calls(p_ws bigint, p_rows jsonb, p_relink jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written int;
  v_rel int;
begin
  with r as (
    select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      seller_id bigint, buyer_id bigint, channel text, direction text, occurred_at timestamptz,
      from_phone text, to_phone text, body text, summary text, duration_s integer, status text,
      source_id text, talkr_user_id text, rep_id uuid)
     where x.source_id is not null
  ), upd as (
    update public.communications c set
      seller_id = r.seller_id, buyer_id = r.buyer_id, channel = r.channel, direction = r.direction,
      occurred_at = r.occurred_at, from_phone = r.from_phone, to_phone = r.to_phone, body = r.body,
      duration_s = r.duration_s, status = r.status, talkr_user_id = r.talkr_user_id,
      summary = coalesce(r.summary, c.summary), rep_id = coalesce(r.rep_id, c.rep_id)
      from r
     where c.workspace_id = p_ws and c.source = 'talkr' and c.source_id = r.source_id
       and (
         (c.seller_id, c.buyer_id, c.channel, c.direction, c.occurred_at, c.from_phone, c.to_phone, c.body,
          c.duration_s, c.status, c.talkr_user_id, c.summary, c.rep_id)
         is distinct from
         (r.seller_id, r.buyer_id, r.channel, r.direction, r.occurred_at, r.from_phone, r.to_phone, r.body,
          r.duration_s, r.status, r.talkr_user_id, coalesce(r.summary, c.summary), coalesce(r.rep_id, c.rep_id))
         -- What the line-owner trigger would credit on this update.
         or (c.rep_id is null and r.rep_id is null and r.channel in ('sms', 'call', 'voicemail') and exists (
           select 1 from public.rep_phone_numbers rp
            where rp.workspace_id = p_ws and rp.user_id is not null
              and rp.phone_e164 = public.normalize_phone(case when r.direction = 'inbound' then r.to_phone else r.from_phone end)))
       )
    returning 1
  ), ins as (
    -- Same snapshot as the update: these are the rows not there yet.
    insert into public.communications (workspace_id, seller_id, buyer_id, channel, direction, occurred_at,
      from_phone, to_phone, body, summary, duration_s, status, source, source_id, talkr_user_id, rep_id)
    select p_ws, r.seller_id, r.buyer_id, r.channel, r.direction, r.occurred_at,
           r.from_phone, r.to_phone, r.body, r.summary, r.duration_s, r.status, 'talkr', r.source_id, r.talkr_user_id, r.rep_id
      from r
     where not exists (select 1 from public.communications c
                        where c.workspace_id = p_ws and c.source = 'talkr' and c.source_id = r.source_id)
    on conflict (workspace_id, source, source_id) do nothing
    returning 1
  )
  select (select count(*) from upd) + (select count(*) from ins) into v_written;

  update public.communications c set seller_id = l.seller_id, buyer_id = l.buyer_id
    from jsonb_to_recordset(coalesce(p_relink, '[]'::jsonb)) as l(id bigint, seller_id bigint, buyer_id bigint)
   where c.id = l.id and c.workspace_id = p_ws
     and (c.seller_id, c.buyer_id) is distinct from (l.seller_id, l.buyer_id);
  get diagnostics v_rel = row_count;

  return jsonb_build_object('written', v_written, 'relinked', v_rel);
end
$$;

revoke all on function public.talkr_mirror_calls(bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.talkr_mirror_calls(bigint, jsonb, jsonb) to service_role;
