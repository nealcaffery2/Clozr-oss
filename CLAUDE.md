# CLOZR

The app lives in `app/` (Next.js static export + Supabase). Build, lint and
type-check from there: `pnpm install`, `pnpm lint`, `pnpm typecheck`,
`pnpm build`. Pure-logic tests are `npx tsx tools/<name>.test.ts`.

## Terminal

When you need a terminal (git, pnpm, builds, scripts), use the `/terminal`
skill (`desktop-commander:terminal`) and run the commands yourself through
Desktop Commander. Don't hand Sam commands to run.

## Database migrations

- Files: `app/supabase/migrations/NNN_name.sql`, next number, idempotent SQL.
  Add a row to that folder's README. Everything else is in that README's
  "Applying them" section.
- Merging to `main` applies new files automatically: the Vercel production
  build runs `app/scripts/deploy-supabase.mjs` → `app/scripts/migrate.mjs`
  (ledger `public.applied_migrations`), and so does `.github/workflows/
  migrations.yml` when Actions is running.
  Nothing to run by hand after a merge; Actions → "Apply database migrations"
  → Run workflow shows `status`, `dry-run` or applies on demand.
- From a Claude session with the Supabase MCP: prefer letting the workflow
  apply. If you must run SQL directly, avoid `drop …`/`truncate`/writes to
  `supabase_migrations` (the MCP stalls waiting for a confirmation) and keep
  each statement under 60 seconds (batch updates by id range).
- Edge functions deploy on every push to `main` from the same Vercel build
  step (and `functions.yml` when Actions runs); nothing to do. Needs
  `SUPABASE_ACCESS_TOKEN` in Vercel's Production env.

## AI agent language (always)

Everything an AI agent writes or says follows the no-AI-slop rules
(`app/supabase/functions/_shared/no-ai-slop.ts`, adapted from
github.com/petergyang/no-ai-slop): no banned words, empty phrases or slop
patterns ("It's not X, it's Y", "Here's the thing", colon reveals, puffery,
recap endings, em dashes). A new prompt that writes for a person appends
`WRITING_RULE`; texts and emails to sellers, buyers or leads also carry
`MESSAGE_RULES` and go through `slopFindings()` before they send; call
prompts get `SPOKEN_RULES`. Tests: `npx tsx tools/no-ai-slop.test.ts`.

## Frontend design (always)

Any change to UI (screens, components, modals, emails, CSS) goes through the
house design skills, every time, no exceptions:

1. `app/DESIGN.md` is the authority: tokens, type scale, radius, copy rules,
   the banned "AI slop" tells. It wins any conflict with a skill's defaults.
   The same system lives in Claude Design as **CLOZR**
   (https://claude.ai/artifact/6kVxTLeQumxFz3dN2QMa2x): read its README there
   for tokens and components, and update it when `app/clozr/tokens.css` or
   DESIGN.md changes. The tokens in code win if the two disagree.
2. **impeccable** (`.claude/skills/impeccable`, from impeccable.style): load it
   before editing UI and follow its craft floor. Before pushing, run its slop
   detector on the rendered page (`.claude/skills/impeccable/scripts/impeccable
   detect <url-or-html>`; in cloud sessions set
   `IMPECCABLE_BROWSER=$PWD/.claude/chromium-no-sandbox`) and fix what it finds, or say in the PR why a finding stands.
3. **design-taste-frontend** (`.claude/skills/design-taste-frontend`, the
   taste-skill): apply its anti-slop rules that fit an operator app (full
   loading/empty/error states, visible labels above inputs, one accent, no
   placeholder-as-label, no generic data). Its landing-page rules do not apply
   to app screens.
4. Vercel's Web Interface Guidelines (vercel.com/design/guidelines) for
   interaction details: named icon buttons, ≥24px hit targets, focus rings,
   ellipsis on loading labels, confirm destructive actions.

Screenshot the result at desktop and phone width and look at it before
calling it done; include the screenshots in the PR.

## Compliance questions

Don't ask Sam about TCPA, opt-outs or messaging consent, and don't add
compliance gating he didn't ask for. He has counsel and adds it when he needs
it. Keep the suppression and opt-out handling that already exists working.
