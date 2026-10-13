-- 72: The Auto-run underwriting switch becomes readable, not just writable.
--
-- Migration 55 added `auto_compr` to a key's settings and let an owner or admin
-- veto the provider per key with set_ingest_setting(id, 'auto_compr', 'off'). The
-- switch worked, but nothing could show its position: `ingest_sources_public`
-- exposes `creates`, `has_signing_secret` and `has_api_key` and stops there, so
-- The browser could turn Auto-run underwriting off and then had no way to tell you it
-- was off. A toggle that cannot read its own state is a toggle nobody trusts.
--
-- The Deal Machine screen renders this switch, so the view now carries it,
-- defaulting to 'on' exactly as the ingest function reads it (settings->>
-- 'auto_compr' is only honoured when it equals 'off'). Same shape as `creates`:
-- a coalesce over the same jsonb, no new privilege — the view still answers
-- only to an owner or admin, and `settings` itself stays unreadable, so the
-- signing secret and the Jotform API key beside it are no more exposed than
-- they were.
drop view if exists public.ingest_sources_public;
create view public.ingest_sources_public with (security_invoker = false) as
  select id, workspace_id, name, label, key_prefix, active, last_used_at, created_at,
         (settings ? 'signing_secret')  as has_signing_secret,
         coalesce(settings->>'creates', 'seller') as creates,
         coalesce(settings->>'auto_compr', 'on') as auto_compr,
         (settings ? 'jotform_api_key') as has_api_key
    from public.ingest_sources
   where public.has_role(workspace_id, 'owner', 'admin');
revoke all on public.ingest_sources_public from anon, authenticated;
grant select on public.ingest_sources_public to authenticated;
