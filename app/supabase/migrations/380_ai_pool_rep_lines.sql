-- 380: AI caller numbers that now belong to reps leave the AI pools.
-- Each AI agent keeps one dedicated number (Riley San Antonio, Jordan Houston,
-- Avery Dallas-Fort Worth, Cody Atlanta). The rest are texting and calling
-- lines for Alex, Morgan and Riley in Talkr, so a callback rings the rep,
-- not the AI. A row left here would be re-wired to ElevenLabs on the next
-- Publish (voice-agent-admin wire_numbers), so the rows go.
delete from public.voice_agent_numbers
where phone_number in (
  '+14045552738', '+18645558051',                 -- Alex (Acme Homes pool)
  '+15125555937', '+14055559848',                 -- Morgan
  '+19015556870', '+12055559700', '+13145550925', -- Riley
  '+18645551187', '+18435552168', '+18435551357', '+18135555559',
  '+18035556335', '+18035558891', '+16155558124'  -- Alex (Compr pool)
);
