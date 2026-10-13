'use client';

// "Skip trace" on a People or Buyers selection: what it will cost first, then
// a real count while it runs, then what landed on the records. The trace and
// its credit cap are Genius Mode's (lib/bulk-skip-trace.ts).

import React, { useEffect, useState } from 'react';
import { findBuyerAddresses, planTrace, runTrace, type TracePlan, type TraceRecord, type TraceSummary } from '@/lib/bulk-skip-trace';

const btn: React.CSSProperties = { height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid #e4e4e7', background: '#fff', fontSize: 12.5, color: '#18181b', cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap' };
const primary: React.CSSProperties = { ...btn, background: '#18181b', color: '#fff', border: '1px solid #18181b', fontWeight: 600 };
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

type Phase =
  | { at: 'planning' }
  | { at: 'ready'; plan: TracePlan }
  | { at: 'running'; plan: TracePlan; done: number }
  | { at: 'done'; plan: TracePlan; sum: TraceSummary };

export function BulkSkipTrace({ kind, records, workspaceId, canWrite, userId, toast, onDone, onClose }: {
  kind: 'seller' | 'buyer';
  records: TraceRecord[];
  workspaceId: number | null;
  canWrite: boolean;
  userId: string | null;
  toast: (msg: string, tone?: 'success' | 'error' | 'info') => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: 'planning' });
  const who = kind === 'seller' ? 'seller' : 'buyer';
  const recKey = records.map((r) => r.dbId).join(',');

  useEffect(() => {
    let live = true;
    void (async () => {
      const recs = kind === 'buyer' && canWrite && workspaceId != null ? await findBuyerAddresses(workspaceId, records) : records;
      const plan = await planTrace(canWrite ? workspaceId : null, recs);
      if (live) setPhase({ at: 'ready', plan });
    })();
    return () => { live = false; };
    // records is rebuilt every render; recKey is what changes the plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recKey, kind, workspaceId, canWrite]);

  const run = (plan: TracePlan) => {
    if (!canWrite || workspaceId == null) {
      toast(`Skip traced ${plural(plan.targets.length, who)} (demo)`);
      return onClose();
    }
    setPhase({ at: 'running', plan, done: 0 });
    void runTrace(workspaceId, plan, userId, (done) => setPhase({ at: 'running', plan, done })).then((sum) => {
      setPhase({ at: 'done', plan, sum });
      onDone();
      if (sum.message && sum.traced === 0) toast(sum.message, 'error');
    });
  };

  const n = records.length;
  return (
    <div role="region" aria-label="Skip trace" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 16px', background: '#fff', borderBottom: '1px solid #e4e4e7' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 650, color: '#18181b' }}>Skip trace {plural(n, who)}</span>
        <span style={{ flex: 1 }} />
        {phase.at !== 'running' ? <button type="button" onClick={onClose} style={{ ...btn, border: 0, color: '#71717a' }}>{phase.at === 'done' ? 'Close' : 'Cancel'}</button> : null}
      </div>
      {phase.at === 'planning' ? (
        <div role="status" style={{ fontSize: 12.5, color: '#71717a' }}>Checking addresses and the 90-day trace cache…</div>
      ) : phase.at === 'ready' ? (
        <>
          <div role="status" style={{ fontSize: 12.5, color: '#3f3f46', lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
            {phase.plan.targets.length
              ? <>Traces <b>{phase.plan.targets.length}</b> of {n} at {kind === 'seller' ? 'their property address' : 'their mailing address or a property they bought from you'}. </>
              : <>None of these {who}s have an address to trace at. </>}
            {phase.plan.noAddress.length ? <>{plural(phase.plan.noAddress.length, who)} with no address {phase.plan.noAddress.length === 1 ? 'is' : 'are'} skipped. </> : null}
            {phase.plan.cached ? <>{phase.plan.cached} traced in the last 90 days come back free. </> : null}
            {phase.plan.targets.length ? <>Cost: up to <b>{plural(phase.plan.credits, 'skip-trace credit')}</b>, counted against the Genius monthly cap.</> : null}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" disabled={!phase.plan.targets.length} onClick={() => run(phase.plan)} style={{ ...primary, opacity: phase.plan.targets.length ? 1 : 0.5, cursor: phase.plan.targets.length ? 'pointer' : 'not-allowed' }}>
              Skip trace {phase.plan.targets.length}{phase.plan.credits ? ` · ${plural(phase.plan.credits, 'credit')}` : ''}
            </button>
            <span style={{ fontSize: 12, color: '#71717a' }}>Blank phone and email are filled. Other numbers are kept{kind === 'seller' ? ' in a note on the lead' : ' on the buyer'}; nothing is overwritten.</span>
          </div>
        </>
      ) : phase.at === 'running' ? (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#3f3f46', fontVariantNumeric: 'tabular-nums' }}>
          <span>Tracing {phase.done} of {phase.plan.targets.length}…</span>
          <span style={{ width: 160, height: 4, borderRadius: 999, background: '#f0f0f1', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round((phase.done / Math.max(1, phase.plan.targets.length)) * 100)}%`, background: '#18181b' }} />
          </span>
        </div>
      ) : (
        <div role="status" style={{ fontSize: 12.5, color: '#3f3f46', lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
          Found contacts for <b>{phase.sum.found}</b> of {phase.sum.traced}. {plural(phase.sum.phones, 'phone')} and {plural(phase.sum.emails, 'email')} written back. {plural(phase.sum.credits, 'credit')} used.
          {phase.sum.failed ? <span style={{ color: '#b91c1c' }}> {phase.sum.failed} failed{phase.sum.message ? `: ${phase.sum.message}` : '.'}</span> : null}
        </div>
      )}
    </div>
  );
}
