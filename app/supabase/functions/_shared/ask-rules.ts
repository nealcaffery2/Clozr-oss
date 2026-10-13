// The pure parts of Ask CLOZR's tool loop (supabase/functions/ask-clozr), so
// tools/ask-rules.test.ts can pin them: the explicit-yes gate on enrolment,
// stage names as a rep types them, the Today focus list as context, the
// thread the model sees, and the cards it may show.

/**
 * An explicit yes in the person's latest message. Enrolling a seller queues
 * texts to them, so ask-clozr refuses the enrolment until the person has said
 * yes after being asked; "enroll Kara in the cold plan" is a request, not the
 * yes. A no anywhere in the message wins.
 */
export function saidYes(message: string): boolean {
  const m = message.toLowerCase().replace(/[’']/g, "'");
  if (/\b(no|nope|don't|do not|cancel|stop|wait|hold off|not yet|never mind|nevermind)\b/.test(m)) return false;
  return /^\s*(y|yes|yep|yeah|yup|sure|ok|okay|confirm(ed)?|correct|go ahead|do it|please do|sounds good|approved?)\b/.test(m)
    || /\b(yes|confirm(ed)?|go ahead|do it)\b/.test(m);
}

/** A stage as the rep typed it, matched against the real list: exact, then ignoring case and punctuation. */
export function matchStage(list: readonly string[], typed: unknown): string | null {
  const s = String(typed ?? '').trim();
  if (!s) return null;
  if (list.includes(s)) return s;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(s);
  const hits = list.filter((x) => norm(x) === q);
  return hits.length === 1 ? hits[0] : null;
}

export type FocusContextItem = { id?: unknown; kind?: unknown; record?: { kind?: unknown; id?: unknown } | null; title?: unknown; detail?: unknown; why?: unknown };

/**
 * The Today focus list the person is looking at, numbered as the screen
 * numbers it, so "do the second one" means something. At most six, each line
 * capped; the record kind and id are what the tools take.
 */
export function focusContext(items: unknown): string {
  if (!Array.isArray(items)) return '';
  const lines = items.slice(0, 6).map((raw, i) => {
    const it = (raw ?? {}) as FocusContextItem;
    const kind = it.record?.kind === 'deal' ? 'deal' : 'seller';
    const id = Number(it.record?.id);
    if (!Number.isFinite(id)) return null;
    const text = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    return `${i + 1}. ${text(it.title, 80)} — ${text(it.why || it.detail, 200)} [${kind}_id ${id}${it.kind ? `, ${text(it.kind, 20)}` : ''}]`;
  }).filter(Boolean);
  return lines.length ? lines.join('\n') : '';
}

export type Turn = { role?: unknown; text?: unknown };
export type ThreadMessage = { role: 'user' | 'assistant'; content: string };

/** The last six turns, user first, same roles merged, each capped. */
export function threadFrom(history: unknown): ThreadMessage[] {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t: Turn) => t && (t.role === 'user' || t.role === 'clozr') && typeof t.text === 'string' && t.text.trim())
    .slice(-6)
    .map((t: Turn) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: String(t.text).slice(0, 3000) } as ThreadMessage));
  const merged: ThreadMessage[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (!last && t.role === 'assistant') continue;
    if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`;
    else merged.push({ ...t });
  }
  return merged;
}

export type CardKind = 'seller' | 'buyer' | 'deal';
export type Card = { kind: CardKind; id: number; title: string; subtitle: string };

/** Cards the model asked to show, kept only when a tool really returned that row this turn. At most six. */
export function cleanCards(raw: unknown, seen: Set<string>): Card[] {
  const out: Card[] = [];
  const keys = new Set<string>();
  for (const c of Array.isArray(raw) ? raw : []) {
    const x = (c ?? {}) as { kind?: unknown; id?: unknown; title?: unknown; subtitle?: unknown };
    const kind = x.kind === 'seller' || x.kind === 'buyer' || x.kind === 'deal' ? x.kind : null;
    const id = Number(x.id);
    if (!kind || !Number.isInteger(id) || typeof x.title !== 'string') continue;
    const key = `${kind}:${id}`;
    if (!seen.has(key) || keys.has(key)) continue;
    keys.add(key);
    out.push({ kind, id, title: x.title.slice(0, 120), subtitle: typeof x.subtitle === 'string' ? x.subtitle.slice(0, 200) : '' });
    if (out.length >= 6) break;
  }
  return out;
}
