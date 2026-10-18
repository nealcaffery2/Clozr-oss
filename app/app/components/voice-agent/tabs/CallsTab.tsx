// AI Agent, Calls and stats: this agent's numbers for the last 30 days, then
// its recent calls. `basis` says which numbers are exact and which are
// keyword heuristics, and is shown as a footnote rather than left out.
'use client';

import React, { useEffect, useState } from 'react';
import { statTiles, statsFor } from '@/lib/voice-agent-console';
import type { StatsResult } from '@/lib/voice-agent';
import { Banner, Section, Skeleton, Stat, ghost } from '../kit';
import { RecentCalls } from '../RecentCalls';
import type { TabCtx } from '../types';

type Load = { at: 'loading' } | { at: 'ready'; stats: StatsResult } | { at: 'error'; error: string };

export function CallsTab({ api, agentKey, epoch, admin, onOpenRecord }: TabCtx) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    void api.stats(agentKey, 30).then((r) => { if (live) setLoad(r.ok ? { at: 'ready', stats: r.data } : { at: 'error', error: r.error }); });
    return () => { live = false; };
  }, [api, agentKey, nonce, epoch]);

  const tiles = load.at === 'ready' ? statTiles(statsFor(load.stats, agentKey)) : [];
  return (
    <>
      <Section id="va-stats" title="Last 30 days" description="How this agent's calls went.">
        {load.at === 'loading' ? (
          <div aria-busy="true" aria-label="Loading stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 10 }}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={66} style={{ borderRadius: 10 }} />)}</div>
        ) : load.at === 'error' ? (
          <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>Could not load the stats. {load.error}</Banner>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 10 }}>
              {tiles.map((t) => <Stat key={t.key} label={t.label} value={t.value} hint={t.hint} />)}
            </div>
            <div style={{ margin: '12px 0 0', display: 'grid', gap: 4 }}>
              {Object.entries(load.stats.basis).map(([k, v]) => (
                <p key={k} style={{ margin: 0, fontSize: 11.5, color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>{k === 'booked_and_transferred' ? 'Booked and transferred' : k === 'dnc_requests_and_not_interested' ? 'Do not contact and not interested' : k.replace(/_/g, ' ')}: </span>{v}
                </p>
              ))}
            </div>
          </>
        )}
      </Section>
      <RecentCalls api={api} agentKey={agentKey} epoch={epoch} canScore={admin} onOpenRecord={onOpenRecord} />
    </>
  );
}
