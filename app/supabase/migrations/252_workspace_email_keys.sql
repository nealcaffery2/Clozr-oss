-- 252: email credentials per workspace, and domains that can be switched off.
--
-- Each workspace sends buyer blasts with its own Resend account and reads its
-- own InboxKit mailboxes, instead of the project's one global key:
--
--   deliverability_secrets.resend_key             Resend API key (full access, so
--                                                 CLOZR can add and verify the blast domain)
--   deliverability_secrets.resend_webhook_secret  that Resend account's webhook signing secret
--   deliverability_secrets.inboxkit_key           InboxKit API key (mailbox health, cold DNS)
--
-- All three are sealed (AES-GCM) by the edge function, like mailreach_key.
-- The Instantly key already lives per workspace in cold_warmup_secrets.api_key
-- (166) and is reused. The blast sender itself is workspaces.settings.blast_from
-- ("Your Company <deals@deals.example.com>"), no column needed. A workspace with
-- nothing set keeps the project secrets (RESEND_API_KEY, MAIL_FROM_BLASTS,
-- INBOXKIT_API_KEY), so it sends exactly as before.
--
-- mailreach_key is no longer read (MailReach is gone from the app). The column
-- and its data stay.
--
-- email_domains.active: false hides a domain from Settings, Postmaster and the
-- blast rotation without deleting its checks. "Remove" in Settings now sets it
-- false; adding the domain again sets it true.

alter table public.deliverability_secrets
  add column if not exists resend_key            text,
  add column if not exists resend_webhook_secret text,
  add column if not exists inboxkit_key          text;

comment on column public.deliverability_secrets.mailreach_key is 'Unused since 252 (MailReach removed). Kept, not dropped.';
comment on column public.deliverability_secrets.resend_key is 'Sealed Resend API key for this workspace''s blasts. Null: the project RESEND_API_KEY.';
comment on column public.deliverability_secrets.resend_webhook_secret is 'Sealed signing secret of this workspace''s Resend webhook.';
comment on column public.deliverability_secrets.inboxkit_key is 'Sealed InboxKit API key. Null: the project INBOXKIT_API_KEY.';

alter table public.email_domains
  add column if not exists active boolean not null default true;

comment on column public.email_domains.active is 'False: switched off (removed in Settings, or not this workspace''s). Kept, not deleted.';

notify pgrst, 'reload schema';
