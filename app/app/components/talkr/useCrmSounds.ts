// The CLOZR side of the notification sounds: an @mention landing in the bell,
// and a task assigned to you coming due. (Texts, voicemail and missed calls
// arrive through Talkr — app/clozr/useTalkrPhone.ts and lib/softphone.ts.)
//
// Also binds lib/phone-audio.ts to the signed-in user and unlocks Web Audio on
// the first gesture, so a ring that arrives later is actually heard.
'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { everyWhileVisible } from '@/lib/visible-timer';
import { armNotificationAsk, installAudioUnlock, playEvent, setAudioUser } from '@/lib/phone-audio';

/** How far ahead due tasks are armed; re-armed on every task change and every half hour. */
const HORIZON_MS = 12 * 3600_000;

export function useCrmSounds(workspaceId: number | null, userId: string | null): void {
  useEffect(() => installAudioUnlock(), []);
  useEffect(() => armNotificationAsk(), []);
  useEffect(() => setAudioUser(userId), [userId]);

  useEffect(() => {
    const db = supabase;
    if (!db || !workspaceId || !userId) return;
    let live = true;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const arm = async () => {
      const now = Date.now();
      const { data } = await db
        .from('tasks')
        .select('id,due_at')
        .eq('workspace_id', workspaceId)
        .eq('assigned_to', userId)
        .eq('done', false)
        .gt('due_at', new Date(now).toISOString())
        .lt('due_at', new Date(now + HORIZON_MS).toISOString());
      if (!live) return;
      timers.forEach(clearTimeout);
      timers = (data ?? []).map((t) => setTimeout(() => playEvent('task'), Date.parse(t.due_at as string) - Date.now()));
    };
    const rearm = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void arm(), 500);
    };

    void arm();
    const stop = everyWhileVisible(() => { if (!document.hidden) rearm(); }, 30 * 60_000);
    // `notifications` joins the realtime publication in migration 56; until it
    // is applied only the task half of this channel delivers.
    const ch = db
      .channel(`sounds:${workspaceId}:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `workspace_id=eq.${workspaceId}` }, (m) => {
        const n = m.new as { user_id?: string | null; category?: string };
        if (n.user_id === userId && n.category === 'Mention') playEvent('mention');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspaceId}` }, rearm)
      .subscribe();

    return () => {
      live = false;
      timers.forEach(clearTimeout);
      if (debounce) clearTimeout(debounce);
      stop();
      void db.removeChannel(ch);
    };
  }, [workspaceId, userId]);
}
