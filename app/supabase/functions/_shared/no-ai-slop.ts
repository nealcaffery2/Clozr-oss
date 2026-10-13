// How every AI agent in Clozr writes and talks: no AI slop. Adapted from
// Peter Yang's no-ai-slop skill (https://github.com/petergyang/no-ai-slop,
// MIT License, Copyright (c) 2026 Peter Yang): the banned words, the empty
// phrases and the 20-odd patterns that make writing read as machine-made.
//
// Two halves, both pure (tools/no-ai-slop.test.ts runs them under tsx):
//   - The rules, as prompt text: WRITING_RULE for anything an agent writes for
//     a person (appended to the agents' system prompts), MESSAGE_RULES for
//     texts and emails to sellers, buyers and leads, SPOKEN_RULES for calls.
//   - slopFindings(): the patterns as checks. The AI agent engine and the
//     Compr agent run every drafted text and email through it and hold a
//     message that still has one after a rewrite.

// ---- the words and phrases --------------------------------------------------------------

/** Banned outright. */
export const SLOP_WORDS: readonly string[] = [
  'delve', 'delves', 'delving', 'foster', 'fosters', 'fostering', 'leverage', 'leverages', 'leveraging', 'utilize', 'utilizes', 'utilizing',
  'facilitate', 'facilitates', 'empower', 'empowers', 'empowering', 'streamline', 'streamlines', 'streamlined', 'robust', 'cutting-edge',
  'paradigm shift', 'game changer', 'game-changer', 'this is huge', 'this changes everything', 'tapestry', 'realm', 'beacon', 'multifaceted',
  'meticulous', 'meticulously', 'intricate', 'paramount', 'transformative', 'elevate', 'elevates', 'embark', 'supercharge', 'harness',
  'ever-evolving',
];

/** Phrases that delay the point. */
export const SLOP_PHRASES: readonly string[] = [
  "it's worth noting", 'it is worth noting', "it's important to note", 'it is important to note', 'at the end of the day', 'when it comes to',
  'at its core', "in today's world", 'in the age of', 'in the world of', 'the reality is', 'the truth is', 'in terms of', 'with regard to',
  'going forward', 'in this article', "let's dive in",
];

export type SlopPattern = { name: string; re: RegExp; fix: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]");
const list = (xs: readonly string[]) => new RegExp(`(?<![\\w-])(?:${xs.map(esc).join('|')})(?![\\w-])`, 'i');

/** The patterns, each with the plain fix. Order is the order they are reported in. */
export const SLOP_PATTERNS: readonly SlopPattern[] = [
  // "Foster" stays fine in "foster kids", "foster care" or "foster home": a seller's life, not a buzzword.
  { name: 'banned word', re: new RegExp(`${list(SLOP_WORDS.filter((w) => !w.startsWith('foster'))).source}|\\bfoster(?:s|ing)?\\b(?!\\s+(?:care|kids?|child|children|home|homes|parents?|famil(?:y|ies)|mom|dad))`, 'i'), fix: 'use the plain word' },
  { name: 'empty phrase', re: list(SLOP_PHRASES), fix: 'cut it and say the point' },
  { name: 'binary contrast', re: /\b(?:it['\u2019]?s|this is|that['\u2019]?s|the (?:question|problem|point|issue|goal) is)\s?n['\u2019]?o?t\s+(?:just\s+|about\s+)?[^.?!\n]{1,60}[.;,]\s*(?:it['\u2019]?s|this is|that['\u2019]?s)\b|\bnot (?:just|only) [^.?!\n]{1,60}?,? but (?:also )?/i, fix: 'state the second half directly' },
  { name: 'throat-clearing opener', re: /\b(?:here['\u2019]?s the thing|here['\u2019]?s what i mean|let me be clear|i['\u2019]?ll be honest|the uncomfortable truth is)\b/i, fix: 'cut it and state the point' },
  { name: 'faux-insight setup', re: /\b(?:the part (?:most people|everyone) (?:skip|miss)e?s?|what most people get wrong|here['\u2019]?s what nobody tells you|what nobody tells you|the part everyone misses)\b/i, fix: 'cut the setup and make the claim' },
  { name: 'colon reveal', re: /(?:^|[.!?]\s+)(?:the|my|our|your|his|her|their)\s+(?:best|real|key|hard|fun|crazy|wild|tricky|interesting|important|scary|big)\s+(?:part|thing|news|bit|catch|twist|detail)[^:.\n]{0,20}:\s+[a-z]/i, fix: 'write it as a plain sentence' },
  { name: 'superficial analysis', re: /,\s+(?:highlighting|underscoring|showcasing|reflecting|emphasizing|demonstrating|illustrating|signaling|signalling)\b/i, fix: 'say what it does for them, or cut it' },
  { name: 'importance puffery', re: /\b(?:stands as a testament|(?:is )?a testament to|marks? a (?:pivotal|significant|major) (?:moment|milestone)|pivotal moment|plays? an? (?:vital|crucial|key|pivotal|critical) role|solidif(?:y|ies|ied) (?:its|their|our) position|underscores? (?:its|the|their) (?:significance|importance))\b/i, fix: 'state the fact' },
  { name: 'reader guidance', re: /\b(?:that last part matters|the key (?:point|takeaway) (?:is|here)|as you can see|this distinction matters|in other words|to be clear)\b/i, fix: 'cut it; let the fact carry it' },
  { name: 'weasel attribution', re: /\b(?:experts (?:agree|say|believe)|industry reports (?:suggest|show)|many (?:argue|believe|say)|widely regarded as|studies (?:show|suggest|have shown)|research shows)\b/i, fix: 'name the source or cut the claim' },
  { name: 'fake-strong verb', re: /\bserves? as (?:a|an|the|your|our)\b|\bacts? as a (?:central|centralized|single|one-stop)\b/i, fix: 'use is, has or a direct verb' },
  { name: 'negative listing', re: /(?:^|[.!?]\s+)not an? [^.!?\n]{1,30}[.!?]\s+not an? [^.!?\n]{1,30}[.!?]/i, fix: 'just say what it is' },
  { name: 'dramatic fragments', re: /\bthat['\u2019]?s it\. that['\u2019]?s the whole thing\b|[.!?]\s+and [^.!?\n]{1,30}\.\s+and [^.!?\n]{1,30}\./i, fix: 'use complete sentences' },
  { name: 'rhetorical setup', re: /\b(?:what if i told you|think about it:|plot twist:|guess what\??|the result\?|the answer\?)/i, fix: 'make the point' },
  { name: 'summary ending', re: /(?:^|[.!?\n]\s*)(?:in conclusion|in summary|to sum up|ultimately|overall),/i, fix: 'end on the last concrete point' },
  { name: 'em dash', re: /\s?[\u2014]\s?|\s[\u2013]\s|\s--\s/, fix: 'use a comma, a period or a new sentence' },
  { name: 'decorative bold', re: /\*\*[^*\n]{1,60}\*\*/, fix: 'drop the bold' },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, fix: 'drop the emoji' },
];

export type SlopFinding = { pattern: string; quote: string; fix: string };

/**
 * The slop in a piece of writing: each pattern found, with the words that
 * tripped it and the fix. Empty when it is clean. Quoted examples in
 * backticks or double quotes are not counted.
 */
export function slopFindings(text: string, opts: { skip?: readonly string[] } = {}): SlopFinding[] {
  const t = String(text ?? '').replace(/`[^`]*`/g, ' ');
  const out: SlopFinding[] = [];
  for (const p of SLOP_PATTERNS) {
    if (opts.skip?.includes(p.name)) continue;
    const m = p.re.exec(t);
    if (m) out.push({ pattern: p.name, quote: m[0].trim().slice(0, 80), fix: p.fix });
  }
  return out;
}

/** One line per finding, for a held message's log and for the rewrite the model is asked for. */
export const slopReport = (f: readonly SlopFinding[]) => f.map((x) => `${x.pattern} ("${x.quote}"): ${x.fix}`).join('; ');

// ---- the rules, as prompt text --------------------------------------------------------------

/** For anything an agent writes for a person: a reply in a chat, a summary, a draft, a reason. Appended to system prompts. */
export const WRITING_RULE = ` How you write (no AI slop): plain, specific and direct, like a sharp person on the team. Lead with the point. Use names, numbers, dates and the actual facts instead of abstractions; if a sentence could be pasted about any other company or person, cut it or make it specific. Active voice, direct verbs ("decided", not "made a decision"; "is", not "serves as"). Never use these words: ${SLOP_WORDS.filter((w, i, a) => a.indexOf(w) === i && !/s$|ing$|ed$/.test(w)).join(', ')}. Never use these phrases: ${SLOP_PHRASES.filter((p) => !p.startsWith('it is')).join(', ')}. No "It's not X, it's Y" or "not just X but Y" contrasts, no "Here's the thing" openers, no "what nobody tells you" setups, no colon reveals ("The best part: ..."), no trailing "highlighting / underscoring / showcasing" clauses, no "a testament to" or "pivotal moment" puffery, no "as you can see" or "the key point is" asides, no "experts agree" or "studies show" without a named source, no "What if I told you" or "Plot twist:" setups, no stacked dramatic fragments, no fake-profound closing line, and no "In conclusion / Ultimately / Overall" recap at the end. No em dashes. No emoji, no decorative bold, no bullets where two sentences read better. Never invent a fact, a number or a quote to sound specific.`;

/** For texts and emails to sellers, buyers and leads (on top of each agent's own rules). */
export const MESSAGE_RULES = `No AI slop in anything you send. Plain words, contractions, one point per message, the specific fact instead of a general claim. Never use: ${SLOP_WORDS.filter((w) => !/s$|ing$|ed$/.test(w)).join(', ')}, or the phrases ${SLOP_PHRASES.filter((p) => !p.startsWith('it is')).map((p) => `"${p}"`).join(', ')}. No "It's not X, it's Y" or "not just X but Y". No "Here's the thing", "I'll be honest", "what nobody tells you", "What if I told you", "Plot twist:", or a "The best part: ..." reveal. No "a testament to", "pivotal moment", "plays a vital role", "serves as", "experts agree" or "studies show". No closing line that sums up or tries to sound deep: stop after the last real point or the question. No em dashes, emoji, bold or bullets in a text.`;

/** For an agent on a call. */
export const SPOKEN_RULES = `# How you talk (no AI slop)
Talk like a real person on the phone, not a script. Short, plain, specific. Never say: ${SLOP_WORDS.filter((w) => !/s$|ing$|ed$/.test(w) && !w.includes('-')).join(', ')}. Never say "it's worth noting", "at the end of the day", "when it comes to", "the truth is", "here's the thing", "let me be clear", "I'll be honest", "what nobody tells you", "what if I told you", "it's not just X, it's Y", "a testament to" or "plays a vital role". Don't sum up what you just said or end on a line that tries to sound wise. Answer the question, then ask the next one.`;
