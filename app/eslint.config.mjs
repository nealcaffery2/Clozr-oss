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
  {
    // The React Compiler rules analyse each hook as one unit, and useClozr is a
    // single ~14,000-line hook: on that file alone they ran past a 6 GB heap and
    // crashed CI lint. The app does not build with the compiler, so these rules
    // are advisory; rules-of-hooks and exhaustive-deps still run here.
    files: ['app/clozr/useClozr.ts'],
    rules: {
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/config': 'off',
      'react-hooks/gating': 'off',
    },
  },
]);

export default eslintConfig;
