-- No-answer overflow: Talkr tells us (call.overflow on the Talkr webhook) that a
-- caller who rang a rep's line and got no answer is being dialled on to an AI
-- agent's line. /personalize reads the row so the agent knows whose call it is
-- picking up (docs/voice-agent.md, "Picking up for reps"). Service role only.
create table if not exists public.voice_agent_overflow (
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  caller_key    text not null,
  line_key      text not null,
  rep_id        uuid references auth.users(id) on delete set null,
  rep_line      text,
  talkr_call_id text,
  reason        text,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, caller_key, line_key)
);

alter table public.voice_agent_overflow enable row level security;
