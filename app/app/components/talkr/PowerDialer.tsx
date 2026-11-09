'use client';

/**
 * The power dialer: a desk built around a list, the way CallTools, Mojo and
 * ReadyMode lay one out. Session bar on top (what the session is doing, its
 * numbers, Next / Pause / End). Left: the setup before a start, then every
 * line of the batch as it rings, the session's numbers and who is up next.
 * Centre: the call (controls, then wrap-up), the script with the live coach
 * and notes. Right: the outcome while the call is live, the record of
 * whoever is on the line, and their text thread.
 *
 * Every list runs on Talkr's server (app/clozr/usePowerDialer.ts): the
 * browser carries one live line and never decides who to ring. This file is
 * the surface only. Keys: N next, P pause, E end, M mute, D drop voicemail;
 * digits belong to the outcome picker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useDialerView, setDialerView, type DialerView } from '@/lib/dialer-view';
import { DIAL_MODES, HOTKEYS, MAX_LINES_PER_REP, clampLines, clock, hotkeyFor, lineIsLive, lineStateLabel, type DialLine, type DialMode } from '@/lib/power-dialer';
import { DIAL_PREFS_CHANGED, readPrefs, savePrefs, talkTime } from '@/lib/dial-session';
import { dialerReadiness, type ReadinessItem } from '@/lib/dialer-readiness';
import { formatPhone, toE164 } from '@/lib/talkr-web/time';
import type { CampaignQueueLeadDto } from '@/lib/talkr-web/api';
import { useSoftphone } from './softphoneAdapter';
import { TopBar } from './TopBar';
import { ActiveCall } from './ActiveCall';
import { LiveCallsStrip, MonitorCard } from './Supervision';
import { Icon } from './Icon';
import { Button, Card } from './ui';
import { IosSegmented } from './ios';
import type { ClozrRecord } from './CallContext';
import { CallProfileCard } from './CallProfileCard';
import { DialerTexts } from './DialerTexts';
import { ScriptPanel } from './ScriptPanel';
import { LiveCoach } from './LiveCoach';
import { RecordRail } from './RecordRail';
import { OutcomePicker } from './OutcomePicker';
import type { OutcomeKey } from '@/lib/call-outcomes';
import { openReach } from '@/app/components/record/reach';
import { useReadinessFacts, useReadinessFix } from './DialerReadiness';
import { openVoicemailRecorder } from './VoicemailDrop';
import { CreateProfileCard, useCallScripts, useWideDesk } from './DialerScreen';
import { LiveCallCard, NotesCard, TalkrNotSignedIn, WrapUpCard } from './DialerParts';
import { TalkrMark } from '@/app/components/brand/TalkrMark';
import '@/app/clozr/power-dialer.css';

/* ── The switch at the top of the Dialer: the phone, or this ─────────────── */

export function DialerViewToggle() {
  const view = useDialerView();
  return (
    <IosSegmented<DialerView>
      value={view}
      onChange={setDialerView}
      ariaLabel="Dialer view"
      options={[
        { value: 'phone', label: 'Phone' },
        { value: 'power', label: 'Power dialer' },
        { value: 'predictive', label: 'Predictive dialer' },
      ]}
    />
  );
}

/** The mode the page is showing. Predictive is its own face of the Dialer, not a setting inside the power dialer. */
function useDialMode(): DialMode {
  return useDialerView() === 'predictive' ? 'predictive' : 'power';
}

const MODE_TITLE: Record<DialMode, string> = { power: 'Power dialer', predictive: 'Predictive dialer' };

/* ── Session state, in one word ───────────────────────────────────────────── */

type Tone = 'off' | 'ring' | 'live' | 'stop';

/** A line still costing attention (dialing, ringing, on the line). */
const liveLine = (l: DialLine) => lineIsLive(l.state);

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/* ── The page ─────────────────────────────────────────────────────────────── */

export function PowerDialerScreen({ V }: { V: ClozrView }) {
  const pd = V.talkrPhone.session;
  const pageMode = useDialMode();
  const { callState, authed, active, team, monitor, toggleMute } = useSoftphone();
  const wide = useWideDesk();
  const running = !!pd.session;
  const paused = pd.session?.state === 'paused';
  const callUp = callState !== 'idle' || V.callState !== 'idle';
  const wrapping = callState === 'wrapup' || V.callState === 'wrap';
  const onCall = callUp && !wrapping;
  const ringing = running && !callUp && pd.lines.some(liveLine);
  const now = useNow(running);

  // The phone has its own screen: this page is the desk's.
  const isMobile = V.isMobile;
  const openPhone = useRef(V.openPhone);
  useEffect(() => { openPhone.current = V.openPhone; });
  useEffect(() => { if (isMobile) openPhone.current(); }, [isMobile]);

  // End is two presses: the first arms it for four seconds.
  const [endArmed, setEndArmed] = useState(false);
  useEffect(() => {
    if (!endArmed) return;
    const t = setTimeout(() => setEndArmed(false), 4000);
    return () => clearTimeout(t);
  }, [endArmed]);
  const confirmEnd = useCallback(() => {
    if (!endArmed) { setEndArmed(true); return; }
    setEndArmed(false);
    void pd.end();
  }, [endArmed, pd]);

  const canNext = running && !paused && !callUp && !pd.busy && !V.talkrPhone.extension.holdingSoftphone;
  const next = useCallback(() => { if (canNext) void pd.next(); }, [canNext, pd]);
  const pauseOrResume = useCallback(() => { if (running) void (paused ? pd.resume() : pd.pause()); }, [running, paused, pd]);

  // Keys, anywhere on the page that is not a field.
  const vmDrop = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = hotkeyFor(e);
      if (!action) return;
      if (action === 'next') { if (canNext) { e.preventDefault(); next(); } return; }
      if (action === 'pause') { if (running) { e.preventDefault(); pauseOrResume(); } return; }
      if (action === 'end') { if (running) { e.preventDefault(); confirmEnd(); } return; }
      if (action === 'mute') { if (onCall) { e.preventDefault(); toggleMute(); } return; }
      if (action === 'drop') { if (onCall) { e.preventDefault(); vmDrop.current?.(); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canNext, next, running, pauseOrResume, confirmEnd, onCall, toggleMute]);

  // The number on screen: the live call's other party, or who the batch is ringing.
  const callPhone = active
    ? (active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number)
    : callUp ? (toE164(V.callTarget?.phone ?? '') || null) : null;
  const winner = pd.winner;
  const phone = callPhone || (winner ? toE164(winner.phone) : null) || (pd.upNext[0]?.phone ? toE164(pd.upNext[0].phone) : null);
  const record: ClozrRecord | null = callUp ? V.callRecord : phone ? V.dialerRecordFor(phone) : null;
  const activeCallId = authed && active && active.record.id && active.record.id !== 'unknown' && active.record.id !== 'demo' ? active.record.id : undefined;
  const scripts = useCallScripts(V, { authed, activeCallId, phone, record });

  // The outcome picked while the call is live, held for the wrap-up so Enter there saves it.
  const [held, setHeld] = useState<OutcomeKey | null>(null);
  useEffect(() => { if (!callUp) setHeld(null); }, [callUp]);
  const liveTarget = onCall ? V.outcomeTarget : null;
  const openText = (p?: unknown) => {
    const box = document.querySelector<HTMLTextAreaElement>('.dial-texts .composer-pill textarea, #dial-text-draft');
    if (box && typeof p === 'string' && phone && toE164(p) === phone) return box.focus();
    return typeof p === 'string' && p ? openReach('text', { name: '', phone: p }) : V.goInbox();
  };

  // What the bar says.
  const who = winner?.name ?? V.callTarget?.name ?? null;
  const tone: Tone = !running ? 'off' : paused ? 'stop' : onCall ? 'live' : ringing || pd.busy ? 'ring' : 'off';
  const title = !running
    ? 'No session running'
    : paused ? 'Paused'
      : onCall && who ? `On the line with ${who}`
        : wrapping ? 'Wrapping up'
          : pd.countdown !== null ? `Next batch in ${pd.countdown}`
            : ringing ? `Ringing ${pd.lines.filter(liveLine).length} ${pd.lines.filter(liveLine).length === 1 ? 'line' : 'lines'}`
              : pd.busy ? 'Dialing'
                : pd.idle ? 'Nobody to dial'
                  : 'Ready for the next batch';
  const listName = pd.campaign?.name.replace(/^CLOZR list · /, '') ?? '';
  const subtitle = running
    ? [listName, `${pd.dialMode === 'predictive' ? 'Predictive' : 'Power'} · ${pd.lineCount} ${pd.lineCount === 1 ? 'line' : 'lines'}`, pd.amd ? 'Machines hear your voicemail' : 'Machines ring through'].filter(Boolean).join(' · ')
    : pageMode === 'predictive' ? 'Pick a list, lines and a voicemail. It dials on by itself after each call.' : 'Pick a list, lines and a voicemail. You press Next between calls.';

  const s = pd.stats;
  const rate = (n: number | null) => (n === null ? '–' : `${n}%`);

  const rail = (
    <>
      {callUp && <CallProfileCard V={V} />}
      {liveTarget && (
        <Card key={liveTarget.key}>
          <OutcomePicker V={V} target={liveTarget} variant="card" armed={false} canPick heading="Outcome" saveLabel="Save" onPick={setHeld} />
        </Card>
      )}
      {record ? (
        <RecordRail V={V} record={record} onText={openText} between={!wide && phone ? <DialerTexts V={V} phone={phone} /> : null} />
      ) : (
        <>
          <CreateProfileCard V={V} phone={phone ?? ''} />
          {!wide && phone && <DialerTexts V={V} phone={phone} />}
        </>
      )}
    </>
  );

  return (
    <>
      <TopBar title={MODE_TITLE[running ? pd.dialMode : pageMode]} subtitle={subtitle} titleSlot={<DialerViewToggle />} />
      <TalkrNotSignedIn V={V} />

      {/* ── Session bar ───────────────────────────────────────────────── */}
      <div className="pd-bar" data-live={onCall} data-paused={paused} role="status" aria-live="polite">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="pd-state">
            <span className="pd-dot" data-tone={tone} aria-hidden />
            <h2 className="pd-title">{title}</h2>
          </div>
          {running ? (
            <div className="pd-inline">
              <span><b>{s.dialed}</b> dialed</span>
              <span><b>{s.connected}</b> connected{s.contactRate !== null && <> · {rate(s.contactRate)}</>}</span>
              <span><b>{s.machines}</b> machines</span>
              <span><b>{s.abandoned}</b> abandoned{s.abandonRate !== null && <> · {rate(s.abandonRate)}</>}</span>
              <span><b>{talkTime(s.talkSeconds)}</b> talk</span>
              <span><b>{clock(s.elapsedSeconds)}</b> on the list</span>
              {s.remaining !== null && <span><b>{s.remaining}</b> left</span>}
            </div>
          ) : null}
          {(pd.error || pd.idle || pd.capNote) && (
            <p className="pd-sub" style={{ color: pd.error ? 'var(--red)' : 'var(--text)', whiteSpace: 'normal' }}>{pd.error ?? pd.idle ?? pd.capNote}</p>
          )}
        </div>
        {running && (
          <div className="pd-controls">
            <LineStepper value={pd.lineCount} onChange={(n) => void pd.setLineCount(n)} disabled={pd.busy} compact />
            {pd.countdown !== null ? (
              <Button tone="ghost" onClick={pd.cancelCountdown}>Stop the countdown</Button>
            ) : (
              <Button tone="ghost" onClick={pauseOrResume} disabled={pd.busy}>
                <Icon name={paused ? 'play' : 'pause'} size={13} />
                {paused ? 'Resume' : 'Pause'}<span className="pd-kbd">P</span>
              </Button>
            )}
            <Button tone={endArmed ? 'red' : 'ghost'} onClick={confirmEnd} disabled={pd.busy} title={endArmed ? 'Press again to end the session' : 'End the session'}>
              {endArmed ? 'End session?' : <>End<span className="pd-kbd">E</span></>}
            </Button>
            <Button tone="green" onClick={next} disabled={!canNext} title={callUp ? 'Finish the call on the line first' : paused ? 'Resume first' : 'Ring the next batch'} style={{ minWidth: 112 }}>
              <Icon name="phone" size={13} />
              Next<span className="pd-kbd" style={{ borderColor: 'rgba(255,255,255,.6)', opacity: 0.9 }}>N</span>
            </Button>
          </div>
        )}
      </div>

      {V.isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <Card className="flex w-full max-w-sm flex-col items-center gap-3" style={{ padding: '22px 18px' }}>
            <Icon name="phone" size={22} style={{ color: 'var(--accent)' }} />
            <span style={{ font: '600 15px/1.3 var(--sans)' }}>The phone runs the list</span>
            <span style={{ font: '400 13px/1.45 var(--sans)', color: 'var(--muted)' }}>Start a session from the Queue tab; its controls sit above the keypad.</span>
            <button type="button" onClick={() => V.openPhone()} className="w-full" style={{ height: 50, borderRadius: 14, border: 0, background: 'var(--accent)', color: '#fff', font: '600 17px/1 var(--sans)', cursor: 'pointer' }}>
              Open phone
            </button>
          </Card>
        </div>
      ) : (
        <div className="dial-desk flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className={`grid min-h-0 flex-1 gap-3 overflow-hidden p-3 ${wide ? 'grid-cols-[320px_minmax(0,1fr)_minmax(400px,1fr)]' : 'grid-cols-[300px_minmax(0,1fr)]'}`}>
            {/* ── Left: setup, or the batch, the numbers and who is next ── */}
            <div className="flex min-h-0 flex-col gap-3 overflow-auto">
              {!running ? (
                <>
                  {pd.summary && <SummaryCard V={V} />}
                  <SetupCard V={V} />
                </>
              ) : (
                <>
                  <LinesCard lines={pd.lines} now={now} drop={!!readPrefs(V.floorWorkspaceId, V.floorMe).vmClipId} idle={pd.idle} />
                  <StatsCard V={V} />
                  <UpNextCard leads={pd.upNext} />
                </>
              )}
            </div>

            {/* ── Centre: the call, then the script with the coach and notes ── */}
            <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto">
              {callUp ? (
                wrapping ? <WrapUpCard V={V} held={held} /> : monitor ? <MonitorCard /> : active ? <ActiveCall team={team} onText={openText} recording={V.rec} /> : null
              ) : running ? (
                <WaitingCard pd={pd} ringing={ringing} onNext={next} canNext={canNext} />
              ) : null}
              {onCall ? (
                <div className="dial-centre grid gap-3">
                  <Card padded={false} className="min-w-0">
                    <ScriptPanel scripts={scripts.scripts} rebuttals={scripts.rebuttals} values={scripts.values} openRebuttalId={scripts.openRebuttal} onRebuttalShown={scripts.rebuttalShown} onUsed={scripts.used} defaultId={scripts.pinned?.id ?? null} onDefault={scripts.makeDefault} />
                  </Card>
                  <LiveCoach V={V} rebuttals={scripts.rebuttals} values={scripts.values} onOpenRebuttal={scripts.setOpenRebuttal} />
                </div>
              ) : (
                <Card padded={false} className="min-w-0">
                  <ScriptPanel scripts={scripts.scripts} rebuttals={scripts.rebuttals} values={scripts.values} onUsed={scripts.used} defaultId={scripts.pinned?.id ?? null} onDefault={scripts.makeDefault} />
                </Card>
              )}
              {onCall && <LiveCallCard V={V} part="intel" />}
              <NotesCard V={V} />
              {!wide && rail}
            </div>

            {/* ── Right: the outcome, the record, the thread ─────────────── */}
            {wide && (
              <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
                <div className={`flex min-h-0 flex-col gap-3 overflow-auto ${phone ? 'max-h-[calc(100%-392px)] shrink-0' : 'flex-1'}`}>
                  {rail}
                </div>
                {phone && <DialerTexts V={V} phone={phone} fill />}
              </div>
            )}
          </div>
          <LiveCallsStrip />
        </div>
      )}
    </>
  );
}

/* ── Between batches ──────────────────────────────────────────────────────── */

function WaitingCard({ pd, ringing, onNext, canNext }: { pd: ClozrView['talkrPhone']['session']; ringing: boolean; onNext: () => void; canNext: boolean }) {
  if (ringing || pd.busy) {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="dial-h">{ringing ? 'Ringing' : 'Dialing'}</h2>
        <p className="dial-hint">Talkr is ringing the lines. The first person to pick up is put through to you; the rest hear your voicemail or an identification message.</p>
      </Card>
    );
  }
  if (pd.countdown !== null) {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="dial-h">Next batch in {pd.countdown}</h2>
        <p className="dial-hint">Predictive presses Next for you. Stop the countdown in the bar to take a breath.</p>
      </Card>
    );
  }
  if (pd.session?.state === 'paused') {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="dial-h">Paused</h2>
        <p className="dial-hint">Nothing dials until you resume. Your place in the list is kept.</p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="dial-h">{pd.idle ? 'Nobody to dial' : 'Ready'}</h2>
        <p className="dial-hint">{pd.idle ?? `Next rings ${pd.lineCount} ${pd.lineCount === 1 ? 'person' : 'people'} at once. Read the script while they ring; the lines panel shows who answers.`}</p>
      </div>
      {!pd.idle && (
        <Button tone="green" onClick={onNext} disabled={!canNext} style={{ justifyContent: 'center' }}>
          <Icon name="phone" size={14} />
          Ring the next batch
        </Button>
      )}
      <div className="pd-keys" aria-label="Keyboard shortcuts">
        {HOTKEYS.map((h) => <span key={h.key}><span className="pd-kbd" style={{ marginLeft: 0, marginRight: 4 }}>{h.key}</span>{h.does}</span>)}
        <span><span className="pd-kbd" style={{ marginLeft: 0, marginRight: 4 }}>1–9</span>Outcome in the wrap-up</span>
      </div>
    </Card>
  );
}

/* ── The lines of the batch ───────────────────────────────────────────────── */

function LinesCard({ lines, now, drop, idle }: { lines: DialLine[]; now: number; drop: boolean; idle: string | null }) {
  const order = (l: DialLine) => (l.state === 'talking' ? 0 : lineIsLive(l.state) ? 1 : 2);
  const sorted = [...lines].sort((a, b) => order(a) - order(b));
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="dial-h">Lines</h2>
        {lines.length > 0 && <span className="dial-label" style={{ fontVariantNumeric: 'tabular-nums' }}>{lines.filter(liveLine).length} of {lines.length} live</span>}
      </div>
      {sorted.length === 0 ? (
        <p className="dial-hint">{idle ? 'The list is done.' : 'Nothing ringing. Press Next.'}</p>
      ) : (
        <ul className="pd-lines" aria-label="Lines in this batch">
          {sorted.map((l) => {
            const live = lineIsLive(l.state);
            const city = l.card?.property ? [l.card.property.city, l.card.property.state].filter(Boolean).join(', ') : '';
            return (
              <li key={l.callId} className="pd-line" data-state={l.state} data-live={live}>
                <span className="pd-line-name">{l.name}</span>
                <span className="pd-line-meta" title={l.from ? `From ${l.from}` : undefined}>
                  {formatPhone(l.phone)}{city && ` · ${city}`}{l.from && ` · from ${l.from}`}
                </span>
                <span className="pd-line-state">
                  <span>{lineStateLabel(l.state, drop)}</span>
                  {live && <span className="pd-line-clock">{clock((now - l.since) / 1000)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ── The session's numbers ────────────────────────────────────────────────── */

function StatsCard({ V }: { V: ClozrView }) {
  const pd = V.talkrPhone.session;
  const s = pd.stats;
  const t = pd.tally;
  const pct = (n: number | null) => (n === null ? '–' : `${n}%`);
  const abandonTone = s.abandonRate === null ? undefined : s.abandonRate >= 3 ? 'bad' : s.abandonRate >= 2 ? 'warn' : undefined;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="dial-h">This session</h2>
      <dl className="pd-stats">
        <div className="pd-stat"><span>Dialed</span><span>{s.dialed}</span></div>
        <div className="pd-stat"><span>Connected</span><span>{s.connected}<small>{pct(s.contactRate)}</small></span></div>
        <div className="pd-stat"><span>Machines</span><span>{s.machines}</span></div>
        <div className="pd-stat" data-tone={abandonTone}><span>Abandoned</span><span>{s.abandoned}<small>{pct(s.abandonRate)} of 3%</small></span></div>
        <div className="pd-stat"><span>Talk time</span><span>{talkTime(s.talkSeconds)}</span></div>
        <div className="pd-stat"><span>Per call</span><span>{s.avgTalkSeconds === null ? '–' : talkTime(s.avgTalkSeconds)}</span></div>
        <div className="pd-stat"><span>Pace</span><span>{s.dialsPerHour === null ? '–' : `${s.dialsPerHour}`}<small>/hr</small></span></div>
        <div className="pd-stat"><span>Left in list</span><span>{s.remaining ?? '–'}</span></div>
        <div className="pd-stat"><span>Appointments</span><span>{t.appointments}</span></div>
        <div className="pd-stat"><span>Offer-ready</span><span>{t.offers}</span></div>
        <div className="pd-stat"><span>Follow-ups</span><span>{t.followUps}</span></div>
        <div className="pd-stat" data-tone={t.dnc ? 'bad' : undefined}><span>Do not call</span><span>{t.dnc}</span></div>
      </dl>
    </Card>
  );
}

/* ── Who is next ──────────────────────────────────────────────────────────── */

function UpNextCard({ leads }: { leads: CampaignQueueLeadDto[] }) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="dial-h">Up next</h2>
        <span className="dial-label">In order</span>
      </div>
      {leads.length === 0 ? (
        <p className="dial-hint">Nobody left that can be dialed right now.</p>
      ) : (
        <ol className="flex flex-col" aria-label="Up next">
          {leads.map((l, i) => {
            const where = [l.address, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
            return (
              <li key={l.campaign_lead_id} className="pd-next">
                <span className="pd-next-n">{i + 1}</span>
                <span className="pd-next-name">{l.name ?? (l.phone ? formatPhone(l.phone) : 'Lead')}</span>
                <span className="pd-next-sub">{where || (l.phone ? formatPhone(l.phone) : '')}</span>
                {l.attempts > 0 && <span className="pd-next-try" title={`${l.attempts} ${l.attempts === 1 ? 'try' : 'tries'} so far`}>Try {l.attempts + 1}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ── After a session ──────────────────────────────────────────────────────── */

function SummaryCard({ V }: { V: ClozrView }) {
  const pd = V.talkrPhone.session;
  const sum = pd.summary;
  if (!sum) return null;
  const s = sum.stats;
  const t = sum.tally;
  const pct = (n: number | null) => (n === null ? '–' : `${n}%`);
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="dial-h">{sum.title}</h2>
        <span className="dial-label">{sum.how === 'finished' ? 'Finished' : 'Ended'} · {sum.mode === 'predictive' ? 'Predictive' : 'Power'} · {sum.lines} {sum.lines === 1 ? 'line' : 'lines'}</span>
      </div>
      <dl className="pd-stats">
        <div className="pd-stat"><span>Dialed</span><span>{s.dialed}</span></div>
        <div className="pd-stat"><span>Connected</span><span>{s.connected}<small>{pct(s.contactRate)}</small></span></div>
        <div className="pd-stat"><span>Machines</span><span>{s.machines}</span></div>
        <div className="pd-stat"><span>Abandoned</span><span>{s.abandoned}<small>{pct(s.abandonRate)}</small></span></div>
        <div className="pd-stat"><span>Talk time</span><span>{talkTime(s.talkSeconds)}</span></div>
        <div className="pd-stat"><span>On the list</span><span>{clock(s.elapsedSeconds)}</span></div>
        <div className="pd-stat"><span>Appointments</span><span>{t.appointments}</span></div>
        <div className="pd-stat"><span>Offer-ready</span><span>{t.offers}</span></div>
        <div className="pd-stat"><span>Follow-ups</span><span>{t.followUps}</span></div>
        <div className="pd-stat"><span>Not interested</span><span>{t.notInterested}</span></div>
        <div className="pd-stat"><span>Wrong numbers</span><span>{t.wrong}</span></div>
        <div className="pd-stat"><span>Do not call</span><span>{t.dnc}</span></div>
      </dl>
      <Button tone="ghost" onClick={pd.dismissSummary} style={{ alignSelf: 'flex-start' }}>Done</Button>
    </Card>
  );
}

/* ── Setup ────────────────────────────────────────────────────────────────── */

function LineStepper({ value, onChange, disabled = false, compact = false }: { value: number; onChange: (n: number) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <span className="pd-stepper" role="group" aria-label="Lines per batch" title="How many people ring at once. The first to answer is yours; the rest hear your voicemail.">
      <button type="button" aria-label="One line fewer" disabled={disabled || value <= 1} onClick={() => onChange(clampLines(value - 1))}><Icon name="minus" size={13} /></button>
      <output aria-live="polite">{value}{compact ? '' : value === 1 ? ' line' : ' lines'}</output>
      <button type="button" aria-label="One line more" disabled={disabled || value >= MAX_LINES_PER_REP} onClick={() => onChange(clampLines(value + 1))}><Icon name="plus" size={13} /></button>
    </span>
  );
}

function ReadinessRow({ item, busy, onFix }: { item: ReadinessItem; busy: boolean; onFix: (a: NonNullable<ReadinessItem['fix']>['action']) => void }) {
  return (
    <li className="pd-check" data-state={item.state}>
      <Icon name={item.state === 'ok' ? 'check' : 'x'} size={14} style={{ flex: 'none', marginTop: 2 }} />
      <span className="min-w-0 flex-1">
        {item.title}
        <small>{item.detail}</small>
      </span>
      {item.fix && item.state !== 'ok' && (
        <Button tone="ghost" className="pd-check-fix" disabled={busy} onClick={() => onFix(item.fix!.action)} style={{ padding: '5px 9px', font: '600 11.5px/1 var(--sans)' }}>
          {item.fix.label}
        </Button>
      )}
    </li>
  );
}

const WEBM = /\.webm$/i;

function SetupCard({ V }: { V: ClozrView }) {
  const pd = V.talkrPhone.session;
  const ws = V.floorWorkspaceId;
  const uid = V.floorMe;
  const [prefsRev, setPrefsRev] = useState(0);
  useEffect(() => {
    const on = () => setPrefsRev((n) => n + 1);
    window.addEventListener(DIAL_PREFS_CHANGED, on);
    return () => window.removeEventListener(DIAL_PREFS_CHANGED, on);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prefs = useMemo(() => readPrefs(ws, uid), [ws, uid, prefsRev]);
  const { facts, clips, reload, recheckMic } = useReadinessFacts(V);
  const noop = useCallback(() => undefined, []);
  const { fix, fixing } = useReadinessFix(V, recheckMic, noop);
  useEffect(() => { void reload(); recheckMic(); }, [reload, recheckMic]);

  const queueCount = V.callQueueCount;
  const sources = useMemo(() => [
    { id: 'queue', title: V.callQueueManual ? 'Your call queue' : 'Today', count: queueCount },
    ...pd.campaigns.map((c) => ({ id: c.id, title: c.name, count: c.lead_counts?.pending ?? null })),
  ], [V.callQueueManual, queueCount, pd.campaigns]);
  const [source, setSource] = useState('queue');
  const picked = sources.find((x) => x.id === source) ?? sources[0]!;
  // Power or predictive is the face of the Dialer the rep is on (the switch in the title bar).
  const mode = useDialMode();
  const [lines, setLines] = useState(prefs.lines);
  const [amd, setAmd] = useState(true);
  const [vmPick, setVmPick] = useState<number | null | undefined>(undefined);
  const recorded = clips.filter((c) => !!c.audio_path && !WEBM.test(c.audio_path));
  const mine = recorded.filter((c) => !!uid && c.created_by === uid);
  const remembered = recorded.some((c) => c.id === prefs.vmClipId) ? prefs.vmClipId : null;
  const vmClipId = vmPick !== undefined ? vmPick : remembered ?? (mine[mine.length - 1] ?? recorded[0])?.id ?? null;
  const items = facts ? dialerReadiness(facts, mode) : [];
  const blocked = items.some((i) => i.state === 'missing') || picked.count === 0 || !!pd.session;

  const start = () => {
    if (blocked) return;
    const n = clampLines(lines);
    savePrefs(ws, uid, { mode, depth: prefs.depth, vmClipId, lines: n });
    if (picked.id === 'queue') void V.startQueue(mode, n, amd);
    else void pd.start(picked.id, mode, n, { title: picked.title, amd });
  };

  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h2 className="dial-h">Dial a list</h2>
        <p className="dial-hint">{DIAL_MODES.find((m) => m.id === mode)?.hint}</p>
      </div>

      <div className="pd-field">
        <span className="dial-label">List</span>
        <select value={picked.id} onChange={(e) => setSource(e.target.value)} aria-label="List to dial" className="sp-select" style={{ font: '600 13px/1 var(--sans)' }}>
          {sources.map((x) => (
            <option key={x.id} value={x.id}>{x.title}{x.count !== null ? ` · ${x.count}` : ''}</option>
          ))}
        </select>
        {picked.count === 0 && <p className="dial-hint" style={{ color: 'var(--amber)' }}>Nobody is on this list. Add people to your queue first.</p>}
      </div>

      <div className="pd-field">
        <span className="dial-label">Lines at once</span>
        <div className="flex items-center gap-3">
          <LineStepper value={lines} onChange={setLines} compact />
          <span className="dial-hint">{lines === 1 ? 'One person at a time.' : `${lines} ring together; the first to answer is yours.`}</span>
        </div>
        {facts && !facts.callerId && <p className="dial-hint" style={{ color: 'var(--amber)' }}>You have no line of your own, so calls go out on the office numbers.</p>}
      </div>

      <div className="pd-field">
        <span className="dial-label">Voicemail on a machine</span>
        <div className="flex items-center gap-2">
          <select value={vmClipId ?? ''} onChange={(e) => setVmPick(e.target.value ? Number(e.target.value) : null)} aria-label="Voicemail to drop" className="sp-select min-w-0 flex-1" style={{ font: '500 12.5px/1 var(--sans)' }}>
            <option value="">None: hang up on machines</option>
            {recorded.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button tone="ghost" onClick={openVoicemailRecorder} title="Record a new voicemail"><Icon name="mic" size={13} />Record</Button>
        </div>
        <label className="pd-toggle">
          <input type="checkbox" checked={amd} onChange={(e) => setAmd(e.target.checked)} />
          Detect answering machines{amd ? '' : ' (off: machines ring through to you)'}
        </label>
      </div>

      {items.length > 0 && (
        <div className="pd-field">
          <span className="dial-label">Before you start</span>
          <ul className="flex flex-col">
            {items.map((it) => <ReadinessRow key={it.key} item={it} busy={!!fixing} onFix={(a) => void fix(a)} />)}
          </ul>
        </div>
      )}

      {pd.error && <p className="dial-hint" style={{ color: 'var(--red)' }}>{pd.error}</p>}
      <Button tone="green" onClick={start} disabled={blocked || pd.busy} style={{ justifyContent: 'center', minHeight: 36 }} title={pd.session ? 'A session is already running' : blocked ? 'Fix what is listed above first' : undefined}>
        <Icon name="phone" size={14} />
        {pd.busy ? 'Starting…' : `Start dialing ${picked.title}`}
      </Button>
      <span className="flex items-center gap-1.5 dial-hint"><TalkrMark size={12} /> Calls rotate across your own numbers, local area code first.</span>
    </Card>
  );
}

/* ── The phone's strip ────────────────────────────────────────────────────── */

export function PowerDialerStrip({ V }: { V: ClozrView }) {
  const pd = V.talkrPhone.session;
  const { callState } = useSoftphone();
  if (!pd.session) return null;
  const paused = pd.session.state === 'paused';
  const callUp = callState !== 'idle';
  const live = pd.lines.filter(liveLine).length;
  const s = pd.stats;
  const title = paused ? 'Paused' : callUp ? (pd.winner?.name ?? 'On a call') : pd.countdown !== null ? `Next in ${pd.countdown}` : live ? `Ringing ${live}` : pd.idle ? 'Nobody to dial' : 'Ready';
  const canNext = !paused && !callUp && !pd.busy;
  return (
    <div className="pd-strip" data-live={callUp} role="status">
      <span className="pd-strip-text">
        <span className="pd-strip-title">{title}</span>
        <span className="pd-strip-sub">{s.dialed} dialed · {s.connected} connected · {pd.lineCount} {pd.lineCount === 1 ? 'line' : 'lines'}{s.remaining !== null ? ` · ${s.remaining} left` : ''}</span>
      </span>
      <span className="pd-strip-btns">
        <button type="button" className="phone-iconbtn" aria-label={paused ? 'Resume' : 'Pause'} onClick={() => void (paused ? pd.resume() : pd.pause())}><Icon name={paused ? 'play' : 'pause'} size={18} /></button>
        <button type="button" className="phone-iconbtn" aria-label="End session" onClick={() => { if (window.confirm('End the session?')) void pd.end(); }}><Icon name="x" size={18} /></button>
        <button type="button" className="phone-iconbtn" aria-label="Next batch" disabled={!canNext} onClick={() => void pd.next()} style={{ background: canNext ? 'var(--phone-mint)' : undefined, color: canNext ? '#fff' : undefined }}><Icon name="phone" size={18} /></button>
      </span>
    </div>
  );
}
