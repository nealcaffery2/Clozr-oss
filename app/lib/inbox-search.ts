// Message-content search for the Inbox (migration 367, `inbox_search`): the
// threads whose texts mention a phrase, by thread key, with how many texts
// matched and one snippet with the words marked. Debounced; a two-letter
// query or the demo searches nothing.

import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { smsKey } from './inbox-state';

export type SearchHit = { hits: number; snippet: string; lastAt: string };

const NONE: ReadonlyMap<string, SearchHit> = new Map();

export function useMessageSearch(workspaceId: number | null, q: string, includeCampaign: boolean) {
  // The last answer and what it answered; "searching" is the gap between the two.
  const [got, setGot] = useState<{ key: string; hits: ReadonlyMap<string, SearchHit>; error: string | null }>({ key: '', hits: NONE, error: null });
  const term = q.trim();
  const active = !!supabase && !!workspaceId && term.length >= 2;
  const key = active ? `${workspaceId}|${includeCampaign}|${term}` : '';
  useEffect(() => {
    if (!active) return;
    let live = true;
    const t = setTimeout(async () => {
      const { data, error } = await supabase!.rpc('inbox_search' as never, { p_ws: workspaceId, p_q: term, p_campaign: includeCampaign, p_limit: 200 } as never);
      if (!live) return;
      if (error) { setGot({ key, hits: NONE, error: error.message }); return; }
      const m = new Map<string, SearchHit>();
      for (const r of (data ?? []) as { phone: string; hits: number; last_at: string; snippet: string }[]) {
        m.set(smsKey(r.phone), { hits: r.hits, snippet: escapeButMark(r.snippet), lastAt: r.last_at });
      }
      setGot({ key, hits: m, error: null });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [active, key, workspaceId, term, includeCampaign]);
  const current = active && got.key === key;
  return { hits: current ? got.hits : NONE, searching: active && !current, error: current ? got.error : null };
}

/** The snippet is a seller's words: everything is escaped except the <mark> pairs ts_headline put in. */
export function escapeButMark(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    .replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}
