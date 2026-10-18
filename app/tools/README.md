# tools

Pure-logic tests live here (`npx tsx tools/<name>.test.ts`), plus:

- `theme-codemod.mjs`: moves inline neutral hex literals onto the theme tokens
  (`var(--token, #literal)`) so dark mode reaches generated screens. Run it on
  your files before a PR: `node tools/theme-codemod.mjs app/components/people`
  (files or folders; prints a count per file; idempotent).
  `node tools/theme-codemod.mjs --check <paths>` lists files still carrying
  neutral literals. Brand, status and heat fills are left alone; a block
  painted with a brand colour is left whole so white text on it stays white;
  add `theme:keep` to a line to skip it. The header comment has the rules.
