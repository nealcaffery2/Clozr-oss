// A Word (or plain-text) contract as a CLOZR text template, mapped with the
// same rules as an uploaded PDF (lib/pdf-autodetect classify):
//   a signature line            → {{sign:role}}  (its printed-name and date
//                                  lines go: the block prints its own)
//   a value the record holds    → {{seller.name}}, {{deal.purchase_price}}…
//   anything else               → [Fill.Label], asked for when sending
//   a short ALL-CAPS line       → ### heading
// Pure: npx tsx tools/pdf-autodetect.test.ts covers it with the PDF rules.

import { classify, partyOf, sideOf, tidyLabel, whoIn, type Who } from './pdf-autodetect';

export type TextTemplate = {
  body_md: string;
  signers: { role: string; label: string; party: string; optional?: boolean }[];
  mapped: { label: string; to: string }[];
  side: 'acquisition' | 'disposition';
};

const BLANK = /_{3,}|\.{6,}|…{3,}/g;
const LABEL: Record<Who, string> = { seller: 'Seller', seller2: 'Seller 2', buyer: 'Buyer', assignor: 'Assignor', assignee: 'Assignee', company: 'Company' };
const ORDER: Who[] = ['seller', 'seller2', 'buyer', 'assignor', 'assignee', 'company'];

/** "Forwarding address" → "Fill.ForwardingAddress": a fill-in the New contract form asks for. */
export function fillToken(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return `Fill.${words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Value'}`;
}

export function autoMapText(text: string, meta: { name?: string; kind?: string } = {}): TextTemplate {
  const kind = meta.kind ?? 'other';
  const side = sideOf(meta.name ?? '', kind);
  const out: string[] = [];
  const mapped: TextTemplate['mapped'] = [];
  const signed = new Set<Who>();
  let ctx: Who | null = null;
  let sinceSign = 99;
  let lastSign: Who | null = null;

  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const t = raw.replace(/\t+/g, ' ').trim();
    sinceSign++;
    if (!t) { out.push(''); continue; }
    const w = whoIn(t);
    if (w && t.length <= 48 && !/_{3,}/.test(t)) ctx = w;
    const inBlock = sinceSign <= 3 && !!lastSign;
    const blanks = [...t.matchAll(BLANK)];

    if (!blanks.length) {
      if (/^(.{0,30}\b)?signature\b|^signature of/i.test(t) && t.length <= 60) {
        const who = whoIn(t) ?? ctx ?? 'seller';
        out.push(`{{sign:${who}}}`); signed.add(who); lastSign = who; sinceSign = 0;
        continue;
      }
      if (inBlock && /^(date|print(ed)? name|name)\b/i.test(t)) continue;
      const letters = t.replace(/[^A-Za-z]/g, '');
      out.push(letters.length >= 4 && t.length <= 70 && t === t.toUpperCase() && !/[.;,]$/.test(t) ? `### ${t}` : t);
      continue;
    }

    let line = '';
    let prevEnd = 0;
    let isBlock = false;
    for (const [bi, m] of blanks.entries()) {
      const start = m.index!, end = start + m[0].length;
      let label = t.slice(prevEnd, start);
      const after = t.slice(end, blanks[bi + 1]?.index ?? t.length);
      if (!tidyLabel(label) && bi === blanks.length - 1) label = after;
      const c = classify(label, { ctx: (inBlock ? lastSign : null) ?? ctx, inSignBlock: inBlock || /sign/i.test(label), side, kind, longBlank: m[0].length >= 20, after });
      if (c.type === 'signature' && c.who) {
        signed.add(c.who); lastSign = c.who; sinceSign = 0; isBlock = true;
        out.push(`{{sign:${c.who}}}`);
        break;
      }
      // The printed name and date under a signature print with its block.
      if (inBlock && (c.type === 'date_signed' || 'printedName' in c || c.type === 'initials')) { isBlock = true; break; }
      let piece: string;
      if ('variable_key' in c && c.variable_key) { piece = `{{${c.variable_key}}}`; mapped.push({ label: c.label, to: c.variable_key }); }
      else {
        const name = ('label' in c && c.label) || tidyLabel(label) || 'Value';
        piece = `[${fillToken(name)}]`;
        mapped.push({ label: name, to: fillToken(name) });
      }
      line += t.slice(prevEnd, start) + piece;
      prevEnd = end;
    }
    if (isBlock) continue;
    out.push(line + t.slice(prevEnd));
  }

  const roles = [...signed];
  if (!roles.length) {
    roles.push('seller', 'buyer');
    out.push('', '{{sign:seller}}', '', '{{sign:buyer}}');
  }
  roles.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return {
    body_md: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n',
    signers: roles.map((r) => ({ role: r, label: LABEL[r], party: partyOf(r, side), ...(r === 'seller2' ? { optional: true } : {}) })),
    mapped, side,
  };
}
