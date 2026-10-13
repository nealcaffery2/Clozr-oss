-- 138: offer statuses the app actually writes, and the default PSA.
--
-- offers_status_chk (from the base schema, not a migration here) allows only
-- lowercase draft / received / submitted / countered / accepted / rejected /
-- killed / expired / withdrawn. Generate offer writes 'Draft' / 'Sent', the
-- buyer desk 'Submitted' / 'Accepted', so every one of those inserts failed
-- with offers_status_chk. The check is now case-insensitive and adds the
-- words the app uses ('sent', 'declined', 'pending'); every value the old
-- check allowed still passes, so no row is rewritten.
--
-- The plain-English system PSA ('psa') was a stand-in. The default is the
-- TREC One to Four Family Residential Contract seeded as 'trec_1_4' (75), so
-- the stand-in goes inactive and New contract lists Cash Offer Letter, then
-- TREC. Contracts already made from it keep their template_id and text.

alter table public.offers drop constraint if exists offers_status_chk;
alter table public.offers add constraint offers_status_chk check (
  lower(status) in (
    'draft', 'sent', 'received', 'submitted', 'pending', 'countered',
    'accepted', 'declined', 'rejected', 'killed', 'expired', 'withdrawn'
  )
);

update public.doc_templates
   set active = false,
       name = 'Agreement to Buy and Sell (retired — use TREC 1-4)'
 where workspace_id is null and key = 'psa' and active;
