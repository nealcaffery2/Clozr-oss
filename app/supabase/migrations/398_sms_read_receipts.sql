-- Read receipts on texts. iMessage and RCS can report that a text was read;
-- plain SMS never does. Talkr will send `message.read` (or status `read`), and
-- talkr-webhook files it as communications.status = 'read'.
--
-- comm_status_rank keeps a text's status forward-only in ingest_apply (the
-- `on conflict` keeps the higher rank): read now ranks above everything, since
-- a text that was read was delivered and cannot fail after. The other ranks are
-- unchanged.

set lock_timeout = '10s';

create or replace function public.comm_status_rank(s text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(s, ''))
    when 'queued'      then 1
    when 'sending'     then 1
    when 'accepted'    then 1
    when 'sent'        then 2
    when 'delivered'   then 3
    when 'failed'      then 4
    when 'undelivered' then 4
    when 'rejected'    then 4
    when 'read'        then 5
    else 0
  end;
$$;

-- When the text was read: stamped the first time its row turns read.
alter table public.communications add column if not exists read_at timestamptz;

-- Stamps read_at, and keeps a read text read when a direct write (the Talkr
-- mirror, a campaign tick) later sets an older status on it.
create or replace function public.communications_read_receipt()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and lower(coalesce(old.status, '')) = 'read'
     and public.comm_status_rank(new.status) < public.comm_status_rank('read') then
    new.status := old.status;
  end if;
  if lower(coalesce(new.status, '')) = 'read' and new.read_at is null then
    new.read_at := coalesce(case when tg_op = 'UPDATE' then old.read_at end, now());
  end if;
  return new;
end;
$$;

revoke all on function public.communications_read_receipt() from public, anon, authenticated;

create or replace trigger communications_read_receipt
  before insert or update of status on public.communications
  for each row execute function public.communications_read_receipt();
