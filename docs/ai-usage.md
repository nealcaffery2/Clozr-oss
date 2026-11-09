# AI usage log

Every Claude call an edge function makes writes one row to `ai_usage`
(migration 425): workspace, feature, model, the four token counts from the
response's `usage` block, and the cost in cents at that day's list price
(`MODEL_PRICES` in `app/supabase/functions/_shared/models.ts`). The write is
`recordUsage()` in `_shared/ai-usage.ts`; it never throws, so a logging
failure cannot fail the feature. A call that errors before a response (401,
429, timeout) writes nothing.

## Reading it

`ai_usage_daily` is a view: one row per workspace, UTC day, feature and model,
with `calls`, token sums and `cost_cents`.

Where the money went in the last 7 days:

```sql
select feature, model, sum(calls) calls, round(sum(cost_cents) / 100, 2) usd
from ai_usage_daily
where day >= current_date - 7
group by 1, 2 order by usd desc;
```

Spend per day, to spot the day it spiked:

```sql
select day, round(sum(cost_cents) / 100, 2) usd, sum(calls) calls
from ai_usage_daily
where day >= current_date - 30
group by 1 order by 1;
```

One feature's calls in the last hour (raw table), to catch a loop:

```sql
select date_trunc('minute', created_at) m, count(*), round(sum(cost_cents) / 100, 2) usd
from ai_usage
where feature = 'lead_memory' and created_at > now() - interval '1 hour'
group by 1 order by 1;
```

## Feature names

| feature | where |
|---|---|
| `ai_agent_next_touch`, `ai_agent_propose_plan`, `ai_agent_draw_avatar` | ai-agent (Cody), one per tool call |
| `lead_memory`, `deal_memory` | lead and deal briefs |
| `call_coach`, `call_profile`, `call_sections`, `call_search` | call review, caller profile, transcript sections and search |
| `reply_suggest`, `record_suggest`, `message_revise`, `draft_template`, `draft_action_plan` | rep-facing drafting |
| `lane_filing`, `lane_listen`, `lane_checkin`, `lane_resources_pdf` | Lane (TC) |
| `gmail_filing` | Gmail deal classifier |
| `ask_clozr`, `clozr_today`, `clozr_focus` | Clozr AI chat and the daily list |
| `dispo_intro`, `buyer_score` | dispo |
| `docs_extract`, `contract_parties` | PDF reads |
| `plan_agent_decide`, `plan_agent_route` | plan agent |
| `roleplay_grade`, `roleplay_seller`, `voice_agent_score`, `sales_manager_weekly` | roleplay and scorecards |
| `records_agent` | web research and photo checks |
| `map_columns` | CSV import mapping |

`workspace_id` is null where the helper has no workspace in scope
(`contract_parties`, `gmail_filing`, `records_agent`,
`lane_resources_pdf`, `map_columns`, `roleplay_grade`, `sales_manager_weekly`,
and the ai-agent tool calls).

## Adding a call site

After the response, one line:

```ts
await recordUsage(admin, { ws, feature: 'my_feature', model: res.model, usage: res.usage });
```

`admin` may be `null`; the helper then builds a service-role client from the
function's env. Add the model to `MODEL_PRICES` when a new one lands, else its
rows log with `cost_cents = 0`.
