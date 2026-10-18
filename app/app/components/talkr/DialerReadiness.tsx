// "Before you dial": the checklist a power or predictive session start stops
// on when something the dialer needs is missing (lib/dialer-readiness.ts),
// and the flag that stays on the dialer until it is fixed.
//
// The host is mounted once in the shell. It gathers the facts (Talkr, the
// softphone, the microphone permission, the caller-ID line, the voicemail
// recordings), publishes them for any session start to read, and opens the
// checklist when one asks.
'use client';

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import {
  dialerReadiness, hostReadinessPrompt, needsAttention, publishReadiness, readinessFacts, readinessRev,
  reviewDialerReadiness, subscribeReadiness, type DialMode, type ReadinessFacts, type ReadinessFix, type ReadinessItem,
} from '@/lib/dialer-readiness';
import { VM_LIBRARY_CHANGED, useVmLibrary } from './useVmLibrary';
import { openVoicemailRecorder, useArmBusyDrop } from './VoicemailDrop';

type MicState = ReadinessFacts['mic'];

/** The browser's microphone permission, kept current. Unknown where the Permissions API will not say (older Safari). */
function useMicPermission(): [MicState, () => void] {
  const [mic, setMic] = useState<MicState>('unknown');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let status: PermissionStatus | null = null;
    const read = () => { if (live && status) setMic(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt'); };
    try {
      void navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((s) => {
        status = s;
        read();
        s.addEventListener('change', read);
      }).catch(() => undefined);
    } catch { /* not supported */ }
    return () => {
      live = false;
      status?.removeEventListener('change', read);
    };
  }, [tick]);
  const recheck = useCallback(() => setTick((t) => t + 1), []);
  return [mic, recheck];
}

/**
 * The facts the checklist reads, gathered live: Talkr, the softphone, the
 * microphone, the line and the voicemail library. Null facts where Talkr is
 * not the phone (the demo). Shared by the checklist and the session setup
 * sheet (DialSessionSetup.tsx).
 */
export function useReadinessFacts(V: ClozrView) {
  const phone = V.talkrPhone;
  const workspaceId = V.floorWorkspaceId;
  const me = V.floorMe;
  const { clips, reload } = useVmLibrary(phone.enabled ? workspaceId : null);
  const [mic, recheckMic] = useMicPermission();

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(VM_LIBRARY_CHANGED, onChange);
    return () => window.removeEventListener(VM_LIBRARY_CHANGED, onChange);
  }, [reload]);

  const recorded = clips.filter((c) => !!c.audio_path);
  const facts: ReadinessFacts | null = phone.enabled ? {
    phone: phone.data.status,
    // The Talkr extension holding the phone is a connected phone, just not this tab's.
    softphone: phone.extension.holdingSoftphone ? 'ready' : phone.sp.deviceState,
    softphoneReason: phone.extension.holdingSoftphone ? null : phone.sp.deviceError,
    mic,
    callerId: phone.callerId.id,
    ownVoicemails: recorded.filter((c) => !!me && c.created_by === me).length,
    teamVoicemails: recorded.length,
  } : null;
  return { facts, clips, reload, recheckMic };
}

/**
 * The checklist's Fix buttons. Connect and Allow act in place; the rest go to
 * another screen, so `leave` closes whatever sheet asked first.
 */
export function useReadinessFix(V: ClozrView, recheckMic: () => void, leave: () => void) {
  const phone = V.talkrPhone;
  const [fixing, setFixing] = useState<string | null>(null);
  const fix = async (action: ReadinessFix) => {
    setFixing(action);
    try {
      if (action === 'connect_phone' || action === 'use_phone_here') {
        // Both are presses. claim takes the lock from another tab; the
        // automatic connect is the only path that backs off.
        phone.retry();
        await phone.sp.initDevice({ claim: true });
      } else if (action === 'allow_mic') {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        s?.getTracks().forEach((t) => t.stop());
        recheckMic();
      } else {
        // These leave for another screen; the session does not start behind them.
        leave();
        // The RVM tab is not on every dialer surface, and it is hidden during a
        // call, so sending the rep there closed this checklist and the recorder
        // never appeared. The recorder dialog stays up until the take is saved.
        if (action === 'record_voicemail') openVoicemailRecorder();
        else {
          if (V.isMobile) V.minimisePhone();
          requestSettingsTab({ main: 'talkr', tab: action === 'open_numbers' ? 'numbers' : 'account' });
          V.goSettings();
        }
      }
    } finally {
      setFixing(null);
    }
  };
  return { fix, fixing };
}

export function DialerReadinessHost({ V }: { V: ClozrView }) {
  const phone = V.talkrPhone;
  const { facts: liveFacts, reload, recheckMic } = useReadinessFacts(V);
  useArmBusyDrop(phone.enabled ? V.floorWorkspaceId : null, V.floorMe);
  const [prompt, setPrompt] = useState<{ mode: DialMode | null; resolve: (go: boolean) => void } | null>(null);
  const factsKey = liveFacts ? JSON.stringify(liveFacts) : '';

  // Publish only when Talkr is the phone; without it there is no session to ready.
  useEffect(() => {
    if (!phone.enabled || !factsKey) return;
    publishReadiness(JSON.parse(factsKey) as ReadinessFacts);
  }, [factsKey, phone.enabled]);

  useEffect(() => {
    if (!phone.enabled) return;
    return hostReadinessPrompt((p) => {
      void reload();
      recheckMic();
      setPrompt(p);
    });
  }, [phone.enabled, reload, recheckMic]);

  const close = useCallback((go: boolean) => {
    setPrompt((p) => {
      p?.resolve(go);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt, close]);

  const { fix, fixing } = useReadinessFix(V, recheckMic, () => close(false));

  if (!prompt || !liveFacts) return null;
  const facts = liveFacts;
  const items = dialerReadiness(facts, prompt.mode);
  const open = needsAttention(items);
  const starting = prompt.mode !== null;
  const modeLabel = prompt.mode === 'predictive' ? 'predictive' : 'power';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dialer-ready-title" onClick={() => close(false)} style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(28,29,31,.5)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', background: '#fdfcfa', color: '#1c1d1f', borderRadius: '18px', padding: '20px 18px 16px', boxShadow: '0 30px 80px rgba(28,29,31,.35)' }}>
        <div style={{ fontSize: '11px', fontWeight: 800, color: open.some((i) => i.state === 'missing') ? '#b91c1c' : open.length ? '#b45309' : '#0e7a57' }}>
          {starting ? `Before your ${modeLabel} session` : 'Dialer setup'}
        </div>
        <div id="dialer-ready-title" style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.02em', marginTop: '4px' }}>
          {open.length ? `${open.length} thing${open.length === 1 ? '' : 's'} to set up` : 'You are ready to dial'}
        </div>
        <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map((item) => <Row key={item.key} item={item} busy={fixing === item.fix?.action} onFix={(a) => void fix(a)} />)}
        </ul>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px', flexWrap: 'wrap' }}>
          {starting ? (
            <>
              <button type="button" onClick={() => close(false)} style={ghost}>Not now</button>
              <button type="button" onClick={() => close(true)} style={primary}>{open.length ? 'Start anyway' : 'Start'}</button>
            </>
          ) : (
            <button type="button" onClick={() => close(false)} style={primary}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Row({ item, busy, onFix }: { item: ReadinessItem; busy: boolean; onFix: (a: ReadinessFix) => void }) {
  const tone = item.state === 'missing' ? '#b91c1c' : item.state === 'warn' ? '#b45309' : '#0e7a57';
  const mark = item.state === 'ok' ? '✓' : '!';
  return (
    <li style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', border: '1px solid #e6e3da', borderRadius: '12px', padding: '10px 12px', background: 'var(--surface, #fff)' }}>
      <span aria-hidden style={{ flex: 'none', width: '20px', height: '20px', borderRadius: '999px', display: 'grid', placeItems: 'center', background: tone, color: 'var(--on-dark, #fff)', fontSize: '12px', fontWeight: 800, marginTop: '1px' }}>{mark}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 700 }}>
          {item.title}
          <span className="sr-only">{item.state === 'ok' ? ' (done)' : item.state === 'warn' ? ' (recommended)' : ' (missing)'}</span>
        </span>
        <span style={{ display: 'block', fontSize: '12.5px', lineHeight: 1.45, color: 'var(--muted, #52525b)', marginTop: '2px' }}>{item.detail}</span>
      </span>
      {item.state !== 'ok' && item.fix ? (
        <button type="button" disabled={busy} onClick={() => onFix(item.fix!.action)} style={{ ...ghost, flex: 'none', height: '30px', fontSize: '12px', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Working…' : item.fix.label}
        </button>
      ) : null}
    </li>
  );
}

/** On the dialer while anything is missing: one line that opens the checklist. */
export function DialerSetupFlag({ style }: { style?: React.CSSProperties }) {
  useSyncExternalStore(subscribeReadiness, readinessRev, () => 0);
  const facts = readinessFacts();
  if (!facts) return null;
  const open = needsAttention(dialerReadiness(facts));
  if (!open.length) return null;
  const missing = open.some((i) => i.state === 'missing');
  const color = missing ? 'var(--tx-red, #b91c1c)' : '#b45309';
  return (
    <button
      type="button"
      onClick={reviewDialerReadiness}
      title={open.map((i) => i.title).join(' · ')}
      style={{
        display: 'flex', alignItems: 'center', gap: '6px', width: '100%', textAlign: 'left', cursor: 'pointer',
        border: `1px solid ${missing ? 'var(--tint-red-2, #fecaca)' : 'var(--tint-amber-2, #fde68a)'}`, background: missing ? 'var(--tint-red, #fef2f2)' : 'var(--tint-amber, #fffbeb)', color,
        borderRadius: '8px', padding: '7px 10px', font: '600 11.5px/1.3 var(--sans, system-ui)', ...style,
      }}
    >
      <span aria-hidden style={{ fontWeight: 800 }}>!</span>
      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Dialer setup: {open.length === 1 ? open[0]!.title.toLowerCase() : `${open.length} things to fix`}
      </span>
      <span style={{ textDecoration: 'underline' }}>Fix</span>
    </button>
  );
}

const primary: React.CSSProperties = { height: '36px', padding: '0 14px', borderRadius: '10px', border: '1px solid var(--ink-deep, #1c1d1f)', background: 'var(--ink-deep, #1c1d1f)', color: 'var(--surface, #fff)', fontWeight: 700, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: '36px', padding: '0 12px', borderRadius: '10px', border: '1px solid #ddd9ce', background: 'var(--surface, #fff)', color: 'var(--ink-deep, #1c1d1f)', fontWeight: 650, cursor: 'pointer' };
