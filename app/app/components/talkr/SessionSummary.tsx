'use client';

/**
 * What a CLOZR dial session came to (lib/dial-session.ts): one grid, drawn
 * in the session bar's detail, the phone's session menu and the finished
 * summary, so the three never disagree. And the card that offers a session
 * saved in this browser back to the rep.
 */

import type { ClozrView } from '@/app/clozr/view';
import { talkTime, type SessionProgress, type SessionTally } from '@/lib/dial-session';
import { Button } from './ui';

export type StatsInput = { progress: SessionProgress; tally: SessionTally; dialed: number; dropped: number; skipped: number };

/** The tiles, in reading order. Zero rows are kept: "0 appointments" is an answer. */
export function sessionTiles(s: StatsInput): { label: string; value: string; tone?: 'good' | 'bad' }[] {
  const { progress: p, tally: t } = s;
  return [
    { label: 'Position', value: p.people ? `${p.position} of ${p.people}` : '—' },
    { label: 'People reached', value: String(p.reached), tone: p.reached ? 'good' : undefined },
    { label: 'Numbers dialed', value: String(s.dialed) },
    { label: 'Connects', value: String(t.connects), tone: t.connects ? 'good' : undefined },
    { label: 'Voicemail / drops', value: `${t.voicemails} / ${s.dropped}` },
    { label: 'No answer', value: String(t.noAnswer) },
    { label: 'Wrong numbers', value: String(t.wrong), tone: t.wrong ? 'bad' : undefined },
    { label: 'Do not call', value: String(t.dnc), tone: t.dnc ? 'bad' : undefined },
    { label: 'Appointments', value: String(t.appointments), tone: t.appointments ? 'good' : undefined },
    { label: 'Offer-ready / follow-ups', value: `${t.offers} / ${t.followUps}` },
    { label: 'Talk time', value: talkTime(t.talkSeconds) },
    { label: 'Numbers per person', value: p.position ? String(p.depth) : '—' },
    { label: 'Numbers left', value: String(p.numbersLeft) },
    { label: 'Skipped', value: String(s.skipped) },
  ];
}

export function SessionStats({ stats, dark = false, columns = 3 }: { stats: StatsInput; dark?: boolean; columns?: number }) {
  const muted = dark ? 'rgba(255,255,255,.6)' : 'var(--muted)';
  const text = dark ? 'var(--surface, #fff)' : 'var(--text)';
  return (
    <div data-testid="session-stats" className="grid gap-x-3 gap-y-2.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {sessionTiles(stats).map((tile) => (
        <span key={tile.label} className="flex min-w-0 flex-col gap-1">
          <span style={{ font: '700 15px/1 var(--sans)', fontVariantNumeric: 'tabular-nums', color: tile.tone === 'good' ? 'var(--green, #0a8560)' : tile.tone === 'bad' ? 'var(--red, #b91c1c)' : text }}>
            {tile.value}
          </span>
          <span className="truncate" style={{ font: '500 11px/1.2 var(--sans)', color: muted }}>{tile.label}</span>
        </span>
      ))}
    </div>
  );
}

/** A progress bar by people: how far down the list the session is. */
export function SessionMeter({ percent, dark = false }: { percent: number; dark?: boolean }) {
  return (
    <span aria-hidden style={{ display: 'block', height: 4, borderRadius: 99, background: dark ? 'rgba(255,255,255,.14)' : 'var(--line)', overflow: 'hidden' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.max(0, percent))}%`, background: 'var(--green, #0a8560)', transition: 'width .3s' }} />
    </span>
  );
}

/** "Resume session (23 of 140, started 2:14pm)" or Discard, wherever a rep starts dialing from. */
export function ResumeCard({ V, dark = false }: { V: ClozrView; dark?: boolean }) {
  const r = V.queueResume;
  if (!r || V.queueSession || V.talkrPhone.session.session) return null;
  return (
    <div
      data-testid="session-resume"
      className="flex flex-col gap-2 px-3 py-2.5"
      style={{
        border: `1px solid ${dark ? 'rgba(255,255,255,.18)' : 'var(--line)'}`, borderRadius: 'var(--r-btn, 10px)',
        background: dark ? 'rgba(255,255,255,.06)' : 'var(--panel-2)', color: dark ? '#fff' : 'var(--text)', marginBottom: 6,
      }}
    >
      <span style={{ font: '600 12px/1.35 var(--sans)' }}>
        Unfinished session · {r.title}
        <span style={{ fontWeight: 500, color: dark ? 'rgba(255,255,255,.6)' : 'var(--muted)' }}>
          {' '}· {r.progress.reached} reached · {r.progress.numbersLeft} numbers left
        </span>
      </span>
      <SessionMeter percent={r.progress.percent} dark={dark} />
      <span className="flex flex-wrap items-center gap-2">
        <Button tone="green" onClick={r.resume} style={{ padding: '8px 11px', font: '600 11.5px/1 var(--sans)' }}>{r.label}</Button>
        <Button tone="ghost" onClick={r.discard} style={{ padding: '8px 11px', font: '600 11.5px/1 var(--sans)' }}>Discard</Button>
      </span>
    </div>
  );
}
