-- 253: Postmaster domain verification, done by CLOZR.
--
-- Gmail Postmaster only reports on a domain the connected Google account has
-- verified. The deliverability edge function now does that itself
-- (_shared/site-verification.ts): it asks Google's Site Verification API for a
-- DNS_TXT token, writes the TXT at the domain's DNS host (InboxKit for the
-- cold domains, Vercel DNS for the company domains), and asks Google to
-- verify. Until DNS reaches Google the row is pending and the next Postmaster
-- load retries it.
--
-- One row per workspace domain:
--   status       verified | pending | needs_dns (no DNS host CLOZR can write) | error
--   account_id   the Google connection it was verified for
--   token        the TXT value Google issued (shown when it must be added by hand)
--   dns_host     inboxkit | vercel, where CLOZR wrote it
--   detail       what happened last, in words
--
-- Service role only, like deliverability_secrets: members see it through the
-- edge function.

create table if not exists public.email_domain_verifications (
  workspace_id  bigint      not null references public.workspaces(id) on delete cascade,
  domain        text        not null check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  account_id    bigint      references public.google_accounts(id) on delete set null,
  status        text        not null default 'pending' check (status in ('verified', 'pending', 'needs_dns', 'error')),
  dns_host      text        check (dns_host is null or dns_host in ('inboxkit', 'vercel')),
  token         text        check (token is null or char_length(token) <= 400),
  detail        text        check (detail is null or char_length(detail) <= 600),
  attempts      integer     not null default 0 check (attempts >= 0),
  checked_at    timestamptz,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, domain)
);

create index if not exists email_domain_verifications_account on public.email_domain_verifications (account_id);

alter table public.email_domain_verifications enable row level security;
revoke all on public.email_domain_verifications from anon, authenticated;
-- RLS on, no policy, no grant: service role only.

create or replace trigger email_domain_verifications_touch
  before update on public.email_domain_verifications
  for each row execute function public.touch_updated_at();

notify pgrst, 'reload schema';
