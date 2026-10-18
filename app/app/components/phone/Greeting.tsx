// A greeting the caller hears: typed text Talkr speaks, or a recording —
// uploaded (MP3/WAV) or recorded here. Browsers record WebM/Opus, which
// carriers will not <Play>, so a recording is re-encoded to 8 kHz mono WAV
// (phone quality, ~16 KB a second) before it goes to Talkr's media store.
'use client';

import React, { useRef, useState } from 'react';
import { talkr, type FlowGreeting } from '@/lib/talkr';
import { IosSegmented } from '@/app/components/talkr/ios';
import { Btn, MUTED, errText, field } from './ui';

function wav(samples: Float32Array, rate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([view], { type: 'audio/wav' });
}

async function toPhoneWav(blob: Blob): Promise<Blob> {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const rate = 8000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return wav((await offline.startRendering()).getChannelData(0), rate);
}

async function upload(blob: Blob, filename: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await talkr.uploadMedia({ content_type: blob.type, data_base64: btoa(bin), filename });
  return r.url;
}

export function GreetingEditor({ value, onChange, allowDefault, defaultLabel = 'Use the default greeting' }: {
  value: FlowGreeting | null | undefined;
  onChange: (next: FlowGreeting | null) => void;
  allowDefault?: boolean;
  defaultLabel?: string;
}) {
  const mode = !value ? 'default' : 'tts' in value ? 'tts' : 'audio';
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  const options = [
    ...(allowDefault ? [{ value: 'default' as const, label: 'Default' }] : []),
    { value: 'tts' as const, label: 'Text' },
    { value: 'audio' as const, label: 'Recording' },
  ];

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setBusy('Uploading…');
        try {
          onChange({ audio_url: await upload(await toPhoneWav(new Blob(chunks, { type: rec.mimeType })), 'greeting.wav') });
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(null);
        }
      };
      recorder.current = rec;
      rec.start();
      setBusy('recording');
    } catch (err) {
      setError(`Microphone unavailable: ${errText(err)}`);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '6px' }}>
      <div>
        <IosSegmented
          value={mode}
          options={options}
          onChange={(m) => onChange(m === 'default' ? null : m === 'tts' ? { tts: value && 'tts' in value ? value.tts : '' } : { audio_url: value && 'audio_url' in value ? value.audio_url : '' })}
        />
      </div>
      {mode === 'default' ? <div style={{ fontSize: '12px', color: MUTED }}>{defaultLabel}</div> : null}
      {value && 'tts' in value ? (
        <textarea
          value={value.tts}
          onChange={(e) => onChange({ tts: e.target.value })}
          rows={2}
          maxLength={1000}
          placeholder="Thanks for calling Acme Homes…"
          style={{ ...field, height: 'auto', padding: '7px 9px', resize: 'vertical', width: '100%' }}
        />
      ) : null}
      {value && 'audio_url' in value ? (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          {value.audio_url ? <audio controls src={value.audio_url} style={{ height: '30px', maxWidth: '100%' }} /> : <span style={{ fontSize: '12px', color: MUTED }}>No recording yet.</span>}
          {busy === 'recording' ? (
            <Btn primary onClick={() => recorder.current?.stop()}>■ Stop</Btn>
          ) : (
            <Btn disabled={Boolean(busy)} onClick={() => void startRecording()}>● Record</Btn>
          )}
          <label className="dc2" style={{ height: '30px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'var(--surface, #fff)' }}>
            Upload MP3/WAV
            <input
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setBusy('Uploading…'); setError(null);
                void upload(file, file.name).then((url) => onChange({ audio_url: url })).catch((err) => setError(errText(err))).finally(() => setBusy(null));
              }}
            />
          </label>
          {busy && busy !== 'recording' ? <span style={{ fontSize: '12px', color: MUTED }}>{busy}</span> : null}
          {busy === 'recording' ? <span style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)' }}>Recording…</span> : null}
        </div>
      ) : null}
      {error ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)' }}>{error}</div> : null}
    </div>
  );
}
