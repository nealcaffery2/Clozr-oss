# Security Policy

CLOZR is a CRM for real-estate acquisition companies. A deployment holds
seller names, phone numbers and addresses, deal economics, call transcripts and
buyer lists, so we take security and responsible disclosure seriously.

This policy covers the code in this repository. Each deployment of it is run
by its own operator; report a problem with someone's deployment to them.

## Reporting a vulnerability

Please report any suspected security vulnerability **privately**. Use GitHub's private vulnerability reporting: the repository's **Security**
tab → **Report a vulnerability**.

Do **not** open a public GitHub issue, post on social media, or disclose the
issue to a third party before we have had a reasonable opportunity to
investigate and remediate.

When reporting, please include:

- A clear description of the vulnerability
- Steps to reproduce, or a proof-of-concept
- The potential impact (data exposure, account takeover, cross-workspace read, etc.)
- Any relevant logs, screenshots, or sample requests
- Your name and contact info if you'd like to be credited

## Our commitment

- We will acknowledge receipt within **3 business days**.
- We will provide an initial assessment within **10 business days**.
- We will work with you in good faith to remediate the issue and keep you
  informed of progress.
- For meaningful, in-scope reports, we will publicly credit the reporter (with
  permission) once the issue is fixed.

## Security posture

CLOZR is a static web app on top of Supabase (Postgres, Auth, Edge Functions)
and the Talkr Platform for telephony. There is no application server of our
own: the controls below are enforced in the database, in the edge functions,
and in the third-party platforms' own configuration. The full design is in
[`docs/security.md`](docs/security.md).

- **Identity & sessions**: Supabase-issued JWTs. Every data read and write is
  made as the signed-in user and filtered by Postgres row-level security; the
  workspace and role come from the `workspace_members` table, never from the
  client. Accounts may enroll **TOTP two-factor** (Account → Two-factor
  authentication); when enrolled, a code is required at sign-in (`aal1 → aal2`
  step-up) and the app refuses to open without it. Sign-up, sign-in, magic-link
  and reset forms carry an **hCaptcha** token when the project enables it.
- **Tenant isolation**: every table carries `workspace_id`; RLS partitions all
  rows by membership, with role-based policies (owner, admin, acquisitions,
  dispositions, TC) on buyers, offers, transactions, invites and members.
  Signed-in users hold only SELECT/INSERT/UPDATE/DELETE on tables (never
  TRUNCATE, TRIGGER or REFERENCES); the anonymous role holds nothing.
- **Privileged operations**: issuing API keys, storing webhook signing
  secrets, replaying events and rotating the calendar token are `SECURITY
  DEFINER` functions that require the owner or admin role and pin
  `search_path`. Every other definer function is revoked from `anon`,
  `authenticated` and `PUBLIC`.
- **Machine access**: integrations post to one door (`/ingest`) with a
  256-bit API key stored as a SHA-256 hash and compared in constant time; the
  workspace is derived from the key, never the body. Talkr webhooks are
  HMAC-SHA256 signed with a 5-minute replay window. Calendar feeds use a
  192-bit token.
- **Rate limiting & abuse control**: a shared, database-backed fixed-window
  limiter caps failed key lookups per address, per-key ingest volume, webhook
  and calendar polling per address, and per-user calls to the billable AI
  functions.
- **Input validation & error hygiene**: request bodies are shape-checked;
  database and vendor error text is logged server-side and never returned to
  the browser.
- **Prompt-injection hygiene**: seller notes, call history, goals and imported
  spreadsheets are fenced as untrusted data before they reach any AI model,
  and the model is told so.
- **Secrets**: Anthropic and the Supabase service role live only as
  edge-function secrets; Twilio, Deepgram and Talkr credentials live only on
  the Talkr Platform. The browser receives the Supabase publishable key,
  which is designed to be public, and nothing else. Nothing secret is
  committed to the repo.
- **Transport & browser**: HTTPS with HSTS (preload), a Content-Security-Policy
  that names every script origin, `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` and
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (so sign-in popups
  can hand the session back through `window.opener`).
  Edge-function responses carry `nosniff`, `no-store` and `no-referrer`, and
  answer CORS only for allow-listed origins once `ALLOWED_ORIGINS` is set.
- **Auditability**: `audit_log` is append-only (triggers refuse UPDATE and
  DELETE, service role included) and records every change to memberships,
  invites, API keys, signing secrets and workspace settings, with hashes and
  secrets redacted. Owners and admins can read their workspace's trail.
- **Supply chain & CI**: every pull request runs lint, type-check, the
  production build, a production-dependency audit and Semgrep static analysis
  as required gates; Dependabot keeps dependencies and GitHub Actions patched.

### Hardening changelog

- **2026-09**, security review pass: closed an RLS policy
  that let any signed-in user add themselves to any workspace with any role;
  removed TRUNCATE/TRIGGER/REFERENCES from signed-in users and every table
  privilege from the anonymous role; admin-gated the key, secret, replay and
  token-rotation functions; added the append-only audit log, the shared rate
  limiter, generic error bodies, CORS allow-listing, prompt-injection fencing,
  TOTP two-factor with sign-in step-up, optional hCaptcha, the CSP and
  hardening headers, and the CI security gates.

## In scope

- The CLOZR web application
- The Supabase edge functions under `/functions/v1/*`
- Authentication, session, and authorization flows, including two-factor
- Row-level security and tenant isolation
- The ingest API and the Talkr webhook receiver

## Out of scope / not eligible

- Third-party services we depend on (Supabase, Vercel, Twilio, Deepgram,
  Anthropic, Google Maps Platform, hCaptcha): please report those directly to
  their security teams.
- The Talkr Platform itself, which has its own policy in its repository.
- Self-XSS or attacks requiring physical access to the victim's device.
- Reports based purely on missing security headers without a concrete attack
  scenario.
- Denial-of-service via volumetric attack.
- Findings produced solely by automated scanners, without manual validation
  and a reproducible exploit chain.
- Social engineering of the operator's employees, customers, or contractors.

## Safe harbor

We will not pursue legal action against researchers who:

1. Make a good-faith effort to comply with this policy
2. Avoid privacy violations, destruction of data, and disruption of service
   during testing
3. Use only the listed reporting channel and refrain from public disclosure
   until we have addressed the issue
4. Do not access or modify data belonging to third parties
