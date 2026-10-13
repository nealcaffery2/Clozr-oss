// AI Agent, Voice: which ElevenLabs speech model the agent talks with, and the
// three knobs that change how it sounds. Unset means ElevenLabs' own default,
// so "Reset" clears the value rather than writing the default number.
'use client';

import React from 'react';
import { LLMS, THINKING, TTS_MODELS, TUNING, tuningIsDefault, type AgentSettings, type Llm, type Thinking, type TtsModel, type TuningKey } from '@/lib/voice-agent';
import { fieldId } from '@/lib/voice-agent-console';
import { Banner, MUTED, Section, Segmented, Slider, eyebrow, ghost, input } from './kit';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const speed = (n: number) => `${n.toFixed(2).replace(/0$/, '')}x`;

const KNOBS: { key: TuningKey; label: string; ends: [string, string]; hint: string; format: (n: number) => string }[] = [
  { key: 'stability', label: 'Expressiveness', ends: ['More expressive', 'More steady'], hint: 'Lower sounds livelier and less predictable. Higher stays even and calm.', format: pct },
  { key: 'similarity', label: 'Similarity to the voice', ends: ['Looser', 'Closer'], hint: 'Higher hugs the original voice; very high can pick up its flaws.', format: pct },
  { key: 'speed', label: 'Speaking speed', ends: ['Slower', 'Faster'], hint: 'Around 1.0x is natural conversation.', format: speed },
];

export function VoiceTuning({ voice, set, error, canEdit }: {
  voice: AgentSettings['voice']; set: (path: (string | number)[], value: unknown) => void; error?: string; canEdit: boolean;
}) {
  const off = !canEdit;
  const model = TTS_MODELS.find((m) => m.id === voice.tts_model);
  const brain = LLMS.find((m) => m.id === voice.llm);
  return (
    <Section
      id="va-tuning" title="Voice model and tuning"
      description="How the agent sounds. Play a sample above to hear unsaved changes before you keep them."
      aside={canEdit ? (
        <button type="button" className="va-btn va-ghost" style={{ ...ghost, height: 28, padding: '0 10px' }} disabled={tuningIsDefault(voice)}
          onClick={() => { set(['voice', 'stability'], null); set(['voice', 'similarity'], null); set(['voice', 'speed'], null); }}>Reset tuning</button>
      ) : undefined}
    >
      <label htmlFor={fieldId('voice.tts_model')} style={eyebrow}>Speech model</label>
      <select id={fieldId('voice.tts_model')} className="va-field" style={input} value={voice.tts_model} disabled={off} onChange={(e) => set(['voice', 'tts_model'], e.target.value as TtsModel)}>
        {TTS_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      <p style={{ margin: '5px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{model?.hint} If ElevenLabs refuses a model for phone agents, CLOZR falls back to Flash v2.5 and tells you when you publish.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '14px 22px', marginTop: 18 }}>
        <div>
          <label htmlFor={fieldId('voice.llm')} style={eyebrow}>Brain</label>
          <select id={fieldId('voice.llm')} className="va-field" style={input} value={voice.llm} disabled={off} onChange={(e) => set(['voice', 'llm'], e.target.value as Llm)}>
            {LLMS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <p style={{ margin: '5px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{brain?.hint} The model that decides what the agent says. If it stalls, ElevenLabs switches to a backup after 4 seconds.</p>
        </div>
        <div>
          <span style={{ ...eyebrow, display: 'block' }}>Thinking before it answers</span>
          <Segmented<Thinking> id={fieldId('voice.thinking')} label="Thinking before it answers" value={voice.thinking} disabled={off}
            onChange={(v) => set(['voice', 'thinking'], v)} options={THINKING} />
          <p style={{ margin: '5px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>Light suits live calls. Deep weighs a pushy caller or a tricky question better but adds a pause; a short &ldquo;mm, okay&rdquo; covers any wait over 3 seconds.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '18px 22px', marginTop: 18 }}>
        {KNOBS.map((k) => (
          <Slider key={k.key} id={fieldId(`voice.${k.key}`)} label={k.label} value={voice[k.key]} min={TUNING[k.key].min} max={TUNING[k.key].max} step={TUNING[k.key].step}
            defaultValue={TUNING[k.key].def} ends={k.ends} hint={k.hint} format={k.format} disabled={off}
            onChange={(v) => set(['voice', k.key], v)} />
        ))}
      </div>
      {error ? <div style={{ marginTop: 12 }}><Banner tone="error">{error}</Banner></div> : null}
    </Section>
  );
}
