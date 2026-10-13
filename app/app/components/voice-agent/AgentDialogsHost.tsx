// Picks which agent-level dialog is open, so the screen root holds one piece
// of state for all three.
'use client';

import React from 'react';
import type { Api, CreatedAgent } from '@/lib/voice-agent-client';
import type { AgentSummary } from '@/lib/voice-agent';
import { DeleteDialog, DuplicateDialog, NewAgentDialog } from './AgentDialogs';

export type DialogState = { kind: 'new' } | { kind: 'duplicate'; agent: AgentSummary } | { kind: 'delete'; agent: AgentSummary } | null;

export function AgentDialogsHost({ api, state, agents, onClose, onCreated, onDeleted }: {
  api: Api; state: DialogState; agents: AgentSummary[]; onClose: () => void;
  onCreated: (c: CreatedAgent, what: 'Created' | 'Duplicated') => void; onDeleted: (key: string, remote: boolean) => void;
}) {
  if (!state) return null;
  if (state.kind === 'new') return <NewAgentDialog api={api} taken={agents.map((a) => a.agent_key)} onClose={onClose} onCreated={(c) => onCreated(c, 'Created')} />;
  if (state.kind === 'duplicate') return <DuplicateDialog api={api} agent={state.agent} onClose={onClose} onCreated={(c) => onCreated(c, 'Duplicated')} />;
  return <DeleteDialog api={api} agent={state.agent} onClose={onClose} onDeleted={onDeleted} />;
}
