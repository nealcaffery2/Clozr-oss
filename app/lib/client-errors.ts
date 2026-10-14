// Errors thrown in the browser, written to public.client_errors (migration 262).
//
// CLOZR is a static export, so a screen that throws leaves nothing in Vercel
// or Supabase logs; the crash card only reached the person's own console. Each
// distinct error is now one row: who, which screen, the message and stack,
// the path and the build it ran on. Read them with
// `select * from client_errors_recent limit 50`.
//
// Reporting never throws and never retries: a failure to record a crash must
// not cause a second one. Per page load the same error is sent once and at
// most MAX_PER_LOAD rows go out, so a render loop cannot flood the table.

import { isChunkLoadError } from './chunk-reload';
import { supabase } from './supabase';

export type ClientErrorKind = 'screen' | 'app' | 'window' | 'promise';

export type ClientErrorRow = {
  kind: ClientErrorKind;
  where_at: string | null;
  message: string;
  stack: string | null;
  component_stack: string | null;
  path: string | null;
  release: string | null;
  user_agent: string | null;
};

const MAX_PER_LOAD = 20;

/** Noise no one can act on: browser quirks, extensions, opaque cross-origin errors. */
const IGNORE = /ResizeObserver loop|^Script error\.?$|chrome-extension:\/\/|moz-extension:\/\/|safari-(?:web-)?extension:\/\//i;

const clip = (s: string | null | undefined, n: number): string | null => {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t.slice(0, n) : null;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
    try { return JSON.stringify(error); } catch { /* fall through */ }
  }
  return String(error);
}

/**
 * The row for an error, or null when it should not be sent: chunk-load errors
 * (lib/chunk-reload.ts reloads onto the new deploy) and browser noise.
 */
export function toClientErrorRow(
  error: unknown,
  ctx: { kind: ClientErrorKind; where?: string | null; componentStack?: string | null; path?: string | null; release?: string | null; userAgent?: string | null },
): ClientErrorRow | null {
  if (isChunkLoadError(error)) return null;
  const message = clip(messageOf(error), 2000);
  if (!message) return null;
  const stack = error instanceof Error ? clip(error.stack, 8000) : null;
  if (IGNORE.test(message) || (stack && IGNORE.test(stack))) return null;
  return {
    kind: ctx.kind,
    where_at: clip(ctx.where, 200),
    message,
    stack,
    component_stack: clip(ctx.componentStack, 8000),
    path: clip(ctx.path, 500),
    release: clip(ctx.release, 80),
    user_agent: clip(ctx.userAgent, 400),
  };
}

/** Same error, same place: sent once per page load. */
export function errorKey(row: ClientErrorRow): string {
  return `${row.kind}|${row.where_at ?? ''}|${row.message}`;
}

const sent = new Set<string>();

/** The build this tab runs, when Vercel exposed it at build time. */
const RELEASE = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;

export function reportClientError(
  error: unknown,
  ctx: { kind: ClientErrorKind; where?: string | null; componentStack?: string | null },
): void {
  try {
    if (typeof window === 'undefined') return;
    const row = toClientErrorRow(error, {
      ...ctx,
      // Path only: query strings can carry signing and invite tokens.
      path: window.location.pathname + window.location.hash,
      release: RELEASE,
      userAgent: navigator.userAgent,
    });
    if (!row) return;
    const key = errorKey(row);
    if (sent.has(key) || sent.size >= MAX_PER_LOAD) return;
    sent.add(key);
    const client = supabase;
    if (!client) return;
    void client.auth.getSession()
      .then(async ({ data }) => {
        if (!data.session) return; // signed out: the table takes signed-in rows only
        await client.from('client_errors' as never).insert(row as never);
      })
      .catch(() => { /* recording a crash must never cause one */ });
  } catch {
    /* same */
  }
}

let installed = false;

/** Window-level errors that no React boundary sees: event handlers, timers, promises. */
export function installClientErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // Failed <script>/<link> loads are chunk reloads, handled in chunk-reload.
    if (e.target && e.target !== window) return;
    reportClientError(e.error ?? e.message, { kind: 'window' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError(e.reason, { kind: 'promise' });
  });
}
