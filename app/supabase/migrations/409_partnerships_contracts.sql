-- 409: the partnerships role sends and works contracts like the deal roles.
--
-- Drew Collins (Head of Partnerships, Acme Homes) sends contracts. The role was
-- left out of contract writes when it was made (263 keeps partners off seller
-- lists; that stays). Now in: contracts (create, edit, send, void), contract
-- folders (doc_folders scope 'contracts') and filled forms (doc_forms). The
-- contracts, pandadoc, docs-plus and docs-extract functions take the role the
-- same way. The contract template library stays owner and admin, as for every
-- other role.
--
-- Safe to re-run.

drop policy if exists contracts_write on public.contracts;
create policy contracts_write on public.contracts for all
  using (workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships'])))
  with check (workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships'])));

drop policy if exists doc_folders_write on public.doc_folders;
create policy doc_folders_write on public.doc_folders for all
  using (case when scope = 'contracts'
    then workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships']))
    else workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin'])) end)
  with check (case when scope = 'contracts'
    then workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships']))
    else workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin'])) end);

drop policy if exists doc_forms_write on public.doc_forms;
create policy doc_forms_write on public.doc_forms for all to authenticated
  using (workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships'])))
  with check (workspace_id in (select my_role_workspace_ids(variadic array['owner', 'admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships']))
    and exists (select 1 from public.doc_templates t where t.id = doc_forms.template_id and (t.workspace_id = doc_forms.workspace_id or t.workspace_id is null)));
