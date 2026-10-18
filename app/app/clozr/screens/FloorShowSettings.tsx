// Settings → Floor show. Admins preview every popup and sound, set the
// monthly wheel prize, and zero a rep after a bulk import.
'use client';

import React, { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { isAdmin, type Role } from '@/lib/team';
import { MONTHLY_SUGGESTIONS, badgeById, monthlyIsStale, type FloorEvent } from '@/lib/floor-show';
import { setFloorNotify, useFloorNotifyPrefs } from '@/lib/floor-notify-prefs';
import { playFloorSound, unlockFloorAudio } from '@/lib/floor-audio';
import {
  clearLeaderboardReset, loadFloorSettings, previewFloor, resetLeaderboardReps, saveFloorSettings,
  type FloorSettings,
} from '@/lib/floor-store';
import { listTeammates, type Teammate } from '@/lib/plans';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: '0 0 6px', fontSize: '14px', fontWeight: 700 };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
const btn: React.CSSProperties = { height: '32px', padding: '0 12px', borderRadius: '9px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontWeight: 650, cursor: 'pointer', fontSize: '12.5px' };
const primary: React.CSSProperties = { ...btn, background: 'var(--ink-deep, #1c1d1f)', color: 'var(--surface, #fff)', borderColor: 'var(--ink-deep, #1c1d1f)' };

function NotifySwitches() {
  const prefs = useFloorNotifyPrefs();
  const [note, setNote] = useState<string | null>(null);
  async function set(key: 'leaderboard' | 'badges', on: boolean) {
    const r = await setFloorNotify({ [key]: on });
    setNote(r.ok ? null : (r.message ?? 'Saved in this browser. The account did not keep it.'));
  }
  const row = (on: boolean, title: string, hint: string, key: 'leaderboard' | 'badges') => (
    <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '12px', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => void set(key, e.target.checked)}
        style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: 'var(--tx-mint, #0a8560)', flex: 'none', cursor: 'pointer' }}
      />
      <span>
        <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 650, color: 'var(--ink, #18181b)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.45, marginTop: '2px' }}>{hint}</span>
      </span>
    </label>
  );
  return (
    <div style={card}>
      <h2 style={h2}>Your notifications</h2>
      <p style={sub}>These are yours. On is how it works today. Turning one off stops it for you: the popup, the toast, and the sound. Contract bells, the wheel, texts, and the rest of the bell stay on.</p>
      {row(prefs.leaderboard, 'Leaderboard notifications', 'When someone passes a teammate on today’s calls, offers, or talk time.', 'leaderboard')}
      {row(prefs.badges, 'Badge notifications', 'Badge popups, hall-of-shame callouts, and the catch-up when you come back.', 'badges')}
      <div style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>Saved on your account, and in this browser.</div>
      {note ? <div style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--tx-amber, #b45309)' }}>{note}</div> : null}
    </div>
  );
}

export function FloorShowSettings({ isMobile }: { isMobile: boolean }) {
  const s = useSession();
  const admin = isAdmin((s.workspace?.role as Role | undefined) ?? null) || s.demo || !s.workspace;
  const ws = s.workspace?.id ?? null;
  const [floor, setFloor] = useState<FloorSettings | null>(null);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [prize, setPrize] = useState('AirPods');
  const [detail, setDetail] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadFloorSettings(ws).then((f) => {
      if (!live) return;
      setFloor(f);
      setPrize(f.monthlyPrize);
      setDetail(f.monthlyDetail);
    });
    if (ws) void listTeammates(ws).then((t) => { if (live) setTeam(t); });
    return () => { live = false; };
  }, [ws]);

  if (!admin) {
    return (
      <div>
        <NotifySwitches />
        <div style={card}><h2 style={h2}>Floor show</h2><p style={sub}>Owners and admins preview the popups, sounds, and wheel from here. Your switches above are what decide whether you hear the moments.</p></div>
      </div>
    );
  }

  async function savePrize() {
    setBusy(true);
    const r = await saveFloorSettings(ws, { monthlyPrize: prize.trim() || 'AirPods', monthlyDetail: detail.trim(), updatedAt: new Date().toISOString() });
    setBusy(false);
    setNote(r.ok ? 'Monthly prize saved. The gold slice uses it until you change it again.' : (r.message ?? 'Could not save.'));
    if (r.ok) {
      const next = await loadFloorSettings(ws);
      setFloor(next);
    }
  }

  async function zero(id: string) {
    setBusy(true);
    const r = await resetLeaderboardReps(ws, [id]);
    setBusy(false);
    setNote(r.ok ? 'That rep is zeroed. Older activity stays in the CRM and off the board.' : (r.message ?? 'Could not reset.'));
    if (r.ok) setFloor(await loadFloorSettings(ws));
  }

  async function undo(id: string) {
    setBusy(true);
    const r = await clearLeaderboardReset(ws, id);
    setBusy(false);
    setNote(r.ok ? 'History counts for that rep again.' : (r.message ?? 'Could not undo.'));
    if (r.ok) setFloor(await loadFloorSettings(ws));
  }

  function preview(event: FloorEvent) {
    unlockFloorAudio();
    previewFloor(event);
  }

  const good = badgeById('apex-predator')!;
  const shame = badgeById('casper')!;
  const stale = monthlyIsStale(floor?.updatedAt);

  return (
    <div>
      <NotifySwitches />
      {stale ? (
        <div style={{ ...card, background: 'var(--tint-amber, #fffbeb)', borderColor: '#fcd34d' }}>
          <h2 style={h2}>Update this month’s prize</h2>
          <p style={sub}>The gold slice has been “{floor?.monthlyPrize || 'AirPods'}” long enough. Pick a new one so the wheel stays fresh — AirPods, a Quest 3, a domestic flight, dinner for two, or a company outing are the usual rotation.</p>
        </div>
      ) : null}
      <div style={card}>
        <h2 style={h2}>Preview</h2>
        <p style={sub}>Plays on this screen the way the floor hears it. A test spin is not recorded and does not use anyone’s one spin.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <button type="button" style={btn} onClick={() => { playFloorSound('airhorn'); preview({ id: 'preview-badge-good', kind: 'badge', tier: 'good', personId: 'preview', person: 'You', badgeId: good.id, badgeName: good.name, hint: good.hint, image: good.image }); }}>Good badge + airhorn</button>
          <button type="button" style={btn} onClick={() => { playFloorSound('shame'); preview({ id: 'preview-badge-bad', kind: 'badge', tier: 'shame', personId: 'preview', person: 'You', badgeId: shame.id, badgeName: shame.name, hint: shame.hint, image: shame.image }); }}>Shame badge + bad sound</button>
          <button type="button" style={btn} onClick={() => { playFloorSound('chime'); preview({ id: 'preview-pass', kind: 'pass', metric: 'calls', passerId: 'a', passer: 'Alex', passedId: 'b', passed: 'Jordan', value: '42' }); }}>Someone passed on calls</button>
          <button type="button" style={btn} onClick={() => { playFloorSound('bell'); preview({ id: 'preview-contract', kind: 'contract', contractId: 'preview-spin', title: 'Purchase agreement · Oak Street', ownerId: null, ownerName: 'Alex', source: 'esign' }); }}>Contract signed + bell</button>
          <button type="button" style={btn} onClick={() => playFloorSound('airhorn')}>Airhorn only</button>
          <button type="button" style={btn} onClick={() => playFloorSound('shame')}>Shame sound only</button>
          <button type="button" style={btn} onClick={() => playFloorSound('bell')}>Bell only</button>
        </div>
      </div>
      <div style={card}>
        <h2 style={h2}>Monthly wheel prize</h2>
        <p style={sub}>Nine everyday prizes share the wheel equally: a $50 gas card, a $20 Starbucks card, a $50 Amazon card, an hour at Topgolf, one concert ticket, nails or a haircut, a $25 DoorDash card, a car wash and detail, and a late start. The gold slice is rarer and is whatever you set here.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
          {MONTHLY_SUGGESTIONS.map((idea) => (
            <button key={idea} type="button" onClick={() => setPrize(idea)} style={{ ...btn, background: prize === idea ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', borderColor: prize === idea ? '#0A8560' : 'var(--divider, #e4e4e7)' }}>{idea}</button>
          ))}
        </div>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 650, color: 'var(--muted, #52525b)' }}>
          This month
          <input value={prize} onChange={(e) => setPrize(e.target.value)} style={{ display: 'block', width: isMobile ? '100%' : '360px', marginTop: '4px', height: '34px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 10px' }} />
        </label>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 650, color: 'var(--muted, #52525b)', marginTop: '8px' }}>
          Note for you (how to fulfill it)
          <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Order from the company card" style={{ display: 'block', width: isMobile ? '100%' : '360px', marginTop: '4px', height: '34px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 10px' }} />
        </label>
        <button type="button" disabled={busy} onClick={() => void savePrize()} style={{ ...primary, marginTop: '12px' }}>Save prize</button>
        {floor?.updatedAt ? <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>Last set {new Date(floor.updatedAt).toLocaleDateString()}.</div> : <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--tx-amber, #b45309)' }}>Not set yet — save one so the reminder can wait a month.</div>}
      </div>
      <div style={card}>
        <h2 style={h2}>Zero a rep on the leaderboard</h2>
        <p style={sub}>Use this after a bulk import so old leads and calls assigned to someone do not count. The records stay. Only the board ignores activity from before the reset. The same switch is on the import screen.</p>
        {team.length === 0 ? <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>{ws ? 'No teammates yet.' : 'Sign in to a workspace to zero a rep. Previews above still play.'}</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {team.map((t) => {
              const at = floor?.resets[t.id];
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 650, fontSize: '13px', minWidth: '140px' }}>{t.name}</span>
                  <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)', flex: 1 }}>{at ? `Zeroed ${new Date(at).toLocaleString()}` : 'Counting full history'}</span>
                  {at ? <button type="button" style={btn} disabled={busy} onClick={() => void undo(t.id)}>Count history again</button> : <button type="button" style={btn} disabled={busy} onClick={() => void zero(t.id)}>Zero now</button>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {note ? <div style={{ fontSize: '12.5px', color: 'var(--tx-mint, #0a8560)', marginBottom: '12px' }}>{note}</div> : null}
    </div>
  );
}
