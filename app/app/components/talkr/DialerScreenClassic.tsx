'use client';

/**
 * The classic desk Dialer, the default layout. Settings › Try new design swaps
 * it for the three-column desk (DialerScreen.tsx), per user. Both draw the
 * same parts (DialBlock with Enter to dial, DialerTexts with its composer,
 * CallContext, CallProfileCard, Request contract), so fixes to them land in both.
 *
 * Dialer workspace: the keypad on the left until a call starts, then the call
 * itself on the left and the record in the middle. The team's clocks stay on
 * the right. A rep on a call needs the person and the property in front of
 * them, not a second dial pad.
 *
 * The centre carries the party's context (CallContext): before a call for the
 * number typed or picked, while a call rings in, and for the whole call once
 * it starts — lead, script and objections, without a click.
 *
 * CLOZR seam (copied from Talkr apps/web/app/(app)/dialer/page.tsx): the
 * softphone is softphoneAdapter.tsx; a call goes out through CLOZR (`V`) so it
 * carries the record, transcript, intelligence and wrap-up; the panel is fed
 * the CLOZR record behind the number; the dial column also holds CLOZR's
 * record / AI switches and its Queue and Voicemail lists beside Recent; the
 * live call adds CLOZR's transcript and seller-intelligence cards; the call
 * ends in CLOZR's wrap-up (dispositions + summary + write to the record). The
 * sample-data demo renders the same screen on V's scripted call.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { everyWhileVisible } from '@/lib/visible-timer';
import type { CallContextParams } from '@/lib/talkr-web/api';
import { callWindow, tzAbbr, tzTime, toE164, zoneForNumber } from '@/lib/talkr-web/time';
import { useSoftphone } from './softphoneAdapter';
import { TopBar } from './TopBar';
import { Mark } from '@/components/ds/mark';
import { ActiveCall } from './ActiveCall';
import { DialSessionBar, DialSessionStart } from './DialSessionBar';
import { LiveCalls, MonitorCard } from './Supervision';
import { Icon } from './Icon';
import { Card, EmptyState, Eyebrow, StatusMarker } from './ui';
import { IosSegmented } from './ios';
import { CallContext } from './CallContext';
import { CallProfileCard } from './CallProfileCard';
import { DialerTexts } from './DialerTexts';
import { CampaignsPanel } from './Campaigns';
import { CallerIdPicker, callerIdLabel } from './CallerIdPicker';
import { openReach } from '@/app/components/record/reach';
import { RequestContractButton } from '@/components/contract-request/RequestContractButton';
import {
  DialBlock,
  LiveCallCard,
  NotesCard,
  QueueList,
  RecentList,
  RecordingToggles,
  TalkrNotSignedIn,
  VoicemailList,
  WrapUpCard,
  ScriptedCall,
} from './DialerParts';

const ZONES: Array<[string, string]> = [
  ['Eastern', 'America/New_York'],
  ['Central', 'America/Chicago'],
  ['Mountain', 'America/Denver'],
  ['Pacific', 'America/Los_Angeles'],
];

/** CLOZR: the list under the dial column. */
type DialList = 'recent' | 'queue' | 'voicemail' | 'campaigns';

export function DialerScreenClassic({ V }: { V: ClozrView }) {
  const { deviceState, callState, authed, active, incoming, team, me, setMe, monitor } = useSoftphone();
  const [digits, setDigits] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [list, setList] = useState<DialList>('recent');

  // A phone has no dialer screen: the full-screen phone (PhoneScreen.tsx) is
  // the one phone there, so landing here on a phone (a resize, a restored
  // screen) opens it instead.
  // Once per arrival on a phone, not on every render: Done must be able to close it.
  const isMobile = V.isMobile;
  const openPhone = useRef(V.openPhone);
  useEffect(() => {
    openPhone.current = V.openPhone;
  });
  useEffect(() => {
    if (isMobile) openPhone.current();
  }, [isMobile]);

  const inCall = callState !== 'idle';
  const wrap = callState === 'wrapup';

  // Clocks tick client-side only: the server cannot know the rep's zone, and a
  // mismatched first paint is a hydration error.
  useEffect(() => {
    setNow(Date.now());
    return everyWhileVisible(() => setNow(Date.now()), 30_000);
  }, []);

  // A call placed from here clears the field.
  useEffect(() => {
    if (inCall) setDigits('');
  }, [inCall]);

  const dial = (input: { to_number?: string }) => {
    if (input.to_number) V.dialE164(input.to_number);
  };

  const dialZone = useMemo(() => (digits.length >= 3 ? zoneForNumber(toE164(digits)) : null), [digits]);

  // Ten digits is a whole number: that is when the party's context loads. The
  // panel debounces the fetch itself and drops a stale party the moment the
  // number changes.
  const contextPhone = useMemo(() => (digits.replace(/\D/g, '').replace(/^1/, '').length === 10 ? toE164(digits) : null), [digits]);
  const contextRecord = contextPhone ? V.dialerRecordFor(contextPhone) : null;

  // The caller while the phone rings — a real E.164, not Twilio's "Unknown".
  const incomingPhone = incoming && /^\+\d{7,}$/.test(incoming.from) ? incoming.from : null;

  // The live call's identity for the panel: the server's call id, or the other
  // party's number until an accepted inbound call has learned its id.
  const activeCallId = authed && active && active.record.id && active.record.id !== 'unknown' && active.record.id !== 'demo' ? active.record.id : undefined;
  const activeParams = useMemo<CallContextParams | null>(() => {
    if (!active || !authed) return null;
    if (activeCallId) return { call_id: activeCallId };
    const other = active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
    return other ? { phone: other } : null;
  }, [active, activeCallId, authed]);

  // The number on the call, for its texts: the live leg's other party, or
  // the number called once the softphone has let go of it (the demo, wrap-up).
  const textPhone = active
    ? (active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number)
    : (toE164(V.callTarget?.phone ?? '') || null);
  const canCall = !inCall && deviceState === 'ready' && V.callState === 'idle';
  const callUp = inCall || wrap || V.callState !== 'idle';
  const wrapping = wrap || V.callState === 'wrap';
  // Worded exactly as components/ProspectTime does it, so the two places this
  // page states the seller's clock never look like two different facts.
  const hint =
    dialZone && now !== null
      ? `${tzTime(dialZone, now)} their time`
      : callerIdLabel(me) || V.callerIdLabel || 'No number assigned to you yet';
  // A number in hand opens the docked quick text; without one, the inbox.
  const openText = (phone?: unknown) => (typeof phone === 'string' && phone ? openReach('text', { name: '', phone }) : V.goInbox());
  const pickRecent = (phone: string) => {
    // Picking a row loads that party: the number lands in the field and the
    // context panel follows it by phone.
    setDigits(phone.replace(/\D/g, '').slice(-10));
  };

  /** Talkr only answers for a signed-in rep it knows; the demo and an unlinked rep get CLOZR's record alone. */
  const params = (p: CallContextParams | null) => (authed ? p : null);

  /** Before a call: the party behind the number, or, while a call rings in, the caller. */
  const precallContext = incomingPhone && !active ? (
    <CallContext mode="incoming" params={params({ phone: incomingPhone })} record={V.dialerRecordFor(incomingPhone)} onText={openText} />
  ) : contextPhone ? (
    <CallContext
      mode="precall"
      params={params({ phone: contextPhone })}
      record={contextRecord}
      onCall={dial}
      canCall={canCall}
      onText={openText}
      // A number with a record loaded: the contract can be asked for before the call.
      extraAction={contextRecord ? <RequestContractButton V={V} phone={contextPhone} /> : undefined}
    />
  ) : (
    <Card>
      <EmptyState
        icon="phone"
        title="No call in progress"
        hint="Dial a number to see who it is, their history and the script. Hold, add a call, merge and transfer all appear here once you are connected."
      />
    </Card>
  );

  /** The live call's context panel, the desk's right column. */
  const inCallContext = () =>
    active && (
      <CallContext
        mode="incall"
        callId={activeCallId}
        params={activeParams}
        record={V.callRecord}
        direction={active.record.direction}
        onText={openText}
        extraAction={<RequestContractButton V={V} />}
      />
    );

  // `wide`: the full dialer's centre column when no call is up, where the
  // lists have the room to read as lists rather than a phone column.
  const dialList = (wide: boolean) => (
    <>
      <div className="pb-1.5">
        <IosSegmented
          value={list}
          onChange={setList}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'queue', label: 'Queue' },
            { value: 'voicemail', label: 'Voicemail' },
            { value: 'campaigns', label: 'Campaigns' },
          ]}
        />
      </div>
      {list === 'recent' && <RecentList V={V} big={wide} onPick={pickRecent} />}
      {list === 'queue' && (
        <>
          <DialSessionStart V={V} />
          <QueueList V={V} wide={wide} />
        </>
      )}
      {list === 'voicemail' && <VoicemailList V={V} wide={wide} />}
      {list === 'campaigns' && <CampaignsPanel V={V} />}
    </>
  );

  return (
    <>
      <TopBar
        title="Dialer"
        subtitle={wrap ? 'Wrapping up' : inCall ? 'One live call' : 'Ready to dial'}
        // Talkr's New call opens /dialer; here that is this page, so it lands in the number field.
        onNewCall={() => document.querySelector<HTMLInputElement>('.talkr-dialer input[aria-label^="Number to dial"]')?.focus()}
      />
      <TalkrNotSignedIn V={V} />
      <DialSessionBar V={V} />

      {/* ── Phone: the full-screen phone has the call; this is only the way to it ── */}
      {V.isMobile ? (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <Card className="flex w-full max-w-sm flex-col items-center gap-3" style={{ padding: '22px 18px' }}>
          <Icon name="phone" size={22} style={{ color: 'var(--accent)' }} />
          <span style={{ font: '600 15px/1.3 var(--sans)' }}>The phone opens full screen</span>
          <span style={{ font: '400 13px/1.45 var(--sans)', color: 'var(--muted)' }}>
            Keypad, recents, your queue and voicemail, and the call itself.
          </span>
          <button
            type="button"
            onClick={() => V.openPhone()}
            className="w-full"
            style={{ height: 50, borderRadius: 14, border: 0, background: 'var(--accent)', color: '#fff', font: '600 17px/1 var(--sans)', cursor: 'pointer' }}
          >
            Open phone
          </button>
        </Card>
      </div>
      ) : (

      /* ── Desk: keypad on the left until the call starts. Then the call
             takes that column and the record keeps the middle. ──── */
      <div
        className={
          callUp
            ? 'grid min-h-0 flex-1 grid-cols-[360px_1fr] 2xl:grid-cols-[360px_1fr_300px]'
            : 'grid min-h-0 flex-1 grid-cols-[300px_1fr_280px] xl:grid-cols-[320px_1fr_320px]'
        }
      >
        {/* ── Dial, or the call once one is up ─────────────────────────── */}
        <div className="dial-rail flex min-h-0 flex-col overflow-auto border-r border-[var(--line)]" style={{ background: 'var(--rail)' }}>
          {callUp ? (
            wrapping ? (
              <div className="p-3"><WrapUpCard V={V} /></div>
            ) : monitor ? (
              <div className="p-3"><MonitorCard /></div>
            ) : active ? (
              <div className="p-3"><ActiveCall team={team} onText={openText} recording={V.rec} /></div>
            ) : (
              <div className="p-3"><ScriptedCall V={V} /></div>
            )
          ) : (
          <div className="flex flex-col gap-2.5 px-4 pb-3 pt-4">
            <Eyebrow>Dial</Eyebrow>
            <DialBlock V={V} digits={digits} setDigits={setDigits} error={null} keyboard />

            {me && me.org_numbers.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Caller ID</Eyebrow>
                <CallerIdPicker me={me} onChange={setMe} compact />
              </div>
            )}
            <div className="dial-note flex items-center gap-2 px-3 py-2" style={{ border: '1px dashed var(--line)', borderRadius: 'var(--r-btn)' }}>
              <Icon name="pin" size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ font: '500 11px/1.35 var(--sans)', color: 'var(--muted)' }}>{hint}</span>
            </div>
            <RecordingToggles V={V} />
          </div>
          )}
        </div>

        {/* ── The record. The call does not sit on top of it. ───────────── */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto p-5">
          {callUp ? (
            <>
              {/* The transcript and the texts first: the two things a rep reads while talking. */}
              {!wrapping && <LiveCallCard V={V} part="transcript" />}
              {/* "From this call": under the transcript, and first at wrap-up
                  once the transcript card is gone. It renders nothing for a
                  seller on record or a buyer whose buy box is complete. */}
              <CallProfileCard V={V} />
              {textPhone && <DialerTexts V={V} phone={textPhone} />}
              {active ? inCallContext() : V.callRecord ? (
                <CallContext mode="precall" params={null} record={V.callRecord} onText={openText} extraAction={<RequestContractButton V={V} />} />
              ) : (
                <Card>
                  <EmptyState icon="user" title="No CLOZR record for this number" hint="Save the number as a contact, or add a seller from Quick Add." />
                </Card>
              )}
              {!wrapping && <LiveCallCard V={V} part="intel" />}
              <NotesCard V={V} />
            </>
          ) : (
            <>
              {(incomingPhone || contextPhone) && <DialerTexts V={V} phone={(incomingPhone || contextPhone)!} />}
              {precallContext}
              <Card className="flex flex-col gap-0.5">{dialList(true)}</Card>
              <NotesCard V={V} />
            </>
          )}
        </div>

        {/* ── Team clocks ───────────────────────────────────────────────── */}
        <div
          className={`dial-rail dial-rail-r ${callUp ? 'hidden 2xl:flex' : 'flex'} min-h-0 flex-col gap-4 overflow-auto border-l border-[var(--line)] p-4`}
          style={{ background: 'var(--rail)' }}
        >
          <div className="flex flex-col gap-2.5">
            <Eyebrow>Team presence</Eyebrow>
            {team.length === 0 && (
              <EmptyState compact icon="users" title="No teammates yet" hint="Their local time and presence show here, so you know who can take a transfer." />
            )}
            {team.map((m) => (
              <div key={m.id} className="flex items-center gap-2.5 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <span className="mr-auto flex min-w-0 flex-col gap-1">
                  <span className="truncate" style={{ font: '600 12px/1 var(--sans)' }}>{m.display_name}</span>
                  <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}>
                    {m.city ?? 'Zone not set'}
                    {m.timezone && now !== null ? ` · ${tzAbbr(m.timezone, now)}` : ''}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span style={{ font: '600 12px/1 var(--sans)' }}>{m.timezone && now !== null ? tzTime(m.timezone, now) : '—'}</span>
                  <StatusMarker
                    color={m.presence === 'available' ? 'var(--green)' : m.presence === 'away' ? 'var(--amber)' : 'var(--muted-2)'}
                    label={m.presence}
                  />
                </span>
              </div>
            ))}
          </div>

          {/* Supervision: teammates' live calls, beside who is on the floor. Hidden without calls.monitor. */}
          <LiveCalls />

          {/* Between calls Recent, Queue and Voicemail take the wide centre
              column; while a call has the centre they wait here. */}
          {(callUp) && <div className="flex flex-col gap-0.5">{dialList(false)}</div>}

          <Card className="flex flex-col gap-2.5">
            <Eyebrow>Dialing windows</Eyebrow>
            {ZONES.map(([label, tz]) => {
              const w = now === null ? null : callWindow(tz, now);
              return (
                <div key={tz} className="flex items-center gap-2.5 py-1.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  <span style={{ color: w ? w.color : 'var(--muted-2)', display: 'inline-flex' }}><Mark label="clock" /></span>
                  <span className="mr-auto" style={{ font: '600 11.5px/1 var(--sans)' }}>{label}</span>
                  <span style={{ font: '600 11.5px/1 var(--sans)', color: 'var(--muted)' }}>{now === null ? '—' : tzTime(tz, now)}</span>
                  <span
                    style={{
                      font: '600 11px/1 var(--sans)',
                      color: w ? w.color : 'var(--muted-2)',
                      width: 74,
                      textAlign: 'right',
                    }}
                  >
                    {w ? (w.safe ? 'Open' : 'Quiet hours') : '—'}
                  </span>
                </div>
              );
            })}
            <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>9:00 AM – 8:00 PM in the lead&apos;s local time.</p>
          </Card>
        </div>
      </div>
      )}
    </>
  );
}
