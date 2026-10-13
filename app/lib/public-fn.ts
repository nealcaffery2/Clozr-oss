// Calling an edge function from a page with no CLOZR login (signing, form
// links, verify). The function checks its own credential (signing token, form
// slug); the error body's `error` becomes the message.
import { supabase } from '@/lib/supabase';

export type PublicRes<T> = { ok: true; data: T } | { ok: false; message: string };

export async function publicFn<T>(fn: string, body: Record<string, unknown>): Promise<PublicRes<T>> {
  if (!supabase) return { ok: false, message: 'This page is not configured.' };
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message; } catch { /* keep */ }
    return { ok: false, message };
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) return { ok: false, message: String((data as { error: string }).error) };
  return { ok: true, data: data as T };
}
