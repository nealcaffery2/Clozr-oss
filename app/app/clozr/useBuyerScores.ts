'use client';

// The Buyers screen's AI scores: load the cache once, fill in stale rows as
// they come on screen, and a Refresh that re-scores on demand. Auto-scoring is
// capped per visit so scrolling a long list cannot run up the model bill.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type BuyerAiScore, isStale, loadBuyerScores, refreshBuyerScores } from '@/lib/buyer-ai-score';

const AUTO_PER_VISIT = 40;

type Toast = (msg: string, tone?: 'success' | 'error' | 'info') => void;

export function useBuyerScores(workspaceId: number | null, visibleDbIds: number[], toast: Toast) {
  const [scores, setScores] = useState<Map<number, BuyerAiScore>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const tried = useRef(new Set<number>());
  const warned = useRef(false);
  const running = useRef(false);

  useEffect(() => {
    let live = true;
    void loadBuyerScores(workspaceId).then((m) => {
      if (!live) return;
      setScores(m);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [workspaceId]);

  const merge = (m: Map<number, BuyerAiScore>) => setScores((cur) => {
    const next = new Map(cur);
    for (const [k, v] of m) next.set(k, v);
    return next;
  });

  const visibleKey = visibleDbIds.join(',');
  useEffect(() => {
    if (workspaceId == null || !loaded || running.current) return;
    const due = visibleKey.split(',').map(Number)
      .filter((id) => id > 0 && !tried.current.has(id) && isStale(scores.get(id)))
      .slice(0, Math.max(0, AUTO_PER_VISIT - tried.current.size));
    if (!due.length) return;
    for (const id of due) tried.current.add(id);
    running.current = true;
    void refreshBuyerScores(workspaceId, due).then((r) => {
      running.current = false;
      merge(r.scores);
      // Say once why scores are reply-based (no key, no function, no table), then stay quiet.
      if (r.message && !warned.current) { warned.current = true; toast(r.message, r.ok ? 'info' : 'error'); }
    });
  }, [workspaceId, loaded, visibleKey, scores, toast]);

  const refresh = useCallback((dbIds: number[]) => {
    if (workspaceId == null) return toast('Sign in to score buyers.');
    if (!dbIds.length || running.current) return;
    running.current = true;
    setProgress({ done: 0, total: dbIds.length });
    void refreshBuyerScores(workspaceId, dbIds, true, (done, total) => setProgress({ done, total })).then((r) => {
      running.current = false;
      setProgress(null);
      merge(r.scores);
      if (!r.ok) return toast(r.message || 'Scoring failed.', 'error');
      toast(`${r.scores.size} buyer${r.scores.size === 1 ? '' : 's'} rescored${r.message ? `. ${r.message}` : ''}`, r.message ? 'info' : 'success');
    });
  }, [workspaceId, toast]);

  return { scores, refresh, progress };
}
