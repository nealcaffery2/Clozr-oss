'use client';

// Deal sheet reminders, popped at the side: the first few unread ones for the
// rep on that section. Opening one goes to the deal sheet; dismissing it clears
// it from the bell too, until tomorrow if the section is still blank.

import React from 'react';
import type { ClozrView } from './view';

const KICKER: Record<string, { label: string; color: string }> = {
  Acquisitions: { label: 'Acquisitions', color: '#0A8560' },
  Dispositions: { label: 'Dispositions', color: '#ff7a45' },
  Coordination: { label: 'Transaction coordination', color: '#1f7a4d' },
};

export function SectionGapPops({ V }: { V: ClozrView }) {
  const pops = V.sectionGapPops;
  if (!pops.length || V.isMobile) return null;
  return (
    <div role="region" aria-label="Deal sheet reminders" style={{ position: 'fixed', right: '16px', bottom: 'calc(16px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px) + var(--clozr-todaybar, 0px))', zIndex: 95, display: 'flex', flexDirection: 'column', gap: '8px', width: 'min(340px, calc(100vw - 32px))' }}>
      {pops.map((p) => {
        const k = KICKER[p.cat] ?? { label: p.cat, color: '#71717a' };
        return (
          <div key={p.id} style={{ position: 'relative' }}>
            <button type="button" aria-label="Dismiss until tomorrow" title="Dismiss until tomorrow" onClick={p.dismiss} style={{ position: 'absolute', top: 4, right: 4, zIndex: 1, width: 28, height: 28, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: '#71717a', cursor: 'pointer' }}>
              <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <button type="button" onClick={p.open} style={{ width: '100%', textAlign: 'left', border: '1px solid #e4e4e7', borderLeft: `3px solid ${k.color}`, background: '#fff', borderRadius: '12px', padding: '10px 36px 10px 12px', boxShadow: '0 12px 30px rgba(28,29,31,.14)', cursor: 'pointer', animation: 'clozrFade .18s', color: '#18181b' }}>
              <div style={{ fontSize: '11.5px', fontWeight: 800, color: k.color }}>{k.label} · deal sheet</div>
              <div style={{ marginTop: '3px', fontSize: '13px', fontWeight: 600, lineHeight: 1.4 }}>{p.text}</div>
            </button>
          </div>
        );
      })}
      {V.sectionGapMore > 0 || pops.length > 1 ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', fontSize: '12px' }}>
          {V.sectionGapMore > 0 ? <span style={{ color: '#71717a', alignSelf: 'center' }}>{V.sectionGapMore} more in the bell</span> : null}
          <button type="button" onClick={V.dismissSectionGaps} style={{ border: '1px solid #e4e4e7', background: '#fff', borderRadius: '8px', padding: '4px 10px', fontWeight: 600, color: '#3f3f46', cursor: 'pointer' }}>Dismiss all</button>
        </div>
      ) : null}
    </div>
  );
}
