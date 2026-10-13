-- google-sync was dying on CPU Time exceeded (edge status 546) because an
-- earlier unbounded calendar pull had expanded recurring meetings decades
-- out and left the rows in appointments. Every later pass then spent its
-- whole CPU budget looking those events up one by one, never finished, never
-- wrote a fresh syncToken for the member's primary feed, and the next pass
-- started the same full read over again.
--
-- The function now bounds every pull (see google-sync/calendar.ts
-- PULL_FORWARD_DAYS = 400) and skips anything outside the window. This
-- migration clears the junk already stored and resets every feed cursor so
-- the next run is a bounded full read that can actually complete.

-- Far-future mirrors only. Rows CLOZR created and pushed (source != 'google')
-- are left alone even if someone booked something a year out on purpose.
delete from public.appointments
where source = 'google'
  and starts_at > (now() + interval '400 days');

-- Force every feed through a bounded full read on the next sync. An unbounded
-- syncToken (minted before timeMax existed) is what kept reintroducing the
-- far-future instances above.
update public.google_calendar_feeds
set sync_token = null,
    last_full_sync_at = null,
    last_error = null;

update public.google_accounts
set sync_token = null
where sync_token is not null;
