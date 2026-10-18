// The campaign builder's edit lightbox, the parts both sides share: the
// sections a message splits into for "change just this part", the merge
// fields an AI edit must keep, the guard on what the rep sends, and the
// carrier review a message gets before a push launches. No imports beyond
// carrier-safe, so the message-revise edge function reads the same file.

import { type CarrierCheck, type CarrierFinding, carrierCheck } from './carrier-safe.ts';

/** Every {{field}} in a message, in order, each once. */
export function mergeTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    const t = m[1].toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Why a revise request cannot go to the model, or null when it can. */
export function reviseProblem(r: { instruction: string; text: string; html?: string | null; section?: string | null }): string | null {
  if (!r.instruction.trim()) return 'Say what you want to change first.';
  if (r.instruction.length > 1000) return 'Keep the change to 1,000 characters.';
  if (!r.text.trim() && !r.html?.trim()) return 'There is no message to change.';
  if (r.text.length > 6000) return 'The message is too long to edit with AI. Edit it by hand.';
  if (r.html && r.html.length > 60000) return 'The email is too long to edit with AI. Edit it by hand.';
  if (r.section && !r.text.includes(r.section)) return 'That section is no longer in the message. Pick it again.';
  return null;
}

/**
 * The parts a rep can pick to change on their own: each line, and each
 * sentence of a long line. A merge field is never split.
 */
export function messageSections(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    const parts = l.length > 90 ? l.match(/[^.!?]+(?:[.!?]+|$)(?:\s+|$)/g) ?? [l] : [l];
    for (const p of parts) {
      const s = p.trim();
      // A heading or a lone merge field is not a part worth rewriting on its own.
      if (s && !out.includes(s) && s.replace(/\{\{[^}]*\}\}/g, '').replace(/[^a-z]/gi, '').length >= 5) out.push(s);
    }
  }
  return out.length > 1 ? out.slice(0, 12) : [];
}

/** A short label for a section chip. */
export const sectionLabel = (s: string, max = 42) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export type CarrierReview = {
  /** Which message, as the builder names it ("Deal brief by text"). */
  label: string;
  /** Where the builder edits it (the lightbox target). */
  target: string;
  channel: 'sms' | 'email';
  check: CarrierCheck;
  /** The suggested version: the check's own rewording. Null when only a hand edit can fix it. */
  suggestion: string | null;
};

/**
 * The carrier review of one message template, before a push launches. Texts
 * get the full check. Emails are checked too: inbox filters score the same
 * trigger words, so a flagged email gets the same suggestion.
 */
export function reviewMessage(label: string, target: string, channel: 'sms' | 'email', text: string): CarrierReview | null {
  if (!text.trim()) return null;
  const raw = carrierCheck(text);
  // An email carries several links by design (the deal page, photos, comps) and capital headings ("ACME HOMES",
  // a disclosure's "EQUITABLE INTEREST"); only a text is scored for those. A word that is negated where it
  // stands ("are not guaranteed" in a disclaimer) says the opposite of the pitch it is filtered for, and
  // swapping it would change what the sentence promises, so it is left alone.
  const negated = (f: CarrierFinding) => {
    const word = f.found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const all = text.match(new RegExp(word, 'gi'))?.length ?? 0;
    return all > 0 && (text.match(new RegExp(`\\b(?:not|no|never)\\s+${word}`, 'gi'))?.length ?? 0) >= all;
  };
  const findings = channel === 'email'
    ? raw.findings.filter((f) => !/^\d+ links$/.test(f.found) && !/all capitals/.test(f.why) && !negated(f))
    : raw.findings;
  if (!findings.length) return null;
  const check = { ...raw, findings };
  return { label, target, channel, check, suggestion: raw.text !== text ? raw.text : null };
}

/** The check's swaps applied to other copies of the same words: each "found" becomes its "to", as written. */
export function fixWords(text: string, findings: CarrierFinding[]): string {
  let t = text;
  for (const f of findings) {
    if (f.severity !== 'fix' || f.to == null || !f.found) continue;
    // Not where it is negated: "are not guaranteed" stays as written.
    t = t.replace(new RegExp(`(?<!\\b(?:not|no|never)\\s+)${f.found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), () => f.to!);
  }
  return t;
}

/** The same swaps in a designed email: only the words between tags change, never a tag, style or link. */
export function fixHtmlWords(html: string, findings: CarrierFinding[]): string {
  return html.replace(/>([^<]+)</g, (_m, words: string) => `>${fixWords(words, findings)}<`);
}

/** One line per finding, the way the builder lists them. */
export function findingLine(f: CarrierFinding): string {
  if (f.severity === 'fix' && f.to != null) return `"${f.found}" becomes "${f.to}": ${f.why}.`;
  if (f.severity === 'block') return `"${f.found}" stops the send: ${f.why}.`;
  return `"${f.found}": ${f.why}.`;
}
