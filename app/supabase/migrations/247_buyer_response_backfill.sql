-- 247 buyer_response_backfill
--
-- The Buyers list now reads its response rate from buyer_scores (lib/crm.ts),
-- not from deal_buyer_matches, whose sent_at was never stamped (0 of 1,012 on
-- 2026-10-10), so every buyer read 0% and the low-response tire kicker rule
-- never fired. Most buyers with real history were never scored, and 28 that
-- were show no rate because their Podio texts and calls were imported after
-- the score was computed.
--
-- This writes the reply-based rate for every buyer with outbound history,
-- the same rule as _shared/buyer-score-rule.ts: an outbound text, email or
-- call (notes are not touches) counts as answered when the buyer wrote or
-- called back within 7 days, opt-outs and "wrong number" are not answers, and
-- a deal send counts the same way or by replied_at. Rows land as source
-- 'rule' with computed_at two days back, so the next time a buyer is on
-- screen the buyer-score function re-reads the full history (with AI when
-- ANTHROPIC_API_KEY is set). An existing row keeps its score and reason; only
-- a missing rate and its counts are filled. Safe to re-run.

with touch as (
  select c.workspace_id, c.buyer_id, c.occurred_at
  from public.communications c
  where c.buyer_id is not null and c.direction = 'outbound' and c.occurred_at is not null
    and coalesce(c.channel, '') !~* '^(note|task|system|activity)$'
),
answer as (
  select c.buyer_id, c.occurred_at
  from public.communications c
  where c.buyer_id is not null and c.direction = 'inbound' and c.occurred_at is not null
    and coalesce(c.channel, '') !~* '^(note|task|system|activity)$'
    and coalesce(c.body, '') !~* '^\s*(stop|unsubscribe|end|quit|cancel|stopall)\M'
    and coalesce(c.body, '') !~* 'wrong number'
),
sends as (
  select m.workspace_id, m.buyer_id, m.sent_at as occurred_at, m.replied_at
  from public.deal_buyer_matches m
  where m.buyer_id is not null and m.sent_at is not null
),
counted as (
  select t.workspace_id, t.buyer_id,
    exists (select 1 from answer a where a.buyer_id = t.buyer_id and a.occurred_at > t.occurred_at and a.occurred_at <= t.occurred_at + interval '7 days') as answered
  from touch t
  union all
  select s.workspace_id, s.buyer_id,
    s.replied_at is not null
      or exists (select 1 from answer a where a.buyer_id = s.buyer_id and a.occurred_at > s.occurred_at and a.occurred_at <= s.occurred_at + interval '7 days')
  from sends s
),
per_buyer as (
  select k.workspace_id, k.buyer_id, count(*)::int as touches, count(*) filter (where k.answered)::int as answered
  from counted k
  join public.buyers b on b.id = k.buyer_id and b.workspace_id = k.workspace_id
  group by k.workspace_id, k.buyer_id
),
facts as (
  select p.*,
    round(100.0 * p.answered / p.touches)::int as rate,
    (select count(*) from public.offers o where o.buyer_id = p.buyer_id)::int as offers,
    (select count(*) from public.deals d where d.buyer_id = p.buyer_id and d.stage ~* 'closed')::int as closed,
    (select floor(extract(epoch from (now() - max(a.occurred_at))) / 86400)::int from answer a where a.buyer_id = p.buyer_id) as days_since_reply
  from per_buyer p
)
insert into public.buyer_scores as s (buyer_id, workspace_id, response_rate, score, reason, source, model, stats, computed_at)
select f.buyer_id, f.workspace_id, f.rate,
  least(100, greatest(0, round(
    f.rate * 0.4 + least(f.offers, 5) * 5 + least(f.closed, 3) * (25.0 / 3)
    + case when f.days_since_reply is null then 0 when f.days_since_reply <= 30 then 10 when f.days_since_reply <= 90 then 5 else 0 end
  )))::int,
  'Answered ' || f.answered || ' of ' || f.touches || ' touches'
    || case when f.offers > 0 then ', ' || f.offers || ' offer' || case when f.offers = 1 then '' else 's' end else '' end
    || case when f.closed > 0 then ', ' || f.closed || ' closed deal' || case when f.closed = 1 then '' else 's' end else '' end
    || '.',
  'rule', null,
  jsonb_build_object('touches', f.touches, 'answered', f.answered, 'offers', f.offers, 'closed', f.closed,
    'days_since_reply', f.days_since_reply, 'backfill', 247),
  now() - interval '2 days'
from facts f
on conflict (buyer_id) do update
  set response_rate = excluded.response_rate,
      stats = s.stats || excluded.stats,
      source = 'rule',
      computed_at = least(s.computed_at, excluded.computed_at)
  where s.response_rate is null
     or coalesce((s.stats ->> 'touches')::int, 0) < (excluded.stats ->> 'touches')::int;
