'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Audience, type Channel, type MessageTemplate, listTemplates } from '@/lib/message-templates';
import { type Teammate, listTeam } from '@/lib/team';
import { tcTemplateRows } from '@/lib/tc-templates';

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
    // Names the house facts, so the demo shows the blank-field notice on a house with none on file.
    id: -5, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'email', audience: 'seller',
    category: 'follow-up', name: 'Property recap', subject: 'What we have on {{address}}',
    body_text: 'Hi {{first_name}},\n\nHere is what we have on {{address}}: {{beds}} bd / {{baths}} ba, {{sqft}} sqft, built {{year_built}}. Reply if any of it is off and I will fix our numbers.\n\n{{rep_name}}',
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
  {
    // Deleted, so the demo's Templates has one row under Show archived.
    id: -6, workspace_id: 0, owner_id: 'demo', shared: true, channel: 'sms', audience: 'seller',
    category: 'follow-up', name: 'Old voicemail follow-up', subject: null,
    body_text: 'Hi {{first_name}}, left you a voicemail about {{address}}. Call or text back when you get a minute.',
    body_html: null, blocks: null, merge_fields: [], archived_at: '2026-10-20T15:00:00Z',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-20T15:00:00Z',
  },
  // The transaction coordinator's set (migration 401 loads the same into Acme Homes).
  ...tcTemplateRows().map((t, i): MessageTemplate => ({
    ...t, id: -100 - i, workspace_id: 0, owner_id: 'demo', shared: true, archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  })),
];

/** The workspace's templates this member can see, and the roster the Owner filter names. */
export function useTemplates(workspaceId: number | null) {
  // Every row, archived ones too; `templates` is the live ones, `archived` the deleted (Templates, Show archived).
  const [rows, setTemplates] = useState<MessageTemplate[]>(workspaceId ? [] : DEMO_TEMPLATES);
  const templates = useMemo(() => rows.filter((t) => !t.archived_at), [rows]);
  const archived = useMemo(() => rows.filter((t) => !!t.archived_at), [rows]);
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

  return { templates, archived, team, error, loading, reload };
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
