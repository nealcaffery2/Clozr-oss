/**
 * safeOrigin only ever hands back an allow-listed CLOZR origin, whatever a
 * request body or Origin header says. esign and google-sync build the links
 * that carry signing tokens from it. Run with:
 *   deno test --allow-env app/supabase/functions/_shared/parity/security.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { CLOZR_APP_ORIGIN } from '../app-url.ts';
import { safeOrigin } from './security.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const apply = (set: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  apply(vars);
  try {
    fn();
  } finally {
    apply(prev);
  }
}

Deno.test('safeOrigin ignores a foreign host in the body and the Origin header', () => {
  withEnv({ APP_URL: 'https://your-clozr-site.example.com', SITE_URL: undefined, DOCS_ALLOWED_ORIGINS: undefined }, () => {
    assertEquals(safeOrigin('https://evil.example', 'https://evil.example'), 'https://your-clozr-site.example.com');
    assertEquals(safeOrigin('https://evil.example/sign/', null), 'https://your-clozr-site.example.com');
    assertEquals(safeOrigin(undefined, undefined), 'https://your-clozr-site.example.com');
  });
});

Deno.test('safeOrigin keeps an allow-listed origin and skips past a foreign one', () => {
  withEnv({ APP_URL: 'https://your-clozr-site.example.com', SITE_URL: undefined, DOCS_ALLOWED_ORIGINS: 'https://app.clozr.com' }, () => {
    assertEquals(safeOrigin('https://app.clozr.com/', null), 'https://app.clozr.com');
    assertEquals(safeOrigin('https://evil.example', 'https://app.clozr.com'), 'https://app.clozr.com');
    assertEquals(safeOrigin(null, CLOZR_APP_ORIGIN), CLOZR_APP_ORIGIN);
  });
});

Deno.test('safeOrigin never returns a Talkr host, even from APP_URL', () => {
  withEnv({ APP_URL: 'https://talkr.example.com', SITE_URL: undefined, DOCS_ALLOWED_ORIGINS: undefined }, () => {
    assertEquals(safeOrigin('https://talkr.example.com', 'https://talkr.example.com'), CLOZR_APP_ORIGIN);
  });
});
