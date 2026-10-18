'use client';

import React, { useId, useState } from 'react';
import { BLACKLIST_REASONS } from '@/lib/blacklist-reasons';

const btn: React.CSSProperties = {
  height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--tint-red-2, #fecaca)', background: 'var(--surface, #fff)',
  color: 'var(--tx-red, #b91c1c)', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap',
};

const field: React.CSSProperties = {
  width: '100%', height: 32, borderRadius: 8, border: '1px solid var(--divider, #e4e4e7)', padding: '0 10px',
  fontSize: 13, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)',
};

/**
 * Blacklist the current selection. Asks once, and asks why: the names land on
 * the secret list in Account, and a list nobody can explain six months later
 * gets restored wholesale. The reason goes back through onConfirm.
 */
export function BlacklistButton({
  count,
  names,
  onConfirm,
  disabledTitle = 'Select someone first',
}: {
  count: number;
  names: string[];
  onConfirm: (reason: string) => void;
  disabledTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [detail, setDetail] = useState('');
  const uid = useId();
  const ask = () => {
    if (!count) return;
    setPick('');
    setDetail('');
    setOpen(true);
  };
  // "Other" needs the words; a listed reason can stand alone or carry a note.
  const reason = pick === 'Other' ? detail.trim() : [pick, detail.trim()].filter(Boolean).join(': ');
  const ready = !!pick && (pick !== 'Other' || !!detail.trim());
  const who = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  return (
    <>
      <button type="button" className="dc2" title={count ? 'Move onto the secret blacklist' : disabledTitle} onClick={ask} disabled={!count}
        style={{ ...btn, opacity: count ? 1 : 0.45, cursor: count ? 'pointer' : 'not-allowed' }}>
        Blacklist{count ? ` ${count}` : ''}
      </button>
      {open ? (
        <div role="dialog" aria-modal="true" aria-label="Blacklist" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div style={{ width: 'min(420px, 100%)', background: 'var(--surface, #fff)', borderRadius: 14, border: '1px solid var(--divider, #e4e4e7)', padding: '16px 16px 14px', boxShadow: '0 24px 64px rgba(24,24,27,.24)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em' }}>Blacklist {count === 1 ? 'this person' : `${count} people`}?</div>
            <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--muted, #52525b)' }}>
              {who || 'This record'} leaves People and Buyers. The only place to see {count === 1 ? 'them' : 'them'} again is Account, where the list can be exported.
            </p>
            <label htmlFor={uid + '-r'} style={{ display: 'block', marginTop: 12, fontSize: 11.5, fontWeight: 500, color: 'var(--meta, #71717a)' }}>Reason</label>
            <select id={uid + '-r'} autoFocus value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...field, marginTop: 4 }}>
              <option value="">Pick a reason…</option>
              {BLACKLIST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <label htmlFor={uid + '-d'} style={{ display: 'block', marginTop: 8, fontSize: 11.5, fontWeight: 500, color: 'var(--meta, #71717a)' }}>
              {pick === 'Other' ? 'What happened' : 'Details (optional)'}
            </label>
            <input id={uid + '-d'} value={detail} maxLength={400} onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) { setOpen(false); onConfirm(reason); } }}
              placeholder={pick === 'Other' ? 'Say why, in a line' : 'Anything the next rep should know'} style={{ ...field, marginTop: 4 }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="dc2" onClick={() => setOpen(false)} style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', cursor: 'pointer', fontSize: 12.5 }}>Cancel</button>
              <button type="button" className="dc2" disabled={!ready} title={ready ? undefined : 'Pick a reason first'} onClick={() => { setOpen(false); onConfirm(reason); }} style={{ ...btn, background: '#b91c1c', color: '#fff', borderColor: '#b91c1c', opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }}>Blacklist</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
