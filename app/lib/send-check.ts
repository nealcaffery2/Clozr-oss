// What a text or email will run into before it goes out, in plain words, and
// the version that passes. The plan step editor shows it as the rep types, so
// nothing reaches a carrier (or a spam folder) without them having been told.
//
// Carrier wording (lib/carrier-safe), the writing guard (no-ai-slop), and the
// text's size: a text over 160 plain characters, or over 70 once any curly
// quote, emoji or accent makes it Unicode, is split into several messages,
// and long multi-part cold texts are what carriers filter.

import { PLAIN_TO, carrierCheck } from './carrier-safe';
import { cleanMechanicalSlop, slopFindings } from '../supabase/functions/_shared/no-ai-slop';

export type SendIssue = { level: 'red' | 'amber'; what: string; fix: string };
export type SendCheck = { issues: SendIssue[]; fixed: string; segments: number; unicode: boolean; green: boolean };

// GSM-7: what a text can carry at 160 characters a part.
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

/** Curly quotes and dashes a phone keyboard or a doc paste put in; plain ones keep a text GSM. */
export function plainPunctuation(t: string): string {
  return t.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/ /g, ' ');
}

export function smsSegments(t: string): { segments: number; unicode: boolean } {
  const unicode = !GSM.test(t);
  const n = [...t].length;
  if (unicode) return { unicode, segments: n <= 70 ? 1 : Math.ceil(n / 67) };
  return { unicode, segments: n <= 160 ? 1 : Math.ceil(n / 153) };
}

export function checkMessage(body: string, channel: 'sms' | 'email'): SendCheck {
  const issues: SendIssue[] = [];
  const text = body ?? '';

  for (const f of slopFindings(text)) {
    const mechanical = /bold|em dash|emoji/i.test(f.pattern);
    issues.push({
      level: 'amber',
      what: `${f.pattern}: "${f.quote}"`,
      fix: mechanical ? `${f.fix} (Fix it does this)` : f.fix,
    });
  }
  if (/^\s{0,3}#{1,6}\s|^\s*[-*]\s+\S/m.test(text)) {
    issues.push({ level: 'amber', what: 'Markdown headings or bullets', fix: 'write it as plain sentences; a phone shows the # and * as typed' });
  }

  let fixed = cleanMechanicalSlop(text).replace(/\*\*/g, '');
  if (channel === 'sms') {
    const c = carrierCheck(fixed, { mode: 'outreach' });
    // The look-alike punctuation is reported once, below, as the Unicode note.
    for (const f of c.findings.filter((x) => x.to !== PLAIN_TO)) {
      issues.push({
        level: f.severity === 'block' ? 'red' : 'amber',
        what: `"${f.found}": ${f.why}`,
        fix: f.severity === 'block' ? 'take it out; this text will not send with it' : f.to !== undefined ? `say "${f.to}" (Fix it does this)` : 'reword it',
      });
    }
    fixed = plainPunctuation(c.text);
    const before = smsSegments(text);
    const after = smsSegments(fixed);
    if (before.unicode && !after.unicode) {
      issues.push({ level: 'amber', what: 'Curly quotes or symbols make this a Unicode text (70 characters a part, not 160)', fix: 'use plain quotes and apostrophes (Fix it does this)' });
    }
    if (after.unicode) {
      issues.push({ level: 'amber', what: 'An emoji or accented letter makes this a Unicode text (70 characters a part)', fix: 'take it out to fit 160 characters a part' });
    }
    if (after.segments >= 4) {
      issues.push({ level: 'red', what: `${after.segments} texts long (${[...fixed].length} characters)`, fix: 'carriers filter long multi-part cold texts: cut it to one or two parts (under 300 characters), one ask, one link' });
    } else if (after.segments === 3) {
      issues.push({ level: 'amber', what: `3 texts long (${[...fixed].length} characters)`, fix: 'under 300 characters keeps it to two parts' });
    }
    return { issues, fixed, segments: after.segments, unicode: after.unicode, green: issues.length === 0 };
  }
  return { issues, fixed, segments: 0, unicode: false, green: issues.length === 0 };
}
