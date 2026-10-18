-- 320: email reads stop calling can_read_email() on every row. Same rows visible.
--
-- For a member who is not owner, admin or tc, communications_read (151) called
-- can_read_email(workspace_id, id) on every email row a read passed, about
-- 0.45 ms a row (most of it has_role -> member_role, three nested definer
-- calls): 343 ms for a rep's newest 500 emails, 646 ms for the reporting read.
--
-- can_read_email(ws, id) is true when (a) the caller is owner/admin/tc of ws,
-- (b) a mailbox row of the caller holds the email, or (c) no mailbox holds it
-- and it is not a Gmail row. The policy already had (a) as an initplan
-- (my_email_admin_workspace_ids). Now:
--   (b) is an initplan too: my_mailbox_communication_ids(), the caller's
--       mailbox rows, read once per statement;
--   (c) never holds for a Gmail row, so the function is called only for
--       email rows that are not Gmail (cold, resend: a small share), and
--       there its answer is the old answer exactly.
-- One write path differs, and only toward stricter: a signed-in INSERT ...
-- RETURNING of a brand-new Gmail email by a member outside (a) and (b) now
-- fails the read check (the old (c) could not see the uncommitted row and
-- passed it). No client writes Gmail rows; edge functions do, as service role.
-- can_read_email keeps its result; has_role(p_ws, 'owner', 'admin', 'tc') is
-- replaced by the same test on workspace_members (the role is one of the
-- three; "sdr counts as dispositions" never applies to these roles), so the
-- calls that remain (this policy, email_attachments_read, floor_board) do no
-- nested definer calls.
--
-- Proof, on live data, every member of several workspaces (and each of them
-- again as a tc, since no tc existed yet): visible
-- communications under the old and new rule are identical (counts equal, set
-- difference 0 both ways, md5 of the id list equal to what the live policy
-- returns signed in as that user). Only communications_read changes;
-- update and delete keep 151's form (they touch rows by id).
-- Safe to re-run.

create or replace function public.my_mailbox_communication_ids()
returns setof bigint language sql stable security definer set search_path = public, pg_temp as $$
  select m.communication_id from public.communication_mailboxes m where m.user_id = (select auth.uid())
$$;
revoke all on function public.my_mailbox_communication_ids() from public, anon;
grant execute on function public.my_mailbox_communication_ids() to authenticated;

create or replace function public.can_read_email(p_ws bigint, p_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.workspace_members w
                 where w.workspace_id = p_ws and w.user_id = (select auth.uid())
                   and w.role in ('owner', 'admin', 'tc'))
      or exists (select 1 from public.communication_mailboxes m
                 where m.communication_id = p_id and m.user_id = (select auth.uid()))
      or (not exists (select 1 from public.communication_mailboxes m where m.communication_id = p_id)
          and not exists (select 1 from public.communications c where c.id = p_id and c.source = 'gmail'))
$$;

-- ponytail: non-Gmail email rows still pay one definer call each (as cold email
-- grows); a stored mailbox flag on communications removes it if that shows.
alter policy communications_read on public.communications
  using (workspace_id in (select public.my_workspace_ids())
         and (channel is distinct from 'email'
              or workspace_id in (select public.my_email_admin_workspace_ids())
              or id in (select public.my_mailbox_communication_ids())
              or (source is distinct from 'gmail' and public.can_read_email(workspace_id, id))));
