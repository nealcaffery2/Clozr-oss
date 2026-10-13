-- 129 · A seller's other numbers, for the record and the power dialer.
--
-- The dialer rang one number per seller: sellers.phone. Every other number we
-- had for them was nowhere it could be dialled. An import's second phone
-- column was parsed and dropped, and a skip trace filled the phone only when
-- it was blank and left the rest in a "Skip trace" note on the timeline.
-- Buyers have had buyer_phones for that since the Genius work.
--
-- seller_phones holds a seller's ADDITIONAL numbers. sellers.phone stays the
-- number: what the record shows first, what a text goes to, what dedupe and
-- call-sync match on. Nothing syncs the two; a number here never becomes the
-- primary by itself.
--
--   phone          E.164, as lib/talkr.ts toE164 writes it
--   phone_key      public.normalize_phone(phone), set by trigger, the same key
--                  sellers.phone_key and buyer_phones.phone_key hold
--   position       the order to try them in; the primary is 1, so 2 onwards
--   kind           mobile / landline / voip / what the source called it
--   source         'import', 'skip_trace', 'manual', 'backfill'
--   is_dnc         never dial it (a skip trace's registry flag, or a rep)
--   is_wrong       the "Wrong number" outcome on this number: the dialer
--                  skips it, the seller keeps their other numbers
--   call_count, last_called_at   bumped by the dialer when it rings this one
--
-- Row security is the sellers rule (docs/security.md §2): any member of the
-- workspace reads and writes, and a row can only point at a seller of its own
-- workspace. Idempotent.

create table if not exists public.seller_phones (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  seller_id      bigint not null references public.sellers(id) on delete cascade,
  phone          text not null,
  phone_key      text,
  position       smallint not null default 2,
  kind           text default 'mobile',
  source         text,
  is_dnc         boolean not null default false,
  is_wrong       boolean not null default false,
  call_count     integer not null default 0,
  last_called_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seller_phones_e164 check (phone ~ '^\+[0-9]{7,15}$'),
  constraint seller_phones_seller_phone_key unique (seller_id, phone)
);
create index if not exists seller_phones_seller_position_idx on public.seller_phones (seller_id, position);
create index if not exists seller_phones_workspace_idx on public.seller_phones (workspace_id);
create index if not exists seller_phones_phone_key_idx on public.seller_phones (workspace_id, phone_key);

-- phone_key the way every other phone column gets it. Definer, so the key is
-- set whoever writes the row; a trigger body is not an RPC (migration 14).
create or replace function public.seller_phones_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.phone_key := public.normalize_phone(new.phone);
  return new;
end
$$;
revoke all on function public.seller_phones_key() from public, anon, authenticated;

create or replace trigger seller_phones_key
  before insert or update of phone on public.seller_phones
  for each row execute function public.seller_phones_key();
create or replace trigger seller_phones_touch
  before update on public.seller_phones
  for each row execute function public.touch_updated_at();

alter table public.seller_phones enable row level security;
drop policy if exists seller_phones_rw on public.seller_phones;
create policy seller_phones_rw on public.seller_phones for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id)
    and exists (select 1 from public.sellers s where s.id = seller_id and s.workspace_id = seller_phones.workspace_id));
grant select, insert, update, delete on public.seller_phones to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill, once: the numbers earlier skip traces left in "Skip trace" notes.
-- lib/bulk-skip-trace.ts writes one line per number, unchanged since it
-- shipped:  <number>[ (<type>)][ DNC][, <name>]  — emails are lines too, and
-- never start with a digit. The seller's own phone and a repeat are skipped;
-- positions follow the order the notes were written in. A re-run adds nothing.
-- ---------------------------------------------------------------------------
with lines as (
  select a.workspace_id, a.entity_id as seller_id, a.occurred_at, a.id as activity_id, l.n,
         substring(l.line from '^\s*([+()0-9 .-]{10,20}?)(?:\s+\(|\s+DNC|,|\s*$)') as raw,
         lower(substring(l.line from '\(([A-Za-z ]+)\)')) as kind,
         l.line ~ '\sDNC(,|\s*$)' as dnc
    from public.activity a
    cross join lateral regexp_split_to_table(coalesce(a.body, ''), '\n') with ordinality as l(line, n)
   where a.entity_type = 'seller' and a.kind = 'note' and a.title = 'Skip trace'
),
numbers as (
  select ln.*, regexp_replace(coalesce(ln.raw, ''), '\D', '', 'g') as digits
    from lines ln
),
found as (
  select distinct on (s.id, e.e164)
         s.workspace_id, s.id as seller_id, e.e164, nb.kind, nb.dnc, nb.occurred_at, nb.activity_id, nb.n
    from numbers nb
    join public.sellers s on s.id = nb.seller_id and s.workspace_id = nb.workspace_id
    cross join lateral (
      select case
               when length(nb.digits) = 10 then '+1' || nb.digits
               when length(nb.digits) = 11 and nb.digits like '1%' then '+' || nb.digits
             end as e164
    ) e
   where e.e164 is not null
     and public.normalize_phone(e.e164) is distinct from public.normalize_phone(s.phone)
   order by s.id, e.e164, nb.occurred_at, nb.activity_id, nb.n
)
insert into public.seller_phones (workspace_id, seller_id, phone, position, kind, source, is_dnc)
select f.workspace_id, f.seller_id, f.e164,
       (1 + row_number() over (partition by f.seller_id order by f.occurred_at, f.activity_id, f.n))::smallint,
       coalesce(nullif(f.kind, ''), 'mobile'), 'backfill', f.dnc
  from found f
on conflict (seller_id, phone) do nothing;
