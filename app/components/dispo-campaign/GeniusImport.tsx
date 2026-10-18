'use client';

// "Add a Genius pull": the owners a saved Genius run found buying near this
// house, brought into the campaign's audience. A house searched more than
// once lists every pull to pick from. Owners not yet skip-traced are traced
// first (a confirm says how many credits that can cost; owners traced before
// are free), owners with no phone or email are left out, and the rest are
// added to the buyer list or matched to the buyer already on file.

import React, { useEffect, useState } from 'react';
import { type PastRun, type Run, loadRun, propertyRuns } from '@/lib/genius';
import { type ImportResult, type ImportStep, importCounts, importRun } from '@/lib/genius-import';
import { Btn, C, Dialog, Note } from './ui';
import { plural } from './logic';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function GeniusImport({ workspaceId, dealId, address, userId, canWrite, demo, onImported }: {
  workspaceId: number; dealId: number; address: string | null; userId: string | null; canWrite: boolean; demo: boolean;
  /** The buyers to put in the audience, once they are on file. */
  onImported: (ids: number[]) => Promise<void>;
}) {
  const [runs, setRuns] = useState<PastRun[] | null>(demo ? [] : null);
  const [pick, setPick] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [step, setStep] = useState<ImportStep | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const choose = (id: number) => {
    setPick(id); setLoading(true); setRun(null); setResult(null);
    void loadRun(workspaceId, id).then((r) => { setRun(r); setLoading(false); });
  };

  useEffect(() => {
    if (demo) return;
    let live = true;
    void propertyRuns(workspaceId, dealId, address).then((r) => {
      if (!live) return;
      const done = r.filter((x) => x.status !== 'running' && (x.buyer_count ?? 0) > 0);
      setRuns(done);
      if (done[0]) choose(done[0].id);
    }).catch((e: Error) => { if (live) { setRuns([]); setErr(e.message); } });
    return () => { live = false; };
    // choose only reads the workspace, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dealId, address, demo]);

  const counts = run ? importCounts(run.candidates) : null;
  const busy = !!step;
  // A pull that was traced (all or part of it) adds the reachable owners as they are; the skip trace is offered only for a pull nobody traced.
  const needsTrace = !!counts && counts.reachable === 0 && counts.untraced > 0;

  const go = async () => {
    if (!run) return;
    setConfirm(false); setErr(null); setResult(null);
    setStep({ phase: needsTrace ? 'trace' : 'add', done: 0, of: needsTrace ? counts!.untraced : counts?.reachable ?? 0 });
    try {
      const r = await importRun(workspaceId, run, userId, setStep, { trace: needsTrace });
      if (r.ids.length) await onImported(r.ids);
      setResult(r);
      // The run on file now carries the traces and buyer links; read it again so the counts are current.
      const again = await loadRun(workspaceId, run.run_id ?? pick ?? 0);
      if (again) setRun(again);
    } catch (e) {
      setErr((e as Error).message);
    }
    setStep(null);
  };

  return (
    <section className="mk-card" style={{ padding: '14px 16px', display: 'grid', gap: '12px' }} aria-labelledby="mk-genius-h" data-testid="genius-import">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <span aria-hidden style={{ width: '30px', height: '30px', borderRadius: '8px', background: 'color-mix(in srgb, var(--c-genius) 12%, var(--surface, #fff))', color: 'var(--c-genius)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '13px', flex: 'none' }}>G</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="mk-genius-h" style={{ margin: 0, fontSize: '13.5px', fontWeight: 650 }}>Add a Genius pull</h2>
          <div style={{ fontSize: '12px', color: C.muted, marginTop: '2px', lineHeight: 1.45 }}>Owners Genius found buying near this house, skip-traced and reachable, join this campaign. Their emails are verified before anything is sent.</div>
        </div>
      </div>

      {demo ? <span style={{ fontSize: '12.5px', color: C.muted }}>Genius pulls are not part of the demo.</span>
        : runs === null ? <div className="mk-lb-skeleton" style={{ padding: 0 }} aria-busy="true" aria-label="Loading Genius pulls"><span /><span style={{ width: '70%' }} /></div>
          : !runs.length ? <span style={{ fontSize: '12.5px', color: C.muted }}>No Genius pull for this house yet. Run one from the deal&apos;s Genius tab, then add it here.</span>
            : (
              <>
                {runs.length > 1 ? (
                  <div role="radiogroup" aria-label="Genius pull" style={{ display: 'grid', gap: '6px' }}>
                    {runs.map((r) => (
                      <button key={r.id} type="button" role="radio" aria-checked={pick === r.id} disabled={busy} onClick={() => choose(r.id)} className="mk-chip mk-press"
                        style={{ height: 'auto', minHeight: '36px', padding: '6px 10px', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }}>
                        <span style={{ fontWeight: 600 }}>{day(r.created_at)}</span>
                        <span className="mk-num" style={{ color: C.muted }}>{plural(r.buyer_count ?? 0, 'owner')} · {r.radius_mi} mi · {r.months} months{r.deal_id === dealId ? '' : ' · searched by address'}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mk-num" style={{ fontSize: '12.5px' }}>Pull from <b>{day(runs[0].created_at)}</b> · {plural(runs[0].buyer_count ?? 0, 'owner')} within {runs[0].radius_mi} mi</div>
                )}

                {loading ? <span role="status" style={{ fontSize: '12.5px', color: C.muted }}>Reading the pull…</span> : counts ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }} data-testid="genius-counts">
                    <Count n={counts.total} k="owners" />
                    <Count n={counts.onFile} k="already buyers" />
                    <Count n={counts.reachable} k="traced, reachable" />
                    <Count n={counts.untraced} k="not traced yet" tone={counts.untraced ? C.amber : undefined} />
                  </div>
                ) : null}

                {step ? (
                  <div role="status" style={{ display: 'grid', gap: '6px' }}>
                    <span className="mk-num" style={{ fontSize: '12.5px' }}>{step.phase === 'trace' ? `Skip tracing ${Math.min(step.done + 25, step.of)} of ${step.of}…` : step.phase === 'verify' ? `Verifying their emails · ${Math.min(step.done + 200, step.of)} of ${step.of} buyers…` : `Adding ${step.done} of ${step.of} to buyers…`}</span>
                    <div className="mk-bar"><span style={{ transform: `scaleX(${step.of ? Math.max(0.03, step.done / step.of) : 0.03})` }} /></div>
                  </div>
                ) : null}

                {result ? (
                  <Note level={result.message ? 'warn' : 'info'}>
                    {plural(result.ids.length, 'buyer')} added to this campaign: {result.added} new, {result.matched} already on file.
                    {result.traced ? ` ${result.traced} skip-traced${result.cached ? `, ${result.cached} of them free from the cache` : ''}.` : ''}
                    {result.noContact ? ` ${result.noContact} had no phone or email and are left out.` : ''}
                    {result.message ? ` The skip trace stopped part way: ${result.message}` : ''}
                    {result.verified.error ? ` Email check did not run: ${result.verified.error}` : result.verified.checked ? ` ${result.verified.checked} emails checked: ${result.verified.safe} safe to send, ${result.verified.checked - result.verified.safe} held back.` : ''}
                  </Note>
                ) : null}
                {err ? <Note level="block">{err}</Note> : null}

                {counts && !step ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <Btn kind="primary" disabled={!canWrite || (needsTrace ? !counts.untraced : !counts.reachable)} title={!canWrite ? 'A dispositions role is needed' : undefined}
                      onClick={() => (needsTrace ? setConfirm(true) : void go())} data-testid="genius-add">
                      {needsTrace ? `Skip trace ${counts.untraced} and add` : `Add ${counts.reachable.toLocaleString('en-US')} traced ${counts.reachable === 1 ? 'buyer' : 'buyers'}`}
                    </Btn>
                    <span style={{ fontSize: '12px', color: C.muted2 }}>
                      {needsTrace ? 'Nobody in this pull is traced yet.'
                        : [counts.untraced ? `${counts.untraced} not traced stay out` : '', counts.noContact ? `${counts.noContact} traced with nothing found stay out` : ''].filter(Boolean).join(' · ') || 'Everyone reachable in this pull.'}
                    </span>
                  </div>
                ) : null}
              </>
            )}

      {confirm && counts ? (
        <Dialog title={`Skip trace ${plural(counts.untraced, 'owner')}?`} onClose={() => setConfirm(false)} actions={
          <>
            <Btn onClick={() => setConfirm(false)} data-autofocus>Cancel</Btn>
            <Btn kind="primary" onClick={() => void go()}>Skip trace and add</Btn>
          </>
        }>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: C.muted }}>
            Up to {plural(counts.untraced, 'skip-trace credit')}. Owners traced before come back from the cache for free. Then everyone with a phone or email
            ({counts.reachable} now, plus whoever the trace finds) is added to buyers, tagged genius, and put in this campaign.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

const Count = ({ n, k, tone }: { n: number; k: string; tone?: string }) => (
  <div style={{ padding: '8px 10px', borderRadius: '8px', background: C.surface2 }}>
    <div className="mk-num" style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', color: tone ?? C.ink }}>{n.toLocaleString('en-US')}</div>
    <div style={{ fontSize: '11.5px', color: C.muted }}>{k}</div>
  </div>
);
