// Talkr's event stream, opened once and shared.
//
// useTalkrPhone holds the one EventSource a signed-in tab keeps to Talkr and
// publishes every event here. The Inbox's All and SMS tabs listen to this
// instead of opening their own streams (each was a second and third socket,
// each with its own 20-second poll behind it).
//
// `eventFacts` reads who and what an event is about, so a listener can tell
// a text to this rep from a teammate's call without refetching to find out.

'use client';

import { useEffect, useRef } from 'react';

export type TalkrEvent = { type: string; data: Record<string, unknown> | null };

/** The events the stream carries that the CRM acts on. */
export const TALKR_EVENT_TYPES = [
  'message.received', 'message.updated', 'conversation.updated', 'call.updated', 'voicemail.left',
] as const;

const listeners = new Set<(e: TalkrEvent) => void>();

/** Parses one stream event, hands it to every listener, and returns it. */
export function publishTalkrEvent(type: string, raw: unknown): TalkrEvent {
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    /* an unreadable body still says something happened */
  }
  const e = { type, data };
  for (const fn of [...listeners]) fn(e);
  return e;
}

export function onTalkrEvent(fn: (e: TalkrEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export type EventFacts = {
  userIds: string[];
  conversationId: string | null;
  callId: string | null;
  sessionId: string | null;
  /** Last ten digits of every phone number the event names. */
  numbers: string[];
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const digits10 = (v: unknown) => {
  const d = typeof v === 'string' ? v.replace(/\D/g, '') : '';
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Who and what an event names: Talkr puts the ids either on the event or under `data`. */
export function eventFacts(e: TalkrEvent): EventFacts {
  const top = e.data ?? {};
  const inner = (top.data && typeof top.data === 'object' ? top.data : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(inner[k]) ?? str(top[k]);
      if (v) return v;
    }
    return null;
  };
  const userIds = ['userId', 'assignedUserId', 'user_id', 'assigned_user_id']
    .flatMap((k) => [str(inner[k]), str(top[k])])
    .filter((v): v is string => !!v);
  const numbers = ['to', 'from', 'toNumber', 'fromNumber', 'to_number', 'from_number', 'ourNumber', 'our_number', 'theirNumber', 'their_number']
    .flatMap((k) => [digits10(inner[k]), digits10(top[k])])
    .filter((v): v is string => !!v);
  return {
    userIds: [...new Set(userIds)],
    conversationId: pick('conversationId', 'conversation_id'),
    callId: pick('callId', 'call_id'),
    sessionId: pick('sessionId', 'session_id', 'dialSessionId'),
    numbers: [...new Set(numbers)],
  };
}

/**
 * Listen to the shared stream while mounted. `onEvents` runs once a burst of
 * the given types has gone quiet for `debounceMs`, with every event in it, so
 * sent, delivered and read on one text are one refetch.
 */
export function useTalkrEvents(
  enabled: boolean,
  types: readonly string[],
  onEvents: (events: TalkrEvent[]) => void,
  debounceMs = 400,
): void {
  const fn = useRef(onEvents);
  useEffect(() => { fn.current = onEvents; }, [onEvents]);
  const key = types.join(',');
  useEffect(() => {
    if (!enabled) return;
    const want = new Set(key.split(','));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let burst: TalkrEvent[] = [];
    const stop = onTalkrEvent((e) => {
      if (!want.has(e.type)) return;
      burst.push(e);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const events = burst;
        burst = [];
        fn.current(events);
      }, debounceMs);
    });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [enabled, key, debounceMs]);
}
