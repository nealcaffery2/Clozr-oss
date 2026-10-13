'use client';

/**
 * A vendor list grouped the way the team looks for someone: a title company,
 * then each of its offices, with the main point of contact first and starred;
 * photographers and notaries by state, then town, so "who covers Knoxville"
 * is one glance. Selection, call and the bulk bar are the same rows the flat
 * table uses (V.vendorRows), so nothing here is a second source of truth.
 */

import React, { useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { TypeChip } from '@/components/TypeChip';
import { reachClick } from '@/app/components/record/reach';

const cap: React.CSSProperties = { fontSize: '11.5px', color: '#71717a', fontWeight: 600 };
const link: React.CSSProperties = { background: 'none', border: 0, padding: 0, fontSize: '12px', cursor: 'pointer', color: '#0A8560', fontWeight: 500 };

export function VendorGroups({ V }: { V: ClozrView }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const groups = V.vendorGroups ?? [];
  if (!groups.length) {
    return <div style={{ padding: '28px 20px', fontSize: '13px', color: '#71717a' }}>Nobody matches these filters.</div>;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa', padding: V.isMobile ? '10px 10px calc(96px + env(safe-area-inset-bottom, 0px))' : '14px 16px 60px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : 'repeat(auto-fill, minmax(380px, 1fr))', gap: '12px', alignItems: 'start' }}>
        {groups.map((g) => {
          const isClosed = !!closed[g.key];
          return (
            <section key={g.key} style={{ background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', overflow: 'hidden' }}>
              <button onClick={() => setClosed((c) => ({ ...c, [g.key]: !c[g.key] }))} aria-expanded={!isClosed}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '12px 14px', border: 0, background: 'none', cursor: 'pointer', borderBottom: isClosed ? 0 : '1px solid #f0f0f1' }}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: '14px', color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                  <span style={{ display: 'block', fontSize: '11.5px', color: '#71717a', marginTop: '1px' }}>{g.sub}</span>
                </span>
                {!g.hasMain && !V.vendorGroupsByPlace ? <span style={{ fontSize: '10.5px', fontWeight: 600, color: '#d97706', whiteSpace: 'nowrap' }}>No main contact</span> : null}
                <span style={{ fontSize: '11px', color: '#a1a1aa' }}>{isClosed ? '▸' : '▾'}</span>
              </button>
              {isClosed ? null : g.locations.map((loc) => (
                <div key={loc.key} style={{ padding: '8px 14px 4px' }}>
                  <div style={{ ...cap, color: loc.label.startsWith('No ') || loc.label.startsWith('Town not') ? '#d97706' : '#71717a' }}>📍 {loc.label}</div>
                  {loc.rows.map((r) => (
                    <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '18px 22px minmax(0,1fr)', gap: '6px', alignItems: 'start', padding: '8px 0', borderBottom: '1px solid #f4f4f5', background: r.checked ? '#E7F8F1' : 'transparent' }}>
                      <input type="checkbox" checked={!!r.checked} onChange={r.toggle} aria-label={`Select ${r.contact}`} style={{ width: '14px', height: '14px', accentColor: '#0A8560', marginTop: '2px', cursor: 'pointer' }} />
                      <button onClick={r.setMainPoc} title={r.mainPoc ? 'Main point of contact here — click to clear' : 'Make the main point of contact here'}
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: '15px', lineHeight: 1, color: r.mainPoc ? '#d97706' : '#d4d4d8' }}>
                        {r.mainPoc ? '★' : '☆'}
                      </button>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: '13px', color: '#18181b' }}>{r.contact === '—' ? r.name : r.contact}</span>
                          {r.mainPoc ? <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#d97706' }}>Main POC</span> : null}
                          {V.vendorGroupsByPlace || r.contact === '—' || r.name === g.title ? null : <span style={{ fontSize: '11.5px', color: '#a1a1aa' }}>{r.name}</span>}
                          {V.vendorShowType ? <TypeChip kind={r.kind} /> : null}
                        </span>
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: '3px', fontSize: '12px' }}>
                          {r.phone !== '—' ? <button className="dc12 clozr-contact" onClick={r.call} style={{ ...link, color: undefined }}>{r.phone}</button> : null}
                          {r.email !== '—' ? <a className="clozr-contact" href={`mailto:${r.email.split(/[;,]/)[0].trim()}`} onClick={(e) => reachClick(e, 'email', { name: r.contact === '—' ? r.name : r.contact, email: r.email.split(/[;,]/)[0].trim(), phone: r.phone !== '—' ? r.phone : null })} style={{ color: 'inherit', textDecoration: 'none', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.email}</a> : null}
                          {r.phone === '—' && r.email === '—' ? <span style={{ color: '#a1a1aa' }}>No phone or email</span> : null}
                        </span>
                        {r.markets && r.markets !== r.state ? <span style={{ display: 'block', fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>Serves {r.markets}</span> : null}
                        <button onClick={r.editLocation} style={{ ...link, fontSize: '11px', color: '#71717a', marginTop: '3px' }}>{r.location ? 'Change location' : 'Set location'}</button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
