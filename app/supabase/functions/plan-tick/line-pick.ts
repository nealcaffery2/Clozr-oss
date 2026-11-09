/**
 * The pure half of lines.ts: line caps, versions and which line a text goes
 * out on. No Supabase or Talkr here, so the app's type check and tsx tests
 * can import it (lines.ts re-exports all of it).
 */
import { AREA_CODE_STATE, areaCodeOf } from '../_shared/agent-lines.ts';

export const ROTATE_OVER = 50;
export const LINE_DAILY_CAP = 600;

/** A line's own daily cap (lineCap); LINE_DAILY_CAP when unset. */
export type Line = { id: string; e164: string; sent: number; cap?: number };

/** Texts a day a line sends: a new line ramps over its first two weeks so carriers trust it. */
export function lineCap(firstSentAt: string | null | undefined, nowMs = Date.now()): number {
  const days = firstSentAt ? (nowMs - Date.parse(firstSentAt)) / 86_400_000 : 0;
  return days < 3 ? 50 : days < 7 ? 100 : days < 14 ? 150 : LINE_DAILY_CAP;
}

export function rotationOn(setting: unknown, activeOnPlan: number): boolean {
  if (setting === false) return false;
  if (setting === true) return true;
  return activeOnPlan > ROTATE_OVER;
}

/** One of up to three versions split by a line of ---, the same one for the same person. */
export function pickVersion(body: string, enrollmentId: number): string {
  const parts = body.split(/\r?\n[ \t]*-{3,}[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean).slice(0, 3);
  if (parts.length <= 1) return body;
  return parts[Math.abs(Math.trunc(enrollmentId)) % parts.length];
}

/**
 * The line this person already hears from, when it is one of ours and under
 * the cap, so one person's texts stay on one number. Else the least-used line
 * under the cap in their area code, then in their state, then anywhere; null
 * when every line is full today.
 */
export function pickLine(lines: readonly Line[], cap: number, lastFrom?: string | null, toPhone?: string | null): Line | null {
  const sticky = lastFrom ? lines.find((l) => tail(l.e164) === tail(lastFrom)) : undefined;
  const room = (l: Line) => l.sent < Math.min(cap, l.cap ?? cap);
  if (sticky && room(sticky)) return sticky;
  const ac = areaCodeOf(toPhone);
  const st = ac ? AREA_CODE_STATE[ac] : undefined;
  return leastUsed(lines, room, (l) => !!ac && areaCodeOf(l.e164) === ac)
    ?? leastUsed(lines, room, (l) => !!st && AREA_CODE_STATE[areaCodeOf(l.e164) ?? ''] === st)
    ?? leastUsed(lines, room, () => true);
}

/**
 * A dispo blast's line. The buyer's own line first (one person, one number),
 * then the number the sender picked for its first ROTATE_OVER texts of the day,
 * then the sender's other lines and the office's shared ones (pickLine). The
 * picked number keeps going past ROTATE_OVER only when every other line is
 * full. `held` are lines Talkr refused this tick (off the 10DLC campaign, or
 * at its cap): skipped, so the text goes out on another line instead of
 * waiting a day.
 */
export function pickBlastLine(
  lines: readonly Line[], primaryId: string | null, lastFrom: string | null, toPhone: string | null, held: ReadonlySet<string> = new Set(),
): Line | null {
  const open = lines.filter((l) => !held.has(l.id));
  const room = (l: Line, cap: number) => l.sent < Math.min(cap, l.cap ?? cap);
  const sticky = lastFrom ? open.find((l) => tail(l.e164) === tail(lastFrom)) : undefined;
  if (sticky && room(sticky, LINE_DAILY_CAP)) return sticky;
  const primary = primaryId ? open.find((l) => l.id === primaryId) : undefined;
  if (primary && room(primary, ROTATE_OVER)) return primary;
  return pickLine(open.filter((l) => l !== primary), LINE_DAILY_CAP, null, toPhone)
    ?? (primary && room(primary, LINE_DAILY_CAP) ? primary : null);
}

function leastUsed(lines: readonly Line[], room: (l: Line) => boolean, ok: (l: Line) => boolean): Line | null {
  let best: Line | null = null;
  for (const l of lines) if (ok(l) && room(l) && (!best || l.sent < best.sent)) best = l;
  return best;
}

export const tail = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').slice(-10);

/** A line labelled as someone's or the company's main number: kept off blasts. */
export const isMainLine = (label: string | null | undefined) => /\bmain\b/i.test(label ?? '');
