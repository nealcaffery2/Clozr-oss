'use client';

// The Buyers list's bulk bar: delete, send a deal, tag for Genius, enroll the
// buyers that fit a deal in an action plan. Mirrors People's bar; the writes
// live in lib/crm-write.ts. Nothing is sent or enrolled without a confirm.

import React, { useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { buyerFitsForDeal, deleteBuyers, enrollBuyersInPlan, exportBuyersCsv, markDealSent, setBuyerStage, tagBuyers, untagBuyers } from '@/lib/crm-write';
import { BUYER_STAGES } from '@/lib/stages';
import { useSession } from '@/lib/session';
import { BulkCompose, type BulkPerson } from '@/app/components/bulk/BulkCompose';
import { BulkSkipTrace } from '@/components/BulkSkipTrace';
import { BulkAgentPanel } from '@/app/components/ai-agent/BulkAgentPanel';
import { AssignPanel, SelectCount } from '@/app/components/bulk/AssignPanel';
import { ActionsMenu } from '@/app/components/bulk/ActionsMenu';
import { firstN, inListOrder } from '@/lib/bulk-assign';

type Bulk = ClozrView['buyerBulk'];
type Mode = null | 'market' | 'rvm' | 'plan' | 'campaign' | 'enroll' | 'unenroll' | 'trace' | 'ai' | 'assign' | 'stage';

const btn: React.CSSProperties = { flex: 'none', whiteSpace: 'nowrap', height: '28px', padding: '0 10px', borderRadius: '7px', border: '1px solid rgba(10, 133, 96,.25)', background: '#fff', fontSize: '12px', color: '#18181b', cursor: 'pointer', fontWeight: 500 };
const field: React.CSSProperties = { height: '30px', borderRadius: '7px', border: '1px solid #e4e4e7', padding: '0 8px', fontSize: '12.5px', background: '#fff' };
const label: React.CSSProperties = { fontSize: '11.5px', color: '#71717a', fontWeight: 600 };


/** `compact`: one sideways-scrolling row, for a phone, where fourteen wrapped buttons took half the screen. */
export function BuyerBulkBar({ bulk, selectedIds, onClear, compact, list = [], onSelect }: {
  bulk: Bulk; selectedIds: string[]; onClear: () => void; compact?: boolean;
  /** The list as shown (sorted, filtered), for "Select [N]" and assigning in list order. */
  list?: { id: string; assigned?: string | null }[];
  /** Replace the selection (Select [N]). */
  onSelect?: (ids: string[]) => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const n = selectedIds.length;
  const { toast } = bulk;
  const done = (msg: string) => { setBusy(false); setMode(null); onClear(); bulk.reload?.(); toast(msg); };

  const del = () => {
    if (!window.confirm(`Delete ${n} buyer${n === 1 ? '' : 's'}? Buyers a deal, offer or contract still names are set Inactive instead. This cannot be undone.`)) return;
    if (!bulk.canWrite) return toast(`Deleted ${n} (demo)`);
    setBusy(true);
    void deleteBuyers(selectedIds).then((r) => {
      if (!r.ok) { setBusy(false); return toast(r.message || 'Nothing was deleted.'); }
      done(`${r.deleted} deleted${r.deactivated ? ` · ${r.deactivated} set Inactive (still on a deal, offer or contract)` : ''}`);
    });
  };
  const genius = () => {
    if (!bulk.canWrite) return toast(`Tagged ${n} for Genius (demo)`);
    setBusy(true);
    void tagBuyers(selectedIds, 'genius').then((r) => (r.ok ? done(`${n} tagged for Genius`) : (setBusy(false), toast(r.message || 'That did not save.'))));
  };
  const retag = (add: boolean) => {
    const tag = window.prompt(`Tag to ${add ? 'add to' : 'remove from'} ${n} buyer${n === 1 ? '' : 's'}:`);
    if (!tag?.trim()) return;
    if (!bulk.canWrite) return toast(`${add ? 'Tagged' : 'Removed'} (demo)`);
    setBusy(true);
    void (add ? tagBuyers : untagBuyers)(selectedIds, tag).then((r) => (r.ok ? done(`${add ? 'Tagged' : 'Removed'} "${tag.trim()}" · ${n}`) : (setBusy(false), toast(r.message || 'That did not save.'))));
  };

  const stage = (to: string) => {
    if (!to) return;
    if (!bulk.canWrite) return toast(`Moved ${n} to ${to} (demo)`);
    setBusy(true);
    void setBuyerStage(selectedIds, to).then((r) => (r.ok ? done(`${n} moved to ${to}`) : (setBusy(false), toast(r.message || 'That did not save.'))));
  };
  // The selection in list order (map picks, which are not rows, go last) so blocks follow the list.
  const ordered = (() => {
    const inList = inListOrder(list.map((b) => b.id), new Set(selectedIds));
    const seen = new Set(inList);
    return [...inList, ...selectedIds.filter((id) => !seen.has(id))];
  })();
  const selectFirst = (k: number, unassignedOnly = false) => onSelect?.(firstN(list, k, unassignedOnly ? (b) => !b.assigned : undefined));
  const exportCsv = () => {
    if (!bulk.canWrite) return toast(`Exported ${n} (demo)`);
    setBusy(true);
    void exportBuyersCsv(selectedIds).then((r) => { setBusy(false); toast(r.ok ? `Exported ${n} buyer${n === 1 ? '' : 's'}` : r.message || 'Could not export.'); });
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: compact ? 'nowrap' : 'wrap', overflowX: compact ? 'auto' : undefined, gap: '6px', padding: compact ? '8px 12px' : '8px 16px', background: '#F0FAF5', borderBottom: '1px solid rgba(10, 133, 96,.2)', animation: 'clozrFade .14s' }}>
        <span style={{ flex: 'none', fontSize: '12.5px', fontWeight: 600, color: '#08694C', marginRight: '8px', whiteSpace: 'nowrap' }}>{n.toLocaleString('en-US')} selected</span>
        <button className="dc11" disabled={busy} onClick={() => setMode(mode === 'ai' ? null : 'ai')} aria-pressed={mode === 'ai'}
          title="Switch an AI agent on or off for these buyers. VIPs and funds are always skipped."
          style={{ ...btn, border: '1px solid rgba(10,133,96,.35)', background: mode === 'ai' ? '#E7F5EF' : 'linear-gradient(90deg,#F0FAF5,#ecfdf5)', color: '#08694C', fontWeight: 700 }}>
          ✦ AI agent
        </button>
        <button className="dc11" disabled={busy} onClick={() => setMode(mode === 'assign' ? null : 'assign')} aria-pressed={mode === 'assign'}
          title="Assign to one teammate, or split between several in list order" style={{ ...btn, background: mode === 'assign' ? '#E7F8F1' : '#fff' }}>
          Assign
        </button>
        <button className="dc11" disabled={busy} onClick={() => setMode(mode === 'market' ? null : 'market')} style={btn}>Send to marketing</button>
        <button className="dc11" disabled={busy} onClick={() => { onClear(); void bulk.addToCallQueue(selectedIds); }} style={btn}>Add to call queue</button>
        {/* Everything else under Actions ▾ (app/components/bulk/ActionsMenu). */}
        <ActionsMenu accent="#0A8560" actions={[
          { key: 'rvm', label: 'RVM', group: 'Reach out', note: 'ringless voicemail', run: () => setMode('rvm') },
          { key: 'campaign', label: 'Build campaign', group: 'Reach out', run: () => setMode('campaign') },
          { key: 'plan', label: 'Enroll for a deal', group: 'Reach out', run: () => setMode('plan') },
          { key: 'stage', label: 'Move to stage…', group: 'Organize', run: () => setMode('stage') },
          { key: 'tag', label: 'Add tag', group: 'Organize', run: () => retag(true) },
          { key: 'untag', label: 'Remove tag', group: 'Organize', run: () => retag(false) },
          { key: 'genius', label: 'Tag for Genius', group: 'Organize', run: genius },
          { key: 'enroll', label: 'Add to action plan', group: 'Organize', run: () => setMode('enroll') },
          { key: 'pause', label: 'Pause action plans', group: 'Organize', run: () => {
            if (!window.confirm(`Pause the action plan on ${n} buyer${n === 1 ? '' : 's'}?`)) return;
            bulk.pauseFromPlan(selectedIds);
          } },
          { key: 'unenroll', label: 'Stop action plans', group: 'Organize', run: () => {
            if (!window.confirm(`Stop the action plan on ${n} buyer${n === 1 ? '' : 's'}?`)) return;
            bulk.removeFromPlan(selectedIds);
            onClear();
          } },
          { key: 'trace', label: 'Skip trace', group: 'Data', note: 'find phones & emails', run: () => setMode('trace') },
          { key: 'export', label: 'Export', group: 'Data', note: 'CSV', run: exportCsv },
          { key: 'delete', label: 'Delete', group: 'Remove', danger: true, run: del },
        ].map((a) => ({ ...a, disabled: busy }))} />
        <div style={{ flex: 1 }} />
        {busy ? <span style={{ fontSize: '12px', color: '#08694C' }}>Working…</span> : null}
        {onSelect && list.length ? <SelectCount listCount={list.length} ownerAware onSelect={selectFirst} /> : null}
        <button onClick={onClear} style={{ height: '28px', padding: '0 10px', border: 0, background: 'none', fontSize: '12px', color: '#08694C', cursor: 'pointer' }}>Clear</button>
      </div>
      {mode === 'assign' ? (
        <AssignPanel noun={{ one: 'buyer', many: 'buyers' }} team={bulk.team} selectedIds={ordered} listCount={list.length || n}
          canWrite={bulk.canWrite} onSelectFirst={(k) => selectFirst(k)} onClose={() => setMode(null)}
          onAssign={async (blocks) => { if (await bulk.assign(blocks)) { setMode(null); onClear(); } }} />
      ) : null}
      {mode === 'stage' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '8px 14px', background: '#fff', borderBottom: '1px solid #e4e4e7' }}>
          <span style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, alignSelf: 'center', marginRight: '4px' }}>Move to</span>
          {BUYER_STAGES.map((st) => (
            <button key={st} type="button" className="dc2" disabled={busy} onClick={() => stage(st)} style={{ ...btn, background: '#fff' }}>{st}</button>
          ))}
          <button type="button" onClick={() => setMode(null)} style={{ height: '28px', padding: '0 8px', border: 0, background: 'none', fontSize: '12px', cursor: 'pointer', color: '#71717a' }}>Cancel</button>
        </div>
      ) : null}
      {mode === 'market' ? <Market bulk={bulk} selectedIds={selectedIds} onClose={() => setMode(null)} /> : null}
      {mode === 'rvm' ? <Market bulk={bulk} selectedIds={selectedIds} channel="rvm" onClose={() => setMode(null)} /> : null}
      {mode === 'campaign' ? <Campaign bulk={bulk} selectedIds={selectedIds} onClose={() => setMode(null)} /> : null}
      {mode === 'plan' ? <Plan bulk={bulk} selectedIds={selectedIds} onClose={() => setMode(null)} onDone={done} /> : null}
      {mode === 'trace' ? (
        <BulkSkipTrace
          kind="buyer"
          records={selectedIds.flatMap((id) => (bulk.buyers[id] ? [{ kind: 'buyer' as const, dbId: bulk.buyers[id].dbId, name: bulk.buyers[id].name, company: bulk.buyers[id].company }] : []))}
          workspaceId={bulk.workspaceId}
          canWrite={bulk.canWrite}
          userId={session.user?.id ?? null}
          toast={bulk.toast}
          onDone={() => bulk.reload?.()}
          onClose={() => setMode(null)}
        />
      ) : null}
      {mode === 'ai' ? (
        <BulkAgentPanel workspaceId={bulk.workspaceId} canWrite={bulk.canWrite} selectedIds={selectedIds} records={bulk.buyers} toast={toast}
          onClose={() => setMode(null)} onDone={(msg) => { setMode(null); onClear(); bulk.reload?.(); toast(msg); }} />
      ) : null}
      {mode === 'enroll' ? <EnrollSimple bulk={bulk} selectedIds={selectedIds} onClose={() => setMode(null)} onDone={done} /> : null}
    </>
  );
}

function Panel({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 16px', background: '#fff', borderBottom: '1px solid #e4e4e7' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={label}>{title}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ border: 0, background: 'none', fontSize: '12px', cursor: 'pointer', color: '#71717a' }}>Cancel</button>
      </div>
      {children}
    </div>
  );
}

function DealPick({ bulk, value, onChange }: { bulk: Bulk; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...field, minWidth: '280px' }}>
      <option value="">{bulk.deals.length ? 'Pick an active deal…' : 'No active deals (Under Contract Seller, Ready To Market, Buyer Under Contract)'}</option>
      {bulk.deals.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
    </select>
  );
}

/** Buyers -> Send to marketing: the shared bulk composer, after they pick which deal (app/components/bulk/BulkCompose.tsx). */
function Market({ bulk, selectedIds, channel, onClose }: { bulk: Bulk; selectedIds: string[]; channel?: 'sms' | 'rvm'; onClose: () => void }) {
  const session = useSession();
  // The sender's own signature fields: {{rep_phone}} and {{rep_email}} in the dispo templates.
  const rep = { ...bulk.textCtx, repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' };
  const people: BulkPerson[] = selectedIds.flatMap((id) => {
    const b = bulk.buyers[id];
    return b ? [{ id, dbId: b.dbId, name: b.name, phone: b.phone, email: b.email, pref: b.pref, inactive: b.inactive, blacklisted: b.blacklisted }] : [];
  });
  return (
    <BulkCompose
      kind="buyer"
      channel={channel}
      people={people}
      deals={bulk.deals}
      requireDeal
      workspaceId={bulk.workspaceId}
      canWrite={bulk.canWrite}
      userId={session.user?.id ?? null}
      rep={rep}
      testTo={session.user?.email ?? null}
      toast={bulk.toast}
      // Marking the deal sent is what makes a buyer "already sent this one".
      onSent={async ({ dealId, sentDbIds }) => { if (dealId) await markDealSent(dealId, sentDbIds); }}
      // The composer shows its own report, so closing just refreshes what it changed.
      onClose={() => { onClose(); bulk.reload?.(); }}
    />
  );
}


/** Hand the selection to a deal's campaign builder (components/DispoCampaign.tsx) on its dispo property. */
function Campaign({ bulk, selectedIds, onClose }: { bulk: Bulk; selectedIds: string[]; onClose: () => void }) {
  const [dealId, setDealId] = useState('');
  return (
    <Panel title={`Build a campaign for ${selectedIds.length} buyer${selectedIds.length === 1 ? '' : 's'}`} onClose={onClose}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <DealPick bulk={bulk} value={dealId} onChange={setDealId} />
        <button className="clozr-genius-btn" disabled={!dealId || !bulk.canWrite} onClick={() => bulk.openCampaign(Number(dealId), selectedIds.flatMap((id) => (bulk.buyers[id] ? [bulk.buyers[id].dbId] : [])))} style={{ ...btn, background: '#0A8560', color: '#fff', border: '1px solid #0A8560' }}>
          Open campaign builder
        </button>
        {!bulk.canWrite ? <span style={{ fontSize: '12px', color: '#71717a' }}>Sign in to build a campaign.</span> : <span style={{ fontSize: '12px', color: '#71717a' }}>They start ticked in the builder, alongside the deal&apos;s matched buyers.</span>}
      </div>
    </Panel>
  );
}

function Plan({ bulk, selectedIds, onClose, onDone }: { bulk: Bulk; selectedIds: string[]; onClose: () => void; onDone: (m: string) => void }) {
  const [dealId, setDealId] = useState('');
  const [planId, setPlanId] = useState('');
  const [fits, setFits] = useState<{ buyerId: number; score: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const deal = bulk.deals.find((d) => String(d.id) === dealId);

  const check = (v: string) => {
    setDealId(v); setFits(null);
    const d = bulk.deals.find((x) => String(x.id) === v);
    if (!d) return;
    if (!bulk.canWrite) return setFits([]);
    setBusy(true);
    void buyerFitsForDeal(d.id, selectedIds).then((r) => {
      setBusy(false);
      if (!r.ok) return bulk.toast(r.message || 'Could not score buyers against that deal.');
      setFits(r.fits ?? []);
    });
  };
  const enroll = () => {
    if (!deal || !fits?.length || !planId || bulk.workspaceId === null) return;
    const byDb = new Map(Object.values(bulk.buyers).map((b) => [b.dbId, b.name]));
    setBusy(true);
    void enrollBuyersInPlan(bulk.workspaceId, planId, deal.id, fits.map((f) => ({ id: f.buyerId, name: byDb.get(f.buyerId) || '' })), deal.fields, bulk.me)
      .then((r) => {
        setBusy(false);
        if (!r.ok) return bulk.toast((r.message || 'Could not enroll.') + (r.enrolled ? ` (${r.enrolled} enrolled before this)` : ''));
        onDone(`${r.enrolled} enrolled · ${r.queued} touches queued${r.already ? ` · ${r.already} already on the plan` : ''}`);
      });
  };

  return (
    <Panel title="Enroll buyers that fit a deal" onClose={onClose}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <DealPick bulk={bulk} value={dealId} onChange={check} />
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} style={{ ...field, minWidth: '200px' }}>
          <option value="">{bulk.plans.length ? 'Pick an active plan…' : 'No active plans yet'}</option>
          {bulk.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px' }}>
        {!bulk.canWrite ? <span style={{ color: '#71717a' }}>Sign in to score buyers against a deal.</span>
          : busy ? <span style={{ color: '#0A8560' }}>Working…</span>
            : fits ? (
              <>
                <span><b>{fits.length}</b> of {selectedIds.length} selected buyers fit this deal (match score 55+).</span>
                <button className="clozr-genius-btn" disabled={!fits.length || !planId} onClick={() => { if (window.confirm(`Enroll ${fits.length} buyer${fits.length === 1 ? '' : 's'} in this plan for ${deal?.fields.address}?`)) enroll(); }} style={{ ...btn, background: '#0A8560', color: '#fff', border: '1px solid #0A8560' }}>
                  Enroll {fits.length}
                </button>
              </>
            ) : <span style={{ color: '#71717a' }}>Pick a deal to see which buyers fit its buy box.</span>}
      </div>
    </Panel>
  );
}

/**
 * Add selected buyers to a plan saved in the Builder, no deal match required.
 * Every plan is offered: buyer and TC plans first, then the rest, so a plan
 * someone just built shows up here even before its audience is set.
 */
function EnrollSimple({ bulk, selectedIds, onClose, onDone }: { bulk: Bulk; selectedIds: string[]; onClose: () => void; onDone: (m: string) => void }) {
  const [planId, setPlanId] = useState('');
  const all = bulk.allPlans;
  const forBuyers = (a: string) => a === 'buyer' || a === 'tc';
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const buyerPlans = all.filter((p) => forBuyers(p.audience)).sort((a, b) => Number(b.active) - Number(a.active) || byName(a, b));
  const otherPlans = all.filter((p) => !forBuyers(p.audience)).sort((a, b) => Number(b.active) - Number(a.active) || byName(a, b));
  const picked = all.find((p) => p.id === planId);
  const label = (p: (typeof all)[number]) => `${p.name}${p.steps ? ` · ${p.steps} step${p.steps === 1 ? '' : 's'}` : ''}${p.active ? '' : ' · paused'}`;
  const n = selectedIds.length;
  return (
    <Panel title={`Add ${n} buyer${n === 1 ? '' : 's'} to an action plan`} onClose={onClose}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} style={{ ...field, minWidth: '260px', maxWidth: '100%' }} aria-label="Action plan">
          <option value="">{all.length ? 'Pick a plan…' : 'No plans yet. Build one in Action plans'}</option>
          {buyerPlans.length ? (
            <optgroup label="Buyer plans">
              {buyerPlans.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </optgroup>
          ) : null}
          {otherPlans.length ? (
            <optgroup label="Other plans">
              {otherPlans.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </optgroup>
          ) : null}
        </select>
        <button
          className="clozr-genius-btn"
          disabled={!planId}
          onClick={() => {
            if (!window.confirm(`Enroll ${n} buyer${n === 1 ? '' : 's'} in ${picked?.name ?? 'this plan'}?`)) return;
            bulk.enrollInPlan(planId, selectedIds);
            onDone(`Enrolling ${n}…`);
          }}
          style={{ ...btn, background: '#0A8560', color: '#fff', border: '1px solid #0A8560' }}
        >
          Enroll {n}
        </button>
        {picked && !forBuyers(picked.audience) ? (
          <span style={{ fontSize: '12px', color: '#b45309' }}>Built for {picked.audience === 'source' ? 'wholesaler sources' : 'sellers'}: check its wording fits a buyer.</span>
        ) : picked && !picked.active ? (
          <span style={{ fontSize: '12px', color: '#71717a' }}>Paused plans still queue their steps as tasks.</span>
        ) : null}
      </div>
    </Panel>
  );
}
