// What every section (tab) of the console reads: one context, so adding a
// section is a registry entry in sections.tsx and not a change to the editor.
import type { Api } from '@/lib/voice-agent-client';
import type { AgentDetail } from '@/lib/voice-agent';
import type { TabId } from '@/lib/voice-agent-console';
import type { FormView } from './useAgentForm';

export type TabCtx = {
  agentKey: string;
  workspaceId: number | null;
  api: Api;
  demo: boolean;
  /** An owner or admin: may hear voices, start test calls and score them. */
  admin: boolean;
  /** An admin who is not in a read-only preview: may change anything. */
  canEdit: boolean;
  detail: AgentDetail;
  form: FormView;
  /** Whether the agent has been published, so the test call has something to call. */
  published: boolean;
  /** Bumps after a publish or rollback so history, stats and calls read again. */
  epoch: number;
  goTo: (tab: TabId) => void;
  /** Open the tab a settings path lives on and focus its field. */
  jump: (path: string) => void;
  /** Open the seller or buyer a call was filed on. */
  onOpenRecord?: (kind: 'seller' | 'buyer', id: number) => void;
  /** After a rollback: read the agent again and show the result. */
  onRolledBack: () => void;
};
