-- 107: remember how an email's deal was chosen, so routing can follow the deals.
--
-- The Gmail sync only ever filled an empty deal_id, so mail filed on the
-- seller's latest deal stayed there after the right deal was opened or its
-- address corrected. To move mail safely the sync has to know which rows it
-- filed itself: 'rule' (gmail-match.ts), 'ai' (the classifier fallback in
-- gmail-ai.ts) or 'manual' (a person used File under). Only 'rule' and 'ai'
-- rows are ever re-routed. Rows filed before this migration stay null and are
-- treated like hand-filed ones: nobody can tell which they were.

alter table public.communications
  add column if not exists deal_routed_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'communications_deal_routed_by_check') then
    alter table public.communications
      add constraint communications_deal_routed_by_check check (deal_routed_by in ('rule', 'ai', 'manual'));
  end if;
end $$;

-- The relink pass reads recent unfiled or machine-filed mail per workspace.
create index if not exists communications_email_routing_idx
  on public.communications (workspace_id, occurred_at desc)
  where channel = 'email' and (deal_id is null or deal_routed_by in ('rule', 'ai'));
