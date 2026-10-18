'use client';

/**
 * Settings → Talkr → Audio & sounds, top to bottom: microphone and speaker,
 * ringtones, the voicemail drop, your voicemail greeting, then notification
 * sounds. Talkr's Audio and
 * Sounds cards (apps/web/app/(app)/settings/page.tsx), plus what CLOZR adds.
 *
 * Everything but the greeting is per user, per browser (lib/phone-audio.ts) —
 * Talkr's `/v1/me` has no fields for it, and Talkr itself keeps these in localStorage. The
 * device lists come straight from the browser, so this works before the
 * softphone connects; lib/softphone.ts applies the choices to the carrier SDK.
 * Custom MP3 / HTTPS links and outbound ringback share the same prefs used by
 * inbox, dialer, and every softphone surface.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  NOTIFY_EVENTS,
  RINGTONES,
  TONES,
  micConstraints,
  outputSelectionSupported,
  previewActiveRingtone,
  previewRingtone,
  isUploadedSound,
  setAudioPrefs,
  setCustomRingtoneFromFile,
  setEventSoundFromFile,
  previewEvent,
  testOutput,
  useAudioPrefs,
  type NotifyEvent,
  type RingtoneId,
  type ToneId,
  isIOSDevice,
} from '@/lib/phone-audio';
import {
  notificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/lib/desktop-notify';
import { Icon } from './Icon';
import { Button, Card, Eyebrow, FIELD, StatusMarker, Toggle } from './ui';
import { shortDeviceLabel } from './softphoneAdapter';
import { VoicemailDropPanel } from './VoicemailDrop';
import { MyVoicemailGreeting } from '@/app/components/phone/MyGreeting';

/**
 * The desktop-notification switch.
 *
 * Turning it on is the one place the browser is asked for permission: the
 * prompt has to come from a gesture, and a denial is permanent for the origin,
 * so it is never raised on load. A blocked browser says so and stays off —
 * only the rep can undo that, from the padlock in the address bar.
 */
function DesktopNotifications({ on }: { on: boolean }) {
  const [perm, setPerm] = useState<NotificationPermissionState>('unsupported');
  useEffect(() => setPerm(notificationPermission()), []);

  if (!notificationsSupported()) {
    return <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>No desktop notifications here</span>;
  }

  const blocked = perm === 'denied';
  return (
    <div className="flex items-center gap-2.5">
      {blocked && (
        <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--red)' }} title="Allow notifications for this site from the padlock in your address bar">
          Blocked by your browser
        </span>
      )}
      <Toggle
        on={on && perm === 'granted'}
        label="Desktop notifications"
        onChange={(want) => {
          if (!want) {
            setAudioPrefs({ desktopNotifications: false });
            return;
          }
          void requestNotificationPermission().then((next) => {
            setPerm(next);
            // Only on once the browser actually said yes, so the switch never
            // claims something the rep will not receive.
            setAudioPrefs({ desktopNotifications: next === 'granted' });
          });
        }}
      />
    </div>
  );
}

type Permission = 'granted' | 'denied' | 'prompt' | 'unknown';

const PERMISSION: Record<Permission, { color: string; label: string }> = {
  granted: { color: 'var(--green)', label: 'Allowed' },
  denied: { color: 'var(--red)', label: 'Blocked' },
  prompt: { color: 'var(--amber)', label: 'Not asked' },
  unknown: { color: 'var(--muted-2)', label: 'Unknown' },
};

const HELP = { font: '400 11px/1.45 var(--sans)', color: 'var(--muted-2)' } as const;

/** The browser's audio devices and mic permission, kept fresh on plug/unplug. */
function useAudioDevices() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<Permission>('unknown');
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.enumerateDevices;

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all.filter((d) => d.kind === 'audioinput'));
      setOutputs(all.filter((d) => d.kind === 'audiooutput'));
      // Labels are only filled in once the site may use the mic.
      if (all.some((d) => d.kind === 'audioinput' && d.label)) setPermission('granted');
    } catch {
      /* keep the last list */
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    let status: PermissionStatus | null = null;
    const read = () => status && setPermission(status.state as Permission);
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        status = s;
        read();
        s.onchange = () => {
          read();
          void refresh();
        };
      })
      .catch(() => undefined);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
      if (status) status.onchange = null;
    };
  }, [supported, refresh]);

  const request = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setPermission('granted');
    } catch {
      setPermission('denied');
    }
    await refresh();
  }, [refresh]);

  return { inputs, outputs, permission, request, supported };
}

/** Live input level (0–1) from the chosen mic with the chosen processing, while `on`. */
function useMicLevel(on: boolean, constraints: MediaTrackConstraints): number {
  const [level, setLevel] = useState(0);
  const key = JSON.stringify(constraints);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let live = true;
    void navigator.mediaDevices
      .getUserMedia({ audio: JSON.parse(key) as MediaTrackConstraints })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setLevel(0));
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      setLevel(0);
    };
  }, [on, key]);
  return level;
}

function DeviceSelect({ devices, value, onChange, disabled, label }: { devices: MediaDeviceInfo[]; value: string | null; onChange: (id: string | null) => void; disabled?: boolean; label: string }) {
  const hasDefault = devices.some((d) => d.deviceId === 'default');
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      aria-label={label}
      className="min-w-0 flex-1 outline-none disabled:cursor-not-allowed disabled:opacity-50"
      style={FIELD}
    >
      {!hasDefault && <option value="">System default</option>}
      {devices.map((d, i) => (
        <option key={`${d.deviceId}-${i}`} value={d.deviceId}>
          {d.label ? shortDeviceLabel(d.label) : `${label} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

function Volume({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <label className="flex items-center gap-2.5" style={{ font: '500 12px/1 var(--sans)', color: 'var(--muted)' }}>
      <Icon name="speaker" size={13} />
      <input type="range" min={0} max={100} step={5} value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} aria-label={label} className="flex-1" style={{ accentColor: 'var(--accent)' }} />
      <span style={{ width: 34, textAlign: 'right' }}>{Math.round(value * 100)}%</span>
    </label>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-2.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
      <span className="mr-auto flex min-w-0 flex-col gap-0.5" style={{ flex: '1 1 180px' }}>
        <span style={{ font: '600 12.5px/1.2 var(--sans)' }}>{title}</span>
        {hint && <span style={HELP}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function CardHead({ icon, title, right }: { icon: 'mic' | 'phone' | 'msg' | 'voicemail'; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon name={icon} size={16} style={{ color: 'var(--accent)' }} />
      <span className="mr-auto" style={{ font: '700 13.5px/1 var(--sans)' }}>{title}</span>
      {right}
    </div>
  );
}

/** Which of the two ringing sounds a control edits. */
type RingSlot = 'incoming' | 'outgoing';

/**
 * Dial-out ringback: its own tone, or wait music, or neither.
 *
 * "Same as incoming" is the default and is what this did before the choice
 * existed, so an upgrade changes nothing for anyone. Picking a tone here
 * overrides an incoming custom file too — a dial-out choice that lost to the
 * incoming MP3 would look broken.
 */
function OutboundRingback() {
  const p = useAudioPrefs();
  const custom = p.outgoingCustomRingtoneUrl;
  const same = !custom && !p.outgoingRingtone;
  return (
    <div className="flex flex-col">
      <label className="flex cursor-pointer items-center gap-2.5 py-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <input
          type="radio"
          name="outgoing-ringtone"
          checked={same}
          onChange={() => setAudioPrefs({ outgoingRingtone: null, outgoingCustomRingtoneUrl: null })}
          style={{ accentColor: 'var(--accent)' }}
        />
        <span className="mr-auto" style={{ font: `${same ? 600 : 500} 12.5px/1 var(--sans)` }}>Same as incoming</span>
        <Button tone="quiet" onClick={() => previewActiveRingtone(p, true)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
          <Icon name="play" size={11} />
          Preview
        </Button>
      </label>
      {(Object.keys(RINGTONES) as RingtoneId[]).map((id) => {
        const on = !custom && p.outgoingRingtone === id;
        return (
          <label key={id} className="flex cursor-pointer items-center gap-2.5 py-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <input
              type="radio"
              name="outgoing-ringtone"
              checked={on}
              onChange={() => setAudioPrefs({ outgoingRingtone: id, outgoingCustomRingtoneUrl: null })}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span className="mr-auto" style={{ font: `${on ? 600 : 500} 12.5px/1 var(--sans)` }}>{RINGTONES[id].label}</span>
            <Button tone="quiet" onClick={() => previewRingtone(id, p)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
              <Icon name="play" size={11} />
              Preview
            </Button>
          </label>
        );
      })}
      <div className="flex flex-col gap-2 py-2.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input type="radio" name="outgoing-ringtone" checked={!!custom} readOnly style={{ accentColor: 'var(--accent)' }} />
          <span className="mr-auto" style={{ font: `${custom ? 600 : 500} 12.5px/1 var(--sans)` }}>Your MP3</span>
          <Button tone="quiet" disabled={!custom} onClick={() => previewActiveRingtone(p, true)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
            <Icon name="play" size={11} />
            Preview
          </Button>
        </label>
        <CustomRingtoneFields target="outgoing" />
      </div>
    </div>
  );
}

/**
 * The URL box and upload button for one custom sound. `target` says which:
 * the incoming ringtone, or the dial-out wait music.
 */
function CustomRingtoneFields({ target = 'incoming' }: { target?: RingSlot }) {
  const p = useAudioPrefs();
  const current = target === 'outgoing' ? p.outgoingCustomRingtoneUrl : p.customRingtoneUrl;
  const write = (url: string | null) =>
    setAudioPrefs(target === 'outgoing' ? { outgoingCustomRingtoneUrl: url } : { customRingtoneUrl: url });
  const fileRef = useRef<HTMLInputElement>(null);
  const [urlDraft, setUrlDraft] = useState(isUploadedSound(current) ? '' : (current ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current || isUploadedSound(current)) {
      if (!current) setUrlDraft('');
      return;
    }
    setUrlDraft(current);
  }, [current]);

  const applyUrl = () => {
    setError(null);
    const url = urlDraft.trim();
    if (!url) {
      // The box is empty while an uploaded file plays; leaving it is not a clear. "Clear custom" is.
      if (!isUploadedSound(current)) write(null);
      return;
    }
    if (!/^https?:\/\//i.test(url) && !url.startsWith('data:audio')) {
      setError('Use an https:// link (or upload a file).');
      return;
    }
    write(url);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await setCustomRingtoneFromFile(file, target);
      setUrlDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div className="flex flex-wrap gap-1.5">
        <input
          type="url"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={applyUrl}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyUrl())}
          placeholder={target === 'outgoing' ? 'https://example.com/hold-music.mp3' : 'https://example.com/ringtone.mp3'}
          aria-label={target === 'outgoing' ? 'Custom wait music URL' : 'Custom ringtone URL'}
          className="min-w-0 flex-1 outline-none"
          style={{ ...FIELD, padding: '7px 9px' }}
        />
        <Button tone="ghost" className="shrink-0" onClick={applyUrl}>
          Use link
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input ref={fileRef} type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/*" className="hidden" onChange={(e) => void onFile(e)} />
        <Button tone="ghost" className="shrink-0" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Uploading…' : 'Upload MP3'}
        </Button>
        {current && (
          <Button
            tone="quiet"
            className="shrink-0"
            onClick={() => {
              write(null);
              setUrlDraft('');
              setError(null);
            }}
          >
            Clear custom
          </Button>
        )}
      </div>
      {isUploadedSound(current) && (
        <span style={HELP}>Using uploaded file in this browser (max 10 MB). HTTPS links sync better across devices.</span>
      )}
      {error && <span style={{ ...HELP, color: 'var(--red)' }}>{error}</span>}
    </div>
  );
}

export function AudioSettings({ who, workspaceId = null, userId = null }: { who: string | null; workspaceId?: number | null; userId?: string | null }) {
  const p = useAudioPrefs();
  const dev = useAudioDevices();
  const sinkOk = outputSelectionSupported();
  const [meter, setMeter] = useState(false);
  // One hidden file input serves every notification row; this says which row asked.
  const alertFile = useRef<HTMLInputElement | null>(null);
  const pickFor = useRef<NotifyEvent | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const level = useMicLevel(meter && dev.permission === 'granted', micConstraints(p));
  const permission = PERMISSION[dev.permission];

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 760 }}>
      <p style={HELP}>
        Set these in order: how you sound on a call, what rings, the voicemail a machine or a second answer hears, what callers hear when you miss them, then alerts.
      </p>
      {/* ── 1. Microphone and speaker ──────────────────────────────── */}
      <Card className="flex flex-col gap-3.5">
        <CardHead icon="mic" title="1 · Microphone and speaker" right={<StatusMarker color={permission.color} label={`Mic ${permission.label}`} />} />
        {!dev.supported ? (
          <p style={HELP}>This browser cannot list audio devices. Calls use the system default mic and speaker.</p>
        ) : (
          <>
            {dev.permission !== 'granted' && (
              <div className="flex flex-col gap-1.5">
                <div>
                  <Button tone="accent" onClick={() => void dev.request()}>
                    <Icon name="mic" size={13} />
                    Allow microphone
                  </Button>
                </div>
                <span style={{ ...HELP, color: dev.permission === 'denied' ? 'var(--red)' : HELP.color }}>
                  {dev.permission === 'denied'
                    ? 'Blocked by the browser: click the lock icon in the address bar → Site settings → Microphone → Allow, then reload.'
                    : 'Device names and the level meter need microphone access.'}
                </span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Eyebrow>Microphone</Eyebrow>
              <div className="flex gap-1.5">
                <DeviceSelect label="Microphone" devices={dev.inputs} value={p.inputDeviceId} onChange={(id) => setAudioPrefs({ inputDeviceId: id })} />
                <Button tone="ghost" className="shrink-0" disabled={dev.permission !== 'granted'} onClick={() => setMeter((m) => !m)}>
                  {meter ? 'Stop test' : 'Test mic'}
                </Button>
              </div>
              <span role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="block overflow-hidden" style={{ height: 5, borderRadius: 3, background: 'var(--panel-2)' }}>
                <span className="block h-full" style={{ width: `${Math.round(level * 100)}%`, background: 'var(--green)', transition: 'width 90ms linear' }} />
              </span>
              <span style={HELP}>{meter ? 'Say something — the bar should move.' : 'Used from your next call.'}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Eyebrow>Speaker</Eyebrow>
              <div className="flex gap-1.5">
                <DeviceSelect label="Speaker" devices={dev.outputs} value={p.outputDeviceId} disabled={!sinkOk} onChange={(id) => setAudioPrefs({ outputDeviceId: id })} />
                <Button tone="ghost" className="shrink-0" onClick={() => testOutput(p.outputDeviceId)}>
                  <Icon name="play" size={12} />
                  Test speaker
                </Button>
              </div>
              <span style={HELP}>
                {sinkOk
                  ? 'Where you hear the caller, and your notification sounds. Switches live on a call.'
                  : isIOSDevice()
                    ? 'On a phone the call starts in the earpiece. Speaker on the call screen switches it to the loudspeaker. Headphones and Bluetooth take over when they connect.'
                    : 'This browser (Safari, Firefox on some systems) cannot choose an output; audio follows the system default. Chrome or Edge can pick a speaker.'}
              </span>
            </div>

            <div className="flex flex-col">
              <Eyebrow>Processing</Eyebrow>
              <Row title="Echo cancellation" hint="Stops the caller hearing themselves through your speakers">
                <Toggle on={p.echoCancellation} onChange={(v) => setAudioPrefs({ echoCancellation: v })} label="Echo cancellation" />
              </Row>
              <Row title="Noise suppression" hint="Filters keyboard, fans and a busy floor">
                <Toggle on={p.noiseSuppression} onChange={(v) => setAudioPrefs({ noiseSuppression: v })} label="Noise suppression" />
              </Row>
              <Row title="Automatic gain" hint="Evens out your volume; turn off with a hardware-leveled headset">
                <Toggle on={p.autoGainControl} onChange={(v) => setAudioPrefs({ autoGainControl: v })} label="Automatic gain" />
              </Row>
            </div>
          </>
        )}
      </Card>

      {/* ── 2. Ringtones ───────────────────────────────────────────── */}
      <Card className="flex flex-col gap-3.5">
        <CardHead icon="phone" title="2 · Ringtones" right={<Toggle on={p.ringOnDevice} onChange={(v) => setAudioPrefs({ ringOnDevice: v })} label="Ring on this device" />} />
        <p style={HELP}>
          {p.ringOnDevice ? 'Incoming calls ring in this browser.' : 'Incoming ringing is off on this device: calls show the card silently.'}
          {' '}Applies across inbox, dialer, and every softphone surface.
        </p>
        <Eyebrow>Incoming ringtone</Eyebrow>
        <div className="flex flex-col">
          {(Object.keys(RINGTONES) as RingtoneId[]).map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2.5 py-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
              <input
                type="radio"
                name="ringtone"
                checked={!p.customRingtoneUrl && p.ringtone === id}
                onChange={() => setAudioPrefs({ ringtone: id, customRingtoneUrl: null })}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span className="mr-auto" style={{ font: `${!p.customRingtoneUrl && p.ringtone === id ? 600 : 500} 12.5px/1 var(--sans)` }}>{RINGTONES[id].label}</span>
              <Button tone="quiet" onClick={() => previewRingtone(id, { ...p, customRingtoneUrl: null })} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
                <Icon name="play" size={11} />
                Preview
              </Button>
            </label>
          ))}
          <div className="flex flex-col gap-2 py-2.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="radio"
                name="ringtone"
                checked={!!p.customRingtoneUrl}
                readOnly
                style={{ accentColor: 'var(--accent)' }}
              />
              <span className="mr-auto" style={{ font: `${p.customRingtoneUrl ? 600 : 500} 12.5px/1 var(--sans)` }}>Custom MP3 / link</span>
              <Button tone="quiet" disabled={!p.customRingtoneUrl} onClick={() => previewActiveRingtone(p)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }}>
                <Icon name="play" size={11} />
                Preview
              </Button>
            </label>
            <CustomRingtoneFields />
          </div>
        </div>

        <Row title="Outbound waiting music" hint="The piano you hear while their phone rings is the phone company's hold music. Upload an MP3 and that plays instead until they pick up.">
          <Toggle on={p.outgoingRingback} onChange={(v) => setAudioPrefs({ outgoingRingback: v })} label="Outbound ringback" />
        </Row>
        {p.outgoingRingback && <OutboundRingback />}

        <Volume label="Ringtone volume" value={p.ringVolume} onChange={(v) => setAudioPrefs({ ringVolume: v })} />
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Ring on</Eyebrow>
          <div className="flex gap-1.5">
            <DeviceSelect label="Ringtone device" devices={dev.outputs} value={p.ringDeviceId} disabled={!sinkOk} onChange={(id) => setAudioPrefs({ ringDeviceId: id })} />
            <Button tone="ghost" className="shrink-0" onClick={() => previewActiveRingtone(p)}>
              <Icon name="phone" size={12} />
              Test ring
            </Button>
          </div>
          <span style={HELP}>Pick your desk speakers to hear calls with the headset off.</span>
        </div>
      </Card>

      {/* ── 3. Voicemail drop ──────────────────────────────────────── */}
      <Card className="flex flex-col gap-3.5">
        <CardHead icon="voicemail" title="3 · Voicemail drop" />
        <VoicemailDropPanel workspaceId={workspaceId} userId={userId} />
      </Card>

      {/* ── 4. Voicemail greeting ──────────────────────────────────── */}
      <Card className="flex flex-col gap-3.5">
        <CardHead icon="voicemail" title="4 · Your voicemail greeting" />
        <span style={HELP}>What a caller hears before leaving you a voicemail. Saved to your phone account, so it follows you to every device.</span>
        <MyVoicemailGreeting />
      </Card>

      {/* ── 5. Notification sounds ─────────────────────────────────── */}
      <Card className="flex flex-col gap-3">
        <CardHead icon="msg" title="5 · Notifications" right={<DesktopNotifications on={p.desktopNotifications} />} />
        <Volume label="Notification volume" value={p.notifyVolume} onChange={(v) => setAudioPrefs({ notifyVolume: v })} />
        <input
          ref={alertFile} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg" hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            const ev = pickFor.current;
            if (!file || !ev) return;
            setAlertError(null);
            try { await setEventSoundFromFile(ev, file); previewEvent(ev); }
            catch (err) { setAlertError(err instanceof Error ? err.message : 'Upload failed'); }
          }}
        />
        {alertError ? <span style={{ ...HELP, color: 'var(--tx-red, #b91c1c)' }}>{alertError}</span> : null}
        <div className="flex flex-col">
          {(Object.keys(NOTIFY_EVENTS) as NotifyEvent[]).map((ev) => {
            const cur = p.events[ev];
            const set = (patch: Partial<typeof cur>) => setAudioPrefs({ events: { ...p.events, [ev]: { ...cur, ...patch } } });
            return (
              <Row key={ev} title={NOTIFY_EVENTS[ev].label} hint={cur.customUrl ? `${NOTIFY_EVENTS[ev].hint} · your own sound` : NOTIFY_EVENTS[ev].hint}>
                <select
                  value={cur.customUrl ? '__custom' : cur.tone}
                  onChange={(e) => {
                    if (e.target.value === '__upload') { pickFor.current = ev; alertFile.current?.click(); return; }
                    if (e.target.value === '__custom') return;
                    set({ tone: e.target.value as ToneId, customUrl: null });
                  }}
                  disabled={!cur.on} aria-label={`${NOTIFY_EVENTS[ev].label} sound`} className="outline-none disabled:opacity-50" style={{ ...FIELD, padding: '7px 9px', width: 130 }}
                >
                  {(Object.keys(TONES) as ToneId[]).map((t) => (
                    <option key={t} value={t}>{TONES[t].label}</option>
                  ))}
                  {cur.customUrl ? <option value="__custom">Your MP3</option> : null}
                  <option value="__upload">{cur.customUrl ? 'Replace MP3…' : 'Upload MP3…'}</option>
                </select>
                <Button tone="quiet" disabled={!cur.on} onClick={() => previewEvent(ev, p)} style={{ padding: '6px 9px', font: '600 11px/1 var(--sans)' }} title={`Preview ${NOTIFY_EVENTS[ev].label} sound`}>
                  <Icon name="play" size={11} />
                </Button>
                <Toggle on={cur.on} onChange={(on) => set({ on })} label={NOTIFY_EVENTS[ev].label} />
              </Row>
            );
          })}
        </div>
        <p style={HELP}>
          Browsers only play sound after you have clicked somewhere in CLOZR once, so the first alert after a fresh load
          may be silent. Each switch is the same one the bell uses: Mute on a row turns these off for an hour and
          Unmute turns them back on. Desktop notifications use the same switches. Saved in this browser
          {who ? ` for ${who}` : ''}.
        </p>
      </Card>
    </div>
  );
}
