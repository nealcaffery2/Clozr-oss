-- dispo_after_inbound (296): an inbound email finds its campaign recipient.
-- The trigger matches r.email = lower(from_email) and recipients are stored
-- lowercased (nullif(lower(b.email), '')), so the plain column is indexed.
create index concurrently if not exists dispo_recipients_email_idx
  on public.dispo_campaign_recipients (workspace_id, email);
