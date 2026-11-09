'use client';

// "Suggested" at the top of the inbox templates rail: up to three replies the
// reply-suggest function picks for this thread and the lead's stage, a saved
// template when one fits, else a written reply. Read once per thread and last
// message; clicking one puts it in the composer, nothing is sent from here.

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type SuggestMessage = { direction: 'inbound' | 'outbound'; body: string; created_at: string };
export type SuggestTemplate = { id: string; name: string; body: string };
type Suggestion = { template_id: string | null; body: string; why: string };

const cache = new Map<string, Suggestion[]>();

export function SuggestedReplies({ workspaceId, threadKey, messages, templates, lead, onUse }: {
  workspaceId: number | null;
  /** The conversation id; the cache key adds the newest message. */
  threadKey: string | null;
  messages: SuggestMessage[];
  templates: SuggestTemplate[];
  lead: { kind: string; stage: string; name: string } | null;
  onUse: (body: string, templateId: string | null) => void;
}) {
  const last = messages[messages.length - 1];
  const key = threadKey && last ? `${workspaceId}|${threadKey}|${last.created_at}|${templates.length}` : null;
  const [state, setState] = useState<{ key: string; list: Suggestion[] | null; error: string | null } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!key || workspaceId == null || !supabase) return;
    if (cache.has(key)) return;
    let alive = true;
    // A short wait so flicking through threads does not ask for each one.
    const timer = setTimeout(() => {
      setState({ key, list: null, error: null });
      void supabase!.functions.invoke('reply-suggest', { body: {
        workspace_id: workspaceId, kind: lead?.kind ?? null, stage: lead?.stage ?? null, name: lead?.name ?? null,
        messages: messages.slice(-20).map((m) => ({ direction: m.direction, body: m.body, at: m.created_at })),
        templates: templates.slice(0, 60),
      } }).then(({ data, error }) => {
        if (!alive) return;
        const list = (data as { suggestions?: Suggestion[] } | null)?.suggestions;
        if (error || !Array.isArray(list)) { setState({ key, list: [], error: 'Suggestions are not available right now.' }); return; }
        cache.set(key, list);
        setState({ key, list, error: null });
      });
    }, 600);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key carries the thread, its newest message and the template count
  }, [key, workspaceId, retry]);

  if (!key) return null;
  const hit = cache.get(key);
  const cur = hit ? { list: hit, error: null } : state?.key === key ? state : null;
  const names = new Map(templates.map((t) => [t.id, t.name]));
  return (
    <section aria-label="Suggested replies" aria-busy={!cur || cur.list == null} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ font: '600 11px/1 var(--sans)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Suggested</span>
        <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>From this thread{lead?.stage ? ` and ${lead.stage}` : ''}</span>
      </div>
      {!cur || cur.list == null ? (
        <div role="status" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>Reading the thread…</div>
      ) : cur.error ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>
          {cur.error}
          <button type="button" onClick={() => { if (key) cache.delete(key); setRetry((n) => n + 1); }}
            style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', font: '600 12px/1 var(--sans)', color: 'var(--ink)' }}>Try again</button>
        </div>
      ) : !cur.list.length ? (
        <div style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>Nothing to suggest for this thread.</div>
      ) : cur.list.map((s, i) => (
        <button key={i} type="button" onClick={() => onUse(s.body, s.template_id)}
          style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 12px', borderRadius: '12px', cursor: 'pointer',
            border: '1px solid var(--line, var(--divider, #e4e4e7))', background: 'var(--surface, #fff)', color: 'var(--ink)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', font: '600 12px/1.2 var(--sans)' }}>
            {s.template_id ? names.get(s.template_id) ?? 'Template' : 'Written for this thread'}
            <span style={{ marginLeft: 'auto', font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>{s.template_id ? 'template' : 'AI'}</span>
          </span>
          <span style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--ink-2, var(--ink))', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.body}</span>
          {s.why ? <span style={{ font: '400 11px/1.3 var(--sans)', color: 'var(--muted)' }}>{s.why}</span> : null}
        </button>
      ))}
    </section>
  );
}
