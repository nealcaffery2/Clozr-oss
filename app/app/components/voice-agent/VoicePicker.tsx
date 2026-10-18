// AI Agent, Voice: the ElevenLabs voices this account can use, searchable, each
// with a play button. A ready-made preview_url plays directly; otherwise the
// `preview` action renders the fixed sample line in that voice.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Play, Search, Square } from 'lucide-react';
import { SILENT_WAV } from '@/lib/phone-audio';
import { audioSrc, type Api } from '@/lib/voice-agent-client';
import { TUNING_KEYS, filterVoices, modelDiffers, sampleLine, ttsLabel, voiceTraits, type AgentSettings, type Voice } from '@/lib/voice-agent';
import { Banner, Empty, GREEN, INK, LINE, MUTED, Skeleton, Spinner, card, ghost, h2, input, sub } from './kit';

type Load = { at: 'loading' } | { at: 'ready'; voices: Voice[] } | { at: 'error'; error: string };

export function VoicePicker({ api, admin, agentKey, settings, selected, onSelect, canEdit }: {
  api: Api; admin: boolean; agentKey: string; settings: AgentSettings; selected: string; onSelect: (id: string) => void; canEdit: boolean;
}) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [q, setQ] = useState('');
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const cache = useRef(new Map<string, { src: string; model: string | null }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turn = useRef(0);
  const line = sampleLine(settings.identity);

  useEffect(() => {
    let live = true;
    if (!admin) return;
    void api.voices(agentKey).then((r) => {
      if (live) setLoad(r.ok ? { at: 'ready', voices: r.data } : { at: 'error', error: r.error });
    });
    return () => { live = false; };
  }, [api, admin, agentKey, nonce]);

  const stop = useCallback(() => {
    turn.current++;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (audio.current) audio.current.pause();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);

  const play = useCallback(async (v: Voice) => {
    if (playing === v.voice_id) return stop();
    stop();
    setPlayError(null);
    const me = turn.current;
    // One element for every sample. Safari only starts sound from inside a click, and a
    // rendered sample arrives after the click is over; an element that already played
    // from a click may play again later, so it is primed with silence before the fetch.
    const a = (audio.current ??= new Audio());
    const start = (src: string) => {
      if (turn.current !== me) return;
      a.onended = () => { if (turn.current === me) setPlaying(null); };
      a.onerror = () => { if (turn.current === me) { setPlaying(null); setPlayError('That sample would not play.'); } };
      a.src = src;
      setPlaying(v.voice_id);
      a.play().catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : '';
        // AbortError: a newer press or Stop replaced this sample, which is not a failure.
        if (turn.current !== me || name === 'AbortError') return;
        setPlaying(null);
        setPlayError(name === 'NotAllowedError' ? 'The browser blocked playback. Press play again.' : 'That sample would not play.');
      });
    };
    if (v.preview_url) return start(v.preview_url);
    if (api.demo) {
      // Demo voices have no audio; the browser's own voice stands in so the button visibly works.
      setPlaying(v.voice_id);
      if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
        const u = new SpeechSynthesisUtterance(line);
        u.onend = () => setPlaying((p) => (p === v.voice_id ? null : p));
        speechSynthesis.speak(u);
      }
      timer.current = setTimeout(() => setPlaying((p) => (p === v.voice_id ? null : p)), 4000);
      return;
    }
    // Unsaved model and tuning ride along, so a slider can be heard before it is saved.
    const opts: Record<string, unknown> = { tts_model: settings.voice.tts_model };
    for (const k of TUNING_KEYS) if (settings.voice[k] != null) opts[k] = settings.voice[k];
    const key = v.voice_id + '|' + line + '|' + JSON.stringify(opts);
    const hit = cache.current.get(key);
    if (hit) { setSpoken(hit.model); return start(hit.src); }
    a.onended = a.onerror = null;
    a.src = SILENT_WAV;
    a.play().catch(() => undefined);
    setFetching(v.voice_id);
    const r = await api.previewVoice(agentKey, v.voice_id, line, opts);
    setFetching((f) => (f === v.voice_id ? null : f));
    if (!r.ok) { if (turn.current === me) setPlayError(r.error); return; }
    const src = audioSrc(r.data);
    cache.current.set(key, { src, model: r.data.model });
    if (turn.current !== me) return;
    setSpoken(r.data.model);
    start(src);
  }, [agentKey, api, line, playing, settings.voice, stop]);

  const voices = useMemo(() => (load.at === 'ready' ? load.voices : []), [load]);
  const shown = useMemo(() => filterVoices(voices, q), [voices, q]);
  const pickedMissing = load.at === 'ready' && selected && !voices.some((v) => v.voice_id === selected);

  if (!admin) {
    return (
      <section style={card} aria-labelledby="va-voice">
        <h2 id="va-voice" style={h2}>Voice</h2>
        <p style={sub}>Only owners and admins can browse voices or play samples.</p>
        {selected ? <p style={{ margin: '10px 0 0', fontSize: 13, color: INK }}>Current voice ID: <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{selected}</span></p> : null}
      </section>
    );
  }

  return (
    <section style={card} aria-labelledby="va-voice">
      <h2 id="va-voice" style={h2}>Voice</h2>
      <p style={{ ...sub, marginBottom: 12 }}>
        {canEdit ? 'Press play to hear a voice say ' : 'The voice the agent uses. Samples say '}
        <span style={{ color: INK }}>&ldquo;{line.length > 70 ? line.slice(0, 68).trimEnd() + '…' : line}&rdquo;</span>
      </p>

      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, top: 11, color: MUTED, pointerEvents: 'none' }} />
        <input className="va-field" type="search" aria-label="Search voices" placeholder="Search by name, accent or style" value={q} onChange={(e) => setQ(e.target.value)} disabled={load.at !== 'ready'}
          style={{ ...input, paddingLeft: 33 }} />
      </div>

      {spoken ? (
        <div style={{ marginBottom: 10 }}>
          <Banner tone={modelDiffers(settings.voice.tts_model, spoken) ? 'warn' : 'info'}>
            Last sample spoken in <strong style={{ color: INK }}>{ttsLabel(spoken)}</strong>.
            {modelDiffers(settings.voice.tts_model, spoken) ? ` You chose ${ttsLabel(settings.voice.tts_model)}; ElevenLabs used ${ttsLabel(spoken)} instead.` : ''}
          </Banner>
        </div>
      ) : null}
      {playError ? <div style={{ marginBottom: 10 }}><Banner tone="warn">{playError}</Banner></div> : null}
      {pickedMissing ? <div style={{ marginBottom: 10 }}><Banner tone="info">The saved voice is not in this account&apos;s list. Pick another to replace it.</Banner></div> : null}

      {load.at === 'loading' ? (
        <div aria-busy="true" aria-label="Loading voices" style={{ display: 'grid', gap: 8 }}>
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={54} style={{ borderRadius: 10 }} />)}
        </div>
      ) : load.at === 'error' ? (
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>
          Could not load voices. {load.error}
        </Banner>
      ) : shown.length === 0 ? (
        <Empty title={voices.length ? `No voice matches “${q}”` : 'No voices on this account'}>
          {voices.length ? 'Try a name, an accent, or a word like calm or friendly.' : 'Add a voice in ElevenLabs and it will appear here.'}
        </Empty>
      ) : (
        <div role="radiogroup" aria-label="Voice" style={{ display: 'grid', gap: 6, maxHeight: 440, overflowY: 'auto', margin: '0 -4px', padding: 4 }}>
          {shown.map((v) => {
            const on = v.voice_id === selected;
            const isPlaying = playing === v.voice_id;
            const busy = fetching === v.voice_id;
            return (
              <div key={v.voice_id} style={{ display: 'flex', alignItems: 'stretch', gap: 8, borderRadius: 10, border: `1px solid ${on ? GREEN : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', boxShadow: on ? `0 0 0 1px ${GREEN}` : 'none' }}>
                <button type="button" className="va-btn" onClick={() => void play(v)} aria-label={isPlaying ? `Stop ${v.name}` : `Play a sample of ${v.name}`}
                  style={{ width: 44, flex: 'none', display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: isPlaying ? GREEN : INK, cursor: 'pointer', borderRadius: '10px 0 0 10px' }}>
                  <span style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 999, background: isPlaying ? 'var(--surface, #fff)' : 'var(--surface-2, #f4f4f5)', boxShadow: isPlaying ? `inset 0 0 0 1px ${GREEN}` : 'none' }}>
                    {busy ? <Spinner size={14} /> : isPlaying ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Play size={13} fill="currentColor" aria-hidden="true" style={{ marginLeft: 2 }} />}
                  </span>
                </button>
                <button type="button" role="radio" aria-checked={on} disabled={!canEdit} className="va-btn" onClick={() => onSelect(v.voice_id)}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px 9px 0', border: 0, background: 'transparent', textAlign: 'left', cursor: canEdit ? 'pointer' : 'default', fontFamily: 'inherit', borderRadius: '0 10px 10px 0' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: on ? GREEN : INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                    <span style={{ display: 'block', marginTop: 1, fontSize: 12, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voiceTraits(v) || 'No description'}</span>
                  </span>
                  {v.category && v.category !== 'premade' ? (
                    <span style={{ textTransform: 'capitalize', fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--surface-2, #f4f4f5)', color: 'var(--muted, #52525b)', flex: 'none' }}>{v.category}</span>
                  ) : null}
                  <span aria-hidden="true" style={{ width: 20, height: 20, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 999, background: on ? GREEN : 'transparent', color: 'var(--on-dark, #fff)', border: on ? 0 : `1px solid ${LINE}` }}>
                    {on ? <Check size={13} strokeWidth={3} /> : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
