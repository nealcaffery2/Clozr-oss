// AI Agent, Voice: pick a voice (with samples) and tune the speech model.
'use client';

import React from 'react';
import { firstError } from '@/lib/voice-agent-console';
import { VoicePicker } from '../VoicePicker';
import { VoiceTuning } from '../VoiceTuning';
import type { TabCtx } from '../types';

export function VoiceTab({ api, admin, agentKey, form, canEdit }: TabCtx) {
  const { draft, errors, set } = form;
  return (
    <>
      <VoicePicker api={api} admin={admin} agentKey={agentKey} settings={draft} selected={draft.voice.voice_id} canEdit={canEdit} onSelect={(id) => set(['voice', 'voice_id'], id)} />
      <VoiceTuning voice={draft.voice} set={set} canEdit={canEdit} error={firstError(errors, 'voice')} />
    </>
  );
}
