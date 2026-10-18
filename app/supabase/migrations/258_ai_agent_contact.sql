-- How the AI agent opens a call on a record: a first call (a new lead or a cold
-- call, they have never talked with us) or a follow-up (we already know it's
-- them). The rep picks it when switching the agent on; null lets the agent
-- decide from the record's history. Read by ai-agent and the opener in
-- _shared/voice-agent.ts. Additive, safe to re-run.

alter table public.ai_agent_enrollments
  add column if not exists contact text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_agent_enrollments_contact_check') then
    alter table public.ai_agent_enrollments
      add constraint ai_agent_enrollments_contact_check check (contact is null or contact in ('first', 'known'));
  end if;
end $$;
