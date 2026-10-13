'use client';

// Buyers → Automations: trigger events that tag buyers from what they did.
// The rules are evaluated in the database (migration 54) daily and right after
// a deal is sent, replied to, marked or offered on; this card only switches
// them on and says what they mean.

import React, { useEffect, useState } from 'react';
import type { BuyerAutomationRuleRow } from '@/lib/database.types';
import { RULES, type RuleKey, loadRules, runRules, saveRule } from '@/lib/dispo-campaign';

type Draft = Pick<BuyerAutomationRuleRow, 'rule' | 'enabled' | 'n' | 'pct' | 'tag' | 'remove_when_false'> & { last_run_at: string | null };

const field: React.CSSProperties = { height: '28px', borderRadius: '7px', border: '1px solid #e4e4e7', padding: '0 8px', fontSize: '12.5px', background: '#fff' };
const btn = (primary = false): React.CSSProperties => ({ height: '28px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${primary ? '#0A8560' : '#e4e4e7'}`, background: primary ? '#0A8560' : '#fff', color: primary ? '#fff' : '#18181b', fontSize: '12px', fontWeight: 600, cursor: 'pointer' });

const HOW: Record<RuleKey, string> = {
  no_response: 'Their last N deals sent (deal matches with a sent date) all have no reply.',
  not_interested: 'Their last N deals sent are all marked not interested (a rep\'s mark on the campaign, or a reply that reads as a pass).',
  not_sent: 'No deal has been sent to them in N days, including buyers never sent one.',
  active_again: 'Their "Inactive until" date (buyer profile → Contact) is within the next N days.',
  no_status: 'They replied to each of their last N deals but none has a status (interested, not interested, offered) or an offer.',
  lowball: 'Their last N offers were each at or below P% of the deal\'s marketed price (else sold price, else contract + assignment fee).',
};

export function BuyerAutomations({ workspaceId, canWrite, onToast, onChanged, onClose }: { workspaceId: number | null; canWrite: boolean; onToast: (m: string) => void; onChanged: () => void; onClose: () => void }) {
  const [rules, setRules] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void loadRules(workspaceId).then((r) => {
      if (!live) return;
      const saved = r.ok ? r.data : [];
      setRules(RULES.map((d) => {
        const s = saved.find((x) => x.rule === d.rule);
        return s ? { rule: s.rule, enabled: s.enabled, n: s.n, pct: s.pct, tag: s.tag, remove_when_false: s.remove_when_false, last_run_at: s.last_run_at }
          : { rule: d.rule, enabled: false, n: d.n, pct: d.pct ?? 80, tag: d.tag, remove_when_false: false, last_run_at: null };
      }));
    });
    return () => { live = false; };
  }, [workspaceId]);

  const patch = (i: number, p: Partial<Draft>) => setRules((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const save = async (run: boolean) => {
    if (!workspaceId || !rules) return;
    setBusy(true);
    for (const r of rules) {
      const res = await saveRule(workspaceId, { rule: r.rule, enabled: r.enabled, n: Math.max(1, Math.min(365, r.n)), pct: Math.max(1, Math.min(100, r.pct)), tag: r.tag.trim() || RULES.find((d) => d.rule === r.rule)!.tag, remove_when_false: r.remove_when_false });
      if (!res.ok) { setBusy(false); return onToast(res.message); }
    }
    if (run) {
      const res = await runRules(workspaceId);
      setBusy(false);
      onToast(res.ok ? `Automations saved and run · ${res.data} tag change${res.data === 1 ? '' : 's'}` : res.message);
      if (res.ok) onChanged();
      return;
    }
    setBusy(false);
    onToast('Automations saved · they run daily and after campaign events');
  };

  return (
    <div style={{ background: '#fff', borderBottom: '1px solid #e4e4e7', padding: '12px 20px', display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 600, fontSize: '14px' }}>Buyer automations</span>
        <span style={{ fontSize: '12px', color: '#71717a' }}>Tag buyers when a trigger event is true. Runs daily and after sends, replies, marks and offers.</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ border: 0, background: 'none', fontSize: '12px', cursor: 'pointer', color: '#71717a' }}>Close</button>
      </div>
      {!workspaceId ? <div style={{ fontSize: '12.5px', color: '#a1a1aa' }}>Sign in to set up buyer automations.</div> : !rules ? <div style={{ fontSize: '12.5px', color: '#a1a1aa' }}>Loading…</div> : (
        <>
          {rules.map((r, i) => {
            const def = RULES.find((d) => d.rule === r.rule)!;
            return (
              <div key={r.rule} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '10px', alignItems: 'start', border: '1px solid #f0f0f1', borderRadius: '10px', padding: '10px' }}>
                <input type="checkbox" checked={r.enabled} disabled={!canWrite} onChange={(e) => patch(i, { enabled: e.target.checked })} style={{ accentColor: '#0A8560', marginTop: '6px' }} aria-label={`Enable: ${def.label(r.n, r.pct)}`} />
                <div style={{ display: 'grid', gap: '6px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', fontSize: '12.5px' }}>
                    <b>{def.label(r.n, r.pct)}</b>
                    <label>N <input type="number" min={1} max={365} value={r.n} disabled={!canWrite} onChange={(e) => patch(i, { n: Number(e.target.value) || 1 })} style={{ ...field, width: '60px' }} /> {def.unit}</label>
                    {r.rule === 'lowball' ? <label>P <input type="number" min={1} max={100} value={r.pct} disabled={!canWrite} onChange={(e) => patch(i, { pct: Number(e.target.value) || 80 })} style={{ ...field, width: '60px' }} /> %</label> : null}
                    <label>Tag <input value={r.tag} disabled={!canWrite} onChange={(e) => patch(i, { tag: e.target.value })} style={{ ...field, width: '150px' }} /></label>
                    <label style={{ display: 'inline-flex', gap: '5px', alignItems: 'center' }}><input type="checkbox" checked={r.remove_when_false} disabled={!canWrite} onChange={(e) => patch(i, { remove_when_false: e.target.checked })} style={{ accentColor: '#0A8560' }} /> Remove tag when no longer true</label>
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#71717a' }}>{HOW[r.rule]}{r.last_run_at ? ` Last run ${new Date(r.last_run_at).toLocaleString()}.` : ''}</div>
                </div>
              </div>
            );
          })}
          {canWrite ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button style={btn()} disabled={busy} onClick={() => void save(false)}>Save</button>
              <button style={btn(true)} disabled={busy} onClick={() => void save(true)}>{busy ? 'Working…' : 'Save and run now'}</button>
            </div>
          ) : <div style={{ fontSize: '12px', color: '#71717a' }}>Owners, admins and dispositions can change automations.</div>}
        </>
      )}
    </div>
  );
}
