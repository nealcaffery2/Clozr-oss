// The AI Agent console's helpers that are not about one settings shape: where a
// settings path lives on screen, how a diff reads, list edits, hours, the
// variable palette, stats and scores. Pure, so voice-agent.test.ts covers them.

import {
  DAYS, savePayload, type AgentSettings, type AgentStats, type AgentSummary, type FieldErrors, type Grade, type Hours, type PromptWarning, type SettingChange, type StatsResult,
} from './voice-agent';

export const MAX_AGENTS = 10;

// ---- Tabs and paths ---------------------------------------------------------------------------------

export const TAB_IDS = ['identity', 'voice', 'personality', 'script', 'rules', 'offer', 'handling', 'transfer', 'tools', 'knowledge', 'test', 'calls', 'history'] as const;
export type TabId = (typeof TAB_IDS)[number];

const ROOT_TAB: Record<string, TabId> = {
  identity: 'identity', voice: 'voice', personality: 'personality', script: 'script', rules: 'rules', offer_authority: 'offer',
  call_handling: 'handling', channels: 'handling', live_transfer: 'transfer', tools: 'tools', knowledge: 'knowledge',
};

/** The tab a settings path is edited on, or null for a path that is not a setting (a general error, `script` alone maps to Script). */
export function pathTab(path: string): TabId | null {
  const root = path.replace(/#.*$/, '').split(/[.[]/)[0] ?? '';
  return ROOT_TAB[root] ?? null;
}

/** The DOM id a field for `path` carries, so a warning or a server error can scroll to it. */
export const fieldId = (path: string) => 'va-f-' + path.replace(/#/g, '-').replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-|-$/g, '');

/** Paths from most to least specific: `a.b[x].c` tries itself, `a.b[x]`, `a.b`, `a`. The first one on screen is the target. */
export function pathCandidates(path: string): string[] {
  const out: string[] = [];
  let p = path.replace(/#.*$/, '');
  while (p) {
    out.push(p);
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return out;
}

/** The first error whose path starts with `prefix`, for a list shown as one field. */
export function firstError(errors: FieldErrors, prefix: string): string | undefined {
  const k = Object.keys(errors).find((p) => p === prefix || p.startsWith(`${prefix}[`) || p.startsWith(`${prefix}.`));
  return k ? errors[k] : undefined;
}

/** Error counts per tab, for the badge beside each tab's name. */
export function errorsByTab(errors: FieldErrors): Partial<Record<TabId, number>> {
  const out: Partial<Record<TabId, number>> = {};
  for (const path of Object.keys(errors)) {
    const t = pathTab(path);
    if (t) out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

// ---- Immutable edits -----------------------------------------------------------------------------------

export function getIn(o: unknown, keys: (string | number)[]): unknown {
  return keys.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string | number, unknown>)[k] : undefined), o);
}

/** A copy of `o` with the value at `keys` replaced; nothing on the way is mutated. */
export function setIn<T>(o: T, keys: (string | number)[], value: unknown): T {
  if (!keys.length) return value as T;
  const [head, ...rest] = keys as [string | number, ...(string | number)[]];
  const base = (Array.isArray(o) ? [...o] : { ...(o as object) }) as Record<string | number, unknown>;
  base[head] = setIn(base[head], rest, value);
  return base as T;
}

/** `[a, b, c]` with the item at `i` moved one step; a move past either end changes nothing. */
export function moveItem<T>(items: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= items.length || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export const removeAt = <T>(items: T[], i: number): T[] => items.filter((_, j) => j !== i);
export const replaceAt = <T>(items: T[], i: number, item: T): T[] => items.map((x, j) => (j === i ? item : x));

/** `base_1`, `base_2`, ...: the first one no other item has. Ids stay stable through reorders and are what the server diffs by. */
export function uniqueId(base: string, taken: string[]): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Put `token` where the cursor is (replacing a selection), and say where the cursor goes after it. */
export function insertAtCursor(text: string, start: number, end: number, token: string): { text: string; cursor: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return { text: text.slice(0, a) + token + text.slice(b), cursor: a + token.length };
}

// ---- The variable palette -------------------------------------------------------------------------------

/** Every {{variable}} the agent has on a call (the server defuses any other), with what it holds. */
export const PROMPT_VARIABLES: { name: string; hint: string; empty?: boolean }[] = [
  { name: 'first_name', hint: 'The caller\'s first name, when the number matches a record.' },
  { name: 'property_address', hint: 'The property the record is about.' },
  { name: 'lead_brief', hint: 'The short brief a rep would read on the record.' },
  { name: 'last_contact_summary', hint: 'What the last conversation was about.' },
  { name: 'next_step', hint: 'The next step already agreed with them.' },
  { name: 'rep_name', hint: 'The rep who owns the record.' },
  { name: 'rep_phone', hint: 'That rep\'s phone number.' },
  { name: 'company', hint: 'The company name from Identity.' },
  { name: 'agent_name', hint: 'The agent\'s own name from Identity.' },
  { name: 'caller_known', hint: 'true when the number matched exactly one record.' },
  { name: 'do_not_engage', hint: 'true when the number must not be talked to.' },
  { name: 'record_kind', hint: 'seller or buyer.' },
  { name: 'lead_source', hint: '"form", "outbound", or empty when unknown.' },
  { name: 'offer_low', hint: 'Bottom of the approved range. Empty when the agent may not quote.' },
  { name: 'offer_high', hint: 'Top of the approved range (the deal\'s MAO).' },
  { name: 'seller_asking_price', hint: 'What the seller has said they want.' },
  { name: 'property_facts', hint: 'Beds, baths and condition notes. Always empty for now.', empty: true },
  { name: 'mortgage_payoff_estimate', hint: 'Estimated payoff. Always empty for now.', empty: true },
];

const VARIABLE_NAMES = new Set(PROMPT_VARIABLES.map((v) => v.name));

/** `{{names}}` in a text that are not variables the agent has: the server strips their braces, so the text would read wrong. */
export function unknownVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = m[1] ?? '';
    if (!VARIABLE_NAMES.has(name) && !/^system__[a-z_]+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// ---- Hours ---------------------------------------------------------------------------------------------------

export const DAY_LABELS: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const DAY_NAMES: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** Add or remove a day, keeping Monday-first order whatever order they were picked in. */
export function toggleDay(days: string[], day: string): string[] {
  const has = days.includes(day);
  return DAYS.filter((d) => (d === day ? !has : days.includes(d)));
}

/** "Every day", "Weekdays", "Mon to Sat", "Mon, Wed, Fri". */
export function daysSummary(days: string[]): string {
  const on = DAYS.filter((d) => days.includes(d));
  if (!on.length) return 'No days';
  if (on.length === 7) return 'Every day';
  const key = on.join(',');
  if (key === 'mon,tue,wed,thu,fri') return 'Weekdays';
  if (key === 'sat,sun') return 'Weekends';
  const first = DAYS.indexOf(on[0]!);
  const run = on.length >= 3 && on.every((d, i) => DAYS.indexOf(d) === first + i);
  if (run) return `${DAY_LABELS[on[0]!]} to ${DAY_LABELS[on[on.length - 1]!]}`;
  return on.map((d) => DAY_LABELS[d]).join(', ');
}

/** "21:00" as "9:00 pm"; anything that is not HH:MM comes back as it was. */
export function formatTime12(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

export function hoursSummary(h: Pick<Hours, 'start' | 'end'> & Partial<Pick<Hours, 'days' | 'tz'>>): string {
  const overnight = h.start > h.end ? ' (overnight)' : '';
  const days = h.days ? `${daysSummary(h.days)}, ` : '';
  const tz = h.tz ? `, ${h.tz.replace(/_/g, ' ')}` : '';
  return `${days}${formatTime12(h.start)} to ${formatTime12(h.end)}${overnight}${tz}`;
}

/** The server's `hours_outside_quiet` warning, one step early: call hours that run past the quiet-hours window are never placed. */
export function callHoursOutsideQuiet(s: AgentSettings): boolean {
  const q = s.rules.compliance.quiet_hours; const h = s.call_handling.call_hours;
  return q.enabled && q.tz === h.tz && (h.start < q.start || h.end > q.end);
}

const COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

export function zoneOptions(current: string, local = ''): string[] {
  return [...new Set([current, local, ...COMMON_ZONES].filter(Boolean))];
}
export const zoneLabel = (z: string) => z.replace(/_/g, ' ').replace('/', ' / ');

// ---- Agents ----------------------------------------------------------------------------------------------------

export const agentTitle = (a: Pick<AgentSummary, 'name' | 'agent_key'>) => a.name.trim() || 'Unnamed agent';
export const canAddAgent = (count: number) => count < MAX_AGENTS;

/** A key for a new agent from the name typed for it, or '' to let the server pick. Never collides with `taken`. */
export function agentKeyFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  if (!/^[a-z]/.test(base)) return '';
  let k = base.length >= 2 ? base : `${base}_agent`;
  let n = 2;
  while (taken.includes(k)) k = `${base}_${n++}`;
  return k;
}

// ---- Diffs ----------------------------------------------------------------------------------------------------------

const ROOT_LABEL: Record<string, string> = {
  identity: 'Identity', voice: 'Voice', personality: 'Personality', script: 'Script', rules: 'Rules', offer_authority: 'Offer authority',
  call_handling: 'Call handling', live_transfer: 'Live transfer', tools: 'Tools', knowledge: 'Knowledge', channels: 'Channels',
};
const SEG_LABEL: Record<string, string> = {
  dos: 'Always rules', donts: 'Never rules', sections: 'Script sections', destinations: 'Transfer destinations', faqs: 'FAQs', custom: 'Custom triggers',
  tts_model: 'Speech model', llm: 'Brain', thinking: 'Thinking', voice_id: 'Voice', introduce_as: 'Introduces itself as', raw_prompt_override: 'Prompt override', master_script_text: 'Master script',
  never_mention: 'Never mention', forbidden_phrases: 'Forbidden phrases', required_phrases: 'Required phrases', company_facts: 'Company facts',
  honor_dnc: 'Honor do not contact', ai_disclosure_when_asked: 'Honest about being an AI', floor_pct_of_mao: 'Floor as % of MAO',
  step_size_pct: 'Step size %', max_call_seconds: 'Longest call', silence_timeout_s: 'Silence timeout', first_response_delay_ms: 'First response delay',
  ring_timeout_s: 'Ring timeout', gap_hours: 'Hours between tries', max_attempts: 'Attempts', message_template: 'Message', whisper_message_template: 'Whisper message',
  quiet_hours: 'Quiet hours', call_hours: 'Call hours', recording_notice: 'Recording notice', use_fillers: 'Filler words', phone_number_id: 'Phone number',
  q: 'Question', a: 'Answer',
};

const sentence = (s: string) => { const t = s.replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** `rules.dos[stop_bye].text` as "Rules · Always rules · "stop_bye" · Text". */
export function pathLabel(path: string): string {
  const isOrder = path.endsWith('#order');
  const bare = path.replace(/#order$/, '');
  const parts = [...bare.matchAll(/([^.[\]]+)|\[([^\]]*)\]/g)].map((m) => (m[2] !== undefined ? `“${m[2]}”` : SEG_LABEL[m[1]!] ?? ROOT_LABEL[m[1]!] ?? sentence(m[1]!)));
  return parts.join(' · ') + (isOrder ? ' · Order' : '');
}

/** A value as one short line: "On", "8:00", "empty", text cut at 90 characters. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 90 ? `${v.slice(0, 88).trimEnd()}…` : v;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ').slice(0, 90) : 'empty';
  return JSON.stringify(v).slice(0, 90);
}

export type DescribedChange = { path: string; tab: TabId | null; group: string; label: string; from: string; to: string; kind: 'added' | 'removed' | 'changed' };

const emptyList = (v: unknown) => Array.isArray(v) && v.length === 0;

const ITEM_ID = /^(.*\[[^\]]+\])\.id$/;
const ITEM_SUMMARY = ['text', 'title', 'q', 'label', 'when', 'number'];

/** An item that came or went is one row (its text), not a row per field: the server reports id, text and severity of a new rule separately. */
function condenseItems(changes: SettingChange[]): SettingChange[] {
  const gone = new Map<string, 'added' | 'removed'>();
  for (const c of changes) {
    const m = ITEM_ID.exec(c.path);
    if (m && (c.from === null || c.from === undefined)) gone.set(m[1]!, 'added');
    else if (m && (c.to === null || c.to === undefined)) gone.set(m[1]!, 'removed');
  }
  if (!gone.size) return changes;
  const out: SettingChange[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const base = [...gone.keys()].find((k) => c.path === k || c.path.startsWith(`${k}.`));
    if (!base) { out.push(c); continue; }
    if (seen.has(base)) continue;
    seen.add(base);
    const kind = gone.get(base)!;
    const side = kind === 'added' ? 'to' : 'from';
    const fields = changes.filter((x) => x.path.startsWith(`${base}.`));
    const pick = ITEM_SUMMARY.map((k) => fields.find((x) => x.path === `${base}.${k}`)?.[side]).find((v) => typeof v === 'string' && v) ?? (kind === 'added' ? 'new item' : 'removed item');
    out.push({ path: base, from: kind === 'added' ? null : pick, to: kind === 'added' ? pick : null });
  }
  return out;
}

/**
 * The changes worth showing. The server flattens lists of items by id, so an
 * empty list turning into items reports the list itself as changed, and a
 * membership change reports its order too; both are noise beside the item rows.
 */
export function visibleChanges(changes: SettingChange[]): SettingChange[] {
  return condenseItems(changes.filter((c) => {
    if ((emptyList(c.from) && c.to === null) || (c.from === null && emptyList(c.to))) return false;
    if (c.path.endsWith('#order')) {
      // Only a reorder of the same items is news; items coming or going already show as rows of their own.
      if (!Array.isArray(c.from) || !Array.isArray(c.to)) return false;
      if ([...(c.from as string[])].sort().join('|') !== [...(c.to as string[])].sort().join('|')) return false;
    }
    return true;
  }));
}

export function describeChange(c: SettingChange): DescribedChange {
  const tab = pathTab(c.path);
  const root = c.path.split(/[.[#]/)[0] ?? '';
  const kind = c.from === null || c.from === undefined ? 'added' : c.to === null || c.to === undefined ? 'removed' : 'changed';
  return { path: c.path, tab, group: ROOT_LABEL[root] ?? sentence(root), label: pathLabel(c.path), from: formatValue(c.from), to: formatValue(c.to), kind };
}

export function groupChanges(changes: SettingChange[]): { group: string; tab: TabId | null; items: DescribedChange[] }[] {
  const out: { group: string; tab: TabId | null; items: DescribedChange[] }[] = [];
  for (const c of visibleChanges(changes).map(describeChange)) {
    let g = out.find((x) => x.group === c.group);
    if (!g) { g = { group: c.group, tab: c.tab, items: [] }; out.push(g); }
    g.items.push(c);
  }
  return out;
}

/** "3 changes across Rules and Script" for the publish modal's one-line summary. */
export function changeSummary(changes: SettingChange[]): string {
  const g = groupChanges(changes);
  const n = g.reduce((t, x) => t + x.items.length, 0);
  if (!n) return 'No changes to the settings.';
  const names = g.map((x) => x.group);
  const where = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${n} ${n === 1 ? 'change' : 'changes'} in ${where}.`;
}

// The same leaf-level diff the server computes, for /demo (and nothing else: the real one is authoritative).

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

function flatten(v: unknown, path: string, out: Map<string, unknown>) {
  if (Array.isArray(v) && v.length && v.every((x) => isObj(x) && typeof x.id === 'string')) {
    for (const x of v as Rec[]) flatten(x, `${path}[${x.id}]`, out);
    out.set(`${path}#order`, (v as Rec[]).map((x) => x.id));
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, v);
}

export function diffSettings(a: unknown, b: unknown): SettingChange[] {
  const fa = new Map<string, unknown>(); const fb = new Map<string, unknown>();
  flatten(a, '', fa); flatten(b, '', fb);
  const out: SettingChange[] = [];
  for (const p of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
    const x = fa.get(p); const y = fb.get(p);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, from: x === undefined ? null : x, to: y === undefined ? null : y });
  }
  return out;
}

export function diffLines(a: string, b: string): { added: string[]; removed: string[] } {
  const la = a.split('\n'); const lb = b.split('\n');
  const sa = new Set(la); const sb = new Set(lb);
  return { added: lb.filter((l) => l.trim() && !sa.has(l)), removed: la.filter((l) => l.trim() && !sb.has(l)) };
}

// ---- Warnings, stats, scores ----------------------------------------------------------------------------------------

/** Warnings first, then the notes, each keeping the server's order. */
export function groupWarnings(list: PromptWarning[]): { warnings: PromptWarning[]; notes: PromptWarning[] } {
  return { warnings: list.filter((w) => w.level === 'warning'), notes: list.filter((w) => w.level === 'info') };
}

export const formatAvg = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}` : '–');

export type StatTile = { key: string; label: string; value: string; hint: string };

/** The six numbers a card shows, from one agent's row; a row that is missing reads as zeros. */
export function statTiles(a: AgentStats | undefined): StatTile[] {
  const s = a ?? { agent_key: '', calls: 0, avg_duration_s: 0, booked: 0, transferred: 0, dnc_requests: 0, not_interested: 0 };
  return [
    { key: 'calls', label: 'Calls', value: String(s.calls), hint: 'Calls this agent took or placed.' },
    { key: 'avg', label: 'Avg length', value: formatAvg(s.avg_duration_s), hint: 'Minutes and seconds, counting calls that connected.' },
    { key: 'booked', label: 'Booked', value: String(s.booked), hint: 'Appointments the agent booked. Stays 0 until the booking tool exists.' },
    { key: 'transferred', label: 'Transferred', value: String(s.transferred), hint: 'Calls handed to a person.' },
    { key: 'dnc', label: 'Do not contact', value: String(s.dnc_requests), hint: 'Callers who asked to be left alone.' },
    { key: 'ni', label: 'Not interested', value: String(s.not_interested), hint: 'Callers who said no thanks.' },
  ];
}

export const statsFor = (r: StatsResult | null, key: string) => r?.agents.find((a) => a.agent_key === key);

export type ScoreTone = 'good' | 'mid' | 'bad';
export const scoreTone = (pct: number): ScoreTone => (pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'bad');

/** The failed items first, so the problem is at the top; order is otherwise kept. */
export function gradesSorted(items: Grade[]): Grade[] {
  return [...items].sort((a, b) => Number(a.pass) - Number(b.pass));
}

// ---- Script and languages -----------------------------------------------------------------------------------------

export type ScriptSource = 'override' | 'sections' | 'master' | 'template' | 'none';

/** Which text the agent is really given, in the server's order: override, enabled sections, master script, the template's own sections. */
export function scriptSource(script: AgentSettings['script']): ScriptSource {
  if (script.raw_prompt_override?.trim()) return 'override';
  if (script.sections.some((x) => x.enabled && x.body.trim())) return 'sections';
  if (script.master_script_text.trim()) return 'master';
  return script.template_id ? 'template' : 'none';
}

export const SCRIPT_SOURCE_TEXT: Record<ScriptSource, string> = {
  override: 'The prompt override is used. Personality and the script sections below are ignored.',
  sections: 'The enabled sections below are used.',
  master: 'No enabled section has text, so the master script is used.',
  template: 'Nothing is written here, so the template\'s own sections are used.',
  none: 'There is no script: the agent only has the rules and what it knows about the caller.',
};

/** A language chip: two letters, or two-two ("en", "es", "pt-BR"). Anything else is left out. */
export function addLanguage(list: string[], text: string): string[] {
  const t = text.trim();
  if (!/^[A-Za-z]{2}(-[A-Za-z]{2})?$/.test(t)) return list;
  const [lang, region] = t.split('-') as [string, string | undefined];
  const code = region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
  return list.includes(code) || list.length >= 5 ? list : [...list, code];
}

/** The tabs whose settings differ between what is saved and what is being edited, for the dot beside each tab's name. */
export function dirtyTabs(saved: AgentSettings, draft: AgentSettings): Set<TabId> {
  const out = new Set<TabId>();
  for (const c of visibleChanges(diffSettings(savePayload(saved), savePayload(draft)))) {
    const t = pathTab(c.path);
    if (t) out.add(t);
  }
  return out;
}
