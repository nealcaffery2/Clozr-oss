# CLOZR

The app lives in `app/` (Next.js static export + Supabase). Build, lint and
type-check from there: `pnpm install`, `pnpm lint`, `pnpm typecheck`,
`pnpm build`. Pure-logic tests are `npx tsx tools/<name>.test.ts`.

## Database migrations

- Files: `app/supabase/migrations/NNN_name.sql`, next number, idempotent SQL.
  Add a row to that folder's README. Everything else is in that README's
  "Applying them" section.
- Merging to `main` applies new files automatically (`.github/workflows/
  migrations.yml` → `app/scripts/migrate.mjs`, ledger `public.applied_migrations`).
  Nothing to run by hand after a merge; Actions → "Apply database migrations"
  → Run workflow shows `status`, `dry-run` or applies on demand.
- Keep each statement under 60 seconds (batch updates by id range): the
  Management API path cuts longer ones off.
- Edge functions deploy on every push to `main` (`functions.yml`); nothing to do.

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

Any change to UI (screens, components, modals, emails, CSS) follows
`app/DESIGN.md`: tokens, type scale, radius, copy rules and the banned "AI slop"
tells. The tokens in `app/app/clozr/tokens.css` are the source of truth. Give
every screen full loading, empty and error states, visible labels above inputs,
one accent colour, named icon buttons, hit targets of at least 24px, focus
rings, an ellipsis on loading labels, and a confirmation on destructive actions.

Screenshot the result at desktop and phone width and look at it before
calling it done; include the screenshots in the PR.
