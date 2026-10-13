-- 199: a deal moved to Closed keeps its real close date.
--
-- deals_stage_before stamped closed_on with today whenever a deal entered
-- Closed without one. The Podio import (2026-10-04/05) moved months-old
-- closings into Closed, so they all "closed" this month: Reporting showed 19
-- October closings when most closed between February and July. Now a deal
-- entering Closed with no closed_on takes its close_date when that date has
-- passed, and today only when there is none (or it is still ahead).
--
-- Backfill: the 14 deals the import stamped (closed_on 2026-10-04 or -05,
-- source podio, a close_date more than a week earlier) get closed_on =
-- close_date. Deals closed by hand on those days have no older close_date and
-- are untouched. Safe to run again.

CREATE OR REPLACE FUNCTION public.deals_stage_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.stage := public.normalize_deal_stage(new.stage);
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    if tg_op = 'UPDATE' then new.stage_entered_at := now(); end if;
    if new.stage = 'Under Contract Seller' and new.contract_date is null then new.contract_date := current_date; end if;
    if new.stage = 'Ready To Market' and new.marketing_started_on is null then new.marketing_started_on := current_date; end if;
    -- Migration 199: a close date already past is when it closed, not today.
    if new.stage = 'Closed' and new.closed_on is null then
      new.closed_on := case when new.close_date is not null and new.close_date <= current_date then new.close_date else current_date end;
    end if;
    if new.stage = 'Terminated' then
      new.terminated := true;
      if new.terminated_on is null then new.terminated_on := current_date; end if;
      -- Migration 118: a terminated deal goes to the archive.
      if new.archived_at is null then new.archived_at := now(); new.archived_reason := 'Terminated'; end if;
    elsif tg_op = 'UPDATE' and old.stage = 'Terminated' and new.archived_reason = 'Terminated' then
      -- Brought back from Terminated: it was archived for that, so it comes back too.
      new.archived_at := null; new.archived_reason := null;
    end if;
  end if;
  return new;
end $function$;

update public.deals
   set closed_on = close_date
 where source = 'podio'
   and closed_on between date '2026-10-04' and date '2026-10-05'
   and close_date is not null
   and close_date < closed_on - 7;
