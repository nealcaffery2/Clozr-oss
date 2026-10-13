// A contract waiting on the person who is signed in. The link opens here,
// in a popup, instead of making them leave for email and type a code.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { type MineToSign, myContractsToSign } from '@/lib/contracts';

const poppedKey = (workspaceId: number) => `clozr-sign-popped:${workspaceId}`;

function readPopped(workspaceId: number): Set<number> {
  try {
    const raw = sessionStorage.getItem(poppedKey(workspaceId));
    return new Set(raw ? raw.split(',').map(Number).filter((n) => Number.isFinite(n)) : []);
  } catch { return new Set(); }
}

export function SignPrompt({ workspaceId, email }: { workspaceId: number; email: string }) {
  const [queue, setQueue] = useState<MineToSign[]>([]);
  const [popup, setPopup] = useState<MineToSign | null>(null);
  const [signing, setSigning] = useState<MineToSign | null>(null);

  const load = useCallback(async () => {
    const rows = await myContractsToSign(workspaceId, email);
    setQueue(rows);
    const seen = readPopped(workspaceId);
    const fresh = rows.find((r) => !seen.has(r.signerId));
    if (fresh) setPopup((cur) => cur ?? fresh);
  }, [workspaceId, email]);

  useEffect(() => {
    // The first read is scheduled, like the interval and focus refresh. Calling
    // load() in the effect body is a setState the hooks lint rejects.
    const start = window.setTimeout(() => { void load(); }, 0);
    const id = window.setInterval(() => { void load(); }, 60000);
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearTimeout(start); window.clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [load]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'clozr-signed') return;
      setSigning(null);
      setPopup(null);
      void load();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [load]);

  function remember(item: MineToSign) {
    const seen = readPopped(workspaceId);
    seen.add(item.signerId);
    try { sessionStorage.setItem(poppedKey(workspaceId), [...seen].join(',')); } catch { /* private mode: the popup can return next load */ }
  }

  function later() {
    if (popup) remember(popup);
    setPopup(null);
  }

  function open(item: MineToSign) {
    remember(item);
    setPopup(null);
    setSigning(item);
  }

  if (!queue.length && !signing) return null;
  const top = queue[0];

  return (
    <>
      {top && !signing ? (
        <div style={{ position: 'fixed', right: '16px', bottom: '16px', zIndex: 85, width: 'min(360px, calc(100vw - 32px))', background: '#fff', border: '1px solid #A8ECD2', borderRadius: '14px', boxShadow: '0 16px 40px rgba(0,0,0,.16)', padding: '14px 16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#0A8560' }}>Needs your signature</div>
          <div style={{ fontSize: '15px', fontWeight: 700, marginTop: '4px' }}>{top.name}</div>
          <div style={{ fontSize: '12.5px', color: '#52525b', marginTop: '2px' }}>You are the {top.label.toLowerCase()}{queue.length > 1 ? ` · ${queue.length} waiting` : ''}</div>
          <button type="button" onClick={() => open(top)} style={{ marginTop: '12px', width: '100%', height: '44px', border: 0, borderRadius: '10px', background: '#0A8560', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}>Sign now</button>
        </div>
      ) : null}

      {popup && !signing ? (
        <div role="dialog" aria-modal="true" aria-label="Contract to sign" style={{ position: 'fixed', inset: 0, zIndex: 86, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
          <div style={{ width: 'min(420px, 100%)', background: '#fff', borderRadius: '16px', padding: '22px 22px 18px', boxShadow: '0 24px 70px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#0A8560' }}>New contract</div>
            <h2 style={{ margin: '6px 0 0', fontSize: '20px', letterSpacing: '-0.02em' }}>{popup.name}</h2>
            <p style={{ margin: '8px 0 0', fontSize: '14px', color: '#52525b', lineHeight: 1.45 }}>This is waiting on you as {popup.label}. Sign it here — no email, no code.</p>
            <button type="button" onClick={() => open(popup)} style={{ marginTop: '16px', width: '100%', height: '48px', border: 0, borderRadius: '12px', background: '#0A8560', color: '#fff', fontSize: '16px', fontWeight: 700, cursor: 'pointer' }}>Sign now</button>
            <button type="button" onClick={later} style={{ marginTop: '8px', width: '100%', height: '36px', border: 0, background: 'none', color: '#71717a', fontSize: '13px', cursor: 'pointer' }}>Later</button>
          </div>
        </div>
      ) : null}

      {signing ? (
        <div role="dialog" aria-modal="true" aria-label={`Sign ${signing.name}`} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(24,24,27,.55)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: '#fff', borderBottom: '1px solid #e4e4e7' }}>
            <span style={{ fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sign · {signing.name}</span>
            <button type="button" onClick={() => { setSigning(null); void load(); }} style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>Close</button>
          </div>
          <iframe title={`Sign ${signing.name}`} src={signing.url} style={{ flex: 1, width: '100%', border: 0, background: '#fafafa' }} />
        </div>
      ) : null}
    </>
  );
}
