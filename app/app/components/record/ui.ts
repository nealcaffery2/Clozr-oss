// The seller record's shared inline styles: the app's own look (small
// uppercase tracked eyebrows, white bordered cards, the slate buttons), kept
// in one place so every record component reads the same.
import type React from 'react';

/** A group's label. Sentence case, not tracked capitals (DESIGN.md §1). */
export const eyebrow: React.CSSProperties = { fontSize: '13px', color: 'var(--ink, #18181b)', fontWeight: 650, letterSpacing: '-0.01em' };
/** Sentence-case label over a value or group (DESIGN.md §3: 11.5px / 500 / muted). */
export const label: React.CSSProperties = { fontSize: '11.5px', fontWeight: 500, color: 'var(--meta, #71717a)', lineHeight: 1.3 };
export const card: React.CSSProperties = { border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', background: 'var(--surface, #fff)' };
export const ghostBtn: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', border: 0, background: 'var(--surface, #fff)', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer', color: 'var(--ink, #18181b)', boxShadow: 'var(--shadow-ring)' };
export const primaryBtn: React.CSSProperties = { height: '30px', padding: '0 14px', borderRadius: '8px', border: 0, background: 'var(--c-action, #0A8560)', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 0 0 1px var(--c-action-2, #08694c), 0 1px 2px rgb(8 105 76 / .3)' };
export const hint: React.CSSProperties = { fontSize: '11.5px', color: 'var(--meta, #71717a)', lineHeight: 1.45 };
export const menuPanel: React.CSSProperties = { background: 'var(--c-menu-bg)', borderRadius: '12px', boxShadow: 'var(--shadow-md)', padding: '6px', animation: 'clozrPop .16s cubic-bezier(.23,1,.32,1)' };
export const menuItem: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', textAlign: 'left', minHeight: '34px', padding: '7px 10px', border: 0, borderRadius: '8px', background: 'none', fontSize: '12.5px', cursor: 'pointer', color: 'var(--ink, #18181b)', whiteSpace: 'nowrap' };
