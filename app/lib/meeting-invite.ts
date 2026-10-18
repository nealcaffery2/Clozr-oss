// Meeting invites from the browser's side: the workspace's meeting types, the
// quick time slots, and the call to the meeting-invite edge function. The
// copy itself is rendered by the same pure module the function sends with
// (supabase/functions/_shared/meeting-invite.ts).

import { supabase } from './supabase';
import { toE164 } from './talkr';
import { zoneForNumber } from './talkr-web/time';
import { DEFAULT_MEETING_TYPES, type MeetingType } from '@/supabase/functions/_shared/meeting-invite';

export { DEFAULT_MEETING_TYPES, type MeetingType };
export { bookingMessage, bookingUrlFor, formatWhen, inviteSms, meetingTitle, pickZone } from '@/supabase/functions/_shared/meeting-invite';

/** The workspace's active types, sorted; the five defaults when the table is empty or not there yet. */
export async function loadMeetingTypes(workspaceId: number | null): Promise<MeetingType[]> {
  if (!supabase || workspaceId == null) return [...DEFAULT_MEETING_TYPES];
  const { data, error } = await supabase.from('meeting_types')
    .select('key, name, minutes, title_pattern, description, sort')
    .eq('workspace_id', workspaceId).eq('active', true).order('sort');
  if (error || !data?.length) return [...DEFAULT_MEETING_TYPES];
  return data as MeetingType[];
}

/** The recipient's zone from their phone's area code, when it maps to one. */
export function zoneForPhone(phone: string | null | undefined): string | null {
  const e = toE164(phone ?? '');
  return e ? zoneForNumber(e) : null;
}

export const browserZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

const pad = (n: number) => String(n).padStart(2, '0');
/** A Date as the values an <input type=date> and <input type=time> hold, in the browser's zone. */
export const toInputs = (d: Date) => ({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
/** Back the other way; null when either field is empty or not a real moment. */
export function fromInputs(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export type QuickSlot = { key: string; label: string; at: Date };

/**
 * The few times a rep picks most on a live call: the next quarter hour at
 * least 30 minutes out, tomorrow at 10 and at 2, and the next weekday after
 * tomorrow at 10. Weekends roll to Monday.
 */
export function quickSlots(now = new Date()): QuickSlot[] {
  const soon = new Date(now.getTime() + 30 * 60_000);
  soon.setSeconds(0, 0);
  soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15);
  const day = (offset: number, h: number) => { const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(h, 0, 0, 0); return d; };
  const weekday = (d: Date) => { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d; };
  const t10 = weekday(day(1, 10));
  const t14 = weekday(day(1, 14));
  const after = weekday(new Date(t10.getTime() + 86_400_000));
  const isTomorrow = t10.toDateString() === day(1, 10).toDateString();
  const dayName = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
  const hm = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return [
    { key: 'soon', label: `Today ${hm(soon)}`, at: soon },
    { key: 't10', label: `${isTomorrow ? 'Tomorrow' : dayName(t10)} 10 AM`, at: t10 },
    { key: 't14', label: `${isTomorrow ? 'Tomorrow' : dayName(t14)} 2 PM`, at: t14 },
    { key: 'next', label: `${dayName(after)} 10 AM`, at: after },
  ].map((s) => (s.key === 'soon' && soon.toDateString() !== now.toDateString() ? { ...s, label: `${dayName(soon)} ${hm(soon)}` } : s));
}

export type InviteRequest = {
  workspace_id: number; meeting_type: string; starts_at: string; minutes?: number;
  seller_id?: number | null; buyer_id?: number | null; name?: string; email?: string; phone?: string;
  recipient_tz?: string | null; rep_tz?: string | null; send_email: boolean; send_sms: boolean; note?: string | null; origin?: string;
};

export type InviteResult = {
  ok: true; appointment_id: number; meet_link: string | null; event_link: string | null;
  emailed: boolean; texted: boolean; google_invited: boolean; warnings: string[]; when: string; tz: string;
};

export async function sendMeetingInvite(req: InviteRequest): Promise<{ ok: true; data: InviteResult } | { ok: false; message: string; code?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('meeting-invite', { body: req });
  if (error) {
    let message = error.message;
    let code: string | undefined;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        const body = (await ctx.json()) as { error?: string; code?: string };
        message = body.error ?? message;
        code = body.code;
      }
    } catch { /* keep the transport message */ }
    if (/Failed to send a request|fetch/i.test(message)) message = 'Could not reach the server. Check your connection and send again.';
    return { ok: false, message, code };
  }
  return { ok: true, data: data as InviteResult };
}
