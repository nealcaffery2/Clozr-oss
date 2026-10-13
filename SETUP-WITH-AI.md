# Setting up CLOZR with an AI coding assistant

This file is written for the AI coding assistant (Claude Code, Cursor, Codex
or similar) that a person has asked to set up CLOZR. If you are the person,
hand this file to your assistant and keep [SETUP.md](SETUP.md) open for the
steps you do by hand.

## Your goal

Stand up a working CLOZR for the person you are helping:

- a Supabase project with every migration applied, the Vault secrets created
  and all 69 edge functions deployed with their secrets;
- the static frontend deployed on their domain;
- a first workspace with them as `owner`;
- Talkr connected for calling and SMS, and Google connected if they want
  Gmail and Calendar.

Work from the repository root. The app and its `package.json` are in `app/`;
run `pnpm`, `supabase` and `npx tsx` commands from `app/`.

## Rules for handling secrets

1. **Never ask the person to paste a secret into the chat.** That includes
   API keys, the Supabase `service_role` key, the database password or
   connection string, the personal access token, OAuth client secrets and
   Talkr's partner secret. Chat logs are not a secret store.
2. Instead, ask them to put each secret in a file only they can read, outside
   the repository, and you run commands that read the file:
   - `~/clozr-secrets/db-url`: the Session pooler connection string
   - `~/clozr-secrets/access-token`: a Supabase personal access token
   - `~/clozr-secrets/service-role-key`: the legacy `service_role` JWT
   - `~/clozr-secrets/functions.env`: edge function secrets, `NAME=value` per line
   Create the folder for them with `mkdir -p ~/clozr-secrets && chmod 700 ~/clozr-secrets`.
3. They may also set values themselves with `supabase secrets set`, in
   `app/.env.local`, or in the Vercel environment variables UI.
4. Never print a secret. Do not `cat` these files to the terminal, do not echo
   variables that hold them, and do not write them into any file inside the
   repository. `app/.gitignore` ignores `.env*` except `.env.example`, but
   keep secrets outside the repo anyway.
5. Values that are public by design may be handled normally: the project ref,
   the project URL, the publishable key, the hCaptcha site key, the Google
   client ID, domain names.

## What to ask the person for first

Ask these in one message, and wait for the answers:

1. The domain CLOZR will be served from (for example `crm.yourcompany.com`).
2. Whether a Supabase project exists already. If yes, its project ref.
3. Where they will host the frontend: Vercel (config included) or another
   static host.
4. Their Talkr API origin, if they run Talkr (for example
   `https://talkr.yourcompany.com`), and whether they can change Talkr's
   settings.
5. Whether they want Google (Gmail, Calendar, Drive), and whether their users
   are all in one Google Workspace (decides Internal vs External consent).
6. Which optional integrations they plan to use (Resend email, PandaDoc,
   Podio, ElevenLabs voice agent, Telnyx 10DLC, data providers).

Use their answers in place of `your-project-ref`, `crm.yourcompany.com` and
`talkr.yourcompany.com` below.

## Steps

Do the steps in order. After each one, run its check and compare with the
expected result before moving on. If a check fails, use
[Failure modes](#failure-modes) before trying anything else.

### Step 1. Tools

```sh
node --version
pnpm --version
supabase --version
psql --version
```

Expected: Node `v22.13.0` or later, pnpm `10.x`, a Supabase CLI version (the
repo's deploy workflow pins `2.117.0`), and any psql. If one is missing, tell
the person what to install; `npm install -g supabase@2.117.0` and
`npm install -g pnpm@10` are fine to run if they agree.

### Step 2. Install and run the demo

```sh
cd app
pnpm install --frozen-lockfile
pnpm build
```

Expected: the build finishes and `app/dist/client` exists
(`ls dist/client | head`). Optionally run `pnpm dev` and have the person open
http://localhost:3000/demo; the demo needs no backend.

### Step 3. Supabase project (person, by hand)

If they have no project, ask them to create one in the Supabase dashboard and
then to fill the secret files from the rules above:

| File | Contents | Where they find it |
| --- | --- | --- |
| `~/clozr-secrets/db-url` | Session pooler connection string with the password | Connect → Session pooler |
| `~/clozr-secrets/access-token` | personal access token | supabase.com/dashboard/account/tokens |
| `~/clozr-secrets/service-role-key` | legacy `service_role` key (starts with `eyJ`) | Project Settings → API Keys → Legacy API keys |

Ask them for the project ref and the publishable key in chat; both are public.

Check, without printing anything secret:

```sh
for f in db-url access-token service-role-key; do test -s ~/clozr-secrets/$f && echo "$f: present" || echo "$f: MISSING"; done
SUPABASE_ACCESS_TOKEN="$(cat ~/clozr-secrets/access-token)" supabase projects list
```

Expected: three `present` lines, and the project ref in the list.

### Step 4. Migrations

The folder starts with `0_baseline.sql` (the base schema) and ends with
`258_baseline_tail.sql`. Check:

```sh
ls app/supabase/migrations | sort -V | head -1
```

Expected: `0_baseline.sql`. If it is missing, stop and tell the person.

Apply, from `app/`:

```sh
export SUPABASE_DB_URL="$(cat ~/clozr-secrets/db-url)"
pnpm migrate:dry-run
pnpm migrate
pnpm migrate:status
```

Do not use `supabase db push`. The runner keeps its own ledger in
`public.applied_migrations`, and the file names do not follow the CLI's
timestamp scheme.

Expected: the dry run lists every file; `pnpm migrate` applies them in order
and stops at the first failure with the file name and error; `status` shows
nothing pending.

Check the cron jobs exist:

```sh
psql "$SUPABASE_DB_URL" -At -c "select count(*) from cron.job where jobname like 'clozr-%';"
```

Expected: a number above 20.

### Step 5. Vault secrets

From `app/`, with `SUPABASE_DB_URL` still exported:

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -v url="https://your-project-ref.supabase.co" \
  -v app="https://crm.yourcompany.com" \
  -v srk="$(cat ~/clozr-secrets/service-role-key)" <<'SQL'
select vault.create_secret(:'url', 'clozr_project_url');
select vault.create_secret(:'srk', 'clozr_service_role_key');
select vault.create_secret(:'app', 'clozr_app_url');
SQL
```

The SQL comes in on standard input so psql substitutes the variables (it does
not substitute them in `-c`). If a secret already exists, `create_secret`
fails on the duplicate name; update it with
`select vault.update_secret(id, :'srk') from vault.secrets where name = 'clozr_service_role_key';`
instead.

Check:

```sh
psql "$SUPABASE_DB_URL" -At -c "select name from vault.secrets where name like 'clozr_%' order by name;"
```

Expected exactly:

```
clozr_app_url
clozr_project_url
clozr_service_role_key
```

### Step 6. Edge functions

Ask the person to create `~/clozr-secrets/functions.env` with at least these
names (they type the values):

```
ANTHROPIC_API_KEY=
ALLOWED_ORIGINS=https://crm.yourcompany.com,http://localhost:3000
APP_URL=https://crm.yourcompany.com
TALKR_API_URL=https://talkr.yourcompany.com
TALKR_PARTNER_JWT_SECRET=
RESEND_API_KEY=
MAIL_FROM=Your Company <team@yourcompany.com>
```

You may write a template of this file with the non-secret lines filled and the
secret values empty, then ask them to fill it. For `TALKR_PARTNER_JWT_SECRET`
you may generate a value straight into the file without showing it:

```sh
printf 'TALKR_PARTNER_JWT_SECRET=%s\n' "$(openssl rand -base64 48)" >> ~/clozr-secrets/functions.env
```

Tell them Talkr needs the same value (step 9). Add `ANTHROPIC_WORKSPACE_ID` if
their Anthropic key is organization-level. The full list of optional secrets
is in the README under "Edge function secrets"; add only what they will use.

Deploy and set secrets, from `app/`:

```sh
export SUPABASE_ACCESS_TOKEN="$(cat ~/clozr-secrets/access-token)"
supabase functions deploy --project-ref your-project-ref
supabase secrets set --project-ref your-project-ref --env-file ~/clozr-secrets/functions.env
```

Check:

```sh
supabase functions list --project-ref your-project-ref | grep -c ACTIVE
supabase secrets list --project-ref your-project-ref
curl -s -o /dev/null -w "%{http_code}\n" https://your-project-ref.supabase.co/functions/v1/calendar-feed
```

Expected: `69` (or the number of folders in `app/supabase/functions` other
than `_shared`); the secret names you set, plus the platform's `SUPABASE_*`
entries; and `401` from the curl. A `404` means the functions are not on this
project.

### Step 7. Supabase Auth (person, by hand)

Ask the person to set these in the Supabase dashboard and tell you when done:

| Where | Setting | Value |
| --- | --- | --- |
| Authentication → URL Configuration | Site URL | `https://crm.yourcompany.com` |
| Authentication → URL Configuration | Redirect URLs | `https://crm.yourcompany.com/auth/callback` and `http://localhost:3000/auth/callback` |
| Authentication → Attack protection | Prevent use of leaked passwords | on |
| Authentication → Attack protection | Enable Captcha protection | optional: hCaptcha with their hCaptcha secret |
| Authentication → Multi-Factor | TOTP | leave enabled |

If they turn on hCaptcha, `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` must be set on the
frontend build in step 8; one without the other does not protect anything.

Check: ask them to confirm each row. You cannot read these settings from the
repository.

### Step 8. Frontend

Write `app/.env.local` for local runs (none of these values are secret):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<their publishable key>
NEXT_PUBLIC_SITE_URL=https://crm.yourcompany.com
NEXT_PUBLIC_TALKR_API_URL=https://talkr.yourcompany.com
```

Edit `app/vercel.json`: replace `your-project-ref` in the
`/oauth/google/callback` rewrite destination with their project ref. Show them
the diff.

**On Vercel (person, by hand, unless they have connected the Vercel CLI or
integration):**

| Setting | Value |
| --- | --- |
| Root Directory | `app` |
| Framework Preset | Other |
| Build, output and install commands | leave empty; `app/vercel.json` sets `pnpm build`, `dist/client`, `pnpm install --frozen-lockfile` |
| Environment Variables | the four `NEXT_PUBLIC_*` values above, plus `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` if used |
| Domains | `crm.yourcompany.com` |

**Another static host:** run `pnpm build` and serve `app/dist/client` with
clean URLs, the headers from `app/vercel.json`, and a proxy from
`/oauth/google/callback` to
`https://your-project-ref.supabase.co/functions/v1/google-oauth/callback` if
they will set `GOOGLE_REDIRECT_URI` to their domain.

Check:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://crm.yourcompany.com/login
curl -sI https://crm.yourcompany.com/login | grep -i content-security-policy
```

Expected: `200`, and a `Content-Security-Policy` header.

### Step 9. First owner, then Talkr

Ask the person to open `https://crm.yourcompany.com/login`, choose **Create an
account**, sign up, and confirm the email if Supabase asks. The sign-up
trigger creates their profile, a workspace and an `owner` membership.

Check:

```sh
psql "$SUPABASE_DB_URL" -At -c "select w.id, w.name, m.role from public.workspaces w join public.workspace_members m on m.workspace_id = w.id;"
```

Expected: one row ending in `|owner`. Keep the workspace id.

Talkr side (person, by hand, in their Talkr deployment):

| Talkr setting | Value |
| --- | --- |
| `WEB_ORIGIN` | includes `https://crm.yourcompany.com` and `http://localhost:3000` |
| `PARTNER_JWT_ISSUER` | `https://your-project-ref.supabase.co/auth/v1` |
| `PARTNER_JWKS_URL` or `PARTNER_JWT_SECRET` | per Talkr's docs, to verify Supabase session tokens |
| partner secret for CLOZR | the same value as `TALKR_PARTNER_JWT_SECRET` in `~/clozr-secrets/functions.env` |
| Team | each rep with the same email they use in CLOZR |

CLOZR side, once they give you their Talkr org id (not secret):

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v ws=<workspace id> -v org="<talkr org id>" <<'SQL'
insert into public.talkr_connections (workspace_id, talkr_org_id) values (:ws, :'org');
SQL
```

For Talkr's webhooks, the person mints a **Talkr** ingest key in Settings →
Workspace → Integrations, sets its signing secret there, and subscribes
`https://your-project-ref.supabase.co/functions/v1/talkr-webhook` in Talkr
with the same secret.

Check: Settings → Talkr → Account shows them linked; a test call from the
dialer appears on the record within a few minutes:

```sh
psql "$SUPABASE_DB_URL" -At -c "select status, start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'clozr-call-sync' order by start_time desc limit 3;"
```

Expected: recent rows with status `succeeded`.

### Step 10. Google (optional; the console part is by hand)

> **Bring your own Google OAuth client.** This repository ships no Google
> credentials; every client ID or secret in the code, tests and examples is a
> dummy and will not work. Tell the person they must create their own OAuth
> client in their own Google Cloud project. Never reuse a value you find in the
> repo, never write the client secret into a file that gets committed, and if
> the secret ever lands in git, a chat log or a public place, tell them to
> rotate it (Google Cloud → Credentials → the client → **Reset secret**) and
> update it everywhere it is stored.

Ask the person to do this in Google Cloud Console, with these exact values:

1. APIs & Services → Library: enable **Gmail API** and **Google Calendar
   API**; for add-ons also **Google Drive API**, **Gmail Postmaster Tools
   API** and **Site Verification API**.
2. OAuth consent screen: **Internal** if all users are in their Google
   Workspace, else **External** (add each rep as a test user while in
   Testing). Authorized domain: their apex domain, for example
   `yourcompany.com`. Scopes:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - add-ons: `https://www.googleapis.com/auth/drive.readonly`,
     `https://www.googleapis.com/auth/postmaster.readonly`,
     `https://www.googleapis.com/auth/siteverification`
3. Credentials → Create credentials → OAuth client ID → **Web application**.
   - Authorized JavaScript origins: leave empty.
   - Authorized redirect URIs:
     - `https://crm.yourcompany.com/oauth/google/callback` (if they want their
       domain on the consent screen; requires the vercel.json rewrite from
       step 8), **or**
       `https://your-project-ref.supabase.co/functions/v1/google-oauth/callback`
     - plus `https://your-project-ref.supabase.co/functions/v1/cold-pool/callback`
       if they will connect Google mailboxes to the cold email pool.

Then they add to `~/clozr-secrets/functions.env`:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://crm.yourcompany.com/oauth/google/callback
```

(the last line only if they registered that URI), and you run:

```sh
supabase secrets set --project-ref your-project-ref --env-file ~/clozr-secrets/functions.env
```

Tell them that `gmail.readonly` and `drive.readonly` are restricted scopes:
an External app in Testing has its refresh tokens expired by Google after 7
days, and publishing it needs Google's verification and security assessment.

Check: they click **Connect Google** in Settings → Outbound OS → Google and
come back to `/app` with a message naming their address. Then:

```sh
psql "$SUPABASE_DB_URL" -At -c "select email, status, last_calendar_sync_at from public.google_accounts;"
```

Expected: their address, `active`, and a timestamp within about five minutes.

### Step 11. Optional integrations

For each integration the person named in the first questions, look up its
secrets in the README ("Edge function secrets") and SETUP.md step 11. Have the
person append the values to `~/clozr-secrets/functions.env`, then run
`supabase secrets set --project-ref your-project-ref --env-file ~/clozr-secrets/functions.env`
again. Integrations configured in the app (Podio, iVueit, InvestorBase,
ingest keys, webhooks) are done by the person in Settings → Workspace →
Integrations.

Underwriting has no provider in this release. If they have a valuation
engine, the handler to replace is
`app/supabase/functions/compr-underwrite/index.ts`; its header comment lists
the files that define the request and response shapes. Redeploy with
`supabase functions deploy compr-underwrite --project-ref your-project-ref`.

## Failure modes

| What you see | What to do |
| --- | --- |
| `relation "public.workspace_members" does not exist` | `0_baseline.sql` did not run first. Run `pnpm migrate:status` and apply from the first pending file. |
| The runner stops on a file with an error | Read the error; do not edit an applied file. A fix is a new numbered file. Re-run `pnpm migrate`; it continues from the failed file. |
| Statement cut off after about a minute | You are on the Management API path. Use `SUPABASE_DB_URL`. |
| `Invalid project ref format` | Pass the 20-letter ref, not the URL. |
| `401`/`Unauthorized` from the Supabase CLI | The access token is wrong or expired (90-day lifetime). Ask the person to mint a new one into `~/clozr-secrets/access-token`. |
| Browser console shows CORS errors on `functions/v1/...` | Add the origin to `ALLOWED_ORIGINS` and set secrets again. |
| Cron rows show `failed`, or nothing reaches the functions | Re-check step 5; `clozr_service_role_key` must be the legacy JWT. Look at `select status_code, content from net._http_response order by created desc limit 5;`. |
| AI features reply that the key needs a workspace | Set `ANTHROPIC_WORKSPACE_ID`, or have the person create the key inside an Anthropic workspace. |
| Google `redirect_uri_mismatch` | The registered URI must equal `GOOGLE_REDIRECT_URI` exactly, or the Supabase function URL when that is unset. |
| "Google did not return a long-lived permission" | The person removes the app at myaccount.google.com/permissions and connects again. |
| `/oauth/google/callback` returns 404 on their domain | The rewrite in `app/vercel.json` is missing or still says `your-project-ref`; redeploy the frontend. |
| Talkr calls return 401 | Talkr's `PARTNER_JWT_ISSUER` does not match, or the rep's email is not on Talkr's Team page. |
| Calls work but never land on records | No `talkr_connections` row, or the partner secret differs between CLOZR and Talkr. |
| Magic links open the wrong site | Site URL and Redirect URLs in step 7, and `NEXT_PUBLIC_SITE_URL`. |
| Invites are not emailed | `RESEND_API_KEY` and `MAIL_FROM` are missing; the one-time password still shows once in Settings → Workspace → Team. |

## Final checklist

Report each line to the person as done or not done, with the check you ran:

- [ ] Tools present (step 1).
- [ ] `pnpm build` succeeds (step 2).
- [ ] Every migration applied, nothing pending, `clozr-*` cron jobs present
      (step 4).
- [ ] Three `clozr_*` Vault secrets (step 5).
- [ ] All edge functions deployed, core secrets set, `calendar-feed` answers
      `401` (step 6).
- [ ] Auth URL configuration and leaked-password protection confirmed by the
      person (step 7).
- [ ] Frontend serves `/login` with the CSP header on their domain (step 8).
- [ ] One workspace with the person as `owner` (step 9).
- [ ] Talkr bound to the workspace and a test call on a record (step 9).
- [ ] Google connected and synced, if wanted (step 10).
- [ ] Optional integrations they asked for configured (step 11).
- [ ] No secret was printed, pasted into chat, or written inside the
      repository.
