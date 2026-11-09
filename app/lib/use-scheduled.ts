// The workspace's pending scheduled texts (migration 367) and emails (373),
// live for the Inbox and the records: the Scheduled folder's count, the
// pending bubble in a thread, the pending rows on a record's timeline, and
// the writes (schedule, move, cancel). Null supabase (the demo) reads as none.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { everyRow } from './every-row';
import { supabase } from './supabase';
import { smsKey } from './inbox-state';
import type { OutgoingFile } from './google';

// Every page: a campaign schedules thousands at once, and a read capped at 1,000 lost the Scheduled folder's count.
const PENDING = <T,>(table: 'scheduled_messages' | 'scheduled_emails', workspaceId: number) => everyRow<T>(() => supabase!.from(table as never).select('*').eq('workspace_id' as never, workspaceId as never)
  // Pending rows and the last day's errors, so a failed send is still seen.
  .or(`status.eq.scheduled,and(status.eq.error,updated_at.gte.${new Date(Date.now() - 86_400_000).toISOString()})`)
  .order('send_at').order('id') as never);
/** A burst of row changes (a campaign placing a batch) is one re-read, not one per row. */
const RELOAD_DEBOUNCE_MS = 500;

export type ScheduledRow = {
  id: number; workspace_id: number; user_id: string; seller_id: number | null; buyer_id: number | null;
  phone: string; from_phone_number_id: string | null; body: string; media: string[]; send_at: string;
  status: 'scheduled' | 'sending' | 'sent' | 'error' | 'cancelled'; claimed_at: string | null; error: string | null;
};

export type ScheduledEmailRow = {
  id: number; workspace_id: number; user_id: string; seller_id: number | null; buyer_id: number | null;
  to: string; cc: string | null; bcc: string | null; subject: string; html: string; attachments: OutgoingFile[]; send_at: string;
  status: 'scheduled' | 'sending' | 'sent' | 'error' | 'cancelled'; claimed_at: string | null; error: string | null;
};

export type ScheduleEmailInput = {
  to: string; subject: string; html: string; sendAt: Date; cc?: string | null; bcc?: string | null;
  attachments?: OutgoingFile[]; sellerId?: number | null; buyerId?: number | null;
};

export type ScheduleInput = {
  phone: string; body: string; sendAt: Date; sellerId?: number | null; buyerId?: number | null;
  fromPhoneNumberId?: string | null; media?: string[];
};

let channelSeq = 0;

export function useScheduled(workspaceId: number | null) {
  const [loaded, setRows] = useState<ScheduledRow[]>([]);
  const [loadedMail, setMail] = useState<ScheduledEmailRow[]>([]);
  const rows = useMemo(() => (workspaceId ? loaded : []), [workspaceId, loaded]);
  const emails = useMemo(() => (workspaceId ? loadedMail : []), [workspaceId, loadedMail]);
  // The newest read wins: an older workspace's answer arriving late is dropped.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!supabase || !workspaceId) return;
    const mine = ++seq.current;
    const [texts, mail] = await Promise.all([
      PENDING<ScheduledRow>('scheduled_messages', workspaceId).catch(() => [] as ScheduledRow[]),
      // Before migration 373 the table is missing: no emails, and no error in the console every minute.
      PENDING<ScheduledEmailRow>('scheduled_emails', workspaceId).catch(() => [] as ScheduledEmailRow[]),
    ]);
    if (mine !== seq.current) return;
    setRows(texts);
    setMail(mail);
  }, [workspaceId]);
  useEffect(() => {
    if (!supabase || !workspaceId) return;
    const first = setTimeout(() => void load(), 0);
    let later: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (later) clearTimeout(later);
      later = setTimeout(() => { later = null; void load(); }, RELOAD_DEBOUNCE_MS);
    };
    // One channel per mount: supabase.channel() hands back an existing channel of
    // the same name, and a record mounts this hook from several composers at
    // once; adding listeners to a channel already subscribed throws.
    const ch = supabase.channel(`scheduled:${workspaceId}:${++channelSeq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scheduled_messages', filter: `workspace_id=eq.${workspaceId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scheduled_emails', filter: `workspace_id=eq.${workspaceId}` }, reload)
      .subscribe();
    return () => { clearTimeout(first); if (later) clearTimeout(later); void supabase?.removeChannel(ch); };
  }, [workspaceId, load]);

  /** Pending rows by thread key (smsKey of the counterpart's number). */
  const byThread = useMemo(() => {
    const m = new Map<string, ScheduledRow[]>();
    for (const r of rows) { const k = smsKey(r.phone); m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  }, [rows]);

  const schedule = useCallback(async (input: ScheduleInput): Promise<string | null> => {
    if (!supabase || !workspaceId) return 'Not signed in to a workspace.';
    const { error } = await supabase.from('scheduled_messages' as never).insert({
      workspace_id: workspaceId, phone: input.phone, body: input.body, send_at: input.sendAt.toISOString(),
      seller_id: input.sellerId ?? null, buyer_id: input.buyerId ?? null, from_phone_number_id: input.fromPhoneNumberId ?? null, media: input.media ?? [],
    } as never);
    if (error) return error.message;
    await load();
    return null;
  }, [workspaceId, load]);

  const move = useCallback(async (id: number, sendAt: Date, body?: string): Promise<string | null> => {
    if (!supabase) return 'Not signed in.';
    const { error } = await supabase.from('scheduled_messages' as never)
      .update({ send_at: sendAt.toISOString(), status: 'scheduled', claimed_at: null, error: null, ...(body !== undefined ? { body } : {}), updated_at: new Date().toISOString() } as never).eq('id' as never, id as never);
    if (error) return error.message;
    await load();
    return null;
  }, [load]);

  const cancel = useCallback(async (id: number, table: 'scheduled_messages' | 'scheduled_emails' = 'scheduled_messages'): Promise<string | null> => {
    if (!supabase) return 'Not signed in.';
    const { error } = await supabase.from(table as never).update({ status: 'cancelled', updated_at: new Date().toISOString() } as never).eq('id' as never, id as never);
    if (error) return error.message;
    await load();
    return null;
  }, [load]);

  /** Pending emails by the lower-cased address they go to (the Inbox's mail threads key on the counterpart). */
  const byEmail = useMemo(() => {
    const m = new Map<string, ScheduledEmailRow[]>();
    for (const r of emails) { const k = r.to.trim().toLowerCase(); m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  }, [emails]);

  const scheduleEmail = useCallback(async (input: ScheduleEmailInput): Promise<string | null> => {
    if (!supabase || !workspaceId) return 'Not signed in to a workspace.';
    const { error } = await supabase.from('scheduled_emails' as never).insert({
      workspace_id: workspaceId, to: input.to, cc: input.cc || null, bcc: input.bcc || null, subject: input.subject, html: input.html,
      attachments: input.attachments ?? [], send_at: input.sendAt.toISOString(), seller_id: input.sellerId ?? null, buyer_id: input.buyerId ?? null,
    } as never);
    if (error) return /scheduled_emails/.test(error.message) ? 'Email scheduling needs migration 373 applied first.' : error.message;
    await load();
    return null;
  }, [workspaceId, load]);

  return { rows, emails, byThread, byEmail, schedule, scheduleEmail, move, cancel, refresh: load };
}

export type Scheduled = ReturnType<typeof useScheduled>;
