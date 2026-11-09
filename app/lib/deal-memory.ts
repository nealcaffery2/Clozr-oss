// Deal memory (migration 399): the Smart Summary for a deal under contract.
//
// The TC and the owner need one answer to "where does this deal stand, and
// what disagrees with what": the contract PDFs, the deal sheet, the TC file,
// every email, text and note on the deal. The deal-memory edge function reads
// all of it, asks Claude for a brief, the terms, the timeline, the parties and
// the conflicts, each with its sources, and stores one row per deal.
//
// Pure: the browser panel and the edge function (Deno) share one definition
// of what a deal memory is, how model output is cleaned, the rule-based
// conflict and missing-item checks, staleness, and the no-model fallback.
// Tests: npx tsx tools/deal-memory.test.ts
import { normDate, normMoney, normName } from '../supabase/functions/_shared/extract-diff.ts';

// ---- shapes -----------------------------------------------------------------------------

/** Where a fact came from. `ref` keys into the memory's source catalogue. */
export type SourceCite = { ref: string; quote: string | null; page: number | null };

export type SourceKind = 'document' | 'contract' | 'email' | 'text' | 'call' | 'note' | 'activity' | 'field' | 'tc_file' | 'party';

/** One thing the summary was read from, with what the panel needs to open it. */
export type SourceEntry = {
  kind: SourceKind;
  label: string;
  at: string | null;
  deal_file_id?: number | null;
  contract_id?: number | null;
  provider?: string | null;
  communication_id?: number | null;
  /** A short excerpt of a message, so the panel can show it before the full row loads. */
  preview?: string | null;
};
export type SourceCatalog = Record<string, SourceEntry>;

export const TERM_KEYS = [
  'purchase_price', 'assignment_fee', 'buyer_price', 'emd_amount', 'emd_due', 'contract_date',
  'inspection_end', 'closing_date', 'structure', 'title_company', 'contingencies',
] as const;
export type TermKey = (typeof TERM_KEYS)[number];

export const TERM_LABEL: Record<TermKey, string> = {
  purchase_price: 'Purchase price', assignment_fee: 'Assignment fee', buyer_price: 'End buyer price', emd_amount: 'EMD',
  emd_due: 'EMD due', contract_date: 'Contract signed', inspection_end: 'Inspection ends', closing_date: 'Closing',
  structure: 'Structure', title_company: 'Title company', contingencies: 'Contingencies',
};

export type DealTerm = { key: TermKey; value: string; confidence: number; sources: SourceCite[] };
export type DealEvent = { date: string | null; label: string; done: boolean; sources: SourceCite[] };
export type DealPartyMem = { name: string; role: string; company: string | null; email: string | null; phone: string | null };
export type IssueKind = 'conflict' | 'missing';
export type Severity = 'high' | 'medium' | 'low';
export type DealIssue = { kind: IssueKind; topic: string; severity: Severity; text: string; sources: SourceCite[] };

export type DealMemoryBody = {
  brief: string;
  issues: DealIssue[];
  terms: DealTerm[];
  timeline: DealEvent[];
  parties: DealPartyMem[];
};

export type DealMemory = DealMemoryBody & {
  workspace_id: number;
  deal_id: number;
  sources: SourceCatalog;
  input_hash: string | null;
  source_count: number;
  last_source_at: string | null;
  model: string | null;
  updated_at: string;
};

export const BRIEF_MAX = 900;

// ---- what the function reads, as plain data ---------------------------------------------

/** Everything on file for one deal, already flattened by the edge function. */
export type DealInput = {
  dealId: number;
  address: string | null;
  stage: string | null;
  /** ISO time the read happened; "today" for every date rule. */
  now: string;
  /** The deal row's fields that hold something. */
  deal: Record<string, unknown>;
  /** The title vendor's business name, when the deal names one. */
  titleCompany: string | null;
  /** The TC file (transactions row) and its source ref. */
  tc: { ref: string; row: Record<string, unknown> } | null;
  /** Files and e-sign contracts. `type` is a deal-docs DocType or a contract kind. */
  docs: { ref: string; name: string; type: string; at: string | null; signed: boolean }[];
  /** Terms docs-extract read off a PDF (contract_extractions), cited to their document. */
  extractions: { docRef: string; docType: string; key: string; value: string; page: number | null; confidence: number | null }[];
  /** Emails, texts, calls and notes, newest first. */
  messages: { ref: string; kind: string; at: string; who: string; subject: string | null; text: string }[];
  activity: { ref: string; at: string; text: string }[];
  parties: { ref: string; role: string; name: string | null; company: string | null; email: string | null; phone: string | null }[];
};

// ---- the schema the model answers in ----------------------------------------------------

const CITES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      page: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
    required: ['ref', 'quote', 'page'],
    additionalProperties: false,
  },
} as const;

export const DEAL_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['conflict', 'missing'] },
          topic: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          text: { type: 'string' },
          sources: CITES,
        },
        required: ['kind', 'topic', 'severity', 'text', 'sources'],
        additionalProperties: false,
      },
    },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: [...TERM_KEYS] },
          value: { type: 'string' },
          confidence: { type: 'number' },
          sources: CITES,
        },
        required: ['key', 'value', 'confidence', 'sources'],
        additionalProperties: false,
      },
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          label: { type: 'string' },
          done: { type: 'boolean' },
          sources: CITES,
        },
        required: ['date', 'label', 'done', 'sources'],
        additionalProperties: false,
      },
    },
    parties: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          company: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          phone: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['name', 'role', 'company', 'email', 'phone'],
        additionalProperties: false,
      },
    },
  },
  required: ['brief', 'issues', 'terms', 'timeline', 'parties'],
  additionalProperties: false,
} as const;

// ---- cleaning ---------------------------------------------------------------------------

/** The model is told never to use one; this is the belt to that brace. */
const noDash = (s: string) => s.replace(/\s*[—–]\s*(?=\D)/g, ', ').replace(/\s*—\s*/g, ', ');
const str = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const t = noDash(v.replace(/\s+/g, ' ').trim());
  return t ? t.slice(0, max) : null;
};
const isoDay = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return normDate(s);
};
const SEV: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function cites(v: unknown, known: (ref: string) => boolean): SourceCite[] {
  const out: SourceCite[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(v) ? v : []) {
    const o = (c ?? {}) as Record<string, unknown>;
    const ref = str(o.ref, 80);
    if (!ref || !known(ref)) continue;
    const page = Number.isInteger(o.page) && (o.page as number) > 0 ? (o.page as number) : null;
    const key = `${ref}#${page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, quote: str(o.quote, 240), page });
    if (out.length >= 4) break;
  }
  return out;
}

/** Conflicts before missing items, then the most serious first. */
export function sortIssues(issues: DealIssue[]): DealIssue[] {
  return [...issues].sort((a, b) => (a.kind === b.kind ? SEV[a.severity] - SEV[b.severity] : a.kind === 'conflict' ? -1 : 1));
}

/**
 * Model output (or a stored jsonb) into a clean body. A citation to a source
 * the function did not send is dropped, so every source the panel shows opens.
 */
export function cleanDealMemory(raw: unknown, catalog: SourceCatalog | null): DealMemoryBody {
  const o = (raw ?? {}) as Record<string, unknown>;
  const known = (ref: string) => !catalog || ref in catalog;
  const issues: DealIssue[] = [];
  for (const x of Array.isArray(o.issues) ? o.issues : []) {
    const i = (x ?? {}) as Record<string, unknown>;
    const text = str(i.text, 500);
    if (!text) continue;
    issues.push({
      kind: i.kind === 'missing' ? 'missing' : 'conflict',
      topic: str(i.topic, 60)?.toLowerCase().replace(/\s+/g, '_') ?? 'other',
      severity: i.severity === 'high' || i.severity === 'low' ? i.severity : 'medium',
      text, sources: cites(i.sources, known),
    });
  }
  const terms: DealTerm[] = [];
  const seenTerm = new Set<string>();
  for (const x of Array.isArray(o.terms) ? o.terms : []) {
    const t = (x ?? {}) as Record<string, unknown>;
    const key = (TERM_KEYS as readonly string[]).includes(String(t.key)) ? (t.key as TermKey) : null;
    const value = str(t.value, 200);
    if (!key || !value || seenTerm.has(key)) continue;
    seenTerm.add(key);
    const c = Number(t.confidence);
    terms.push({ key, value, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5, sources: cites(t.sources, known) });
  }
  terms.sort((a, b) => TERM_KEYS.indexOf(a.key) - TERM_KEYS.indexOf(b.key));
  const timeline: DealEvent[] = [];
  for (const x of Array.isArray(o.timeline) ? o.timeline : []) {
    const e = (x ?? {}) as Record<string, unknown>;
    const label = str(e.label, 160);
    if (!label) continue;
    timeline.push({ date: isoDay(e.date), label, done: e.done === true, sources: cites(e.sources, known) });
  }
  timeline.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const parties: DealPartyMem[] = [];
  for (const x of Array.isArray(o.parties) ? o.parties : []) {
    const p = (x ?? {}) as Record<string, unknown>;
    const name = str(p.name, 120);
    if (!name) continue;
    parties.push({ name, role: str(p.role, 40) ?? 'other', company: str(p.company, 120), email: str(p.email, 160), phone: str(p.phone, 40) });
  }
  return {
    brief: (str(o.brief, BRIEF_MAX + 200) ?? '').slice(0, BRIEF_MAX),
    issues: sortIssues(issues).slice(0, 12),
    terms,
    timeline: timeline.slice(0, 20),
    parties: parties.slice(0, 16),
  };
}

export function parseModelDealMemory(text: string, catalog: SourceCatalog): DealMemoryBody | null {
  try {
    const body = cleanDealMemory(JSON.parse(text), catalog);
    return body.brief ? body : null;
  } catch {
    return null;
  }
}

/** A stored row into a DealMemory; null for anything that is not one. */
export function rowToDealMemory(row: unknown): DealMemory | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.deal_id == null || r.workspace_id == null) return null;
  const catalog = (r.sources && typeof r.sources === 'object' ? r.sources : {}) as SourceCatalog;
  const body = cleanDealMemory(r.body ?? r, catalog);
  return {
    ...body,
    workspace_id: Number(r.workspace_id), deal_id: Number(r.deal_id), sources: catalog,
    input_hash: typeof r.input_hash === 'string' ? r.input_hash : null,
    source_count: Number(r.source_count ?? 0) || 0,
    last_source_at: typeof r.last_source_at === 'string' ? r.last_source_at : null,
    model: typeof r.model === 'string' ? r.model : null,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : new Date(0).toISOString(),
  };
}

// ---- rule checks: what disagrees, and what is missing -----------------------------------

/** One source's statement of one term. */
export type Claim = { key: TermKey; value: string; ref: string; page: number | null; said: string; /** The words around it, for a message. */ quote?: string };

type Norm = string | number | null;
const STRUCT_LABEL: Record<string, string> = { assignment: 'an assignment', double_close: 'a double close', novation: 'a novation', jv: 'a JV' };

/** "Double close", "double closing", "simultaneous close" → double_close, and so on. */
export function normStructure(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!s.trim()) return null;
  if (/double\s*clos|back\s*to\s*back|simultaneous\s*clos/.test(s)) return 'double_close';
  if (/novation/.test(s)) return 'novation';
  if (/\bjv\b|joint\s*venture/.test(s)) return 'jv';
  if (/assign|wholesale/.test(s)) return 'assignment';
  return null;
}

const MONEY_KEYS: TermKey[] = ['purchase_price', 'assignment_fee', 'buyer_price', 'emd_amount'];
const DATE_KEYS: TermKey[] = ['emd_due', 'contract_date', 'inspection_end', 'closing_date'];

export function normTerm(key: TermKey, v: unknown): Norm {
  if (MONEY_KEYS.includes(key)) return normMoney(v);
  if (DATE_KEYS.includes(key)) return isoDay(v);
  if (key === 'structure') return normStructure(v);
  if (key === 'title_company') return normName(String(v ?? '').replace(/\b(llc|inc|co|company|title|of|the)\b/gi, ' ')) || null;
  return normName(v) || null;
}

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const dayLabel = (iso: string) => {
  const t = Date.parse(iso + 'T12:00:00Z');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : iso;
};

/** A term's value as people say it: "$7,500", "Oct 30, 2026", "a double close". */
export function displayTerm(key: TermKey, v: unknown): string {
  const n = normTerm(key, v);
  if (n == null) return String(v ?? '').trim();
  if (MONEY_KEYS.includes(key)) return usd(n as number);
  if (DATE_KEYS.includes(key)) return dayLabel(String(n));
  if (key === 'structure') return (STRUCT_LABEL[String(n)] ?? String(n)).replace(/^an? /, '').replace(/^./, (c) => c.toUpperCase());
  return String(v ?? '').trim();
}

const DEAL_FIELD_TERMS: [string, TermKey][] = [
  ['offer_amount', 'purchase_price'], ['assignment_fee', 'assignment_fee'], ['sold_price', 'buyer_price'], ['earnest_money', 'emd_amount'],
  ['contract_date', 'contract_date'], ['option_ends_on', 'inspection_end'], ['close_date', 'closing_date'], ['transaction_type', 'structure'],
];
const TC_TERMS: [string, TermKey][] = [
  ['emd_amount', 'emd_amount'], ['close_date', 'closing_date'], ['option_ends_on', 'inspection_end'], ['title_company', 'title_company'],
  ['contract_date', 'contract_date'], ['structure', 'structure'],
];
const EXTRACT_TERMS: Record<string, TermKey> = {
  purchase_price: 'purchase_price', assignment_fee: 'assignment_fee', emd_amount: 'emd_amount', emd_due_date: 'emd_due',
  option_period_end: 'inspection_end', close_date: 'closing_date', contract_date: 'contract_date', title_company: 'title_company',
};

/** "$7,500" out of "assignment fee of $7,500", "7,500 assignment fee" and the like. */
const FEE_IN_TEXT = /assignment\s+fee\s*(?:is|of|at|will\s+be|=|:)?\s*\$\s?([\d,]+(?:\.\d{1,2})?)\s*(k\b)?|\$\s?([\d,]+(?:\.\d{1,2})?)\s*(k\b)?\s+assignment\s+fee/i;
const STRUCT_IN_TEXT = /\b(double[\s-]?clos(?:e|ing)|simultaneous\s+clos(?:e|ing)|novation)\b/i;

function snippet(text: string, at: number, len = 160): string {
  const start = Math.max(0, text.lastIndexOf('.', at) + 1, at - 80);
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

/** Every term each source states: the deal sheet, the TC file, the PDFs, and money or structure said in a message. */
export function claimsFrom(input: DealInput): Claim[] {
  const out: Claim[] = [];
  for (const [col, key] of DEAL_FIELD_TERMS) {
    const v = input.deal[col];
    if (v == null || v === '' || normTerm(key, v) == null) continue;
    out.push({ key, value: String(v), ref: `field:${col}`, page: null, said: 'the deal record' });
  }
  if (input.titleCompany) out.push({ key: 'title_company', value: input.titleCompany, ref: 'field:title_vendor_id', page: null, said: 'the deal record' });
  if (input.tc) {
    for (const [col, key] of TC_TERMS) {
      const v = input.tc.row[col];
      if (v == null || v === '' || normTerm(key, v) == null) continue;
      out.push({ key, value: String(v), ref: input.tc.ref, page: null, said: 'the TC file' });
    }
  }
  const docName = new Map(input.docs.map((d) => [d.ref, d.name]));
  for (const x of input.extractions) {
    let key = EXTRACT_TERMS[x.key];
    if (!key) continue;
    // On the assignment (B to C) the price printed is what the end buyer pays.
    if (key === 'purchase_price' && /assign/i.test(x.docType)) key = 'buyer_price';
    if (normTerm(key, x.value) == null) continue;
    const name = docName.get(x.docRef) ?? 'the contract';
    out.push({ key, value: x.value, ref: x.docRef, page: x.page, said: `${name}${x.page ? ` (page ${x.page})` : ''}` });
  }
  for (const m of input.messages) {
    const text = `${m.subject ?? ''} ${m.text}`;
    const when = m.at ? new Date(m.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
    const kindWord = m.kind === 'email' ? 'An email' : m.kind === 'sms' || m.kind === 'text' ? 'A text' : m.kind === 'call' ? 'A call' : 'A note';
    const said = `${kindWord}${m.who ? ` from ${m.who}` : ''}${when ? ` on ${when}` : ''}`;
    const s = text.match(STRUCT_IN_TEXT);
    if (s && s.index != null) out.push({ key: 'structure', value: s[1], ref: m.ref, page: null, said, quote: snippet(text, s.index) });
    const f = text.match(FEE_IN_TEXT);
    if (f && f.index != null) {
      const raw = f[1] ?? f[3];
      const k = f[2] ?? f[4];
      const n = normMoney(raw);
      if (n != null) out.push({ key: 'assignment_fee', value: String(k ? n * 1000 : n), ref: m.ref, page: null, said, quote: snippet(text, f.index) });
    }
  }
  return out;
}

const TOPIC_SEVERITY: Partial<Record<TermKey, Severity>> = {
  purchase_price: 'high', assignment_fee: 'high', buyer_price: 'high', structure: 'high', closing_date: 'high',
  emd_amount: 'medium', emd_due: 'medium', inspection_end: 'medium', contract_date: 'low', title_company: 'medium',
};

/** The terms two or more sources state differently, one issue per term, each source named. */
export function termConflicts(claims: Claim[]): DealIssue[] {
  const byKey = new Map<TermKey, Claim[]>();
  for (const c of claims) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  const issues: DealIssue[] = [];
  for (const [key, cs] of byKey) {
    // value → the sources that say it, in the order they were read.
    const groups = new Map<string, Claim[]>();
    for (const c of cs) {
      const n = normTerm(key, c.value);
      if (n == null) continue;
      groups.set(String(n), [...(groups.get(String(n)) ?? []), c]);
    }
    if (groups.size < 2) continue;
    const parts = [...groups.values()].map((g) => {
      const who = [...new Set(g.map((c) => c.said))];
      const what = key === 'structure' ? STRUCT_LABEL[String(normTerm(key, g[0].value))] ?? displayTerm(key, g[0].value) : displayTerm(key, g[0].value);
      return `${joinWords(who)} ${who.length > 1 ? 'say' : 'says'} ${what}`;
    });
    issues.push({
      kind: 'conflict', topic: key, severity: TOPIC_SEVERITY[key] ?? 'medium',
      text: `${TERM_LABEL[key]} does not match. ${capital(parts.join('; '))}.`,
      sources: cs.slice(0, 4).map((c) => ({ ref: c.ref, quote: c.quote ?? c.value, page: c.page })),
    });
  }
  return sortIssues(issues);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function joinWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const DAY = 86_400_000;
const docIs = (input: DealInput, re: RegExp, signedOnly = false) => input.docs.some((d) => re.test(d.type) && (!signedOnly || d.signed));

/** What a deal under contract should have on file and does not. */
export function missingItems(input: DealInput, claims: Claim[] = claimsFrom(input)): DealIssue[] {
  const stage = String(input.stage ?? input.deal.stage ?? '');
  const closed = /closed|sold|terminated|dead|cancel/i.test(stage) || !!input.deal.closed_on;
  const today = input.now.slice(0, 10);
  const contractDate = isoDay(input.deal.contract_date ?? input.tc?.row.contract_date);
  const underContract = /contract|closing|title|clear to close|buyer/i.test(stage) || !!contractDate || docIs(input, /purchase|psa/, true);
  if (!underContract || closed) return [];
  const out: DealIssue[] = [];
  const add = (topic: string, severity: Severity, text: string, refs: string[] = []) =>
    out.push({ kind: 'missing', topic, severity, text, sources: refs.map((ref) => ({ ref, quote: null, page: null })) });

  const emdIn = !!input.tc?.row.emd_received_at || docIs(input, /emd/);
  if (!emdIn) {
    const late = contractDate ? Date.parse(today) - Date.parse(contractDate) > 3 * DAY : false;
    add('emd_receipt', late ? 'high' : 'medium', `No EMD receipt on file${contractDate ? ` and the contract was signed ${dayLabel(contractDate)}` : ''}.`, contractDate ? ['field:contract_date'] : []);
  }
  if (!docIs(input, /purchase|psa/)) add('purchase_agreement', 'high', 'No signed purchase agreement on file.');
  const structure = claims.find((c) => c.key === 'structure' && c.ref.startsWith('field:'));
  const hasBuyer = !!input.deal.buyer_id || input.parties.some((p) => p.role === 'buyer');
  if (hasBuyer && (!structure || normStructure(structure.value) === 'assignment') && !docIs(input, /assign/)) {
    add('assignment_contract', 'high', 'An end buyer is on the deal but no assignment contract is on file.');
  }
  if (!claims.some((c) => c.key === 'title_company') && !input.parties.some((p) => p.role === 'title')) add('title_company', 'medium', 'No title company on the deal.');
  const close = claims.find((c) => c.key === 'closing_date')?.value;
  const closeDay = close ? isoDay(close) : null;
  if (!closeDay) add('closing_date', 'medium', 'No closing date on the deal.');
  else if (closeDay < today) add('closing_date', 'high', `The closing date (${dayLabel(closeDay)}) has passed and the deal is not marked closed.`, ['field:close_date']);
  return sortIssues(out);
}

/**
 * The model's issues plus the rule checks it did not cover. A rule finding
 * on a topic the model already raised is dropped: the model's sentence quotes
 * the sources, the rule's only names them.
 */
export function mergeIssues(model: DealIssue[], rules: DealIssue[]): DealIssue[] {
  const seen = new Set(model.map((i) => `${i.kind}:${i.topic}`));
  return sortIssues([...model, ...rules.filter((r) => !seen.has(`${r.kind}:${r.topic}`))]).slice(0, 12);
}

// ---- staleness, fingerprints, display ---------------------------------------------------

/** Anything on the deal newer than the moment the summary read it. */
export function isStale(m: Pick<DealMemory, 'updated_at'> | null, newestInputAt: string | null | undefined): boolean {
  if (!m || !newestInputAt) return false;
  const a = Date.parse(newestInputAt), b = Date.parse(m.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/** FNV-1a over the inputs: the same inputs give the same hash, so an unchanged deal is never sent to the model twice. */
export function inputFingerprint(parts: readonly unknown[]): string {
  const s = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + s.length.toString(36);
}

/** done, overdue or upcoming, judged against today. */
export function eventState(e: Pick<DealEvent, 'date' | 'done'>, nowIso: string): 'done' | 'overdue' | 'upcoming' {
  if (e.done) return 'done';
  if (e.date && e.date < nowIso.slice(0, 10)) return 'overdue';
  return 'upcoming';
}

/** The collapsed bar's words: "2 conflicts, 1 missing", "All clear", or why there is nothing. */
export function issueCounts(m: Pick<DealMemoryBody, 'issues'> | null): { conflicts: number; missing: number; label: string } {
  const conflicts = m?.issues.filter((i) => i.kind === 'conflict').length ?? 0;
  const missing = m?.issues.filter((i) => i.kind === 'missing').length ?? 0;
  const bits = [conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : null, missing ? `${missing} missing` : null].filter(Boolean);
  return { conflicts, missing, label: bits.length ? bits.join(', ') : 'No conflicts found' };
}

/** "Assignment, p. 2", "Email · Oct 12", "Deal record": the words on a source chip. */
export function sourceLabel(c: SourceCite, catalog: SourceCatalog): string {
  const e = catalog[c.ref];
  if (!e) return 'Source';
  const day = e.at ? new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
  if (e.kind === 'document' || e.kind === 'contract') return `${e.label}${c.page ? `, p. ${c.page}` : ''}`;
  if (e.kind === 'field') return e.label;
  if (e.kind === 'tc_file') return 'TC file';
  const word = e.kind === 'email' ? 'Email' : e.kind === 'text' ? 'Text' : e.kind === 'call' ? 'Call' : e.kind === 'note' ? 'Note' : e.kind === 'party' ? 'Deal team' : 'Activity';
  return day ? `${word} · ${day}` : word;
}

/** Sources the panel can open: documents, contracts and messages. Fields and the TC file are shown, not opened. */
export const opensSource = (e: SourceEntry | undefined) => !!e && ['document', 'contract', 'email', 'text', 'call', 'note'].includes(e.kind);

// ---- the no-model fallback --------------------------------------------------------------

const PARTY_ROLE: Record<string, string> = {
  seller: 'Seller', buyer: 'End buyer', title: 'Title', listing_agent: 'Listing agent', buyers_agent: "Buyer's agent", realtor: 'Agent',
  tc: 'TC', acquisitions: 'Acquisitions', dispositions: 'Dispositions', lender: 'Lender', attorney: 'Attorney', wholesaler: 'Wholesaler',
};
export const partyRole = (role: string) => PARTY_ROLE[role] ?? role.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * A summary built from the record alone, stored when there is no API key or
 * the model call fails, so the panel still shows the terms, dates, people and
 * the rule-found conflicts.
 */
export function fallbackDealMemory(input: DealInput): DealMemoryBody {
  const claims = claimsFrom(input);
  const issues = sortIssues([...termConflicts(claims), ...missingItems(input, claims)]);
  const terms: DealTerm[] = [];
  for (const key of TERM_KEYS) {
    const cs = claims.filter((c) => c.key === key);
    if (!cs.length) continue;
    const first = cs.find((c) => c.ref.startsWith('doc:')) ?? cs[0];
    const agree = cs.every((c) => String(normTerm(key, c.value)) === String(normTerm(key, first.value)));
    terms.push({ key, value: displayTerm(key, first.value), confidence: agree ? 0.8 : 0.4, sources: cs.slice(0, 3).map((c) => ({ ref: c.ref, quote: c.value, page: c.page })) });
  }
  const today = input.now.slice(0, 10);
  const timeline: DealEvent[] = [];
  const ev = (key: TermKey, label: string) => {
    const c = claims.find((x) => x.key === key);
    const d = c ? isoDay(c.value) : null;
    if (c && d) timeline.push({ date: d, label, done: d <= today && key === 'contract_date', sources: [{ ref: c.ref, quote: null, page: c.page }] });
  };
  ev('contract_date', 'Contract signed');
  ev('emd_due', 'EMD due');
  ev('inspection_end', 'Inspection period ends');
  ev('closing_date', 'Closing');
  const emdAt = input.tc?.row.emd_received_at;
  if (emdAt) timeline.push({ date: isoDay(emdAt), label: 'EMD received', done: true, sources: [{ ref: input.tc!.ref, quote: null, page: null }] });
  timeline.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const parties: DealPartyMem[] = input.parties
    .filter((p) => p.name || p.company)
    .map((p) => ({ name: (p.name || p.company)!, role: partyRole(p.role), company: p.name ? p.company : null, email: p.email, phone: p.phone }));
  const t = (key: TermKey) => terms.find((x) => x.key === key)?.value;
  const brief = [
    `${input.address ?? 'This deal'} is at ${input.stage ?? 'an unknown stage'}.`,
    t('purchase_price') ? `Under contract at ${t('purchase_price')}${t('contract_date') ? ` since ${t('contract_date')}` : ''}.` : null,
    t('closing_date') ? `Closing ${t('closing_date')}${t('title_company') ? ` with ${t('title_company')}` : ''}.` : null,
    issues.length ? `${issueCounts({ issues }).label.replace(/^./, (c) => c.toUpperCase())} on file.` : null,
  ].filter(Boolean).join(' ');
  return { brief: brief.slice(0, BRIEF_MAX), issues, terms, timeline, parties };
}

// ---- /demo ------------------------------------------------------------------------------

/**
 * The sample deal's memory: the TC's real question. A title email says double
 * close, the assignment (page 2) says an assignment for $7,500, the deal
 * record says $5,000.
 */
export function demoDealMemory(seed: { dealId: number; address: string; closeDate?: string | null }): DealMemory {
  const now = Date.now();
  const ago = (d: number) => new Date(now - d * DAY).toISOString();
  const close = seed.closeDate ?? '2026-10-30';
  const sources: SourceCatalog = {
    'doc:c1': { kind: 'contract', label: 'Purchase agreement', at: '2026-10-02T15:00:00Z', contract_id: null },
    'doc:c2': { kind: 'contract', label: 'Assignment of contract', at: '2026-10-10T17:20:00Z', contract_id: null },
    'msg:1': { kind: 'email', label: `Re: ${seed.address}, title opened`, at: '2026-10-12T14:05:00Z', communication_id: null,
      preview: `Hi Casey, we opened title on ${seed.address}. Since this one is a double close we will need the transactional funding letter and both settlement statements by the 27th. Thanks, Dana, Example Title` },
    'msg:2': { kind: 'text', label: 'Text from Marcus Ortega', at: '2026-10-11T20:41:00Z', communication_id: null,
      preview: 'Got the assignment signed. 7500 fee works, wiring EMD Monday.' },
    'msg:3': { kind: 'email', label: 'EMD wire confirmation', at: ago(4), communication_id: null,
      preview: `Example Title received the $2,500 earnest money wire from Marcus Ortega for ${seed.address}.` },
    'field:assignment_fee': { kind: 'field', label: 'Deal record', at: null },
    'field:transaction_type': { kind: 'field', label: 'Deal record', at: null },
    'field:close_date': { kind: 'field', label: 'Deal record', at: null },
    'tc:1': { kind: 'tc_file', label: 'TC file', at: null },
  };
  const c = (ref: string, quote: string | null = null, page: number | null = null): SourceCite => ({ ref, quote, page });
  return {
    workspace_id: 0, deal_id: seed.dealId, model: 'demo', input_hash: null, source_count: 31, sources,
    last_source_at: ago(4), updated_at: new Date(now - 40 * 60_000).toISOString(),
    brief: `${seed.address} is under contract with the seller at $168,000 and assigned to Marcus Ortega. Example Title opened title on Oct 12 and is working it as a double close, but the signed assignment is a straight assignment for $7,500 and the deal record still says $5,000. EMD of $2,500 landed at title. Inspection ended Oct 9, closing is ${dayLabel(close)}. Settle the structure and the fee with Dana at Example Title before she orders transactional funding.`,
    issues: [
      { kind: 'conflict', topic: 'structure', severity: 'high', text: 'Example Title is closing this as a double close. The signed assignment (page 1) is a straight assignment to Marcus Ortega, and the deal record says Assignment.',
        sources: [c('msg:1', 'Since this one is a double close we will need the transactional funding letter'), c('doc:c2', 'Assignor assigns all rights under the Purchase Agreement to Assignee', 1), c('field:transaction_type', 'Assignment')] },
      { kind: 'conflict', topic: 'assignment_fee', severity: 'high', text: 'Assignment fee does not match. The assignment (page 2) and Marcus’s Oct 11 text say $7,500; the deal record says $5,000.',
        sources: [c('doc:c2', 'Assignment Fee: $7,500.00, payable at closing', 2), c('msg:2', '7500 fee works'), c('field:assignment_fee', '$5,000')] },
      { kind: 'missing', topic: 'emd_receipt', severity: 'medium', text: 'Title emailed that the EMD wire arrived, but no EMD receipt is filed on the deal and the TC file has no received date.',
        sources: [c('msg:3', 'received the $2,500 earnest money wire'), c('tc:1')] },
    ],
    terms: [
      { key: 'purchase_price', value: '$168,000', confidence: 0.95, sources: [c('doc:c1', 'Purchase Price: $168,000.00', 1)] },
      { key: 'assignment_fee', value: '$7,500 on the assignment; $5,000 on the deal record', confidence: 0.5, sources: [c('doc:c2', 'Assignment Fee: $7,500.00', 2), c('field:assignment_fee', '$5,000')] },
      { key: 'buyer_price', value: '$175,500', confidence: 0.85, sources: [c('doc:c2', 'Total consideration $175,500', 2)] },
      { key: 'emd_amount', value: '$2,500, received by title', confidence: 0.9, sources: [c('doc:c1', 'Earnest Money: $2,500', 1), c('msg:3')] },
      { key: 'emd_due', value: 'Oct 7, 2026', confidence: 0.8, sources: [c('doc:c1', 'within 3 business days of the Effective Date', 1)] },
      { key: 'contract_date', value: 'Oct 2, 2026', confidence: 0.95, sources: [c('doc:c1', 'Effective Date: 10/02/2026', 4)] },
      { key: 'inspection_end', value: 'Oct 9, 2026', confidence: 0.8, sources: [c('doc:c1', '7 day option period', 1)] },
      { key: 'closing_date', value: dayLabel(close), confidence: 0.9, sources: [c('doc:c1', 'on or before 10/30/2026', 2), c('field:close_date')] },
      { key: 'structure', value: 'Assignment on paper; title says double close', confidence: 0.45, sources: [c('doc:c2', null, 1), c('msg:1')] },
      { key: 'title_company', value: 'Example Title, Dana White', confidence: 0.95, sources: [c('msg:1')] },
      { key: 'contingencies', value: 'Inspection only; buyer is cash, no financing contingency', confidence: 0.7, sources: [c('doc:c1', 'Buyer’s obligation is not contingent on financing', 3)] },
    ],
    timeline: [
      { date: '2026-10-02', label: 'Purchase agreement signed with the seller', done: true, sources: [c('doc:c1', null, 4)] },
      { date: '2026-10-07', label: 'EMD due to title', done: true, sources: [c('doc:c1', null, 1)] },
      { date: '2026-10-09', label: 'Inspection period ends', done: true, sources: [c('doc:c1', null, 1)] },
      { date: '2026-10-10', label: 'Assignment signed by Marcus Ortega', done: true, sources: [c('doc:c2', null, 3)] },
      { date: '2026-10-12', label: 'Title opened at Example Title', done: true, sources: [c('msg:1')] },
      { date: '2026-10-27', label: 'Title wants funding letter and both settlement statements', done: false, sources: [c('msg:1')] },
      { date: close, label: 'Closing', done: false, sources: [c('doc:c1', null, 2), c('field:close_date')] },
    ],
    parties: [
      { name: 'Linda Orton', role: 'Seller', company: null, email: 'lortiz@example.com', phone: '(210) 555-0148' },
      { name: 'Marcus Ortega', role: 'End buyer', company: 'Ortega Home Buyers LLC', email: 'marcus@ortegahb.com', phone: '(210) 555-0192' },
      { name: 'Dana White', role: 'Title', company: 'Example Title', email: 'dana@exampletitle.com', phone: '(210) 555-0110' },
      { name: 'Casey Cain', role: 'TC', company: 'Acme Homes', email: null, phone: null },
    ],
  };
}
