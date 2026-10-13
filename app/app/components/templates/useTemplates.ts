'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Audience, type Channel, type MessageTemplate, listTemplates } from '@/lib/message-templates';
import { type Teammate, listTeam } from '@/lib/team';

/** Sample templates for the demo (no workspace), so the composer picker is real. */
const DEMO_TEMPLATES: MessageTemplate[] = [
  {
    id: -1, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'sms', audience: 'seller',
    category: 'follow-up', name: 'Day-2 follow-up', subject: null,
    body_text: 'Hi {{first_name}}, following up on {{address}}. Do you have 5 minutes today?',
    body_html: null, blocks: null, merge_fields: [], archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: -2, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'sms', audience: 'seller',
    category: 'offer', name: 'Offer on the way', subject: null,
    body_text: 'Hi {{first_name}} — written offer for {{address}} is on its way. Any questions, text me here.',
    body_html: null, blocks: null, merge_fields: [], archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: -3, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'email', audience: 'seller',
    category: 'follow-up', name: 'Seller follow-up', subject: 'Quick follow-up on {{address}}',
    body_text: 'Hi {{first_name}},\n\nJust circling back on {{address}}. Happy to work around your timeline — when is a good time to talk?\n\n{{rep_name}}',
    body_html: null, blocks: null, merge_fields: [], archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: -4, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'sms', audience: 'buyer',
    category: 'dispo', name: 'New deal ping', subject: null,
    body_text: 'Hi {{first_name}} — new {{city}} deal that fits your box. Want the report?',
    body_html: null, blocks: null, merge_fields: [], archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
];

/** The workspace's templates this member can see, and the roster the Owner filter names. */
export function useTemplates(workspaceId: number | null) {
  const [templates, setTemplates] = useState<MessageTemplate[]>(workspaceId ? [] : DEMO_TEMPLATES);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [wsSnap, setWsSnap] = useState(workspaceId);
  if (workspaceId !== wsSnap) {
    setWsSnap(workspaceId);
    if (!workspaceId) {
      setTemplates(DEMO_TEMPLATES);
      setTeam([]);
      setError(null);
      setLoading(false);
    } else {
      setTemplates([]);
      setError(null);
      setLoading(true);
    }
  }

  const fetchAll = useCallback(() => {
    if (!workspaceId) {
      setTemplates(DEMO_TEMPLATES);
      setError(null);
      setLoading(false);
      return;
    }
    void listTeam(workspaceId).then(setTeam);
    void listTemplates(workspaceId).then((r) => {
      if (r.ok) { setTemplates(r.data); setError(null); } else setError(r.message);
      setLoading(false);
    });
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    void listTeam(workspaceId).then(setTeam);
    void listTemplates(workspaceId).then((r) => {
      if (r.ok) { setTemplates(r.data); setError(null); } else setError(r.message);
      setLoading(false);
    });
  }, [workspaceId]);
  const reload = useCallback(() => { setLoading(true); fetchAll(); }, [fetchAll]);

  return { templates, team, error, loading, reload };
}

export type TemplateFilter = { channel: Channel | 'any'; audience: Audience | 'any'; owner: string; q: string };

/** owner: 'any' | 'me' | 'shared' | a teammate's user id. */
export function filterTemplates(list: MessageTemplate[], f: TemplateFilter, userId: string | null): MessageTemplate[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((t) =>
    (f.channel === 'any' || t.channel === f.channel)
    && (f.audience === 'any' || t.audience === f.audience)
    && (f.owner === 'any' || (f.owner === 'me' ? t.owner_id === userId : f.owner === 'shared' ? t.shared : t.owner_id === f.owner))
    && (!q || [t.name, t.category, t.subject, t.body_text].some((v) => v?.toLowerCase().includes(q))));
}
