'use client';

// The SMS list for one inbox (lib/inbox-owner): the threads on the owner's
// lines, read line by line (Talkr's `number_id`), plus the ones assigned to
// them on a shared line (`user_id`), as one list. Talkr gives an owner or an
// admin the whole office in a single list; this is how "My inbox" stays mine.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type ConversationDto, type ConversationListDto, type ConversationListQuery, api } from '@/lib/talkr-web/api';
import {
  type InboxOwner, type OrgLine, EVERYONE, UNASSIGNED, eventTouches, lineOwners, linesFor, mergeOwnerThreads, resolveOwner, unreadThreads,
} from '@/lib/inbox-owner';
import { eventFacts, messageFromEvent, onTalkrEvent, useTalkrEvents } from '@/lib/talkr-events';

export type InboxScope = {
  owner: InboxOwner;
  /** The signed-in rep's Talkr id; null until Talkr says who they are. */
  me: string | null;
  /** Every org line, with its owner. */
  lines: OrgLine[];
  /** "My inbox", "Diego Ortiz’s inbox". */
  title: string;
};

/** A stable string for effect deps. */
export const scopeKey = (s: InboxScope | null | undefined) => (s ? `${s.owner}|${s.me ?? ''}|${s.lines.map((l) => `${l.id}:${l.assigned_user_id ?? ''}`).join(',')}` : '');

/** Whether the inbox shown is someone else's (a teammate's, or the shared lines). */
export const viewingOther = (s: InboxScope | null | undefined) => !!s && s.owner !== 'me';

/**
 * The owner's threads for the All tab, live: re-read when the stream names
 * this inbox (its owner, one of its lines, a thread on screen), and a text
 * that arrives moves its row to the top with its words at once, before the
 * re-read lands.
 */
export function useOwnerThreads(scope: InboxScope | null, enabled: boolean, limit = 60) {
  const key = scopeKey(scope);
  const [state, setState] = useState<{ key: string; convs: ConversationDto[]; error: string | null } | null>(null);
  const scopeRef = useRef(scope);
  const convsRef = useRef<ConversationDto[]>([]);
  const fresh = state?.key === key ? state : null;
  useEffect(() => {
    scopeRef.current = scope;
    convsRef.current = fresh?.convs ?? [];
  });

  const read = useCallback(() => {
    const s = scopeRef.current;
    if (!enabled || !s || (s.owner === 'me' && !s.me)) return;
    const k = scopeKey(s);
    void loadOwnerConversations(s, { sort: 'recent' }, limit).then(
      (r) => setState({ key: k, convs: r.conversations, error: null }),
      (e: unknown) => setState((cur) => ({ key: k, convs: cur?.key === k ? cur.convs : [], error: e instanceof Error ? e.message : 'Could not load texts' })),
    );
  }, [enabled, limit]);
  useEffect(() => { read(); }, [read, key]);

  useTalkrEvents(enabled, ['message.received', 'message.updated', 'conversation.updated'], (events) => {
    const s = scopeRef.current;
    if (!s) return;
    const onScreen = new Set(convsRef.current.map((c) => c.id));
    const lines = linesFor(s.owner, s.me, s.lines);
    if (events.some((e) => eventTouches(eventFacts(e), s.owner, s.me, lines, onScreen, e.type))) read();
  });

  // A reply on a thread already listed: its row moves now.
  useEffect(() => {
    if (!enabled) return;
    return onTalkrEvent((e) => {
      if (e.type !== 'message.received') return;
      const m = messageFromEvent(e);
      if (!m || !convsRef.current.some((c) => c.id === m.conversation_id)) return;
      setState((cur) => {
        if (!cur) return cur;
        const convs = cur.convs.map((c) => (c.id === m.conversation_id
          ? { ...c, last_message_at: m.sent_at ?? m.created_at, unread_count: c.unread_count + 1, last_message: { direction: m.direction, body: m.body, media_count: m.media_urls.length, status: m.status } }
          : c));
        convs.sort((a, b) => (Date.parse(b.last_message_at ?? '') || 0) - (Date.parse(a.last_message_at ?? '') || 0));
        return { ...cur, convs };
      });
    });
  }, [enabled]);

  /** The rep read a thread here: its dot goes at once. */
  const markRead = useCallback((id: string) => {
    setState((cur) => (cur ? { ...cur, convs: cur.convs.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) } : cur));
  }, []);

  return { convs: fresh?.convs ?? [], loading: enabled && !fresh, error: fresh?.error ?? null, refresh: read, markRead };
}

export async function loadOwnerConversations(scope: InboxScope, q: ConversationListQuery, limit: number): Promise<ConversationListDto> {
  // Everyone: Talkr's own list, which is the whole office for an owner or
  // admin and the rep's own threads for anyone else (messages.read.org).
  if (scope.owner === EVERYONE) return api.listConversations({ ...q, user_id: undefined, number_id: undefined, limit, offset: undefined });
  const lines = linesFor(scope.owner, scope.me, scope.lines);
  const user = scope.owner === UNASSIGNED ? null : resolveOwner(scope.owner, scope.me);
  const base = { ...q, user_id: undefined, number_id: undefined, limit, offset: undefined };
  const reads: Promise<ConversationListDto>[] = [
    ...lines.map((l) => api.listConversations({ ...base, number_id: l.id })),
    ...(user ? [api.listConversations({ ...base, user_id: user })] : []),
  ];
  if (!reads.length) return { conversations: [], total: 0, counts: { unread: 0, by_type: {}, by_temperature: {} } };
  const settled = await Promise.allSettled(reads);
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!ok.length) throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
  const merged = mergeOwnerThreads<ConversationDto>(ok.map((r) => r.conversations), scope.owner, scope.me, lineOwners(scope.lines), q.sort ?? 'recent');
  const shown = merged.slice(0, limit);
  const by = (pick: (c: ConversationDto) => string | null) => merged.reduce<Record<string, number>>((acc, c) => {
    const k = pick(c);
    if (k) acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  // A per-line read stops at `limit`, so the total is at least what was read.
  const more = ok.some((r) => r.total > r.conversations.length);
  return {
    conversations: shown,
    total: more ? Math.max(merged.length, limit + 1) : merged.length,
    counts: { unread: unreadThreads(merged), by_type: by((c) => c.contact_type), by_temperature: by((c) => c.temperature) },
  };
}
