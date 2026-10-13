// Suggested record updates from a text thread ("can you come Tuesday at 3?" →
// book it). Asks once per last message; the caller passes the recent lines.
'use client';

import React, { useEffect, useState } from 'react';
import { type SmsLine, type Suggestion, suggestForSms } from '@/lib/record-suggest';
import { SuggestionList } from './CallInsight';

export function SmsSuggestions({ workspaceId, sellerId, messages, me, canWrite = true, onToast, onChanged }: {
  workspaceId: number;
  sellerId: number;
  /** The last N messages of the thread, oldest first. */
  messages: SmsLine[];
  me: string | null;
  canWrite?: boolean;
  onToast?: (msg: string) => void;
  onChanged?: () => void;
}) {
  const last = messages[messages.length - 1];
  const key = last ? `${messages.length}:${last.at}` : '';
  // The answer remembers which thread state it was for; a newer message means it is loading again.
  const [res, setRes] = useState<{ key: string; error: string | null; items: Suggestion[] | null }>({ key: '', error: null, items: null });

  useEffect(() => {
    if (!key) return;
    let alive = true;
    suggestForSms(workspaceId, sellerId, messages).then((r) => {
      if (alive) setRes(r.ok ? { key, error: null, items: r.suggestions } : { key, error: r.message, items: null });
    });
    return () => { alive = false; };
    // ponytail: keyed on the last message only; a thread edited in place is not re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId, sellerId]);

  const state = res.key === key ? { loading: false, ...res } : { loading: true, error: null, items: null };
  if (!key || (state.items && !state.items.length)) return null;
  return (
    <div style={{ padding: '8px 10px', borderTop: '1px solid #e4e4e7', background: '#fafafa' }}>
      <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, marginBottom: '6px' }}>Suggested updates</div>
      <SuggestionList workspaceId={workspaceId} sellerId={sellerId} me={me} canWrite={canWrite} key={key} state={state} onToast={onToast} onChanged={onChanged} />
    </div>
  );
}
