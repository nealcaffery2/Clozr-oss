'use client';

/**
 * CLOZR's slide-out quick dialer, its floating launcher, and the incoming-call
 * card — the same Talkr components the Dialer screen is built from, sized for
 * a side panel. People dial from a record without leaving it; "Open full
 * dialer" hands the call to the Dialer screen.
 */

import { useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ActiveCall } from './ActiveCall';
import { CallContext } from './CallContext';
import { CallerIdPicker, DefaultStar, callerIdLabel, showsDefault } from './CallerIdPicker';
import { DialSessionBar, DialSessionStart } from './DialSessionBar';
import { IncomingCall } from './IncomingCall';
import { Icon } from './Icon';
import { Button, Eyebrow } from './ui';
import { IosSegmented } from './ios';
import {
  DialBlock,
  LiveCallCard,
  NotesCard,
  QueueList,
  RecentList,
  RecordingToggles,
  TalkrMark,
  VoicemailList,
  WrapUpCard,
} from './DialerParts';
import { useSoftphone } from './softphoneAdapter';
import { LiveCalls, MonitorCard } from './Supervision';
import { RvmPanel } from './RvmPanel';
import '@/app/clozr/talkr-dialer.css';
import { openReach } from '@/app/components/record/reach';

// Message from a call: the docked quick text to that number, the same box every Text button opens.
const textFromCall = (phone: string) => openReach('text', { name: '', phone });

/** The floating button: the Talkr mark (unrecoloured, per brand/README.md), with a CLOZR-green pulsing ring and badge while a call is live. */
export function DialerLauncher({ V }: { V: ClozrView }) {
  const live = V.callState === 'live';
  return (
    <button
      className="dc6"
      onClick={V.toggleDialer}
      title={live ? 'Talkr dialer · call in progress' : 'Talkr dialer'}
      aria-label={live ? 'Talkr dialer, call in progress' : 'Talkr dialer'}
      style={{
        position: 'relative', width: 44, height: 44, borderRadius: 12, border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)',
        cursor: 'pointer', display: 'grid', placeItems: 'center',
        boxShadow: '0 1px 2px rgba(18,20,28,0.05),0 10px 28px -10px rgba(18,22,40,0.13)',
      }}
    >
      {live && (
        <span
          className="talkr-launcher-ring"
          aria-hidden
          style={{ position: 'absolute', inset: -1, borderRadius: 12, border: '2px solid #0A8560', animation: 'ringpulse 1.6s ease-out infinite' }}
        />
      )}
      <TalkrMark size={22} />
      {live && (
        <span
          aria-hidden
          style={{ position: 'absolute', top: -4, right: -4, width: 12, height: 12, borderRadius: 999, background: '#0A8560', border: '2px solid #fff' }}
        />
      )}
    </button>
  );
}

/** Talkr's incoming-call card, with the CLOZR record behind the number. */
export function DialerIncoming({ V }: { V: ClozrView }) {
  const from = V.talkrPhone.sp.incoming?.from ?? null;
  return (
    <IncomingCall
      record={from ? V.dialerRecordFor(from) : null}
      callback={{ workspaceId: V.templatesWorkspaceId ?? null, userId: V.callbackUserId, talkrUserId: V.talkrPhone.data.me?.id ?? null, openSeller: V.openSellerById, openBuyer: V.openBuyerById }}
    />
  );
}

export function DialerPanel({ V }: { V: ClozrView }) {
  const { authed, active, callState, team, me, setMe, liveCalls, monitor } = useSoftphone();
  const [digits, setDigits] = useState('');
  const wide = V.callState === 'live' && !V.isMobile;
  // On a phone a call in any phase takes the whole screen, over the header and tab bar.
  const sheet = V.isMobile && callState !== 'idle';

  const tabs = V.dialerTabs
    .filter((t) => t.label !== 'Live' || liveCalls !== null)
    .map((t) => ({ value: t.label, label: t.label }));
  const pickTab = (label: string) => V.dialerTabs.find((t) => t.label === label)?.go();
  const activeCallId = authed && active && active.record.id !== 'unknown' && active.record.id !== 'demo' ? active.record.id : undefined;
  const other = active ? (active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number) : '';

  return (
    <aside
      data-screen-label="Talkr dialer"
      className="talkr-dialer"
      style={{
        position: 'fixed', top: sheet ? 0 : 56, right: 0, bottom: sheet ? 0 : V.isMobile ? 'calc(58px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px))' : 'var(--clozr-callbar, 0px)',
        width: V.isMobile ? '100%' : V.dialerWidth, background: 'var(--bg)', borderLeft: '1px solid var(--line)',
        paddingTop: sheet ? 'env(safe-area-inset-top, 0px)' : undefined, paddingBottom: sheet ? 'env(safe-area-inset-bottom, 0px)' : undefined,
        boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)', zIndex: sheet ? 60 : 45,
        display: 'flex', flexDirection: 'column', animation: 'clozrIn .2s cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      <div className="glass-bar relative z-10 flex items-center gap-2.5 px-3.5 py-3" style={{ borderBottom: '0.5px solid rgba(60,60,67,.18)' }}>
        <TalkrMark size={18} />
        <span style={{ font: '700 14px/1 var(--sans)', letterSpacing: '-0.01em' }}>Talkr</span>
        <span className="min-w-0 flex-1 truncate" style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}>
          {showsDefault(me) && <><DefaultStar size={11} />{' '}</>}{callerIdLabel(me) || V.callerIdLabel}
        </span>
        {V.can.dialer ? (
        <Button tone="ghost" onClick={V.goDialer} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
          Open full dialer
          <Icon name="forward" size={11} />
        </Button>
        ) : null}
        <button
          type="button"
          onClick={V.closeDialer}
          aria-label="Close dialer"
          className="inline-flex items-center justify-center"
          style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer' }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <DialSessionBar V={V} />

      {V.talkrPhone.extension.holdingSoftphone && (
        // Two softphones under one identity is how an inbound call rings in a
        // window nobody is looking at, so this tab stands down while the
        // extension is up. Saying so beats a dialer that quietly does nothing.
        <div
          className="flex items-start gap-2.5 px-3.5 py-2.5"
          style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--line)' }}
        >
          <Icon name="check" size={13} style={{ color: 'var(--accent)', marginTop: 1, flex: 'none' }} />
          <span style={{ font: '500 11px/1.45 var(--sans)', color: 'var(--muted)' }}>
            Calls are running through the Talkr extension, so they keep going when you close this
            tab. Dialling a number here still works — it hands the call to the extension. The power
            dialer runs from the extension while it has the phone.
          </span>
        </div>
      )}

      {callState === 'idle' && (
        <>
          <div className="px-3.5 pt-3">
            <IosSegmented value={V.dialerTab} onChange={pickTab} options={tabs} full />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3.5 *:shrink-0">
            {V.isDial && (
              <>
                <DialBlock V={V} digits={digits} setDigits={setDigits} error={null} />
                {me && me.org_numbers.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Eyebrow>Caller ID</Eyebrow>
                    <CallerIdPicker me={me} onChange={setMe} compact />
                  </div>
                )}
                <RecordingToggles V={V} />
              </>
            )}
            {V.isQueue && (
              <>
                <DialSessionStart V={V} />
                <QueueList V={V} />
              </>
            )}
            {V.isRecent && (
              <RecentList
                V={V}
                big={false}
                onPick={(phone) => {
                  setDigits(phone.replace(/\D/g, '').slice(-10));
                  pickTab('Dial');
                }}
              />
            )}
            {V.isVoicemail && <VoicemailList V={V} />}
            {V.dialerTab === 'RVM' && <RvmPanel V={V} />}
            {V.dialerTab === 'Live' && <LiveCalls />}
          </div>
        </>
      )}

      {active && (
        <div className={`grid min-h-0 flex-1 ${wide ? 'grid-cols-[380px_minmax(0,1fr)]' : 'grid-cols-1 overflow-auto'}`}>
          <div className={`flex min-w-0 flex-col gap-3 p-3.5 *:shrink-0 ${wide ? 'overflow-auto' : ''}`} style={wide ? { borderRight: '1px solid var(--line)' } : undefined}>
            {monitor ? <MonitorCard /> : <ActiveCall team={team} onText={textFromCall} recording={V.rec} />}
            <NotesCard V={V} />
          </div>
          <div className={`min-w-0 p-3.5 ${wide ? 'overflow-auto' : ''}`}>
            <CallContext
              mode="incall"
              callId={activeCallId}
              params={authed ? (activeCallId ? { call_id: activeCallId } : other ? { phone: other } : null) : null}
              record={V.callRecord}
              direction={active.record.direction}
              onText={textFromCall}
              liveSlot={<LiveCallCard V={V} />}
            />
          </div>
        </div>
      )}

      {callState === 'wrapup' && (
        <div className="min-h-0 flex-1 overflow-auto p-3.5">
          <WrapUpCard V={V} />
        </div>
      )}
    </aside>
  );
}
