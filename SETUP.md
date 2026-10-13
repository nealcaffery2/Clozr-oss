# Setting up CLOZR

This guide takes you from an empty Supabase account to a working CLOZR at
`https://crm.yourcompany.com`, with a check after each step. Replace these
placeholders everywhere:

| Placeholder | Meaning |
| --- | --- |
| `your-project-ref` | your Supabase project ref, the 20 letters in `https://your-project-ref.supabase.co` |
| `crm.yourcompany.com` | the domain CLOZR will be served from |
| `talkr.yourcompany.com` | your Talkr API origin |

If you want an AI coding assistant to run the steps for you, give it
[SETUP-WITH-AI.md](SETUP-WITH-AI.md) instead.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Run the demo locally](#2-run-the-demo-locally)
3. [Create the Supabase project](#3-create-the-supabase-project)
4. [Create the Vault secrets](#4-create-the-vault-secrets)
5. [Apply the migrations](#5-apply-the-migrations)
6. [Deploy the edge functions and set their secrets](#6-deploy-the-edge-functions-and-set-their-secrets)
7. [Configure Supabase Auth](#7-configure-supabase-auth)
8. [Deploy the frontend and create the first owner](#8-deploy-the-frontend-and-create-the-first-owner)
9. [Connect Talkr](#9-connect-talkr)
10. [Connect Google](#10-connect-google)
11. [Optional integrations](#11-optional-integrations)
12. [Verify the install](#12-verify-the-install)
13. [Troubleshooting](#13-troubleshooting)

## 1. Prerequisites

- **Node.js 22.13 or newer** (`app/package.json` engines).
- **pnpm 10** (the version CI uses).
- **Supabase CLI.** The deploy workflow pins 2.117.0:
  `npm install -g supabase@2.117.0`.
- **psql**, if you apply migrations through a database URL (recommended).
- **A Supabase account** with room for one project.
- **A Talkr deployment** if you want calling and SMS. Talkr is a separate
  open-source repository with its own setup.
- Optional: a Vercel account (the repo ships a `vercel.json`), a Google Cloud
  project for Gmail and Calendar, and accounts for the integrations you plan
  to use.

Check:

```sh
node --version      # v22.13.0 or later
pnpm --version      # 10.x
supabase --version  # 2.117.0 or the version you chose
psql --version      # any recent version
```

## 2. Run the demo locally

```sh
cd app
pnpm install
pnpm dev
```

Open http://localhost:3000/demo. You should see the CLOZR shell with sample
people, deals and buyers. Nothing here needs a backend. Stop the server with
Ctrl+C when you are done.

## 3. Create the Supabase project

1. In the Supabase dashboard, create a project. Save the database password
   somewhere safe.
2. Collect these values. Keep the secret ones out of chat, tickets and the
   repository.

| Value | Where | Secret? |
| --- | --- | --- |
| Project ref | the project URL | no |
| Project URL | Project Settings → API | no |
| Publishable key | Project Settings → API Keys | no (designed to be public) |
| `service_role` key | Project Settings → API Keys → Legacy API keys (a JWT starting with `eyJ`) | **yes** |
| Session pooler connection string | Connect → Session pooler (with your database password) | **yes** |
| Personal access token | supabase.com/dashboard/account/tokens | **yes**, expires after 90 days |

3. Log the CLI in: `supabase login`.

Check: `supabase projects list` shows your project.

## 4. Create the Vault secrets

The pg_cron jobs and database triggers that call edge functions read three
Vault secrets. Without them those jobs do nothing (they do not fail loudly).
In the dashboard SQL editor, run:

```sql
select vault.create_secret('https://your-project-ref.supabase.co', 'clozr_project_url');
select vault.create_secret('<service role key>', 'clozr_service_role_key');
select vault.create_secret('https://crm.yourcompany.com', 'clozr_app_url');
```

Use the legacy `service_role` JWT for `clozr_service_role_key`. The cron jobs
send it as a bearer token, some of the functions they call keep the gateway's
JWT check on, and `is_cron_key` (migration 193) compares callers against
exactly this value.

Check:

```sql
select name from vault.secrets where name like 'clozr_%' order by name;
```

Expected: `clozr_app_url`, `clozr_project_url`, `clozr_service_role_key`.

## 5. Apply the migrations

The migrations in `app/supabase/migrations` are applied in order by
`app/scripts/migrate.mjs`, which records each file in
`public.applied_migrations`. Each file runs in its own transaction with its
ledger row, so a failure leaves nothing behind and the run stops there.

The first file, `0_baseline.sql`, creates the base schema (workspaces,
members, RLS helpers, the sign-up trigger); `258_baseline_tail.sql` finishes
the objects that depend on later tables. On an empty project the whole folder
applies in order with nothing else to prepare.

**Option A, from your machine (recommended).** Uses psql, so a long backfill
is not cut off.

```sh
cd app
export SUPABASE_DB_URL="$(cat ~/clozr-secrets/db-url)"   # a file only you can read
pnpm migrate:dry-run     # lists what would run
pnpm migrate             # applies it
pnpm migrate:status      # shows applied and pending
```

**Option B, through the Management API.** No psql, but a single statement is
cut off after about a minute.

```sh
cd app
export SUPABASE_ACCESS_TOKEN="$(cat ~/clozr-secrets/access-token)"
export SUPABASE_PROJECT_REF=your-project-ref
pnpm migrate
```

**Option C, from GitHub Actions.** In your fork, add repository secrets
(Settings → Secrets and variables → Actions): `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, and optionally `SUPABASE_DB_URL` (preferred when set).
On the Variables tab of the same page, add `CLOZR_DEPLOY` = `true`; without it
the deploy workflows skip.
Then Actions → "Apply database migrations" → Run workflow → `apply`. After
that, every push to `main` that touches the migrations folder applies new
files.

Check: `pnpm migrate:status` reports nothing pending, and

```sql
select jobname, schedule from cron.job where jobname like 'clozr-%' order by jobname;
```

lists the `clozr-*` jobs (call sync, Google sync, campaign ticks and so on).

## 6. Deploy the edge functions and set their secrets

### Deploy

```sh
cd app
supabase functions deploy --project-ref your-project-ref
```

With no function name, the CLI deploys every function in
`app/supabase/functions`. `app/supabase/config.toml` turns the gateway's JWT
check off for the functions that authenticate their own callers (webhooks, the
signing page, OAuth callbacks, the ingest API).

To deploy from GitHub instead, set `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_PROJECT_REF` as repository secrets, set the Actions variable
`CLOZR_DEPLOY` to `true`, and run Actions → "Deploy edge
functions". It also runs on every push to `main` that touches the functions.

Check:

```sh
supabase functions list --project-ref your-project-ref
curl -s -o /dev/null -w "%{http_code}\n" https://your-project-ref.supabase.co/functions/v1/calendar-feed
```

The list shows 69 functions. The curl prints `401` (the feed needs a token).
A `404` means the deploy did not reach this project.

### Secrets

Put the secrets in a file outside the repository, for example
`~/clozr-secrets/functions.env`, one `NAME=value` per line, then load it:

```sh
supabase secrets set --project-ref your-project-ref --env-file ~/clozr-secrets/functions.env
```

Start with these:

```sh
ANTHROPIC_API_KEY=...
ALLOWED_ORIGINS=https://crm.yourcompany.com,http://localhost:3000
APP_URL=https://crm.yourcompany.com
TALKR_API_URL=https://talkr.yourcompany.com
TALKR_PARTNER_JWT_SECRET=...        # a long random string; Talkr gets the same value
RESEND_API_KEY=...
MAIL_FROM=Your Company <team@yourcompany.com>
```

Generate a partner secret with `openssl rand -base64 48`. Add
`ANTHROPIC_WORKSPACE_ID` if your Anthropic key is organization-level. Every
other secret is optional and listed by integration in the README's
[edge function secrets](README.md#edge-function-secrets).
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are set by
the platform.

Check: `supabase secrets list --project-ref your-project-ref` shows the names
you set (values are shown as digests). After step 8, Settings → Workspace →
Server keys in the app shows the same list.

## 7. Configure Supabase Auth

These are dashboard settings; no migration can set them.

1. **Authentication → URL Configuration**
   - Site URL: `https://crm.yourcompany.com`
   - Redirect URLs: `https://crm.yourcompany.com/auth/callback` and, for
     local work, `http://localhost:3000/auth/callback`
2. **Authentication → Attack protection → Prevent use of leaked passwords**:
   on.
3. **hCaptcha (optional).** Authentication → Attack protection → Enable
   Captcha protection, provider hCaptcha, with your hCaptcha secret. Then set
   `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` on the frontend build (step 8). Do both or
   neither.
4. **Multi-factor.** Leave TOTP enabled. Members enroll under Account →
   Two-factor authentication.

Sign-up confirmation, magic links and password resets all return to
`/auth/callback`.

Check: the Security Advisor (Advisors in the dashboard) no longer flags
leaked-password protection.

## 8. Deploy the frontend and create the first owner

### Build-time variables

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://your-project-ref.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your publishable key |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.yourcompany.com` |
| `NEXT_PUBLIC_TALKR_API_URL` | `https://talkr.yourcompany.com` |
| `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` | only if you turned on hCaptcha |

Optional: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_GOOGLE_PLACES_KEY`,
`NEXT_PUBLIC_MAPBOX_TOKEN`, `NEXT_PUBLIC_TALKR_WEB_URL`, `NEXT_PUBLIC_COMPR_URL`
(see the README). For local work, put the same values in `app/.env.local`
(copy `app/.env.example`).

### On Vercel

1. Import the repository. Set **Root Directory** to `app` and the framework
   preset to **Other**. `app/vercel.json` supplies the build command
   (`pnpm build`), the output directory (`dist/client`), the install command,
   clean URLs, the security headers and the CSP.
2. Add the variables above under Settings → Environment Variables.
3. In `app/vercel.json`, replace `your-project-ref` in the
   `/oauth/google/callback` rewrite with your project ref and commit it.
4. Add `crm.yourcompany.com` as a domain and deploy.

### On another static host

Build with `cd app && pnpm build` and serve `app/dist/client`. Then:

- serve clean URLs (`/login` must serve the login page);
- copy the headers from `app/vercel.json`, the CSP in particular;
- if you will set `GOOGLE_REDIRECT_URI` to your own domain (step 10), proxy
  `/oauth/google/callback` to
  `https://your-project-ref.supabase.co/functions/v1/google-oauth/callback`,
  keeping the query string.

### First workspace and owner

Open `https://crm.yourcompany.com/login`, choose **Create an account**, and
sign up. If email confirmation is on in Supabase Auth, confirm from the email
first. On the first sign-up the database's `handle_new_user` trigger creates
your profile, a workspace and an `owner` membership.

Add teammates from Settings → Workspace → Team. The `add-teammate` function
creates their account with a one-time password, emails the invite through
Resend (needs `RESEND_API_KEY` and `MAIL_FROM`), and shows the password once as
a backup. Teammates who sign up on their own get a workspace of their own
instead, so use the Team screen.

Check: you land on `/app` with an empty workspace, and in SQL:

```sql
select w.id, w.name, m.role
from public.workspaces w join public.workspace_members m on m.workspace_id = w.id;
```

shows one row with role `owner`. Note the workspace `id` for step 9.

## 9. Connect Talkr

CLOZR's browser calls Talkr directly, signing each request with the rep's
Supabase session token. Edge functions that call Talkr sign a five-minute
token with `TALKR_PARTNER_JWT_SECRET`.

On the **Talkr** side (see Talkr's own docs for where each is set):

- `WEB_ORIGIN` includes `https://crm.yourcompany.com` (and
  `http://localhost:3000` for local work);
- `PARTNER_JWKS_URL` or `PARTNER_JWT_SECRET`, plus `PARTNER_JWT_ISSUER` set to
  `https://your-project-ref.supabase.co/auth/v1`;
- a partner secret equal to CLOZR's `TALKR_PARTNER_JWT_SECRET`;
- each rep added on Talkr's Team page with the same email they use in CLOZR.

On the **CLOZR** side:

1. `NEXT_PUBLIC_TALKR_API_URL` (step 8) and `TALKR_API_URL` (step 6), or set
   the origin per workspace in Settings → Talkr → Account → Talkr API origin
   (owners and admins). The workspace setting wins.
2. Bind the workspace to its Talkr org so call sync, number checks and other
   server-side mirrors know where to write. There is no screen for this; run
   it in the SQL editor with your workspace id and Talkr org id:

   ```sql
   insert into public.talkr_connections (workspace_id, talkr_org_id)
   values (1, 'your-talkr-org-id');
   ```

3. For Talkr's webhooks (texts and call events as they happen): in Settings →
   Workspace → Integrations, mint an ingest key for **Talkr**, set its signing
   secret, and subscribe
   `https://your-project-ref.supabase.co/functions/v1/talkr-webhook` in Talkr
   with the same secret.

Check: Settings → Talkr → Account shows you linked to Talkr; the dialer places
a call; within a few minutes the call appears on the seller's timeline (the
`clozr-call-sync` job runs every two minutes).

## 10. Connect Google

> **Bring your own Google OAuth client.** This repository ships no Google
> credentials. Every client ID or secret in the code, tests and examples is a
> dummy (such as `000000000000-dummyclientid.apps.googleusercontent.com` or
> `GOCSPX-DUMMY-SECRET-not-a-real-credential`) and will not work. Create your
> own OAuth client in your own Google Cloud project using the steps below. Keep
> the client secret out of git, and rotate it in Google Cloud (Credentials →
> your client → **Reset secret**) if it is ever committed, pasted in a public
> place or shared.

Skip this if you do not need Gmail, Google Calendar or Drive.

### Create the OAuth client

In Google Cloud Console, in one project:

1. **APIs & Services → Library**: enable Gmail API and Google Calendar API.
   For the optional add-ons, also Google Drive API, Gmail Postmaster Tools API
   and Site Verification API.
2. **OAuth consent screen**: choose Internal if every user is in your Google
   Workspace, otherwise External. App name: Your Company CRM. Authorized
   domain: `yourcompany.com`. Add the scopes below. With External in Testing
   mode, add each rep as a test user.
3. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**.
   - Authorized JavaScript origins: none needed.
   - Authorized redirect URIs: pick one of
     - `https://crm.yourcompany.com/oauth/google/callback` if you will set
       `GOOGLE_REDIRECT_URI` (needs the rewrite from step 8; the consent screen
       then shows your domain), or
     - `https://your-project-ref.supabase.co/functions/v1/google-oauth/callback`
       if you leave `GOOGLE_REDIRECT_URI` unset.
   - If you will use Google mailboxes in the cold email pool, also add
     `https://your-project-ref.supabase.co/functions/v1/cold-pool/callback`.

Scopes CLOZR requests:

- Connect Google: `openid`, `email`, `profile`,
  `https://www.googleapis.com/auth/calendar`,
  `https://www.googleapis.com/auth/gmail.send`,
  `https://www.googleapis.com/auth/gmail.readonly`
- Connect Drive (add-on): `https://www.googleapis.com/auth/drive.readonly`
- Connect Postmaster (add-on): `https://www.googleapis.com/auth/postmaster.readonly`,
  `https://www.googleapis.com/auth/siteverification`

`gmail.readonly` and `drive.readonly` are restricted scopes. An External app
in Testing mode works only for listed test users and Google expires their
refresh tokens after 7 days. Publishing it requires Google's verification,
including a security assessment for restricted scopes. An Internal app does
not.

### Give CLOZR the client

Add to your secrets file and load it again (step 6). `app/supabase/functions.env.example`
shows the shape with dummy values; replace every one with your own client's:

```sh
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://crm.yourcompany.com/oauth/google/callback   # only if you chose that URI
GOOGLE_TOKEN_KEY=...                                                    # optional
```

Check: Settings → Outbound OS → Google, **Connect Google**. Approve on Google's
screen. You return to `/app` with a message naming the connected address.
Within five minutes (`clozr-google-sync`), CLOZR's calendar appears in Google
Calendar and mail with people in the CRM shows on their records.

Each member connects their own Google account. The connection belongs to the
workspace it was made in.

## 11. Optional integrations

Turn on only what you use. Each one is a set of function secrets (step 6) or
a form in Settings, unless noted.

| Integration | What to do |
| --- | --- |
| **Underwriting** | Replace `app/supabase/functions/compr-underwrite/index.ts` with a handler for your valuation engine. The shapes the app sends and expects are in `app/lib/compr.ts`, `app/lib/deal-files.ts` and `app/lib/places.ts`. Redeploy that function. |
| **Email campaigns and deliverability** | `RESEND_API_KEY`, `MAIL_FROM`, optional `MAIL_FROM_BLASTS` on a sending subdomain. In Resend, add a webhook to `https://your-project-ref.supabase.co/functions/v1/deliverability/resend` and set `RESEND_WEBHOOK_SECRET`. Optional: `REOON_API_KEY` for verification. Then Settings → Outbound OS → Email deliverability. |
| **Cold email pool** | Google mailboxes use the Google client (step 10, with the cold-pool redirect URI). Microsoft mailboxes: register an Entra ID app with redirect URI `https://your-project-ref.supabase.co/functions/v1/cold-pool/microsoft` and delegated permissions `offline_access openid profile email Mail.Send Mail.Read`, then set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. Optional `INSTANTLY_API_KEY` (warm-up gate) and `INBOXKIT_API_KEY`. |
| **Lead intake** | Settings → Workspace → Integrations → mint an ingest key per source. Sources post to `https://your-project-ref.supabase.co/functions/v1/ingest` with `Authorization: Bearer clz_…` or `?key=clz_…`. Zapier, Make or n8n use the Zapier / Webhook key; Jotform forms use a Jotform key in their WebHooks setting. |
| **Outbound webhooks** | Settings → Workspace → Integrations → Zapier & webhooks: subscribe a URL to events such as `seller.created` or `contract.completed`. |
| **Podio** | Settings → Workspace → Integrations → Podio: client ID, client secret and each app's ID and token. Import, then turn on the ten-minute sync. |
| **PandaDoc** | `PANDADOC_API_KEY`; in PandaDoc, subscribe `https://your-project-ref.supabase.co/functions/v1/pandadoc-webhook` to document and recipient events and set the shared key as `PANDADOC_WEBHOOK_KEY`. CLOZR's own e-sign works without it. |
| **AI** | `ANTHROPIC_API_KEY` covers Ask CLOZR, Lane, AI agents, coaching and drafting. `GEMINI_API_KEY` adds agent pictures and photo checks. |
| **Voice agent** | `ELEVENLABS_API_KEY` plus `ELEVENLABS_PERSONALIZE_SECRET`, `ELEVENLABS_TOOL_SECRET` and `ELEVENLABS_WEBHOOK_SECRET`; then Settings → Workspace → AI Agent. |
| **Live transcript fallback** | `DEEPGRAM_API_KEY` (used when Talkr has no transcription key to give). |
| **10DLC, number health, RVM** | `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_CONNECTION_ID` (or the lower-case Vault secrets). Ringless voicemail through Drop Cowboy (`DROPCOWBOY_*`) or Slybroadcast (`SLYBROADCAST_*`). Then Settings → Workspace → Company & 10DLC. |
| **Buyer data** | `REAL_ESTATE_API_API_KEY` and `BATCHDATA_API_KEY` for Genius and skip tracing; `ATTOM_API_KEY`; `DISPOGENIUS_API_KEY`; InvestorBase and iVueit keys in Settings → Workspace → Integrations. |
| **Address autocomplete and maps** | `NEXT_PUBLIC_GOOGLE_PLACES_KEY` (restrict it to your domain), `NEXT_PUBLIC_MAPBOX_TOKEN`. Rebuild the frontend. |
| **Public marketplace** | `MARKETPLACE_WORKSPACE_ID` if you have more than one workspace; it defaults to the first. |
| **Bank feed** | Brex token from the Reporting bank panel, or `BREX_API_TOKEN`. |
| **Lock CORS** | Make sure `ALLOWED_ORIGINS` lists every origin you serve CLOZR from, including preview patterns such as `https://your-app-*-your-team.vercel.app`. |

## 12. Verify the install

Run through this list once everything is set:

- [ ] `https://crm.yourcompany.com/demo` loads sample data.
- [ ] `https://crm.yourcompany.com/login` signs you in and `/app` shows your
      workspace.
- [ ] Account → Two-factor authentication enrolls a TOTP factor, and the next
      sign-in asks for a code.
- [ ] Quick Add (`Q`) creates a lead, and it appears in People.
- [ ] `pnpm migrate:status` shows nothing pending.
- [ ] Cron jobs are running and reaching the functions:

      ```sql
      select j.jobname, d.status, d.start_time
      from cron.job_run_details d join cron.job j using (jobid)
      order by d.start_time desc limit 10;
      ```

- [ ] A test lead posted to the ingest API lands in People:

      ```sh
      curl -s -X POST "https://your-project-ref.supabase.co/functions/v1/ingest" \
        -H "Authorization: Bearer $(cat ~/clozr-secrets/zapier-key)" \
        -H "Content-Type: application/json" \
        -d '{"event":"lead.create","first_name":"Test","last_name":"Seller","phone":"555-0100","address":"100 Main St","city":"Springfield","state":"IL","zip":"62701"}'
      ```

      (Use a Zapier / Webhook key; it takes flat JSON. The accepted field
      names and aliases are in `app/supabase/functions/_shared/flat.ts`.)
- [ ] The dialer places a call through Talkr and the call lands on the record.
- [ ] Connect Google succeeds and calendar events sync.
- [ ] The underwriting screen says no provider is configured (expected until
      you replace `compr-underwrite`).

## 13. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| A migration fails with `relation ... does not exist` | Files ran out of order or `0_baseline.sql` was skipped. Run `pnpm migrate:status` and apply from the first pending file. |
| `pnpm migrate` stops on a long statement through the Management API | Use `SUPABASE_DB_URL` (psql) instead. |
| A workflow fails with "Missing repository secret" or an auth error | The personal access token expired (90 days). Mint a new one and update `SUPABASE_ACCESS_TOKEN`. |
| Deploy says "Invalid project ref format" | `SUPABASE_PROJECT_REF` must be the 20-letter ref, not the URL. |
| Function calls fail in the browser with CORS errors | Add the page's origin to `ALLOWED_ORIGINS` and set the secrets again. |
| Cron jobs exist but nothing happens | The Vault secrets from step 4 are missing or the service role key is not the legacy JWT. Check `cron.job_run_details` and `net._http_response`. |
| Sign-up or magic-link emails open the wrong site | Fix Site URL and Redirect URLs (step 7) and `NEXT_PUBLIC_SITE_URL`. |
| AI features answer that the key needs a workspace | Your Anthropic key is organization-level. Set `ANTHROPIC_WORKSPACE_ID` or create the key inside a workspace. |
| Google says `redirect_uri_mismatch` | The URI in the OAuth client must match `GOOGLE_REDIRECT_URI`, or the Supabase function URL when that is unset, exactly. Settings → Outbound OS → Google shows the expected value. |
| "Google is not set up on this project yet" | Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. |
| "Google did not return a long-lived permission" | Remove the app at myaccount.google.com/permissions and connect again. |
| Google works for a week, then stops | External app in Testing mode: Google expires refresh tokens after 7 days. Publish the app or use an Internal app. |
| The Google callback on your domain returns 404 | The `/oauth/google/callback` rewrite is missing or still says `your-project-ref`. |
| Talkr requests fail with 401 | Talkr's `PARTNER_JWT_ISSUER` must be `https://your-project-ref.supabase.co/auth/v1`, and the rep must exist in Talkr with the same email. |
| Talkr requests fail with a CORS error | Add your CLOZR origin to Talkr's `WEB_ORIGIN`. |
| Calls work but never reach the record | No `talkr_connections` row for the workspace, or `TALKR_PARTNER_JWT_SECRET` differs between CLOZR and Talkr. |
| Teammate invites are not emailed | Set `RESEND_API_KEY` and `MAIL_FROM`. The one-time password is still shown once in Settings → Workspace → Team. |
| Underwriting controls are unavailable | Expected. Replace `compr-underwrite` with your engine. |
