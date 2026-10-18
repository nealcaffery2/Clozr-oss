// Shared styling for the phone settings: CLOZR's inline-style vocabulary.
'use client';

import React from 'react';
import { TalkrError } from '@/lib/talkr';
import { supabase } from '@/lib/supabase';

export const INK = 'var(--ink, #18181b)';
export const MUTED = 'var(--meta, #71717a)';
export const LINE = 'var(--divider, #e4e4e7)';
export const GREEN = '#0A8560';

export const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
export const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '5px' };
export const field: React.CSSProperties = { height: '32px', padding: '0 9px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '12.5px', outline: 0, background: 'var(--canvas, #fafafa)', color: INK, minWidth: 0, fontFamily: 'inherit' };

export function Btn({ primary, danger, disabled, onClick, children, title, small }: {
  primary?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode; title?: string; small?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={primary ? 'dc3' : 'dc2'}
      style={{
        height: small ? '26px' : '30px', padding: small ? '0 8px' : '0 11px', borderRadius: '8px', fontSize: small ? '11.5px' : '12px', fontWeight: 600, whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
        border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : danger ? '#b91c1c' : INK,
      }}
    >
      {children}
    </button>
  );
}

export type Note = { ok: boolean; text: string } | null;

export function NoteBox({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? GREEN : '#b91c1c', whiteSpace: 'pre-wrap' }}>
      {note.text}
    </div>
  );
}

export function errText(err: unknown): string {
  if (err instanceof TalkrError) {
    const errors = (err.body as { errors?: string[] } | null)?.errors;
    return errors?.length ? `${err.message}\n• ${errors.join('\n• ')}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * supabase.functions.invoke with the function's own answer kept on a non-2xx:
 * the SDK only says "returned a non-2xx status code" and leaves the body (the
 * part that names what to fix) on error.context.
 */
export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  if (!supabase) return { data: null, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data: data as T, error: null };
  let parsed: T | null = null;
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') parsed = (await ctx.json()) as T;
  } catch { /* not JSON */ }
  return { data: parsed, error: (parsed as { error?: string } | null)?.error ?? error.message };
}

export function Pill({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'green' | 'grey' | 'amber' }) {
  const c = tone === 'green' ? { bg: 'var(--mint-dim, #e7f8f1)', fg: GREEN } : tone === 'amber' ? { bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' } : { bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--muted, #52525b)' };
  return <span style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', padding: '2px 7px', borderRadius: '999px', background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{children}</span>;
}
