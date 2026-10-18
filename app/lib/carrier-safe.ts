// What US carriers filter in a business text, and what CLOZR does about it
// before Talkr ever sees the message. One file for the browser (lib/sms) and
// the server (docs-flow textRecipient, the dispo campaign sender, the auto
// reply), the way lib/rvm.ts is shared.
//
// Three outcomes per finding:
//   fix    the wording is swapped for one that says the same thing without
//          the trigger ("free demo" → "quick demo", "JAMES" → "James").
//   block  nothing safe can be swapped in (a link shortener, a prize, a
//          SHAFT topic), so the text is refused with the reason.
//   warn   allowed, but the reason rides along (two links, a lending word).
//
// The lists follow CTIA's messaging principles (SHAFT content, no shortened
// links, identify the business) and the words carrier filters (T-Mobile,
// AT&T, Verizon via Telnyx 40002/40015) are known to score. Rep replies in a
// live thread (`mode: 'reply'`) are never rewritten: a person's own words
// stay theirs, and only a block applies.

export type CarrierSeverity = 'fix' | 'block' | 'warn';
export type CarrierFinding = {
  severity: CarrierSeverity;
  /** The words in the text that tripped it. */
  found: string;
  /** Why a carrier filter would flag it, in plain words. */
  why: string;
  /** What it became (fix only). */
  to?: string;
};
export type CarrierCheck = {
  /** The text as it should go out (fixes applied unless mode is 'reply'). */
  text: string;
  findings: CarrierFinding[];
  /** True when a block finding stops the send. */
  blocked: boolean;
};

const SPAMMY = 'carrier spam filters score this word in business texts';

/**
 * Wording swaps that keep the meaning. Each pattern is matched whole-word and
 * case-insensitively; the replacement keeps a leading capital.
 */
const SWAPS: { re: RegExp; to: string; why: string }[] = [
  { re: /\b(?:a\s+)?(?:quick\s+)?free\s+demo\b/gi, to: 'a quick demo', why: `"free" ${SPAMMY}` },
  { re: /\bfor\s+free\b/gi, to: 'at no cost', why: `"free" ${SPAMMY}` },
  // Not "free and clear" (owned outright), "feel free", "toll-free", "hands-free", "free up".
  { re: /\bfree\b(?!\s+(?:and\s+clear|up\b))(?<!feel\s+free)(?<![-\w]free)/gi, to: 'no-cost', why: `"free" ${SPAMMY}` },
  { re: /\ban?\s+(?:all[-\s]+)?cash\s+offer\b/gi, to: 'an offer', why: '"cash offer" is one of the most filtered phrases in real-estate texting' },
  { re: /\b(?:all[-\s]+)?cash\s+offer(s?)\b/gi, to: 'offer$1', why: '"cash offer" is one of the most filtered phrases in real-estate texting' },
  { re: /\bcash\s+buyer(s?)\b/gi, to: 'buyer$1', why: '"cash buyer" is filtered in real-estate texting' },
  { re: /\b(?:for|in|with)\s+(?:all[-\s]+)?cash\b/gi, to: 'as-is', why: '"for cash" is filtered in real-estate texting' },
  { re: /\bguaranteed\b/gi, to: 'firm', why: `"guaranteed" ${SPAMMY}` },
  { re: /\bguarantee\b/gi, to: 'promise', why: `"guarantee" ${SPAMMY}` },
  { re: /\bact\s+(?:now|fast|quickly)\b/gi, to: 'reply when you can', why: 'pressure phrases are scored as spam' },
  { re: /\blimited[-\s]time\b/gi, to: 'short time', why: '"limited time" is scored as spam' },
  { re: /\burgent(ly)?\b/gi, to: 'soon', why: '"urgent" is scored as spam' },
  { re: /\b(?:risk[-\s]free|no\s+risk)\b/gi, to: 'no pressure', why: '"risk-free" is scored as spam' },
  { re: /\bno\s+obligation\b/gi, to: 'no pressure', why: '"no obligation" is scored as spam' },
  { re: /\bonce\s+in\s+a\s+lifetime\b/gi, to: 'rare', why: 'hype phrases are scored as spam' },
];

/** Words that are always refused: nothing safe can be swapped in. */
const BLOCKS: { re: RegExp; why: string }[] = [
  { re: /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc|rb\.gy)\/\S*/gi, why: 'carriers block shortened links outright; use the full link' },
  { re: /\b(?:you(?:'ve| have)?\s+won|winner|prize|congratulations)\b/gi, why: 'prize language is a top carrier block' },
  { re: /\b(?:verify|confirm)\s+your\s+(?:account|identity|bank)\b|\baccount\s+(?:has\s+been\s+)?(?:suspended|locked)\b/gi, why: 'reads as phishing to carrier filters' },
  { re: /\b(?:sex|sexy|xxx|porn|nude|escort)\b/gi, why: 'SHAFT content (sex) is not allowed on business lines' },
  { re: /\b(?:beer|wine|liquor|vodka|whiskey|alcohol)\b/gi, why: 'SHAFT content (alcohol) is not allowed on business lines' },
  { re: /\b(?:gun|guns|firearm|firearms|ammo|ammunition|rifle|pistol)\b/gi, why: 'SHAFT content (firearms) is not allowed on business lines' },
  { re: /\b(?:tobacco|cigarettes?|vape|vaping|marijuana|cannabis|cbd|thc|weed)\b/gi, why: 'SHAFT content (tobacco or cannabis) is not allowed on business lines' },
];

/** Allowed, with the reason attached. */
const WARNS: { re: RegExp; why: string }[] = [
  { re: /\b(?:loan|loans|pre-?approved|credit\s+(?:score|repair)|debt\s+relief|refinanc\w*)\b/gi, why: 'lending words put a text in the high-risk financial category; fine in a reply, risky in a blast' },
  { re: /\bclick\s+(?:here|below|the\s+link)\b/gi, why: '"click here" is scored as spam; say what the link is instead' },
  { re: /\b100\s?%/g, why: '"100%" is scored as spam' },
];

/** Upper-case words that are meant to be: keywords carriers require, and trade acronyms. */
const CAPS_OK = new Set(['STOP', 'HELP', 'START', 'UNSTOP', 'INFO', 'ASAP', 'FSBO', 'REIA', 'HVAC', 'USPS', 'NOLA', 'DFW', 'ARV', 'MLS', 'HOA', 'LLC', 'CMA', 'ADU', 'USA', 'TX', 'OK', 'AI', 'PM', 'AM']);

/** Greetings that use no name at all ("Hi there,"): left as they are. */
const NO_NAME = new Set(['there', 'all', 'everyone', 'again', 'folks', 'friend', 'guys', 'yall', "y'all"]);

/** Words in a greeting slot that are not a person's first name. */
const NOT_A_NAME = new Set(['sell', 'buy', 'owner', 'owners', 'homeowner', 'team', 'office', 'admin', 'info', 'homes', 'home', 'properties', 'property', 'realty', 'investments', 'investor', 'llc', 'inc', 'co', 'company', 'unknown', 'na', 'n/a', 'none', 'test', 'customer', 'resident', 'dr', 'mr', 'mrs', 'ms', 'sir', 'madam']);

/** Keeps the first letter's case of what it replaces. */
function keepCase(src: string, to: string): string {
  return src[0] && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to;
}

/**
 * The name in a greeting, made safe: a real name in all caps or all lower case
 * is capitalised, and anything that is not a name (a website, a placeholder,
 * an initial, a title, a short acronym, a word like SELL) becomes "there".
 * Null when the name is fine as it is. An unfilled merge field is left alone.
 */
export function greetingName(raw: string): string | null {
  const n = raw.trim();
  if (!n || /\{\{?\s*\w+\s*\}?\}/.test(n)) return null;
  const word = n.replace(/[.,!]+$/, '');
  const lower = word.toLowerCase();
  if (NO_NAME.has(lower)) return null;
  // A short all-caps word is an acronym (OKC, LLC, TJ) unless it reads as a
  // name: a vowel in a two-letter one (AL, ED), in the last two of three (DON, AMY).
  const acronym = word === word.toUpperCase() && word.length <= 3 && !/[AEIOUY]/.test(word.length === 3 ? word.slice(1) : word);
  const looksOff = /[.@/\\[\]{}<>0-9_#:]/.test(n) || word.length < 2 || NOT_A_NAME.has(lower) || acronym;
  if (looksOff) return 'there';
  if (/^[A-Za-z][A-Za-z' -]*$/.test(word) && (word === word.toUpperCase() || word === lower)) {
    return word.split(/([ '-])/).map((p) => (/^[a-z]/i.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join('');
  }
  return null;
}

/** "Hey <one word>," at the start: the slot a first-name merge field fills. */
const GREETING = /^(\s*(?:hey|hi|hello|morning|good\s+(?:morning|afternoon|evening))\s+)([^\s,!]{1,60})(?=\s*[,!])/i;

/**
 * Checks a text the way a carrier filter would and returns what to send.
 * `mode: 'reply'` (a rep typing in a live thread) applies blocks only and
 * reports the rest as warnings, so nothing a person wrote is changed.
 */
export function carrierCheck(raw: string, opts: { mode?: 'outreach' | 'reply' } = {}): CarrierCheck {
  const rewrite = (opts.mode ?? 'outreach') === 'outreach';
  const findings: CarrierFinding[] = [];
  let t = String(raw ?? '');

  // Blocks first, on the text as written.
  for (const b of BLOCKS) {
    for (const m of t.matchAll(b.re)) findings.push({ severity: 'block', found: m[0], why: b.why });
  }

  // The greeting's name.
  const g = GREETING.exec(t);
  if (g) {
    const name = greetingName(g[2]);
    if (name && name !== g[2].trim()) {
      if (rewrite) t = t.replace(GREETING, `${g[1]}${name}`);
      findings.push({ severity: rewrite ? 'fix' : 'warn', found: g[2].trim(), to: name, why: name === 'there' ? 'the name on file is not a person’s name (a website or placeholder reads as spam, and a site name reads as a link)' : 'names in all capitals read as shouting to spam filters' });
    }
  }

  for (const s of SWAPS) {
    t = t.replace(s.re, (m: string, ...groups: unknown[]) => {
      const to = keepCase(m, s.to.replace(/\$1/g, typeof groups[0] === 'string' ? groups[0] : ''));
      findings.push({ severity: rewrite ? 'fix' : 'warn', found: m, to, why: s.why });
      return rewrite ? to : m;
    });
  }

  // Shouting: a run of two or more upper-case words, or one of four or more
  // letters, minus carrier keywords and trade acronyms. The run's first word
  // keeps its capital.
  t = t.replace(/\b[A-Z]{2,}(?:[ \t]+[A-Z]{2,})+\b|\b[A-Z]{4,}\b/g, (run) => {
    let first = true;
    const to = run.replace(/[A-Z]+/g, (w) => {
      const keep = CAPS_OK.has(w);
      const lowered = keep ? w : first ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase();
      first = false;
      return lowered;
    });
    if (to === run) return run;
    findings.push({ severity: rewrite ? 'fix' : 'warn', found: run, to, why: 'words in all capitals read as shouting to spam filters' });
    return rewrite ? to : run;
  });

  // Stacked punctuation and money signs.
  t = t.replace(/([!?])\1+|\${2,}/g, (m) => {
    const to = m[0];
    findings.push({ severity: rewrite ? 'fix' : 'warn', found: m, to, why: 'stacked "!!!", "???" or "$$$" is scored as spam' });
    return rewrite ? to : m;
  });

  for (const w of WARNS) {
    for (const m of t.matchAll(w.re)) findings.push({ severity: 'warn', found: m[0], why: w.why });
  }
  const links = t.match(/\bhttps?:\/\/\S+|\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|ai|io|co|app|us|me|link|page|site)(?:\/\S*)?/gi) ?? [];
  if (links.length > 1) findings.push({ severity: 'warn', found: `${links.length} links`, why: 'more than one link in a text raises its spam score; send one' });

  return { text: rewrite ? t.replace(/[ \t]{2,}/g, ' ') : t, findings, blocked: findings.some((f) => f.severity === 'block') };
}

/** One line for a refusal or a log: what was blocked and why, or what was changed. */
export function carrierReport(c: CarrierCheck, kinds: CarrierSeverity[] = ['block']): string {
  return c.findings.filter((f) => kinds.includes(f.severity))
    .map((f) => (f.to !== undefined && f.severity === 'fix' ? `"${f.found}" to "${f.to}" (${f.why})` : `"${f.found}": ${f.why}`))
    .join('; ');
}
