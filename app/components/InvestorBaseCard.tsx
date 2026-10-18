'use client';

// Settings → Integrations. The InvestorBase key from Account → Integrations
// there. Saving replaces it; an empty save disconnects. The value is write-only.

import React, { useEffect, useState } from 'react';
import { investorbaseConnected, saveInvestorbaseKey } from '@/lib/investorbase';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const muted: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
const field: React.CSSProperties = { height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '13px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', outline: 0, flex: 1, minWidth: '180px', fontFamily: 'ui-monospace, monospace' };
const btn: React.CSSProperties = { height: '34px', padding: '0 12px', borderRadius: '8px', border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' };

export function InvestorBaseCard({ workspaceId, admin, demo }: { workspaceId: number | null; admin: boolean; demo: boolean }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId || demo) return;
    let live = true;
    void investorbaseConnected(workspaceId).then((on) => { if (live) setConnected(on); });
    return () => { live = false; };
  }, [workspaceId, demo]);

  async function save(next: string) {
    if (!workspaceId || !admin || demo) return;
    setBusy(true);
    setNote(null);
    const r = await saveInvestorbaseKey(workspaceId, next);
    setBusy(false);
    if (!r.ok) { setNote(r.message ?? 'Could not save the key.'); return; }
    setKey('');
    setConnected(next.trim().length > 0);
    setNote(next.trim() ? 'InvestorBase key saved. Genius can import buyers for an address.' : 'InvestorBase disconnected.');
  }

  return (
    <section style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 650 }}>InvestorBase</h2>
      <p style={muted}>
        Paste the API key from InvestorBase → Account → Integrations. Genius imports the buyers for an address straight onto Buyer Prospects.
        {connected ? ' A key is saved.' : connected === false ? ' No key saved yet.' : ''}
      </p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="password"
          autoComplete="off"
          value={key}
          disabled={!admin || demo || busy}
          placeholder={connected ? 'Key saved — paste to replace' : 'InvestorBase API key'}
          onChange={(e) => setKey(e.target.value)}
          style={field}
        />
        <button type="button" disabled={!admin || demo || busy || key.trim().length < 8} onClick={() => void save(key)} style={{ ...btn, opacity: !admin || demo || busy || key.trim().length < 8 ? 0.55 : 1 }}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
        {connected ? (
          <button type="button" disabled={!admin || demo || busy} onClick={() => void save('')} style={{ ...btn, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', borderColor: 'var(--divider, #e4e4e7)' }}>
            Disconnect
          </button>
        ) : null}
      </div>
      {note ? <p style={{ ...muted, margin: '10px 0 0', color: 'var(--ink-3, #3f3f46)' }}>{note}</p> : null}
      {!admin ? <p style={{ ...muted, margin: '10px 0 0' }}>An owner or admin saves the key.</p> : null}
    </section>
  );
}
