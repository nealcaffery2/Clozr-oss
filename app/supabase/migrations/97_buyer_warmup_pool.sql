-- 97 — Buyer mail rotates across a warm-up pool.
--
-- A new mailbox and a new blast address start at 50 a day (was 20 for Gmail
-- and 30 for Resend) and still climb 20% a day, capped by daily_cap and
-- ramp_target. Buyer campaigns rotate across every address that has room
-- instead of pinning one sender until it is full and stopping.
--
-- email_senders used to allow one Resend row per workspace. Owner, admin and
-- dispositions reps each get a from-address on the blast domain
-- (rep1@deals.example.com), with reply_to set to their real inbox.
-- The rows are created by ensureRepBlastSenders when Resend is configured.
-- This migration only makes that possible and starts the ramp for mailboxes
-- that have never had settings.

alter table public.mailbox_settings alter column ramp_start set default 50;
alter table public.email_senders alter column ramp_start set default 50;

alter table public.email_senders
  add column if not exists reply_to text,
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.email_senders drop constraint if exists email_senders_workspace_id_provider_key;

create unique index if not exists email_senders_workspace_from_idx
  on public.email_senders (workspace_id, from_email);

-- Mailboxes that have been sending with no settings row start their warm-up
-- today, at 50, rather than inheriting the connect date and jumping to the cap.
insert into public.mailbox_settings (account_id, workspace_id, ramp_enabled, ramp_start, ramp_started_on)
select g.id, g.workspace_id, true, 50, current_date
from public.google_accounts g
where not exists (select 1 from public.mailbox_settings m where m.account_id = g.id);

-- (The hosted product also seeded one primary blast address for its own
-- workspace here. A workspace adds its blast sender in Settings.)
