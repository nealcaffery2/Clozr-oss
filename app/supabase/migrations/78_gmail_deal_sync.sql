-- Every email about a deal, on the deal.
--
-- The Gmail pull (_shared/google.ts pullGmail) used to search only the 120
-- most recently edited sellers, buyers and vendors, 50 messages a run with no
-- next page, over a window that ended wherever the run started — so mail past
-- the fiftieth, mail with anyone further down the list, and mail from a
-- message Gmail refused to hand over were skipped for good. Only a seller's
-- mail reached a deal; the buyer, the title company and everyone else on the
-- deal (deal_parties) never did, and a send from CLOZR carried no deal at all.
--
-- It now reads everything new in the mailbox by headers, keeps what matches
-- (gmail-match.ts: people, the street in the subject, the thread), and walks
-- the whole address book once per mailbox for history. That walk needs a
-- cursor of its own:
--
--   google_accounts.gmail_backfill_cursor
--       "updated_at|kind|id" of the last contact whose history this mailbox
--       has been searched for. Contacts are walked in that order, a hundred
--       addresses a run, so a large book is covered over a few runs of the
--       five-minute schedule (migration 71), and a contact added or edited —
--       an email typed onto a seller, a title company put on a deal — sorts
--       after the cursor and has its last 180 days pulled on the next run.
--       Null: not started. Service role only, like sync_token; not granted
--       to members, who have no use for it.
--
-- The communications columns below are what the pull has always written.
-- They are declared here, `if not exists`, because the migration that made
-- the table predates this folder; on the live project they are a no-op.

alter table public.google_accounts
  add column if not exists gmail_backfill_cursor text;

alter table public.communications
  add column if not exists deal_id     bigint references public.deals(id) on delete set null,
  add column if not exists property_id bigint references public.properties(id) on delete set null,
  add column if not exists vendor_id   bigint references public.vendors(id) on delete set null;

-- A deal's email, newest first, for the deal screen; and the rows the relink
-- pass scans each run (email still waiting for a deal).
create index if not exists communications_deal_email_idx
  on public.communications (deal_id, occurred_at desc) where channel = 'email' and deal_id is not null;
create index if not exists communications_email_undealt_idx
  on public.communications (workspace_id, occurred_at desc) where channel = 'email' and deal_id is null;
