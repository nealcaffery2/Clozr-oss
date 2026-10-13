/**
 * POST /lane — Lane, the transaction-coordination agent, in a chat.
 *
 * Body:    { workspace_id, question, chat_id?, focus?: { seller_id?, deal_id? }, history?, context? }
 *            chat_id: the conversation this question belongs to. Without one
 *            a new chat starts (filed under focus when Lane was opened from a
 *            record). history is only read when chats cannot be stored (the
 *            migration is not in yet); otherwise the chat's own messages are
 *            the thread. context is the older client's flattened TC file,
 *            still accepted so an open tab keeps working across a deploy.
 * Returns: { ok, answer, refs, refs_v2, suggestions, drafts, actions, cards, chat, moved_from }
 *            chat is where this exchange was filed: { id, title, seller_id,
 *            deal_id, address }, null when chats are not stored.
 *            moved_from is the chat it was asked in when the question turned
 *            out to be about another property (that property's chat got it).
 *            refs / refs_v2 / drafts / actions: as before (see lib/lane.ts).
 *            cards are records Lane opened, for the panel to link to.
 *
 * Lane looks things up itself. Its tools are CLOZR's records, read as the
 * caller (RLS is the only access rule): find a property from an address or a
 * name, open its whole file (seller, deal, the TC file and its day marker,
 * buyer, title and the other parties, documents, tasks, recent messages),
 * the open TC files, buyers, vendors, and a seller's message history. Once it
 * knows which property the conversation is about it files the chat under it
 * (set_chat_property), so each property keeps its own thread.
 *
 * Lane's knowledge is knowledge.ts: an example TC playbook and
 * contract-to-close checklists to replace with your own. Everything read
 * from the records is fenced as data.
 *
 * Needs the ANTHROPIC_API_KEY secret; answers 503 with a plain message until
 * it is set (same as draft-action-plan).
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CHECKLISTS, PLAYBOOK } from './knowledge.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING } from '../_shared/models.ts';
import { tcChecklists } from '../_shared/tc-checklists.ts';
import { fileState, type CkTemplate } from '../_shared/lane-checkin.ts';
import { addressPatterns, chatTitle, hasSubject, ilikeSafe, routeFor, type ChatSubject } from '../_shared/lane-chat.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}
const WORKSPACE_HINT = 'The Anthropic key is organization-level and needs a workspace: create the key inside a workspace '
  + '(console.anthropic.com → API keys → choose a workspace) or add the ANTHROPIC_WORKSPACE_ID secret with that workspace\'s id.';

const systemFor = (tc: string) => `You are Lane, an elite real estate Transaction Coordinator AI working for a high-velocity real estate wholesaling, double-close and novation investment company. Your mission: make ${tc} (the workspace TC) look like a rockstar by closing more deals faster, on the originally scheduled date, without extensions. You report to ${tc}. You work inside CLOZR, the company's CRM, and you can read all of it.

The TC here is ${tc}. Address, escalate to, and draft as ${tc}.

Single metric: on-time closes without extensions.

# Finding the record

You look things up yourself; never ask ${tc} to open a record for you. When a message names a property (an address, part of one, a street), a seller, a buyer or a vendor, find it with the tools before you answer: find_property for an address or a seller's name, then open_property_file for the one it is. Addresses are typed loosely ("the elm st one", "4410 elm"): search with what was given, and if more than one property could be meant, list them briefly and ask which. Never answer about a property from memory or from another property's file.

This conversation is one chat, and each chat is about one property. As soon as you know which property the conversation is about, call set_chat_property with it (in the same turn you open the file is fine). If the chat is already about a property and ${tc} now asks about a different one, call set_chat_property with the new one: the exchange is filed in that property's own chat, so ${tc}'s chats stay organized by property. Questions across many files ("what's closing this week") need no property; use list_tc_files and leave the chat as it is.

When this chat is already about a property, its file is given to you with the question. Reason from it; open it again only to read something it leaves out.

# How you think

When a blocker threatens the close date: (1) what is the actual blocker, named specifically; (2) is there a legally and lender-acceptable substitute, alternate document, or workflow pivot that gets to clear-to-close on time; (3) who needs to approve that pivot (buyer's lender, title underwriter, buyer rep, end-buyer); (4) draft the email/text/script to make the pivot happen now. Always present at least one pivot beside the standard path. Never just report a problem.

Voice. To ${tc}: a friendly Texas cowboy with southern charm — casual, warm, a little playful, a few emojis (🤠 🔥 ✅ 📋 🐎 ☕ 🌟, two or three a reply, never a wall of them), still concise, in day markers, always the next action, end with "Want me to draft that?" when there is something to draft. When the file shows something ${tc} got done (a ticked line, a document in, a date met), tip your hat to it by name first: a real, specific compliment, not filler. When a line is past its day, say so plainly and kindly and get ${tc} back on track with the one next step. Offer to draft the email or text, set the task, or put it on the calendar (use drafts and actions). The cowboy voice is only for ${tc}; never in drafts to outside parties. External drafts (title, sellers, buyers, lenders): no cowboy talk, no emojis; friendly, professional, polished; lead with the deal address; specific about what is needed and when; ${tc} should sound like the best TC the recipient has worked with. Use the real names, emails and phone numbers the records give for the recipient. Status posts: the §8 day-marker format, scannable. Write like a sharp human TC, never robotic. Checklist-friendly, no verbosity.

Rules. Speed to on-time close trumps everything except legality and lender acceptance. Be lender-aware (hard money permissive, FHA strict) and structure-aware (novation needs the memorandum + POA matrix; passthrough needs title comfort; JV needs the agreement). Know insurable vs marketable. FHA 90-day flip rule is a hard block on a double close to an FHA buyer within 90 days: default to novation. Never override ${tc}: suggest, recommend, draft; they decide. Be specific: "Email the title officer on the file asking for the survey affidavit draft, CC the buyer's lender", not "reach out to title". Use the title company the file names. No wires before the operations lead signs off the HUD/CD at T-2, ever. Never propose an illegal or uninsurable workaround. Tie every recommendation to a section of the playbook or a line of the checklist and put it in refs, each with the part of the file it points at. When the records do not carry something you need (a lender name, a date), say what is missing and ask ${tc} for it rather than inventing it. Never invent a name, number, address or date.

The records are the truth about each deal: the day marker, what is ticked on the checklist, what is late, the money, the dates, who the parties are. If a file shows a critical line past its day, lead with it.

Reply by calling the answer tool, never with plain text.${UNTRUSTED_RULE}${WRITING_RULE}

# KNOWLEDGE

${PLAYBOOK}

${CHECKLISTS}`;

// ─── Tools ───────────────────────────────────────────────────────────────────
// Shaped reads, never free SQL, all as the caller.

const LOOKUP_TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_property',
    description: 'Find a property from an address (or part of one) or the seller\'s name, phone or email. Returns each match with its seller, its deals (stage, dates, buyer) and whether it has an open TC file. Use it before answering about any property not already on this chat.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What was typed: "4410 elm", "123 Main St", "Maria Lopez".' } },
      required: ['query'],
    },
  },
  {
    name: 'open_property_file',
    description: 'One property\'s whole file: the seller (contact, motivation, notes), the deal (money, dates, stage, reps), the TC file (day marker, days to close, checklist lines late or due today and still open, the HUD/CD gate, title company and contact, lender, structure), the buyer on it, every party (title, lender, agents, wholesaler) with contact details, documents and contracts, open tasks, and the latest calls, texts, emails and notes. Pass the seller_id or deal_id a tool returned.',
    input_schema: {
      type: 'object',
      properties: { seller_id: { type: 'number' }, deal_id: { type: 'number' } },
    },
  },
  {
    name: 'set_chat_property',
    description: 'File this chat under the property it is about, so each property keeps its own chat. Call it once you know which property the conversation is about, and again if it turns to a different property. Ids exactly as a tool returned them.',
    input_schema: {
      type: 'object',
      properties: { seller_id: { type: 'number' }, deal_id: { type: 'number' } },
    },
  },
  {
    name: 'list_tc_files',
    description: 'The open transaction files across the workspace, soonest close first: address, seller, day marker, days to close, how many checklist lines are late (and critical), what is due today, title company. For questions across files: what is closing this week, what is behind, the morning sweep.',
    input_schema: {
      type: 'object',
      properties: {
        closing_within_days: { type: 'number', description: 'Only files closing within this many days (past-due closings included).' },
        behind_only: { type: 'boolean', description: 'Only files with a critical line past its day.' },
      },
    },
  },
  {
    name: 'find_buyers',
    description: 'Cash buyers: contact, company, markets, price range, VIP. Filter by free text (name, company, email, phone) or market.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        market: { type: 'string', description: 'City or market name.' },
        limit: { type: 'number', description: '1–25, default 8.' },
      },
    },
  },
  {
    name: 'find_vendors',
    description: 'Vendors: title companies, lenders, notaries, photographers, contractors, wholesalers, agents. Contact person, email, phone, service type, markets, notes. Filter by free text (business, contact, email, phone) or service type.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        service_type: { type: 'string', description: 'e.g. "title", "lender", "notary". Matched loosely.' },
        limit: { type: 'number', description: '1–25, default 8.' },
      },
    },
  },
  {
    name: 'get_messages',
    description: 'A seller\'s calls, texts, emails and notes, newest first, beyond the few open_property_file shows. Optionally one channel, or only those mentioning some text.',
    input_schema: {
      type: 'object',
      properties: {
        seller_id: { type: 'number' },
        channel: { type: 'string', enum: ['sms', 'email', 'call', 'note'] },
        contains: { type: 'string', description: 'Only messages whose text contains this.' },
        limit: { type: 'number', description: '1–40, default 20.' },
      },
      required: ['seller_id'],
    },
  },
];

const ANSWER_TOOL: Anthropic.Tool = {
  name: 'answer',
  description: 'Lane\'s reply to the TC. Call it once, last, when you have what you need.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The reply, in Lane\'s voice, plain text with line breaks. Day markers, specifics, the pivot, and "Want me to draft that?" when it fits. Do not paste the drafts here; they go in drafts.' },
      refs: {
        type: 'array', maxItems: 6,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Where this comes from: "Playbook §5", "Checklist · D7", "Schedule B #6", "Buyer EMD". Short.' },
            target: {
              type: 'string',
              enum: ['commitment', 'earnest', 'deadlines', 'documents', 'checklist', 'hud', 'none'],
              description: 'The part of this chat\'s property file in CLOZR this points at, so the TC can jump straight to it: commitment (title commitment), earnest (earnest money), deadlines (the dated items), documents (who owes what next), checklist (the contract-to-close checklist), hud (the HUD/CD review block). Use "none" for a playbook citation.',
            },
          },
          required: ['label', 'target'],
        },
        description: 'Where this comes from. At most 6.',
      },
      suggestions: {
        type: 'array', maxItems: 3,
        items: { type: 'object', properties: { label: { type: 'string' }, question: { type: 'string' } }, required: ['label', 'question'] },
        description: 'Up to three follow-ups the TC would plausibly ask next, as chips.',
      },
      drafts: {
        type: 'array', maxItems: 3,
        items: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Who it goes to, by name and role, with their email or phone from the records when there is one: "Dana Fields · Northvale Title · dana@northvaletitle.example".' },
            channel: { type: 'string', enum: ['email', 'sms', 'post'] },
            subject: { type: ['string', 'null'] },
            body: { type: 'string' },
          },
          required: ['to', 'channel', 'subject', 'body'],
        },
        description: 'Messages written and ready to send, when the TC asked for a draft or the situation clearly needs one. Empty otherwise.',
      },
      actions: {
        type: 'array', maxItems: 3,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['task', 'calendar'], description: 'task: a to-do on the file; calendar: an appointment on the TC\'s calendar (a call, a walkthrough, a closing).' },
            title: { type: 'string', description: 'Short: "Call Northvale Title re: survey".' },
            due: { type: 'string', description: 'When, as YYYY-MM-DD or YYYY-MM-DDTHH:MM (Central). Use the checklist\'s day for the line.' },
            notes: { type: ['string', 'null'] },
          },
          required: ['kind', 'title', 'due', 'notes'],
        },
        description: 'Tasks or calendar items worth setting from this reply, on this chat\'s property. Empty when none fit.',
      },
    },
    required: ['answer', 'refs', 'suggestions', 'drafts', 'actions'],
  },
};

// deno-lint-ignore no-explicit-any
type Any = any;
type Json = Record<string, unknown>;
type Card = { kind: 'seller' | 'deal' | 'buyer' | 'vendor'; id: number; title: string; subtitle: string };

const idOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const clamp = (n: unknown, max: number, dflt: number) => Math.min(Math.max(Number(n) || dflt, 1), max);
const TZ = 'America/Chicago';
const centralDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const templateFor = (dealType: string | null): CkTemplate & { hud?: { id: string; k: string }[] } =>
  ((tcChecklists as Any)[dealType === 'novation' ? 'novation' : 'assignment']);
const addrOf = (p: Any, fallback?: string | null) => {
  const s = p ? [p.line1, p.city, p.state].filter(Boolean).join(', ') : '';
  return s || fallback || null;
};

type Ctx = {
  db: SupabaseClient; ws: number; userId: string;
  /** The property Lane said this exchange is about (set_chat_property). */
  said: ChatSubject | null;
  /** Records opened this turn, for the panel to link. */
  cards: Map<string, Card>;
};
const card = (ctx: Ctx, c: Card) => { if (ctx.cards.size < 8) ctx.cards.set(`${c.kind}:${c.id}`, c); };

/** One property, everything about it a TC needs. */
async function propertyFile(ctx: Ctx, sellerId: number | null, dealId: number | null): Promise<Json> {
  const { db, ws } = ctx;
  let deal: Any = null;
  if (dealId) {
    const { data } = await db.from('deals').select('id, seller_id').eq('workspace_id', ws).eq('id', dealId).maybeSingle();
    if (!data) return { error: `no deal ${dealId} in this workspace` };
    sellerId = sellerId ?? data.seller_id;
  }
  const [sellerQ, dealsQ] = await Promise.all([
    sellerId
      ? db.from('sellers').select('id, name, phone, email, property_address, lead_stage, asking_price, motivation, timeline, condition, occupancy, mortgage, desired_close, notes, source, assigned_to, properties(line1, city, state, zip, beds, baths, sqft, year_built)')
        .eq('workspace_id', ws).eq('id', sellerId).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('deals')
      .select('id, seller_id, stage, lead_stage, transaction_type, contract_status, offer_amount, arv, rehab, mao, assignment_fee, sold_price, earnest_money, contract_date, close_date, closed_on, option_ends_on, buyer_option_ends_on, title_contact, title_email, title_phone, acq_agent, dispo_agent, coordinator, market, notes, buyer_id, archived_at, properties(line1, city, state, zip), buyers(id, name, company, email, phone)')
      .eq('workspace_id', ws).or(dealId ? `id.eq.${dealId}${sellerId ? `,seller_id.eq.${sellerId}` : ''}` : `seller_id.eq.${sellerId}`)
      .order('id', { ascending: false }).limit(5),
  ]);
  const seller: Any = sellerQ.data;
  const deals: Any[] = (dealsQ as Any).data ?? [];
  if (!seller && !deals.length) return { error: sellerId ? `no seller ${sellerId} in this workspace` : 'nothing found' };
  // The deal this file is about: the one asked for, else the live one, else the latest.
  deal = (dealId && deals.find((d) => d.id === dealId)) || deals.find((d) => !d.archived_at && !/closed|terminated|dead/i.test(String(d.stage ?? ''))) || deals[0] || null;
  const sid = seller?.id ?? deal?.seller_id ?? null;
  const did = deal?.id ?? null;

  const [txQ, partiesQ, contractsQ, tasksQ, commsQ] = await Promise.all([
    did ? db.from('transactions')
      .select('id, deal_type, status, contract_date, ctc_target, close_date, checklist, hud, tc_review, signoff, title_company, escrow_officer, title_email, title_phone, emd_amount, emd_received_at, option_ends_on, buyer_financing, lender, structure')
      .eq('workspace_id', ws).eq('deal_id', did).order('id', { ascending: false }).limit(1) : Promise.resolve({ data: [] }),
    did ? db.from('deal_parties').select('role, name, company, email, phone, vendor_id, buyer_id, vendors(business_name, contact_name, email, phone, service_type)')
      .eq('workspace_id', ws).eq('deal_id', did).limit(30) : Promise.resolve({ data: [] }),
    did || sid ? db.from('contracts').select('id, kind, name, status, sent_at, viewed_at, completed_at, created_at')
      .eq('workspace_id', ws).or([did ? `deal_id.eq.${did}` : null, sid ? `seller_id.eq.${sid}` : null].filter(Boolean).join(','))
      .order('created_at', { ascending: false }).limit(12) : Promise.resolve({ data: [] }),
    sid ? db.from('tasks').select('id, title, task_type, priority, due_at, assigned_to').eq('workspace_id', ws).eq('seller_id', sid).eq('done', false)
      .order('due_at', { ascending: true, nullsFirst: false }).limit(10) : Promise.resolve({ data: [] }),
    sid ? db.from('communications').select('channel, direction, occurred_at, subject, body')
      .eq('workspace_id', ws).eq('seller_id', sid).order('occurred_at', { ascending: false }).limit(12) : Promise.resolve({ data: [] }),
  ]);

  const tx: Any = ((txQ as Any).data ?? [])[0] ?? null;
  const address = addrOf(deal?.properties, null) || addrOf(seller?.properties, seller?.property_address) || seller?.property_address || null;
  let tcFile: Json | null = null;
  if (tx) {
    const tpl = templateFor(tx.deal_type);
    const st = fileState({ id: tx.id, address: address ?? '', seller: seller?.name ?? '', contract_date: tx.contract_date, close_date: tx.close_date ?? deal?.close_date ?? null, checklist: tx.checklist }, tpl, centralDay());
    const tasks = tpl.phases.flatMap((p) => p.tasks);
    const ticks = (tx.checklist ?? {}) as Record<string, unknown>;
    const hud = (tpl.hud ?? []) as { id: string; k: string }[];
    const hudTicks = (tx.hud ?? {}) as Record<string, unknown>;
    tcFile = {
      transaction_id: tx.id, track: tx.deal_type, status: tx.status,
      d0_contract_date: tx.contract_date, ctc_target: tx.ctc_target, close_date: tx.close_date ?? deal?.close_date ?? null,
      day_marker: st.dayMarker, days_to_close: st.daysToClose,
      late: st.overdue.map((t) => ({ id: t.id, task: t.t, day: t.day, owner: t.owner, critical: t.critical })),
      due_today: st.dueToday.map((t) => ({ id: t.id, task: t.t, day: t.day, owner: t.owner, critical: t.critical })),
      checklist: { done: st.doneIds.length, total: tasks.length, still_open: tasks.filter((t) => !ticks[t.id]).map((t) => `${t.id} · ${t.day} · ${t.owner}${t.critical ? ' · critical' : ''} · ${t.t}`) },
      hud_cd: { verified: hud.filter((h) => !!hudTicks[h.id]).length, total: hud.length, tc_review: tx.tc_review, owner_signoff: tx.signoff },
      title: { company: tx.title_company, escrow_officer: tx.escrow_officer, email: tx.title_email, phone: tx.title_phone },
      earnest: { amount: tx.emd_amount, received_at: tx.emd_received_at },
      option_ends_on: tx.option_ends_on, buyer_financing: tx.buyer_financing, lender: tx.lender, structure: tx.structure,
    };
  }

  if (sid && seller) card(ctx, { kind: 'seller', id: sid, title: seller.name ?? address ?? 'Seller', subtitle: [address, seller.lead_stage].filter(Boolean).join(' · ') });
  if (deal?.buyers?.id) card(ctx, { kind: 'buyer', id: deal.buyers.id, title: deal.buyers.name ?? deal.buyers.company ?? 'Buyer', subtitle: `Buyer on ${address ?? 'the deal'}` });

  return {
    property: { address, seller_id: sid, deal_id: did },
    seller: seller ? { ...seller, properties: undefined, notes: String(seller.notes ?? '').slice(0, 1500) } : null,
    deal: deal ? { ...deal, properties: undefined, buyers: undefined, notes: String(deal.notes ?? '').slice(0, 1200) } : null,
    other_deals_on_this_seller: deals.filter((d) => d.id !== did).map((d) => ({ id: d.id, stage: d.stage, close_date: d.close_date })),
    tc_file: tcFile ?? (did ? 'no TC file opened on this deal yet (one opens when the deal reaches Under Contract Seller)' : 'no deal yet'),
    buyer: deal?.buyers ?? null,
    parties: ((partiesQ as Any).data ?? []).map((p: Any) => ({
      role: p.role, name: p.name ?? p.vendors?.contact_name ?? null, company: p.company ?? p.vendors?.business_name ?? null,
      email: p.email ?? p.vendors?.email ?? null, phone: p.phone ?? p.vendors?.phone ?? null, vendor_id: p.vendor_id, buyer_id: p.buyer_id,
    })),
    documents: (contractsQ as Any).data ?? [],
    open_tasks: (tasksQ as Any).data ?? [],
    recent_messages: ((commsQ as Any).data ?? []).map((c: Any) => ({ ...c, body: String(c.body ?? '').slice(0, 400) })),
  };
}

async function runTool(ctx: Ctx, name: string, args: Json): Promise<unknown> {
  const { db, ws } = ctx;

  if (name === 'find_property') {
    const pats = addressPatterns(String(args.query ?? ''));
    if (!pats.length) return { error: 'query is required' };
    const digits = String(args.query ?? '').replace(/\D/g, '');
    for (const pat of pats) {
      const ors = [`name.ilike.${pat}`, `property_address.ilike.${pat}`, `email.ilike.${pat}`];
      if (digits.length >= 7) ors.push(`phone.ilike.%${digits.slice(-7)}%`);
      const [sQ, pQ] = await Promise.all([
        db.from('sellers').select('id, name, property_address, lead_stage, property_id').eq('workspace_id', ws).is('archived_at', null).or(ors.join(',')).limit(12),
        db.from('properties').select('id, line1, city, state').eq('workspace_id', ws).ilike('line1', pat).limit(12),
      ]);
      const sellers: Any[] = sQ.data ?? [];
      const props: Any[] = pQ.data ?? [];
      const propIds = [...new Set([...props.map((p) => p.id), ...sellers.map((s) => s.property_id).filter(Boolean)])];
      const sellerIds = sellers.map((s) => s.id);
      if (!sellerIds.length && !propIds.length) continue;
      const ors2 = [sellerIds.length ? `seller_id.in.(${sellerIds.join(',')})` : null, propIds.length ? `property_id.in.(${propIds.join(',')})` : null].filter(Boolean).join(',');
      const { data: dealRows } = await db.from('deals')
        .select('id, seller_id, property_id, stage, contract_date, close_date, archived_at, properties(line1, city, state), sellers(name, property_address, lead_stage), buyers(name, company)')
        .eq('workspace_id', ws).or(ors2).order('id', { ascending: false }).limit(25);
      const deals: Any[] = dealRows ?? [];
      const { data: txRows } = deals.length
        ? await db.from('transactions').select('id, deal_id, deal_type, status, contract_date, close_date, checklist').eq('workspace_id', ws).in('deal_id', deals.map((d) => d.id))
        : { data: [] as Any[] };
      const txByDeal = new Map(((txRows ?? []) as Any[]).map((t) => [t.deal_id, t]));
      // One row per property: keyed by seller when there is one.
      const out = new Map<string, Any>();
      const keyOf = (sid: number | null, pid: number | null, did: number) => (sid ? `s${sid}` : pid ? `p${pid}` : `d${did}`);
      for (const s of sellers) out.set(`s${s.id}`, { seller_id: s.id, seller: s.name, address: s.property_address, seller_stage: s.lead_stage, deals: [] });
      for (const d of deals) {
        const k = keyOf(d.seller_id, d.property_id, d.id);
        const row = out.get(k) ?? { seller_id: d.seller_id, seller: d.sellers?.name ?? null, address: null, seller_stage: d.sellers?.lead_stage ?? null, deals: [] };
        row.address = addrOf(d.properties, row.address ?? d.sellers?.property_address);
        const tx = txByDeal.get(d.id);
        const st = tx ? fileState({ id: tx.id, address: '', seller: '', contract_date: tx.contract_date, close_date: tx.close_date ?? d.close_date, checklist: tx.checklist }, templateFor(tx.deal_type), centralDay()) : null;
        row.deals.push({
          deal_id: d.id, stage: d.stage, contract_date: d.contract_date, close_date: d.close_date, archived: !!d.archived_at,
          buyer: d.buyers ? [d.buyers.name, d.buyers.company].filter(Boolean).join(' · ') : null,
          tc_file: tx ? { transaction_id: tx.id, status: tx.status, day_marker: st?.dayMarker, critical_late: st?.overdue.filter((t) => t.critical).length ?? 0 } : null,
        });
        out.set(k, row);
      }
      for (const p of props) {
        if (deals.some((d) => d.property_id === p.id) || sellers.some((s) => s.property_id === p.id)) continue;
        out.set(`p${p.id}`, { seller_id: null, seller: null, address: addrOf(p), deals: [], note: 'a property record with no seller or deal on it' });
      }
      const matches = [...out.values()].slice(0, 10);
      return { count: matches.length, matches, searched: pat };
    }
    return { count: 0, matches: [], note: 'nothing matched; try fewer words (house number and street name), or the seller\'s name' };
  }

  if (name === 'open_property_file') {
    const sid = idOf(args.seller_id); const did = idOf(args.deal_id);
    if (!sid && !did) return { error: 'seller_id or deal_id is required: find_property first' };
    return await propertyFile(ctx, sid, did);
  }

  if (name === 'set_chat_property') {
    let sid = idOf(args.seller_id); const did = idOf(args.deal_id);
    if (!sid && !did) return { error: 'seller_id or deal_id is required' };
    let address: string | null = null;
    if (did) {
      const { data } = await db.from('deals').select('id, seller_id, properties(line1, city, state), sellers(property_address)').eq('workspace_id', ws).eq('id', did).maybeSingle();
      if (!data) return { error: `no deal ${did} in this workspace` };
      sid = sid ?? (data as Any).seller_id ?? null;
      address = addrOf((data as Any).properties, (data as Any).sellers?.property_address);
    }
    if (sid && !address) {
      const { data } = await db.from('sellers').select('id, property_address, properties(line1, city, state)').eq('workspace_id', ws).eq('id', sid).maybeSingle();
      if (!data) return { error: `no seller ${sid} in this workspace` };
      address = addrOf((data as Any).properties, (data as Any).property_address);
    }
    ctx.said = { seller_id: sid, deal_id: did, address };
    return { filed_under: address ?? `seller ${sid}` };
  }

  if (name === 'list_tc_files') {
    const { data, error } = await db.from('transactions')
      .select('id, deal_id, seller_id, deal_type, contract_date, close_date, checklist, title_company, signoff, properties(line1, city, state), sellers(name, property_address)')
      .eq('workspace_id', ws).eq('status', 'open').order('close_date', { ascending: true, nullsFirst: false }).limit(80);
    if (error) throw error;
    const today = centralDay();
    let rows = ((data ?? []) as Any[]).map((t) => {
      const st = fileState({ id: t.id, address: '', seller: '', contract_date: t.contract_date, close_date: t.close_date, checklist: t.checklist }, templateFor(t.deal_type), today);
      return {
        transaction_id: t.id, deal_id: t.deal_id, seller_id: t.seller_id,
        address: addrOf(t.properties, t.sellers?.property_address), seller: t.sellers?.name ?? null, track: t.deal_type,
        close_date: t.close_date, day_marker: st.dayMarker, days_to_close: st.daysToClose,
        late: st.overdue.length, critical_late: st.overdue.filter((x) => x.critical).map((x) => `${x.day} ${x.t}`).slice(0, 4),
        due_today: st.dueToday.map((x) => x.t).slice(0, 4), title_company: t.title_company, owner_signoff: !!t.signoff,
      };
    });
    const within = Number(args.closing_within_days);
    if (within > 0) rows = rows.filter((r) => r.days_to_close !== null && r.days_to_close <= within);
    if (args.behind_only === true) rows = rows.filter((r) => r.critical_late.length > 0);
    return { count: rows.length, files: rows.slice(0, 40) };
  }

  if (name === 'find_buyers') {
    const q = ilikeSafe(String(args.query ?? ''));
    let sel = db.from('buyers')
      .select('id, name, company, email, phone, markets, max_purchase_price, buyer_type, status, vip, notes')
      .eq('workspace_id', ws).is('blacklisted_at', null)
      .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(clamp(args.limit, 25, 8));
    if (q) sel = sel.or(`name.ilike.%${q}%,company.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    if (typeof args.market === 'string' && args.market.trim()) sel = sel.contains('markets', [args.market.trim()]);
    const { data, error } = await sel;
    if (error) throw error;
    for (const b of (data ?? []) as Any[]) card(ctx, { kind: 'buyer', id: b.id, title: b.name ?? b.company ?? 'Buyer', subtitle: [b.company, b.phone ?? b.email].filter(Boolean).join(' · ') });
    return { count: (data ?? []).length, buyers: ((data ?? []) as Any[]).map((b) => ({ ...b, notes: String(b.notes ?? '').slice(0, 300) })) };
  }

  if (name === 'find_vendors') {
    const q = ilikeSafe(String(args.query ?? ''));
    let sel = db.from('vendors')
      .select('id, business_name, contact_name, email, phone, service_type, markets, city, state, notes, is_main_poc')
      .eq('workspace_id', ws).neq('status', 'archived').order('business_name').limit(clamp(args.limit, 25, 8));
    if (q) sel = sel.or(`business_name.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    const type = ilikeSafe(String(args.service_type ?? ''));
    if (type) sel = sel.ilike('service_type', `%${type}%`);
    const { data, error } = await sel;
    if (error) throw error;
    return { count: (data ?? []).length, vendors: ((data ?? []) as Any[]).map((v) => ({ ...v, notes: String(v.notes ?? '').slice(0, 300) })) };
  }

  if (name === 'get_messages') {
    const sid = idOf(args.seller_id);
    if (!sid) return { error: 'seller_id is required' };
    let sel = db.from('communications').select('channel, direction, occurred_at, subject, body, status')
      .eq('workspace_id', ws).eq('seller_id', sid).order('occurred_at', { ascending: false }).limit(clamp(args.limit, 40, 20));
    if (typeof args.channel === 'string' && args.channel) sel = sel.eq('channel', args.channel);
    const has = ilikeSafe(String(args.contains ?? ''));
    if (has) sel = sel.ilike('body', `%${has}%`);
    const { data, error } = await sel;
    if (error) throw error;
    return { count: (data ?? []).length, messages: ((data ?? []) as Any[]).map((c) => ({ ...c, body: String(c.body ?? '').slice(0, 700) })) };
  }

  return { error: `unknown tool ${name}` };
}

// ─── Chats ───────────────────────────────────────────────────────────────────

type ChatRow = { id: number; title: string; seller_id: number | null; deal_id: number | null; address: string | null };
const CHAT_COLS = 'id, title, seller_id, deal_id, address';
const subjectOf = (c: ChatRow | null): ChatSubject | null => (c ? { seller_id: c.seller_id, deal_id: c.deal_id, address: c.address } : null);

/** The caller's latest chat about this property, or a new one. */
async function chatFor(db: SupabaseClient, ws: number, userId: string, s: ChatSubject, question: string): Promise<ChatRow | null> {
  const ors = [s.seller_id ? `seller_id.eq.${s.seller_id}` : null, s.deal_id ? `deal_id.eq.${s.deal_id}` : null].filter(Boolean).join(',');
  const { data: hit } = await db.from('lane_chats').select(CHAT_COLS)
    .eq('workspace_id', ws).eq('user_id', userId).is('archived_at', null).or(ors)
    .order('updated_at', { ascending: false }).limit(1);
  if (hit?.length) return hit[0] as ChatRow;
  const { data } = await db.from('lane_chats')
    .insert({ workspace_id: ws, user_id: userId, title: chatTitle(s, question), seller_id: s.seller_id, deal_id: s.deal_id, address: s.address })
    .select(CHAT_COLS).single();
  return (data as ChatRow) ?? null;
}

const MAX_ROUNDS = 8;

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
  if (!apiKey) return json({ error: 'Lane is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; question?: string; chat_id?: unknown; focus?: { seller_id?: unknown; deal_id?: unknown }; context?: Record<string, unknown>; history?: { role?: string; text?: string }[]; tc_name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const question = String(body.question ?? '').trim();
  if (!question) return json({ error: 'question is required' }, 422);
  if (question.length > 4000) return json({ error: 'question is too long' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `lane:${who.user.id}`, 60, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const legacy = body.context && typeof body.context === 'object' ? body.context : null;
  const tcRaw = body.tc_name ?? (legacy as { tcName?: unknown } | null)?.tcName;
  const tcName = typeof tcRaw === 'string' && tcRaw.trim() ? tcRaw.trim().slice(0, 80) : 'the TC';
  const db = asCaller;
  const userId = who.user.id;
  const ctx: Ctx = { db, ws: workspaceId, userId, said: null, cards: new Map() };

  // ── The chat this question is in. A store that cannot hold chats yet
  // (migration 182 not applied) answers from the posted history instead.
  let chat: ChatRow | null = null;
  let stored = true;
  const focusSeller = idOf(body.focus?.seller_id);
  const legacyDeal = typeof legacy?.dealId === 'string' ? idOf(String(legacy.dealId).replace(/^d/, '')) : null;
  const focusDeal = idOf(body.focus?.deal_id) ?? legacyDeal;
  const chatId = idOf(body.chat_id);
  if (chatId) {
    const { data, error } = await db.from('lane_chats').select(CHAT_COLS).eq('workspace_id', workspaceId).eq('id', chatId).maybeSingle();
    if (error) stored = false;
    else if (!data) return json({ error: 'that chat is not yours or no longer exists' }, 404);
    else chat = data as ChatRow;
  } else {
    let subject: ChatSubject | null = null;
    if (focusSeller || focusDeal) {
      const r = await runTool(ctx, 'set_chat_property', { seller_id: focusSeller, deal_id: focusDeal }) as Json;
      subject = r.error ? null : ctx.said;
      ctx.said = null;
    }
    // Opened from a record: that property's chat when there is one already.
    if (hasSubject(subject)) chat = await chatFor(db, workspaceId, userId, subject, question);
    if (!chat) {
      const { data, error } = await db.from('lane_chats')
        .insert({ workspace_id: workspaceId, user_id: userId, title: chatTitle(subject, question), seller_id: subject?.seller_id ?? null, deal_id: subject?.deal_id ?? null, address: subject?.address ?? null })
        .select(CHAT_COLS).single();
      if (error) { stored = false; console.warn('lane chats unavailable', error.message); } else chat = data as ChatRow;
    }
  }

  // ── The thread so far.
  let turns: { role: string; text: string }[] = [];
  let priorCount = 0;
  if (chat) {
    const { data } = await db.from('lane_messages').select('role, body').eq('chat_id', chat.id).order('id', { ascending: false }).limit(16);
    turns = ((data ?? []) as Any[]).reverse().map((m) => ({ role: m.role, text: m.body }));
    const { count } = await db.from('lane_messages').select('id', { count: 'exact', head: true }).eq('chat_id', chat.id);
    priorCount = count ?? turns.length;
  } else if (Array.isArray(body.history)) {
    turns = body.history.filter((t) => t && (t.role === 'tc' || t.role === 'lane') && typeof t.text === 'string' && t.text.trim()).slice(-12) as { role: string; text: string }[];
  }
  const thread: Anthropic.MessageParam[] = turns
    .map((t) => ({ role: t.role === 'tc' ? 'user' : 'assistant', content: String(t.text).slice(0, 6000) } as Anthropic.MessageParam));
  // Alternating roles starting with the user: drop a leading assistant turn
  // and merge any run of same-role turns.
  const messages: Anthropic.MessageParam[] = [];
  for (const t of thread) {
    const last = messages[messages.length - 1];
    if (!last && t.role === 'assistant') continue;
    if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`;
    else messages.push({ ...t });
  }

  // ── What this chat is about, read fresh with the question.
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TZ });
  const pinned = subjectOf(chat);
  let about = 'This chat is not about a particular property yet. If the question names one, find it.';
  if (hasSubject(pinned)) {
    const file = await propertyFile(ctx, pinned.seller_id, pinned.deal_id).catch((e) => ({ error: String(e) }));
    about = `This chat is about ${pinned.address ?? 'one property'} (seller_id ${pinned.seller_id ?? '—'}, deal_id ${pinned.deal_id ?? '—'}). Its file, read just now:\n${fence('property_file', JSON.stringify(file), 30_000)}`;
  } else if (legacy) {
    about = `The TC file on ${tcName}'s screen:\n${fence('transaction_file', JSON.stringify(legacy), 30_000)}`;
  }
  const ask = `Today is ${today} (Central).\n\n${about}\n\n${tcName} asks: ${fence('question', question, 4000)}`;
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content = `${messages[messages.length - 1].content}\n\n${ask}`;
  else messages.push({ role: 'user', content: ask });

  // ── The loop: look things up, then answer.
  let out: Json | null = null;
  let usage: unknown = null;
  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    let prose = '';
    for (let round = 0; round < MAX_ROUNDS && !out; round++) {
      const last = round === MAX_ROUNDS - 1;
      const res = await client.messages.create({
        model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
        max_tokens: 6000,
        system: systemFor(tcName),
        tools: last ? [ANSWER_TOOL] : [...LOOKUP_TOOLS, ANSWER_TOOL],
        tool_choice: { type: 'auto' },
        messages,
      });
      usage = res.usage;
      messages.push({ role: 'assistant', content: res.content });
      prose = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() || prose;
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const answerCall = calls.find((c) => c.name === 'answer');
      if (answerCall) { out = (answerCall.input ?? {}) as Json; break; }
      if (!calls.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const c of calls) {
        let content: string;
        try {
          const r = await runTool(ctx, c.name, (c.input ?? {}) as Json);
          // Row text came from sellers, title companies and imports — data, not orders.
          content = fence('records', JSON.stringify(r), 30_000);
        } catch (e) {
          console.error('lane tool', c.name, e);
          content = JSON.stringify({ error: 'that lookup failed' });
        }
        results.push({ type: 'tool_result', tool_use_id: c.id, content });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!out && prose) out = { answer: prose, refs: [], suggestions: [], drafts: [], actions: [] };
    if (!out) return json({ error: 'Lane returned no answer' }, 502);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError && /anthropic-workspace-id/.test(e.message)) return json({ error: WORKSPACE_HINT }, 503);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'lane anthropic', e, 502);
    return serverError(CORS, 'lane', e);
  }

  // ── Shape the reply.
  const TARGETS = ['commitment', 'earnest', 'deadlines', 'documents', 'checklist', 'hud', 'none'];
  const refs = (Array.isArray(out.refs) ? out.refs : [])
    .map((r) => (typeof r === 'string' ? { label: r, target: 'none' } : r))
    .filter((r): r is { label: string; target: string } => !!r && typeof (r as { label?: unknown }).label === 'string')
    .map((r) => ({ label: r.label.slice(0, 80), target: TARGETS.includes(r.target) ? r.target : 'none' }))
    .slice(0, 6);
  const suggestions = (Array.isArray(out.suggestions) ? out.suggestions : [])
    .filter((s): s is { label: string; question: string } => !!s && typeof s.label === 'string' && typeof s.question === 'string').slice(0, 3);
  const drafts = (Array.isArray(out.drafts) ? out.drafts : [])
    .filter((d): d is { to: string; channel: string; subject: string | null; body: string } => !!d && typeof d.to === 'string' && typeof d.body === 'string')
    .map((d) => ({ to: d.to, channel: ['email', 'sms', 'post'].includes(d.channel) ? d.channel : 'email', subject: typeof d.subject === 'string' ? d.subject : null, body: d.body })).slice(0, 3);
  const actions = (Array.isArray(out.actions) ? out.actions : [])
    .filter((a): a is { kind: string; title: string; due: string; notes?: string | null } => !!a && typeof (a as { title?: unknown }).title === 'string' && typeof (a as { due?: unknown }).due === 'string')
    .map((a) => ({ kind: a.kind === 'calendar' ? 'calendar' : 'task', title: a.title.slice(0, 200), due: a.due.slice(0, 16), notes: typeof a.notes === 'string' ? a.notes.slice(0, 1000) : null }))
    .slice(0, 3);
  const answer = String(out.answer ?? '').trim();
  const cards = [...ctx.cards.values()];

  // ── File it: this chat, or the property's own chat when the question
  // turned to another property.
  let movedFrom: number | null = null;
  if (stored && chat) {
    try {
      const route = routeFor({ subject: pinned, messages: priorCount }, ctx.said);
      if (route === 'pin' && ctx.said) {
        const { data } = await db.from('lane_chats')
          .update({ seller_id: ctx.said.seller_id, deal_id: ctx.said.deal_id, address: ctx.said.address, title: chatTitle(ctx.said, question) })
          .eq('id', chat.id).select(CHAT_COLS).single();
        if (data) chat = data as ChatRow;
      } else if (route === 'move' && ctx.said) {
        const target = await chatFor(db, workspaceId, userId, ctx.said, question);
        if (target && target.id !== chat.id) { movedFrom = chat.id; chat = target; }
      } else if (!hasSubject(pinned) && priorCount === 0) {
        await db.from('lane_chats').update({ title: chatTitle(null, question) }).eq('id', chat.id);
        chat = { ...chat, title: chatTitle(null, question) };
      }
      const { error } = await db.from('lane_messages').insert([
        { chat_id: chat.id, workspace_id: workspaceId, role: 'tc', body: question },
        { chat_id: chat.id, workspace_id: workspaceId, role: 'lane', body: answer, refs, drafts, actions, cards },
      ]);
      if (error) throw error;
      await db.from('lane_chats').update({ updated_at: new Date().toISOString() }).eq('id', chat.id);
    } catch (e) {
      console.error('lane save', e);
    }
  }

  return json({
    ok: true,
    answer,
    refs: refs.map((r) => r.label),
    refs_v2: refs,
    suggestions,
    drafts,
    actions,
    cards,
    chat: stored ? chat : null,
    moved_from: movedFrom,
    usage,
  });
});
