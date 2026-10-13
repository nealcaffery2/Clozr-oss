-- 25 · rate_limit_hit(): a shared fixed-window counter for the edge functions
--
-- Edge functions are ephemeral, so an in-memory limiter is per-instance and
-- a flood simply fans out. The database is the one thing every instance
-- shares. One row per (key, window); the function increments and answers in a
-- single statement. Service role only — the browser never calls this.

create table if not exists public.rate_limit_buckets (
  key      text primary key,
  count    integer not null default 0,
  reset_at timestamptz not null
);
alter table public.rate_limit_buckets enable row level security;
revoke all on table public.rate_limit_buckets from anon, authenticated;

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_count integer;
  v_reset timestamptz;
begin
  insert into public.rate_limit_buckets as b (key, count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set count    = case when b.reset_at <= now() then 1 else b.count + 1 end,
        reset_at = case when b.reset_at <= now() then now() + make_interval(secs => p_window_seconds) else b.reset_at end
  returning count, reset_at into v_count, v_reset;
  -- Opportunistic sweep so the table never grows without bound.
  if random() < 0.01 then
    delete from public.rate_limit_buckets where reset_at < now() - interval '1 day';
  end if;
  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'remaining', greatest(0, p_limit - v_count),
    'reset_seconds', greatest(0, ceil(extract(epoch from (v_reset - now())))::integer));
end $$;
revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
