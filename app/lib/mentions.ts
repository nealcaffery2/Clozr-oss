/**
 * @mentions in notes.
 *
 * A mention is stored in the note body as `@[Full Name](user-id)`, so the
 * text still reads without CLOZR and the id survives a teammate's rename.
 * Migration 43's trigger parses the same token (keep MENTION_RE and its SQL
 * pattern in step) and notifies each mentioned member.
 */

export const MENTION_RE = /@\[([^\]\n]{1,80})\]\(([\w-]{1,64})\)/g;

export type MentionSegment = { text: string } | { name: string; id: string };

/** The distinct user ids mentioned in a body, in order of first mention. */
export function mentionIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[2]))];
}

/** A body split into plain text and mention chips, for rendering. */
export function mentionSegments(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let at = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    if (m.index > at) out.push({ text: body.slice(at, m.index) });
    out.push({ name: m[1], id: m[2] });
    at = m.index + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

/** The body as plain text: `@[Ann Lee](u1)` reads `@Ann Lee`. */
export function mentionPlain(body: string): string {
  return body.replace(MENTION_RE, '@$1');
}

/**
 * The `@query` being typed at the caret, if any: an `@` at the start or after
 * whitespace, followed by up to 30 characters with no newline or `@`.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@[\]()][^\n@[\]()]{0,29}|)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Replace the `@query` from `start` to `caret` with a token; returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string, id: string): { text: string; caret: number } {
  const token = `@[${name.replace(/[[\]\n]/g, '')}](${id}) `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}
