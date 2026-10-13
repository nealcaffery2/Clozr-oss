// Shared styling for the phone settings: CLOZR's inline-style vocabulary.
'use client';

import React from 'react';
import { TalkrError } from '@/lib/talkr';
import { supabase } from '@/lib/supabase';

export const INK = '#18181b';
export const MUTED = '#71717a';
export const LINE = '#e4e4e7';
export const GREEN = '#0A8560';

export const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
export const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '5px' };
export const field: React.CSSProperties = { height: '32px', padding: '0 9px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '12.5px', outline: 0, background: '#fafafa', color: INK, minWidth: 0, fontFamily: 'inherit' };

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
        border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : '#fff', color: primary ? '#fff' : danger ? '#b91c1c' : INK,
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
    <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? '#dcfce7' : '#fee2e2', border: `1px solid ${note.ok ? '#bbf7d0' : '#fecaca'}`, color: note.ok ? GREEN : '#b91c1c', whiteSpace: 'pre-wrap' }}>
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
  const c = tone === 'green' ? { bg: '#E7F8F1', fg: GREEN } : tone === 'amber' ? { bg: '#fef3c7', fg: '#92400e' } : { bg: '#f4f4f5', fg: '#52525b' };
  return <span style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', padding: '2px 7px', borderRadius: '999px', background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{children}</span>;
}
