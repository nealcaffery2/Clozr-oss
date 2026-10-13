// The section registry: one entry per tab of an agent. Adding a section is an
// entry here plus a component; the editor, the nav, the badges and the jump to
// a field all read this list.
'use client';

import React from 'react';
import type { TabId } from '@/lib/voice-agent-console';
import { CallsTab } from './tabs/CallsTab';
import { HandlingTab } from './tabs/HandlingTab';
import { HistoryTab } from './tabs/HistoryTab';
import { IdentityTab } from './tabs/IdentityTab';
import { KnowledgeTab } from './tabs/KnowledgeTab';
import { OfferTab } from './tabs/OfferTab';
import { PersonalityTab } from './tabs/PersonalityTab';
import { RulesTab } from './tabs/RulesTab';
import { ScriptTab } from './tabs/ScriptTab';
import { TestTab } from './tabs/TestTab';
import { ToolsTab } from './tabs/ToolsTab';
import { TransferTab } from './tabs/TransferTab';
import { VoiceTab } from './tabs/VoiceTab';
import type { TabCtx } from './types';

export type SectionDef = {
  id: TabId; label: string; group: string;
  /** Edited settings live here, so the tab can carry an unsaved dot and an error count. Test, Calls and History are not settings. */
  settings: boolean;
  render: (c: TabCtx) => React.ReactNode;
};

export const SECTIONS: SectionDef[] = [
  { id: 'identity', label: 'Identity', group: 'Who it is', settings: true, render: (c) => <IdentityTab {...c} /> },
  { id: 'voice', label: 'Voice', group: 'Who it is', settings: true, render: (c) => <VoiceTab {...c} /> },
  { id: 'personality', label: 'Personality', group: 'Who it is', settings: true, render: (c) => <PersonalityTab {...c} /> },
  { id: 'script', label: 'Script', group: 'What it says', settings: true, render: (c) => <ScriptTab {...c} /> },
  { id: 'rules', label: 'Rules', group: 'What it says', settings: true, render: (c) => <RulesTab {...c} /> },
  { id: 'offer', label: 'Offer authority', group: 'What it says', settings: true, render: (c) => <OfferTab {...c} /> },
  { id: 'handling', label: 'Call handling', group: 'How it works', settings: true, render: (c) => <HandlingTab {...c} /> },
  { id: 'transfer', label: 'Live transfer', group: 'How it works', settings: true, render: (c) => <TransferTab {...c} /> },
  { id: 'tools', label: 'Tools', group: 'How it works', settings: true, render: (c) => <ToolsTab {...c} /> },
  { id: 'knowledge', label: 'Knowledge', group: 'How it works', settings: true, render: (c) => <KnowledgeTab {...c} /> },
  { id: 'test', label: 'Test', group: 'Review', settings: false, render: (c) => <TestTab {...c} /> },
  { id: 'calls', label: 'Calls & stats', group: 'Review', settings: false, render: (c) => <CallsTab {...c} /> },
  { id: 'history', label: 'History', group: 'Review', settings: false, render: (c) => <HistoryTab {...c} /> },
];
