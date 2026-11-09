-- 393: the owner can switch a Compr workspace to outreach without consent.
--
-- Compr's channel gate (compr-agent.ts channelGate) and the ringless
-- voicemail gate (rvm-tick comprConsentNeeded) refused calls, voicemail and
-- texts to a cold number: nobody who had not opted in or replied. The owner
-- took on that risk after attorney review (the plan setting
-- text_without_consent covered plan texts only). With this timestamp set,
-- the AI agent calls and texts cold numbers and voicemail drops go to them;
-- an opt-out still stops everything. Set it with a note saying who and why.
-- Safe to re-run.
alter table public.compr_agent_settings
  add column if not exists outreach_without_consent_at timestamptz,
  add column if not exists outreach_without_consent_note text;
