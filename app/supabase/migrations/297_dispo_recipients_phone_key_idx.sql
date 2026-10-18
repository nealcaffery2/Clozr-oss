-- dispo_after_inbound (296): an inbound text finds its campaign recipient by phone_key.
create index concurrently if not exists dispo_recipients_phone_key_idx
  on public.dispo_campaign_recipients (workspace_id, phone_key);
