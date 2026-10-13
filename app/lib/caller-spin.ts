/**
 * Caller-ID reputation for live dialing.
 *
 * Mojo and CallTools spread a list across the number pool so one line does
 * not collect every flag. A click-to-call prefers a line in the lead's area
 * code, then the line used least in the last seven days. A power or
 * predictive session does the same without the area code, because the server
 * has not picked the lead yet, and it ignores a dedicated pin so a list
 * cannot burn one number. A pool of one line stays that line.
 *
 * Counts start from Talkr's outbound history and then tick in memory for the
 * rest of this tab, so a burst does not wait on the history endpoint.
 */

import { areaCodeOf, reputationPick, type ReputationLine } from './rvm';
import { stateCode2, stateOfPhone } from './rvm-pool';
import { api } from './talkr-web/api';

export type OrgLine = {
  id: string;
  phone_e164: string;
  area_code?: string | null;
  /**
   * Talkr `GET /v1/numbers` field `provider` (`PhoneNumberDto.provider`).
   * Live dialing keeps only `telnyx`. Missing or any other carrier is out.
   */
  provider?: string | null;
};

/** Shown when a pinned caller ID cannot place a live call and another line is used. */
export const PIN_SKIPPED_NOTICE = 'That caller ID is not a live Telnyx line. This call is using another number. Pick a different caller ID.';

export const NO_LIVE_CALLER_MESSAGE = 'No Telnyx line is available for live calls. A number on another carrier, or with no carrier on file, cannot be used.';

export class NoLiveCallerError extends Error {
  readonly code = 'no_live_caller' as const;
  constructor() {
    super(NO_LIVE_CALLER_MESSAGE);
    this.name = 'NoLiveCallerError';
  }
}

/** True only for Talkr's Telnyx carrier. Twilio and a blank provider are not. */
export function isTelnyxProvider(provider: string | null | undefined): boolean {
  return (provider ?? '').trim().toLowerCase() === 'telnyx';
}

function providerWords(provider: string | null | undefined): string {
  const raw = (provider ?? '').trim();
  if (!raw) return 'Carrier unknown';
  const label = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return `${label} line`;
}

/**
 * Why a line cannot be a live caller ID, or null when it can.
 * RVM-pool lines stay on ringless drops. Anything that is not Telnyx is out,
 * including a line whose carrier was never recorded.
 */
export function liveCallerBlock(
  line: { phone_e164: string; provider?: string | null },
  pools: LinePools | null | undefined,
): string | null {
  const row = pools?.[canonE164(line.phone_e164)] ?? pools?.[line.phone_e164];
  const bits: string[] = [];
  if (!isTelnyxProvider(line.provider)) bits.push(providerWords(line.provider));
  if (row?.pool === 'rvm') bits.push('RVM only');
  if (!bits.length) return null;
  return `${bits.join(', ')}, not for live calls`;
}

/** Copy `provider` from `GET /v1/numbers` onto the org lines the spin already holds. */
export function mergeLineProviders<T extends { id: string; provider?: string | null }>(
  lines: readonly T[],
  numbers: readonly { id: string; provider?: string | null }[],
): T[] {
  const byId = new Map(numbers.map((n) => [n.id, n.provider ?? null]));
  return lines.map((line) => (byId.has(line.id) ? { ...line, provider: byId.get(line.id) ?? null } : line));
}

const WINDOW_MS = 7 * 86_400_000;
const RELOAD_MS = 5 * 60_000;

type Pool = { counts: Record<string, number>; seq: number; loadedAt: number };

const pools = new Map<string, Pool>();

/** Digits to E.164 so a history row and an org line compare as the same number. */
export function canonE164(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return (phone ?? '').trim();
}

/** How many of the last outbound calls each org line placed. */
export function countsFromHistory(lines: readonly OrgLine[], fromNumbers: readonly string[]): Record<string, number> {
  const byE164 = new Map<string, string>();
  for (const line of lines) byE164.set(canonE164(line.phone_e164), line.id);
  const counts: Record<string, number> = {};
  for (const line of lines) counts[line.id] = 0;
  for (const from of fromNumbers) {
    const id = byE164.get(canonE164(from));
    if (id && id in counts) counts[id]++;
  }
  return counts;
}

/** caller_lines.pool and market_state per E.164 (migration 135). Empty before it. */
export type LinePools = Readonly<Record<string, { pool: string | null; state: string | null }>>;

/**
 * Lines worth preferring for a lead in `destState`: dialer-pool lines that
 * serve that state. Only consulted when no line shares the lead's area code,
 * so local presence still wins. Empty when there is nothing to prefer.
 */
export function sameStateDialerLines(lines: readonly OrgLine[], destState: string | null | undefined, pools: LinePools | null | undefined): OrgLine[] {
  const want = stateCode2(destState);
  if (!want || !pools) return [];
  return lines.filter((line) => {
    const p = pools[canonE164(line.phone_e164)];
    if (!p || p.pool !== 'dialer') return false;
    return (stateCode2(p.state) ?? stateOfPhone(line.phone_e164)) === want;
  });
}

export function nextCallerId(
  lines: readonly OrgLine[],
  counts: Readonly<Record<string, number>>,
  dest: string | null | undefined,
  seq = 0,
  prefer?: { destState?: string | null; pools?: LinePools | null },
): { id: string; e164: string } | null {
  if (!lines.length) return null;
  if (lines.length === 1) return { id: lines[0]!.id, e164: lines[0]!.phone_e164 };
  const want = areaCodeOf(dest);
  const local = want ? lines.some((line) => (line.area_code || areaCodeOf(line.phone_e164)) === want) : false;
  const sameState = local ? [] : sameStateDialerLines(lines, prefer?.destState, prefer?.pools);
  const shaped: (ReputationLine & { e164: string })[] = (sameState.length ? sameState : lines).map((line) => ({
    key: line.id,
    e164: line.phone_e164,
    areaCode: line.area_code || areaCodeOf(line.phone_e164),
  }));
  const pick = reputationPick(shaped, counts, dest, seq);
  return pick ? { id: pick.key, e164: pick.e164 } : null;
}

/** Outbound caller IDs from the last seven days. Empty when history is unavailable. */
export async function recentOutboundFromNumbers(): Promise<string[]> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const hist = await api.history({ type: 'calls', direction: 'outbound', from: since, limit: 200 });
  return hist.items.map((item) => item.from_number).filter((n): n is string => !!n);
}

/**
 * The next line to show the lead. `pinId` is a dedicated caller ID and wins
 * for a single click; sessions pass null. The pick is counted immediately.
 */
export type SpinPick = { id: string; e164: string; notice?: string };

export async function spinOrgCallerId(opts: {
  lines: readonly OrgLine[];
  dest?: string | null;
  pinId?: string | null;
  load?: () => Promise<readonly string[]>;
  /** The lead's state (property state, or a buyer's first market), to prefer same-state dialer-pool lines. */
  destState?: string | null;
  /** caller_lines pools; lib/line-pools.ts loads them. RVM-pool lines stay out of live dialing. */
  linePools?: () => Promise<LinePools>;
}): Promise<SpinPick | null> {
  if (!opts.lines.length) return null;
  const linePools = opts.linePools ? await opts.linePools().catch(() => ({} as LinePools)) : null;
  const lines = dialableLines(opts.lines, linePools);
  if (!lines.length) throw new NoLiveCallerError();
  const rawPin = opts.pinId ? opts.lines.find((line) => line.id === opts.pinId) : undefined;
  // A dedicated pin only wins when that exact line can place a live call.
  // An RVM-pool or non-Telnyx pin falls through to rotation.
  const pinned = rawPin && lines.some((line) => line.id === rawPin.id) && !isRvmLine(rawPin, linePools) ? rawPin : undefined;
  if (pinned) return { id: pinned.id, e164: pinned.phone_e164 };
  const skippedPin = !!rawPin;
  const withNotice = (pick: { id: string; e164: string }) => (
    skippedPin && pick.id !== rawPin?.id ? { ...pick, notice: PIN_SKIPPED_NOTICE } : pick
  );
  if (lines.length === 1) return withNotice({ id: lines[0]!.id, e164: lines[0]!.phone_e164 });
  const key = lines.map((line) => line.id).slice().sort().join(',');
  let pool = pools.get(key);
  const now = Date.now();
  if (!pool || now - pool.loadedAt > RELOAD_MS) {
    const froms = opts.load ? await opts.load().catch(() => [] as string[]) : [];
    pool = { counts: countsFromHistory(lines, froms), seq: 0, loadedAt: now };
    pools.set(key, pool);
  }
  const pick = nextCallerId(lines, pool.counts, opts.dest, pool.seq, { destState: opts.destState, pools: linePools });
  pool.seq++;
  if (pick) pool.counts[pick.id] = (pool.counts[pick.id] ?? 0) + 1;
  return pick ? withNotice(pick) : null;
}

function isRvmLine(line: OrgLine, pools: LinePools | null | undefined): boolean {
  const row = pools?.[canonE164(line.phone_e164)] ?? pools?.[line.phone_e164];
  return row?.pool === 'rvm';
}

/**
 * Lines a live call may show. A line in the RVM pool carries ringless drops
 * and is kept off live calls, unless every line is in that pool.
 */
export function liveLines(lines: readonly OrgLine[], pools: LinePools | null | undefined): OrgLine[] {
  if (!pools) return [...lines];
  const live = lines.filter((line) => pools[canonE164(line.phone_e164)]?.pool !== 'rvm');
  return live.length ? live : [...lines];
}

/** RVM-pool skip, then Telnyx only. Unknown and non-Telnyx carriers are dropped. */
export function dialableLines(lines: readonly OrgLine[], pools: LinePools | null | undefined): OrgLine[] {
  return liveLines(lines, pools).filter((line) => isTelnyxProvider(line.provider));
}

/** Tests start from an empty memory. */
export function resetCallerSpin(): void {
  pools.clear();
}
