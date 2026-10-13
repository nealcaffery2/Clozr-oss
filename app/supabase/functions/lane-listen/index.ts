/**
 * POST /lane-listen — Lane reads what happened on a file and updates it.
 *
 * Every call (its transcript), text, email and note with the seller, the
 * buyer, title and anyone else on the deal team, every task completed and
 * every document filed since Lane last read the file is put in front of Lane
 * with the checklist lines still open. Lane answers with what that activity
 * settles:
 *
 *   tick       a checklist line the activity shows is done ("title emailed the
 *              commitment", "buyer's EMD hit escrow")
 *   task_done  an open CRM task the activity finished
 *   date       a date that moved (closing pushed to the 30th)
 *   task_add   something someone promised or asked for that nobody is tracking
 *   party      a title company, lender or agent the file does not have yet
 *   note       one line for the file's activity: what happened, in TC terms
 *
 * Each becomes a lane_updates row (migration 80) with the quote it rests on.
 * A high-confidence tick or task completion applies on its own — the TC can
 * undo it from the file — and everything else waits for the TC to accept.
 * transactions.lane_heard_through moves to the newest thing read, so nothing
 * is read twice and a run cut short picks up where it stopped.
 *
 * Body:
 *   { action: 'listen_all' }             the ten-minute schedule (service role):
 *                                        every open file on a live deal with
 *                                        something new since Lane last read it
 *   { action: 'listen', transaction_id } a member's "Catch Lane up" on one file
 *
 * Needs ANTHROPIC_API_KEY, like `lane`.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { type SupabaseClient, createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import { tcChecklists } from '../_shared/tc-checklists.ts';
import { DOC_LABEL, type DocType } from '../_shared/deal-docs.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

type Any = any;

const DEAD_STAGES = ['Prospect', 'Closed', 'Terminated'];
/** A first read of a file looks back this far, not to the dawn of the deal. */
const FIRST_LOOK_DAYS = 14;
/** Per file per run; the rest is read on the next run. */
const MAX_EVENTS = 40;
/** Files Lane reads per scheduled run (each is one model call); a busy afternoon catches up over a few runs. */
const MAX_FILES = 4;

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = `You are Lane, the transaction coordinator AI at Acme Homes, a real estate wholesaling, double-close and novation company. You are listening to one deal file: the calls (transcripts), texts, emails and notes with the seller, the end buyer, the title company and everyone else on the deal, plus tasks the team completed and documents that were filed. Your job is to keep the file current so the TC never has to re-read a thread to know where the deal stands.

From the new activity, report only what it actually shows:
- tick: a checklist line (by its id) the activity shows is now done. "high" only when the activity states it plainly (title's email attaches the commitment; the buyer says the EMD was wired AND title confirms receipt; the seller returned the signed info sheet). An intention, a promise, or "I'll send it tomorrow" is never a tick — that is a task_add.
- task_done: an open task (by its id) the activity finished. Same bar as a tick.
- date: a date the parties agreed moved: close_date, ctc_target, option_ends_on or emd_received_at, as YYYY-MM-DD. Only with an explicit date in the activity.
- task_add: something a party promised, requested or is waiting on that no open task or open checklist line already tracks. Short imperative title, due_in_days from today.
- party: a title company, lender, attorney, agent or other party who is clearly working this deal and is not on the deal team yet (name, company, email, phone as given in the activity; role one of title, lender, attorney, listing_agent, buyers_agent, photographer, other).
- note: at most one, one or two sentences, what happened in TC terms, only when there is something worth reading.

Every item quotes its evidence: the few words from the activity it rests on, and which event ids. Never invent a fact, a date, a name or a number that is not in the activity. When nothing new is settled, return empty lists. Activity from a seller or a buyer about another property does not count toward this file.${UNTRUSTED_RULE}`;

const TOOL: Anthropic.Tool = {
  name: 'file_updates',
  description: 'What the new activity settles on this deal file.',
  input_schema: {
    type: 'object',
    properties: {
      updates: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['tick', 'task_done', 'date', 'task_add', 'party', 'note'] },
            item_id: { type: 'string', description: 'tick: the checklist line id. task_done: the task id.' },
            field: { type: 'string', enum: ['close_date', 'ctc_target', 'option_ends_on', 'emd_received_at'], description: 'date only' },
            value: { type: 'string', description: 'date: YYYY-MM-DD. task_add: the task title. note: the note.' },
            due_in_days: { type: 'integer', minimum: 0, maximum: 60, description: 'task_add only' },
            party: {
              type: 'object',
              properties: { role: { type: 'string' }, company: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } },
              description: 'party only',
            },
            summary: { type: 'string', description: 'One short line the TC reads: "Title commitment received from Northvale Title".' },
            evidence: { type: 'string', description: 'The few words from the activity this rests on.' },
            event_ids: { type: 'array', items: { type: 'integer' }, description: 'The communication ids it comes from.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['kind', 'summary', 'evidence', 'confidence'],
        },
      },
    },
    required: ['updates'],
  },
};

type Tx = {
  id: number; workspace_id: number; deal_id: number; seller_id: number | null; deal_type: string;
  contract_date: string | null; ctc_target: string | null; close_date: string | null; option_ends_on: string | null;
  emd_received_at: string | null; checklist: Record<string, boolean> | null; lane_heard_through: string | null; created_at: string;
};

const TX_COLS = 'id, workspace_id, deal_id, seller_id, deal_type, contract_date, ctc_target, close_date, option_ends_on, emd_received_at, checklist, lane_heard_through, created_at';
const iso = (d: Date) => d.toISOString();
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, n);

/** Everything Lane needs about one file, or null when there is nothing new to hear. */
async function gather(admin: SupabaseClient, tx: Tx) {
  const { data: deal } = await admin.from('deals').select('id, stage, seller_id, buyer_id, close_date, property_id').eq('id', tx.deal_id).maybeSingle();
  if (!deal || DEAD_STAGES.includes(deal.stage)) return null;
  const floor = new Date(Date.now() - FIRST_LOOK_DAYS * 86_400_000);
  const since = tx.lane_heard_through ?? iso(new Date(Math.max(floor.getTime(), new Date(tx.contract_date ?? tx.created_at).getTime())));

  const [{ data: parties }, { data: prop }] = await Promise.all([
    admin.from('deal_parties').select('role, vendor_id, buyer_id, seller_id, user_id, name, company, email, phone').eq('deal_id', deal.id),
    deal.property_id ? admin.from('properties').select('line1, city, state').eq('id', deal.property_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const team = (parties ?? []) as Any[];
  const buyerIds = Array.from(new Set([deal.buyer_id, ...team.map((p) => p.buyer_id)].filter((x): x is number => !!x)));
  const vendorIds = Array.from(new Set(team.map((p) => p.vendor_id).filter((x): x is number => !!x)));

  const ors = [`deal_id.eq.${deal.id}`];
  if (deal.seller_id) ors.push(`seller_id.eq.${deal.seller_id}`);
  if (buyerIds.length) ors.push(`buyer_id.in.(${buyerIds.join(',')})`);
  if (vendorIds.length) ors.push(`vendor_id.in.(${vendorIds.join(',')})`);
  const { data: rawComms } = await admin.from('communications')
    .select('id, deal_id, seller_id, buyer_id, vendor_id, channel, direction, occurred_at, from_email, to_email, from_phone, to_phone, subject, body, summary, transcript, ai_notes')
    .eq('workspace_id', tx.workspace_id).or(ors.join(',')).gt('occurred_at', since)
    .order('occurred_at', { ascending: true }).limit(MAX_EVENTS * 3);

  // A partner contact or a buyer can be on many live deals; a message filed to
  // no deal only counts here when this is the one live deal they are on.
  const liveCount = async (col: 'seller_id' | 'buyer_id', id: number) => {
    const { count } = await admin.from('deals').select('id', { count: 'exact', head: true }).eq(col, id).not('stage', 'in', `(${DEAD_STAGES.map((s) => `"${s}"`).join(',')})`);
    return count ?? 0;
  };
  const sellerSolo = deal.seller_id ? (await liveCount('seller_id', deal.seller_id)) <= 1 : false;
  const buyerSolo = new Map<number, boolean>();
  for (const b of buyerIds) buyerSolo.set(b, (await liveCount('buyer_id', b)) <= 1);
  const comms = ((rawComms ?? []) as Any[]).filter((c) => {
    if (c.deal_id != null) return c.deal_id === deal.id;
    if (c.vendor_id && vendorIds.includes(c.vendor_id)) return true;
    if (c.buyer_id && buyerIds.includes(c.buyer_id)) return buyerSolo.get(c.buyer_id) ?? false;
    if (c.seller_id && c.seller_id === deal.seller_id) return sellerSolo;
    return false;
  }).slice(0, MAX_EVENTS);

  const taskOr = [`deal_id.eq.${deal.id}`, ...(deal.seller_id && sellerSolo ? [`seller_id.eq.${deal.seller_id}`] : [])].join(',');
  const [{ data: doneTasks }, { data: openTasks }, { data: files }] = await Promise.all([
    admin.from('tasks').select('id, title, completed_at').eq('workspace_id', tx.workspace_id).or(taskOr).eq('done', true).gt('completed_at', since).limit(20),
    admin.from('tasks').select('id, title, due_at').eq('workspace_id', tx.workspace_id).or(taskOr).eq('done', false).order('due_at').limit(30),
    admin.from('deal_files').select('id, name, category, source, created_at, communication_id').eq('deal_id', deal.id).gt('created_at', since).limit(20),
  ]);
  if (!comms.length && !(doneTasks ?? []).length && !(files ?? []).length) {
    return { deal, since, nothing: true as const };
  }
  const through = [
    ...comms.map((c) => c.occurred_at as string),
    ...((doneTasks ?? []) as Any[]).map((t) => t.completed_at as string),
    ...((files ?? []) as Any[]).map((f) => f.created_at as string),
  ].sort().pop()!;
  return { deal, since, nothing: false as const, prop, team, comms, doneTasks: (doneTasks ?? []) as Any[], openTasks: (openTasks ?? []) as Any[], files: (files ?? []) as Any[], through };
}

type Gathered = Exclude<Awaited<ReturnType<typeof gather>>, null | { nothing: true }>;

function who(c: Any, g: Gathered): string {
  const role = c.vendor_id ? (g.team.find((p) => p.vendor_id === c.vendor_id)?.role ?? 'vendor')
    : c.buyer_id ? 'buyer' : c.seller_id ? 'seller' : 'party';
  return `${role}${c.direction ? ' · ' + c.direction : ''}`;
}

function prompt(tx: Tx, g: Gathered): string {
  const cl = tcChecklists[tx.deal_type as keyof typeof tcChecklists] ?? tcChecklists.assignment;
  const ticked = tx.checklist ?? {};
  const open = cl.phases.flatMap((ph) => ph.tasks).filter((t) => !ticked[t.id]).map((t) => `${t.id} [${t.day} · ${t.owner}] ${t.t}`);
  const events = g.comms.map((c) => {
    const text = c.channel === 'call'
      ? (c.transcript ? `Transcript: ${clip(c.transcript, 6000)}` : `Summary: ${clip(c.summary ?? c.ai_notes?.summary ?? c.body, 1500)}`)
      : [c.subject ? `Subject: ${clip(c.subject, 200)}` : '', clip(c.body ?? c.summary, 3000)].filter(Boolean).join('\n');
    const fileNames = g.files.filter((f) => f.communication_id === c.id).map((f) => `${f.name} (${DOC_LABEL[f.category as DocType] ?? 'file'})`);
    return fence(`event_${c.id}`, `#${c.id} · ${c.channel} · ${who(c, g)} · ${c.occurred_at}${c.from_email ? ' · from ' + c.from_email : ''}${fileNames.length ? '\nAttached: ' + fileNames.join(', ') : ''}\n${text}`, 7000);
  });
  const filed = g.files.filter((f) => !f.communication_id).map((f) => `${f.name} (${DOC_LABEL[f.category as DocType] ?? 'file'}, ${f.source ?? 'upload'})`);
  const team = g.team.map((p) => `${p.role}: ${[p.name, p.company, p.email, p.phone].filter(Boolean).join(' · ')}`);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  return [
    `Today is ${today} (Central).`,
    `Deal: ${g.prop ? [g.prop.line1, g.prop.city, g.prop.state].filter(Boolean).join(', ') : 'deal ' + tx.deal_id} · ${tx.deal_type} · stage ${g.deal.stage}`,
    `Dates on file: contract ${tx.contract_date ?? '—'} · CTC target ${tx.ctc_target ?? '—'} · close ${tx.close_date ?? g.deal.close_date ?? '—'} · option ends ${tx.option_ends_on ?? '—'} · EMD received ${tx.emd_received_at ?? '—'}`,
    `Deal team:\n${fence('deal_team', team.join('\n') || '(none)', 3000)}`,
    `Open checklist lines (id [day · owner] text):\n${open.join('\n') || '(all done)'}`,
    `Open tasks (id · title):\n${fence('open_tasks', g.openTasks.map((t) => `${t.id} · ${t.title}`).join('\n') || '(none)', 3000)}`,
    g.doneTasks.length ? `Tasks the team completed since last read:\n${fence('done_tasks', g.doneTasks.map((t) => `${t.id} · ${t.title}`).join('\n'), 2000)}` : '',
    filed.length ? `Documents filed since last read (not from an email):\n${fence('filed', filed.join('\n'), 2000)}` : '',
    `New activity since ${g.since}, oldest first:\n${events.join('\n\n') || '(no messages)'}`,
  ].filter(Boolean).join('\n\n');
}

async function listen(admin: SupabaseClient, client: Anthropic, tx: Tx) {
  const g0 = await gather(admin, tx);
  if (!g0) return { tx: tx.id, skipped: 'deal not live' };
  if (g0.nothing) return { tx: tx.id, heard: 0 };
  const g = g0 as Gathered;

  const res = await client.messages.create({
    model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 3000, system: toolRule('file_updates') + SYSTEM,
    tools: [TOOL], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: prompt(tx, g) }],
  });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const updates = ((call?.input as Any)?.updates ?? []) as Any[];

  const cl = tcChecklists[tx.deal_type as keyof typeof tcChecklists] ?? tcChecklists.assignment;
  const lines = new Map(cl.phases.flatMap((ph) => ph.tasks).map((t) => [t.id, t.t]));
  const openTaskIds = new Map(g.openTasks.map((t) => [String(t.id), t.title as string]));
  const commIds = new Set(g.comms.map((c) => c.id as number));
  const checklist = { ...(tx.checklist ?? {}) };
  const rows: Any[] = [];
  const now = iso(new Date());

  for (const u of updates) {
    const confidence = ['high', 'medium', 'low'].includes(u.confidence) ? u.confidence : 'medium';
    if (confidence === 'low') continue;
    const base = {
      workspace_id: tx.workspace_id, transaction_id: tx.id, deal_id: tx.deal_id, seller_id: tx.seller_id ?? g.deal.seller_id,
      summary: clip(u.summary, 300), evidence: clip(u.evidence, 600) || null, confidence,
      source_comm_ids: (Array.isArray(u.event_ids) ? u.event_ids : []).map(Number).filter((n: number) => commIds.has(n)),
    };
    if (u.kind === 'tick') {
      const id = String(u.item_id ?? '');
      if (!lines.has(id) || checklist[id]) continue;
      const auto = confidence === 'high';
      if (auto) checklist[id] = true;
      rows.push({ ...base, kind: 'tick', payload: { item_id: id, label: lines.get(id) }, status: auto ? 'applied' : 'pending', decided_at: auto ? now : null });
    } else if (u.kind === 'task_done') {
      const id = String(u.item_id ?? '');
      if (!openTaskIds.has(id)) continue;
      const auto = confidence === 'high';
      if (auto) await admin.from('tasks').update({ done: true, completed_at: now }).eq('id', Number(id));
      rows.push({ ...base, kind: 'task_done', payload: { task_id: Number(id), title: openTaskIds.get(id) }, status: auto ? 'applied' : 'pending', decided_at: auto ? now : null });
    } else if (u.kind === 'date') {
      if (!['close_date', 'ctc_target', 'option_ends_on', 'emd_received_at'].includes(u.field) || !/^\d{4}-\d{2}-\d{2}$/.test(String(u.value ?? ''))) continue;
      rows.push({ ...base, kind: 'date', payload: { field: u.field, value: u.value } });
    } else if (u.kind === 'task_add') {
      const title = clip(u.value, 200);
      if (!title) continue;
      rows.push({ ...base, kind: 'task_add', payload: { title, due_in_days: Math.max(0, Math.min(60, Number(u.due_in_days ?? 1))) } });
    } else if (u.kind === 'party') {
      const p = u.party ?? {};
      if (!p.company && !p.name) continue;
      const role = ['title', 'lender', 'attorney', 'listing_agent', 'buyers_agent', 'photographer', 'other'].includes(p.role) ? p.role : 'other';
      const email = clip(p.email, 200).toLowerCase() || null;
      // An address that is already a vendor becomes that vendor, so accepting links the directory row.
      const { data: v } = email ? await admin.from('vendors').select('id').eq('workspace_id', tx.workspace_id).ilike('email', `%${email}%`).limit(1).maybeSingle() : { data: null };
      rows.push({ ...base, kind: 'party', payload: { role, company: clip(p.company, 200) || null, name: clip(p.name, 200) || null, email, phone: clip(p.phone, 40) || null, vendor_id: v?.id ?? null } });
    } else if (u.kind === 'note') {
      const text = clip(u.value || u.summary, 600);
      if (!text) continue;
      rows.push({ ...base, kind: 'note', payload: { text }, status: 'applied', decided_at: now });
    }
  }

  // Claim the read before writing anything: a manual "Catch Lane up" and the
  // schedule landing on the same file together must not both file the same updates.
  let claim = admin.from('transactions').update({ lane_heard_through: g.through, updated_at: now }).eq('id', tx.id);
  claim = tx.lane_heard_through ? claim.eq('lane_heard_through', tx.lane_heard_through) : claim.is('lane_heard_through', null);
  const { data: claimed } = await claim.select('id');
  if (!claimed?.length) return { tx: tx.id, skipped: 'another run read this file' };

  const ticked = rows.filter((r) => r.kind === 'tick' && r.status === 'applied');
  if (ticked.length) {
    // Merge onto the checklist as it is now, not as it was when Lane started reading: a TC tick in between survives.
    const { data: fresh } = await admin.from('transactions').select('checklist').eq('id', tx.id).maybeSingle();
    const merged = { ...((fresh?.checklist as Record<string, boolean>) ?? {}), ...Object.fromEntries(ticked.map((r) => [r.payload.item_id, true])) };
    await admin.from('transactions').update({ checklist: merged }).eq('id', tx.id);
  }
  if (rows.length) {
    // Rows differ in their keys (only some carry status); a key one row leaves
    // out takes the column default, not null.
    const { error } = await admin.from('lane_updates').insert(rows, { defaultToNull: false });
    if (error) throw new Error('lane_updates insert: ' + error.message);
  }

  // One line on the file's activity, so the People record and the TC feed show what Lane heard.
  const sellerId = tx.seller_id ?? g.deal.seller_id;
  if (rows.length && sellerId) {
    const applied = rows.filter((r) => r.status === 'applied' && r.kind !== 'note');
    const pending = rows.filter((r) => r.status === 'pending');
    const note = rows.find((r) => r.kind === 'note')?.payload.text;
    await admin.from('activity').insert({
      workspace_id: tx.workspace_id, entity_type: 'seller', entity_id: sellerId, kind: 'tc',
      title: `Lane · ${[applied.length ? applied.length + ' updated' : '', pending.length ? pending.length + ' to review' : ''].filter(Boolean).join(' · ') || 'heard the file'}`,
      body: [note, ...applied.map((r) => '✓ ' + r.summary), ...pending.map((r) => '? ' + r.summary)].filter(Boolean).join('\n').slice(0, 2000),
      occurred_at: now,
    });
  }
  return { tx: tx.id, heard: g.comms.length, updates: rows.length, applied: rows.filter((r) => r.status === 'applied').length };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Lane is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);
  const client = new Anthropic({ apiKey, ...anthropicHeaders() });

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

  try {
    if (b.action === 'listen_all') {
      if (!(await isServiceCaller(admin, bearer))) return json({ error: 'listen_all is for the service role' }, 403);
      const { data: txs } = await admin.from('transactions').select(TX_COLS).eq('status', 'open')
        .order('lane_heard_through', { ascending: true, nullsFirst: true }).limit(200);
      const out: Any[] = [];
      let worked = 0;
      for (const tx of (txs ?? []) as Tx[]) {
        if (worked >= MAX_FILES) break;
        try {
          const r = await listen(admin, client, tx);
          out.push(r);
          if ('updates' in r) worked++;
        } catch (err) {
          console.error('lane-listen file failed', { tx: tx.id, err: String(err) });
          out.push({ tx: tx.id, error: true });
        }
      }
      return json({ ok: true, files: out });
    }

    if (b.action === 'listen') {
      const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
      const { data: who } = await asCaller.auth.getUser();
      if (!who?.user) return json({ error: 'sign in first' }, 401);
      const id = Number(b.transaction_id);
      if (!Number.isFinite(id)) return json({ error: 'transaction_id is required' }, 422);
      // Read as the caller: RLS answers whether they may see this file at all.
      const { data: mine } = await asCaller.from('transactions').select('id').eq('id', id).maybeSingle();
      if (!mine) return json({ error: 'no such file' }, 404);
      const rl = await rateLimit(admin, `lane-listen:${who.user.id}`, 30, 3600);
      if (!rl.allowed) return tooMany(CORS, rl);
      const { data: tx } = await admin.from('transactions').select(TX_COLS).eq('id', id).maybeSingle();
      if (!tx) return json({ error: 'no such file' }, 404);
      return json({ ok: true, ...(await listen(admin, client, tx as Tx)) });
    }

    return json({ error: 'unknown action' }, 422);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    return serverError(CORS, 'lane-listen', e);
  }
});
