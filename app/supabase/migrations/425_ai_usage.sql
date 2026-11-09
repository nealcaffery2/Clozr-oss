-- 425 · One row per Claude call, so "why are we out of API credit" is a
-- query, not a count of side-effect tables. Written by the edge functions
-- (_shared/ai-usage.ts recordUsage) with the service role; members read
-- their own workspace. cost_cents comes from the price table in
-- _shared/models.ts at call time, so a price change does not rewrite history.

create table if not exists public.ai_usage (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint,
  feature            text not null,
  model              text not null,
  input_tokens       int  not null default 0,
  output_tokens      int  not null default 0,
  cache_read_tokens  int  not null default 0,
  cache_write_tokens int  not null default 0,
  cost_cents         numeric(12, 4) not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists ai_usage_ws_day_idx on public.ai_usage (workspace_id, created_at desc);

alter table public.ai_usage enable row level security;

create policy ai_usage_select on public.ai_usage for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.ai_usage to authenticated;

-- Spend by workspace, day, feature and model. Day is UTC.
create or replace view public.ai_usage_daily
with (security_invoker = true) as
select
  workspace_id,
  date_trunc('day', created_at)::date as day,
  feature,
  model,
  count(*)                 as calls,
  sum(input_tokens)        as input_tokens,
  sum(output_tokens)       as output_tokens,
  sum(cache_read_tokens)   as cache_read_tokens,
  sum(cache_write_tokens)  as cache_write_tokens,
  sum(cost_cents)          as cost_cents
from public.ai_usage
group by 1, 2, 3, 4;

grant select on public.ai_usage_daily to authenticated;
