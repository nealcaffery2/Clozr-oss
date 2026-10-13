/**
 * Unit tests for CLOZR app-origin resolution (invite / auth email links).
 * Run with: deno test app/supabase/functions/_shared/app-url.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { CLOZR_APP_ORIGIN, clozrAppOrigin, clozrLoginUrl, sanitizeClozrOrigin } from './app-url.ts';

Deno.test('sanitizeClozrOrigin accepts Clozr production', () => {
  assertEquals(sanitizeClozrOrigin('https://your-clozr-site.example.com/'), 'https://your-clozr-site.example.com');
  assertEquals(sanitizeClozrOrigin('https://clozrpreview-abc.vercel.app'), 'https://clozrpreview-abc.vercel.app');
});

Deno.test('sanitizeClozrOrigin rejects Talkr hosts', () => {
  assertEquals(sanitizeClozrOrigin('https://talkrdialer.com'), '');
  assertEquals(sanitizeClozrOrigin('https://www.talkrdialer.com/login'), '');
  assertEquals(sanitizeClozrOrigin('https://talkr-platform-preview.vercel.app'), '');
  assertEquals(sanitizeClozrOrigin('https://talkrphone.vercel.app'), '');
});

Deno.test('clozrAppOrigin prefers caller origin over Talkr APP_URL', () => {
  const prev = Deno.env.get('APP_URL');
  Deno.env.set('APP_URL', 'https://talkrdialer.com');
  try {
    assertEquals(clozrAppOrigin('https://your-clozr-site.example.com'), 'https://your-clozr-site.example.com');
    assertEquals(clozrAppOrigin(), CLOZR_APP_ORIGIN);
    assertEquals(clozrLoginUrl('https://your-clozr-site.example.com'), 'https://your-clozr-site.example.com/login');
  } finally {
    if (prev === undefined) Deno.env.delete('APP_URL');
    else Deno.env.set('APP_URL', prev);
  }
});

Deno.test('clozrAppOrigin falls back when preferred is Talkr', () => {
  const prev = Deno.env.get('APP_URL');
  Deno.env.set('APP_URL', 'https://your-clozr-site.example.com');
  try {
    assertEquals(clozrAppOrigin('https://talkrdialer.com'), 'https://your-clozr-site.example.com');
  } finally {
    if (prev === undefined) Deno.env.delete('APP_URL');
    else Deno.env.set('APP_URL', prev);
  }
});
