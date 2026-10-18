-- 262 · Errors thrown in the browser, so a crash leaves a record.
--
-- CLOZR is a static export: when a screen throws, nothing reaches Vercel or
-- Supabase, and all anyone has is "it crashed". The app now writes one row
-- here per distinct error (lib/client-errors.ts): the crash card, the app
-- error page and the window error / unhandledrejection handlers. Read it from
-- the SQL editor or the Supabase MCP:
--
--   select created_at, email, where_at, message, path, release
--   from client_errors_recent limit 50;
--
-- Signed-in users insert their own rows; nobody reads through the API
-- (service role and the SQL editor only). Lengths are capped so the public
-- key cannot be used to park large blobs.
--
-- Additive, safe to re-run.

create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid not null default auth.uid(),
  kind        text not null,
  where_at    text,
  message     text not null,
  stack       text,
  component_stack text,
  path        text,
  release     text,
  user_agent  text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_errors_kind_check') then
    alter table public.client_errors
      add constraint client_errors_kind_check check (kind in ('screen', 'app', 'window', 'promise'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_errors_size_check') then
    alter table public.client_errors
      add constraint client_errors_size_check check (
        length(message) <= 2000
        and coalesce(length(stack), 0) <= 8000
        and coalesce(length(component_stack), 0) <= 8000
        and coalesce(length(where_at), 0) <= 200
        and coalesce(length(path), 0) <= 500
        and coalesce(length(release), 0) <= 80
        and coalesce(length(user_agent), 0) <= 400
      );
  end if;
end $$;

create index if not exists client_errors_created_at on public.client_errors (created_at desc);
create index if not exists client_errors_user_created on public.client_errors (user_id, created_at desc);

alter table public.client_errors enable row level security;

drop policy if exists client_errors_insert_own on public.client_errors;
create policy client_errors_insert_own on public.client_errors
  for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on public.client_errors from anon;
grant insert on public.client_errors to authenticated;

-- Who hit it, without a join every time.
create or replace view public.client_errors_recent
with (security_invoker = true) as
select e.id, e.created_at, u.email, e.kind, e.where_at, e.message, e.path, e.release, e.stack, e.component_stack, e.user_agent
from public.client_errors e
left join auth.users u on u.id = e.user_id
order by e.created_at desc;

revoke all on public.client_errors_recent from anon, authenticated;

notify pgrst, 'reload schema';
