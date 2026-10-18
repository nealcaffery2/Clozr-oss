'use client';

// The body on the row is the document the Gmail sync already stored. Opening
// a message renders that. A row that still holds only the plain part (synced
// before HTML was kept, or larger than the sync will store) asks Gmail once
// and writes the HTML back, so the next open does not wait on that.

import { useEffect, useMemo, useState } from 'react';
import { cachedEmailHtml, emailHtmlCached, storeEmailHtml } from '@/lib/email-document-cache';
import { emailPlain, looksLikeHtml } from '@/lib/email-html';
import { emailHtml } from '@/lib/google';

export function useEmailDocument(body: string | null | undefined, opts?: { workspaceId?: number | null; communicationId?: number | null }) {
  const stored = String(body ?? '');
  // A stored body runs to tens of kilobytes; the feed redraws far more often than it changes.
  const storedHtml = useMemo(() => (looksLikeHtml(stored) ? stored : null), [stored]);
  const id = opts?.communicationId ?? null;
  const workspaceId = opts?.workspaceId ?? null;
  const cached = id != null ? cachedEmailHtml(id) : undefined;
  const [fetched, setFetched] = useState<{ id: number; html: string | null } | null>(null);
  const fetchedHtml = fetched && fetched.id === id ? fetched.html : null;
  const html = storedHtml ?? fetchedHtml ?? (cached === undefined ? null : cached);

  useEffect(() => {
    if (storedHtml || !workspaceId || id == null) return;
    if (emailHtmlCached(id)) return;
    let cancel = false;
    void emailHtml(workspaceId, id).then((r) => {
      const next = r.ok && r.data.html && looksLikeHtml(r.data.html) ? r.data.html : null;
      storeEmailHtml(id, next);
      if (!cancel) setFetched({ id, html: next });
    });
    return () => { cancel = true; };
  }, [storedHtml, workspaceId, id]);

  const text = useMemo(() => (html ? emailPlain(html) : stored), [html, stored]);
  return {
    html,
    text,
    loading: !html && !!workspaceId && id != null && !storedHtml && !(id != null && emailHtmlCached(id)),
  };
}
