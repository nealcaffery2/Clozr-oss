-- =============================================================================
-- 179 · Clozr Docs: PandaDoc parity (Oct 2026)
--
-- Extends the existing e-sign module (contracts, contract_signers,
-- contract_fields, contract_events, doc_templates, doc_template_fields,
-- doc_folders, doc_content_blocks, notary_requests). Nothing is dropped and
-- every new column is nullable or defaulted, so the deployed esign, contracts
-- and docs-remind bundles keep working before the new code ships.
--
-- Adds
--   1. Field types: radio, attachment, stamp, formula, email, phone, initials
--      everywhere; radio groups, conditional logic, formulas, anchors.
--   2. Adopt-once signature + initials, signer auth policy, forwarding policy,
--      redirect after signing, revision counter (correct and resend).
--   3. Contract kinds used in PandaDoc but missing here
--      (nda, commission, receipt, ica, referral, participation).
--   4. contract_attachments   signer-uploaded files (PandaDoc "collect files")
--   5. contract_comments      internal + recipient comments per document
--   6. contract_deliveries    per-message delivery tracking (Resend, Talkr)
--   7. contract_revisions     snapshot on every correct-and-resend
--   8. doc_forms              public self-serve links (PandaDoc Forms)
--   9. bulk_sends / items     one template to many recipients
--  10. contract_progress view + docs_stats() for the tracker and reports
--  11. Private storage bucket contract-attachments
-- =============================================================================


-- ---------------------------------------------------------------- 1. fields
alter table public.doc_template_fields drop constraint if exists doc_template_fields_type_chk;
alter table public.doc_template_fields add constraint doc_template_fields_type_chk check (type = any (array[
  'signature','initials','date_signed','text','number','currency','date','checkbox','dropdown',
  'radio','attachment','stamp','formula','email','phone']));
alter table public.contract_fields drop constraint if exists contract_fields_type_chk;
alter table public.contract_fields add constraint contract_fields_type_chk check (type = any (array[
  'signature','initials','date_signed','text','number','currency','date','checkbox','dropdown',
  'radio','attachment','stamp','formula','email','phone']));

-- group_key   radio buttons sharing a key are one question (one value per group);
--             checkboxes sharing a key form a group with validation.min/max checked.
-- conditions  {"all":[{"field":"<field_key>","op":"eq|neq|filled|empty|checked|unchecked|gt|lt","value":"x"}],
--              "action":"show|require"}   evaluated client and server side.
-- formula     "{price} - {fee}" over other fields' field_key / {{variables}}; read only.
-- field_key   stable per-template key so conditions/formulas survive versioning.
-- anchor_text place the field relative to this text on the PDF instead of x/y.
alter table public.doc_template_fields
  add column if not exists field_key text,
  add column if not exists group_key text,
  add column if not exists conditions jsonb,
  add column if not exists formula text,
  add column if not exists anchor_offset jsonb,           -- {"dx":0,"dy":0,"occurrence":"all|first|n"}
  add column if not exists placeholder text,
  add column if not exists font_size numeric;
alter table public.contract_fields
  add column if not exists field_key text,
  add column if not exists group_key text,
  add column if not exists conditions jsonb,
  add column if not exists formula text,
  add column if not exists placeholder text,
  add column if not exists font_size numeric,
  add column if not exists attachment_id bigint;

create index if not exists contract_fields_group_idx on public.contract_fields (contract_id, group_key) where group_key is not null;

-- ------------------------------------------------------- 2. signers/contracts
alter table public.contract_signers
  add column if not exists initials_png text,
  add column if not exists signature_style text,          -- drawn | typed | uploaded
  add column if not exists signature_font text,           -- typed signatures: the font they picked
  add column if not exists adopted_at timestamptz,
  add column if not exists auth_mode text not null default 'link',   -- link | email_code | sms_code
  add column if not exists forwarded_from bigint,
  add column if not exists last_delivery_status text,     -- sent | delivered | opened | bounced | failed | complained
  add column if not exists last_delivery_at timestamptz,
  add column if not exists completed_link_sent_at timestamptz;
alter table public.contract_signers drop constraint if exists contract_signers_auth_mode_chk;
alter table public.contract_signers add constraint contract_signers_auth_mode_chk check (auth_mode in ('link','email_code','sms_code'));

alter table public.contracts
  add column if not exists require_access_code boolean not null default false,
  add column if not exists allow_forwarding boolean not null default true,
  add column if not exists allow_reassign boolean not null default true,
  add column if not exists redirect_url text,
  add column if not exists revision integer not null default 1,
  add column if not exists corrected_at timestamptz,
  add column if not exists expiry_extended_count integer not null default 0,
  add column if not exists bulk_send_id bigint,
  add column if not exists form_id bigint,
  add column if not exists tags text[] not null default '{}',
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists sender_user_id uuid,
  add column if not exists email_subject text;

alter table public.doc_templates
  add column if not exists require_access_code boolean not null default false,
  add column if not exists default_cc jsonb not null default '[]'::jsonb,       -- [{"email","name"}]
  add column if not exists default_message text,
  add column if not exists default_subject text,
  add column if not exists name_pattern text,                                   -- "{{property.address}} PSA 2026"
  add column if not exists tags text[] not null default '{}',
  add column if not exists description text;

-- ------------------------------------------------------------------ 3. kinds
alter table public.doc_templates drop constraint if exists doc_templates_kind_check;
alter table public.doc_templates add constraint doc_templates_kind_check check (kind = any (array[
  'psa','assignment','amendment','termination','option','novation','jv','disclosure','addendum','offer',
  'nda','commission','receipt','ica','referral','participation','other']));
alter table public.contracts drop constraint if exists contracts_kind_check;
alter table public.contracts add constraint contracts_kind_check check (kind = any (array[
  'psa','assignment','amendment','termination','option','novation','jv','disclosure','addendum','offer',
  'nda','commission','receipt','ica','referral','participation','other']));

-- ------------------------------------------------------------ 4. attachments
create table if not exists public.contract_attachments (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  contract_id bigint not null references public.contracts(id) on delete cascade,
  signer_id bigint references public.contract_signers(id) on delete set null,
  field_id bigint references public.contract_fields(id) on delete set null,
  label text,
  storage_path text not null,
  content_type text,
  byte_size bigint,
  sha256 text,
  uploaded_ip text,
  created_at timestamptz not null default now()
);
create index if not exists contract_attachments_contract_idx on public.contract_attachments (contract_id);

-- --------------------------------------------------------------- 5. comments
create table if not exists public.contract_comments (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  contract_id bigint not null references public.contracts(id) on delete cascade,
  parent_id bigint references public.contract_comments(id) on delete cascade,
  author_user_id uuid,
  author_signer_id bigint references public.contract_signers(id) on delete set null,
  internal boolean not null default true,       -- internal notes never reach recipients
  page integer,
  anchor jsonb,                                  -- {"x":0.1,"y":0.2} on the page, optional
  body text not null check (length(btrim(body)) between 1 and 4000),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists contract_comments_contract_idx on public.contract_comments (contract_id, created_at);

-- ------------------------------------------------------------- 6. deliveries
create table if not exists public.contract_deliveries (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  contract_id bigint not null references public.contracts(id) on delete cascade,
  signer_id bigint references public.contract_signers(id) on delete set null,
  channel text not null check (channel in ('email','sms')),
  kind text not null check (kind in ('invite','reminder','turn','code','completed','voided','declined','expiring','corrected')),
  provider text not null,                        -- resend | talkr
  provider_message_id text,
  to_address text,
  status text not null default 'sent' check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained')),
  error text,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contract_deliveries_contract_idx on public.contract_deliveries (contract_id, created_at desc);
create unique index if not exists contract_deliveries_msg_uidx on public.contract_deliveries (provider, provider_message_id) where provider_message_id is not null;

-- -------------------------------------------------------------- 7. revisions
create table if not exists public.contract_revisions (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  contract_id bigint not null references public.contracts(id) on delete cascade,
  revision integer not null,
  reason text,
  body_md text,
  pdf_path text,
  source_pdf_path text,
  sha256 text,
  fields jsonb not null default '[]'::jsonb,
  signers jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (contract_id, revision)
);

-- ------------------------------------------------------------------ 8. forms
create table if not exists public.doc_forms (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  template_id bigint not null references public.doc_templates(id) on delete restrict,
  slug text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  name text not null,
  public_role text not null,                     -- the template role the visitor fills and signs
  fixed_recipients jsonb not null default '[]'::jsonb,   -- [{role,name,email,recipient_type,user_id}] e.g. the company countersigner
  require_email_code boolean not null default true,
  active boolean not null default true,
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz,
  redirect_url text,
  deal_id bigint references public.deals(id) on delete set null,
  intro text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------- 9. bulk send
create table if not exists public.bulk_sends (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  template_id bigint not null references public.doc_templates(id) on delete restrict,
  name text not null,
  message text,
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  total integer not null default 0,
  sent integer not null default 0,
  failed integer not null default 0,
  options jsonb not null default '{}'::jsonb,    -- expires_days, order_mode, reminders, fixed_recipients
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists public.bulk_send_items (
  id bigint generated always as identity primary key,
  bulk_send_id bigint not null references public.bulk_sends(id) on delete cascade,
  workspace_id bigint not null,
  row_index integer not null,
  input jsonb not null,                          -- {recipient:{name,email,phone}, deal_id?, seller_id?, buyer_id?, tokens?:[{name,value}]}
  contract_id bigint references public.contracts(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists bulk_send_items_q on public.bulk_send_items (bulk_send_id, status);

alter table public.contracts drop constraint if exists contracts_bulk_send_fk;
alter table public.contracts add constraint contracts_bulk_send_fk foreign key (bulk_send_id) references public.bulk_sends(id) on delete set null;
alter table public.contracts drop constraint if exists contracts_form_fk;
alter table public.contracts add constraint contracts_form_fk foreign key (form_id) references public.doc_forms(id) on delete set null;

-- ------------------------------------------------------------------ RLS
-- Members read; writes go through edge functions (service role), except
-- comments and forms. Every write checks that the row it points at (contract,
-- template) is in the same workspace, so one workspace cannot plant a
-- comment on, or build a form from, another workspace's document.
alter table public.contract_attachments enable row level security;
alter table public.contract_comments enable row level security;
alter table public.contract_deliveries enable row level security;
alter table public.contract_revisions enable row level security;
alter table public.doc_forms enable row level security;
alter table public.bulk_sends enable row level security;
alter table public.bulk_send_items enable row level security;

drop policy if exists contract_attachments_select on public.contract_attachments;
create policy contract_attachments_select on public.contract_attachments for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists contract_deliveries_select on public.contract_deliveries;
create policy contract_deliveries_select on public.contract_deliveries for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists contract_revisions_select on public.contract_revisions;
create policy contract_revisions_select on public.contract_revisions for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists bulk_sends_select on public.bulk_sends;
create policy bulk_sends_select on public.bulk_sends for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists bulk_send_items_select on public.bulk_send_items;
create policy bulk_send_items_select on public.bulk_send_items for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists contract_comments_select on public.contract_comments;
create policy contract_comments_select on public.contract_comments for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists contract_comments_insert on public.contract_comments;
create policy contract_comments_insert on public.contract_comments for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and author_user_id = auth.uid() and author_signer_id is null
              and exists (select 1 from public.contracts c where c.id = contract_id and c.workspace_id = contract_comments.workspace_id));
drop policy if exists contract_comments_update on public.contract_comments;
create policy contract_comments_update on public.contract_comments for update to authenticated
  using (public.is_workspace_member(workspace_id) and (author_user_id = auth.uid() or public.has_role(workspace_id, 'owner', 'admin')))
  with check (exists (select 1 from public.contracts c where c.id = contract_id and c.workspace_id = contract_comments.workspace_id));

drop policy if exists doc_forms_select on public.doc_forms;
create policy doc_forms_select on public.doc_forms for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists doc_forms_write on public.doc_forms;
create policy doc_forms_write on public.doc_forms for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions', 'tc'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions', 'tc')
              and exists (select 1 from public.doc_templates t where t.id = template_id
                          and (t.workspace_id = doc_forms.workspace_id or t.workspace_id is null)));

-- ------------------------------------------------------------ storage bucket
-- Path: ws/<workspace_id>/<contract_id>/<uuid>-<filename>. Uploads go through
-- docs-public (service role); members read their own workspace's folder.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('contract-attachments', 'contract-attachments', false, 26214400,
            array['application/pdf','image/png','image/jpeg','image/heic','image/webp',
                  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists contract_attachments_read on storage.objects';
    execute $p$create policy contract_attachments_read on storage.objects for select to authenticated
      using (bucket_id = 'contract-attachments' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
  end if;
end $$;

-- ------------------------------------------------- 10. progress + reporting
create or replace view public.contract_progress with (security_invoker = true) as
select c.id as contract_id,
       c.workspace_id,
       c.status,
       count(s.*) filter (where s.recipient_type in ('signer','filler') and s.status <> 'delegated') as to_sign,
       count(s.*) filter (where s.recipient_type in ('signer','filler') and s.status in ('signed','filled')) as signed,
       count(s.*) filter (where s.recipient_type = 'approver' and s.status <> 'delegated') as approvers,
       count(s.*) filter (where s.recipient_type = 'approver' and s.status = 'approved') as approved,
       max(s.signed_at) as last_signed_at,
       sum(coalesce(s.view_seconds,0)) as view_seconds,
       case
         when c.status in ('sent','viewed')
          and count(s.*) filter (where s.recipient_type in ('signer','filler') and s.status in ('signed','filled')) > 0
         then 'partially_signed'
         when c.status in ('sent','viewed') and c.expires_at is not null and c.expires_at < now() then 'expired'
         else c.status
       end as display_status,
       (select string_agg(coalesce(x.label, x.role) || ': ' || coalesce(x.name, x.email, '?'), ', ' order by x.sort)
          from public.contract_signers x
         where x.contract_id = c.id and x.recipient_type in ('signer','filler','approver')
           and x.status not in ('signed','filled','approved','delegated')) as waiting_on
  from public.contracts c
  left join public.contract_signers s on s.contract_id = c.id
 where c.deleted_at is null
 group by c.id;

create or replace function public.docs_stats(p_workspace bigint, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = public as $$
  with c as (
    select * from public.contracts
     where workspace_id = p_workspace and deleted_at is null
       and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'created',     (select count(*) from c),
    'sent',        (select count(*) from c where sent_at is not null),
    'viewed',      (select count(*) from c where viewed_at is not null),
    'completed',   (select count(*) from c where status = 'completed'),
    'declined',    (select count(*) from c where status = 'declined'),
    'expired',     (select count(*) from c where status = 'expired'),
    'voided',      (select count(*) from c where status = 'voided'),
    'median_hours_to_complete', (select round((percentile_cont(0.5) within group (order by extract(epoch from completed_at - sent_at)) / 3600)::numeric, 1)
                                   from c where completed_at is not null and sent_at is not null),
    'value_completed', (select coalesce(sum(value),0) from c where status = 'completed'),
    'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from c group by kind) k),
    'by_sender', (select coalesce(jsonb_object_agg(coalesce(p.full_name, 'unknown'), n), '{}'::jsonb)
                    from (select created_by, count(*) n from c group by created_by) s left join public.profiles p on p.id = s.created_by)
  )
  where is_workspace_member(p_workspace);
$$;

-- updated_at upkeep
create or replace function public.docs_touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists contract_deliveries_touch on public.contract_deliveries;
create trigger contract_deliveries_touch before update on public.contract_deliveries for each row execute function public.docs_touch_updated_at();
drop trigger if exists doc_forms_touch on public.doc_forms;
create trigger doc_forms_touch before update on public.doc_forms for each row execute function public.docs_touch_updated_at();


-- ------------------------------------------- 12. prefill data (replaces the PandaDoc "prefill signer" pattern)
-- Values the TC typed into every PandaDoc PSA / assignment / TREC now live on the deal and resolve as {{deal.*}}.
alter table public.deals
  add column if not exists option_fee numeric,
  add column if not exists option_period_days integer,
  add column if not exists emd_due_days integer,
  add column if not exists special_provisions text,
  add column if not exists tc_fee numeric;
-- TREC agent block ({{rep.acq_license}}); brokerage/supervisor live in workspaces.settings.company.*
alter table public.profiles add column if not exists license_number text;

-- ------------------------------------------------------------ crons
-- docs-remind now also reminds approvers and expires documents stuck awaiting
-- approval, so the kick fires for those too.
create or replace function public.docs_remind_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.contracts where status in ('sent', 'viewed', 'awaiting_approval') and provider = 'clozr') then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/docs-remind',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.docs_remind_kick() from public, anon, authenticated;

-- Bulk send: every minute while a batch has queued rows, docs-plus bulk_tick
-- creates and sends up to 20 more.
create or replace function public.docs_bulk_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.bulk_send_items where status = 'queued') then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/docs-plus',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"bulk_tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.docs_bulk_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'clozr-docs-bulk';
    perform cron.schedule('clozr-docs-bulk', '* * * * *', 'select public.docs_bulk_kick()');
  end if;
end $$;
