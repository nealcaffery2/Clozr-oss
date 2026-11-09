// What an action-plan step does when it comes due. No network.
//
// A Compr workspace sends email, text, tag, assign and stage on its own.
// A prospect's email goes out of the warmed cold inboxes. Someone who already
// has a Compr account gets the workspace's own mail. A call or a manual task
// stays on the list for a person.

import { localParts } from './deliverability-rules.ts';

export const AUTO_CHANNELS = ['email', 'sms', 'tag', 'assign', 'stage'] as const;
export type AutoChannel = (typeof AUTO_CHANNELS)[number];

export const CUSTOMER_TAGS = ['compr-free-trial', 'compr-paid'] as const;
export const COLD_TAG = 'compr-cold';
export const EXCLUDE_TAG = 'compr-master-exclude';
/** Booked a Compr call on Cal.com (cal-webhook): they asked to hear from us, so not a cold prospect. */
export const DEMO_TAG = 'compr-demo';
/** Ran the free report on underwriting.example.com and asked for it by email (Compr /api/guest-lead): warm, not cold. */
export const FREE_REPORT_TAG = 'compr-free-report';

const DNC = new Set(['dnc', 'do not contact', 'do-not-contact', 'secret-blacklist']);

export type PlanPerson = {
  kind: 'buyer' | 'seller';
  tags: readonly string[] | null;
  email: string | null;
  phone: string | null;
  archived: boolean;
  blacklisted: boolean;
  /** Buyers only. A seller has no consent column; Talkr still refuses STOP. */
  optedIn: boolean;
  hasSignup: boolean;
  emailSafe: boolean | null;
  emailStatus: string | null;
};

export type Hours = { enabled?: boolean; start?: string; end?: string; days?: number[] };

export type SendGate = {
  suppressed: boolean;
  requireVerified: boolean;
  /** Plan setting text_without_consent: the owner took on the TCPA risk of texting buyers with no opt-in on file. */
  textWithoutConsent?: boolean;
};

export const normTags = (tags: readonly string[] | null | undefined): string[] =>
  (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

export function isCustomer(p: Pick<PlanPerson, 'tags' | 'hasSignup'>): boolean {
  if (p.hasSignup) return true;
  const tags = normTags(p.tags);
  return tags.some((t) => (CUSTOMER_TAGS as readonly string[]).includes(t));
}

/**
 * Cold mail uses the warmed inboxes. Relationship mail uses the workspace
 * sender. A signup or a paid or trial tag wins, so a customer is never
 * mailed from a cold domain, and so does a booked call: someone who booked
 * time with the rep hears from the rep's own domain.
 */
export function emailLane(p: PlanPerson, compr: boolean): 'cold' | 'relationship' {
  if (isCustomer(p)) return 'relationship';
  const tags = normTags(p.tags);
  if (tags.includes(DEMO_TAG) || tags.includes(FREE_REPORT_TAG)) return 'relationship';
  if (tags.includes(COLD_TAG)) return 'cold';
  if (compr && p.kind === 'buyer') return 'cold';
  return 'relationship';
}

/** Compr sends on its own. Any workspace can turn that on or off in the plan settings. */
export function autoSendOn(compr: boolean, settings: { auto_send?: boolean } | null | undefined): boolean {
  if (settings?.auto_send === false) return false;
  if (settings?.auto_send === true) return true;
  return compr;
}

/** Why this step must not go out. Null means send. */
export function planBlock(p: PlanPerson, channel: 'email' | 'sms', _lane: 'cold' | 'relationship', gate: SendGate): string | null {
  if (p.archived) return 'archived';
  const tags = normTags(p.tags);
  if (p.blacklisted || tags.some((t) => DNC.has(t))) return 'do not contact';
  if (tags.includes(EXCLUDE_TAG)) return 'excluded from Compr sends';
  if (channel === 'email') {
    const e = (p.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'no email';
    if (gate.suppressed) return 'email unsubscribed or bounced';
    return null;
  }
  return (p.phone ?? '').replace(/\D/g, '').length >= 10 ? null : 'no mobile number';
}

/** The cold tag a prospect is missing, or null when they already have it or are a customer. */
export function tagToAdd(p: PlanPerson, lane: 'cold' | 'relationship'): string | null {
  if (lane !== 'cold' || isCustomer(p)) return null;
  const tags = normTags(p.tags);
  if (tags.includes(EXCLUDE_TAG) || tags.includes(COLD_TAG)) return null;
  return COLD_TAG;
}

/** {{field}} only. An unknown field stays visible. */
export function fillMerge(body: string, fields: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const v = fields[String(name).toLowerCase()];
    return v == null ? whole : v;
  });
}

export function subjectOf(subject: string | null | undefined, title: string | null | undefined, fields: Record<string, string>): string {
  const raw = (subject ?? '').trim() || (title ?? '').trim() || 'Compr';
  return fillMerge(raw, fields).replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function hhmm(v: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** Plan hours use Monday = 1. A list that contains 0 is already Sunday = 0. */
function daySet(days: number[] | undefined): Set<number> {
  const list = days?.length ? days : [1, 2, 3, 4, 5];
  const iso = !list.includes(0);
  return new Set(list.map((d) => (iso && d === 7 ? 0 : d)));
}

/** Open now, or the next quarter hour the plan's hours allow. */
export function windowState(now: Date, hours: Hours | null | undefined, tz: string): { open: boolean; nextAt: string } {
  if (!hours?.enabled) return { open: true, nextAt: now.toISOString() };
  const days = daySet(hours.days);
  const start = hhmm(hours.start, 8 * 60);
  const end = hhmm(hours.end, 20 * 60);
  const inside = (t: Date) => {
    const p = localParts(t, tz);
    const m = p.hour * 60 + p.minute;
    return days.has(p.weekday) && m >= start && m < end;
  };
  if (inside(now)) return { open: true, nextAt: now.toISOString() };
  for (let step = 1; step <= 8 * 24 * 4; step++) {
    const t = new Date(now.getTime() + step * 15 * 60_000);
    if (inside(t)) return { open: false, nextAt: t.toISOString() };
  }
  return { open: false, nextAt: new Date(now.getTime() + 12 * 3600_000).toISOString() };
}

export function enrollTitle(planName: string): string {
  const name = planName.trim() || 'an action plan';
  return `Started "${name}"`;
}

/** Who a step sends as. A named step assignee wins. In Compr the workspace rep wins over the person who clicked enroll, so the reply comes back to that rep. */
export function planSender(input: {
  stepAssignee?: string | null; repId?: string | null; taskAssignee?: string | null; createdBy?: string | null; compr: boolean;
}): string | null {
  const step = input.stepAssignee?.trim() || '';
  if (step) return step;
  const rep = input.repId?.trim() || '';
  if (input.compr && rep) return rep;
  return input.taskAssignee?.trim() || input.createdBy?.trim() || rep || null;
}

/** A paused or stopped enrolment must not send. */
export function enrollmentOpen(status: string | null | undefined): boolean {
  return status === 'active';
}

/** Why a prospect email must not go out, given the warmed-sequence row for this campaign. A finished row can send again. */
export function coldHold(status: string | null | undefined): string | null {
  if (status === 'active') return 'Already on a warmed sequence, so this step did not send a second one.';
  if (status === 'bounced' || status === 'unsubscribed' || status === 'suppressed' || status === 'replied' || status === 'stopped') {
    return 'This address already left the warmed sequence.';
  }
  return null;
}

export function skipTitle(channel: string): string {
  if (channel === 'sms') return 'Text skipped';
  if (channel === 'email') return 'Email skipped';
  if (channel === 'tag') return 'Tag skipped';
  return 'Step skipped';
}
