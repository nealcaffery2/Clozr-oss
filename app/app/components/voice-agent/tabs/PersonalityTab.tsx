// AI Agent, Personality: how the agent sounds, as a tone and five dials. These
// become the "How you sound" block of the prompt, unless a prompt override
// replaces it.
'use client';

import React from 'react';
import { EXPRESSIVENESS, EXPRESSIVE_TTS, TONES, speaksTags, ttsLabel, type Expressiveness, type Tone } from '@/lib/voice-agent';
import { Banner, ChoiceCards, Scale, Section, SettingRow, Switch, ghost, grid, eyebrow } from '../kit';
import type { TabCtx } from '../types';

const ENERGY = ['Very calm', 'Calm', 'Balanced', 'Upbeat', 'Energetic'];
const LENGTH = ['One short line', 'Brief', 'Balanced', 'Thorough', 'Detailed'];
const WARMTH = ['Matter of fact', 'Cool', 'Friendly', 'Warm', 'Very warm'];
const FORMAL = ['Very casual', 'Casual', 'Balanced', 'Polished', 'Very formal'];
const HUMOR = ['None', 'A touch', 'Some', 'Playful'];

export function PersonalityTab({ form, canEdit }: TabCtx) {
  const { draft, set } = form;
  const p = draft.personality;
  const off = !canEdit;
  return (
    <>
      <Section id="va-tone" title="Tone" description="The overall feel of the conversation.">
        <span style={eyebrow} id="va-tone-l">Tone</span>
        <ChoiceCards<Tone> label="Tone" value={p.tone} disabled={off} onChange={(v) => set(['personality', 'tone'], v)} options={TONES.map((t) => ({ id: t.id, label: t.label, hint: t.hint }))} />
        {draft.script.raw_prompt_override?.trim() ? <div style={{ marginTop: 12 }}><Banner tone="warn">A prompt override is set on the Script tab, so these personality settings are not used.</Banner></div> : null}
      </Section>

      <Section id="va-dials" title="Dials" description="Fine tune the voice of the agent. Each one is a plain-language line in the prompt.">
        <div style={{ ...grid(280), gap: '20px 26px' }}>
          <Scale id="va-energy" label="Energy" value={p.energy} min={1} max={5} ends={['Reserved', 'Energetic']} words={ENERGY} disabled={off} onChange={(v) => set(['personality', 'energy'], v)} hint="How much life is in the delivery." />
          <Scale id="va-warmth" label="Warmth" value={p.warmth} min={1} max={5} ends={['Matter of fact', 'Warm']} words={WARMTH} disabled={off} onChange={(v) => set(['personality', 'warmth'], v)} hint="How much personal kindness it shows." />
          <Scale id="va-verbosity" label="Length of replies" value={p.verbosity} min={1} max={5} ends={['Brief', 'Detailed']} words={LENGTH} disabled={off} onChange={(v) => set(['personality', 'verbosity'], v)} hint="Short turns keep a phone call natural." />
          <Scale id="va-formality" label="Formality" value={p.formality} min={1} max={5} ends={['Casual', 'Formal']} words={FORMAL} disabled={off} onChange={(v) => set(['personality', 'formality'], v)} hint="Like a neighbor, or like a front desk." />
          <Scale id="va-humor" label="Humor" value={p.humor} min={0} max={3} ends={['None', 'Playful']} words={HUMOR} disabled={off} onChange={(v) => set(['personality', 'humor'], v)} hint="Sellers in a hard spot rarely want jokes." />
        </div>
        <div style={{ marginTop: 6 }}>
          <SettingRow title="Filler words" help={'Small acknowledgements like "Gotcha" and "Okay, that makes sense". They make it sound less scripted.'}>
            <Switch label="Use filler words" on={p.use_fillers} disabled={off} onChange={(v) => set(['personality', 'use_fillers'], v)} />
          </SettingRow>
        </div>
      </Section>

      <Section id="va-delivery" title="Delivery" description="How human the agent sounds between the words: hesitations, pauses, empathy and real sounds.">
        <ChoiceCards<Expressiveness> label="Delivery" value={p.expressiveness} disabled={off}
          onChange={(v) => set(['personality', 'expressiveness'], v)}
          options={EXPRESSIVENESS.map((x) => ({ id: x.id, label: x.label, hint: x.hint }))} />
        {p.expressiveness === 'expressive' && !speaksTags(draft.voice.tts_model)
          ? <div style={{ marginTop: 12 }}><Banner tone="warn" action={off ? undefined : <button type="button" className="va-btn va-ghost" style={ghost} onClick={() => set(['voice', 'tts_model'], EXPRESSIVE_TTS)}>Use {ttsLabel(EXPRESSIVE_TTS)}</button>}>Sounds like a laugh or a sigh need v4 Turbo, v4 or v3 Conversational. With {ttsLabel(draft.voice.tts_model)} the agent stays natural but makes no sounds.</Banner></div>
          : null}
      </Section>
    </>
  );
}
