'use client';

/**
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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { everyWhileVisible } from '@/lib/visible-timer';
import type { CallContextParams } from '@/lib/talkr-web/api';
import { callWindow, formatPhone, tzAbbr, tzTime, toE164, zoneForNumber } from '@/lib/talkr-web/time';
import { DIAL_MODES } from '@/lib/dial-engine';
import { useSoftphone } from './softphoneAdapter';
import { TopBar } from './TopBar';
import { Mark } from '@/components/ds/mark';
import { ActiveCall } from './ActiveCall';
import { DialSessionBar, DialSessionStart } from './DialSessionBar';
import { LiveCalls, MonitorCard } from './Supervision';
import { Icon } from './Icon';
import { Button, Card, EmptyState, StatusMarker } from './ui';
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

export function DialerScreen({ V }: { V: ClozrView }) {
  const { deviceState, callState, authed, active, incoming, team, me, setMe, monitor } = useSoftphone();
  const [digits, setDigits] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [list, setList] = useState<DialList>('recent');
  const wide = useWideDesk();

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
        compact
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


  // The number on screen, for Create profile: the one typed, or the live call's other party.
  // During the call and its wrap-up (when the softphone has already let go of
  // it), the number called: right after a call to an unknown number is when
  // a profile is most wanted.
  const callPhone = active
    ? (active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number)
    : callUp ? (toE164(V.callTarget?.phone ?? '') || null) : null;
  const profilePhone = callPhone || contextPhone || '';
  const profileRecord = callUp ? V.callRecord : contextRecord;
  // Below 1280px there is no right column: Create profile and the sales floor
  // join the centre one instead, mounted once either way (the sales floor's
  // list polls while it is mounted).
  const sideCards = (
    <>
      <CreateProfileCard V={V} phone={profilePhone} record={profileRecord} />
      <Card className="flex flex-col gap-2">
        <LiveCalls />
        <SalesFloorFallback />
      </Card>
    </>
  );

  return (
    <>
      <TopBar
        title="Dialer"
        subtitle={wrap ? 'Wrapping up' : inCall ? 'One live call' : 'Ready to dial'}
        extra={<TeamMenu team={team} now={now} />}
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

      /* ── Desk: three columns that keep their places for the whole call.
             Left: the phone (keypad, then the call's own controls).
             Centre: who is on the line, the live transcript, notes, the lists.
             Right: create a profile from the number, and the sales floor. ── */
      <div className={`dial-desk grid min-h-0 flex-1 gap-3 overflow-hidden p-3 ${wide ? 'grid-cols-[340px_minmax(0,1fr)_320px]' : 'grid-cols-[320px_minmax(0,1fr)]'}`}>
        {/* ── Phone, or the call once one is up ─────────────────────────── */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          {callUp ? (
            wrapping ? (
              <WrapUpCard V={V} />
            ) : monitor ? (
              <MonitorCard />
            ) : active ? (
              <ActiveCall team={team} onText={openText} recording={V.rec} />
            ) : (
              <ScriptedCall V={V} />
            )
          ) : (
            <Card className="dial-phone flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h2 style={{ font: '650 20px/1.2 var(--sans)', letterSpacing: '-0.015em' }}>Phone</h2>
                <p style={{ font: '400 13.5px/1.35 var(--sans)', color: 'var(--muted)' }}>{hint}</p>
              </div>
              <DialBlock V={V} digits={digits} setDigits={setDigits} error={null} keyboard />
              {me && me.org_numbers.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span style={{ font: '600 13.5px/1 var(--sans)' }}>Caller ID</span>
                  <CallerIdPicker me={me} onChange={setMe} compact />
                </div>
              )}
            </Card>
          )}
          {!callUp && <DialModeCard V={V} onQueue={() => setList('queue')} />}
          {!callUp && (
            <Card className="flex flex-col gap-2">
              <RecordingToggles V={V} />
            </Card>
          )}
        </div>

        {/* ── The record. The call does not sit on top of it. ───────────── */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto">
          {callUp ? (
            <>
              {/* The transcript, then the texts with the same person, then what the AI makes of the call. */}
              {!wrapping && <LiveCallCard V={V} part="transcript" />}
              {/* "From this call": right under the transcript, and first at
                  wrap-up once the transcript card is gone. It renders nothing
                  for a seller on record or a buyer whose buy box is complete. */}
              <CallProfileCard V={V} />
              {callPhone && <DialerTexts V={V} phone={callPhone} />}
              {!wrapping && <LiveCallCard V={V} part="intel" />}
              {active ? inCallContext() : V.callRecord ? (
                <CallContext mode="precall" params={null} record={V.callRecord} onText={openText} extraAction={<RequestContractButton V={V} />} />
              ) : (
                <Card>
                  <EmptyState icon="user" title="No CLOZR record for this number" hint="Use Create profile to save this number, so the call lands on a record." />
                </Card>
              )}
              <NotesCard V={V} />
              {!wide && sideCards}
              {!wide && <Card className="flex flex-col gap-0.5">{dialList(true)}</Card>}
            </>
          ) : (
            <>
              {/* The thread first: the dial box already says who the number is. */}
              {(incomingPhone || contextPhone) && <DialerTexts V={V} phone={(incomingPhone || contextPhone)!} />}
              {precallContext}
              {!wide && sideCards}
              <Card className="flex flex-col gap-0.5">{dialList(true)}</Card>
              <NotesCard V={V} />
            </>
          )}
        </div>

        {/* ── Create a profile, and the sales floor ─────────────────────── */}
        {wide && (
          <div className="flex min-h-0 flex-col gap-3 overflow-auto">
            {sideCards}
            {callUp && <Card className="flex flex-col gap-0.5">{dialList(false)}</Card>}
          </div>
        )}
      </div>
      )}
    </>
  );
}

/* ── Create profile ───────────────────────────────────────────────────────── */

const PROFILE_KINDS: { value: 'seller' | 'buyer' | 'agent' | 'wholesaler' | 'vendor'; label: string; hint: string }[] = [
  { value: 'seller', label: 'Seller', hint: 'A lead with a property. Lands in People.' },
  { value: 'buyer', label: 'Buyer', hint: 'A cash buyer. Needs a phone and an email.' },
  { value: 'agent', label: 'Agent', hint: 'A realtor, saved with your vendors.' },
  { value: 'wholesaler', label: 'Wholesaler', hint: 'Another wholesaler, saved with your vendors.' },
  { value: 'vendor', label: 'Vendor', hint: 'Title, lender, contractor and the rest.' },
];

/**
 * The number on screen becomes a profile without leaving the dialer. The
 * phone is filled in from the call or the dial box, and the full form opens,
 * so a profile is never saved with only a name.
 */
function CreateProfileCard({ V, phone, record }: { V: ClozrView; phone: string; record: ReturnType<ClozrView['dialerRecordFor']> | ClozrView['callRecord'] }) {
  const [kind, setKind] = useState<(typeof PROFILE_KINDS)[number]['value']>('seller');
  const picked = PROFILE_KINDS.find((k) => k.value === kind)!;
  if (record) {
    return (
      <Card className="flex flex-col gap-2.5">
        <h2 style={{ font: '650 20px/1.2 var(--sans)', letterSpacing: '-0.015em' }}>Profile</h2>
        <div className="flex items-center gap-2.5">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate" style={{ font: '600 15px/1.25 var(--sans)' }} title={record.name}>{record.name}</span>
            <span className="truncate" style={{ font: '400 13px/1.3 var(--sans)', color: 'var(--muted)' }} title={record.address || undefined}>
              {record.kind === 'buyer' ? 'Buyer' : 'Seller'}{record.stage ? ` · ${record.stage}` : ''}
            </span>
          </span>
        </div>
        {record.open && (
          <Button tone="ghost" onClick={record.open} style={{ justifyContent: 'center' }}>
            Open profile
          </Button>
        )}
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 style={{ font: '650 20px/1.2 var(--sans)', letterSpacing: '-0.015em' }}>Create profile</h2>
        <p style={{ font: '400 13.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
          {phone ? `For ${formatPhone(phone)}. The number is filled in for you.` : 'Type a number first and it is filled in for you.'}
        </p>
      </div>
      <div role="radiogroup" aria-label="Profile type" className="flex flex-wrap gap-1.5">
        {PROFILE_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={kind === k.value}
            onClick={() => setKind(k.value)}
            className="dial-chip"
          >
            {k.label}
          </button>
        ))}
      </div>
      <p style={{ font: '400 13px/1.4 var(--sans)', color: 'var(--muted)' }}>{picked.hint}</p>
      <Button tone="accent" onClick={() => V.addProfile(kind, phone)} style={{ justifyContent: 'center' }}>
        <Icon name="user" size={14} />
        Create {picked.label.toLowerCase()} profile
      </Button>
    </Card>
  );
}

/* ── Dial mode ────────────────────────────────────────────────────────────── */

/**
 * How the next calls get dialed, in plain sight: one at a time from the
 * keypad, or a session over the queue in power or predictive mode. Starting a
 * session opens the setup sheet (mode, numbers per lead, caller ID, voicemail).
 */
function DialModeCard({ V, onQueue }: { V: ClozrView; onQueue: () => void }) {
  const running = !!V.queueSession || !!V.talkrPhone.session.session;
  const count = V.callQueueCount;
  const start = (mode: 'power' | 'predictive') => {
    onQueue();
    void V.startQueue(mode);
  };
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 style={{ font: '650 16px/1.2 var(--sans)', letterSpacing: '-0.01em' }}>Dial a list</h2>
        <button type="button" onClick={onQueue} className="dial-link" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {count} in queue
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {DIAL_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="dial-mode"
            disabled={running || count === 0}
            onClick={() => start(m.id)}
            title={running ? 'A session is already running' : count === 0 ? 'Add people to your call queue first' : m.hint}
          >
            <span style={{ font: '600 14px/1 var(--sans)' }}>{m.label}</span>
            <span style={{ font: '400 12.5px/1.3 var(--sans)', color: 'var(--muted)' }}>{m.id === 'power' ? 'You press Next' : 'Dials ahead of you'}</span>
          </button>
        ))}
      </div>
      {running && <p role="status" style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>A session is running. Its controls are in the bar above.</p>}
    </Card>
  );
}

/* ── Team ─────────────────────────────────────────────────────────────────── */

type TeamMember = ReturnType<typeof useSoftphone>['team'][number];

/**
 * Who is on the floor and every zone's calling window, folded into one header
 * button. It used to be a full column; a rep glances at it, they do not work in it.
 */
function TeamMenu({ team, now }: { team: TeamMember[]; now: number | null }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const available = team.filter((m) => m.presence === 'available').length;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Team: ${available} available`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-2"
        style={{ minHeight: 32, border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--panel)', font: '600 12px/1 var(--sans)', cursor: 'pointer' }}
      >
        <Icon name="users" size={13} style={{ color: 'var(--muted)' }} />
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{available}</span>
        <span className="hidden lg:inline" style={{ color: 'var(--muted)', fontWeight: 500 }}>available</span>
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={panel} tabIndex={-1} role="dialog" aria-label="Team and calling windows" className="cz-menu cz-menu--right" style={{ top: 'calc(100% + 6px)', width: 'min(320px, calc(100vw - 32px))', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="flex flex-col gap-1">
              <span style={{ font: '600 12.5px/1.2 var(--sans)' }}>Team</span>
              {team.length === 0 && (
                <span style={{ font: '500 11.5px/1.35 var(--sans)', color: 'var(--muted)' }}>No teammates yet. Their local time and presence show here, so you know who can take a transfer.</span>
              )}
              {team.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5 py-1.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  <span className="mr-auto flex min-w-0 flex-col gap-0.5">
                    <span className="truncate" style={{ font: '600 12px/1.2 var(--sans)' }}>{m.display_name}</span>
                    <span style={{ font: '500 11px/1.2 var(--sans)', color: 'var(--muted)' }}>
                      {m.city ?? 'Zone not set'}
                      {m.timezone && now !== null ? ` · ${tzTime(m.timezone, now)} ${tzAbbr(m.timezone, now)}` : ''}
                    </span>
                  </span>
                  <StatusMarker
                    color={m.presence === 'available' ? 'var(--green)' : m.presence === 'away' ? 'var(--amber)' : 'var(--muted-2)'}
                    label={m.presence}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <span style={{ font: '600 12.5px/1.2 var(--sans)' }}>Calling windows</span>
              {ZONES.map(([label, tz]) => {
                const w = now === null ? null : callWindow(tz, now);
                return (
                  <div key={tz} className="flex items-center gap-2.5 py-1">
                    <span style={{ color: w ? w.color : 'var(--muted-2)', display: 'inline-flex' }}><Mark label="clock" /></span>
                    <span className="mr-auto" style={{ font: '500 12px/1 var(--sans)' }}>{label}</span>
                    <span style={{ font: '500 12px/1 var(--sans)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{now === null ? '—' : tzTime(tz, now)}</span>
                    <span style={{ font: '600 11px/1 var(--sans)', color: w ? w.color : 'var(--muted-2)', width: 72, textAlign: 'right' }}>
                      {w ? (w.safe ? 'Open' : 'Quiet hours') : '—'}
                    </span>
                  </div>
                );
              })}
              <span style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--muted)' }}>9:00 AM – 8:00 PM in the lead&apos;s local time.</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The sales floor's heading when supervision is off for this rep: who can listen in, and how. */
function SalesFloorFallback() {
  const { liveCalls } = useSoftphone();
  if (liveCalls !== null) return null;
  return (
    <>
      <h2 style={{ font: '650 16px/1.2 var(--sans)', letterSpacing: '-0.01em' }}>Sales floor</h2>
      <p style={{ font: '400 13px/1.45 var(--sans)', color: 'var(--muted)' }}>
        Teammates&apos; live calls show here, to listen, whisper or barge, for anyone given call monitoring in Talkr.
      </p>
    </>
  );
}

/** The desk is wide enough for the third column (Tailwind's xl, 1280px). */
function useWideDesk(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia('(min-width: 1280px)');
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia('(min-width: 1280px)').matches,
    () => true,
  );
}
