'use client';

/**
 * Before a session dials, and after it stops.
 *
 * "Start session" used to ring the first number in the same click, with the
 * readiness checklist only in the way when something was missing. Now every
 * start, a CLOZR list (queue, Today, vendors, RVM, run it again) or a Talkr
 * campaign, opens this sheet first: mode, numbers per lead, the line calls go
 * out on, the voicemail Drop VM plays, and the checklist, with what blocks a
 * start said in words and the Start button off until it is fixed. The rep's
 * choices are remembered per workspace and rep (lib/dial-session.ts prefs).
 *
 * When the list runs out (or the rep presses End) the summary says so: what
 * the session came to, and Run the same list again, Start a new session, or
 * Done.
 *
 * Mounted once in the shell; session starts reach it through
 * requestSessionSetup, the way the checklist is reached.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { DIAL_MODES, type DialMode } from '@/lib/dial-engine';
import { dialerReadiness } from '@/lib/dialer-readiness';
import {
  RUN_AGAIN, dialableOf, hostSessionSetup, readPrefs, savePrefs, setupCheck, talkTime,
  type RunAgainFilter, type SetupChoice, type SetupRequest,
} from '@/lib/dial-session';
import { QUEUE_DEPTHS, type QueueDepth } from '@/lib/seller-phones';
import { CallerIdPicker, callerIdLabel } from './CallerIdPicker';
import { Row as ReadinessRow, useReadinessFacts, useReadinessFix } from './DialerReadiness';
import { openVoicemailRecorder } from './VoicemailDrop';
import { useSoftphone } from './softphoneAdapter';
import { SessionMeter, SessionStats } from './SessionSummary';
import '@/app/clozr/talkr-dialer.css';

type Prompt = SetupRequest & { resolve: (c: SetupChoice | null) => void };

export function DialSessionHost({ V }: { V: ClozrView }) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  useEffect(() => hostSessionSetup((p) => setPrompt(p)), []);
  const close = useCallback((c: SetupChoice | null) => {
    setPrompt((p) => {
      p?.resolve(c);
      return null;
    });
  }, []);
  return (
    <>
      {prompt && <SetupSheet key={prompt.listId + prompt.kind} V={V} prompt={prompt} onClose={close} />}
      {!prompt && V.queueDone && <FinishedSheet done={V.queueDone} />}
    </>
  );
}

const WEBM = /\.webm$/i;

function SetupSheet({ V, prompt, onClose }: { V: ClozrView; prompt: Prompt; onClose: (c: SetupChoice | null) => void }) {
  const ws = V.floorWorkspaceId;
  const uid = V.floorMe;
  const prefs = useMemo(() => readPrefs(ws, uid), [ws, uid]);
  const { facts, clips, reload, recheckMic } = useReadinessFacts(V);
  const { me, setMe } = useSoftphone();
  const [listId, setListId] = useState(prompt.listId);
  const [mode, setMode] = useState<DialMode>(prompt.mode ?? prefs.mode);
  const [depth, setDepth] = useState<QueueDepth>(prompt.depth ?? prefs.depth);
  const [vmPick, setVmPick] = useState<number | null | undefined>(undefined);
  const { fix, fixing } = useReadinessFix(V, recheckMic, () => onClose(null));
  const startRef = useRef<HTMLButtonElement>(null);

  // Fresh facts each time the sheet opens: a recording made a minute ago, the mic just allowed.
  useEffect(() => {
    void reload();
    recheckMic();
  }, [reload, recheckMic]);

  const list = prompt.lists.find((l) => l.id === listId) ?? prompt.lists[0]!;
  const campaign = prompt.kind === 'campaign';
  const recorded = clips.filter((c) => !!c.audio_path);
  // A drop plays the file on the live call: a WebM (saved before recordings
  // were converted to WAV) does not play there, so it is listed but cannot be picked.
  const playable = recorded.filter((c) => !WEBM.test(c.audio_path!));
  const webm = recorded.filter((c) => WEBM.test(c.audio_path!));
  const mine = playable.filter((c) => !!uid && c.created_by === uid);
  // The pick: what the rep chose here, else their last choice if it is still in the library, else their own newest.
  const remembered = playable.some((c) => c.id === prefs.vmClipId) ? prefs.vmClipId : null;
  const vmClipId = vmPick !== undefined ? vmPick : remembered ?? (mine[mine.length - 1] ?? playable[0])?.id ?? null;
  const vmClip = playable.find((c) => c.id === vmClipId) ?? null;

  const check = setupCheck(facts, list.facts, campaign || !list.hasRecords ? 1 : depth);
  const items = facts ? dialerReadiness(facts, mode) : [];
  const blocked = check.blockers.length > 0;

  const start = () => {
    if (blocked) return;
    const choice: SetupChoice = { listId: list.id, mode, depth: campaign || !list.hasRecords ? prefs.depth : depth, vmClipId };
    savePrefs(ws, uid, { mode, depth: choice.depth, vmClipId });
    onClose(choice);
  };
  const startLatest = useRef(start);
  useEffect(() => {
    startLatest.current = start;
  });

  useEffect(() => {
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(null);
        return;
      }
      if (e.key !== 'Enter' || e.repeat) return;
      // Enter on a field or an action button does that thing; anywhere else
      // (a mode or depth just picked included) it starts.
      const t = e.target as HTMLElement | null;
      const choice = t?.tagName === 'BUTTON' && t.hasAttribute('aria-pressed');
      if (t && t !== startRef.current && !choice && /^(SELECT|TEXTAREA|INPUT|BUTTON|A)$/.test(t.tagName)) return;
      e.preventDefault();
      startLatest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const f = list.facts;
  const resume = !campaign ? V.queueResume : null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dial-setup-title" data-testid="dial-setup" onClick={() => onClose(null)} style={backdrop}>
      <div className="talkr-dialer" onClick={(e) => e.stopPropagation()} style={sheet}>
        <div style={{ ...eyebrow, color: blocked ? '#b91c1c' : check.warnings.length ? '#b45309' : '#0e7a57' }}>
          {campaign ? 'Start a Talkr campaign' : 'Start a dial session'}
        </div>
        <div id="dial-setup-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 4 }}>
          {list.title}
          {f ? <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 15 }}> · {f.people} {f.people === 1 ? 'person' : 'people'}</span> : null}
        </div>
        {f && (
          <div style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--muted)', marginTop: 4 }}>
            {dialableOf(f)} to call
            {f.noNumber ? ` · ${f.noNumber} no number` : ''}
            {f.dnc ? ` · ${f.dnc} do not call` : ''}
            {f.claimed ? ` · ${f.claimed} claimed by a teammate` : ''}
          </div>
        )}

        {resume && (
          <div data-testid="dial-setup-resume" style={{ ...box, marginTop: 12, background: '#fffbeb', borderColor: '#fde68a' }}>
            <span style={{ font: '600 12.5px/1.35 var(--sans)' }}>You have an unfinished session: {resume.title}</span>
            <span className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              <button type="button" style={ghostSm} onClick={() => { onClose(null); resume.resume(); }}>{resume.label}</button>
              <button type="button" style={ghostSm} onClick={resume.discard}>Discard it</button>
            </span>
            <span style={{ display: 'block', font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)', marginTop: 6 }}>Starting this one discards it.</span>
          </div>
        )}

        {prompt.lists.length > 1 && (
          <Field label={campaign ? 'Campaign' : 'List'}>
            <select value={list.id} onChange={(e) => setListId(e.target.value)} aria-label={campaign ? 'Campaign' : 'List'} style={select}>
              {prompt.lists.map((l) => (
                <option key={l.id} value={l.id}>{l.title}{l.facts ? ` · ${l.facts.people}` : ''}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Mode">
          <Segmented
            label="Dial mode"
            value={mode}
            options={DIAL_MODES.map((m) => ({ id: m.id, label: m.label, hint: m.hint }))}
            onChange={(m) => setMode(m)}
          />
          <Hint>
            {campaign
              ? (mode === 'predictive' ? 'Talkr dials ahead, drops a voicemail when a machine answers, and stops if abandonment crosses 3%.' : 'Talkr picks who to ring next, in their calling window and inside the attempt caps. You press Next.')
              : (mode === 'predictive' ? 'The next number dials the moment you save an outcome or a voicemail drop finishes. Numbers outside 8am–8pm their time wait.' : 'You press Next for every call. Nothing dials until you do.')}
          </Hint>
        </Field>

        {!campaign && list.hasRecords && (
          <Field label="Numbers per lead">
            <Segmented
              label="Numbers per lead"
              value={depth}
              options={QUEUE_DEPTHS.map((d) => ({ id: d.id, label: d.label, hint: d.hint }))}
              onChange={(d) => setDepth(d)}
            />
            <Hint>{QUEUE_DEPTHS.find((d) => d.id === depth)?.hint}. A conversation or do not call stops the rest of their numbers.</Hint>
          </Field>
        )}

        <Field label="Caller ID">
          {me && me.org_numbers.length > 0
            ? <CallerIdPicker me={me} onChange={setMe} compact />
            : <span style={{ font: '500 12.5px/1.4 var(--sans)' }}>{callerIdLabel(me) || V.callerIdLabel || 'The line on your Talkr account'}</span>}
        </Field>

        <Field label="Voicemail drop">
          {playable.length > 0 ? (
            <select
              value={vmClipId ?? ''}
              onChange={(e) => setVmPick(e.target.value ? Number(e.target.value) : null)}
              aria-label="Voicemail to drop"
              style={select}
            >
              <option value="">None · leave voicemails by hand</option>
              {playable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.seconds ? ` · ${c.seconds}s` : ''}{uid && c.created_by === uid ? ' · yours' : c.created_by ? ' · a teammate’s' : ''}
                </option>
              ))}
              {webm.map((c) => (
                <option key={c.id} value={c.id} disabled>{c.name} · WebM, record again to drop it</option>
              ))}
            </select>
          ) : (
            <span className="flex flex-wrap items-center gap-2" style={{ font: '500 12.5px/1.4 var(--sans)' }}>
              {recorded.length ? 'Only WebM recordings, which do not play on a call. Record again to drop one.' : 'None recorded.'}
              <button type="button" style={ghostSm} onClick={() => openVoicemailRecorder()}>Record one</button>
            </span>
          )}
          <Hint>
            {campaign && mode === 'predictive'
              ? 'Talkr speaks your voicemail script when a machine answers. If someone else picks up while you are already on a call, this browser plays the recording on that line and hangs it up.'
              : `No answering-machine detection on a browser-dialed list: when a machine picks up, tap Drop VM and ${vmClip ? `“${vmClip.name}”` : 'a recording'} plays and hangs up${mode === 'predictive' ? ', and the next number dials' : ''}. If someone else answers while you are already talking, the same recording plays on that line.`}
          </Hint>
          {!campaign && list.title !== 'RVM' && (
            <Hint>
              Ringless voicemail (no ring at all) goes out from the{' '}
              <button type="button" style={link} onClick={() => { onClose(null); V.openDialerTab('RVM'); }}>RVM tab</button>.
            </Hint>
          )}
        </Field>

        <Field label="Ready to dial">
          {items.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((item) => <ReadinessRow key={item.key} item={item} busy={fixing === item.fix?.action} onFix={(a) => void fix(a)} />)}
            </ul>
          ) : (
            <Hint>The phone checks run once Talkr is connected to this workspace.</Hint>
          )}
          {(check.blockers.length > 0 || check.warnings.length > 0) && (
            <ul data-testid="dial-setup-checks" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {check.blockers.map((b) => <li key={b} style={{ font: '600 12px/1.4 var(--sans)', color: '#b91c1c' }}>Blocks the start: {b}</li>)}
              {check.warnings.map((w) => <li key={w} style={{ font: '500 12px/1.4 var(--sans)', color: '#b45309' }}>{w}</li>)}
            </ul>
          )}
        </Field>

        <div className="flex flex-wrap items-center justify-end gap-2" style={{ marginTop: 16 }}>
          <span style={{ marginRight: 'auto', font: '500 11px/1.3 var(--sans)', color: 'var(--muted)' }}>Enter starts · Esc cancels</span>
          <button type="button" onClick={() => onClose(null)} style={ghost}>Cancel</button>
          <button
            ref={startRef}
            type="button"
            data-testid="dial-setup-start"
            onClick={start}
            disabled={blocked}
            title={blocked ? check.blockers.join(' ') : undefined}
            style={{ ...primary, opacity: blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}
          >
            {blocked ? 'Fix the above to start' : check.warnings.length ? 'Start dialing anyway' : 'Start dialing'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FinishedSheet({ done }: { done: NonNullable<ClozrView['queueDone']> }) {
  const [filter, setFilter] = useState<RunAgainFilter>(done.againCounts.not_reached > 0 && done.how === 'finished' ? 'not_reached' : 'all');
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(done.close);
  useEffect(() => {
    closeRef.current = done.close;
  });
  useEffect(() => {
    doneRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const finished = done.how === 'finished';
  const minutes = Math.max(1, Math.round((done.endedAt - done.startedAt) / 60000));
  const count = done.againCounts[filter];
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dial-done-title" data-testid="dial-finished" onClick={done.close} style={backdrop}>
      <div className="talkr-dialer" onClick={(e) => e.stopPropagation()} style={sheet}>
        <div style={{ ...eyebrow, color: '#0e7a57' }}>{finished ? 'Session finished' : 'Session ended'}</div>
        <div id="dial-done-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 4 }}>
          {finished ? `You finished ${done.title}`
            : done.progress.position ? `${done.title}: stopped at ${done.progress.position} of ${done.progress.people}`
              : `${done.title}: ended before the first call`}
        </div>
        <div style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--muted)', marginTop: 4 }}>
          {done.mode === 'predictive' ? 'Predictive' : 'Power'} · {minutes} min · {done.dialed} numbers dialed · {talkTime(done.tally.talkSeconds)} talking
          {!finished && done.left ? ` · ${done.left} not started` : ''}
        </div>
        <div style={{ margin: '12px 0' }}><SessionMeter percent={finished ? 100 : done.progress.percent} /></div>
        <SessionStats stats={done} />

        <div style={{ ...box, marginTop: 14 }}>
          <span style={{ font: '600 12.5px/1.3 var(--sans)' }}>Run the same list again</span>
          <span style={{ display: 'block', marginTop: 8 }}>
            <Segmented
              label="Who to call again"
              value={filter}
              options={RUN_AGAIN.map((r) => ({ id: r.id, label: `${r.label} (${done.againCounts[r.id]})`, hint: r.hint }))}
              onChange={setFilter}
            />
          </span>
          <Hint>{RUN_AGAIN.find((r) => r.id === filter)?.hint}. A fresh session: the setup opens first.</Hint>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2" style={{ marginTop: 16 }}>
          {done.keepGoing && <button type="button" style={ghost} onClick={done.keepGoing}>Continue where I stopped</button>}
          <button type="button" style={ghost} onClick={done.newSession}>Start a new session</button>
          <button type="button" data-testid="dial-run-again" style={{ ...ghost, opacity: count ? 1 : 0.45 }} disabled={!count} onClick={() => done.runAgain(filter)}>
            Run the same list again ({count})
          </button>
          <button ref={doneRef} type="button" data-testid="dial-finished-done" style={primary} onClick={done.close}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ font: '700 11px/1 var(--sans)', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={{ display: 'block', font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)', marginTop: 6 }}>{children}</span>;
}

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <span role="group" aria-label={label} className="inline-flex max-w-full flex-wrap overflow-hidden" style={{ border: '1px solid var(--line)', borderRadius: 9 }}>
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          aria-pressed={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          style={{
            border: 0, padding: '8px 12px', cursor: 'pointer', font: '600 12px/1 var(--sans)',
            background: value === o.id ? 'var(--green)' : 'transparent', color: value === o.id ? '#fff' : 'var(--text)',
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 141, background: 'rgba(28,29,31,.5)', display: 'grid', placeItems: 'center', padding: 16 };
const sheet: React.CSSProperties = {
  width: 'min(520px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', background: '#fdfcfa', color: '#1c1d1f',
  borderRadius: 18, padding: '20px 18px 16px', boxShadow: '0 30px 80px rgba(28,29,31,.35)',
};
const eyebrow: React.CSSProperties = { fontSize: 11, fontWeight: 800 };
const box: React.CSSProperties = { display: 'block', border: '1px solid #e6e3da', borderRadius: 12, padding: '10px 12px', background: '#fff' };
const select: React.CSSProperties = { width: '100%', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 10px', font: '500 12.5px/1.2 var(--sans)', background: '#fff', color: 'var(--text)' };
const primary: React.CSSProperties = { height: 38, padding: '0 16px', borderRadius: 10, border: '1px solid #1c1d1f', background: '#1c1d1f', color: '#fff', fontWeight: 700, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 38, padding: '0 12px', borderRadius: 10, border: '1px solid #ddd9ce', background: '#fff', color: '#1c1d1f', fontWeight: 650, cursor: 'pointer' };
const ghostSm: React.CSSProperties = { ...ghost, height: 30, fontSize: 12 };
const link: React.CSSProperties = { border: 0, background: 'none', padding: 0, color: 'var(--green)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' };
