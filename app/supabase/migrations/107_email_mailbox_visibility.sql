-- 106: a rep reads their own mailbox; TC, admin and owner read the workspace's.
--
-- communications_write let every member SELECT every row, so the Email tab's
-- "all" scope was everyone's Gmail for anyone who opened it, and hiding the
-- mailbox switcher in the UI changed nothing a direct query could not undo.
-- The rule now lives on the row: an email is readable by an owner, admin or
-- TC, by a member whose connected mailbox holds it (communication_mailboxes,
-- migration 82), or by any member when no mailbox holds it at all (a dispo
-- blast or a form notification is the workspace's, not a person's; a Gmail
-- row is never in that class, so one caught between its insert and its
-- mailbox row stays private). Calls,
-- texts and notes keep the plain membership rule.
--
-- Idempotent: every object is dropped or replaced before it is created.

create or replace function public.can_read_email(p_ws bigint, p_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_role(p_ws, 'owner', 'admin', 'tc')
      or exists (select 1 from public.communication_mailboxes m
                 where m.communication_id = p_id and m.user_id = (select auth.uid()))
      or (not exists (select 1 from public.communication_mailboxes m where m.communication_id = p_id)
          and not exists (select 1 from public.communications c where c.id = p_id and c.source = 'gmail'))
$$;
revoke all on function public.can_read_email(bigint, bigint) from public, anon;
grant execute on function public.can_read_email(bigint, bigint) to authenticated;

-- One ALL policy becomes four so the email rule applies to reads, edits and
-- deletes, while an insert still only needs membership.
drop policy if exists communications_write on public.communications;
drop policy if exists communications_read on public.communications;
drop policy if exists communications_insert on public.communications;
drop policy if exists communications_update on public.communications;
drop policy if exists communications_delete on public.communications;

create policy communications_read on public.communications for select to authenticated
  using (public.is_workspace_member(workspace_id)
         and (channel is distinct from 'email' or public.can_read_email(workspace_id, id)));
create policy communications_insert on public.communications for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy communications_update on public.communications for update to authenticated
  using (public.is_workspace_member(workspace_id)
         and (channel is distinct from 'email' or public.can_read_email(workspace_id, id)))
  with check (public.is_workspace_member(workspace_id));
create policy communications_delete on public.communications for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (channel is distinct from 'email' or public.can_read_email(workspace_id, id)));

-- Which mailbox holds a message: your own rows, or all of them for the roles
-- that may open anyone's mailbox.
drop policy if exists communication_mailboxes_read on public.communication_mailboxes;
create policy communication_mailboxes_read on public.communication_mailboxes for select to authenticated
  using (public.is_workspace_member(workspace_id)
         and (user_id = (select auth.uid()) or public.has_role(workspace_id, 'owner', 'admin', 'tc')));

-- A file on an email is as private as the email.
drop policy if exists email_attachments_read on public.email_attachments;
create policy email_attachments_read on public.email_attachments for select to authenticated
  using (public.is_workspace_member(workspace_id) and public.can_read_email(workspace_id, communication_id));

-- TC reads a rep's read state the way an admin does.
drop policy if exists cus_admin_read on public.communication_user_state;
create policy cus_admin_read on public.communication_user_state for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'tc'));
