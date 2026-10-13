# CLOZR security architecture

**Status:** implemented; migrations 23–26, `supabase/functions/_shared/security.ts`,
`lib/session.tsx`, `lib/captcha.ts`, `vercel.json`, `.github/workflows/*`.
**Audience:** acquisitions teams holding seller PII and deal economics. Designed to be
audited against SOC 2-style controls.

CLOZR has no application server. The browser talks to Supabase (Postgres behind
PostgREST, Auth, Edge Functions) and to the Talkr Platform directly, so every
control lives in one of three places: the database, an edge function, or a
platform setting. This document says which, and why.

---

## 1. Identity (CC6.1, CC6.2)

| Layer | What |
|---|---|
| Sign-in | Email + password, magic link, or password reset, all via Supabase Auth. `lib/session.tsx` is the single place that calls it. |
| Bot protection | hCaptcha on all four auth forms when `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` is set at build time **and** hCaptcha is enabled under Authentication → Attack protection in the Supabase dashboard with the matching secret. GoTrue verifies the token; the app only passes it along. No key: no widget, forms unchanged. |
| Two-factor | **TOTP** via Supabase MFA. Enrol on Account → Two-factor authentication (scan, type a code, done). With a verified factor the session signs in at `aal1` and Supabase reports `nextLevel = aal2`; the login page asks for the code, and the `/app` guard refuses to render until `getAuthenticatorAssuranceLevel()` says the step-up is done. Removing a factor requires an `aal2` session, which every in-app session is. |
| Leaked passwords | Supabase's HaveIBeenPwned check is a dashboard toggle (Authentication → Attack protection → *Prevent use of leaked passwords*). The security advisor flags it until it is on. |
| Teammates | Owners and admins add people from Settings → Team. The `add-teammate` function creates a confirmed user with a one-time password, emails a CLOZR-branded invite (password + sign-in link to the Clozr app origin — never Talkr) via Resend, shows the password once as a backup, records the invite, and the `handle_new_user` trigger joins them with the intended role. **Resend invite** mints a fresh password and re-mails it. Invite `loginUrl` prefers the admin's live browser origin, then `APP_URL` / `SITE_URL`, and rejects Talkr hosts (`talkr.example.com`, Talkr Vercel apps), falling back to `https://your-clozr-site.example.com`. |
| Machine access | Integrations authenticate to `/ingest` with a `clz_…` API key: 192 bits from the platform CSPRNG, stored as SHA-256, prefix kept for recognition, compared in constant time. Talkr webhooks are HMAC-SHA256 signed (`t=…,v1=…`, 5-minute replay window). Calendar feeds use a 192-bit token. |

The browser holds the Supabase **publishable** key, which is designed to be
public: the security boundary is row-level security, not the secrecy of that
string. The service role key exists only inside edge functions.

---

## 2. Tenancy and data isolation (CC6.6)

One Postgres, partitioned by `workspace_id`. Every data table has RLS enabled
with policies of the form

```sql
using (public.is_workspace_member(workspace_id))
```

and, where a role matters (buyers, offers, transactions, invites, members,
ingest keys), `public.has_role(workspace_id, 'owner', 'admin', …)`. Both
helpers read `workspace_members` for `auth.uid()`; they are the only
`SECURITY DEFINER` functions signed-in users may call that return anything,
and what they return is a fact about the caller.

Migration 23 fixed the two real gaps found in review:

- `members_insert_self` allowed `insert into workspace_members` for any
  workspace and any role as long as `user_id = auth.uid()`. Dropped; nothing
  in the client needed it.
- Default grants gave `anon` and `authenticated` `TRUNCATE`, `TRIGGER` and
  `REFERENCES` on every table. RLS does not govern `TRUNCATE`. `anon` now
  holds no table or sequence privilege at all; `authenticated` holds only
  `SELECT/INSERT/UPDATE/DELETE`. Default privileges are altered so new tables
  start the same way.

Every policy is declared `to authenticated`, with `auth.uid()` wrapped in
`(select …)` so it is evaluated once per statement. `ingest_sources` is
readable only through the `ingest_sources_public` view (no `key_hash`, no
signing secret) and writable by owners and admins.

Edge functions that act with the service role first resolve the caller from
their JWT (`auth.getUser()`), then check membership or role against
`workspace_members`, and only then touch data. The workspace always comes from
the key or the membership, never from the request body.

---

## 3. Roles (CC6.3)

| Role | Sellers, tasks, deals | Buyers | Offers | Transactions | Members, invites, keys, settings |
|---|:-:|:-:|:-:|:-:|:-:|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| admin | ✓ | ✓ | ✓ | ✓ | ✓ (cannot touch the owner row) |
| acquisitions | ✓ | | inbound only | | |
| dispositions | ✓ | ✓ | ✓ | ✓ | |
| tc | ✓ | read | ✓ | ✓ | |
| member | ✓ | read | read | read | |

Hard-deleting a seller or a buyer is owner/admin only (migration 208); the
app archives instead.

Enforced by RLS (migration 17) and, for the privileged RPCs, inside the
functions themselves (migration 23): `issue_ingest_key`, `set_ingest_secret`,
`ingest_replay` and `ensure_calendar_token(rotate => true)` raise `42501`
unless the caller is an owner or admin.

---

## 4. Audit (CC7.2)

`public.audit_log` is append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers
raise, and the service role is not exempt. Two write paths:

1. **Row triggers** (`audit_data_change`) on `workspace_members`,
   `workspace_invites`, `ingest_sources` and `workspaces` capture before/after
   JSON for every INSERT/UPDATE/DELETE, with `key_hash`, `calendar_token` and
   `settings.signing_secret` redacted.
2. **`audit_event(workspace_id, action, detail)`** for actions that are not one
   row change, callable by any member for their own workspace.

Owners and admins can read their workspace's trail. Indexed by workspace and
action for evidence pulls:

```sql
select occurred_at, action, principal_id, resource_type, resource_id, detail
from audit_log where workspace_id = 42 and occurred_at >= now() - interval '90 days'
order by occurred_at;
```

---

## 5. The edge-function surface

`supabase/functions/_shared/security.ts` is imported by every function.

| Control | How |
|---|---|
| CORS | `corsFor(req)` reflects the request origin only if it matches `ALLOWED_ORIGINS` (comma-separated, `https://*.vercel.app` patterns allowed). Unset, it answers `*` and logs a warning so the gap is visible. Set it: `supabase secrets set ALLOWED_ORIGINS=https://crm.yourcompany.com,https://your-app-*-your-team.vercel.app`. |
| Rate limiting | `rateLimit(db, key, limit, windowSeconds)` calls `public.rate_limit_hit` (migration 25), a fixed-window counter in a service-role-only table. Fails open on a database error and logs. Keys: failed ingest key lookups per address (30/10 min), ingest per key (600/min), Talkr webhook per address (600/min), calendar feed per address (60/10 min), AI functions per user (30/hour), add-teammate per admin (20/hour). |
| Client address | `clientIp()` prefers `cf-connecting-ip`, then `x-real-ip`, then the **last** `X-Forwarded-For` entry, so a client-supplied leftmost value never mints a fresh bucket. |
| Error hygiene | `serverError()` logs the real error with a scope and returns a generic body. Postgres, Anthropic and vendor error text no longer reaches the browser. |
| Response headers | `nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` on every response. |
| Prompt injection | `fence(label, text)` strips control characters, caps length and wraps untrusted text in `<untrusted_…>` tags; `UNTRUSTED_RULE` in the system prompt names them as data. Applied to seller fields, history, goals and imported spreadsheets in `draft-action-plan` and `map-columns`. |

Functions deployed with `verify_jwt` **off** (`ingest`, `talkr-webhook`,
`calendar-feed`) own their own authentication as described in §1; the rest
require a Supabase JWT at the gateway and re-verify it inside.

The gateway only proves a JWT was signed by the project: the anon key passes
it. So inside a function:

| Caller | Check (`_shared/security.ts`) |
|---|---|
| The service role (pg_cron kicks, one function calling another) | `isServiceCaller(admin, bearer)`: exactly the runtime's `SUPABASE_SERVICE_ROLE_KEY` (constant-time) or exactly the vault key the cron sends (`is_cron_key`, migration 193). A decoded `role` claim is never trusted on its own, so the check holds even with `verify_jwt` off. |
| A person acting on one workspace | `auth.getUser()`, then `memberRole(db, workspaceId, userId)` before any service-role read or write of that workspace's rows (`compr-underwrite`, and the per-function checks elsewhere). |
| A person spending a vendor key on no workspace's rows | `isTeammate(db, userId)`: a member of some workspace, not a bare sign-up (`map-columns`, `jev-triage`), plus the per-user rate limit. |

Every function lives in `app/supabase/functions/` and deploys from `main`.
A function made only in the dashboard is invisible to review; the three that
were (`geocode-properties`, `provider-check`, `dispogenius-sync`) were guarded
by one static token written in their source and were brought into the repo
with `isServiceCaller`. That token was exposed in the dashboard source and in
the `dispogenius_sync_kick` body (removed by migration 206) and opens nothing
now; treat it as burned.

Public pages and copy show the city and state only unless the rep turns the
full address on: the `listing` page and the marketplace card drop the street
from the headline and description (`mentionsStreet` / `hideStreet` in
`marketplace-public.ts`). The `/deal` route writes the listing page into the
app's origin, so it cleans it first (`lib/listing-html.ts`: only http(s),
mailto: and tel: links, no inline handlers, frames or `<base>`), and the
listing function itself prints only http(s) URLs.

---

## 6. Browser hardening

`vercel.json` sets on every route: HSTS (2 years, preload), `X-Frame-Options:
DENY` and `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, a `Permissions-Policy` that keeps only the
microphone (the softphone) and `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
The value is `same-origin-allow-popups`, not `same-origin`: sign-in popups an
integration opens hand the session back through `window.opener`, which
`same-origin` would sever. Popups Clozr does not open stay
isolated, and Clozr does not set COEP, so this is not a cross-origin-isolation
regression. The
Content-Security-Policy names every script origin (self, Google Maps, hCaptcha),
allows inline scripts only because the static export inlines its own
hydration payload, blocks `object-src`, pins `base-uri` and `form-action` to
self, and allows `connect-src https: wss:` because the Talkr API origin is a
per-workspace setting. `/app`, `/login`, `/auth/*`, `/demo` and `/playground/jev-triage` are `noindex`
and `no-store`.

---

## 7. Secrets

| Where | What |
|---|---|
| Browser bundle | Supabase URL and publishable key; hCaptcha site key (public by design). |
| Supabase edge-function secrets | `SUPABASE_SERVICE_ROLE_KEY` (platform-provided), `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `ALLOWED_ORIGINS`. Optional: `TYPESAFE_API_KEY` for the Jev lead-triage playground (`jev-triage`); until it is set the function answers 503 and the page uses a local stub. |
| Database | Ingest key hashes; Talkr signing secrets (write-only from the client via `set_ingest_secret`, readable only by the webhook function). |
| Talkr Platform | Twilio, Deepgram and Anthropic credentials for calling; never in CLOZR. |
| Vercel | Nothing secret: the site is static and nothing runs server-side there. |

---

## 8. Supply chain and CI

`.github/workflows/ci.yml` runs lint, type-check, the production build and
`pnpm audit --prod --audit-level=high` on every pull request and push to
`main`. `.github/workflows/semgrep.yml` runs the curated `p/security-audit`,
`p/secrets` and `p/typescript` rulesets over the edge functions, `lib/` and
`app/`, failing on ERROR-level findings, weekly as well. `.github/dependabot.yml`
groups weekly npm updates and patches GitHub Actions. Make the two workflows
required status checks on `main`.

---

## 9. Threat model

| Threat | Control |
|---|---|
| Cross-workspace read with the publishable key | RLS on every table; `anon` holds no privileges |
| Signed-in user joins another workspace | `members_insert_self` removed; membership written only by the signup trigger and `add-teammate` |
| Signed-in user empties a table | `TRUNCATE` revoked from `authenticated` |
| Member mints or rewires API keys | RPCs and `ingest_sources` policy require owner/admin |
| Stolen ingest key | Hashed at rest, disable from Settings, workspace bound to the key, 600/min ceiling |
| Ingest key brute force | 30 failed lookups per address per 10 minutes, 192-bit keys |
| Forged Talkr webhook | HMAC-SHA256 over `t.body`, constant-time compare, 5-minute window |
| Guessed or leaked password | TOTP step-up; leaked-password check (dashboard) |
| Credential stuffing / signup bots | hCaptcha when enabled; Supabase's own auth rate limits |
| Prompt injection through seller text | Fenced as untrusted data; structured tool output only |
| Error messages mapping the schema | Generic bodies; details in function logs |
| Clickjacking, MIME sniffing, injected scripts | CSP, `frame-ancestors 'none'`, `nosniff` |
| Tampered audit trail | Append-only triggers, service role included |
| Compromised dependency or action | Lockfile-pinned installs, production audit gate, Semgrep, Dependabot |

---

## 10. Operator runbook

**Turn on the two dashboard settings** (not expressible in migrations):
Authentication → Attack protection → *Prevent use of leaked passwords*, and
*Enable Captcha protection* (hCaptcha) with the secret, plus
`NEXT_PUBLIC_HCAPTCHA_SITE_KEY` on the Vercel project.

**Lock CORS to the real origins:**
```sh
supabase secrets set ALLOWED_ORIGINS=https://crm.yourcompany.com,https://your-app-*-your-team.vercel.app
```

**Read the audit trail for a workspace:** the query in §4, or from the app as
an owner/admin via `supabase.from('audit_log')`.

**Force a user out:** delete their `workspace_members` row (audited) and revoke
their sessions from the Supabase Auth dashboard.

**Re-run the linters after schema work:** Supabase → Advisors. Expected
remaining items are intentional: the RLS helper functions and the admin-gated
RPCs are `SECURITY DEFINER` and callable by signed-in users on purpose;
`rate_limit_buckets` has RLS with no policy because only the service role
touches it.
