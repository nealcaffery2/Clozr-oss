'use client';

// The dispo property's Marketing tab: campaign results, the one-screen
// campaign (QuickCampaign: who, how, what it says, launch), and behind an
// "Advanced builder" click the full composer, Audience → Message → Review,
// beside a live preview and a summary rail.
// Every number and name on it comes from the workspace's rows; launch hands the
// exact reviewed messages to dispo_campaign_launch (migration 53) and the
// server sends them on schedule (dispo-campaign-tick), browser open or not.
//
// On /demo there is no workspace: `demo` carries sample rows (the buyers
// matched to 2207 Willow Street, the templates and one past campaign), nothing
// reaches Supabase or Talkr, and launch, save and publish end in a "(demo)"
// toast. The pieces live in components/dispo-campaign/.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type CampaignResults, loadResults, takePrefill } from '@/lib/dispo-campaign';
import { Composer, COMPOSER_CSS } from './dispo-campaign/Composer';
import { QuickCampaign } from './dispo-campaign/QuickCampaign';
import { Results, type BuyerInfo } from './dispo-campaign/Results';
import { Btn, CSS, C } from './dispo-campaign/ui';
import { DEMO_DEAL_ID, DEMO_WORKSPACE_ID, type DemoMarketing } from './dispo-campaign/demo-data';

type Props = {
  workspaceId: number | null; dealId: number | null; canWrite: boolean; isMobile: boolean;
  dealFields: Record<string, string> | null; textCtx: { repName: string; company: string } | null;
  onToast: (m: string) => void; onChanged: () => void;
  /** Sample rows for /demo. When set, nothing on the tab talks to a server. */
  demo?: DemoMarketing | null;
  /** Buyers who opened their tracked link to this deal, when the page knows. */
  viewed?: number | null;
  /** Names for the buyers in the results, by database id. */
  buyer?: (id: number) => BuyerInfo | null;
  onCall?: (name: string, phone: string) => void;
  onOpenBuyer?: (id: number) => void;
  onQueue?: (buyerIds: number[]) => void | Promise<void>;
  onAgent?: (buyerIds: number[]) => void | Promise<void>;
};

export function DispoCampaign(props: Props) {
  const { workspaceId, dealId, demo } = props;
  if (demo && props.dealFields && props.textCtx) {
    return <Campaigns {...props} workspaceId={DEMO_WORKSPACE_ID} dealId={DEMO_DEAL_ID} dealFields={props.dealFields} textCtx={props.textCtx} demo={demo} />;
  }
  if (!workspaceId || !dealId || !props.dealFields || !props.textCtx) {
    return <div className="mk-card" style={{ padding: '16px', fontSize: '13px', color: C.muted2, background: 'var(--surface, #fff)', border: `1px solid ${C.line}`, borderRadius: '12px' }}>Campaigns run on a signed-in workspace, for a real deal. Sign in to build one.</div>;
  }
  return <Campaigns key={dealId} {...props} workspaceId={workspaceId} dealId={dealId} dealFields={props.dealFields} textCtx={props.textCtx} demo={null} />;
}

function Campaigns({ workspaceId, dealId, canWrite, isMobile, dealFields, textCtx, onToast, onChanged, demo, viewed, buyer, onCall, onOpenBuyer, onQueue, onAgent }: Props & {
  workspaceId: number; dealId: number; dealFields: Record<string, string>; textCtx: { repName: string; company: string }; demo: DemoMarketing | null;
}) {
  const [results, setResults] = useState<CampaignResults | null>(() => (demo ? demo.results : null));
  const [building, setBuilding] = useState(false);
  // The full builder opens first; the one-screen quick send is a click away.
  const [advanced, setAdvanced] = useState(true);
  /** The builder fills the screen below the top menu; the rep can shrink it back into the tab. */
  const [full, setFull] = useState(true);
  const [prefill] = useState(() => (demo ? [] : takePrefill(dealId, false)));
  useEffect(() => { if (!demo) takePrefill(dealId); }, [dealId, demo]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void loadResults(workspaceId, dealId).then((r) => { if (live && r.ok) setResults(r.data); });
    return () => { live = false; };
  }, [workspaceId, dealId, tick, demo]);

  const hasCampaigns = !!results?.campaigns.length;
  const open = building || prefill.length > 0 || (results !== null && results.campaigns.length === 0);
  const names = (id: number) => buyer?.(id) ?? demo?.names.get(id) ?? null;
  const composer = open ? (advanced || demo ? (
    <Composer workspaceId={workspaceId} dealId={dealId} canWrite={canWrite} isMobile={isMobile} dealFields={dealFields} textCtx={textCtx} prefill={prefill}
      onToast={onToast} onLaunched={() => { setBuilding(false); setAdvanced(true); if (!demo) { refresh(); onChanged(); } }}
      onClose={hasCampaigns ? () => { setBuilding(false); setAdvanced(true); } : null} demo={demo} reveal={building}
      onQueue={onQueue} onAgent={onAgent} onQuick={demo ? undefined : () => setAdvanced(false)} />
  ) : (
    <QuickCampaign workspaceId={workspaceId} dealId={dealId} canWrite={canWrite} isMobile={isMobile} dealFields={dealFields} textCtx={textCtx} prefill={prefill}
      onToast={onToast} onLaunched={() => { setBuilding(false); setAdvanced(true); refresh(); onChanged(); }} onAdvanced={() => setAdvanced(true)}
      onClose={hasCampaigns ? () => { setBuilding(false); setAdvanced(true); } : null} />
  )) : null;
  const where = dealFields.full_address || dealFields.address || 'This deal';
  return (
    <div className="mk" style={{ display: 'grid', gap: '14px' }} data-testid="marketing">
      <style>{CSS + COMPOSER_CSS}</style>
      {composer && full && typeof document !== 'undefined' ? createPortal(
        // Everything beside the side menu (below the phone's 56px bar), like
        // the side panels: the deal header, its tabs and the page around them
        // give their room to the builder while it is open.
        <div className="mk" role="region" aria-label="Campaign builder" data-testid="marketing-full"
          style={{
            position: 'fixed', left: isMobile ? 0 : 'var(--clozr-side, 0px)', right: 0, zIndex: 46, background: '#f4f5f7', display: 'flex', flexDirection: 'column',
            top: isMobile ? 'calc(56px + env(safe-area-inset-top, 0px))' : 0,
            bottom: isMobile ? 'calc(var(--clozr-callbar, 0px) + 58px)' : 'var(--clozr-callbar, 0px)',
          }}>
          {/* Outside the scroll area, so the builder scrolling itself into view never hides the way out. */}
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, padding: isMobile ? '8px 10px' : '8px 20px', borderBottom: `1px solid ${C.line}`, background: 'var(--surface, #fff)' }}>
            <span className="mk-status" style={{ color: C.muted2 }}>Marketing</span>
            <b style={{ fontSize: '14px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{where}</b>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={() => setFull(false)} data-testid="marketing-exit-full">Exit full screen</Btn>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', padding: isMobile ? '10px 10px 0' : '12px 20px 0' }}>
            {composer}
          </div>
        </div>,
        document.body,
      ) : composer ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn size="sm" onClick={() => setFull(true)} data-testid="marketing-full-open">⤢ Full screen</Btn>
          </div>
          {composer}
        </>
      ) : results ? (
        <Results workspaceId={workspaceId} dealId={dealId} results={results} canWrite={canWrite} isMobile={isMobile} onToast={onToast}
          onChanged={demo ? () => onToast('Results refreshed (demo)') : refresh} onNew={() => setBuilding(true)}
          viewed={demo ? demo.viewed : viewed ?? null} buyer={names} onCall={onCall} onOpenBuyer={onOpenBuyer} demo={!!demo} />
      ) : <div className="mk-card" role="status" style={{ padding: '18px 16px', fontSize: '12.5px', color: C.muted2 }}>Loading this deal&apos;s campaigns…</div>}
    </div>
  );
}
