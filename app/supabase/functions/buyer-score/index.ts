/**
 * POST /buyer-score: a buyer's response rate and a 0-100 score with a short
 * reason, read from their whole history: texts, emails, calls, deal sends,
 * offers and closed deals.
 *
 * Body:    { workspace_id, buyer_ids: number[] (max 20), force?: boolean }
 * Returns: { scores: { [buyer_id]: Score }, ai: boolean, skipped: number, message? }
 *
 * History is read as the caller (RLS), so a rep who cannot see buyers scores
 * nothing. The result is cached in buyer_scores (migration 106) by the service
 * role. A cached score is reused until it is 7 days old or the buyer has new
 * history since it was computed; force skips that check.
 *
 * The rule score (answered touches over outbound touches, offers, closings,
 * recency) is always computed. Claude refines it when ANTHROPIC_API_KEY is
 * set; without the key, or when a call fails, the rule score is stored with
 * source 'rule' and the reply says why.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { ruleScore, type History } from '../_shared/buyer-score-rule.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

const TTL_MS = 7 * 864e5;
const MODEL = CLAUDE_MODEL;

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = `You score a real-estate cash buyer for a wholesaling team's dispositions desk, from the buyer's communication history with the team.

Return:
- response_rate: 0-100, the share of the team's outbound touches (texts, emails, calls, deal blasts) the buyer actually answered. Start from the computed counts you are given. Do not count auto-replies, STOP/unsubscribe messages or "wrong number" as answers. Use null only when nothing was ever sent.
- score: 0-100, how worth the team's time this buyer is right now. Weigh closed deals most, then offers made, then genuine engagement (questions about a property, asking for more deals), then recency. A buyer who closed with the team recently is 80+. Someone who never answers is under 20. Someone who answers but never offers is a tire kicker, 30-50.
- reason: one short sentence (under 140 characters) a rep reads on hover. Cite the concrete facts ("Closed 2 deals, last in June; answers most texts within a day"). No filler.${UNTRUSTED_RULE}`;

const TOOL: Anthropic.Tool = {
  name: 'score_buyer',
  description: 'The buyer score.',
  input_schema: {
    type: 'object',
    properties: {
      response_rate: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      reason: { type: 'string' },
    },
    required: ['response_rate', 'score', 'reason'],
  },
};

type Score = { response_rate: number | null; score: number; reason: string; source: 'ai' | 'rule'; computed_at: string; stats?: Record<string, unknown> | null };

// deno-lint-ignore no-explicit-any
type Any = any;

async function history(db: SupabaseClient, ws: number, buyerId: number): Promise<History | null> {
  const [b, comms, offers, deals, matches] = await Promise.all([
    db.from('buyers').select('id, name, company, status, buyer_type, created_at, vip, vetted_at').eq('id', buyerId).eq('workspace_id', ws).maybeSingle(),
    db.from('communications').select('channel, direction, occurred_at, created_at, body, summary, subject, status')
      .eq('workspace_id', ws).eq('buyer_id', buyerId).order('occurred_at', { ascending: false }).limit(400),
    db.from('offers').select('amount, status, sent_at, direction, responded_at').eq('workspace_id', ws).eq('buyer_id', buyerId).limit(200),
    db.from('deals').select('stage, closed_on, close_date, sold_price').eq('workspace_id', ws).eq('buyer_id', buyerId).limit(100),
    db.from('deal_buyer_matches').select('status, sent_at, viewed_at, replied_at').eq('workspace_id', ws).eq('buyer_id', buyerId).limit(500),
  ]);
  if (!b.data) return null;
  return {
    buyer: b.data as Any,
    comms: (comms.data ?? []) as Any[],
    offers: (offers.data ?? []) as Any[],
    deals: (deals.data ?? []) as Any[],
    matches: (matches.data ?? []) as Any[],
  };
}

/** Newest timestamp anywhere in the history, so a cached score knows it is behind. */
function latest(h: History): number {
  // created_at too: an import lands old messages (occurred_at in the past)
  // after a score was computed, and the score has to see them.
  const ts = [
    ...h.comms.flatMap((c) => [c.occurred_at, (c as { created_at?: string }).created_at]), ...h.offers.flatMap((o) => [o.sent_at, o.responded_at]),
    ...h.matches.flatMap((m) => [m.sent_at, m.replied_at]), ...h.deals.flatMap((d) => [d.closed_on]),
  ].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : 0;
}

async function aiScore(client: Anthropic, h: History, rule: ReturnType<typeof ruleScore>): Promise<{ response_rate: number | null; score: number; reason: string }> {
  const thread = h.comms.slice(0, 80).reverse().map((c) =>
    `[${String(c.occurred_at ?? '').slice(0, 10)}] ${c.channel} ${c.direction === 'inbound' ? 'BUYER' : 'TEAM'}${c.status ? ` (${c.status})` : ''}: ${String(c.body ?? c.summary ?? c.subject ?? '').replace(/\s+/g, ' ').slice(0, 280)}`,
  ).join('\n');
  const facts = {
    buyer: { name: h.buyer.name, company: h.buyer.company, status: h.buyer.status, type: h.buyer.buyer_type, added: h.buyer.created_at, vip: h.buyer.vip, vetted: !!h.buyer.vetted_at },
    computed: rule.stats,
    offers: h.offers.slice(0, 30).map((o) => ({ amount: o.amount, status: o.status, at: o.sent_at, direction: o.direction })),
    deals: h.deals.map((d) => ({ stage: d.stage, closed_on: d.closed_on ?? d.close_date, price: d.sold_price })),
  };
  const res = await client.messages.create({
    model: MODEL, thinking: CLAUDE_THINKING,
    max_tokens: 400,
    system: toolRule('score_buyer') + SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: `Today: ${new Date().toISOString().slice(0, 10)}.\n\nFacts:\n${JSON.stringify(facts, null, 1)}\n\nMessages, oldest first (the newest 80):\n${fence('messages', thread || '(none)', 30_000)}`,
    }],
  });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const out = (call?.input ?? {}) as { response_rate?: unknown; score?: unknown; reason?: unknown };
  const clamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
  const score = clamp(out.score);
  const reason = typeof out.reason === 'string' ? out.reason.trim().slice(0, 240) : '';
  if (score == null || !reason) throw new Error('model returned no score');
  // The model may only lower or raise the counted rate, never blank it: when
  // touches were sent there is a rate, and null would read as "nothing sent".
  const rate = clamp(out.response_rate) ?? rule.response_rate;
  return { response_rate: rate, score, reason };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  let body: { workspace_id?: number; buyer_ids?: unknown; force?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id);
  const ids = [...new Set((Array.isArray(body.buyer_ids) ? body.buyer_ids : []).map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 20);
  if (!Number.isFinite(ws) || !ids.length) return json({ error: 'workspace_id and buyer_ids are required' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `buyer-score:${who.user.id}`, 600, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const client = apiKey ? new Anthropic({ apiKey, ...anthropicHeaders() }) : null;
  let message: string | undefined = client ? undefined : 'AI scoring is off: set the ANTHROPIC_API_KEY secret on the Supabase project. Showing reply-based scores.';

  try {
    const { data: cached, error: cacheErr } = await admin.from('buyer_scores').select('buyer_id, response_rate, score, reason, source, computed_at, stats')
      .eq('workspace_id', ws).in('buyer_id', ids);
    if (cacheErr && /does not exist|schema cache/i.test(cacheErr.message)) {
      return json({ error: 'Buyer scores are not set up: apply migration 106 (buyer_scores) to the database.' }, 503);
    }
    const cache = new Map((cached ?? []).map((r: Any) => [r.buyer_id as number, r]));
    const scores: Record<number, Score> = {};
    let skipped = 0;
    let aiFailed = 0;

    for (const id of ids) {
      const h = await history(asCaller, ws, id);
      if (!h) { skipped++; continue; }
      const prev = cache.get(id);
      const prevAt = Date.parse(prev?.computed_at ?? '');
      const fresh = prev && Date.now() - prevAt < TTL_MS && latest(h) <= prevAt
        // A rule score is refreshed as soon as AI can do better.
        && (prev.source === 'ai' || !client);
      if (fresh && !body.force) {
        scores[id] = { response_rate: prev.response_rate, score: prev.score, reason: prev.reason, source: prev.source, computed_at: prev.computed_at, stats: prev.stats ?? null };
        continue;
      }
      const rule = ruleScore(h);
      let out: Score = { response_rate: rule.response_rate, score: rule.score, reason: rule.reason, source: 'rule', computed_at: new Date().toISOString(), stats: rule.stats };
      if (client) {
        try {
          const ai = await aiScore(client, h, rule);
          out = { ...ai, source: 'ai', computed_at: out.computed_at, stats: rule.stats };
        } catch (e) {
          aiFailed++;
          if (e instanceof Anthropic.AuthenticationError) message = 'The ANTHROPIC_API_KEY secret was rejected. Showing reply-based scores.';
          else if (e instanceof Anthropic.RateLimitError) message = 'AI scoring is rate limited right now. Showing reply-based scores; try Refresh in a minute.';
          else console.error('buyer-score ai', String(e));
        }
      }
      await admin.from('buyer_scores').upsert({
        buyer_id: id, workspace_id: ws, response_rate: out.response_rate, score: out.score, reason: out.reason,
        source: out.source, model: out.source === 'ai' ? MODEL : null, stats: rule.stats, computed_at: out.computed_at,
      }, { onConflict: 'buyer_id' });
      scores[id] = out;
    }
    if (aiFailed && !message) message = `AI scoring failed on ${aiFailed} buyer${aiFailed === 1 ? '' : 's'}; those show reply-based scores.`;
    return json({ scores, ai: !!client, skipped, ...(message ? { message } : {}) });
  } catch (e) {
    return serverError(CORS, 'buyer-score', e);
  }
});
