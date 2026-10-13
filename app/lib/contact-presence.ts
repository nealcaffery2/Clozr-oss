// "Has phone / no phone" and "has email / no email" for the People and Buyers lists.
// A phone counts when it has at least 7 digits. An email counts when it has
// a real address, so a dash or a blank cell is "missing".

import { picksOf } from './multi-filter';

export type PresenceFilter = 'Any' | 'Has phone' | 'No phone' | 'Has email' | 'No email';

export const PHONE_FILTERS = ['Any', 'Has phone', 'No phone'] as const;
export const EMAIL_FILTERS = ['Any', 'Has email', 'No email'] as const;

export function hasPhone(value: string | null | undefined): boolean {
  return (value ?? '').replace(/\D/g, '').length >= 7;
}

export function hasEmail(value: string | null | undefined): boolean {
  const s = (value ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * `phoneFilter` is Any | Has phone | No phone, `emailFilter` is Any | Has email
 * | No email, either possibly several picks (lib/multi-filter): a record
 * passes when it meets any one of them.
 */
export function matchesContactFilters(
  phone: string | null | undefined,
  email: string | null | undefined,
  phoneFilter: string | undefined,
  emailFilter: string | undefined,
): boolean {
  const phones = picksOf(phoneFilter);
  if (phones.length && !phones.some((f) => (f === 'Has phone' ? hasPhone(phone) : f === 'No phone' ? !hasPhone(phone) : true))) return false;
  const emails = picksOf(emailFilter);
  if (emails.length && !emails.some((f) => (f === 'Has email' ? hasEmail(email) : f === 'No email' ? !hasEmail(email) : true))) return false;
  return true;
}
