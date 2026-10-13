-- 124: one AI agent hands a record to the next.
--
-- Migration 123 put one agent on a record at a time. This lets an agent pass
-- the record on when its stage is done, so a seller can go Lead manager →
-- Acquisitions without anyone switching agents by hand and without two
-- agents ever texting the same person at once.
--
-- voice_agent_settings.handoff_to  the agent this one hands to (same
--                                  workspace; null = it hands to a person,
--                                  as before). Deleting that agent clears it.
-- voice_agent_settings.handoff_on  when: 'ready' (the agent judges the person
--                                  ready for the next stage) and/or
--                                  'qualified' (a seller's motivation,
--                                  timeline and condition are on file after
--                                  the agent has made at least one touch).
-- ai_agent_enrollments.relayed_from  the agents that already worked this run,
--                                  oldest first, so a hand-off never loops
--                                  back to one of them.
--
-- Existing workspaces: a Lead manager is pointed at the workspace's
-- Acquisitions agent when there is exactly one, so the pair works out of the
-- box. The guard from migration 123 re-checks the audience when the agent on
-- a running record changes, so a hand-off can never land on an agent that
-- does not work that kind of record.
-- Idempotent.

alter table public.voice_agent_settings
  add column if not exists handoff_to text,
  add column if not exists handoff_on text[] not null default '{ready,qualified}';

alter table public.voice_agent_settings drop constraint if exists voice_agent_settings_handoff_on_check;
alter table public.voice_agent_settings add constraint voice_agent_settings_handoff_on_check
  check (handoff_on <@ array['ready', 'qualified']::text[]);

alter table public.voice_agent_settings drop constraint if exists voice_agent_settings_handoff_not_self;
alter table public.voice_agent_settings add constraint voice_agent_settings_handoff_not_self
  check (handoff_to is null or handoff_to <> agent_key);

-- The agent handed to lives in the same workspace; deleting it clears the pointer only.
alter table public.voice_agent_settings drop constraint if exists voice_agent_settings_handoff_to_fkey;
alter table public.voice_agent_settings add constraint voice_agent_settings_handoff_to_fkey
  foreign key (workspace_id, handoff_to) references public.voice_agent_settings (workspace_id, agent_key)
  on delete set null (handoff_to);

alter table public.ai_agent_enrollments
  add column if not exists relayed_from text[] not null default '{}';

-- Lead manager → Acquisitions where a workspace has exactly one of each.
update public.voice_agent_settings lm
   set handoff_to = acq.agent_key
  from (
    select workspace_id, min(agent_key) as agent_key
      from public.voice_agent_settings
     where role = 'acquisitions'
     group by workspace_id
    having count(*) = 1
  ) acq
 where lm.workspace_id = acq.workspace_id
   and lm.role = 'lead_manager'
   and lm.handoff_to is null;
