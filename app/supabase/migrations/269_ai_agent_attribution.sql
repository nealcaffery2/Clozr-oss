-- 269 · Which AI agent sent it: the agent's name and picture on the activity log.
--
-- Until now a text, email, ringless voicemail or call an AI agent sent was
-- filed under the rep it went out as (rep_id), and the agent's own line on the
-- timeline (activity kind 'ai_agent') had no actor, so the record showed a rep's
-- face on the message and a grey "AA" tile beside it. Each row now names the
-- agent (voice_agent_settings.agent_key), and the seller and buyer activity
-- logs show that agent's name and avatar_url (migration 123).
--
--   communications.ai_agent_key  the agent that sent this text, email, voicemail
--                                or call. Written by ai-agent (texts, emails),
--                                rvm-tick (voicemails, from the drop) and
--                                voice-agent (calls).
--   activity.ai_agent_key        the agent behind an 'ai_agent' timeline line.
--   rvm_drops.ai_agent_key       the agent that queued the drop, so rvm-tick can
--                                carry it onto the voicemail's communications row.
--
-- Backfill: messages the agent ledger links (ai_agent_actions.communication_id,
-- its rvm_drop_id), AI calls by conversation (voice_agent_calls), and 'ai_agent'
-- lines whose title names the agent ("AI agent Riley sent a text").
-- Idempotent: only rows still without an agent are touched.

alter table public.communications add column if not exists ai_agent_key text;
alter table public.activity       add column if not exists ai_agent_key text;
alter table public.rvm_drops      add column if not exists ai_agent_key text;

-- Texts and emails the ledger points at.
update public.communications c
   set ai_agent_key = a.agent_key
  from public.ai_agent_actions a
 where a.communication_id = c.id
   and a.workspace_id = c.workspace_id
   and a.agent_key <> 'unassigned'
   and c.ai_agent_key is null;

-- Voicemails: the ledger's drop id, the drop's communications row (rvm:<id>).
update public.rvm_drops d
   set ai_agent_key = a.agent_key
  from public.ai_agent_actions a
 where a.action = 'rvm_sent'
   and a.status = 'done'
   and a.workspace_id = d.workspace_id
   and (a.detail->>'rvm_drop_id') ~ '^[0-9]+$'
   and (a.detail->>'rvm_drop_id')::bigint = d.id
   and d.ai_agent_key is null;

update public.communications c
   set ai_agent_key = d.ai_agent_key
  from public.rvm_drops d
 where c.source = 'rvm'
   and c.source_id = 'rvm:' || d.id
   and c.workspace_id = d.workspace_id
   and d.ai_agent_key is not null
   and c.ai_agent_key is null;

-- AI calls: one voice_agent_calls row per ElevenLabs conversation (el:<id>).
update public.communications c
   set ai_agent_key = v.agent_key
  from public.voice_agent_calls v
 where c.source = 'elevenlabs'
   and c.source_id = 'el:' || v.conversation_id
   and c.workspace_id = v.workspace_id
   and v.agent_key <> 'unassigned'
   and c.ai_agent_key is null;

-- Timeline lines: "AI agent <name> …", matched to the workspace's agent by name.
update public.activity t
   set ai_agent_key = s.agent_key
  from public.voice_agent_settings s
 where t.kind = 'ai_agent'
   and t.ai_agent_key is null
   and s.workspace_id = t.workspace_id
   and coalesce(nullif(s.name, ''), s.live_settings->'identity'->>'name', s.settings->'identity'->>'name') <> ''
   and starts_with(t.title, 'AI agent ' || coalesce(nullif(s.name, ''), s.live_settings->'identity'->>'name', s.settings->'identity'->>'name') || ' ');
