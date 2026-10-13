// Badges, passes, a signed contract, and one spin of the wheel.
// Toasts sit on the bottom left. A badge or a contract also takes the screen.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import {
  audienceSees, canSpin, catchUp, dayStats, diffFloor, floorBadgeHits, metricLabel,
  monthlyIsStale, signedFromContracts, signedFromMail, sliceMid, snapFrom, spinWheel, wheelPrizes,
  type FloorEvent, type WheelPrize,
} from '@/lib/floor-show';
import { playFloorSound, soundFor, unlockFloorAudio } from '@/lib/floor-audio';
import { floorEventSilenced } from '@/lib/floor-notify';
import { getFloorNotifyPrefs, useFloorNotifyPrefs } from '@/lib/floor-notify-prefs';
import {
  getLeaderboardResets, hasSpun, loadFloorSettings, loadSnap, markNudgeShown, notifyWheelResult, nudgeShownToday,
  onFloorPreview, rememberSpin, saveSnap,
} from '@/lib/floor-store';
import { applyLeaderboardResets } from '@/lib/leaderboard';
import type { ReportRaw } from '@/lib/reporting';

type Show = FloorEvent & { big: boolean; preview?: boolean; quiet?: boolean };

const COLORS = ['#12946a', '#1c1d1f', '#c4a35a', '#0e7a57', '#3f3f46', '#b45309', '#166534', '#44403c', '#0f766e', '#854d0e'];

function useConfetti(on: boolean) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!on) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let live = true;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    const bits = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.4,
      r: 4 + Math.random() * 6,
      v: 2.2 + Math.random() * 3.4,
      drift: -1.2 + Math.random() * 2.4,
      spin: Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }));
    const tick = () => {
      if (!live) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const b of bits) {
        b.y += b.v;
        b.x += b.drift;
        b.spin += 0.08;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.spin);
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.r, -b.r / 2, b.r * 2, b.r);
        ctx.restore();
        if (b.y > canvas.height + 20) b.y = -20;
      }
      requestAnimationFrame(tick);
    };
    tick();
    return () => { live = false; window.removeEventListener('resize', resize); };
  }, [on]);
  return ref;
}

function Wheel({ prizes, rotation }: { prizes: WheelPrize[]; rotation: number }) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let at = 0;
  const stops: string[] = [];
  prizes.forEach((p, i) => {
    const deg = (p.weight / total) * 360;
    const color = p.jackpot ? '#c4a35a' : COLORS[i % COLORS.length];
    stops.push(`${color} ${at}deg ${at + deg}deg`);
    at += deg;
  });
  return (
    <div style={{ position: 'relative', width: 'min(320px, 78vw)', height: 'min(320px, 78vw)', margin: '0 auto' }}>
      <div style={{ position: 'absolute', left: '50%', top: '-6px', transform: 'translateX(-50%)', zIndex: 2, width: 0, height: 0, borderLeft: '10px solid transparent', borderRight: '10px solid transparent', borderTop: '18px solid #1c1d1f' }} />
      <div style={{
        width: '100%', height: '100%', borderRadius: '50%',
        background: `conic-gradient(${stops.join(',')})`,
        transform: `rotate(${rotation}deg)`,
        boxShadow: 'inset 0 0 0 8px #fdfcfa, 0 16px 40px rgba(28,29,31,.2)',
      }} />
      <div style={{ position: 'absolute', inset: '38%', borderRadius: '50%', background: '#1c1d1f', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 800, letterSpacing: '.08em' }}>SPIN</div>
    </div>
  );
}

/** How often the open, visible tab re-reads the workspace for the board. */
const FLOOR_REFRESH_MS = 5 * 60_000;

export function FloorShow({ V }: { V: ClozrView }) {
  const notify = useFloorNotifyPrefs();
  const [queue, setQueue] = useState<Show[]>([]);
  const [current, setCurrent] = useState<Show | null>(null);
  const [toasts, setToasts] = useState<Show[]>([]);
  const [wheelFor, setWheelFor] = useState<(Extract<FloorEvent, { kind: 'contract' }> & { preview?: boolean }) | null>(null);
  const [prizeAt, setPrizeAt] = useState<string | null>(null);
  // The workspace whose floor settings (and leaderboard resets) have loaded.
  const [settingsFor, setSettingsFor] = useState<number | null | undefined>(undefined);
  const settingsReady = settingsFor === V.floorWorkspaceId;
  const [monthly, setMonthly] = useState('AirPods');
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [landed, setLanded] = useState<WheelPrize | null>(null);
  const spinFrame = useRef(0);
  const [wheelNote, setWheelNote] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  // The first diff after the screen opens is a catch-up (see catchUp in lib/floor-show).
  const caughtUp = useRef(false);
  const confettiOn = current?.kind === 'contract';
  const canvasRef = useConfetti(confettiOn);

  const feedKey = useMemo(() => {
    const raw = V.floorRaw;
    if (!raw) return '';
    const filtered = applyLeaderboardResets(raw, getLeaderboardResets());
    const stats = dayStats(filtered);
    const hits = floorBadgeHits(filtered);
    const contracts = collectContracts(filtered, V.floorMail);
    return JSON.stringify({ stats, hits: hits.map((h) => `${h.personId}:${h.badge.id}@${h.window}`), contracts: contracts.map((c) => c.id), rev: V.floorResetRev });
  }, [V.floorRaw, V.floorMail, V.floorResetRev]);

  // Unlock on the first click or key, never at mount: building an AudioContext
  // before a gesture logs "AudioContext was not allowed to start" on every load.
  useEffect(() => {
    const arm = () => unlockFloorAudio();
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, []);

  useEffect(() => {
    let live = true;
    const ws = V.floorWorkspaceId;
    void loadFloorSettings(ws).then((s) => {
      if (!live) return;
      setMonthly(s.monthlyPrize);
      setPrizeAt(s.updatedAt);
      setSettingsFor(ws);
    }).catch(() => undefined); // unread resets keep the floor quiet rather than announce imported history
    return () => { live = false; };
  }, [V.floorWorkspaceId]);

  useEffect(() => onFloorPreview((event) => push(event, true)), []);

  // A switch flipped off while a popup is up: drop it, including one already on screen.
  // Deferred so the preference update is not a setState inside the effect body.
  useEffect(() => {
    const keep = (e: Show) => e.preview || !floorEventSilenced(e.kind, notify);
    const id = window.setTimeout(() => {
      setQueue((q) => (q.every(keep) ? q : q.filter(keep)));
      setToasts((t) => (t.every(keep) ? t : t.filter(keep)));
      setCurrent((c) => (c && !keep(c) ? null : c));
    }, 0);
    return () => window.clearTimeout(id);
  }, [notify]);

  useEffect(() => {
    // Not before the workspace's leaderboard resets are in. Until then a rep
    // zeroed after an import still has the imported deals, so every login
    // announced their old badges again and the reset took them away a second later.
    if (!V.floorRaw || !settingsReady) return;
    const filtered = applyLeaderboardResets(V.floorRaw, getLeaderboardResets());
    const stats = dayStats(filtered);
    const hits = floorBadgeHits(filtered);
    const contracts = collectContracts(filtered, V.floorMail);
    const prev = loadSnap(V.floorWorkspaceId);
    const events = diffFloor(prev, stats, hits, contracts).filter((e) => audienceSees(e, V.floorMe, V.floorAdmin));
    saveSnap(V.floorWorkspaceId, snapFrom(stats, hits, contracts, prev));
    const first = !caughtUp.current;
    caughtUp.current = true;
    if (first) for (const e of catchUp(events)) push(e, false, true);
    else for (const e of events) push(e, false);
    // feedKey is the snapshot of the board; the function closes over the latest view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedKey, settingsReady]);

  useEffect(() => {
    if (!settingsReady || !V.floorAdmin || !monthlyIsStale(prizeAt) || nudgeShownToday()) return;
    markNudgeShown();
    push({ id: 'nudge:' + new Date().toISOString().slice(0, 10), kind: 'nudge', text: 'The monthly wheel prize is due for a refresh. Pick this month’s prize under Settings, Floor show.' }, false);
  }, [settingsReady, prizeAt, V.floorAdmin]);

  // The board refreshes from a full workspace read, so only the tab someone is
  // looking at asks for one, and at most every five minutes. Every open tab
  // re-reading everything each minute kept the database pegged and the app
  // stuck on its loading screen.
  useEffect(() => {
    if (!V.floorWorkspaceId) return;
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < FLOOR_REFRESH_MS) return;
      last = Date.now();
      V.reloadCrm();
    };
    const t = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', refresh); };
  }, [V.floorWorkspaceId, V.reloadCrm]);

  useEffect(() => {
    if (current || !queue.length) return;
    const [next, ...rest] = queue;
    let cancel = false;
    queueMicrotask(() => {
      if (cancel) return;
      setQueue(rest);
      setCurrent(next);
      playFor(next);
    });
    return () => { cancel = true; };
  }, [current, queue]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  /** quiet: a toast only, no takeover and no sound (what happened while the screen was closed). */
  function push(event: FloorEvent, preview: boolean, quiet = false) {
    if (!preview && floorEventSilenced(event.kind, getFloorNotifyPrefs())) return;
    if (!preview && seen.current.has(event.id)) return;
    if (!preview) seen.current.add(event.id);
    const big = !quiet && (event.kind === 'badge' || event.kind === 'contract');
    const show: Show = { ...event, big, preview, quiet };
    if (big) setQueue((q) => [...q, show]);
    setToasts((t) => [...t.filter((x) => x.id !== event.id), show].slice(-4));
  }

  function playFor(show: Show) {
    if (!show.preview && floorEventSilenced(show.kind, getFloorNotifyPrefs())) return;
    if (show.kind === 'badge') playFloorSound(show.tier === 'shame' ? soundFor('badge-shame') : soundFor('badge-good'));
    else if (show.kind === 'contract') playFloorSound(soundFor('contract'));
    else if (show.kind === 'pass') playFloorSound(soundFor('pass'));
  }

  function dismiss() {
    setCurrent(null);
  }

  function openBoard(id?: string) {
    if (id) setToasts((t) => t.filter((x) => x.id !== id));
    setCurrent(null);
    V.goLeaderboard();
  }

  function openWheel(event: Extract<FloorEvent, { kind: 'contract' }>, preview?: boolean) {
    window.cancelAnimationFrame(spinFrame.current);
    setLanded(null);
    setWheelNote(null);
    setSpinning(false);
    setRotation(0);
    setWheelFor({ ...event, preview });
    setCurrent(null);
  }

  async function spin() {
    if (!wheelFor || spinning || landed) return;
    if (!wheelFor.preview && hasSpun(wheelFor.contractId)) {
      setWheelNote('This contract already had its spin.');
      return;
    }
    unlockFloorAudio();
    const slices = wheelPrizes(monthly);
    const { index, prize } = spinWheel(slices);
    const mid = sliceMid(slices, index);
    const from = rotation;
    const to = from + 5 * 360 + (360 - mid);
    const started = performance.now();
    const dur = 4200;
    const who = wheelFor;
    setSpinning(true);
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setRotation(from + (to - from) * eased);
      if (t < 1) {
        spinFrame.current = window.requestAnimationFrame(step);
        return;
      }
      setSpinning(false);
      setLanded(prize);
      playFloorSound(prize.jackpot ? 'airhorn' : 'chime');
      if (!who.preview) {
        rememberSpin(who.contractId);
        void notifyWheelResult(V.floorWorkspaceId, V.floorAdminIds, `${who.ownerName} spun the wheel`, `${prize.label}${prize.jackpot ? ' — monthly prize' : ''}`).then((r) => {
          setWheelNote(r.ok ? 'Admins have it in the bell.' : (r.message ?? 'Saved on this screen.'));
        });
      } else {
        setWheelNote('Test spin — nothing was recorded.');
      }
    };
    spinFrame.current = window.requestAnimationFrame(step);
  }

  const prizes = wheelPrizes(monthly);

  return (
    <>
      <style>{`
        @keyframes floorIn { from { transform: translateY(12px) scale(.98); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes floorToast { from { transform: translateX(-16px); opacity: 0 } to { transform: none; opacity: 1 } }
      `}</style>
      {confettiOn ? <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 118, pointerEvents: 'none' }} /> : null}
      {current?.big ? (
        <div role="dialog" aria-label={current.kind === 'badge' ? current.badgeName : 'Contract signed'} onClick={dismiss} style={{ position: 'fixed', inset: 0, zIndex: 119, background: 'rgba(28,29,31,.55)', display: 'grid', placeItems: 'center', padding: '24px' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(440px, 100%)', background: '#fdfcfa', borderRadius: '22px', padding: '28px 24px 20px', textAlign: 'center', boxShadow: '0 30px 80px rgba(28,29,31,.35)', animation: 'floorIn .35s ease' }}>
            {current.kind === 'badge' ? (
              <>
                <div style={{ fontSize: '11px', fontWeight: 800, color: current.tier === 'shame' ? '#b91c1c' : '#0e7a57' }}>{current.tier === 'shame' ? 'Hall of shame' : 'Badge unlocked'}</div>
                <img src={current.image} alt="" style={{ width: '148px', height: '148px', objectFit: 'cover', borderRadius: '50%', margin: '14px auto', display: 'block', border: `4px solid ${current.tier === 'shame' ? '#fecaca' : '#c4a35a'}`, background: '#eceae3' }} />
                <div style={{ fontSize: '26px', fontWeight: 800, letterSpacing: '-0.03em' }}>{current.badgeName}</div>
                <div style={{ marginTop: '6px', fontSize: '15px', color: '#3f3f46' }}>{current.person}</div>
                <div style={{ marginTop: '4px', fontSize: '13px', color: '#71717a' }}>{current.hint}</div>
              </>
            ) : current.kind === 'contract' ? (
              <>
                <div style={{ fontSize: '11px', fontWeight: 800, color: '#0e7a57' }}>{current.source === 'email' ? 'Inbox · signed' : 'CLOZR eSign'}</div>
                <div style={{ fontSize: '42px', lineHeight: 1, margin: '10px 0' }}>🔔</div>
                <div style={{ fontSize: '26px', fontWeight: 800, letterSpacing: '-0.03em' }}>Contract signed</div>
                <div style={{ marginTop: '6px', fontSize: '15px' }}>{current.ownerName}</div>
                <div style={{ marginTop: '4px', fontSize: '13px', color: '#71717a' }}>{current.title}</div>
                {canSpin(current, V.floorMe, V.floorAdmin) && !hasSpun(current.contractId) ? (
                  <button type="button" onClick={() => openWheel(current, current.preview)} style={primary}>Spin the wheel</button>
                ) : (
                  <div style={{ marginTop: '10px', fontSize: '12.5px', color: '#71717a' }}>{current.ownerName} gets one spin.</div>
                )}
              </>
            ) : null}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '16px' }}>
              <button type="button" onClick={() => openBoard()} style={primary}>Leaderboard</button>
              <button type="button" onClick={dismiss} style={ghost}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {/* Above Today's action bar too (--clozr-todaybar): these stay until read, and sat on Call, Text and Log. */}
      <div style={{ position: 'fixed', left: 'calc(16px + var(--clozr-side, 0px))', bottom: 'calc(16px + env(safe-area-inset-bottom, 0px) + var(--clozr-callbar, 0px) + var(--clozr-todaybar, 0px))', zIndex: 96, display: 'flex', flexDirection: 'column', gap: '8px', width: 'min(340px, calc(100vw - 32px))', pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ position: 'relative', pointerEvents: 'auto' }}>
          <button type="button" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} style={{ position: 'absolute', top: 4, right: 4, zIndex: 1, width: 28, height: 28, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: '#71717a', cursor: 'pointer' }}>
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <button type="button" onClick={() => openBoard(t.id)} style={{ width: '100%', textAlign: 'left', border: '1px solid #e6e3da', background: '#fdfcfa', borderRadius: '14px', padding: '10px 36px 10px 12px', boxShadow: '0 12px 30px rgba(28,29,31,.16)', cursor: 'pointer', animation: 'floorToast .28s ease', color: '#1c1d1f' }}>
            <div style={{ fontSize: '11.5px', fontWeight: 800, color: t.kind === 'badge' && t.tier === 'shame' ? '#b91c1c' : '#0e7a57' }}>{toastKicker(t)}</div>
            <div style={{ marginTop: '3px', fontSize: '13.5px', fontWeight: 700, lineHeight: 1.35 }}>{toastText(t)}</div>
            {t.kind === 'contract' && (t.preview || canSpin(t, V.floorMe, V.floorAdmin)) && (t.preview || !hasSpun(t.contractId)) ? (
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (t.kind === 'contract') openWheel(t, t.preview); }} style={{ display: 'inline-block', marginTop: '6px', fontSize: '12px', fontWeight: 700, color: '#0e7a57' }}>Spin the wheel</span>
            ) : null}
          </button>
          </div>
        ))}
      </div>
      {wheelFor ? (
        <div role="dialog" aria-label="Spin the wheel" style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(28,29,31,.62)', display: 'grid', placeItems: 'center', padding: '20px' }}>
          <div style={{ width: 'min(460px, 100%)', background: '#f4f2ec', borderRadius: '22px', padding: '22px 18px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: '12px', fontWeight: 800, color: '#0e7a57' }}>One spin</div>
            <div style={{ fontSize: '22px', fontWeight: 800, margin: '4px 0 14px' }}>{wheelFor.ownerName}</div>
            <Wheel prizes={prizes} rotation={rotation} />
            <div style={{ marginTop: '14px', minHeight: '44px', fontSize: landed ? '20px' : '15px', fontWeight: 800 }}>{landed ? `You won ${landed.label}` : 'Equal chances. The gold slice is this month’s prize.'}</div>
            {wheelNote ? <div style={{ fontSize: '12.5px', color: '#71717a' }}>{wheelNote}</div> : null}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '12px' }}>
              <button type="button" disabled={spinning || !!landed} onClick={() => void spin()} style={{ ...primary, opacity: spinning || landed ? 0.55 : 1 }}>{landed ? 'Spun' : spinning ? 'Spinning…' : 'Spin'}</button>
              <button type="button" onClick={() => setWheelFor(null)} style={ghost}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function collectContracts(raw: ReportRaw, mail: ClozrView['floorMail']) {
  const deals = raw.deals;
  const members = raw.members;
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? 'the team';
  const fromEsign = signedFromContracts(raw.contracts ?? [], (dealId) => {
    const d = deals.find((x) => x.id === dealId);
    const seller = raw.sellers.find((s) => s.id === d?.seller_id);
    return { id: d?.owner_id ?? null, name: nameOf(d?.owner_id ?? null), label: seller?.address || seller?.name || 'Purchase contract' };
  });
  const fromMail = signedFromMail(mail.map((m) => ({ ...m, ownerName: m.ownerName || nameOf(m.ownerId) })));
  const dealIds = new Set(fromEsign.map((c) => c.id));
  return [...fromEsign, ...fromMail.filter((m) => !dealIds.has(m.id))];
}

function toastKicker(t: Show): string {
  if (t.kind === 'badge') return t.tier === 'shame' ? 'Shame badge' : 'Badge';
  if (t.kind === 'pass') return `Passed on ${metricLabel(t.metric)}`;
  if (t.kind === 'contract') return 'Contract signed';
  if (t.kind === 'digest') return 'While you were away';
  return 'Floor show';
}

function toastText(t: Show): string {
  if (t.kind === 'badge') return `${t.person} got ${t.badgeName}`;
  if (t.kind === 'pass') return `${t.passer} passed ${t.passed} · ${t.value} ${metricLabel(t.metric)}`;
  if (t.kind === 'contract') return `${t.ownerName} · ${t.title}`;
  return t.text;
}

const primary: React.CSSProperties = { marginTop: '8px', height: '36px', padding: '0 14px', borderRadius: '10px', border: '1px solid #1c1d1f', background: '#1c1d1f', color: '#fff', fontWeight: 700, cursor: 'pointer' };
const ghost: React.CSSProperties = { marginTop: '8px', height: '36px', padding: '0 14px', borderRadius: '10px', border: '1px solid #ddd9ce', background: '#fff', fontWeight: 650, cursor: 'pointer' };
