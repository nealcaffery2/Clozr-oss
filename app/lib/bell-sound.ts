// Map bell rows to notification sounds (lib/phone-audio) and dedupe keys.

import type { Notification } from './clozr-types';
import type { NotifyEvent } from './phone-audio';

/** Bell category → settings event(s). Call covers missed + voicemail. */
export const BELL_CAT_NOTIFY_EVENTS: Record<string, NotifyEvent[]> = {
  SMS: ['sms'],
  Call: ['missed', 'voicemail'],
  Mention: ['mention'],
  Task: ['task'],
  Contract: ['contract'],
  'Contract request': ['contract'],
};

export function bellNotifEvent(n: Pick<Notification, 'cat' | 'text' | 'link'>): NotifyEvent | null {
  if (n.cat === 'SMS' || n.cat === 'inbound_sms' || n.cat === 'Email reply') return 'sms';
  if (n.cat === 'Call') {
    if (n.link.screen === 'person' && !n.link.tab) return 'voicemail';
    if (/voicemail/i.test(n.text)) return 'voicemail';
    return 'missed';
  }
  if (n.cat === 'Mention') return 'mention';
  if (n.cat === 'Task') return 'task';
  if (n.cat === 'Contract' || n.cat === 'Contract request') return 'contract';
  return null;
}

/** Short-lived dedupe so Talkr realtime and CRM bell rows do not double-chime. */
export function bellSoundDedupeKey(n: Pick<Notification, 'id' | 'cat' | 'phone'>, event: NotifyEvent): string {
  if (n.phone && (event === 'sms' || event === 'missed' || event === 'voicemail')) {
    const tail = String(n.phone).replace(/\D/g, '').slice(-10);
    if (tail.length === 10) return `${event}:${tail}`;
  }
  return `${event}:${n.id}`;
}
