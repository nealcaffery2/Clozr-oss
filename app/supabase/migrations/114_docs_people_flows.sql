-- 114 · Clozr Docs people flows (docs/esign spec, "People adding")
--
--   * approvers: internal sign-off before a document goes out. A contract
--     with an approver who has not approved sits in `awaiting_approval`;
--     nobody else gets a link until every approver approves, and a rejection
--     puts it back to draft with the reason
--   * delegation: a signer hands their signature to someone else from the
--     signing page. A new row takes their place (`delegated_from`); the old
--     row is closed as `delegated` and its link stops working
--   * delivery by text: per recipient `delivery` (email · sms · both); the
--     access code can be texted and proven by phone (`phone_verified_at`)
--   * CRM links: a recipient picked from People, Buyers, Vendors or the team
--     keeps the link (`seller_id`, `buyer_id`, `vendor_id`, `user_id`), so the
--     contract shows on that record's Contracts card
--
-- contracts.status is free text; `awaiting_approval` needs no constraint.

-- ---------------------------------------------------------------- signers
alter table public.contract_signers
  add column if not exists delivery text not null default 'email',
  add column if not exists delegated_from bigint references public.contract_signers(id) on delete set null,
  add column if not exists delegated_to bigint references public.contract_signers(id) on delete set null,
  add column if not exists delegated_at timestamptz,
  add column if not exists delegate_reason text,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text,
  add column if not exists phone_verified_at timestamptz,
  add column if not exists seller_id bigint references public.sellers(id) on delete set null,
  add column if not exists buyer_id bigint references public.buyers(id) on delete set null,
  add column if not exists vendor_id bigint references public.vendors(id) on delete set null,
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.contract_signers drop constraint if exists contract_signers_delivery_chk;
alter table public.contract_signers add constraint contract_signers_delivery_chk
  check (delivery in ('email', 'sms', 'both'));

-- approved / rejected are an approver's answers; delegated closes a row
-- whose signature was handed to someone else.
alter table public.contract_signers drop constraint if exists contract_signers_status_check;
alter table public.contract_signers add constraint contract_signers_status_check
  check (status in ('pending', 'viewed', 'signed', 'declined', 'approved', 'rejected', 'delegated', 'filled'));

create index if not exists contract_signers_seller_idx on public.contract_signers (seller_id) where seller_id is not null;
create index if not exists contract_signers_buyer_idx on public.contract_signers (buyer_id) where buyer_id is not null;
create index if not exists contract_signers_vendor_idx on public.contract_signers (vendor_id) where vendor_id is not null;
create index if not exists contract_signers_user_idx on public.contract_signers (user_id) where user_id is not null;

-- ---------------------------------------------------------------- contracts
alter table public.contracts
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_rejected_at timestamptz,
  add column if not exists approval_rejected_reason text;
create index if not exists contracts_awaiting_approval_idx on public.contracts (workspace_id) where status = 'awaiting_approval';
