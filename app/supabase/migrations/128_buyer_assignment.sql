-- 128 · Buyers can be assigned to a teammate.
--
-- Sellers have had assigned_to since migration 20; buyers had no owner, so
-- the Buyers bulk bar could not route a list to a dispositions rep. The
-- People and Buyers "Assign" panel (app/components/bulk/AssignPanel.tsx)
-- writes this column one teammate at a time: all selected to one person, or
-- the selection split into consecutive blocks across several (round robin).
-- The app reads it on its own (lib/crm.ts), so the Buyers list still loads
-- on a database without it. Deleting the user clears the assignment.
-- Writes go through the buyers table's own row security.

alter table public.buyers
  add column if not exists assigned_to uuid references auth.users (id) on delete set null;

create index if not exists buyers_assigned_idx
  on public.buyers (workspace_id, assigned_to)
  where assigned_to is not null;
