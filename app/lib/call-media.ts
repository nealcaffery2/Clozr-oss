// A recorded call as the player reads it: timed transcript segments, the
// chapters over them, and search. Pure, so the call-sections edge function
// (Deno) and the browser share one definition of every rule here.
//
// Segments come from Talkr's recording transcript (start/end in seconds from
// the start of the recording), from the live transcript the dialer heard, or,
// for a row that only ever stored flat text, from that text with times
// estimated by length over the call's duration. `estimated` says which, so the
// player can say "about" instead of pretending to a precision it lacks.

export type Speaker = 'rep' | 'contact' | 'unknown';
export type CallSegment = { start: number; end: number; speaker: Speaker; text: string };

export const SECTION_KINDS = ['intro', 'motivation', 'property', 'price', 'timeline', 'objections', 'next_steps', 'other'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export type CallSection = {
  kind: SectionKind;
  title: string;
  /** Index of the first segment of the section. */
  index: number;
  start: number;
  end: number;
  summary: string | null;
};

/** What communications.call_sections holds (migration 106). */
export type StoredSections = {
  sections: CallSection[];
  source: 'ai' | 'keywords';
  model: string | null;
  at: string;
  /** How many segments the sections were computed over; a longer transcript later means recompute. */
  segments: number;
};

export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  motivation: 'Motivation',
  property: 'Property',
  price: 'Price',
  timeline: 'Timeline',
  objections: 'Objections',
  next_steps: 'Next steps',
  other: 'Other',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function speakerOf(v: unknown): Speaker {
  const s = String(v ?? '').toLowerCase();
  if (s === 'rep' || s === 'agent' || s === 'user') return 'rep';
  if (s === 'contact' || s === 'seller' || s === 'buyer' || s === 'prospect' || s === 'customer') return 'contact';
  return 'unknown';
}

/** A jsonb segments column (or Talkr's segments array) as clean, time-ordered segments. Null when unusable. */
export function parseSegments(raw: unknown): CallSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CallSegment[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const text = String(o.text ?? '').trim();
    const start = num(o.start);
    if (!text || start === null || start < 0) continue;
    const end = num(o.end);
    out.push({ start, end: end !== null && end >= start ? end : start, speaker: speakerOf(o.speaker), text });
  }
  if (!out.length) return null;
  return out.sort((a, b) => a.start - b.start);
}

const PREFIX = /^\s*(rep|agent|me|you|contact|seller|buyer|prospect|customer|caller|[A-Z][a-z]{1,20})\s*:\s*/i;

/**
 * Flat "Rep: …\nContact: …" text into segments with times spread by length
 * across the call. Speaking rate varies line to line, so these are estimates,
 * and they are only ever shown as such.
 */
export function segmentsFromText(text: string, durationS?: number | null, repName?: string | null): CallSegment[] {
  const rows = String(text ?? '').split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return [];
  const rep = (repName ?? '').trim().toLowerCase();
  const parsed = rows.map((row) => {
    const m = PREFIX.exec(row);
    if (!m) return { speaker: 'unknown' as Speaker, text: row };
    const who = m[1]!.toLowerCase();
    const speaker: Speaker = who === 'rep' || who === 'agent' || who === 'me' || who === 'you' || (rep && who === rep)
      ? 'rep'
      : ['contact', 'seller', 'buyer', 'prospect', 'customer', 'caller'].includes(who) ? 'contact' : 'unknown';
    return { speaker, text: row.slice(m[0].length).trim() || row };
  });
  const chars = parsed.reduce((n, p) => n + p.text.length, 0) || 1;
  // ~15 characters a second is ordinary phone speech when the call length is unknown.
  const total = durationS && durationS > 0 ? durationS : chars / 15;
  let t = 0;
  return parsed.map((p) => {
    const len = (p.text.length / chars) * total;
    const seg = { start: round1(t), end: round1(t + len), speaker: p.speaker, text: p.text };
    t += len;
    return seg;
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Index of the segment playing at `t` seconds, or -1 before the first. */
export function activeIndex(segments: CallSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.start <= t + 0.05) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** "m:ss", or "h:mm:ss" past an hour. */
export function fmtClock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'was', 'did', 'do', 'does', 'they', 'he', 'she', 'we', 'i', 'you', 'it', 'where', 'when', 'what', 'who', 'how', 'why', 'mention', 'mentioned', 'say', 'said', 'talk', 'talked', 'about', 'any', 'their', 'them', 'there', 'that', 'this']);

/** Words worth matching in a question: lowercase, stop words out, a trailing plural s folded. */
export function queryTerms(q: string): string[] {
  const words = String(q ?? '').toLowerCase().match(/[a-z0-9$']+/g) ?? [];
  const out = words.map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  return [...new Set(out)];
}

/** Plain text search, used when the AI search is unavailable. Best matches first, at most `limit`. */
export function textSearch(segments: CallSegment[], q: string, limit = 8): number[] {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const scored: { i: number; score: number }[] = [];
  segments.forEach((s, i) => {
    const text = s.text.toLowerCase();
    let score = 0;
    for (const t of terms) if (text.includes(t)) score += t.length > 3 ? 2 : 1;
    if (score) scored.push({ i, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((x) => x.i);
}

const KEYWORDS: [SectionKind, RegExp][] = [
  ['motivation', /\b(why (are|do) you|reason|motivat|moving|relocat|divorce|inherit|passed away|probate|tired of|behind on|foreclos|job|retire)/i],
  ['property', /\b(roof|foundation|kitchen|bath(room)?s?|bed(room)?s?|square f|sq ?ft|repairs?|condition|hvac|a\/c|plumbing|electrical|tenant|vacant|renovat|updated)\b/i],
  ['price', /(\$\s?\d|\b\d{2,3}\s?k\b|\bprice\b|\basking\b|\boffer\b|\bnumber\b|\bowe\b|\bmortgage\b|\bpayoff\b|\bequity\b|\bcash\b)/i],
  ['timeline', /\b(how soon|timeline|close by|closing|by (the )?end of|next (week|month)|asap|days?\b|weeks?\b|months?\b|move out)/i],
  ['objections', /\b(too low|not interested|think about it|other investor|realtor|agent|list it|lowball|not sure|talk to my)\b/i],
  ['next_steps', /\b(send (you|over)|contract|appointment|walk ?through|come out|call you back|follow up|schedule|tomorrow|text you|email you)\b/i],
];

/**
 * Chapters from keywords, for when there is no model to ask. The call opens
 * on the intro; each other kind starts where it is first heard, and the
 * section runs to the next one. Crude, and labelled as keyword sections.
 */
export function keywordSections(segments: CallSegment[]): CallSection[] {
  if (!segments.length) return [];
  const starts: { kind: SectionKind; index: number }[] = [{ kind: 'intro', index: 0 }];
  for (const [kind, re] of KEYWORDS) {
    const i = segments.findIndex((s, idx) => idx > 0 && re.test(s.text));
    if (i > 0) starts.push({ kind, index: i });
  }
  return finishSections(starts.map((s) => ({ ...s, title: SECTION_LABEL[s.kind], summary: null })), segments);
}

/** Sort, drop duplicates at one index, and give each section its end. */
function finishSections(rows: { kind: SectionKind; index: number; title: string; summary: string | null }[], segments: CallSegment[]): CallSection[] {
  const byIndex = new Map<number, (typeof rows)[number]>();
  for (const r of rows.sort((a, b) => a.index - b.index)) if (!byIndex.has(r.index)) byIndex.set(r.index, r);
  const list = [...byIndex.values()];
  const last = segments[segments.length - 1]!;
  return list.map((r, k) => {
    const next = list[k + 1];
    return {
      kind: r.kind,
      title: r.title,
      index: r.index,
      start: segments[r.index]!.start,
      end: next ? segments[next.index]!.start : last.end,
      summary: r.summary,
    };
  });
}

/** The model's section list, validated against the transcript it was given. Null when nothing usable came back. */
export function normalizeSections(input: unknown, segments: CallSegment[]): CallSection[] | null {
  const raw = (input as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(raw) || !segments.length) return null;
  const rows: { kind: SectionKind; index: number; title: string; summary: string | null }[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const index = Math.round(Number(o.start_index));
    if (!Number.isFinite(index) || index < 0 || index >= segments.length) continue;
    const kind = (SECTION_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as SectionKind) : 'other';
    const title = String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 48) || SECTION_LABEL[kind];
    const summary = String(o.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 220) || null;
    rows.push({ kind, index, title, summary });
  }
  if (!rows.length) return null;
  if (!rows.some((r) => r.index === 0)) rows.push({ kind: 'intro', index: 0, title: SECTION_LABEL.intro, summary: null });
  return finishSections(rows, segments);
}

/** The model's search answer, validated: segment indexes in range, best first, at most five. */
export function normalizeMatches(input: unknown, count: number): { index: number; why: string | null }[] {
  const raw = (input as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: { index: number; why: string | null }[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const index = Math.round(Number(o.index));
    if (!Number.isFinite(index) || index < 0 || index >= count || seen.has(index)) continue;
    seen.add(index);
    out.push({ index, why: String(o.why ?? '').trim().slice(0, 160) || null });
    if (out.length >= 5) break;
  }
  return out;
}

/** "[12] 3:04 Contact: text" lines for a prompt, cut to `maxChars`. */
export function segmentsForPrompt(segments: CallSegment[], maxChars = 30_000): string {
  const who = (s: Speaker) => (s === 'rep' ? 'Rep' : s === 'contact' ? 'Contact' : 'Speaker');
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const line = `[${i}] ${fmtClock(s.start)} ${who(s.speaker)}: ${s.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

/** Stored sections are reusable when they were computed over this transcript. */
export function sectionsFresh(stored: unknown, segmentCount: number): stored is StoredSections {
  const s = stored as StoredSections | null;
  return !!s && Array.isArray(s.sections) && s.sections.length > 0 && s.source === 'ai' && s.segments === segmentCount;
}
