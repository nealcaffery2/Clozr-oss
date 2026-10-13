'use client';

/**
 * The power dialer's bar: what a rep drives a list from.
 *
 * Talkr has run dial sessions since Phase 5 and CLOZR had the client for them
 * with nothing on screen calling it — "Start session" dialled the first row of
 * the CRM's own queue and stopped there. This is the surface Kixie and
 * ReadyMode put on an answered call and this one did not have: where you are
 * in the list, Next, and a way to stop without losing your place.
 *
 * It sits above the call rather than inside it on purpose. The call's own
 * controls are about the person on the line; these are about the list, they
 * matter in every phase — mid-call, in wrap-up and between calls — and a
 * control that moves between phases is a control a rep stops trusting.
 *
 * Nothing here decides who to ring. Suppression, the per-day attempt cap and
 * the lead's own calling window are selection-time rules on the server
 * (talkr/docs/dialers.md §3), and "nobody to dial" comes back as an answer
 * with a reason rather than an error — so the bar says which, instead of
 * going quiet and leaving the rep to guess the list is finished.
 */

import { useState, type ReactNode } from 'react';
import { DIAL_MODES, autoAdvances, type DialMode } from '@/lib/dial-engine';
import type { ClozrView } from '@/app/clozr/view';
import { Icon } from './Icon';
import { Button } from './ui';
import { PhoneSheet } from './ios';
import { TalkrMark } from '@/app/components/brand/TalkrMark';
import { confirmDialerReady } from '@/lib/dialer-readiness';
import { requestSessionSetup } from '@/lib/dial-session';
import { DialerSetupFlag } from './DialerReadiness';
import { SessionMeter, SessionStats } from './SessionSummary';

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="display" style={{ font: '700 14px/1 var(--sans)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}>
        {label}
      </span>
    </span>
  );
}

/**
 * Offered where the session is not yet running. A rep with no active campaign
 * sees nothing at all rather than a button that can only fail.
 *
 * This walks a Talkr campaign, which is a different list from the CLOZR queue
 * under it — so it says "campaign" on its button, and the queue's own Start
 * session is the one that dials the people listed there.
 */
function ModePick({ mode, onChange }: { mode: DialMode; onChange: (m: DialMode) => void }) {
  return (
    <span className="inline-flex overflow-hidden" style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
      {DIAL_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          title={m.hint}
          onClick={() => onChange(m.id)}
          style={{
            border: 0, padding: '6px 10px', cursor: 'pointer', font: '600 11px/1 var(--sans)',
            background: mode === m.id ? 'var(--green)' : 'transparent',
            color: mode === m.id ? '#fff' : 'var(--text)',
          }}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}

export function DialSessionStart({ V }: { V: ClozrView }) {
  const { session, campaigns, start, busy, error } = V.talkrPhone.session;
  const [picked, setPicked] = useState<string>('');
  const [mode, setMode] = useState<DialMode>('power');
  // A running session has its bar; Start beside it could only be refused.
  if (session || V.queueSession || campaigns.length === 0) return null;
  const campaignId = picked || campaigns[0]!.id;

  return (
    <div className="flex flex-col gap-2 p-3" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)' }}>
      <span className="flex items-center gap-1.5" style={{ font: '600 11.5px/1 var(--sans)' }}>
        <TalkrMark size={13} />
        Talkr campaign
      </span>
      <span style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
        {mode === 'predictive'
          ? 'Talkr dials ahead, drops a voicemail when a machine answers, and stops if abandonment crosses 3%.'
          : 'Talkr picks who to ring next, in their calling window and inside the attempt caps. You press Next.'}
      </span>
      <ModePick mode={mode} onChange={setMode} />
      <div className="flex items-center gap-2">
        {campaigns.length > 1 ? (
          <select
            value={campaignId}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Campaign"
            className="min-w-0 flex-1"
            style={{
              border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--panel)',
              color: 'var(--text)', padding: '8px 10px', font: '500 12px/1 var(--sans)',
            }}
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate" style={{ font: '600 12px/1 var(--sans)' }}>
            {campaigns[0]!.name}
          </span>
        )}
        <Button
          tone="green"
          disabled={busy}
          onClick={() => {
            // The setup sheet first (DialSessionSetup.tsx): mode, caller ID,
            // voicemail and the checklist. Without one on screen, the
            // checklist alone when something is missing (lib/dialer-readiness.ts).
            const asked = requestSessionSetup({
              kind: 'campaign',
              lists: campaigns.map((c) => ({ id: c.id, title: c.name, facts: null, hasRecords: false })),
              listId: campaignId,
              mode,
              depth: null,
            });
            if (asked !== false) {
              void asked.then((c) => {
                if (!c) return;
                setPicked(c.listId);
                setMode(c.mode);
                void start(c.listId, c.mode);
              });
              return;
            }
            const ready = confirmDialerReady(mode);
            if (ready === true) void start(campaignId, mode);
            else void ready.then((yes) => { if (yes) void start(campaignId, mode); });
          }}
        >
          {busy ? 'Starting…' : mode === 'predictive' ? 'Start predictive' : 'Dial campaign'}
        </Button>
      </div>
      {error && (
        <span role="alert" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</span>
      )}
      <DialerSetupFlag />
    </div>
  );
}

/**
 * The same bar for a session over a CLOZR list (the call queue, or a vendor
 * call list). CLOZR records are not Talkr leads, so the list is walked in the
 * CRM: Next skips anyone without a number or marked do not call, and each
 * person dialled comes off the list. With Numbers per lead above 1, a person
 * is tried on each of their numbers in turn: the bar says which one, and Next
 * person moves on without the rest.
 */
/** "Up next: Kara Mitchell · Seller · New Lead · 1424 Oak St", between calls. */
function UpNext({ next, dark = false }: { next: NonNullable<NonNullable<ClozrView['queueSession']>['upNext']>; dark?: boolean }) {
  return (
    <span data-testid="session-up-next" className="truncate" style={{ font: '500 11px/1.35 var(--sans)', color: dark ? 'rgba(255,255,255,.6)' : 'var(--muted)' }}>
      Up next: <b style={{ fontWeight: 600, color: dark ? '#fff' : 'var(--text)' }}>{next.name}</b>
      {[next.kind, next.stage, next.line].filter(Boolean).map((x) => ` · ${x}`).join('')}
    </span>
  );
}

function QueueSessionBar({ V, run }: { V: ClozrView; run: NonNullable<ClozrView['queueSession']> }) {
  const onCall = V.callState !== 'idle';
  const [open, setOpen] = useState(false);
  const p = run.progress;
  return (
    <div
      className="flex flex-col gap-2 px-3.5 py-2.5"
      style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--line)' }}
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="talkr-rec-dot" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--green)' }} />
            <span className="truncate" style={{ font: '700 12px/1 var(--sans)' }}>{run.title}</span>
            <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted)' }}>{run.mode === 'predictive' ? 'Predictive' : 'Power'}</span>
          </span>
          <span data-testid="session-position" style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
            {p.position ? `${p.position} of ${p.people}` : `${p.people} people`}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-3.5">
          <Stat value={run.dialed} label="Dialed" />
          <Stat value={p.reached} label="Reached" />
          {run.dropped > 0 && <Stat value={run.dropped} label="Dropped" />}
          <Stat value={run.left} label="Left" />
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide session details' : 'Show session details'}
            onClick={() => setOpen((v) => !v)}
            style={{ border: '1px solid var(--line)', background: 'var(--panel)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}
          >
            <Icon name="chevron-down" size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
          </button>
        </span>
      </div>
      <SessionMeter percent={p.percent} />
      {open && (
        <div className="py-1">
          <SessionStats stats={{ progress: p, tally: run.tally, dialed: run.dialed, dropped: run.dropped, skipped: run.skipped }} />
        </div>
      )}
      {run.number && (
        <span role="status" className="truncate" style={{ font: '500 11px/1.35 var(--sans)', color: 'var(--muted)' }}>
          {run.number.name} · number {run.number.n} of {run.number.of} · {run.number.phone}
        </span>
      )}
      {run.upNext && <UpNext next={run.upNext} />}
      <div className="flex items-center gap-2">
        <Button
          tone="green"
          disabled={onCall}
          title={V.callState === 'live' ? 'Finish the call on the line first.' : onCall ? 'Save how the last call went first.' : undefined}
          onClick={run.next}
          style={{ flex: 1 }}
        >
          <Icon name="phone" size={13} />
          {run.nextLabel}
        </Button>
        {run.skipPerson && (
          <Button tone="ghost" onClick={run.skipPerson} title="Skip the rest of their numbers and go on to the next person">
            <Icon name="forward" size={13} />
            Next person
          </Button>
        )}
        <Button tone="ghost" onClick={run.end} style={{ color: 'var(--red)' }}>
          End
        </Button>
      </div>
      {run.hold && (
        <span role="status" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>{run.hold}</span>
      )}
      <DialerSetupFlag />
    </div>
  );
}

/**
 * The full-screen phone's version (PhoneScreen.tsx): one dark line of where
 * the list stands, a thumb-sized Next, and Pause / End session behind •••,
 * so the list's End is never a red button beside the call's.
 */
function CompactSessionBar({
  title,
  stats,
  nextLabel,
  nextReason,
  onNext,
  paused,
  busy,
  onPauseResume,
  onSkip,
  onEnd,
  note,
  error,
  details,
  percent,
}: {
  title: string;
  stats: string;
  nextLabel: string;
  nextReason?: string;
  onNext: () => void;
  paused?: boolean;
  busy?: boolean;
  onPauseResume?: () => void;
  /** A CLOZR list walking someone's numbers: go on to the next person instead. */
  onSkip?: (() => void) | null;
  onEnd: () => void;
  note?: string | null;
  error?: string | null;
  /** A CLOZR list: the session's numbers, at the top of the ••• sheet. */
  details?: ReactNode;
  /** How far down the list, 0–100. */
  percent?: number;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div data-testid="phone-session" className="flex flex-col gap-2" style={{ margin: '0 16px 8px' }}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={paused ? undefined : 'talkr-rec-dot'} style={{ width: 8, height: 8, borderRadius: 999, flex: 'none', background: paused ? 'rgba(255,255,255,.4)' : '#3DDC97' }} />
        <span className="min-w-0 flex-1 truncate" style={{ font: '400 13px/1.3 var(--sans)', color: 'rgba(255,255,255,.6)' }}>
          <b style={{ fontWeight: 600, color: '#fff' }}>{title}</b> · {stats}
        </span>
        <button type="button" className="phone-iconbtn" aria-label="Session options" onClick={() => setMenu(true)}>
          <Icon name="more" size={22} strokeWidth={3} />
        </button>
      </div>
      {percent !== undefined && <SessionMeter percent={percent} dark />}
      <button
        type="button"
        aria-disabled={nextReason ? true : undefined}
        onClick={() => {
          if (!nextReason) onNext();
        }}
        style={{
          height: 50, borderRadius: 14, border: 0, background: '#0A8560', color: '#fff', font: '600 17px/1 var(--sans)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: nextReason ? 0.45 : 1,
        }}
      >
        <Icon name="phone" size={17} />
        {nextLabel}
      </button>
      {(nextReason || note) && (
        <span style={{ font: '400 13px/1.35 var(--sans)', color: 'rgba(255,255,255,.6)' }}>{nextReason ?? note}</span>
      )}
      {error && (
        <span role="alert" style={{ font: '400 13px/1.35 var(--sans)', color: '#FF6961' }}>{error}</span>
      )}
      <PhoneSheet open={menu} onClose={() => setMenu(false)} title={title}>
        {details && <div style={{ padding: '4px 16px 12px' }}>{details}</div>}
        {onPauseResume && (
          <button
            type="button"
            className="phone-row"
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (busy) return;
              setMenu(false);
              onPauseResume();
            }}
          >
            <Icon name={paused ? 'play' : 'pause'} size={20} />
            {paused ? 'Resume session' : 'Pause session'}
          </button>
        )}
        {onSkip && (
          <button
            type="button"
            className="phone-row"
            onClick={() => {
              setMenu(false);
              onSkip();
            }}
          >
            <Icon name="forward" size={20} />
            Skip their other numbers
          </button>
        )}
        <button
          type="button"
          className="phone-row"
          aria-disabled={busy ? true : undefined}
          style={{ color: '#FF453A' }}
          onClick={() => {
            if (busy) return;
            setMenu(false);
            onEnd();
          }}
        >
          <Icon name="x" size={20} />
          End session
        </button>
      </PhoneSheet>
    </div>
  );
}

export { ModePick };

export function DialSessionBar({ V, variant = 'default' }: { V: ClozrView; variant?: 'default' | 'compact' }) {
  const { session, campaign, card, remaining, idle, error, busy, next, pause, resume, end, machines, capNote, background } =
    V.talkrPhone.session;
  if (!session) {
    const run = V.queueSession;
    if (!run) return null;
    if (variant !== 'compact') return <QueueSessionBar V={V} run={run} />;
    const onCall = V.callState !== 'idle';
    return (
      <CompactSessionBar
        title={run.title}
        stats={`${run.progress.position ? `${run.progress.position} of ${run.progress.people}` : `${run.progress.people} people`} · ${run.dialed} dialed · ${run.progress.reached} reached${run.dropped > 0 ? ` · ${run.dropped} dropped` : ''} · ${run.left} left`}
        percent={run.progress.percent}
        details={<SessionStats dark columns={2} stats={{ progress: run.progress, tally: run.tally, dialed: run.dialed, dropped: run.dropped, skipped: run.skipped }} />}
        nextLabel={run.nextLabel}
        nextReason={V.callState === 'live' ? 'Finish the call on the line first.' : onCall ? 'Save how the last call went first.' : undefined}
        onNext={run.next}
        onSkip={run.skipPerson}
        onEnd={run.end}
        note={run.hold ?? (run.number ? `${run.number.name}: number ${run.number.n} of ${run.number.of} · ${run.number.phone}` : null)
          ?? (run.upNext ? `Up next: ${run.upNext.name}${[run.upNext.kind, run.upNext.stage, run.upNext.line].filter(Boolean).map((x) => ` · ${x}`).join('')}` : null)}
      />
    );
  }

  // The server hands back the lead card with the call, before the seller
  // answers. The property is the half a rep cannot get from the number.
  const place = card?.property
    ? [card.property.address_line1, card.property.city, card.property.state].filter(Boolean).join(', ')
    : null;

  const paused = session.state === 'paused';
  // Next dials. It must not be reachable while a call is up — the server
  // refuses it (session_call_in_flight) — nor in wrap-up, where it would
  // replace the call still waiting for its outcome and progressive would
  // never see the disposition it advances on.
  const onCall = V.callState !== 'idle';
  const extensionHasPhone = V.talkrPhone.extension.holdingSoftphone;
  const nextReason = V.callState === 'live'
    ? 'Finish the call on the line first.'
    : onCall
      ? 'Save how the last call went first.'
      : extensionHasPhone
        ? 'The Talkr extension has the phone. Run the session from there.'
        : paused
          ? 'The session is paused.'
          : undefined;

  if (variant === 'compact') {
    return (
      <CompactSessionBar
        title={campaign?.name ?? 'Dial session'}
        stats={`${session.dialed} dialed · ${session.connected} talked${remaining !== null ? ` · ${remaining} left` : ''}${paused ? ' · paused' : ''}${background.length ? ` · ${background.length} ringing` : ''}`}
        nextLabel={busy ? 'Dialling…' : 'Next call'}
        nextReason={busy ? undefined : nextReason}
        onNext={() => {
          if (!busy) void next();
        }}
        paused={paused}
        busy={busy}
        onPauseResume={() => void (paused ? resume() : pause())}
        onEnd={() => void end()}
        note={idle ?? (place && !paused ? place : null) ?? (background.length ? background.map((l) => `Ringing ${l.name}`).join(' · ') : null)}
        error={error}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-2 px-3.5 py-2.5"
      style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--line)' }}
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={paused ? undefined : 'talkr-rec-dot'}
              style={{ width: 7, height: 7, borderRadius: 999, background: paused ? 'var(--muted-2)' : 'var(--green)' }}
            />
            <span className="truncate" style={{ font: '700 12px/1 var(--sans)' }}>
              {campaign?.name ?? 'Dial session'}
            </span>
          </span>
          <span className="truncate" style={{ font: '500 10px/1.3 var(--sans)', color: 'var(--muted)' }}>
            {paused ? 'Paused' : place ? `${session.mode} · ${place}` : `${session.mode} dialer`}
            {autoAdvances(session.mode) && campaign?.settings.parallelLines ? ` · ${campaign.settings.parallelLines} lines` : ''}
          </span>
        </span>

        <span className="ml-auto flex items-center gap-3.5">
          <Stat value={session.dialed} label="Dialed" />
          <Stat value={session.connected} label="Talked" />
          {machines != null && machines > 0 && <Stat value={machines} label="Machines" />}
          {remaining !== null && <Stat value={remaining} label="Left" />}
        </span>
      </div>

      {background.length > 0 && (
        <div role="status" className="flex flex-col gap-1" aria-live="polite">
          {background.map((line) => (
            <span
              key={line.callId}
              className="flex items-center gap-1.5 truncate"
              style={{ font: '500 11px/1.35 var(--sans)', color: 'var(--muted)' }}
            >
              <span aria-hidden className="talkr-rec-dot" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--amber)', flex: 'none' }} />
              Ringing · {line.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          tone="green"
          disabled={busy || onCall || paused || extensionHasPhone}
          title={nextReason}
          onClick={() => void next()}
          style={{ flex: 1 }}
        >
          <Icon name="phone" size={13} />
          {busy ? 'Dialling…' : 'Next call'}
        </Button>
        <Button
          tone="ghost"
          disabled={busy}
          onClick={() => void (paused ? resume() : pause())}
          title={paused ? 'Pick the list back up where it stopped' : 'Stop advancing, keep your place'}
        >
          <Icon name={paused ? 'play' : 'pause'} size={13} />
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button tone="ghost" disabled={busy} onClick={() => void end()} style={{ color: 'var(--red)' }}>
          End
        </Button>
      </div>

      {/* "Nobody to dial" is an answer with a reason, not a dead button. */}
      {capNote && (
        <span role="status" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>{capNote}</span>
      )}
      {idle && (
        <span className="flex items-start gap-1.5" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
          <Icon name="clock" size={11} style={{ marginTop: 1, flex: 'none' }} />
          {idle}
        </span>
      )}
      {error && (
        <span role="alert" style={{ font: '500 10.5px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</span>
      )}
    </div>
  );
}
