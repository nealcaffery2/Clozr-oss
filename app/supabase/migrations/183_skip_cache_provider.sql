-- 183 · Which provider skip traced an owner.
--
-- Skip tracing is split by owner type (genius-discover's trace()): LLCs and
-- other entities go to BatchData, which finds the person behind them far more
-- often; individuals go to RealEstateAPI at $0.05 a hit. provider records who
-- answered each cached trace, so the two can be compared on hit rate:
--
--   select provider, count(*) as traced,
--          count(*) filter (where jsonb_array_length(hits) > 0) as found
--   from public.genius_skip_cache group by provider;
--
-- Null on rows traced before this split (all RealEstateAPI).

alter table public.genius_skip_cache add column if not exists provider text;

comment on column public.genius_skip_cache.provider is
  'Who skip traced this owner: batchdata (entities) or reapi (individuals). Null before migration 183.';
