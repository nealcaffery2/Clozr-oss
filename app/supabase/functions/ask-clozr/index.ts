/**
 * POST /ask-clozr — Ask CLOZR: questions and small jobs over a real workspace.
 *
 * Body:    { workspace_id, question, history?, context?: { focus? }, stream?, read_only? }
 * Returns: stream: true  → application/x-ndjson, one event per line:
 *                           { type: 'text', text }            a piece of the answer
 *                           { type: 'tool', name, status }     a tool starting / done / failed
 *                           { type: 'cards', cards }           records to open
 *                           { type: 'done', answer, cards }    the whole answer
 *                           { type: 'error', error }
 *          otherwise      → { ok, answer, cards } once it is finished.
 *          cards are the records the UI opens: { kind: seller|buyer|deal, id, title, subtitle }.
 *
 * A streaming tool loop: the model answers in prose as it goes; a turn that
 * stops on a tool runs it here, appends the result and keeps streaming into
 * the same response. The tools are CLOZR itself — the Today focus list, tasks,
 * sellers, notes, deals, the Compr outcome, action plans — shaped queries and
 * writes, never free SQL.
 *
 * Every read and write runs as the caller, on the caller's JWT, so RLS is the
 * only access rule that matters: the function cannot read or change a row the
 * person asking could not themselves. Row text (seller notes, buyer notes,
 * names off an import) is fenced before it reaches the model. Two exceptions,
 * both checked as the caller first: plan_enroll is revoked from
 * `authenticated` (migration 34) and runs on the service role with the caller
 * as the actor, and the Compr outcome goes through compr-underwrite with the
 * caller's own token.
 *
 * Writes need the person to ask. Enrolling in a plan queues texts to a
 * seller, so it also needs an explicit yes in the person's latest message
 * (_shared/ask-rules.ts saidYes): the model asks first, then enrols. A
 * read-only preview (View as) sends read_only and gets no write tools.
 *
 * Today's composer sends the focus list it shows as context.focus, numbered
 * as on screen, so "do the second one" resolves to a record.
 *
 * Needs the ANTHROPIC_API_KEY secret; answers 503 with a plain message until
 * it is set (same as lane and draft-action-plan).
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING } from '../_shared/models.ts';
import { matchPlan } from '../_shared/plan-match.ts';
import { FOCUS_TZ, loadFocus } from '../_shared/focus.ts';
import { seatBrief } from '../_shared/seat-brief.ts';
import { cleanCards, focusContext, matchStage, saidYes, threadFrom, type Card } from '../_shared/ask-rules.ts';
import { focusTop } from '../../../lib/focus.ts';
import { localMidnightIso } from '../../../lib/rvm.ts';
import { ACTIVE_DEAL_STAGES, DEAL_STAGES, SELLER_STAGE_LABELS } from '../../../lib/stages.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}
const WORKSPACE_HINT = 'The Anthropic key is organization-level and needs a workspace: create the key inside a workspace '
  + '(console.anthropic.com → API keys → choose a workspace) or add the ANTHROPIC_WORKSPACE_ID secret with that workspace\'s id.';

const SYSTEM = `You are Ask CLOZR, the assistant inside CLOZR — the CRM a real estate investment company runs its wholesaling, double-close and novation business on. The person asking is an acquisitions rep, a dispo rep, a TC or the owner, mid-shift, on a screen full of work.

You work from this workspace's records, and only from them. Use the tools to get what you need. Never invent a name, a number, an address or a date: if the tools do not return it, say what is missing. If a question is about one transaction file's coordination — title, earnest money, HUD/CD, closing-day mechanics — say that Lane reads those files and hand it over.

How to answer. Lead with the answer, not with what you did. Plain prose, two to five sentences, specific about names and numbers; a short numbered list only when the person asked for a list or a plan. No preamble ("Great question", "Let me look..."), do not narrate the lookups, no markdown headers. Write like a sharp colleague answering across a desk.

When the answer is about particular records, call show_records once, at the end, with the ones worth opening (most urgent first, at most six). Every record you show must be a row a tool returned this turn: its id comes from the tool result, never from you.

For "what should I focus on today" or "what first", call todays_focus and answer from it: it is the same list the Today screen shows, already in order. When the person refers to the list on their screen ("the second one", "do that first one"), the numbered list in their message is that list; use the record ids it gives.

Changing things. You can create and complete tasks, add a note, move a seller or a deal to another stage, and enroll a seller in an action plan. Do any of these only when the person asks for it, and only for the record they mean; if more than one record could be meant, ask which. Report exactly what the tool returned. Never claim to have sent, texted, emailed or called anyone: you cannot. If they want a message sent, say which screen does it.

Enrolling in an action plan sends texts to the seller. Before you call enroll_in_action_plan, tell the person which seller and which plan you are about to enroll and ask them to confirm; call it only after they answer yes. If the plan name matches more than one plan, ask which one.

Counts and money come from the tools. When a count is large, say the number and show the few that matter.${UNTRUSTED_RULE}${WRITING_RULE}`;

// ─── Tools ───────────────────────────────────────────────────────────────────
// A short list of shaped queries and writes rather than free SQL: the model
// picks filters and ids, never a statement, so no question can reach a table
// the caller's role does not already expose through the app.

const LIMIT = 25;
const clampLimit = (n: unknown) => Math.min(Math.max(Number(n) || 8, 1), LIMIT);
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const idOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'todays_focus',
    description: 'The person asking\'s focus list for today, the same one the Today screen shows: overdue and due-today tasks, today\'s appointments, unassigned new leads nobody has called, closings within 7 days, their leads going cold (no touch in 3+ days, most motivated first) and deals sitting 14+ days with no buyer. `top` is the 3–6 to do first, in order; `all` is every candidate.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_my_tasks',
    description: 'Open tasks, soonest due first, with the seller each is on. Mine by default.',
    input_schema: {
      type: 'object',
      properties: {
        overdue_only: { type: 'boolean', description: 'Only tasks already past their due date.' },
        due_today: { type: 'boolean', description: 'Only tasks due before the end of today.' },
        everyone: { type: 'boolean', description: 'The whole team\'s open tasks, not just mine.' },
        seller_id: { type: 'number', description: 'Only this seller\'s tasks.' },
        limit: { type: 'number', description: `1–${LIMIT}, default 8.` },
      },
    },
  },
  {
    name: 'search_sellers',
    description: 'Sellers and their leads. Filter by free text (name, address, phone, email), by lead stage, by how long they have sat in stage, by whether anyone has contacted them lately, or to mine only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against name, property address, email and phone.' },
        stage: { type: 'string', description: 'Exact lead stage label. Use list_stages first if unsure.' },
        stale_days: { type: 'number', description: 'Only sellers whose stage has not changed in at least this many days.' },
        uncontacted_days: { type: 'number', description: 'Only sellers with no call, text or email in this many days.' },
        mine_only: { type: 'boolean', description: 'Only sellers assigned to the person asking.' },
        limit: { type: 'number', description: `1–${LIMIT}, default 8.` },
      },
    },
  },
  {
    name: 'get_seller',
    description: 'One seller in full: contact, property, stage, motivation, asking price, notes, open tasks, the last texts, calls and notes, their action plans and their deals.',
    input_schema: { type: 'object', properties: { seller_id: { type: 'number' } }, required: ['seller_id'] },
  },
  {
    name: 'find_buyers',
    description: 'Cash buyers and their buy boxes. Filter by free text (name, company, email, phone), by market, or by the price they can go to.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against name, company, email and phone.' },
        market: { type: 'string', description: 'City or market name, matched against the buyer\'s markets.' },
        price_at_least: { type: 'number', description: 'Only buyers whose max purchase price is at least this.' },
        vip: { type: 'boolean', description: 'Only VIP buyers.' },
        limit: { type: 'number', description: `1–${LIMIT}, default 8.` },
      },
    },
  },
  {
    name: 'list_deals',
    description: 'Deals under contract or in dispo, with property, stage, money and dates. Filter by stage, a closing window, how long they have sat, whether a buyer is on them, or free text on the address.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against the property address.' },
        stage: { type: 'string', description: 'Exact deal stage label. Use list_stages first if unsure.' },
        closing_within_days: { type: 'number', description: 'Only deals closing within this many days (past-due closings included).' },
        stale_days: { type: 'number', description: 'Only deals whose stage has not changed in at least this many days.' },
        without_buyer: { type: 'boolean', description: 'Only deals with no buyer on them yet.' },
        include_finished: { type: 'boolean', description: 'Also closed and terminated deals.' },
        limit: { type: 'number', description: `1–${LIMIT}, default 8.` },
      },
    },
  },
  {
    name: 'get_deal',
    description: 'One deal in full: property, seller, buyer, stage and dates, the money, the Compr underwrite and any outcome sent to Compr.',
    input_schema: { type: 'object', properties: { deal_id: { type: 'number' } }, required: ['deal_id'] },
  },
  {
    name: 'list_stages',
    description: 'The workspace\'s seller lead stages and deal stages, with how many records sit in each. Cheap — call it whenever a question names a stage you are not sure of.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_action_plans',
    description: 'The workspace\'s action plans (follow-up sequences): id, name, whether it is playing, step count, what starts it, who is on it and a short description.',
    input_schema: { type: 'object', properties: { include_paused: { type: 'boolean', description: 'Also plans that are paused.' } } },
  },
  {
    name: 'show_records',
    description: 'The records behind the answer, for the person to open. Call once, at the end, when the answer is about particular records.',
    input_schema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array', maxItems: 6,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['seller', 'buyer', 'deal'] },
              id: { type: 'number', description: 'The row id exactly as a tool returned it.' },
              title: { type: 'string' },
              subtitle: { type: 'string', description: 'One line: address, stage, money, how long it has sat.' },
            },
            required: ['kind', 'id', 'title', 'subtitle'],
          },
        },
      },
      required: ['cards'],
    },
  },
];

const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_task',
    description: 'Create a task, assigned to the person asking. A write: only when they ask for it.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to do, short.' },
        seller_id: { type: 'number', description: 'The seller it is about, as a tool returned it.' },
        deal_id: { type: 'number', description: 'The deal it is about, as a tool returned it.' },
        due_at: { type: 'string', description: 'ISO 8601 date-time it is due. Default: in one hour.' },
        task_type: { type: 'string', enum: ['call', 'text', 'email', 'todo'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark one open task done. A write: only when the person asks. A task from an action plan moves that plan on.',
    input_schema: { type: 'object', properties: { task_id: { type: 'number' } }, required: ['task_id'] },
  },
  {
    name: 'update_seller_stage',
    description: 'Move a seller to another lead stage. A write: only when the person asks. The deal follows in the database (Under Contract creates one, Closed and Terminated close it).',
    input_schema: {
      type: 'object',
      properties: { seller_id: { type: 'number' }, stage: { type: 'string', description: 'The exact lead stage label.' } },
      required: ['seller_id', 'stage'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to a seller\'s (or a deal\'s) timeline. A write: only when the person asks.',
    input_schema: {
      type: 'object',
      properties: { seller_id: { type: 'number' }, deal_id: { type: 'number' }, body: { type: 'string' } },
      required: ['body'],
    },
  },
  {
    name: 'update_deal_stage',
    description: `Move a deal to another stage (${DEAL_STAGES.join(', ')}). A write: only when the person asks. Closed or Terminated also sends the outcome to Compr on its own.`,
    input_schema: {
      type: 'object',
      properties: { deal_id: { type: 'number' }, stage: { type: 'string' } },
      required: ['deal_id', 'stage'],
    },
  },
  {
    name: 'enroll_in_action_plan',
    description: 'Enroll one seller in an action plan, which queues its texts, calls and emails. It texts the seller: ask the person to confirm the seller and the plan first, and call this only after they say yes. If the plan name is ambiguous the tool says so: ask which plan.',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The plan id from list_action_plans, or its name as the person said it.' },
        seller_id: { type: 'number', description: 'The seller id exactly as a tool returned it.' },
      },
      required: ['plan', 'seller_id'],
    },
  },
];

type Json = Record<string, unknown>;

/** Escapes a value for a PostgREST `or=(...)` filter, where , and ) are syntax. */
const ilikeSafe = (s: string) => s.replace(/[,()\\*]/g, ' ').trim().slice(0, 80);

type Ctx = {
  db: SupabaseClient; admin: SupabaseClient; ws: number; userId: string;
  authHeader: string; question: string;
  /** The asker's workspace role: their seat's work (_shared/seat-brief.ts, lib/seat.ts). */
  role?: string | null;
  /** Rows the tools returned this turn, as kind:id, so show_records can only show real ones. */
  seen: Set<string>;
  cards: Card[];
};
const remember = (ctx: Ctx, kind: 'seller' | 'buyer' | 'deal', ids: unknown[]) => { for (const id of ids) if (id != null) ctx.seen.add(`${kind}:${id}`); };

async function logActivity(ctx: Ctx, entity: 'seller' | 'deal', id: number, kind: string, title: string, body?: string) {
  await ctx.db.from('activity').insert({ workspace_id: ctx.ws, entity_type: entity, entity_id: id, kind, title, body: body ?? null, actor_id: ctx.userId });
}

async function runTool(ctx: Ctx, name: string, args: Json): Promise<unknown> {
  const { db, ws, userId } = ctx;
  const limit = clampLimit(args.limit);
  const q = typeof args.query === 'string' ? ilikeSafe(args.query) : '';

  if (name === 'show_records') {
    ctx.cards = cleanCards(args.cards, ctx.seen);
    return { shown: ctx.cards.length };
  }

  if (name === 'list_stages') {
    const [sellers, deals] = await Promise.all([
      db.from('sellers').select('lead_stage').eq('workspace_id', ws).is('archived_at', null),
      db.from('deals').select('stage').eq('workspace_id', ws),
    ]);
    const tally = (rows: { [k: string]: unknown }[] | null, col: string) => {
      const out: Record<string, number> = {};
      for (const r of rows ?? []) { const k = String(r[col] ?? 'None'); out[k] = (out[k] ?? 0) + 1; }
      return out;
    };
    return { seller_stages: tally(sellers.data, 'lead_stage'), deal_stages: tally(deals.data, 'stage'), seller_stage_labels: SELLER_STAGE_LABELS, deal_stage_labels: DEAL_STAGES };
  }

  if (name === 'todays_focus') {
    const all = await loadFocus(db, ws, userId, undefined, undefined, ctx.role ?? null);
    const top = focusTop(all);
    for (const it of all) remember(ctx, it.record.kind, [it.record.id]);
    const slim = (it: (typeof all)[number]) => ({ id: it.id, kind: it.kind, [`${it.record.kind}_id`]: it.record.id, name: it.title, detail: it.detail });
    return { top: top.map(slim), all: all.slice(0, 40).map(slim), total: all.length };
  }

  if (name === 'list_my_tasks') {
    let sel = db.from('tasks')
      .select('id, title, task_type, priority, due_at, seller_id, deal_id, assigned_to, enrollment_id, sellers(name)')
      .eq('workspace_id', ws).eq('done', false)
      .order('due_at', { ascending: true, nullsFirst: false }).limit(limit);
    if (args.everyone !== true) sel = sel.eq('assigned_to', userId);
    if (args.overdue_only === true) sel = sel.lt('due_at', new Date().toISOString());
    if (args.due_today === true) sel = sel.lt('due_at', new Date(Date.parse(localMidnightIso(new Date(), FOCUS_TZ)) + 86_400_000).toISOString());
    if (idOf(args.seller_id)) sel = sel.eq('seller_id', idOf(args.seller_id)!);
    const { data, error } = await sel;
    if (error) throw error;
    remember(ctx, 'seller', (data ?? []).map((t) => t.seller_id));
    remember(ctx, 'deal', (data ?? []).map((t) => t.deal_id));
    return { count: (data ?? []).length, tasks: (data ?? []).map((t) => ({ ...t, from_action_plan: t.enrollment_id != null, mine: t.assigned_to === userId })) };
  }

  if (name === 'search_sellers') {
    let sel = db.from('sellers')
      .select('id, name, phone, email, property_address, lead_stage, asking_price, motivation, assigned_to, stage_entered_at, updated_at')
      .eq('workspace_id', ws).is('archived_at', null)
      .order('stage_entered_at', { ascending: true, nullsFirst: false }).limit(limit);
    if (q) sel = sel.or(`name.ilike.%${q}%,property_address.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    if (typeof args.stage === 'string' && args.stage) sel = sel.eq('lead_stage', args.stage);
    if (Number(args.stale_days) > 0) sel = sel.lt('stage_entered_at', days(Number(args.stale_days)));
    if (args.mine_only === true) sel = sel.eq('assigned_to', userId);
    const { data, error } = await sel;
    if (error) throw error;
    let rows = data ?? [];
    // "Nobody has touched them" is a second query: the communications table is
    // the only record of an actual outbound attempt.
    if (Number(args.uncontacted_days) > 0 && rows.length) {
      const ids = rows.map((r) => r.id);
      const { data: comms } = await db.from('communications').select('seller_id')
        .eq('workspace_id', ws).in('seller_id', ids).neq('channel', 'note').gte('occurred_at', days(Number(args.uncontacted_days)));
      const touched = new Set((comms ?? []).map((c) => c.seller_id));
      rows = rows.filter((r) => !touched.has(r.id));
    }
    remember(ctx, 'seller', rows.map((r) => r.id));
    return { count: rows.length, sellers: rows.map((r) => ({ ...r, mine: r.assigned_to === userId })) };
  }

  if (name === 'get_seller') {
    const id = idOf(args.seller_id);
    if (!id) return { error: 'seller_id is required: search for the seller first' };
    const { data: s, error } = await db.from('sellers')
      .select('id, name, phone, email, property_address, lead_stage, asking_price, motivation, timeline, condition, occupancy, mortgage, notes, source, tags, assigned_to, stage_entered_at, created_at, properties(line1, city, state, zip, beds, baths, sqft, year_built)')
      .eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!s) return { error: `no seller ${id} in this workspace` };
    const [tasks, comms, plans, deals] = await Promise.all([
      db.from('tasks').select('id, title, task_type, due_at, assigned_to').eq('workspace_id', ws).eq('seller_id', id).eq('done', false).order('due_at', { ascending: true }).limit(8),
      db.from('communications').select('channel, direction, occurred_at, body, status').eq('workspace_id', ws).eq('seller_id', id).order('occurred_at', { ascending: false }).limit(10),
      db.from('enrollments').select('id, status, stopped_reason, enrolled_at, routed_reason, action_plans(name)').eq('workspace_id', ws).eq('seller_id', id).order('enrolled_at', { ascending: false }).limit(8),
      db.from('deals').select('id, stage, offer_amount, close_date, terminated').eq('workspace_id', ws).eq('seller_id', id).limit(5),
    ]);
    remember(ctx, 'seller', [id]);
    remember(ctx, 'deal', (deals.data ?? []).map((d) => d.id));
    return {
      seller: { ...s, mine: s.assigned_to === userId, notes: String(s.notes ?? '').slice(0, 1500) },
      open_tasks: tasks.data ?? [],
      recent: (comms.data ?? []).map((c) => ({ ...c, body: String(c.body ?? '').slice(0, 300) })),
      action_plans: (plans.data ?? []).map((e) => ({ id: e.id, plan: (e.action_plans as unknown as { name?: string } | null)?.name ?? null, status: e.status, stopped_reason: e.stopped_reason, enrolled_at: e.enrolled_at, routed: e.routed_reason })),
      deals: deals.data ?? [],
    };
  }

  if (name === 'find_buyers') {
    let sel = db.from('buyers')
      .select('id, name, company, email, phone, markets, min_purchase_price, max_purchase_price, buyer_type, status, vip, last_activity_at')
      .eq('workspace_id', ws).is('blacklisted_at', null)
      .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(limit);
    if (q) sel = sel.or(`name.ilike.%${q}%,company.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    if (typeof args.market === 'string' && args.market) sel = sel.contains('markets', [args.market]);
    if (Number(args.price_at_least) > 0) sel = sel.gte('max_purchase_price', Number(args.price_at_least));
    if (args.vip === true) sel = sel.eq('vip', true);
    const { data, error } = await sel;
    if (error) throw error;
    remember(ctx, 'buyer', (data ?? []).map((b) => b.id));
    return { count: (data ?? []).length, buyers: data ?? [] };
  }

  if (name === 'list_deals') {
    let sel = db.from('deals')
      .select('id, stage, offer_amount, arv, rehab, assignment_fee, sold_price, contract_date, close_date, option_ends_on, market, stage_entered_at, terminated, buyer_id, seller_id, properties(line1, city, state, zip), sellers(name)')
      .eq('workspace_id', ws).is('archived_at', null)
      .order('close_date', { ascending: true, nullsFirst: false }).limit(limit);
    if (args.include_finished !== true) sel = sel.eq('terminated', false).in('stage', ACTIVE_DEAL_STAGES);
    if (typeof args.stage === 'string' && args.stage) sel = sel.eq('stage', args.stage);
    if (Number(args.closing_within_days) > 0) {
      const end = new Date(Date.now() + Number(args.closing_within_days) * 86_400_000).toISOString().slice(0, 10);
      sel = sel.not('close_date', 'is', null).lte('close_date', end);
    }
    if (Number(args.stale_days) > 0) sel = sel.lt('stage_entered_at', days(Number(args.stale_days)));
    if (args.without_buyer === true) sel = sel.is('buyer_id', null);
    const { data, error } = await sel;
    if (error) throw error;
    let rows = data ?? [];
    // PostgREST cannot filter on an embedded table's column, so an address
    // search filters the page we got back rather than the whole table.
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((r) => {
        const p = r.properties as { line1?: string; city?: string } | null;
        return `${p?.line1 ?? ''} ${p?.city ?? ''}`.toLowerCase().includes(needle);
      });
    }
    remember(ctx, 'deal', rows.map((r) => r.id));
    remember(ctx, 'seller', rows.map((r) => r.seller_id));
    return { count: rows.length, deals: rows };
  }

  if (name === 'get_deal') {
    const id = idOf(args.deal_id);
    if (!id) return { error: 'deal_id is required: list the deals first' };
    const { data: d, error } = await db.from('deals')
      .select('id, stage, lead_stage, offer_amount, arv, rehab, mao, assignment_fee, sold_price, earnest_money, contract_date, close_date, closed_on, option_ends_on, terminated, terminated_on, termination_reason, stage_entered_at, underwriting_url, notes, seller_id, buyer_id, properties(line1, city, state, zip), sellers(name, phone), buyers(name, company)')
      .eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!d) return { error: `no deal ${id} in this workspace` };
    const uw = await db.from('compr_underwrites').select('lead_id, created_at, source').eq('workspace_id', ws).eq('deal_id', id).order('created_at', { ascending: false }).limit(1);
    remember(ctx, 'deal', [id]);
    remember(ctx, 'seller', [d.seller_id]);
    remember(ctx, 'buyer', [d.buyer_id]);
    return { deal: { ...d, notes: String(d.notes ?? '').slice(0, 1200) }, compr_underwrite: uw.data?.[0] ?? null };
  }

  if (name === 'list_action_plans') {
    let sel = db.from('action_plans')
      .select('id, name, description, active, trigger_type, trigger_value, action_plan_steps(count)')
      .eq('workspace_id', ws).order('name');
    if (args.include_paused !== true) sel = sel.eq('active', true);
    const { data, error } = await sel;
    if (error) throw error;
    const { data: on } = await db.from('enrollments').select('plan_id').eq('workspace_id', ws).in('status', ['active', 'paused']);
    const running = new Map<number, number>();
    for (const r of on ?? []) running.set(r.plan_id, (running.get(r.plan_id) ?? 0) + 1);
    return {
      count: (data ?? []).length,
      action_plans: (data ?? []).map((p) => ({
        id: p.id, name: p.name, playing: p.active,
        steps: (p.action_plan_steps as unknown as { count: number }[] | null)?.[0]?.count ?? 0,
        starts: p.trigger_type === 'manual' ? 'by hand' : `${p.trigger_type}${p.trigger_value ? `: ${p.trigger_value}` : ''}`,
        on_it: running.get(p.id) ?? 0,
        description: String(p.description ?? '').slice(0, 160),
      })),
    };
  }

  // ---- writes ---------------------------------------------------------------------

  if (name === 'create_task') {
    const title = String(args.title ?? '').trim().slice(0, 200);
    if (!title) return { error: 'a task needs a title' };
    const sellerId = idOf(args.seller_id);
    const dealId = idOf(args.deal_id);
    const due = typeof args.due_at === 'string' && !Number.isNaN(Date.parse(args.due_at)) ? new Date(args.due_at).toISOString() : new Date(Date.now() + 3_600_000).toISOString();
    const type = ['call', 'text', 'email', 'todo'].includes(String(args.task_type)) ? String(args.task_type) : 'todo';
    const priority = ['low', 'normal', 'high'].includes(String(args.priority)) ? String(args.priority) : 'normal';
    const { data, error } = await db.from('tasks').insert({
      workspace_id: ws, seller_id: sellerId, deal_id: dealId, title, task_type: type, priority, due_at: due, assigned_to: userId, created_by: userId,
    }).select('id, title, due_at').single();
    if (error) return { outcome: 'error', error: error.message };
    return { outcome: 'created', task: data };
  }

  if (name === 'complete_task') {
    const id = idOf(args.task_id);
    if (!id) return { error: 'task_id is required: list the tasks first' };
    const { data: t } = await db.from('tasks').select('id, title, done, seller_id').eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (!t) return { outcome: 'error', error: `no task ${id} in this workspace` };
    if (t.done) return { outcome: 'already_done', task: { id: t.id, title: t.title } };
    const { error } = await db.from('tasks').update({ done: true, completed_at: new Date().toISOString() }).eq('id', id);
    if (error) return { outcome: 'error', error: error.message };
    return { outcome: 'completed', task: { id: t.id, title: t.title } };
  }

  if (name === 'update_seller_stage') {
    const id = idOf(args.seller_id);
    const stage = matchStage(SELLER_STAGE_LABELS, args.stage);
    if (!id) return { error: 'seller_id is required' };
    if (!stage) return { outcome: 'error', error: 'not a lead stage', stages: SELLER_STAGE_LABELS };
    const { data: s } = await db.from('sellers').select('id, name, lead_stage').eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (!s) return { outcome: 'error', error: `no seller ${id} in this workspace` };
    if (s.lead_stage === stage) return { outcome: 'unchanged', seller: s };
    const { error } = await db.from('sellers').update({ lead_stage: stage }).eq('id', id).eq('workspace_id', ws);
    if (error) return { outcome: 'error', error: error.message };
    await logActivity(ctx, 'seller', id, 'stage', 'Stage → ' + stage, 'Moved by Ask CLOZR');
    return { outcome: 'moved', seller: { id, name: s.name }, from: s.lead_stage, to: stage };
  }

  if (name === 'add_note') {
    const body = String(args.body ?? '').trim().slice(0, 4000);
    const sellerId = idOf(args.seller_id);
    const dealId = idOf(args.deal_id);
    if (!body) return { error: 'the note is empty' };
    if (!sellerId && !dealId) return { error: 'say which seller or deal the note is on' };
    const { data, error } = await db.from('communications').insert({
      workspace_id: ws, seller_id: sellerId, ...(dealId ? { deal_id: dealId } : {}), channel: 'note', direction: 'outbound', body,
      occurred_at: new Date().toISOString(), rep_id: userId, source: 'clozr', source_id: crypto.randomUUID(),
    }).select('id').single();
    if (error) return { outcome: 'error', error: error.message };
    return { outcome: 'added', note_id: data.id };
  }

  if (name === 'update_deal_stage') {
    const id = idOf(args.deal_id);
    const stage = matchStage(DEAL_STAGES, args.stage);
    if (!id) return { error: 'deal_id is required' };
    if (!stage) return { outcome: 'error', error: 'not a deal stage', stages: DEAL_STAGES };
    const { data: d } = await db.from('deals').select('id, stage').eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (!d) return { outcome: 'error', error: `no deal ${id} in this workspace` };
    if (d.stage === stage) return { outcome: 'unchanged', deal: d };
    const { error } = await db.from('deals').update({ stage, updated_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', ws);
    if (error) return { outcome: 'error', error: error.message };
    await logActivity(ctx, 'deal', id, 'stage', 'Deal → ' + stage, 'Moved by Ask CLOZR');
    return { outcome: 'moved', deal_id: id, from: d.stage, to: stage };
  }

  if (name === 'enroll_in_action_plan') {
    const sellerId = idOf(args.seller_id);
    if (!sellerId) return { outcome: 'error', error: 'seller_id is required: find the seller first' };
    // Read as the caller first: RLS decides whether they can see this plan and
    // this seller before the service-role RPC runs.
    const [plans, seller] = await Promise.all([
      db.from('action_plans').select('id, name').eq('workspace_id', ws).eq('active', true),
      db.from('sellers').select('id, name').eq('workspace_id', ws).eq('id', sellerId).is('archived_at', null).maybeSingle(),
    ]);
    if (plans.error) throw plans.error;
    if (seller.error) throw seller.error;
    if (!seller.data) return { outcome: 'error', error: `no seller ${sellerId} in this workspace` };
    const m = matchPlan(plans.data ?? [], args.plan);
    if ('ambiguous' in m) return { outcome: 'ambiguous', message: 'More than one plan matches: ask which one. Nothing was enrolled.', options: m.ambiguous };
    if ('none' in m) return { outcome: 'error', error: 'no active plan by that name or id', plans: (plans.data ?? []).map((p) => p.name) };
    const plan = m.plan;
    // The texts go to a real person: the yes has to be in the person's own latest message.
    if (!saidYes(ctx.question)) {
      return { outcome: 'needs_confirmation', message: `Nothing was enrolled. Ask the person to confirm: enroll ${seller.data.name} in "${plan.name}"? Call again only after they say yes.`, plan, seller: seller.data };
    }

    // Same "already on it" rule as lib/plans.ts; plan_enroll itself only
    // checks active, and would return null without saying why.
    const { data: running, error: runErr } = await db.from('enrollments').select('id')
      .eq('workspace_id', ws).eq('plan_id', plan.id).eq('seller_id', sellerId).in('status', ['active', 'paused']).limit(1);
    if (runErr) throw runErr;
    if (running?.length) return { outcome: 'already_enrolled', plan, seller: seller.data, enrollment_id: running[0].id };

    const { data: enrollmentId, error } = await ctx.admin.rpc('plan_enroll', {
      p_workspace: ws, p_plan: plan.id, p_seller: sellerId, p_actor: userId,
    });
    if (error) {
      console.error('ask-clozr plan_enroll', error);
      return { outcome: 'error', error: 'the enrollment failed' };
    }
    if (enrollmentId == null) return { outcome: 'error', error: 'the plan did not start: the seller is already on it, or the plan or seller is gone' };
    return { outcome: 'enrolled', plan, seller: seller.data, enrollment_id: enrollmentId };
  }

  return { error: `unknown tool ${name}` };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 8;
type Send = (event: Json) => void;

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Ask CLOZR is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; question?: string; history?: unknown; context?: { focus?: unknown }; stream?: boolean; read_only?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const question = String(body.question ?? '').trim();
  if (!question) return json({ error: 'question is required' }, 422);
  if (question.length > 2000) return json({ error: 'question is too long' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `ask-clozr:${who.user.id}`, 60, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  const onScreen = focusContext(body.context?.focus);
  const ask = [
    `Today is ${today} (Central). You are in workspace ${workspaceId}.`,
    onScreen ? `The person is on the Today screen, looking at their focus list, numbered as on screen:\n${fence('focus_list', onScreen, 3000)}` : null,
    fence('question', question, 2000),
  ].filter(Boolean).join('\n\n');
  const thread = threadFrom(body.history);
  const messages: Anthropic.MessageParam[] = thread.map((t) => ({ role: t.role, content: t.content }));
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content = `${messages[messages.length - 1].content}\n\n${ask}`;
  else messages.push({ role: 'user', content: ask });

  const ctx: Ctx = { db: asCaller, admin, ws: workspaceId, userId: who.user.id, authHeader, question, seen: new Set(), cards: [], role: member.role ?? null };
  const tools = body.read_only === true ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];

  /** The loop, reporting through `send`. Resolves with the whole answer. */
  const run = async (send: Send): Promise<{ answer: string } | { error: string; status: number }> => {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    let answer = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS - 1;
        const stream = client.messages.stream({
          model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
          max_tokens: 3000,
          system: SYSTEM + '\n\n' + seatBrief(member.role),
          // The last round answers from what it has: no more lookups.
          tools: last ? tools.filter((t) => t.name === 'show_records') : tools,
          tool_choice: { type: 'auto' },
          messages,
        });
        // A later round's prose starts a new paragraph.
        let fresh = true;
        stream.on('text', (delta) => {
          if (!delta) return;
          if (fresh && answer && !answer.endsWith('\n')) { answer += '\n\n'; send({ type: 'text', text: '\n\n' }); }
          fresh = false;
          answer += delta;
          send({ type: 'text', text: delta });
        });
        const msg = await stream.finalMessage();
        messages.push({ role: 'assistant', content: msg.content });
        const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || !calls.length) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const c of calls) {
          send({ type: 'tool', name: c.name, status: 'start' });
          let content: string;
          let ok = true;
          try {
            const r = await runTool(ctx, c.name, (c.input ?? {}) as Json);
            ok = !(r && typeof r === 'object' && ('error' in r || (r as Json).outcome === 'error'));
            // Row text came from imports, sellers and buyers — data, not orders.
            content = fence('records', JSON.stringify(r), 30_000);
          } catch (e) {
            ok = false;
            console.error('ask-clozr tool', c.name, e);
            content = JSON.stringify({ error: 'that lookup failed' });
          }
          send({ type: 'tool', name: c.name, status: ok ? 'done' : 'error' });
          if (c.name === 'show_records') send({ type: 'cards', cards: ctx.cards });
          results.push({ type: 'tool_result', tool_use_id: c.id, content });
        }
        messages.push({ role: 'user', content: results });
      }
      answer = answer.trim();
      if (!answer) return { error: 'Ask CLOZR returned no answer', status: 502 };
      return { answer };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { error: 'the ANTHROPIC_API_KEY secret is invalid', status: 503 };
      if (e instanceof Anthropic.RateLimitError) return { error: 'rate limited — try again in a moment', status: 429 };
      if (e instanceof Anthropic.APIError && /anthropic-workspace-id/.test(e.message)) return { error: WORKSPACE_HINT, status: 503 };
      console.error('ask-clozr', e);
      return { error: 'Ask CLOZR hit an error on our side. Try again in a moment.', status: 502 };
    }
  };

  if (body.stream === true) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send: Send = (o) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { /* client went away */ } };
        try {
          const r = await run(send);
          if ('error' in r) send({ type: 'error', error: r.error });
          else send({ type: 'done', answer: r.answer, cards: ctx.cards });
        } catch (e) {
          console.error('ask-clozr stream', e);
          send({ type: 'error', error: 'Ask CLOZR hit an error on our side. Try again in a moment.' });
        } finally {
          try { ctrl.close(); } catch { /* closed */ }
        }
      },
    });
    return new Response(stream, { headers: { ...CORS, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  try {
    const r = await run(() => {});
    if ('error' in r) return json({ error: r.error }, r.status);
    return json({ ok: true, answer: r.answer, cards: ctx.cards });
  } catch (e) {
    return serverError(CORS, 'ask-clozr', e);
  }
});
