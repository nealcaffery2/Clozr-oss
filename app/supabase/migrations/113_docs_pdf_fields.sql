-- 113 · Clozr Docs: fields on uploaded PDFs, and form fillers (docs/esign spec, phase 2)
--
-- A template or a one-off contract can be an uploaded PDF (a TREC form, a
-- county form) with fields placed on its pages: signature, initials, date
-- signed, text, number, currency, date, checkbox, dropdown. Each field
-- belongs to one recipient role and may be bound to a Clozr Docs variable
-- (deal.purchase_price …), which pre-fills it read-only.
--
-- Coordinates: page is 1-based; x, y, w, h are fractions (0..1) of the page
-- as displayed (its /Rotate applied), measured from the top-left corner. The
-- same numbers work at any zoom; the flattener maps them back to PDF points
-- (supabase/functions/_shared/pdf-fields.ts, toPdfPoint).
--
-- A form filler (recipient_type 'filler') fills in their fields and presses
-- Done: status 'filled', filled_at. They take a turn like a signer but never
-- sign and are listed on the certificate as a form filler, not a signatory.

-- ---------------------------------------------------------------- modes
alter table public.doc_templates
  add column if not exists mode text not null default 'richtext',
  add column if not exists pdf_path text;          -- doc-sources/ws/<ws>/templates/<file>.pdf
alter table public.doc_templates drop constraint if exists doc_templates_mode_chk;
alter table public.doc_templates add constraint doc_templates_mode_chk check (mode in ('richtext', 'pdf'));

alter table public.contracts
  add column if not exists mode text not null default 'richtext',
  add column if not exists source_pdf_path text;   -- contracts/ws/<ws>/<id>/source.pdf: the untouched original the fields sit on
alter table public.contracts drop constraint if exists contracts_mode_chk;
alter table public.contracts add constraint contracts_mode_chk check (mode in ('richtext', 'pdf'));

-- ---------------------------------------------------------------- fillers
alter table public.contract_signers add column if not exists filled_at timestamptz;
-- 'filled' is a form filler who pressed Done. 'approved' is kept allowed here
-- too so this constraint and the approvals migration do not undo each other.
alter table public.contract_signers drop constraint if exists contract_signers_status_check;
alter table public.contract_signers add constraint contract_signers_status_check
  check (status in ('pending', 'viewed', 'signed', 'declined', 'filled', 'approved'));

-- ---------------------------------------------------------------- template fields
create table if not exists public.doc_template_fields (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  template_id   bigint not null references public.doc_templates(id) on delete cascade,
  role          text not null,                     -- doc_templates.signers[].role
  type          text not null,
  page          int not null,
  x             double precision not null,
  y             double precision not null,
  w             double precision not null,
  h             double precision not null,
  required      boolean not null default false,
  read_only     boolean not null default false,
  label         text,
  default_value text,
  variable_key  text,                              -- doc-vars key; pre-fills and locks the field
  anchor_text   text,
  options       jsonb,                             -- dropdown choices: ["Cash", "Conventional"]
  validation    jsonb,                             -- { min, max, maxLength }
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint doc_template_fields_type_chk check (type in ('signature', 'initials', 'date_signed', 'text', 'number', 'currency', 'date', 'checkbox', 'dropdown')),
  constraint doc_template_fields_box_chk check (page >= 1 and x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= 1.000001 and y + h <= 1.000001)
);
create index if not exists doc_template_fields_template_idx on public.doc_template_fields (template_id, page, sort);
alter table public.doc_template_fields enable row level security;
-- Same rule as doc_templates: members read, owners and admins write, and a
-- field can only sit on a template of its own workspace.
drop policy if exists doc_template_fields_select on public.doc_template_fields;
create policy doc_template_fields_select on public.doc_template_fields for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists doc_template_fields_write on public.doc_template_fields;
create policy doc_template_fields_write on public.doc_template_fields for all
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin')
    and exists (select 1 from public.doc_templates t where t.id = template_id and t.workspace_id = doc_template_fields.workspace_id));
grant select, insert, update, delete on public.doc_template_fields to authenticated;
drop trigger if exists doc_template_fields_touch on public.doc_template_fields;
create trigger doc_template_fields_touch before update on public.doc_template_fields for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- contract fields
create table if not exists public.contract_fields (
  id                bigint generated always as identity primary key,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  contract_id       bigint not null references public.contracts(id) on delete cascade,
  signer_id         bigint not null references public.contract_signers(id) on delete cascade,
  template_field_id bigint references public.doc_template_fields(id) on delete set null,
  type              text not null,
  page              int not null,
  x                 double precision not null,
  y                 double precision not null,
  w                 double precision not null,
  h                 double precision not null,
  required          boolean not null default false,
  read_only         boolean not null default false,
  label             text,
  default_value     text,
  variable_key      text,
  options           jsonb,
  validation        jsonb,
  sort              int not null default 0,
  value             text,                          -- canonical; see pdf-fields.ts
  filled_at         timestamptz,
  filled_ip         text,
  filled_by         bigint references public.contract_signers(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint contract_fields_type_chk check (type in ('signature', 'initials', 'date_signed', 'text', 'number', 'currency', 'date', 'checkbox', 'dropdown')),
  constraint contract_fields_box_chk check (page >= 1 and x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= 1.000001 and y + h <= 1.000001)
);
create index if not exists contract_fields_contract_idx on public.contract_fields (contract_id, page, sort);
create index if not exists contract_fields_signer_idx on public.contract_fields (signer_id);
alter table public.contract_fields enable row level security;
-- Like contract_signers: members read; writes only through the contracts and
-- esign functions (service role), which check draft status, owner and type.
drop policy if exists contract_fields_select on public.contract_fields;
create policy contract_fields_select on public.contract_fields for select using (public.is_workspace_member(workspace_id));
grant select on public.contract_fields to authenticated;
drop trigger if exists contract_fields_touch on public.contract_fields;
create trigger contract_fields_touch before update on public.contract_fields for each row execute function public.touch_updated_at();

-- A completed contract's filled values are part of the record: no edits, no
-- new fields, no deletes (except by deleting the contract itself, where the
-- cascade runs after the contract row is gone — same rule as contract_events).
create or replace function public.contract_fields_lock_completed() returns trigger
language plpgsql set search_path = public as $$
declare cid bigint;
begin
  if tg_op = 'DELETE' then cid := old.contract_id; else cid := new.contract_id; end if;
  if exists (select 1 from public.contracts c where c.id = cid and c.status = 'completed') then
    if tg_op = 'UPDATE' and new is not distinct from old then return new; end if;
    raise exception 'contract % is completed; its field values are locked', cid;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists contract_fields_lock_completed on public.contract_fields;
create trigger contract_fields_lock_completed before insert or update or delete on public.contract_fields
  for each row execute function public.contract_fields_lock_completed();
revoke execute on function public.contract_fields_lock_completed() from public, anon, authenticated;

-- The original a PDF contract was signed on is part of the record too.
-- (contracts_lock_completed from 112 already covers body_md, tokens, pdf_path
-- and final_sha256; this adds the PDF-mode columns without redefining it.)
create or replace function public.contracts_lock_completed_pdf() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'completed' and (
       new.mode is distinct from old.mode
    or new.source_pdf_path is distinct from old.source_pdf_path
  ) then
    raise exception 'contract % is completed; its source PDF is locked', old.id;
  end if;
  return new;
end $$;
drop trigger if exists contracts_lock_completed_pdf on public.contracts;
create trigger contracts_lock_completed_pdf before update on public.contracts
  for each row execute function public.contracts_lock_completed_pdf();
revoke execute on function public.contracts_lock_completed_pdf() from public, anon, authenticated;

-- ---------------------------------------------------------------- storage
-- Uploaded source PDFs, private, one folder per workspace:
--   doc-sources/ws/<workspace_id>/templates/<file>.pdf   (PDF templates)
--   doc-sources/ws/<workspace_id>/uploads/<file>.pdf     (one-off contracts)
-- Members read their workspace's folder; roles that send contracts upload.
-- When a contract is created the functions copy the file into the contracts
-- bucket, so editing or deleting a template never changes a sent document.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('doc-sources', 'doc-sources', false, 26214400, array['application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists doc_sources_read on storage.objects';
    execute $p$create policy doc_sources_read on storage.objects for select to authenticated
      using (bucket_id = 'doc-sources' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
    execute 'drop policy if exists doc_sources_write on storage.objects';
    execute $p$create policy doc_sources_write on storage.objects for insert to authenticated
      with check (bucket_id = 'doc-sources' and split_part(name, '/', 1) = 'ws'
             and public.has_role(nullif(split_part(name, '/', 2), '')::bigint, 'owner', 'admin', 'acquisitions', 'dispositions', 'tc'))$p$;
    execute 'drop policy if exists doc_sources_delete on storage.objects';
    execute $p$create policy doc_sources_delete on storage.objects for delete to authenticated
      using (bucket_id = 'doc-sources' and split_part(name, '/', 1) = 'ws'
             and public.has_role(nullif(split_part(name, '/', 2), '')::bigint, 'owner', 'admin'))$p$;
  end if;
end $$;
