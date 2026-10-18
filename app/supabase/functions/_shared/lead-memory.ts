// Reads one seller's or buyer's whole history and writes their lead_memory
// row (migration 110). Used by the lead-memory function (a rep's Refresh and
// the two-minute dirty pass) and by voice-agent right after an AI call, so the
// next channel to touch the lead reads what was just said.
//
// The shapes, the cleaning and the no-model fallback live in lib/lead-memory.ts
// so the browser card reads the same definition.
import { WRITING_RULE } from './no-ai-slop.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CLAUDE_MODEL } from './models.ts';
import { UNTRUSTED_RULE, fence } from './security.ts';
import {
  MEMORY_SCHEMA, fallbackMemory, historyRows, historyText, ourSide, parseModelMemory, rowToMemory,
  TRANSCRIPT_FULL, type HistoryItem, type LeadFacts, type LeadHistory, type LeadMemory, type RecordKind,
} from '../../../lib/lead-memory.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const SYSTEM = `You keep the memory for one lead in a real estate wholesaling CRM (Acme Homes). Reps, an AI phone agent and AI-drafted texts all read what you write before they talk to this person, so it must be exact.

Write:
- brief: at most 900 characters of plain sentences, what someone needs in 20 seconds before a call. Who they are and how they like to be addressed, the property, why they would sell (or, for a buyer, what they buy), the numbers said so far (asking price, our offers), timeline, condition, objections, what WE promised and whether it was done, the agreed next step, and anything to be careful about. Most important first. No headings, no bullet characters, never an em dash.
- facts: the same, structured. Money as plain numbers of dollars. last_contact_at is the ISO time of the newest real conversation (call, text, email), last_contact_summary one sentence of what was said in it. promises_made are commitments our side made ("send the offer in writing by Friday"). do_not_mention lists topics the person asked us not to raise, or sensitive matters a caller must not open with (a death, a divorce, a foreclosure they are embarrassed about). open_questions are things we still need to learn. sentiment is how they feel about working with us now.

Several people work one lead: reps and AI agents, each with their own name, and any of them may read this next. Always say who on our side said or promised something, by name ("Riley, our AI lead manager, called on Oct 3", "Sam offered 150,000"). Never write as "I", "you" or "the agent", and never let one name stand for the whole team.

Rules: use only what the history and record say; never guess a number, a date or a name. When the history disagrees with itself, trust the newest. Leave a fact null or empty rather than invent it. Record fields can be stale, the newest conversation wins.${UNTRUSTED_RULE}${WRITING_RULE}`;

function anthropicClient(apiKey: string): Anthropic {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
}

const trim = (v: unknown, max: number) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
};

function commText(c: Any, fullTranscript = false, agentNames: Record<string, string> = {}): string {
  const notes = c.ai_notes && typeof c.ai_notes === 'object' ? (c.ai_notes.summary ?? c.ai_notes.notes ?? '') : '';
  const coach = c.coaching_review && typeof c.coaching_review === 'object' ? c.coaching_review.keep ?? '' : '';
  const parts = [
    ourSide(c, agentNames),
    c.subject ? `Subject: ${trim(c.subject, 160)}.` : '',
    c.summary ? `Summary: ${trim(c.summary, 500)}` : '',
    notes ? `Notes: ${trim(notes, 500)}` : '',
    c.transcript ? `Transcript: ${trim(c.transcript, fullTranscript ? TRANSCRIPT_FULL : 1200)}` : '',
    !c.transcript && c.body ? trim(c.body, 900) : '',
    coach ? `Coach: ${trim(coach, 200)}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * Everything on file for one record, read with whatever client the caller
 * trusts. Null when the record is not there. A failed read throws
 * (historyRows) before anything is summarised or decided from it.
 */
export async function gatherHistory(db: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<LeadHistory | null> {
  const col = kind === 'seller' ? 'seller_id' : 'buyer_id';
  const table = kind === 'seller' ? 'sellers' : 'buyers';
  const rec = historyRows(await db.from(table).select('*').eq('id', id).eq('workspace_id', ws).maybeSingle(), 'record');
  if (!rec) return null;

  const [comms, acts, deals, appts, tasks] = await Promise.all([
    db.from('communications').select('*').eq('workspace_id', ws).eq(col, id).order('occurred_at', { ascending: false }).limit(200),
    db.from('activity').select('kind, title, body, occurred_at').eq('workspace_id', ws).eq('entity_type', kind).eq('entity_id', id)
      .order('occurred_at', { ascending: false }).limit(80),
    db.from('deals').select('*')
      .eq('workspace_id', ws).eq(col, id).limit(20),
    db.from('appointments').select('title, kind, starts_at, location').eq('workspace_id', ws).eq(col, id).order('starts_at', { ascending: false }).limit(10),
    kind === 'seller'
      ? db.from('tasks').select('title, due_at, done').eq('workspace_id', ws).eq('seller_id', id).eq('done', false).order('due_at').limit(10)
      : Promise.resolve({ data: [] as Any[], error: null }),
  ]);
  for (const [what, r] of [['messages and calls', comms], ['activity', acts], ['deals', deals], ['appointments', appts], ['tasks', tasks]] as [string, Any][]) historyRows(r, what);
  const agentNames: Record<string, string> = {};
  // Without the table every AI line reads "one of our AI agents".
  const agents = historyRows(await db.from('voice_agent_settings').select('agent_key, name').eq('workspace_id', ws), 'agent names', true);
  for (const a of (agents ?? []) as Any[]) if (a.agent_key && a.name) agentNames[String(a.agent_key)] = String(a.name);
  const dealIds = ((deals.data ?? []) as Any[]).map((d) => d.id);
  const offersQ = kind === 'seller' && dealIds.length
    ? db.from('offers').select('amount, status, direction, sent_at, notes').eq('workspace_id', ws).or(`seller_id.eq.${id},deal_id.in.(${dealIds.join(',')})`).limit(40)
    : db.from('offers').select('amount, status, direction, sent_at, notes').eq('workspace_id', ws).eq(col, id).limit(40);
  const offers = historyRows(await offersQ, 'offers');

  const items: HistoryItem[] = [];
  // The newest calls are read whole (comms come newest first): an agent picks
  // up exactly where the last real conversation left off.
  let fullCalls = 0;
  for (const c of (comms.data ?? []) as Any[]) {
    const isCall = (c.channel === 'call' || c.channel === 'voicemail') && !!c.transcript;
    const full = isCall && fullCalls < 3;
    if (full) fullCalls++;
    const text = commText(c, full, agentNames);
    if (!text) continue;
    items.push({ at: c.occurred_at ?? c.created_at, kind: String(c.channel ?? 'note'), direction: c.direction === 'inbound' ? 'inbound' : c.direction === 'outbound' ? 'outbound' : null, text, ...(full ? { full: true } : {}) });
  }
  const extra = await gatherExtras(db, ws, kind, id, rec as Any, (comms.data ?? []) as Any[]);
  items.push(...extra.items);
  for (const a of (acts.data ?? []) as Any[]) {
    const text = [a.title, a.body].filter(Boolean).map((t) => trim(t, 600)).join(': ');
    if (text) items.push({ at: a.occurred_at, kind: 'activity', direction: null, text });
  }
  for (const a of (appts.data ?? []) as Any[]) {
    items.push({ at: a.starts_at, kind: 'appointment', direction: null, text: [a.title, a.kind, a.location].filter(Boolean).join(', ') });
  }
  for (const t of (tasks.data ?? []) as Any[]) {
    if (t.due_at) items.push({ at: t.due_at, kind: 'task', direction: null, text: `Open task: ${trim(t.title, 200)}` });
  }

  const r = rec as Any;
  const nextTask = ((tasks.data ?? []) as Any[])[0];
  // Every field on the record that has a value, not a hand-picked few: what
  // an import brought in (mailing address, owner 2, other emails, extras)
  // is as useful to the agent as the stage.
  const record: Record<string, unknown> = { ...fieldsOf(r), next_task: nextTask?.title ?? null };
  return {
    kind, id, name: String(r.name ?? ''), record, items,
    deals: ((deals.data ?? []) as Any[]).map((d) => fieldsOf(d)),
    offers: ((offers ?? []) as Any[]).map((o) => ({ amount: o.amount ?? null, status: o.status ?? null, direction: o.direction ?? null, at: o.sent_at ?? null })),
    counts: extra.counts,
    context: extra.context,
  };
}

/** Columns that are bookkeeping, not facts about the person or the deal. */
const SKIP_FIELD = /^(id|workspace_id|created_by|updated_by|phone_key|address_key|source_id|webhook_token|track_token|embedding|search|fts|.*_tsv)$/;

/** A row's fields that hold something, long text trimmed, so an agent reads every fact on file. */
function fieldsOf(row: Any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (SKIP_FIELD.test(k) || v === null || v === undefined || v === '' || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length) continue;
    out[k] = typeof v === 'string' ? trim(v, 1500) : v;
  }
  return out;
}

/**
 * The rest of what is on file for one record: the property and its facts,
 * the person's other phones, RVMs left for them, the action plans and AI
 * agents that have worked them, and how often each channel reached them.
 * A table or column a database lacks is skipped; any other failed read
 * throws, so the memory is not written with parts missing.
 */
async function gatherExtras(db: SupabaseClient, ws: number, kind: RecordKind, id: number, rec: Any, comms: Any[]): Promise<{ items: HistoryItem[]; counts: Record<string, unknown>; context: Record<string, unknown> }> {
  const col = kind === 'seller' ? 'seller_id' : 'buyer_id';
  const safe = async <T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> => historyRows(await q, 'extras', true);
  const [property, phones, rvms, plans, agents, matches] = await Promise.all([
    kind === 'seller' && rec?.property_id ? safe<Any>(db.from('properties').select('*').eq('id', rec.property_id).maybeSingle()) : Promise.resolve(null),
    safe<Any[]>(db.from(kind === 'seller' ? 'seller_phones' : 'buyer_phones').select('kind, position, is_dnc, call_count').eq('workspace_id', ws).eq(col, id).order('position').limit(10)),
    safe<Any[]>(db.from('rvm_drops').select('status, script, sent_at, created_at, callback_at, callback_channel, skip_reason, vm_library(name, script)').eq('workspace_id', ws).eq(col, id).order('created_at', { ascending: false }).limit(20)),
    safe<Any[]>(db.from('enrollments').select('status, step_index, enrolled_at, completed_at, stopped_reason, action_plans!enrollments_plan_id_fkey(name)').eq('workspace_id', ws).eq(col, id).order('enrolled_at', { ascending: false }).limit(10)),
    safe<Any[]>(db.from('ai_agent_enrollments').select('agent_key, status, touches, instructions, stop_reason, started_at, stopped_at, relayed_from').eq('workspace_id', ws).eq('record_kind', kind).eq('record_id', id).limit(3)),
    kind === 'buyer' ? safe<Any[]>(db.from('deal_buyer_matches').select('status, sent_at, viewed_at, replied_at, opens, clicks, replies, calls, temperature, pass_reason, offers').eq('workspace_id', ws).eq('buyer_id', id).order('updated_at', { ascending: false }).limit(15)) : Promise.resolve(null),
  ]);

  const items: HistoryItem[] = [];
  for (const d of rvms ?? []) {
    const lib = (d.vm_library ?? {}) as Any;
    const what = trim(d.script || lib.script || lib.name || 'ringless voicemail', 300);
    const result = d.status === 'dropped' ? 'delivered' : String(d.status ?? '');
    const back = d.callback_at ? `, they ${d.callback_channel === 'sms' ? 'texted' : 'called'} back ${String(d.callback_at).slice(0, 10)}` : '';
    items.push({ at: d.sent_at ?? d.created_at, kind: 'rvm', direction: 'outbound', text: `Ringless voicemail ${result}${d.skip_reason ? ` (${d.skip_reason})` : ''}${back}: ${what}` });
  }

  // How often each side reached the other, so the agent knows "we've called 6 times, they answered once".
  const c: Record<string, number> = {};
  const last: Record<string, string> = {};
  for (const m of comms) {
    const ch = String(m.channel ?? 'note');
    const dir = m.direction === 'inbound' ? 'in' : m.direction === 'outbound' ? 'out' : '';
    if (!dir) continue;
    const key = `${ch}_${dir}`;
    c[key] = (c[key] ?? 0) + 1;
    if (ch === 'call' && dir === 'out' && Number(m.duration_s ?? 0) >= 30) c.call_conversations = (c.call_conversations ?? 0) + 1;
    const at = String(m.occurred_at ?? m.created_at ?? '');
    if (at && (!last[key] || at > last[key])) last[key] = at.slice(0, 10);
  }
  const counts: Record<string, unknown> = {
    ...c,
    rvm_delivered: (rvms ?? []).filter((d) => d.status === 'dropped').length,
    rvm_callbacks: (rvms ?? []).filter((d) => d.callback_at).length,
    last_by_channel: last,
    note: comms.length >= 200 ? 'counts cover the newest 200 messages and calls' : undefined,
  };

  const context: Record<string, unknown> = {};
  if (property) context.property = fieldsOf(property);
  if (phones?.length) context.other_phones = phones.map((p) => ({ kind: p.kind, position: p.position, dnc: !!p.is_dnc, calls: p.call_count }));
  if (plans?.length) context.action_plans = plans.map((e) => ({ plan: (e.action_plans as Any)?.name ?? null, status: e.status, step: e.step_index, since: String(e.enrolled_at ?? '').slice(0, 10), stopped: e.stopped_reason ?? null }));
  if (agents?.length) context.ai_agents = agents.map((a) => fieldsOf(a));
  if (matches?.length) context.deals_sent_to_buyer = matches.map((m) => fieldsOf(m));
  return { items, counts, context };
}

export type RefreshResult = { memory: LeadMemory; source: 'ai' | 'fallback'; message?: string };

/**
 * Read, summarise, store. Without ANTHROPIC_API_KEY, or when the call fails or
 * refuses, the deterministic fallback is stored so the card and the phone
 * still have the basics; `message` says why.
 */
export async function refreshLeadMemory(admin: SupabaseClient, ws: number, kind: RecordKind, id: number): Promise<RefreshResult | null> {
  const asOf = new Date().toISOString();
  const h = await gatherHistory(admin, ws, kind, id);
  if (!h) return null;

  let out: { brief: string; facts: LeadFacts } | null = null;
  let message: string | undefined;
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    message = 'AI memory is off: set the ANTHROPIC_API_KEY secret on the Supabase project. Showing the latest touches instead.';
  } else {
    try {
      const res = await anthropicClient(apiKey).messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: MEMORY_SCHEMA } },
        messages: [{
          role: 'user',
          content: `Today: ${asOf.slice(0, 10)}.\n\n${fence('lead_history', historyText(h), 60_000)}`,
        }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === 'refusal') {
        message = 'The model declined to summarise this record. Showing the latest touches instead.';
      } else {
        const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
        out = parseModelMemory(text);
        if (!out) message = 'The model returned no usable memory. Showing the latest touches instead.';
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) message = 'The ANTHROPIC_API_KEY secret was rejected. Showing the latest touches instead.';
      else if (e instanceof Anthropic.RateLimitError) message = 'AI memory is rate limited right now. Showing the latest touches; try Refresh in a minute.';
      else { console.error('lead-memory anthropic', String(e)); message = 'AI memory failed this time. Showing the latest touches instead.'; }
    }
  }
  const source: 'ai' | 'fallback' = out ? 'ai' : 'fallback';
  const mem = out ?? fallbackMemory(h);
  const times = h.items.map((i) => Date.parse(i.at)).filter((t) => Number.isFinite(t) && t <= Date.now());
  const row = {
    workspace_id: ws, record_kind: kind, record_id: id, brief: mem.brief, facts: mem.facts,
    source_count: h.items.length, last_source_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    model: source === 'ai' ? CLAUDE_MODEL : 'fallback', updated_at: asOf,
  };
  const { error } = await admin.from('lead_memory').upsert(row, { onConflict: 'workspace_id,record_kind,record_id' });
  if (error) throw new Error(`lead_memory upsert: ${error.message}`);
  return { memory: rowToMemory(row)!, source, ...(message ? { message } : {}) };
}
