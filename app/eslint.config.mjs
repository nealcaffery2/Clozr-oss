import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
    // Supabase edge functions run on Deno with their own globals and jsr:
  // imports; they are deployed from here but are not part of this program.
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'supabase/functions/**']),
  {
    rules: {
      // next/link is unusable in this build. vinext ships its own Link, and in
      // the static export both of its paths throw: the RSC prefetch fails with
      // "d is not a function" on mount, and clicking throws "e is not a
      // function" out of startTransition, so navigation silently does nothing.
      // Plain anchors do full page loads, which is what crossing between the
      // marketing page, the auth pages and the app should do anyway.
      //
      // Revisit if vinext's Link starts working; until then this rule points at
      // the broken option.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    // The Inbox is Talkr's messages page, copied component-for-component from
    // A:\talkr\apps\web so it stays byte-comparable with the source. Talkr does
    // not run the React Compiler rules, and its idioms (a ref mirrored during
    // render, a clock started in a mount effect, a draft re-synced from a prop)
    // trip them. Rewriting every effect would be a fork, not a port.
    // Talkr's sequences pages (app/components/sequences) are the same kind of port.
    files: ['app/components/talkr/**', 'lib/talkr-web/**', 'app/components/sequences/**'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
]);

export default eslintConfig;
