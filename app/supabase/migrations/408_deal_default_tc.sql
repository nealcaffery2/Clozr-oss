-- Every live deal has the workspace's TC on its team.
--
-- workspace_tc() (the first 'tc' member, else Casey) was only put on a deal
-- by offer_accepted_to_dispo and submission_into_pipeline. A deal created
-- past Prospect, or moved there on the deal sheet, by Lane or an import, had
-- no TC: 13 of 17 Under Contract Seller deals on 2026-10-23.
--
-- deals_default_tc: after a deal is inserted or changes stage into a live
-- stage (not Prospect, Terminated or Closed) with no TC, it sets tc_rep_id.
-- An UPDATE that names tc_rep_id, so deals_fill_rep_names and deals_team_sync
-- run and the TC lands on the deal team. Only on insert or a stage change, so
-- a TC taken off a deal stays off until its stage moves.
--
-- Then the open deals with no TC get one. Safe to re-run.

create or replace function public.deals_default_tc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tc_rep_id is not null or coalesce(new.stage, 'Prospect') in ('Prospect', 'Terminated', 'Closed') then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return null; end if;
  update public.deals set tc_rep_id = public.workspace_tc(new.workspace_id)
   where id = new.id and tc_rep_id is null and public.workspace_tc(new.workspace_id) is not null;
  return null;
end $$;
revoke all on function public.deals_default_tc() from public, anon, authenticated;

drop trigger if exists deals_default_tc on public.deals;
create trigger deals_default_tc
  after insert or update of stage on public.deals
  for each row execute function public.deals_default_tc();

update public.deals d set tc_rep_id = public.workspace_tc(d.workspace_id)
 where d.tc_rep_id is null and d.archived_at is null
   and coalesce(d.stage, 'Prospect') not in ('Prospect', 'Terminated', 'Closed')
   and public.workspace_tc(d.workspace_id) is not null;
