// A script as the dialer reads it: sections of spoken lines, branches the
// rep picks with a button, notes to the rep, and merge fields filled from
// the record on the line. Pure logic, no React: tools/acme-homes-playbook.test.ts
// covers it.
//
// Body grammar (the same light markdown ScriptsManager edits):
//   ## Section title
//   A spoken line, one per paragraph.
//   - If <condition>: <what to say>      a branch (button labelled <condition>)
//   - a plain bullet                       a spoken line
//   > a note to the rep                    not read aloud
//   {field}                                a merge field

import type { ClozrRecord } from '@/app/components/talkr/CallContext';
import type { ScriptDto } from './talkr-web/api';

export type ScriptLine =
  | { kind: 'say'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'branch'; label: string; text: string };

export type ScriptSectionDoc = { title: string; lines: ScriptLine[] };
export type ScriptDoc = { title: string; sections: ScriptSectionDoc[] };

/** Body → sections. Text above the first heading lands in an untitled first section. */
export function parseScriptDoc(title: string, body: string): ScriptDoc {
  const sections: ScriptSectionDoc[] = [];
  let cur: ScriptSectionDoc | null = null;
  const open = (t: string) => { cur = { title: t, lines: [] }; sections.push(cur); };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) { open(h[1]!.trim()); continue; }
    if (!cur) open('');
    const note = /^>\s?(.*)$/.exec(line);
    if (note) { cur!.lines.push({ kind: 'note', text: note[1]!.trim() }); continue; }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet) {
      const branch = /^If\s+([^:]+):\s*(.+)$/i.exec(bullet[1]!);
      if (branch) cur!.lines.push({ kind: 'branch', label: branch[1]!.trim(), text: branch[2]!.trim() });
      else cur!.lines.push({ kind: 'say', text: bullet[1]!.trim() });
      continue;
    }
    cur!.lines.push({ kind: 'say', text: line });
  }
  return { title, sections };
}

// ── Merge fields ─────────────────────────────────────────────────────────────

/** What a blank chip says when the record has no value for the field. */
export const MERGE_LABEL: Record<string, string> = {
  first_name: 'first name', name: 'name', address: 'address', city: 'city', state: 'state', postal_code: 'ZIP', phone: 'phone', email: 'email',
  company: 'company', rep_name: 'your name', rep_first_name: 'your first name',
  asking: 'asking price', offer: 'our offer', mao: 'COMPR MAO', arv: 'ARV', condition: 'condition', motivation: 'motivation',
  timeframe: 'timeframe', beds_baths: 'beds/baths', sqft: 'sqft', buybox: 'buy box', markets: 'markets', last_purchase: 'last purchase',
  deal_property: 'the property',
};

const fact = (r: ClozrRecord, label: string) => r.facts.find(([k]) => k === label)?.[1] ?? '';

/**
 * The merge map for the record on the line. Talkr's own fields (first_name,
 * address, rep_name…) and CLOZR's deal fields (asking, offer, mao, arv…) in
 * one map; `extra` (Talkr's merge_fields) wins where it has a value.
 */
export function mergeFieldsFor(record: ClozrRecord | null, rep: { name?: string | null; company?: string | null }, extra: Record<string, string> = {}): Record<string, string> {
  const name = record?.name ?? '';
  const repName = rep.name?.trim() ?? '';
  const out: Record<string, string> = {
    first_name: name.split(/\s+/)[0] ?? '', name, phone: record?.phone ?? '', email: record?.email ?? '',
    company: rep.company ?? 'Acme Homes', rep_name: repName, rep_first_name: repName.split(/\s+/)[0] ?? '',
  };
  if (record?.kind === 'seller') {
    Object.assign(out, {
      address: record.address, asking: fact(record, 'Asking'), offer: fact(record, 'Last offer'), mao: fact(record, 'MAO'), arv: fact(record, 'ARV'),
      condition: fact(record, 'Condition'), motivation: fact(record, 'Motivation'), timeframe: fact(record, 'Timeline'),
      beds_baths: fact(record, 'Beds/baths'), sqft: fact(record, 'Sqft'),
    });
  } else if (record?.kind === 'buyer') {
    Object.assign(out, {
      markets: record.address, buybox: [fact(record, 'Buy box'), fact(record, 'Property type'), fact(record, 'Strategy')].filter(Boolean).join(', '),
      last_purchase: fact(record, 'Last purchase'), deal_property: fact(record, 'On deal').replace(/\s*\([^)]*\)\s*$/, ''),
      asking: fact(record, 'Latest offer'),
    });
  }
  for (const [k, v] of Object.entries(extra)) if (v && v.trim()) out[k] = v;
  return out;
}

export type MergeRun = { kind: 'text' | 'value' | 'blank'; text: string; field?: string };

/** A spoken line split into text, filled values and blank chips. */
export function mergeRuns(text: string, values: Record<string, string>): MergeRun[] {
  const runs: MergeRun[] = [];
  for (const part of text.split(/(\{[a-z_]+\})/g)) {
    if (!part) continue;
    const m = /^\{([a-z_]+)\}$/.exec(part);
    if (!m) { runs.push({ kind: 'text', text: part }); continue; }
    const v = values[m[1]!];
    if (v && v.trim() && v !== '—') runs.push({ kind: 'value', text: v, field: m[1] });
    else runs.push({ kind: 'blank', text: MERGE_LABEL[m[1]!] ?? m[1]!.replace(/_/g, ' '), field: m[1] });
  }
  return runs;
}

// ── Which script, which rebuttals ────────────────────────────────────────────

type Scriptish = Pick<ScriptDto, 'kind' | 'title' | 'category' | 'tags' | 'contact_types' | 'body'> & { id?: string; enabled?: boolean };

const forKind = (s: Scriptish, kind: 'seller' | 'buyer') =>
  s.enabled !== false && (s.contact_types.length === 0 || s.contact_types.includes(kind));

/** The scripts a rep can read to this kind of party, primary first. */
export function scriptsFor<T extends Scriptish>(all: readonly T[], kind: 'seller' | 'buyer', primaryTitle?: string | null): T[] {
  const list = all.filter((s) => s.kind === 'script' && forKind(s, kind));
  if (!primaryTitle) return list;
  const i = list.findIndex((s) => s.title === primaryTitle);
  return i > 0 ? [list[i]!, ...list.slice(0, i), ...list.slice(i + 1)] : list;
}

export function rebuttalsFor<T extends Scriptish>(all: readonly T[], kind: 'seller' | 'buyer'): T[] {
  return all.filter((s) => s.kind === 'rebuttal' && forKind(s, kind));
}

/** The objection chips across the top of the panel, in this order; everything else sits under More. */
export const OBJECTION_CHIPS = ['Price', 'Agent', 'Timing', 'Spouse', 'Not interested', 'Call back'] as const;

/**
 * The rebuttal the seller's last words call for, by keyword: the longest tag
 * found in the text wins, so "call me back next month" lands on Call back and
 * not on Timing. Null when nothing matches.
 */
export function matchObjection<T extends Pick<Scriptish, 'tags'>>(text: string, rebuttals: readonly T[]): T | null {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  let best: { r: T; len: number } | null = null;
  for (const r of rebuttals) {
    for (const tag of r.tags) {
      const k = ` ${tag.toLowerCase()} `;
      if (t.includes(k) && (!best || k.length > best.len)) best = { r, len: k.length };
    }
  }
  return best?.r ?? null;
}

/** The first spoken line of a rebuttal, for the "Say next" card. */
export function firstLine(body: string): string {
  const doc = parseScriptDoc('', body);
  for (const s of doc.sections) for (const l of s.lines) if (l.kind === 'say') return l.text;
  return '';
}
