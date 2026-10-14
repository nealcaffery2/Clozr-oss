/**
 * Cold prospect campaigns: the decisions, with no network and no database.
 *
 * A campaign is an audience of buyers plus a sequence. The worker
 * (cold-campaign-tick) asks planColdSend what to do with one due enrollment,
 * then sends through the mailbox's provider. Caps, the volume ramp and the
 * verification gate are the same functions the Gmail and Resend paths use
 * (deliverability-rules.ts). Cold mail is always kind 'bulk'. A new mailbox
 * sends 5 a day its first week, 10 the second, 15 the third, then 20, and
 * never more than 20. The gap between sends is 4 to 11 minutes, and today's cap is
 * jittered down so it is not the same number every day. Instantly warmup
 * mail is not a reply: Instantly's warmup ID is matched in the subject or the body.
 * Step 1 never sends Re: or Fwd:. One recipient has one active sequence and
 * one sender. A company domain gets at most 3 cold emails a day. Complaint
 * pause target is under 0.1%. Cold plus warmup stays around 40 a day. Any
 * Spam placement pauses the mailbox. The rep Gmail and Resend ramps are not
 * these numbers.
 *
 * Tests: npx tsx tools/cold-campaign.test.ts
 */
import {
  FREE_MAIL, type EmailSafety, type MailboxSettings, autoPauseReason, blockUnverified, cycleOrder, dayStartUtc, domainOf, localParts, parseBounce, rampDay,
} from './deliverability-rules.ts';

/** Always refused as a cold From-domain, even when a workspace adds nothing else. */
export const DEFAULT_BLOCKED_SENDING_DOMAINS = ['yourcompany.com'] as const;

/** Cold-pool defaults. The rep Gmail and Resend ramps stay on their own constants. */
export const COLD_DAILY_CAP = 20;
export const COLD_HOURLY_CAP = 6;
export const COLD_RAMP_START = 5;
/** Stored on the mailbox row. The cold schedule itself steps up weekly, not by this percent. */
export const COLD_RAMP_INCREASE_PCT = 20;
export const COLD_RAMP_TARGET = 20;
/** Day 0 is the start volume; it steps up once a week and reaches the cap on day COLD_RAMP_DAYS (5, 10, 15, 20). */
export const COLD_RAMP_DAYS = 21;
/** Today's allowance is cut by up to this percent. It is never raised, and never above the ceiling. */
export const COLD_JITTER_PCT = 15;
/** Randomized pause between two sends from one mailbox. */
export const COLD_GAP_MIN_SECONDS = 4 * 60;
export const COLD_GAP_MAX_SECONDS = 11 * 60;
/** Same as the 4 minute minimum. Older callers used a 45 second floor. */
export const COLD_GAP_FLOOR_SECONDS = COLD_GAP_MIN_SECONDS;
/** Cold sends plus Instantly warmup on one inbox. Warmup volume is configured; this is the combined ceiling. */
export const COLD_COMBINED_DAILY = 40;
/** Default warmup messages a day, so 20 cold + 20 warmup stays on the combined ceiling. */
export const COLD_WARMUP_DAILY = 20;
/** Cold mail to one company domain, all mailboxes, one day. Free inboxes are not under this cap. */
export const COLD_RECIPIENT_DOMAIN_CAP = 3;
/** Google Postmaster's spam-complaint target. At a 20-a-day cap, one complaint in a week is already over it. */
export const COLD_COMPLAINT_RATE = 0.001;

/** InboxKit Google Workspace mailboxes connect with an app password on these hosts. */
export const GOOGLE_WORKSPACE_SMTP = { host: 'smtp.gmail.com', port: 587 } as const;
export const GOOGLE_WORKSPACE_IMAP = { host: 'imap.gmail.com', port: 993 } as const;

/**
 * Folder and label names Instantly's warmup instructions create.
 * Gmail: label "Warmup". Outlook: folder "Instantly Warmup".
 */
export const INSTANTLY_WARMUP_FOLDERS = ['warmup', 'instantly warmup', 'instantly-warmup', 'instantly_warmup'] as const;

/** Local parts that are a company role, not a person. Suppressed by default. */
export const ROLE_LOCAL_PARTS = [
  'info', 'admin', 'administrator', 'sales', 'support', 'hello', 'contact', 'office', 'team',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse', 'webmaster',
  'marketing', 'hr', 'jobs', 'billing', 'accounts', 'enquiries', 'inquiries', 'help',
  'mail', 'officeadmin', 'security', 'privacy', 'legal', 'newsletter',
] as const;

export type RecipientProvider = 'gmail' | 'google_workspace' | 'outlook' | 'other';

/**
 * Workspace Primary-inbox policy. Defaults are the safe side: plain text,
 * no open pixel, no click rewrite, step 1 has no link, later steps have one,
 * and a missing physical address blocks the send.
 */
export type ColdDeliverability = {
  plainTextFirst: boolean;
  openTracking: boolean;
  clickTracking: boolean;
  step1Links: 'block' | 'warn' | 'allow';
  maxLinksAfterStep1: number;
  spamLintBlock: boolean;
  spamScoreLimit: number;
  gapMinSeconds: number;
  gapMaxSeconds: number;
  dailyCeiling: number;
  jitterPct: number;
  rampDays: number;
  skipWeekends: boolean;
  restDays: boolean;
  bouncePauseRate: number;
  bounceMinSample: number;
  anyComplaintPauses: boolean;
  /** Pause when complaints / sends over 7 days reach this. Default is 0.1%. */
  complaintPauseRate: number;
  /** Max cold sends per day to one non-freemail recipient domain, across the workspace. */
  recipientDomainDailyCap: number;
  /** Instantly (or any) warmup volume reserved on each inbox. Cold room is the combined ceiling minus this. */
  warmupDaily: number;
  /** Cold plus warmup. Default 40. */
  combinedDailyCeiling: number;
  lowReplyRate: number;
  lowReplySample: number;
  primaryRateFloor: number;
  bodyRepeatLimit: number;
  bodyRepeatWindowMinutes: number;
  providerShare: number;
  suppressRoles: boolean;
  suppressCatchAll: boolean;
  requirePhysicalAddress: boolean;
  physicalAddress: string;
  oooHoldBusinessDays: number;
  /** Days an inbox warms before the gate lets cold mail start. Default WARMUP_GATE_MIN_DAYS. */
  warmupGateDays: number;
};

export const DEFAULT_COLD_DELIVERABILITY: ColdDeliverability = {
  plainTextFirst: true,
  openTracking: false,
  clickTracking: false,
  step1Links: 'block',
  maxLinksAfterStep1: 1,
  spamLintBlock: true,
  spamScoreLimit: 60,
  gapMinSeconds: COLD_GAP_MIN_SECONDS,
  gapMaxSeconds: COLD_GAP_MAX_SECONDS,
  dailyCeiling: COLD_DAILY_CAP,
  jitterPct: COLD_JITTER_PCT,
  rampDays: COLD_RAMP_DAYS,
  skipWeekends: true,
  restDays: true,
  bouncePauseRate: 0.02,
  bounceMinSample: 50,
  anyComplaintPauses: true,
  complaintPauseRate: COLD_COMPLAINT_RATE,
  recipientDomainDailyCap: COLD_RECIPIENT_DOMAIN_CAP,
  warmupDaily: COLD_WARMUP_DAILY,
  combinedDailyCeiling: COLD_COMBINED_DAILY,
  lowReplyRate: 0.01,
  lowReplySample: 50,
  primaryRateFloor: 0.8,
  bodyRepeatLimit: 3,
  bodyRepeatWindowMinutes: 30,
  providerShare: 0.6,
  suppressRoles: true,
  suppressCatchAll: true,
  requirePhysicalAddress: true,
  physicalAddress: '',
  oooHoldBusinessDays: 4,
  warmupGateDays: 14,
};

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a stored jsonb blob over the defaults. Unknown keys are ignored. */
export function coldDeliverability(raw: unknown, physicalAddress?: string | null): ColdDeliverability {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const d: ColdDeliverability = { ...DEFAULT_COLD_DELIVERABILITY };
  const flag = (key: keyof ColdDeliverability, snake: string) => {
    if (typeof src[snake] === 'boolean') (d as Record<string, unknown>)[key] = src[snake];
  };
  flag('plainTextFirst', 'plain_text_first');
  flag('openTracking', 'open_tracking');
  flag('clickTracking', 'click_tracking');
  flag('spamLintBlock', 'spam_lint_block');
  flag('skipWeekends', 'skip_weekends');
  flag('restDays', 'rest_days');
  flag('anyComplaintPauses', 'any_complaint_pauses');
  flag('suppressRoles', 'suppress_roles');
  flag('suppressCatchAll', 'suppress_catch_all');
  flag('requirePhysicalAddress', 'require_physical_address');
  if (src.step1_links === 'block' || src.step1_links === 'warn' || src.step1_links === 'allow') d.step1Links = src.step1_links;
  d.maxLinksAfterStep1 = clampNum(src.max_links_after_step1, 0, 3, d.maxLinksAfterStep1);
  d.spamScoreLimit = clampNum(src.spam_score_limit, 1, 100, d.spamScoreLimit);
  d.gapMinSeconds = clampNum(src.gap_min_seconds, 30, 3600, d.gapMinSeconds);
  d.gapMaxSeconds = clampNum(src.gap_max_seconds, d.gapMinSeconds, 7200, d.gapMaxSeconds);
  d.dailyCeiling = clampNum(src.daily_ceiling, 1, 2000, d.dailyCeiling);
  d.jitterPct = clampNum(src.jitter_pct, 0, 40, d.jitterPct);
  d.rampDays = clampNum(src.ramp_days, 1, 60, d.rampDays);
  d.bouncePauseRate = clampNum(src.bounce_pause_rate, 0, 1, d.bouncePauseRate);
  d.bounceMinSample = clampNum(src.bounce_min_sample, 1, 500, d.bounceMinSample);
  d.complaintPauseRate = clampNum(src.complaint_pause_rate, 0, 0.05, d.complaintPauseRate);
  d.recipientDomainDailyCap = clampNum(src.recipient_domain_daily_cap, 0, 50, d.recipientDomainDailyCap);
  d.warmupDaily = clampNum(src.warmup_daily, 0, 80, d.warmupDaily);
  d.combinedDailyCeiling = clampNum(src.combined_daily_ceiling, 1, 200, d.combinedDailyCeiling);
  d.lowReplyRate = clampNum(src.low_reply_rate, 0, 1, d.lowReplyRate);
  d.lowReplySample = clampNum(src.low_reply_sample, 1, 500, d.lowReplySample);
  d.primaryRateFloor = clampNum(src.primary_rate_floor, 0, 1, d.primaryRateFloor);
  d.bodyRepeatLimit = clampNum(src.body_repeat_limit, 1, 50, d.bodyRepeatLimit);
  d.bodyRepeatWindowMinutes = clampNum(src.body_repeat_window_minutes, 1, 24 * 60, d.bodyRepeatWindowMinutes);
  d.providerShare = clampNum(src.provider_share, 0.1, 1, d.providerShare);
  d.oooHoldBusinessDays = clampNum(src.ooo_hold_business_days, 1, 20, d.oooHoldBusinessDays);
  d.warmupGateDays = Math.round(clampNum(src.warmup_gate_days, 1, 30, d.warmupGateDays));
  d.physicalAddress = String(physicalAddress ?? src.physical_address ?? '').trim();
  if (d.gapMaxSeconds < d.gapMinSeconds) d.gapMaxSeconds = d.gapMinSeconds;
  return d;
}

export type ColdWindow = { start: number; end: number; days: number[] };

export type ColdVariant = { key: string; subject: string; body: string; weight: number };

export type ColdStep = {
  position: number;
  delayBusinessDays: number;
  subject: string;
  body: string;
  variants: ColdVariant[];
};

export type ColdMailbox = {
  id: number;
  domainId: number;
  domain: string;
  email: string;
  paused: boolean;
  /** warming and active can send. paused, error, disconnected and pending cannot. */
  status: string;
  settings: MailboxSettings;
  sentToday: number;
  sentLastHour: number;
  lastSentAt: string | null;
  /** Plain-text signature appended above the physical-address footer. */
  signature?: string | null;
  /** Weekday this mailbox does not send. Empty uses a stable day from the id. */
  restWeekday?: number | null;
  /** Sends already made today, by recipient provider. */
  sentByProvider?: Partial<Record<RecipientProvider, number>>;
  /** This inbox's warmup volume. Empty uses the workspace policy. */
  warmupDaily?: number | null;
  /**
   * True while the workspace warms through a vendor and this inbox has not
   * cleared the gate (14 days warming and a score of 90). A gated inbox has
   * a cold allowance of 0; the sync promotes it to active and restarts the
   * ramp at day 1.
   */
  warmupGated?: boolean;
};

export type ColdDomain = {
  id: number;
  domain: string;
  dailyCap: number;
  sentToday: number;
  paused: boolean;
  blocking: string[];
  checkedAt: string | null;
  /** Hostname that rewrites a click, and only when click tracking is on. */
  trackingDomain?: string | null;
};

export type ReplyClass = 'interested' | 'not_interested' | 'out_of_office' | 'unsubscribe' | 'bounce' | 'other';

export type WarmupMailbox = { id: number; email: string; rampDay: number; allowance: number };

export type WarmupSnapshot = {
  provider: string;
  enrolled: boolean;
  stage: string;
  dailyTarget: number | null;
  note: string;
};

/**
 * Where a seed message landed. null primaryRate means the vendor has not
 * reported a Primary rate. `spam` or placement `spam` is a Spam result from
 * a weekly manual test or a seed list, not a daily poll. One Spam result
 * pauses the mailbox. A null result does not.
 */
export type PlacementResult = {
  primaryRate: number | null;
  checkedAt: string | null;
  sample: number;
  spam?: boolean | null;
  placement?: 'primary' | 'spam' | 'other' | null;
};

/** A warmup vendor plugs in here later. The stub never calls the network. */
export interface WarmupProvider {
  readonly name: string;
  status(mailbox: WarmupMailbox): Promise<WarmupSnapshot>;
  enroll(mailbox: WarmupMailbox): Promise<WarmupSnapshot>;
  pause(mailbox: WarmupMailbox): Promise<WarmupSnapshot>;
  /**
   * Latest placement result. Callers may ask on a tick. A provider should
   * return the last weekly manual test or seed-list result, not run a new
   * test every minute. No result does not pause. Any Spam result does.
   */
  placement(mailbox: WarmupMailbox): Promise<PlacementResult>;
}

type FetchLike = (input: string, init?: { method?: string }) => Promise<unknown>;

/**
 * Config names the vendor an owner intends to use. Until a real adapter is
 * written, every name resolves to the stub, which does not call `fetch`.
 */
export function createWarmupProvider(config: { provider?: string | null; apiBase?: string | null }, deps?: { fetch?: FetchLike }): WarmupProvider {
  return new StubWarmupProvider(config.provider?.trim() || 'stub', config.apiBase?.trim() || null, deps?.fetch);
}

class StubWarmupProvider implements WarmupProvider {
  readonly name: string;
  constructor(private readonly configured: string, private readonly apiBase: string | null, private readonly fetchImpl?: FetchLike) {
    this.name = 'stub';
    // The fetch handle is kept so a test can prove it is never used.
    void this.fetchImpl;
    void this.apiBase;
  }
  async status(mailbox: WarmupMailbox): Promise<WarmupSnapshot> {
    return this.snap(mailbox, false);
  }
  async enroll(mailbox: WarmupMailbox): Promise<WarmupSnapshot> {
    return this.snap(mailbox, false);
  }
  async pause(mailbox: WarmupMailbox): Promise<WarmupSnapshot> {
    return this.snap(mailbox, false);
  }
  async placement(_mailbox: WarmupMailbox): Promise<PlacementResult> {
    return { primaryRate: null, checkedAt: null, sample: 0, spam: null, placement: null };
  }
  private snap(mailbox: WarmupMailbox, enrolled: boolean): WarmupSnapshot {
    const named = this.configured === 'stub' || this.configured === 'none' ? '' : ` Config says "${this.configured}"${this.apiBase ? ` at ${this.apiBase}` : ''}, and no adapter is installed for it.`;
    return {
      provider: 'stub',
      enrolled,
      stage: `ramp-day-${mailbox.rampDay + 1}`,
      dailyTarget: mailbox.allowance,
      note: `Volume ramp only (${mailbox.allowance}/day today). No external warmup call is made.${named}`,
    };
  }
}

/** The three protected domains, plus anything the workspace added. */
export function blockedSendingDomains(extra: readonly string[] | null | undefined): string[] {
  const out = new Set<string>(DEFAULT_BLOCKED_SENDING_DOMAINS);
  for (const raw of extra ?? []) {
    const d = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (d && d.includes('.')) out.add(d);
  }
  return [...out];
}

/** True when `domain` is one of the blocked names or a subdomain of one. */
export function domainBlocked(domain: string, blocked: readonly string[]): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  return blocked.some((raw) => {
    const b = raw.trim().toLowerCase().replace(/\.$/, '');
    return !!b && (d === b || d.endsWith(`.${b}`));
  });
}

export function sendingDomainBlocked(emailOrDomain: string, blocked: readonly string[]): boolean {
  const domain = emailOrDomain.includes('@') ? domainOf(emailOrDomain) : emailOrDomain;
  return domainBlocked(domain, blocked);
}

/**
 * Why an address cannot join the pool, or null. Every way in (CSV, Google,
 * Microsoft, InboxKit) asks this before writing a mailbox row, so the three
 * locked domains are refused whatever the workspace added or removed.
 */
export function importRefusal(email: string, blocked: readonly string[]): string | null {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return 'Not an email address.';
  const domain = domainOf(e);
  if (!domain || !domain.includes('.')) return 'Not a domain name.';
  if (sendingDomainBlocked(e, blockedSendingDomains(blocked))) return 'Blocked sending domain.';
  return null;
}

// ------------------------------------------------------------ warmup gate
/** Days an inbox warms before cold mail may start. */
export const WARMUP_GATE_MIN_DAYS = 14;
/** The Instantly health score an inbox needs before cold mail may start. */
export const WARMUP_GATE_MIN_SCORE = 90;
/** Warmup mail landing in Spam above this share pauses the inbox. */
export const WARMUP_SPAM_PAUSE_PCT = 3;

/** Only a vendor that reports a score can run the gate; the stub ramps as before. */
export function warmupGateOn(provider: string | null | undefined): boolean {
  return String(provider ?? '').trim().toLowerCase() === 'instantly';
}

export function warmupDaysSince(startedAt: string | null | undefined, now: Date): number {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export type WarmupGate = { ready: boolean; daysWarming: number; reason: string };

/**
 * Ready once the inbox has warmed for WARMUP_GATE_MIN_DAYS and its latest
 * vendor score is at least WARMUP_GATE_MIN_SCORE. A missing score never
 * passes: a vendor that has not reported is a vendor that has not vouched.
 */
export function warmupGate(input: { startedAt: string | null | undefined; score: number | null | undefined; now: Date; minDays?: number; minScore?: number }): WarmupGate {
  const minDays = input.minDays ?? WARMUP_GATE_MIN_DAYS;
  const minScore = input.minScore ?? WARMUP_GATE_MIN_SCORE;
  const daysWarming = warmupDaysSince(input.startedAt, input.now);
  const score = input.score == null || !Number.isFinite(input.score) ? null : input.score;
  if (!input.startedAt) return { ready: false, daysWarming, reason: 'Warmup has not started.' };
  if (daysWarming < minDays) {
    return { ready: false, daysWarming, reason: `Warming, day ${daysWarming + 1} of ${minDays}${score == null ? ', no score yet' : `, score ${score}`}.` };
  }
  if (score == null) return { ready: false, daysWarming, reason: `Warmed ${daysWarming} days, waiting for a score.` };
  if (score < minScore) return { ready: false, daysWarming, reason: `Warmed ${daysWarming} days, score ${score} is under ${minScore}.` };
  return { ready: true, daysWarming, reason: `Score ${score} after ${daysWarming} days. Cold mail can start.` };
}

export type PoolAlertInput = {
  sync: { error: string | null; unlisted: string[]; rewarmed: string[]; resumed: string[]; promoted: string[] };
  mailboxes: { email: string; status: string; paused: boolean; paused_reason: string | null; warmup_score: number | null; warmup_started_at: string | null }[];
  domains: { domain: string; paused: boolean; paused_reason: string | null; blocking: string[] | null; checked_at: string | null }[];
  minDays: number;
  minScore: number;
  now: Date;
};

/** What the daily alert mail says: problems a person must look at, and what the sync fixed by itself. */
export function poolAlerts(i: PoolAlertInput): { problems: string[]; healed: string[] } {
  const problems: string[] = [];
  if (i.sync.error) problems.push(`Instantly sync: ${i.sync.error}`);
  if (i.sync.unlisted.length) problems.push(`Not in Instantly, so nothing warms them: ${i.sync.unlisted.join(', ')}.`);
  for (const d of i.domains) {
    if (d.paused) problems.push(`${d.domain} is paused: ${d.paused_reason ?? 'no reason given'}`);
    if (!d.checked_at) problems.push(`${d.domain} has never passed a DNS check, so it cannot send.`);
    for (const b of d.blocking ?? []) problems.push(`${d.domain}: ${b}`);
  }
  for (const m of i.mailboxes) {
    if (m.paused) { problems.push(`${m.email} is paused: ${m.paused_reason ?? 'no reason given'}`); continue; }
    const days = warmupDaysSince(m.warmup_started_at, i.now);
    if (m.status === 'warming' && days >= i.minDays && m.warmup_score != null && m.warmup_score < i.minScore) {
      problems.push(`${m.email} has warmed ${days} days but its score is ${m.warmup_score}, under ${i.minScore}, so it is still held back.`);
    }
  }
  const healed = [
    ...i.sync.rewarmed.map((e) => `Warmup was off for ${e}. Turned it back on.`),
    ...i.sync.resumed.map((e) => `${e} is back under the Spam limit. Unpaused it.`),
    ...i.sync.promoted.map((e) => `${e} cleared warmup and started sending cold mail.`),
  ];
  return { problems, healed };
}

/** Share of warmup mail that landed in Spam, 0 to 100, or null before any was sent. */
export function warmupSpamPct(sent: number, spam: number): number | null {
  const s = Math.max(0, Math.floor(sent));
  if (s <= 0) return null;
  return Math.round((100 * Math.max(0, Math.min(s, Math.floor(spam))) / s) * 10) / 10;
}

/** The auto-pause reason when warmup Spam is over the limit, else null. */
export function warmupSpamPause(sent: number, spam: number, limitPct = WARMUP_SPAM_PAUSE_PCT): string | null {
  const pct = warmupSpamPct(sent, spam);
  if (pct == null || pct <= limitPct) return null;
  return `warmup mail landed in Spam ${pct.toFixed(1)}% of the time over ${WARMUP_GATE_MIN_DAYS} days (limit ${limitPct}%)`;
}

/**
 * Cold campaigns are bulk. Known-bad addresses are refused. Unverified
 * addresses are refused only when the workspace requires a verified address.
 * This is blockUnverified(..., 'bulk'), the same gate guardSend uses.
 */
export function coldAudienceBlocked(safety: EmailSafety, requireVerified: boolean): boolean {
  return blockUnverified(safety, 'bulk', { requireVerified });
}

const STATE_ZONE: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DC: 'America/New_York',
  DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  IA: 'America/Chicago', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', MA: 'America/New_York',
  MD: 'America/New_York', ME: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MO: 'America/Chicago', MS: 'America/Chicago', MT: 'America/Denver', NC: 'America/New_York',
  ND: 'America/Chicago', NE: 'America/Chicago', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NV: 'America/Los_Angeles', NY: 'America/New_York', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VA: 'America/New_York', VT: 'America/New_York', WA: 'America/Los_Angeles',
  WI: 'America/Chicago', WV: 'America/New_York', WY: 'America/Denver',
};

/** USPS code from an explicit state or from a market token such as "Austin, TX". */
export function stateOf(explicit: string | null | undefined, markets: readonly string[] | null | undefined): string | null {
  const direct = (explicit ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(direct) && STATE_ZONE[direct]) return direct;
  for (const market of markets ?? []) {
    const hit = /,\s*([A-Za-z]{2})\b/.exec(market) ?? /\b([A-Z]{2})\s*$/.exec(market.trim());
    const code = hit?.[1]?.toUpperCase() ?? '';
    if (STATE_ZONE[code]) return code;
  }
  return null;
}

/** Recipient zone from their state, otherwise the workspace fallback. */
export function zoneForState(state: string | null | undefined, fallback: string): string {
  const code = (state ?? '').trim().toUpperCase();
  return STATE_ZONE[code] ?? (fallback.trim() || 'America/Chicago');
}

export function inRecipientWindow(at: Date, tz: string, w: ColdWindow): boolean {
  const p = localParts(at, tz);
  return w.days.includes(p.weekday) && p.hour >= w.start && p.hour < w.end;
}

/** First quarter-hour inside the window at or after `after`. */
export function nextRecipientWindow(after: Date, tz: string, w: ColdWindow): Date | null {
  let t = Math.ceil(after.getTime() / 900_000) * 900_000;
  for (let i = 0; i < 4 * 24 * 12; i++, t += 900_000) {
    if (inRecipientWindow(new Date(t), tz, w)) return new Date(t);
  }
  return null;
}

/** An instant at `hour`:00 on the local calendar date `YYYY-MM-DD`. */
export function atLocalHour(date: string, hour: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), tz);
    const [gy, gm, gd] = p.date.split('-').map(Number);
    const got = Date.UTC(gy, gm - 1, gd, p.hour, p.minute);
    const want = Date.UTC(y, m - 1, d, hour, 0);
    guess += want - got;
  }
  return new Date(guess);
}

function nextCalendarDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return n.toISOString().slice(0, 10);
}

/**
 * When step delay has elapsed. `days` 0 means `from` itself (the window check
 * still applies). Otherwise, `window.start` on the local day that is `days`
 * business days later. Weekends are Saturday and Sunday in `tz`.
 */
export function businessWindowOpen(from: Date, days: number, tz: string, w: ColdWindow): Date {
  if (days <= 0) return from;
  let date = localParts(from, tz).date;
  let left = days;
  for (let guard = 0; left > 0 && guard < 40; guard++) {
    date = nextCalendarDate(date);
    const wd = localParts(atLocalHour(date, 12, tz), tz).weekday;
    if (wd !== 0 && wd !== 6) left--;
  }
  return atLocalHour(date, w.start, tz);
}

export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `{Hello|Hi}` and one level of nesting. A brace with no pipe is left alone. */
export function applySpintax(text: string, rnd: () => number): string {
  let out = text;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\{([^{}]+)\}/g, (all, inner: string) => {
      const parts = inner.split('|');
      if (parts.length < 2) return all;
      const iPick = Math.min(parts.length - 1, Math.floor(rnd() * parts.length));
      return parts[iPick] ?? parts[0];
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

export function applyMerge(text: string, fields: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_all, key: string) => {
    const v = fields[key.toLowerCase()];
    return v == null ? '' : String(v);
  });
}

export function pickVariant(variants: readonly ColdVariant[], seed: number): ColdVariant | null {
  const usable = variants.filter((v) => v.subject.trim() && v.body.trim() && v.weight > 0);
  if (!usable.length) return null;
  const total = usable.reduce((n, v) => n + v.weight, 0);
  let roll = seeded(seed)() * total;
  for (const v of usable) {
    roll -= v.weight;
    if (roll < 0) return v;
  }
  return usable[usable.length - 1];
}

export function renderStep(step: ColdStep, seed: number, fields: Record<string, string | null | undefined>): { subject: string; body: string; variant: string | null } {
  const variant = pickVariant(step.variants, seed);
  const subject = applySpintax(applyMerge(variant?.subject ?? step.subject, fields), seeded(seed + 1));
  const body = applySpintax(applyMerge(variant?.body ?? step.body, fields), seeded(seed + 2));
  return { subject, body, variant: variant?.key ?? null };
}

const REPLY_PREFIX = /^(?:(?:re|fw|fwd)\s*:\s*)+/i;

/**
 * Step 1 is a new message: Re: and Fwd: are stripped, even if the template
 * or an old thread id has them. A later step gets one Re: only when it is a
 * reply to our own earlier Message-ID.
 */
export function replySubject(subject: string, followUp: boolean): string {
  const bare = subject.replace(/\s+/g, ' ').trim().replace(REPLY_PREFIX, '').trim();
  if (!followUp) return bare;
  return bare ? `Re: ${bare}` : 'Re:';
}

/** True only for a step after the first that already has our Message-ID. */
export function isThreadedFollowUp(stepPosition: number, threadMessageId: string | null | undefined): boolean {
  return stepPosition > 1 && !!String(threadMessageId ?? '').trim();
}

export function bodyFingerprint(subject: string, body: string): string {
  const s = `${subject}\n${body}`.replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function bodyTooCommon(hash: string, recent: readonly { hash: string; sentAt: string }[], now: Date, limit: number, windowMs: number): boolean {
  const cutoff = now.getTime() - windowMs;
  const n = recent.filter((r) => r.hash === hash && Date.parse(r.sentAt) >= cutoff).length;
  return n >= limit;
}

const MARKETING_URL = /https?:\/\/[^\s<>"')\]]+/gi;

export function marketingLinks(text: string): string[] {
  MARKETING_URL.lastIndex = 0;
  return [...text.matchAll(MARKETING_URL)].map((m) => m[0]).filter((url) => !/unsubscribe/i.test(url));
}

/** Click tracking rewrites a link only when it is enabled and this sending domain has a tracking host. */
export function rewriteTrackedLinks(text: string, opts: { enabled: boolean; trackingDomain: string | null | undefined }): string {
  const host = (opts.trackingDomain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!opts.enabled || !host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return text;
  MARKETING_URL.lastIndex = 0;
  return text.replace(MARKETING_URL, (url) => {
    if (/unsubscribe/i.test(url)) return url;
    return `https://${host}/c?u=${encodeURIComponent(url)}`;
  });
}

export function missingMergeFields(template: string, fields: Record<string, string | null | undefined>): string[] {
  const keys = [...template.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
  return [...new Set(keys.filter((k) => !String(fields[k] ?? '').trim()))];
}

export function unresolvedMerges(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

/** Every spintax branch is visible to the linter, so a spam word in one option still counts. */
function expandForLint(text: string): string {
  let out = text;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\{([^{}]+)\}/g, (all, inner: string) => {
      const parts = inner.split('|');
      return parts.length < 2 ? all : parts.join(' ');
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

const SPAM_RULES: { re: RegExp; points: number; label: string }[] = [
  { re: /\$\$\$/, points: 30, label: 'dollar signs' },
  { re: /\brisk[\s-]?free\b/i, points: 25, label: 'risk free' },
  { re: /\bact now\b/i, points: 25, label: 'act now' },
  { re: /\bclick here\b/i, points: 25, label: 'click here' },
  { re: /\bwinner\b/i, points: 25, label: 'winner' },
  { re: /\bguarantee(d)?\b/i, points: 20, label: 'guarantee' },
  { re: /\bfree\b/i, points: 20, label: 'free' },
  { re: /\bbuy now\b/i, points: 20, label: 'buy now' },
  { re: /\bcongratulations\b/i, points: 20, label: 'congratulations' },
  { re: /\blimited time\b/i, points: 15, label: 'limited time' },
  { re: /\bno obligation\b/i, points: 15, label: 'no obligation' },
  { re: /\burgent\b/i, points: 15, label: 'urgent' },
  { re: /\b100\s*%/, points: 15, label: '100%' },
  { re: /\bcash\b/i, points: 10, label: 'cash' },
];

export function spamScore(subject: string, body: string): { score: number; hits: string[] } {
  const text = `${subject}\n${body}`;
  let score = 0;
  const hits: string[] = [];
  for (const rule of SPAM_RULES) {
    if (rule.re.test(text)) {
      score += rule.points;
      hits.push(rule.label);
    }
  }
  const caps = text.split(/\s+/).filter((w) => w.length >= 5 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (caps.length >= 3) {
    score += 20;
    hits.push('all caps');
  }
  if (/[!?]{3,}/.test(text)) {
    score += 15;
    hits.push('punctuation');
  }
  return { score: Math.min(100, score), hits };
}

export type LintResult = { ok: boolean; score: number; blocks: string[]; warnings: string[] };

export function lintColdCopy(input: {
  stepPosition: number;
  subject: string;
  body: string;
  fields: Record<string, string | null | undefined>;
  policy: ColdDeliverability;
}): LintResult {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const expanded = `${expandForLint(input.subject)}\n${expandForLint(input.body)}`;
  const missing = missingMergeFields(expanded, input.fields);
  if (missing.length) blocks.push(`Missing merge ${missing.map((k) => `{{${k}}}`).join(', ')}.`);
  const rendered = applyMerge(expanded, input.fields);
  const left = unresolvedMerges(rendered);
  if (left.length) blocks.push(`Unresolved merge ${left.join(', ')}.`);
  const subject = applyMerge(expandForLint(input.subject), input.fields).trim();
  const body = applyMerge(expandForLint(input.body), input.fields).trim();
  if (!subject || !body) blocks.push('Subject and body are required.');
  const links = marketingLinks(`${subject}\n${body}`);
  if (input.stepPosition <= 1 && links.length && input.policy.step1Links === 'block') {
    blocks.push('Step 1 cannot contain a link.');
  } else if (input.stepPosition <= 1 && links.length && input.policy.step1Links === 'warn') {
    warnings.push('Step 1 contains a link.');
  } else if (input.stepPosition > 1 && links.length > input.policy.maxLinksAfterStep1) {
    blocks.push(`Step ${input.stepPosition} has ${links.length} links (limit ${input.policy.maxLinksAfterStep1}).`);
  }
  if (input.policy.requirePhysicalAddress && !input.policy.physicalAddress.trim()) {
    blocks.push('A physical address is required in the footer.');
  }
  const spam = spamScore(subject, body);
  if (input.policy.spamLintBlock && spam.score >= input.policy.spamScoreLimit) {
    blocks.push(`Spam score ${spam.score} is at or above ${input.policy.spamScoreLimit}.`);
  }
  return { ok: blocks.length === 0, score: spam.score, blocks, warnings };
}

/** HTML that matches the text: escaped, no images, no tracking pixel. */
export function plainHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:sans-serif;white-space:pre-wrap">${esc}</div>`;
}

/** Appends a pixel only when open tracking is on and a host was configured. The default does neither. */
export function withOpenPixel(html: string, enabled: boolean, pixelUrl: string | null | undefined): string {
  const url = (pixelUrl ?? '').trim();
  if (!enabled || !/^https:\/\/[^\s"]+$/.test(url)) return html;
  return `${html}<img src="${url.replace(/"/g, '')}" width="1" height="1" alt="" />`;
}

export function composeColdText(body: string, opts: { signature?: string | null; physicalAddress?: string | null; unsubscribeUrl: string }): string {
  const parts = [body.trim()];
  if (opts.signature?.trim()) parts.push(opts.signature.trim());
  if (opts.physicalAddress?.trim()) parts.push(opts.physicalAddress.trim());
  parts.push(`If you would rather not hear from us, unsubscribe: ${opts.unsubscribeUrl}`);
  return parts.join('\n\n');
}

/** Message-ID host is the sending domain, so the address and the id agree. */
export function coldMessageId(enrollmentId: number, step: number, nonce: string, fromEmail: string): string {
  const domain = domainOf(fromEmail) || 'localhost';
  return `<cold.${enrollmentId}.${step}.${nonce}@${domain}>`;
}

/** A named return date wins. Otherwise the hold is a few business days, then the next step. */
export function oooResumeAt(body: string, receivedAt: Date, holdBusinessDays: number, tz: string): Date {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(body);
  if (iso) {
    const back = atLocalHour(iso[1], 9, tz);
    if (back.getTime() > receivedAt.getTime() + 60_000) return back;
  }
  return businessWindowOpen(receivedAt, Math.max(1, holdBusinessDays), tz, { start: 9, end: 17, days: [1, 2, 3, 4, 5] });
}

/**
 * A missing report does not pause. Any Spam placement does, including one
 * weekly manual test or one seed. A reported Primary rate under the floor
 * still pauses when a rate was actually measured.
 */
export function placementPausesRamp(result: PlacementResult, floor: number): string | null {
  if (result.spam === true || result.placement === 'spam') {
    return 'Spam placement. A seed or weekly placement test landed in Spam.';
  }
  if (result.primaryRate == null || result.sample <= 0) return null;
  if (result.primaryRate < floor) {
    return `Primary placement ${(100 * result.primaryRate).toFixed(0)}% is below ${(100 * floor).toFixed(0)}%`;
  }
  return null;
}

/** Cold room left after warmup, never above the cold allowance and never negative. */
export function coldSendRoom(allowance: number, warmupDaily: number, combinedCeiling = COLD_COMBINED_DAILY): number {
  const warm = Math.max(0, Math.floor(warmupDaily));
  const ceiling = Math.max(0, Math.floor(combinedCeiling));
  return Math.max(0, Math.min(Math.max(0, allowance), ceiling - warm));
}

/** Company domain of a recipient, or null for a free inbox (Gmail, Outlook, Yahoo, and the rest of FREE_MAIL). */
export function recipientCompanyDomain(email: string): string | null {
  const domain = domainOf(email);
  if (!domain || FREE_MAIL.has(domain)) return null;
  return domain;
}

/** Buyer assignee, else the rep the inbox sends as, else the buyer record's owner, else the workspace owner. */
export function replyOwner(input: { buyerAssignedTo?: string | null; mailboxUserId?: string | null; buyerOwnerId?: string | null; workspaceOwnerId?: string | null }): string | null {
  const id = input.buyerAssignedTo || input.mailboxUserId || input.buyerOwnerId || input.workspaceOwnerId || '';
  return id.trim() ? id.trim() : null;
}

/**
 * The rep a replying contact gets assigned to: the inbox's rep, when nobody
 * had the contact and a person answered (not a bounce, unsubscribe,
 * out-of-office or complaint).
 */
export function assignOnReply(input: { buyerAssignedTo?: string | null; mailboxUserId?: string | null; classification: string; complaint: boolean }): string | null {
  const rep = input.mailboxUserId?.trim() ?? '';
  if (input.buyerAssignedTo || !rep || input.complaint) return null;
  return ['bounce', 'unsubscribe', 'out_of_office'].includes(input.classification) ? null : rep;
}

const DNS_FRESH_MS = 7 * 86_400_000;

/**
 * Weekly-step ramp for the cold pool only: ramp_start for the first week,
 * then even steps a week apart up to the cap at rampDays (5, 10, 15, then 20
 * on the defaults). Never over COLD_DAILY_CAP, whatever the mailbox or the
 * workspace ceiling says. The shared dailyAllowance used by Gmail and Resend
 * is unchanged. Jitter only lowers the number.
 */
export function coldDailyAllowance(m: MailboxSettings, today: string, opts?: { ceiling?: number; rampDays?: number; jitterPct?: number; mailboxId?: number }): number {
  const ceiling = Math.max(1, Math.min(COLD_DAILY_CAP, opts?.ceiling ?? COLD_DAILY_CAP));
  const cap = Math.max(1, Math.min(m.daily_cap, m.ramp_target, ceiling));
  let base = cap;
  if (m.ramp_enabled) {
    const steps = Math.max(1, Math.round(Math.max(1, opts?.rampDays ?? COLD_RAMP_DAYS) / 7));
    const start = Math.max(1, Math.min(m.ramp_start, cap));
    const progress = Math.min(1, Math.floor(rampDay(m, today) / 7) / steps);
    base = Math.max(1, Math.min(cap, Math.round(start + (cap - start) * progress)));
  }
  const jitterPct = opts?.jitterPct ?? 0;
  if (jitterPct <= 0 || opts?.mailboxId == null) return base;
  const roll = seeded(gapSeed(opts.mailboxId, `allowance|${today}`))();
  const cut = Math.floor(base * (jitterPct / 100) * roll);
  return Math.max(1, Math.min(cap, base - cut));
}

/** One weekday off, stable per mailbox, Monday through Friday. */
export function mailboxRestWeekday(mailboxId: number): number {
  return (Math.abs(mailboxId) % 5) + 1;
}

export function mailboxResting(m: ColdMailbox, now: Date, policy: ColdDeliverability = DEFAULT_COLD_DELIVERABILITY): boolean {
  if (!policy.restDays) return false;
  const wd = localParts(now, m.settings.timezone || 'America/Chicago').weekday;
  const rest = m.restWeekday == null ? mailboxRestWeekday(m.id) : m.restWeekday;
  return wd === rest;
}

export function effectiveWindow(w: ColdWindow, policy: ColdDeliverability = DEFAULT_COLD_DELIVERABILITY): ColdWindow {
  if (!policy.skipWeekends) return w;
  const days = w.days.filter((d) => d !== 0 && d !== 6);
  return { ...w, days: days.length ? days : [1, 2, 3, 4, 5] };
}

const CONSUMER_GMAIL = new Set(['gmail.com', 'googlemail.com']);
const CONSUMER_OUTLOOK = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk']);

/** gmail.com and googlemail.com are consumer Gmail. A Google MX on any other domain is Google Workspace. */
export function recipientProvider(email: string, mxHint?: string | null): RecipientProvider {
  const domain = domainOf(email);
  if (CONSUMER_GMAIL.has(domain)) return 'gmail';
  if (CONSUMER_OUTLOOK.has(domain)) return 'outlook';
  const mx = (mxHint ?? '').toLowerCase();
  if (mx.includes('google') || mx.includes('gmail') || mx.includes('googlemail')) return 'google_workspace';
  if (mx.includes('outlook') || mx.includes('microsoft') || mx.includes('protection.outlook')) return 'outlook';
  return 'other';
}

/** True when this provider already has its share of today's allowance. */
export function providerSpreadFull(sentToProvider: number, allowance: number, share: number): boolean {
  if (!(share > 0) || share >= 1) return false;
  const limit = Math.max(1, Math.ceil(allowance * share));
  return sentToProvider >= limit;
}

export function isRoleAddress(email: string): boolean {
  const local = (email.split('@')[0] ?? '').split('+')[0].trim().toLowerCase();
  return (ROLE_LOCAL_PARTS as readonly string[]).includes(local);
}

export function isCatchAllStatus(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'catch_all';
}

export type MailboxSkip = 'paused' | 'status' | 'warming' | 'blocked_domain' | 'domain_paused' | 'domain_unchecked' | 'domain_blocking' | 'domain_stale' | 'daily_cap' | 'hourly_cap' | 'domain_cap' | 'gap' | 'resting' | 'provider_spread';

export function mailboxSkip(m: ColdMailbox, domain: ColdDomain | undefined, blocked: readonly string[], now: Date, policy: ColdDeliverability = DEFAULT_COLD_DELIVERABILITY, recipient?: RecipientProvider): MailboxSkip | null {
  if (m.paused || m.status === 'paused') return 'paused';
  if (m.status !== 'active' && m.status !== 'warming') return 'status';
  if (m.status === 'warming' && m.warmupGated) return 'warming';
  if (sendingDomainBlocked(m.email, blocked) || sendingDomainBlocked(m.domain, blocked)) return 'blocked_domain';
  if (!domain || domain.paused) return 'domain_paused';
  if (!domain.checkedAt) return 'domain_unchecked';
  if (domain.blocking.length) return 'domain_blocking';
  if (Date.parse(domain.checkedAt) < now.getTime() - DNS_FRESH_MS) return 'domain_stale';
  const today = localParts(now, m.settings.timezone || 'America/Chicago').date;
  const rampAllowance = coldDailyAllowance(m.settings, today, {
    ceiling: policy.dailyCeiling, rampDays: policy.rampDays, jitterPct: policy.jitterPct, mailboxId: m.id,
  });
  const allowance = coldSendRoom(rampAllowance, m.warmupDaily ?? policy.warmupDaily, policy.combinedDailyCeiling);
  if (allowance <= 0 || m.sentToday >= allowance) return 'daily_cap';
  if (m.sentLastHour >= m.settings.hourly_cap) return 'hourly_cap';
  if (domain.sentToday >= domain.dailyCap) return 'domain_cap';
  const gap = mailboxGapSeconds(m, now, policy);
  if (gap > 0 && m.lastSentAt && Date.parse(m.lastSentAt) + gap * 1000 > now.getTime()) return 'gap';
  if (mailboxResting(m, now, policy)) return 'resting';
  if (recipient && providerSpreadFull(m.sentByProvider?.[recipient] ?? 0, allowance, policy.providerShare)) return 'provider_spread';
  return null;
}

/**
 * Seconds to wait after this mailbox's previous send. The same mailbox id
 * and previous timestamp always return the same gap, so the planner and
 * cold_send_claim cannot disagree. Default range is 4 to 11 minutes.
 */
export function sendGapSeconds(mailboxId: number, lastSentAt: string, minSeconds = COLD_GAP_MIN_SECONDS, maxSeconds = COLD_GAP_MAX_SECONDS): number {
  const min = Math.max(0, Math.floor(minSeconds));
  const max = Math.max(min, Math.floor(maxSeconds));
  const roll = seeded(gapSeed(mailboxId, lastSentAt))();
  return min + Math.floor(roll * (max - min + 1));
}

export function mailboxGapSeconds(m: ColdMailbox, now: Date, policy: ColdDeliverability = DEFAULT_COLD_DELIVERABILITY): number {
  if (!m.lastSentAt) return 0;
  void now;
  const min = Math.min(policy.gapMaxSeconds, Math.max(policy.gapMinSeconds, m.settings.min_gap_seconds || 0));
  const max = Math.max(min, policy.gapMaxSeconds);
  return sendGapSeconds(m.id, m.lastSentAt, min, max);
}

function gapSeed(mailboxId: number, lastSentAt: string): number {
  const s = `${mailboxId}|${lastSentAt}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Next healthy mailbox in rotation. `cursor` advances one prospect at a time. */
export function pickPoolMailbox(mailboxes: readonly ColdMailbox[], domains: readonly ColdDomain[], blocked: readonly string[], cursor: number, now: Date, policy: ColdDeliverability = DEFAULT_COLD_DELIVERABILITY, recipient?: RecipientProvider): { mailbox: ColdMailbox; skips: MailboxSkip[] } | null {
  const byDomain = new Map(domains.map((d) => [d.id, d]));
  const ordered = [...mailboxes].sort((a, b) => a.id - b.id);
  const skips: MailboxSkip[] = [];
  const open: ColdMailbox[] = [];
  for (const m of ordered) {
    const why = mailboxSkip(m, byDomain.get(m.domainId), blocked, now, policy, recipient);
    if (why) skips.push(why);
    else open.push(m);
  }
  const spun = cycleOrder(open, cursor);
  const mailbox = spun[0];
  return mailbox ? { mailbox, skips } : null;
}

export type StopStatus = 'replied' | 'bounced' | 'unsubscribed' | 'suppressed' | 'completed' | 'stopped';

/** Why an enrollment must not be sent, before a mailbox is chosen. */
export function sequenceStop(e: {
  status: string;
  suppressed: boolean;
  safety: EmailSafety;
  requireVerified: boolean;
  stepsLeft: boolean;
  email?: string;
  verificationStatus?: string | null;
  suppressRoles?: boolean;
  suppressCatchAll?: boolean;
}): { status: StopStatus; reason: string } | null {
  if (e.status === 'replied') return { status: 'replied', reason: 'Prospect replied.' };
  if (e.status === 'bounced') return { status: 'bounced', reason: 'Address bounced.' };
  if (e.status === 'unsubscribed') return { status: 'unsubscribed', reason: 'Prospect unsubscribed.' };
  if (e.status === 'suppressed' || e.suppressed) return { status: 'suppressed', reason: 'Address is on the suppression list.' };
  if (e.status === 'completed' || (e.status === 'active' && !e.stepsLeft)) return { status: 'completed', reason: 'Sequence finished.' };
  if (e.status !== 'active') return { status: 'stopped', reason: `Enrollment is ${e.status}.` };
  if ((e.suppressRoles ?? true) && e.email && isRoleAddress(e.email)) {
    return { status: 'suppressed', reason: 'Role addresses such as info@ and admin@ are suppressed.' };
  }
  if ((e.suppressCatchAll ?? true) && isCatchAllStatus(e.verificationStatus)) {
    return { status: 'suppressed', reason: 'Catch-all addresses are suppressed.' };
  }
  if (coldAudienceBlocked(e.safety, e.requireVerified)) {
    return e.safety === 'unsafe'
      ? { status: 'stopped', reason: 'Address failed email verification and is not safe to send.' }
      : { status: 'stopped', reason: 'Address is not verified, and this workspace only sends bulk mail to a verified address.' };
  }
  return null;
}

export type ColdPlan =
  | { action: 'stop'; status: StopStatus; reason: string }
  | { action: 'wait'; nextAt: string; reason: string }
  | {
    action: 'send';
    mailboxId: number;
    from: string;
    subject: string;
    body: string;
    variant: string | null;
    inReplyTo: string | null;
    stepPosition: number;
    bodyHash: string;
    recipientProvider: RecipientProvider;
    trackingDomain: string | null;
    warnings: string[];
  };

export type RecentBody = { hash: string; sentAt: string };

export function planColdSend(input: {
  now: Date;
  enrollment: {
    id: number;
    status: string;
    email: string;
    state: string | null;
    stepPosition: number;
    lastSentAt: string | null;
    enrolledAt: string;
    threadMessageId: string | null;
    suppressed: boolean;
    safety: EmailSafety;
    verificationStatus?: string | null;
    mxHint?: string | null;
    /** Mailbox that sent step 1. Follow-ups stay on it. */
    pinnedMailboxId?: number | null;
    /** Another campaign in this workspace already has this address active. */
    otherSequence?: boolean;
  };
  steps: readonly ColdStep[];
  campaign: { status: string; window: ColdWindow; fallbackTimezone: string };
  mailboxes: readonly ColdMailbox[];
  domains: readonly ColdDomain[];
  blockedDomains: readonly string[];
  requireVerified: boolean;
  cursor: number;
  fields: Record<string, string | null | undefined>;
  policy?: ColdDeliverability;
  recentBodies?: readonly RecentBody[];
  /** Cold sends already made today to this recipient's company domain. Ignored for free inboxes. */
  recipientDomainSentToday?: number;
}): ColdPlan {
  if (input.campaign.status === 'paused') {
    return { action: 'wait', nextAt: new Date(input.now.getTime() + 3_600_000).toISOString(), reason: 'Campaign is paused.' };
  }
  if (input.campaign.status === 'draft' || input.campaign.status === 'done') {
    return { action: 'stop', status: 'stopped', reason: `Campaign is ${input.campaign.status}.` };
  }
  const policy = input.policy ?? DEFAULT_COLD_DELIVERABILITY;
  const step = input.steps.find((s) => s.position === input.enrollment.stepPosition);
  const stop = sequenceStop({
    status: input.enrollment.status,
    suppressed: input.enrollment.suppressed,
    safety: input.enrollment.safety,
    requireVerified: input.requireVerified,
    stepsLeft: !!step,
    email: input.enrollment.email,
    verificationStatus: input.enrollment.verificationStatus,
    suppressRoles: policy.suppressRoles,
    suppressCatchAll: policy.suppressCatchAll,
  });
  if (stop) return { action: 'stop', ...stop };
  if (input.enrollment.otherSequence) {
    return { action: 'stop', status: 'suppressed', reason: 'This address already has an active sequence from another campaign.' };
  }

  const zone = zoneForState(input.enrollment.state, input.campaign.fallbackTimezone);
  const window = effectiveWindow(input.campaign.window, policy);
  const anchor = new Date(input.enrollment.lastSentAt ?? input.enrollment.enrolledAt);
  const ready = businessWindowOpen(anchor, step!.delayBusinessDays, zone, window);
  if (input.now.getTime() < ready.getTime()) {
    const open = inRecipientWindow(ready, zone, window) ? ready : nextRecipientWindow(ready, zone, window);
    return { action: 'wait', nextAt: (open ?? ready).toISOString(), reason: `Step ${step!.position} waits ${step!.delayBusinessDays} business day(s).` };
  }
  if (!inRecipientWindow(input.now, zone, window)) {
    const open = nextRecipientWindow(input.now, zone, window);
    return { action: 'wait', nextAt: (open ?? new Date(input.now.getTime() + 3_600_000)).toISOString(), reason: `Outside the recipient's sending window (${zone}).` };
  }
  const company = recipientCompanyDomain(input.enrollment.email);
  if (company && (input.recipientDomainSentToday ?? 0) >= policy.recipientDomainDailyCap) {
    const later = new Date(input.now.getTime() + 20 * 3_600_000);
    const open = nextRecipientWindow(later, zone, window);
    return {
      action: 'wait',
      nextAt: (open ?? later).toISOString(),
      reason: `${company} already received ${policy.recipientDomainDailyCap} cold email(s) today.`,
    };
  }
  const lint = lintColdCopy({ stepPosition: step!.position, subject: step!.subject, body: step!.body, fields: input.fields, policy });
  for (const variant of step!.variants) {
    const extra = lintColdCopy({ stepPosition: step!.position, subject: variant.subject, body: variant.body, fields: input.fields, policy });
    lint.score = Math.max(lint.score, extra.score);
    lint.blocks.push(...extra.blocks);
    lint.warnings.push(...extra.warnings);
    lint.ok = lint.ok && extra.ok;
  }
  if (!lint.ok) {
    return { action: 'wait', nextAt: new Date(input.now.getTime() + 6 * 3_600_000).toISOString(), reason: lint.blocks[0] ?? 'Copy failed the pre-send check.' };
  }
  const provider = recipientProvider(input.enrollment.email, input.enrollment.mxHint);
  const pinnedId = input.enrollment.pinnedMailboxId ?? null;
  const pool = pinnedId ? input.mailboxes.filter((m) => m.id === pinnedId) : input.mailboxes;
  if (pinnedId && !pool.length) {
    return { action: 'wait', nextAt: new Date(input.now.getTime() + 3_600_000).toISOString(), reason: 'The mailbox that started this sequence is not in the pool.' };
  }
  const picked = pickPoolMailbox(pool, input.domains, input.blockedDomains, pinnedId ? 0 : input.cursor, input.now, policy, provider);
  if (!picked) {
    const open = nextRecipientWindow(new Date(input.now.getTime() + 900_000), zone, window);
    const why = pinnedId
      ? 'The mailbox that started this sequence has no room under its cap, ramp, warmup reserve, rest day, or gap.'
      : 'No healthy mailbox has room under its cap, ramp, warmup reserve, domain cap, rest day, provider spread, or blocked-domain rule.';
    return { action: 'wait', nextAt: (open ?? new Date(input.now.getTime() + 3_600_000)).toISOString(), reason: why };
  }
  const followUp = isThreadedFollowUp(step!.position, input.enrollment.threadMessageId);
  const windowMs = policy.bodyRepeatWindowMinutes * 60_000;
  let chosen: { subject: string; body: string; variant: string | null } | null = null;
  let hash = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const rendered = renderStep(step!, input.enrollment.id * 1000 + step!.position + attempt * 97, input.fields);
    const subject = replySubject(rendered.subject, followUp);
    const h = bodyFingerprint(subject, rendered.body);
    if (!bodyTooCommon(h, input.recentBodies ?? [], input.now, policy.bodyRepeatLimit, windowMs)) {
      chosen = { subject, body: rendered.body, variant: rendered.variant };
      hash = h;
      break;
    }
  }
  if (!chosen) {
    return { action: 'wait', nextAt: new Date(input.now.getTime() + windowMs).toISOString(), reason: 'That copy was just sent to several people. Waiting for a different variant.' };
  }
  const domain = input.domains.find((d) => d.id === picked.mailbox.domainId);
  return {
    action: 'send',
    mailboxId: picked.mailbox.id,
    from: picked.mailbox.email,
    subject: chosen.subject,
    body: chosen.body,
    variant: chosen.variant,
    inReplyTo: followUp ? input.enrollment.threadMessageId : null,
    stepPosition: step!.position,
    bodyHash: hash,
    recipientProvider: provider,
    trackingDomain: policy.clickTracking ? (domain?.trackingDomain?.trim() || null) : null,
    warnings: lint.warnings,
  };
}

const UNSUB = /\b(unsubscribe|remove me|opt[\s-]?out|stop emailing|take me off|do not (email|contact)|don't (email|contact))\b/i;
const OOO = /\b(out of (the )?office|automatic reply|auto[\s-]?reply|away from|on vacation|ooo\b|i am currently out)\b/i;
const NOT_INTERESTED = /\b(not interested|no thanks|no thank you|not a fit|not for (me|us)|pass on this|remove\b|do not contact)\b/i;
const INTERESTED = /\b(interested|send (me )?(the )?(info|details|numbers)|tell me more|let'?s talk|call me|i('m| am) available|yes please)\b/i;
const COMPLAINT = /\b(this is spam|marked as spam|junk mail|reported as spam)\b/i;

/** Rules first. Bounce, then unsubscribe, then out of office, then not interested, then interested. */
export function classifyReply(input: { from: string; subject: string; body: string }): ReplyClass {
  const from = input.from ?? '';
  const subject = input.subject ?? '';
  const body = input.body ?? '';
  const blob = `${subject}\n${body}`;
  const bounce = parseBounce(from, {}, blob) ?? (/mailer-daemon|postmaster@/i.test(from) || /\b(undeliverable|delivery status notification|delivery has failed)\b/i.test(blob) ? { hard: true } : null);
  if (bounce) return 'bounce';
  if (UNSUB.test(blob) || COMPLAINT.test(blob)) return 'unsubscribe';
  if (OOO.test(blob)) return 'out_of_office';
  if (NOT_INTERESTED.test(blob)) return 'not_interested';
  if (INTERESTED.test(blob)) return 'interested';
  return 'other';
}

export function countsAsComplaint(input: { from: string; subject: string; body: string }): boolean {
  return COMPLAINT.test(`${input.subject ?? ''}\n${input.body ?? ''}`);
}

export type PolledMessage = { from: string; inReplyTo: string | null; subject: string; providerId: string };

export type SendRef = { id: number; toEmail: string; rfcMessageId: string | null; enrollmentId: number };

export type WarmupSignal = {
  subject?: string;
  body?: string;
  headers?: Record<string, string> | null;
  labels?: readonly string[] | null;
  folder?: string | null;
};

/**
 * Instantly warms the same inboxes on its own network. Those messages are
 * not prospect replies. The warmup ID is a tag the owner pastes: Instantly
 * puts it in the subject and at the bottom of the body, and either place
 * is enough. An Instantly warmup header, the Warmup label, the Instantly
 * Warmup folder, or the same short code in the subject and on the last line
 * are extra filters for mail that arrives before the tag is saved.
 */
export function isInstantlyWarmup(msg: WarmupSignal, tag?: string | null): boolean {
  if (warmupPlace(msg.folder)) return true;
  for (const label of msg.labels ?? []) if (warmupPlace(label)) return true;
  const headers = msg.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (warmupHeader(name, value)) return true;
  }
  const configured = (tag ?? '').trim();
  if (configured.length >= 4) {
    const blob = `${msg.subject ?? ''}\n${msg.body ?? ''}\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
    if (blob.toLowerCase().includes(configured.toLowerCase())) return true;
  }
  return warmupSubjectCode(msg.subject ?? '', msg.body ?? '');
}

function warmupPlace(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase().replace(/^\[gmail\]\//, '').replace(/^inbox[./]/, '');
  if (!n || n.startsWith('\\')) return false;
  return (INSTANTLY_WARMUP_FOLDERS as readonly string[]).includes(n) || n.endsWith('/warmup') || n.endsWith('/instantly warmup');
}

function warmupHeader(name: string, value: string): boolean {
  const n = name.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (n === 'x-instantly' || n === 'x-instantly-warmup' || n === 'x-warmup' || n === 'x-warm-up' || n === 'x-mailwarm') return true;
  if (n.startsWith('x-') && n.includes('warmup')) return true;
  if (n.includes('instantly') && v.includes('warm')) return true;
  if (v.includes('instantly') && v.includes('warmup')) return true;
  return false;
}

/** Instantly puts its code in the subject and again on the last line of the body. */
function warmupSubjectCode(subject: string, body: string): boolean {
  const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] ?? '').replace(/^["']|["']$/g, '');
  if (last.length < 5 || last.length > 40) return false;
  if (/[.!?]/.test(last)) return false;
  const code = /^(?=.*\d)[A-Za-z0-9]{5,16}$/.test(last) || /^[A-Za-z]{3,}-[A-Za-z]{3,}$/.test(last);
  if (!code) return false;
  return subject.toLowerCase().includes(last.toLowerCase());
}

export type ProspectReply =
  | { stop: false; reason: 'warmup' | 'unmatched' }
  | { stop: true; send: SendRef; classification: ReplyClass };

/**
 * Warmup mail never matches a send and is never classified. Anything else
 * uses In-Reply-To, then the From address, then the reply rules.
 */
export function prospectReply(msg: PolledMessage & WarmupSignal & { body?: string }, sends: readonly SendRef[], tag?: string | null): ProspectReply {
  if (isInstantlyWarmup(msg, tag)) return { stop: false, reason: 'warmup' };
  const hit = matchReply(msg, sends);
  if (!hit) return { stop: false, reason: 'unmatched' };
  return { stop: true, send: hit, classification: classifyReply({ from: msg.from, subject: msg.subject, body: msg.body ?? '' }) };
}

/** In-Reply-To wins. Otherwise the newest send to that From address. */
export function matchReply(msg: PolledMessage, sends: readonly SendRef[]): SendRef | null {
  const ref = (msg.inReplyTo ?? '').replace(/[<>]/g, '').trim().toLowerCase();
  if (ref) {
    const hit = sends.find((s) => (s.rfcMessageId ?? '').replace(/[<>]/g, '').trim().toLowerCase() === ref);
    if (hit) return hit;
  }
  const from = msg.from.trim().toLowerCase();
  const candidates = sends.filter((s) => s.toEmail.trim().toLowerCase() === from);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

export type HealthCounts = { sent: number; bounced: number; replied: number; complaints: number };

export function healthRates(s: HealthCounts): { bounceRate: number; replyRate: number; complaintRate: number } {
  const d = s.sent > 0 ? s.sent : 0;
  return {
    bounceRate: d ? s.bounced / d : 0,
    replyRate: d ? s.replied / d : 0,
    complaintRate: d ? s.complaints / d : 0,
  };
}

/**
 * Cold pool pauses tighter than the shared helper: bounce rate over 2% once
 * the sample is large enough, a spam-complaint rate at or above 0.1%, and a
 * reply rate under 1% after the same kind of sample. The shared hard-bounce
 * and unsubscribe rules still apply. One complaint in a week of 20-a-day
 * sending is already over 0.1%.
 */
export function poolPauseReason(s: {
  sent7d: number;
  bounced7d: number;
  hardInLast50: number;
  bulk30d: number;
  unsub30d: number;
  complaints7d: number;
  replied7d?: number;
  policy?: ColdDeliverability;
}): string | null {
  const policy = s.policy ?? DEFAULT_COLD_DELIVERABILITY;
  if (s.sent7d >= policy.bounceMinSample && s.bounced7d / s.sent7d > policy.bouncePauseRate) {
    return `bounce rate ${(100 * s.bounced7d / s.sent7d).toFixed(1)}% over 7 days (limit ${(100 * policy.bouncePauseRate).toFixed(1)}%)`;
  }
  const base = autoPauseReason({ sent7d: s.sent7d, bounced7d: s.bounced7d, hardInLast50: s.hardInLast50, bulk30d: s.bulk30d, unsub30d: s.unsub30d });
  if (base) return base;
  if (policy.anyComplaintPauses && s.complaints7d > 0) {
    const rate = s.sent7d > 0 ? s.complaints7d / s.sent7d : 1;
    if (rate >= policy.complaintPauseRate) {
      const shown = s.sent7d > 0 ? `${(100 * rate).toFixed(2)}%` : 'a complaint before any measured sends';
      return `spam complaint rate ${shown} over 7 days (target under ${(100 * policy.complaintPauseRate).toFixed(1)}%)`;
    }
  }
  const replied = s.replied7d ?? 0;
  if (s.sent7d >= policy.lowReplySample && replied / s.sent7d < policy.lowReplyRate) {
    return `reply rate ${(100 * replied / s.sent7d).toFixed(1)}% over 7 days (floor ${(100 * policy.lowReplyRate).toFixed(1)}%)`;
  }
  return null;
}

export type CsvMailbox = {
  email: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
};

export type CsvSkip = { line: number; email: string; reason: string };

/**
 * Google shows an app password as four groups of four letters. The SMTP
 * server wants the sixteen letters with the spaces removed.
 */
export function normalizeMailboxPassword(raw: string): string {
  const t = raw.trim();
  if (/^[a-z]{4}(?: [a-z]{4}){3}$/i.test(t)) return t.replace(/ /g, '');
  return t;
}

/**
 * SMTP/IMAP rows, aimed at a Google Workspace export (InboxKit): email and
 * an app password are enough. Blank hosts become smtp.gmail.com:587 and
 * imap.gmail.com:993. One bad row is skipped. Password columns stay out of
 * any later response.
 */
export function parseMailboxCsv(text: string): { ok: true; rows: CsvMailbox[]; skipped: CsvSkip[] } | { ok: false; error: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: false, error: 'The file needs a header row and at least one mailbox.' };
  if (lines.length - 1 > 500) return { ok: false, error: 'Import at most 500 mailboxes at a time.' };
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const emailAt = idx(['email', 'email_address', 'e_mail', 'from', 'address', 'mailbox', 'inbox', 'user_email']);
  if (emailAt < 0) return { ok: false, error: 'The header needs an email column.' };
  const rows: CsvMailbox[] = [];
  const skipped: CsvSkip[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]);
    const email = (cols[emailAt] ?? '').trim().toLowerCase();
    const cell = (names: string[]) => {
      const at = idx(names);
      return at < 0 ? '' : (cols[at] ?? '').trim();
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped.push({ line: i + 1, email, reason: 'No email address.' });
      continue;
    }
    const smtpPassword = normalizeMailboxPassword(cell(['smtp_password', 'password', 'app_password', 'smtp_app_password', 'google_app_password', 'app_pass', 'mailbox_password']));
    if (!smtpPassword) {
      skipped.push({ line: i + 1, email, reason: 'App password is required.' });
      continue;
    }
    const imapPassword = normalizeMailboxPassword(cell(['imap_password'])) || smtpPassword;
    const smtpHostRaw = cell(['smtp_host', 'host', 'smtp_server']);
    const google = !smtpHostRaw || /(?:^|\.)gmail\.com$/i.test(smtpHostRaw) || /(?:^|\.)googlemail\.com$/i.test(smtpHostRaw);
    const smtpHost = smtpHostRaw || GOOGLE_WORKSPACE_SMTP.host;
    const smtpPort = Number(cell(['smtp_port', 'port'])) || (google ? GOOGLE_WORKSPACE_SMTP.port : 587);
    const imapHost = cell(['imap_host', 'imap_server']) || (google ? GOOGLE_WORKSPACE_IMAP.host : smtpHost);
    const imapPort = Number(cell(['imap_port'])) || GOOGLE_WORKSPACE_IMAP.port;
    const first = cell(['first_name', 'first']);
    const last = cell(['last_name', 'last']);
    const displayName = cell(['display_name', 'name', 'from_name', 'full_name']) || [first, last].filter(Boolean).join(' ');
    const username = cell(['smtp_username', 'smtp_user', 'username', 'user']) || email;
    rows.push({
      email,
      displayName,
      smtpHost,
      smtpPort,
      smtpUsername: username,
      smtpPassword,
      imapHost,
      imapPort,
      imapUsername: cell(['imap_username', 'imap_user']) || username,
      imapPassword,
    });
  }
  return { ok: true, rows, skipped };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export type AudienceBuyer = {
  email: string | null;
  status: string | null;
  tags: string[];
  markets: string[];
  state?: string | null;
  buyerType: string | null;
  entityType: string | null;
  archivedAt: string | null;
  blacklistedAt: string | null;
  phone: string | null;
  /** Display name of the assigned rep, or empty when nobody owns the buyer. */
  ownerName?: string | null;
};

export type AudienceSpec =
  | { kind: 'tag'; tag: string }
  | { kind: 'saved_view'; config: { filters?: Record<string, string>; geniusOnly?: boolean } };

/** A buyer is in the campaign when the tag matches, or the saved Buyers view's filters do. */
export function buyerInAudience(b: AudienceBuyer, audience: AudienceSpec): boolean {
  if (b.archivedAt || b.blacklistedAt) return false;
  const email = (b.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (audience.kind === 'tag') {
    const tag = audience.tag.trim().toLowerCase();
    return !!tag && b.tags.some((t) => t.trim().toLowerCase() === tag);
  }
  const f = audience.config.filters ?? {};
  const any = (v?: string) => !v || v === 'Any';
  if (!any(f.buyerStatus) && (b.status ?? '') !== f.buyerStatus) return false;
  if (!any(f.buyerType) && (b.buyerType ?? '') !== f.buyerType) return false;
  if (!any(f.buyerEntity) && (b.entityType ?? '') !== f.buyerEntity) return false;
  if (!any(f.buyerState)) {
    const st = stateOf(b.state, b.markets);
    const want = f.buyerState.trim().toLowerCase();
    if (st?.toLowerCase() !== want && !b.markets.some((m) => m.toLowerCase().includes(want))) return false;
  }
  if (!any(f.buyerCity) && !b.markets.some((m) => m.toLowerCase().includes(f.buyerCity.trim().toLowerCase()))) return false;
  if (f.buyerEmail === 'Has email' && !email) return false;
  if (f.buyerEmail === 'No email') return false;
  if (f.buyerPhone === 'Has phone' && (b.phone ?? '').replace(/\D/g, '').length < 7) return false;
  if (f.buyerPhone === 'No phone' && (b.phone ?? '').replace(/\D/g, '').length >= 7) return false;
  if (!any(f.buyerOwner)) {
    const want = f.buyerOwner.trim();
    const owner = (b.ownerName ?? '').trim();
    if (want === 'Unassigned' ? !!owner : owner !== want) return false;
  }
  if (audience.config.geniusOnly && !b.tags.some((t) => t.trim().toLowerCase() === 'genius')) return false;
  return true;
}

/** Day boundary for a mailbox cap, so the worker and the claim agree. */
export function mailboxDayStart(m: MailboxSettings, now: Date): Date {
  return dayStartUtc(now, m.timezone || 'America/Chicago');
}
