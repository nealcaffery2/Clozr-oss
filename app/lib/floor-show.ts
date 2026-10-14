// The floor show: badges, daily passes, a signed contract, and one spin.
//
// Pure. The screen decides who sees what and how loud it is. Numbers come
// from the same leaderboard engine as the board, after any bulk-import reset.

import { BADGES, type BadgeDef, type LeaderboardRaw, type SalesPerson, badgesFor, buildBadgeContext, buildLeaderboard, getCalls, periodRange, qualifies } from './leaderboard';

export type PassMetric = 'calls' | 'offers' | 'talk';

export type DayStat = {
  id: string;
  name: string;
  calls: number;
  offers: number;
  talk: number;
};

export type BadgeHit = {
  personId: string;
  person: string;
  badge: BadgeDef;
  /** Which run of the badge this is (`this-week:2026-09-28`), so earning it again next week announces again. */
  window?: string;
};

export type SignedContract = {
  /** Stable id: `contract:12` or `mail:ct9`. */
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string;
  source: 'esign' | 'email';
};

export type FloorSnap = {
  seeded: boolean;
  /**
   * Every badge already announced in a run still open (`furniture@last-7-days:2026-09-28`),
   * not just the ones held right now, so a badge that drops off and comes back inside the
   * same run does not announce twice. A run that has ended drops out.
   */
  badges: Record<string, string[]>;
  stats: Record<string, { calls: number; offers: number; talk: number }>;
  /** The day `stats` were counted on (`today:2026-10-02`); a pass is only judged against the same day. */
  day?: string;
  contracts: string[];
};

export type FloorEvent =
  | { id: string; kind: 'badge'; tier: 'good' | 'shame'; personId: string; person: string; badgeId: string; badgeName: string; hint: string; image: string }
  | { id: string; kind: 'pass'; metric: PassMetric; passerId: string; passer: string; passedId: string; passed: string; value: string }
  | { id: string; kind: 'contract'; contractId: string; title: string; ownerId: string | null; ownerName: string; source: 'esign' | 'email' }
  | { id: string; kind: 'nudge'; text: string }
  /** Badges earned while this screen was closed, gathered into one quiet toast on the way in. */
  | { id: string; kind: 'digest'; text: string };

export const EMPTY_SNAP: FloorSnap = { seeded: false, badges: {}, stats: {}, contracts: [] };

const METRIC_LABEL: Record<PassMetric, string> = {
  calls: 'calls',
  offers: 'offers',
  talk: 'talk time',
};

export function metricLabel(m: PassMetric): string {
  return METRIC_LABEL[m];
}

export function formatTalk(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function metricValue(row: DayStat, metric: PassMetric): number {
  return metric === 'calls' ? row.calls : metric === 'offers' ? row.offers : row.talk;
}

function formatMetric(metric: PassMetric, value: number): string {
  return metric === 'talk' ? formatTalk(value) : String(value);
}

/** Today’s calls, offers and talk time, one row per rep on the board. */
export function dayStats(raw: LeaderboardRaw, now = Date.now()): DayStat[] {
  const people = buildLeaderboard(raw, 'today', { now }).salesPeople;
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    calls: getCalls(p),
    offers: p.offersMade ?? 0,
    talk: p.totalTalkTime ?? 0,
  }));
}

/**
 * The window each badge is judged over on the floor, matching what its name
 * promises. The board judged every badge over the last 30 days, so a good
 * badge stayed held for a month and announced once (or never, when it was
 * already held the first time this screen loaded), while the shame badges
 * flipped between reps and kept firing. Now a good badge resets with its
 * window and announces each time it is earned again, and a shame badge
 * (a rolling seven days) announces at most once a week.
 */
export type BadgeWindow = 'today' | 'this-week' | 'this-month' | 'last-7-days';
const BADGE_WINDOW: Record<string, BadgeWindow> = {
  'dialing-for-dollars': 'today',
  'blood-in-the-water': 'this-week',
  'deal-reaper': 'this-week',
  arsonist: 'this-week',
  furniture: 'last-7-days',
  casper: 'last-7-days',
  'warm-milk': 'last-7-days',
  'smooth-talker': 'this-week',
  'offer-cannon': 'this-week',
  'buyer-magnet': 'this-week',
  'snail-mail': 'last-7-days',
  // A Friday closing is this week's; the rest of the coordinator's are judged over the month.
  'friday-closer': 'this-week',
};
export function badgeWindow(id: string): BadgeWindow {
  return BADGE_WINDOW[id] ?? 'this-month';
}

const WINDOWS: BadgeWindow[] = ['today', 'this-week', 'this-month', 'last-7-days'];

/** Which run of a window `now` falls in. Shame on a rolling week is keyed by the calendar week, so it fires once a week, not once a day. */
export function windowKey(w: BadgeWindow, now = Date.now()): string {
  const from = w === 'last-7-days' ? 'this-week' : w;
  return `${w}:${new Date(periodRange(from, now).start ?? 0).toISOString().slice(0, 10)}`;
}

/** The runs open right now; a remembered badge from any other run is over. */
export function liveWindows(now = Date.now()): Set<string> {
  return new Set(WINDOWS.map((w) => windowKey(w, now)));
}

/**
 * "#1 for the month" is a ranking, and on the 1st whoever makes the first call
 * leads it. These wait until the month has a week of numbers behind it.
 */
const RANKED_MONTHLY = new Set(['apex-predator', 'triple-crown']);
export const MONTH_SETTLE_DAYS = 7;

/** Every badge held right now, each judged over its own window. */
export function floorBadgeHits(raw: LeaderboardRaw, now = Date.now(), manual: Record<string, string[]> = {}): BadgeHit[] {
  const hits: BadgeHit[] = [];
  const monthStart = periodRange('this-month', now).start ?? 0;
  const monthSettled = now - monthStart >= MONTH_SETTLE_DAYS * 86_400_000;
  for (const w of WINDOWS) {
    const badges = BADGES.filter((b) => badgeWindow(b.id) === w && (monthSettled || !RANKED_MONTHLY.has(b.id)));
    if (!badges.length) continue;
    const people = buildLeaderboard(raw, w, { now }).salesPeople;
    const ctx = buildBadgeContext(people, manual);
    const key = windowKey(w, now);
    for (const p of people) {
      for (const badge of badges) if (qualifies(badge, p, ctx)) hits.push({ personId: p.id, person: p.name, badge, window: key });
    }
  }
  return hits;
}

const hitKey = (h: BadgeHit) => (h.window ? `${h.badge.id}@${h.window}` : h.badge.id);

export function badgeHits(people: SalesPerson[]): BadgeHit[] {
  const ctx = buildBadgeContext(people);
  const hits: BadgeHit[] = [];
  for (const p of people) {
    for (const badge of badgesFor(p, ctx, true)) hits.push({ personId: p.id, person: p.name, badge });
  }
  return hits;
}

/** How many signed-contract ids the snapshot keeps, newest last. */
const CONTRACT_MEMORY = 500;

/**
 * What has been seen, for the next look to diff against. Badges and contracts
 * already announced are kept (badges until their run ends), so one refresh that
 * comes back short — a slow read, a reset still loading — cannot make them new
 * again on the refresh after it.
 */
export function snapFrom(stats: DayStat[], hits: BadgeHit[], contracts: SignedContract[], prev: FloorSnap = EMPTY_SNAP, now = Date.now()): FloorSnap {
  const live = liveWindows(now);
  const badges: FloorSnap['badges'] = {};
  for (const [id, keys] of Object.entries(prev.badges)) {
    const open = keys.filter((k) => live.has(k.slice(k.indexOf('@') + 1)));
    if (open.length) badges[id] = open;
  }
  for (const h of hits) {
    const k = hitKey(h);
    const had = badges[h.personId] ?? [];
    if (!had.includes(k)) badges[h.personId] = [...had, k];
  }
  const rows: FloorSnap['stats'] = {};
  for (const s of stats) rows[s.id] = { calls: s.calls, offers: s.offers, talk: s.talk };
  const seen = [...new Set([...prev.contracts, ...contracts.map((c) => c.id)])].slice(-CONTRACT_MEMORY);
  return { seeded: true, badges, stats: rows, day: windowKey('today', now), contracts: seen };
}

/**
 * Someone passed another rep on a daily metric.
 * A tie does not count, and going from zero to one does not pass people who
 * were also at zero.
 */
export function findPasses(prev: DayStat[], next: DayStat[]): FloorEvent[] {
  const before = new Map(prev.map((p) => [p.id, p]));
  const events: FloorEvent[] = [];
  const metrics: PassMetric[] = ['calls', 'offers', 'talk'];
  for (const metric of metrics) {
    for (const p of next) {
      const was = before.get(p.id);
      if (!was) continue;
      const nowV = metricValue(p, metric);
      const thenV = metricValue(was, metric);
      if (nowV <= thenV) continue;
      for (const other of next) {
        if (other.id === p.id) continue;
        const otherWas = before.get(other.id);
        if (!otherWas) continue;
        const otherThen = metricValue(otherWas, metric);
        const otherNow = metricValue(other, metric);
        if (otherThen > thenV && otherNow < nowV) {
          events.push({
            id: `pass:${metric}:${p.id}:${other.id}:${nowV}`,
            kind: 'pass',
            metric,
            passerId: p.id,
            passer: p.name,
            passedId: other.id,
            passed: other.name,
            value: formatMetric(metric, nowV),
          });
        }
      }
    }
  }
  return events;
}

export function diffFloor(prev: FloorSnap, stats: DayStat[], hits: BadgeHit[], contracts: SignedContract[], now = Date.now()): FloorEvent[] {
  if (!prev.seeded) return [];
  const events: FloorEvent[] = [];
  const knownPeople = new Set([...Object.keys(prev.badges), ...Object.keys(prev.stats)]);
  for (const h of hits) {
    if (!knownPeople.has(h.personId)) continue;
    const had = new Set(prev.badges[h.personId] ?? []);
    if (had.has(hitKey(h))) continue;
    events.push({
      id: `badge:${h.personId}:${hitKey(h)}`,
      kind: 'badge',
      tier: h.badge.tier === 'shame' ? 'shame' : 'good',
      personId: h.personId,
      person: h.person,
      badgeId: h.badge.id,
      badgeName: h.badge.name,
      hint: h.badge.hint,
      image: h.badge.image,
    });
  }
  // Yesterday's totals against today's are not a pass; only the same day counts.
  if (prev.day === windowKey('today', now)) {
    const prevStats: DayStat[] = Object.entries(prev.stats).map(([id, s]) => ({
      id,
      name: stats.find((n) => n.id === id)?.name ?? id,
      calls: s.calls,
      offers: s.offers,
      talk: s.talk,
    }));
    events.push(...findPasses(prevStats, stats));
  }
  const seen = new Set(prev.contracts);
  for (const c of contracts) {
    if (seen.has(c.id)) continue;
    events.push({
      id: `contract:${c.id}`,
      kind: 'contract',
      contractId: c.id,
      title: c.title,
      ownerId: c.ownerId,
      ownerName: c.ownerName,
      source: c.source,
    });
  }
  return events;
}

const PURCHASE = /purchase agreement|purchase contract|assignment contract|assignment agreement|\bpsa\b|purchase and sale/i;
const SIGNED = /fully executed|has been signed|all parties have signed|document completed|completed signing|signed by all|executed by all/i;

/** A purchase or assignment contract the inbox (or a title email) says is signed. */
export function emailLooksSigned(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`.slice(0, 4000);
  return PURCHASE.test(text) && SIGNED.test(text);
}

export type ContractRow = {
  id: number;
  deal_id: number | null;
  kind: string;
  status: string;
  completed_at: string | null;
};

export type MailRow = { id: string; subject: string; body: string; who: string; ownerId: string | null; ownerName: string };

const SKIP_KIND = /offer letter|addendum/i;
const KEEP_KIND = /psa|purchase|assignment|seller|buyer|contract|wholesale/i;

export function signedFromContracts(
  rows: ContractRow[],
  dealOwner: (dealId: number) => { id: string | null; name: string; label: string },
): SignedContract[] {
  const out: SignedContract[] = [];
  for (const c of rows) {
    const status = (c.status || '').toLowerCase();
    if (!/complete|signed|executed/.test(status)) continue;
    if (c.kind && SKIP_KIND.test(c.kind)) continue;
    if (c.kind && !KEEP_KIND.test(c.kind)) continue;
    const who = c.deal_id != null ? dealOwner(c.deal_id) : { id: null, name: 'the team', label: c.kind || 'Contract' };
    out.push({
      id: `contract:${c.id}`,
      title: who.label || c.kind || 'Contract',
      ownerId: who.id,
      ownerName: who.name,
      source: 'esign',
    });
  }
  return out;
}

export function signedFromMail(rows: MailRow[]): SignedContract[] {
  const out: SignedContract[] = [];
  for (const m of rows) {
    if (!emailLooksSigned(m.subject, m.body)) continue;
    out.push({
      id: `mail:${m.id}`,
      title: m.subject || 'Purchase contract',
      ownerId: m.ownerId,
      ownerName: m.ownerName || m.who || 'the team',
      source: 'email',
    });
  }
  return out;
}

// ---- the wheel ----------------------------------------------------------------

export type WheelPrize = { id: string; label: string; weight: number; jackpot?: boolean };

/** Equal chances. The monthly jackpot is the thin slice. */
export const STANDARD_PRIZES: WheelPrize[] = [
  { id: 'gas', label: '$50 gas card', weight: 10 },
  { id: 'starbucks', label: '$20 Starbucks gift card', weight: 10 },
  { id: 'amazon', label: '$50 Amazon gift card', weight: 10 },
  { id: 'topgolf', label: 'Topgolf — 1 hour', weight: 10 },
  { id: 'concert', label: '1 concert ticket', weight: 10 },
  { id: 'grooming', label: 'Nails or a haircut, paid', weight: 10 },
  { id: 'doordash', label: '$25 DoorDash card', weight: 10 },
  { id: 'detail', label: 'A company-paid car wash and detail', weight: 10 },
  { id: 'late-start', label: 'Late start — skip huddle, dial at 10', weight: 10 },
];

export const MONTHLY_SUGGESTIONS = [
  'AirPods',
  'A Meta Quest 3',
  'A domestic plane ticket',
  'Dinner for two',
  'Your choice of company outing',
  'A weekend cabin',
  'A new dialer headset',
  'Box seats for one game',
  'A spa afternoon',
  'A Yeti cooler for the truck',
];

export const DEFAULT_MONTHLY = 'AirPods';

/** How long a monthly prize stays before Settings asks for a new one. */
export const MONTHLY_STALE_MS = 28 * 86_400_000;

export function wheelPrizes(monthly: string): WheelPrize[] {
  const label = monthly.trim() || DEFAULT_MONTHLY;
  return [...STANDARD_PRIZES, { id: 'monthly', label: `Monthly prize — ${label}`, weight: 2, jackpot: true }];
}

export function spinWheel(prizes: WheelPrize[], rnd = Math.random()): { index: number; prize: WheelPrize } {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = Math.min(0.999999, Math.max(0, rnd)) * total;
  for (let i = 0; i < prizes.length; i++) {
    r -= prizes[i].weight;
    if (r < 0) return { index: i, prize: prizes[i] };
  }
  return { index: prizes.length - 1, prize: prizes[prizes.length - 1] };
}

/** Degrees clockwise from the top to the middle of a slice. */
export function sliceMid(prizes: WheelPrize[], index: number): number {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let before = 0;
  for (let i = 0; i < index; i++) before += prizes[i].weight;
  return ((before + prizes[index].weight / 2) / total) * 360;
}

export function monthlyIsStale(updatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true;
  return now - t >= MONTHLY_STALE_MS;
}

export function audienceSees(event: FloorEvent, _me: string | null, admin: boolean): boolean {
  if (admin) return true;
  if (event.kind === 'nudge') return false;
  if (event.kind === 'badge' || event.kind === 'contract' || event.kind === 'pass' || event.kind === 'digest') return true;
  return false;
}

/**
 * The first look after the screen opens is a catch-up on what happened while
 * it was closed. None of it takes over the screen: a pass is stale by then and
 * dropped, and more than two badges fold into one toast.
 */
export function catchUp(events: FloorEvent[], now = Date.now()): FloorEvent[] {
  const badges = events.filter((e): e is Extract<FloorEvent, { kind: 'badge' }> => e.kind === 'badge');
  const contracts = events.filter((e): e is Extract<FloorEvent, { kind: 'contract' }> => e.kind === 'contract');
  const rest = events.filter((e) => e.kind !== 'badge' && e.kind !== 'pass' && e.kind !== 'contract');
  const out: FloorEvent[] = [];
  if (badges.length <= 2) out.push(...badges);
  else out.push(badgeDigest(badges, now, 'while you were away'));
  // A long weekend of signed contracts is one toast, not a stack that pushes each other off screen.
  if (contracts.length <= 2) out.push(...contracts);
  else {
    const named = contracts.slice(0, 3).map((c) => c.title).join(', ');
    const more = contracts.length - 3;
    out.push({ id: `digest:contracts:${new Date(now).toISOString().slice(0, 13)}:${contracts.length}`, kind: 'digest', text: `${contracts.length} contracts signed while you were away: ${named}${more > 0 ? ` and ${more} more` : ''}.` });
  }
  return [...out, ...rest];
}

function badgeDigest(badges: Extract<FloorEvent, { kind: 'badge' }>[], now: number, when: string): FloorEvent {
  const named = badges.slice(0, 3).map((b) => `${b.person} got ${b.badgeName}`).join(', ');
  const more = badges.length - 3;
  return {
    id: `digest:${new Date(now).toISOString().slice(0, 13)}:${badges.length}:${badges[0]?.id ?? ''}`,
    kind: 'digest',
    text: `${badges.length} badges ${when} — ${named}${more > 0 ? ` and ${more} more` : ''}.`,
  };
}

/** How many badges take over the screen from one look at the board; the rest fold into one toast. */
export const LIVE_BADGE_TAKEOVERS = 2;

/**
 * A live look at the board (not the catch-up): at most two badges get the
 * full-screen moment, the rest fold into one quiet toast, so a big refresh never
 * plays ten popups and ten sounds in a row.
 */
export function throttleLive(events: FloorEvent[], now = Date.now(), max = LIVE_BADGE_TAKEOVERS): { loud: FloorEvent[]; quiet: FloorEvent[] } {
  const badges = events.filter((e): e is Extract<FloorEvent, { kind: 'badge' }> => e.kind === 'badge');
  if (badges.length <= max) return { loud: events, quiet: [] };
  const keep = new Set(badges.slice(0, max).map((b) => b.id));
  const folded = badges.slice(max);
  return {
    loud: events.filter((e) => e.kind !== 'badge' || keep.has(e.id)),
    quiet: [badgeDigest(folded, now, 'just now')],
  };
}

/** Away from the board this long, the next look is a quiet catch-up again (a tab left open over a weekend). */
export const CATCH_UP_AFTER_MS = 30 * 60_000;

export function canSpin(event: Extract<FloorEvent, { kind: 'contract' }>, me: string | null, admin: boolean): boolean {
  if (!me) return admin;
  if (event.ownerId && event.ownerId === me) return true;
  return admin && !event.ownerId;
}

/** Badge art for a preview when the gallery image is enough. */
export function badgeById(id: string): BadgeDef | undefined {
  return BADGES.find((b) => b.id === id);
}
