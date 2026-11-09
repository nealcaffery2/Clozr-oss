// Talk to it: a test call that stays open beside the tabs while you edit. Each
// call runs the form as it is when you press Start (unsaved edits included,
// through test_session's draft overrides), so the loop is talk, change a line in
// any tab, talk again, with no save or publish in between. Beside the tabs on a
// wide console; a bottom sheet on a phone that folds down to a bar.
'use client';

import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Mic, MicOff, Phone, PhoneOff, X } from 'lucide-react';
import type { Api, TestVersion } from '@/lib/voice-agent-client';
import { asComprProspect, formatDuration } from '@/lib/voice-agent';
import { Badge, Banner, INK, LINE, MUTED, Segmented, ghost, primary } from './kit';
import { StatusPill, Transcript } from './CallParts';
import { useCallSession } from './useCallSession';

type Kind = 'seller' | 'buyer';

export function TalkDock({ api, workspaceId, agentKey, ready, agentName, defaultAs, compr = false, version, sheet, minimized, onMinimize, onClose, barSlot }: {
  api: Api; workspaceId: number | null; agentKey: string;
  /** Published at least once, so there is an ElevenLabs agent to run the draft on. */
  ready: boolean; agentName: string; defaultAs: Kind;
  /** A COMPR agent: the caller is a COMPR prospect, with no seller or buyer to pick. */
  compr?: boolean;
  /** The draft as it is right now, read on each Start. */
  version: () => TestVersion;
  /** A bottom sheet (phone, narrow console) rather than a column beside the tabs. */
  sheet: boolean; minimized: boolean; onMinimize: (min: boolean) => void; onClose: () => void;
  /** Where the folded sheet draws its one-line call bar: the top of the save and publish bar. */
  barSlot: HTMLElement | null;
}) {
  const demo = api.demo;
  const [as, setAs] = useState<Kind>(defaultAs);
  const [edited, setEdited] = useState(false);
  const call = useCallSession({ live: workspaceId != null && !demo });
  const { phase, error, lines, tools, speaking, muted, elapsed, inCall, run, end } = call;
  const canStart = (demo || ready) && !inCall;

  const start = useCallback(() => {
    const v = version();
    setEdited(!!v.settings);
    // A COMPR agent's sample rides on the sample buyer; the prospect's brief replaces the buy box.
    void run(() => (compr
      ? api.startTestSession(agentKey, { sample: 'buyer' }, v).then((r) => (r.ok ? { ...r, data: asComprProspect(r.data) } : r))
      : api.startTestSession(agentKey, { sample: as }, v)));
  }, [agentKey, api, as, compr, run, version]);
  const close = () => { void end(); onClose(); };

  const clock = phase === 'live' || phase === 'ended' ? formatDuration(elapsed) : '';
  const callButton = inCall ? (
    <button type="button" className="va-btn" onClick={() => void end()} style={{ ...ghost, height: 40, flex: 1, background: '#dc2626', border: '1px solid #dc2626', color: '#fff', fontSize: 13.5 }}>
      <PhoneOff size={16} aria-hidden="true" /> End call
    </button>
  ) : (
    <button type="button" className="va-btn va-prim" disabled={!canStart} onClick={start} style={{ ...primary(!canStart), height: 40, flex: 1, fontSize: 13.5 }}>
      <Phone size={16} aria-hidden="true" /> {phase === 'ended' ? 'Call again' : 'Start talking'}
    </button>
  );

  if (sheet && minimized) {
    if (!barSlot) return null;
    // Folded, the call rides on the save and publish bar, so it never covers it or the fields.
    return createPortal(
      <div role="region" aria-label={`Talk to ${agentName || 'the agent'}`} className="va-in"
        style={{ flex: '1 1 100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 10px',
          background: 'var(--surface, #fff)', borderRadius: 10, color: INK }}>
        <span role="status" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusPill phase={phase} speaking={speaking} muted={muted} />
          <span style={{ fontSize: 12.5, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
        </span>
        {inCall ? (
          <button type="button" className="va-btn" aria-label="End call" onClick={() => void end()} style={{ ...ghost, width: 40, height: 40, padding: 0, background: '#dc2626', border: '1px solid #dc2626', color: '#fff' }}><PhoneOff size={16} aria-hidden="true" /></button>
        ) : null}
        <button type="button" className="va-btn va-ghost" aria-label="Open the talk panel" onClick={() => onMinimize(false)} style={{ ...ghost, width: 40, height: 40, padding: 0 }}><ChevronUp size={18} aria-hidden="true" /></button>
      </div>,
      barSlot,
    );
  }

  return (
    <section aria-labelledby="va-talk-title" className={sheet ? 'va-modal' : 'va-in'}
      style={sheet ? {
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 99, height: 'min(68dvh, 560px)', display: 'flex', flexDirection: 'column',
        background: 'var(--surface, #fff)', borderRadius: '16px 16px 0 0', boxShadow: 'var(--elev-3)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      } : {
        position: 'sticky', top: 12, height: 'min(640px, calc(100dvh - 150px))', display: 'flex', flexDirection: 'column', minWidth: 0,
        background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: 12, boxShadow: 'var(--elev-2)', overflow: 'hidden',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px 10px 16px', borderBottom: `1px solid ${LINE}` }}>
        <h2 id="va-talk-title" style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Talk to {agentName || 'the agent'}</h2>
        <Badge tone="green">Your draft</Badge>
        {sheet ? <button type="button" className="va-btn va-ghost" aria-label="Fold the talk panel down" onClick={() => onMinimize(true)} style={{ ...ghost, width: 36, height: 36, padding: 0 }}><ChevronDown size={18} aria-hidden="true" /></button> : null}
        <button type="button" className="va-btn va-ghost" aria-label={inCall ? 'End the call and close' : 'Close the talk panel'} onClick={close} style={{ ...ghost, width: 36, height: 36, padding: 0 }}><X size={16} aria-hidden="true" /></button>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${LINE}`, display: 'grid', gap: 8 }}>
        {compr ? (
          <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.45 }}>
            <strong style={{ color: INK, fontWeight: 600 }}>You play a COMPR prospect:</strong> a wholesaler on a COMPR trial, two addresses run, no demo booked with Alex yet.
          </p>
        ) : (
          <Segmented<Kind> label="You play" disabled={inCall} value={as} onChange={setAs}
            options={[{ id: 'seller', label: 'A seller', hint: 'A made-up homeowner with a full brief.' }, { id: 'buyer', label: 'A cash buyer', hint: 'A made-up investor with a buy box.' }]} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
          <StatusPill phase={phase} speaking={speaking} muted={muted} />
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
        </div>
      </div>

      {!demo && !ready ? <div style={{ padding: '10px 16px 0' }}><Banner tone="warn">Publish this agent once to create it in ElevenLabs. After that, every call here runs your draft without publishing.</Banner></div> : null}
      {error ? <div style={{ padding: '10px 16px 0' }}><Banner tone="error">{error}</Banner></div> : null}

      <Transcript scroller={call.scroller} phase={phase} lines={lines} tools={tools} agentName={agentName}
        idleHint="Press Start and talk. Change anything in the tabs, then call again to hear it." style={{ flex: 1, minHeight: 0 }} />

      <div style={{ padding: '10px 16px 12px', borderTop: `1px solid ${LINE}` }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {callButton}
          {phase === 'live' ? (
            <button type="button" className="va-btn va-ghost" aria-pressed={muted} onClick={call.toggleMute} style={{ ...ghost, height: 40, minWidth: 92 }}>
              {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />} {muted ? 'Unmute' : 'Mute'}
            </button>
          ) : null}
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>
          {inCall && edited ? 'This call has your unsaved edits. ' : ''}Prompt, script, rules, voice and model come from your draft, saved or not. Tools, transfer and call timing stay as published. Nothing goes live.
        </p>
      </div>
    </section>
  );
}
