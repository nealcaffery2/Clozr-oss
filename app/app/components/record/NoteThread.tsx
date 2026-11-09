'use client';

// Under a note in the activity stream: emoji reactions (one per user per
// emoji, click to toggle) and replies, nested under the note in time order
// (migration 410). Loads when the note scrolls near, like CallInsight.

import React, { useEffect, useRef, useState } from 'react';
import { MessageSquareReply, SmilePlus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { relative } from '@/lib/crm';
import type { NoteReaction, NoteReply } from '@/lib/database.types';
import { useNearView } from './CallInsight';

const QUICK = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🙏'];
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '4px', height: '24px', padding: '0 8px', borderRadius: '999px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)' };

/** The first emoji in what was typed (Win+. or the phone's keyboard), or null. */
export function firstEmoji(text: string): string | null {
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())) {
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ? segment : null;
  }
  return null;
}

function fetchThread(communicationId: number) {
  return Promise.all([
    supabase!.from('note_reactions').select('*').eq('communication_id', communicationId).order('created_at'),
    supabase!.from('note_replies').select('*').eq('communication_id', communicationId).order('created_at'),
  ]);
}

export function NoteThread({ communicationId, workspaceId, me, canWrite, nameOf }: {
  communicationId: number; workspaceId: number; me: string | null; canWrite: boolean; nameOf: (userId: string) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useNearView(ref);
  const [reactions, setReactions] = useState<NoteReaction[]>([]);
  const [replies, setReplies] = useState<NoteReply[]>([]);
  const [picker, setPicker] = useState(false);
  const [typed, setTyped] = useState('');
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const apply = ([r, p]: Awaited<ReturnType<typeof fetchThread>>) => {
    if (r.data) setReactions(r.data);
    if (p.data) setReplies(p.data);
  };
  const load = () => fetchThread(communicationId).then(apply);
  useEffect(() => {
    if (!near) return;
    let on = true;
    void fetchThread(communicationId).then((x) => { if (on) apply(x); });
    return () => { on = false; };
  }, [near, communicationId]);

  const write = canWrite && !!me && !!supabase;
  const toggle = async (emoji: string) => {
    setPicker(false); setTyped('');
    if (!write) return;
    const mine = reactions.find((r) => r.emoji === emoji && r.user_id === me);
    // Shown at once; a failed write re-reads what is really there.
    setReactions((rs) => (mine ? rs.filter((r) => r !== mine)
      : [...rs, { id: -Date.now(), workspace_id: workspaceId, communication_id: communicationId, user_id: me!, emoji, created_at: new Date().toISOString() }]));
    const { error } = mine
      ? await supabase!.from('note_reactions').delete().eq('id', mine.id)
      : await supabase!.from('note_reactions').insert({ workspace_id: workspaceId, communication_id: communicationId, emoji });
    if (error) setErr('Could not save that reaction.');
    void load();
  };
  const sendReply = async () => {
    const body = draft.trim();
    if (!write || !body || busy) return;
    setBusy(true); setErr('');
    const { error } = await supabase!.from('note_replies').insert({ workspace_id: workspaceId, communication_id: communicationId, body });
    setBusy(false);
    if (error) { setErr('Could not post the reply.'); return; }
    setDraft(''); setReplying(false);
    void load();
  };
  const removeReply = async (id: number) => {
    const { error } = await supabase!.from('note_replies').delete().eq('id', id);
    if (error) setErr('Could not delete the reply.');
    void load();
  };

  // One chip per emoji, in the order each was first used.
  const groups = [...new Set(reactions.map((r) => r.emoji))].map((emoji) => {
    const who = reactions.filter((r) => r.emoji === emoji);
    return { emoji, count: who.length, mine: who.some((r) => r.user_id === me), names: who.map((r) => (r.user_id === me ? 'You' : nameOf(r.user_id))).join(', ') };
  });
  const typedEmoji = firstEmoji(typed);

  return (
    <div ref={ref} data-testid="note-thread" style={{ marginTop: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {groups.map((g) => (
          <button key={g.emoji} type="button" className="dc2 rec-press" onClick={() => void toggle(g.emoji)} disabled={!write}
            title={g.names} aria-pressed={g.mine} aria-label={`${g.emoji} ${g.count}: ${g.names}`}
            style={{ ...chip, border: `1px solid ${g.mine ? 'rgba(10, 133, 96,.45)' : LINE}`, background: g.mine ? 'var(--c-action-soft, #e7f5ef)' : 'var(--surface, #fff)', color: g.mine ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontWeight: g.mine ? 600 : 500 }}>
            <span style={{ fontSize: '13px' }}>{g.emoji}</span>{g.count}
          </button>
        ))}
        {write ? (
          <>
            <button type="button" className="dc2 rec-press tl-act" onClick={() => setPicker((o) => !o)} aria-label="Add reaction" aria-expanded={picker} title="Add reaction">
              <SmilePlus size={13} aria-hidden />
            </button>
            <button type="button" className="dc2 rec-press tl-act" onClick={() => setReplying((o) => !o)} aria-expanded={replying}>
              <MessageSquareReply size={13} aria-hidden />Reply{replies.length ? ` · ${replies.length}` : ''}
            </button>
          </>
        ) : null}
      </div>
      {/* In the flow, not a popover: .clozr-tl's content-visibility clips anything that overflows the entry (2026-10-23). */}
      {picker ? (
            <div role="dialog" aria-label="Pick a reaction" style={{ marginTop: '6px', width: 'fit-content', maxWidth: '100%', padding: '6px', background: 'var(--c-menu-bg)', border: '1px solid var(--c-menu-line)', borderRadius: '12px', boxShadow: 'var(--shadow-md)', display: 'grid', gap: '6px' }}
              onKeyDown={(e) => { if (e.key === 'Escape') setPicker(false); }}>
              <div style={{ display: 'flex', gap: '2px' }}>
                {QUICK.map((e) => (
                  <button key={e} type="button" className="dc2 rec-press" onClick={() => void toggle(e)} aria-label={'React ' + e}
                    style={{ width: '32px', height: '32px', border: 0, borderRadius: '8px', background: 'none', fontSize: '18px', cursor: 'pointer' }}>{e}</button>
                ))}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); if (typedEmoji) void toggle(typedEmoji); }} style={{ display: 'flex', gap: '6px' }}>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Any emoji" placeholder="Any emoji (Win + .)"
                  style={{ flex: 1, minWidth: 0, height: '28px', padding: '0 8px', border: `1px solid ${LINE}`, borderRadius: '7px', fontSize: '13px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' }} />
                <button type="submit" className="dc2 rec-press" disabled={!typedEmoji}
                  style={{ ...chip, borderRadius: '7px', height: '28px', border: 0, background: typedEmoji ? '#0A8560' : LINE, color: '#fff', fontWeight: 600 }}>Add</button>
              </form>
            </div>
      ) : null}
      {replies.length || replying ? (
        <div style={{ marginTop: '8px', paddingLeft: '12px', borderLeft: `2px solid ${LINE}`, display: 'grid', gap: '8px' }}>
          {replies.map((r) => (
            <div key={r.id} data-testid="note-reply">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span style={{ fontWeight: 600, color: 'var(--ink-2, #27272a)' }}>{nameOf(r.user_id)}</span>
                <span style={{ color: MUTED }} title={new Date(r.created_at).toLocaleString()}>{relative(r.created_at)}</span>
                {r.user_id === me && write ? (
                  <button type="button" className="dc2" onClick={() => void removeReply(r.id)} style={{ border: 0, background: 'none', padding: 0, fontSize: '11.5px', color: MUTED, cursor: 'pointer' }}>Delete</button>
                ) : null}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--ink-2, #27272a)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.body}</div>
            </div>
          ))}
          {replying ? (
            <div style={{ display: 'grid', gap: '6px' }}>
              <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} aria-label="Reply to this note" placeholder="Reply…"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void sendReply(); }
                  if (e.key === 'Escape') setReplying(false);
                }}
                style={{ width: '100%', padding: '8px 10px', border: `1px solid ${LINE}`, borderRadius: '8px', resize: 'vertical', fontSize: '13px', lineHeight: 1.5, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', outline: 0 }} />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button type="button" className="dc3" onClick={() => void sendReply()} disabled={busy || !draft.trim()}
                  style={{ ...chip, borderRadius: '7px', height: '26px', border: 0, background: draft.trim() ? '#0A8560' : LINE, color: '#fff', fontWeight: 600 }}>{busy ? 'Posting…' : 'Reply'}</button>
                <button type="button" className="dc2" onClick={() => { setReplying(false); setDraft(''); }}
                  style={{ ...chip, borderRadius: '7px', height: '26px', border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: 'var(--ink-2, #27272a)' }}>Cancel</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {err ? <div role="alert" style={{ marginTop: '6px', fontSize: '12px', color: '#b91c1c' }}>{err}</div> : null}
    </div>
  );
}
