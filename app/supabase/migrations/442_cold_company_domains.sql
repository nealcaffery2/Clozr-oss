-- 442 · A workspace may let cold email send from the company domains, health
-- checked.
--
-- The cold pool refuses yourcompany.com, underwriting.example.com and underwriting.example.com as a
-- From-domain (_shared/cold-campaign.ts DEFAULT_BLOCKED_SENDING_DOMAINS) so a
-- spam strike on an outreach inbox could never reach the address every blast
-- and reply goes out from. The owner wants the option to send from them
-- anyway, so this flag lets an owner or admin turn the lock off for one
-- workspace. Off everywhere by default. When it is on, a company-domain
-- mailbox still passes every gate the pool applies (DNS check under 7 days,
-- no blocking items, warm-up gate, bounce and complaint auto-pause, the
-- 5 -> 20 ramp, the combined ceiling, the recipient-domain cap) plus one
-- more: its domain's DNS score must be at or above the warm-up gate score.
-- blocked_extra still wins: a company domain listed there stays blocked.
-- Safe to re-run.

alter table public.cold_workspace_settings
  add column if not exists allow_company_domains boolean not null default false;

comment on column public.cold_workspace_settings.allow_company_domains is
  'Owner/admin override: cold email may send from the company domains (yourcompany.com, underwriting.example.com, underwriting.example.com), health checked. Default false. blocked_extra still wins.';
