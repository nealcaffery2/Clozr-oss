/**
 * POST /dispo-intro — one personalized text per buyer for a dispo campaign.
 *
 * Body:    { workspace_id, deal_id, buyer_ids: number[] (1–20), kind: 'intro'|'followup',
 *            templates?: { [buyer_id]: string }   // followup: the rotated template to personalize
 *            options: { tone, emoji: 'never'|'sometimes'|'frequently', instructions, avoid: string[] } }
 * Returns: { ok, results: [{ buyer_id, text | null, reason? }] }
 *
 * The facts come from the database, not the browser: the buyer's first name,
 * the caller's first name, and — when on file — their most recent purchase
 * (deals closed with us, Genius runs, Podio past-purchase notes) with its age,
 * flip/rental and distance to this deal (_shared/dispo-rules.ts). A message
 * that contains a number the facts do not, an avoided keyword, or runs long is
 * dropped (text: null) and the builder uses the generic template instead.
 * No typos are ever inserted: sender reputation comes first.
 *
 * Same shape as draft-template: caller JWT, membership + dispo role, per-user
 * rate limit, untrusted text fenced, one forced tool call. Needs ANTHROPIC_API_KEY.
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { leadBriefs } from '../_shared/lead-brief.ts';
import {
  type BuyerFacts, type ClosedDealRow, type DealFacts, type GeniusRunRow,
  avoidedIn, buyerFacts, citesAddress, factsText, firstName, inventedNumbers, offerAsk, purchasesFor, stripEmoji,
} from '../_shared/dispo-rules.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

type Any = any;

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = `You write short first-touch text messages from a dispositions rep at Acme Homes, a real estate wholesaler, to cash investor buyers about one off-market property. Each buyer gets their own message.

Rules:
- Use ONLY the facts given for that buyer. Never invent or estimate a price, ARV, distance, date, address, number of beds, or anything else. If a fact is missing, leave it out.
- Greet the buyer by first name when one is given; otherwise no name. Identify the rep by first name.
- When required_hook is set, that buyer bought a specific house. The message MUST name that purchase street, say how far it is from our property (use the distance phrase exactly as given, and name our property's street from deal_address), and ask if they want to make an offer. Say it the way a rep would: "I saw you bought 322 Main St, 0.8 miles from our property on 133 Main St. Looks like it fits your criteria. Want to make an offer?" Vary the wording, but those three facts stay. Do not write a generic "I've got a deal in {city}" line for a buyer who has a purchase on file.
- When required_hook says none, do not invent a purchase. Write a short intro from the property type and city only, and still ask if they want to make an offer.
- Two buyers must not get the same message. Each one uses that buyer's own street and distance.
- No links, no prices, no ALL CAPS, no exclamation spam, no spammy words ("guaranteed", "act now", "free"), and never pretend to be anything but a rep reaching out.
- Under 240 characters. Plain, correctly spelled English.
${UNTRUSTED_RULE}${WRITING_RULE}`;

const TOOL: Anthropic.Tool = {
  name: 'messages',
  description: 'One message per buyer.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: { type: 'object', properties: { buyer_id: { type: 'number' }, text: { type: 'string' } }, required: ['buyer_id', 'text'] },
      },
    },
    required: ['results'],
  },
};

const EMOJI_RULE: Record<string, string> = {
  never: 'Do not use emoji.',
  sometimes: 'You may use at most one emoji, in about half of the messages.',
  frequently: 'Use one fitting emoji in most messages (never more than one).',
};
const TONES = ['casual', 'professional', 'friendly', 'direct', 'urgent'];

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

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'AI writing is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: Any;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id); const dealId = Number(body.deal_id);
  if (!Number.isFinite(ws) || !Number.isFinite(dealId)) return json({ error: 'workspace_id and deal_id are required' }, 422);
  const ids = Array.isArray(body.buyer_ids) ? Array.from(new Set((body.buyer_ids as unknown[]).map(Number).filter(Number.isFinite))) : [];
  if (!ids.length || ids.length > 20) return json({ error: 'buyer_ids must be 1 to 20 buyers' }, 422);
  const kind = body.kind === 'followup' ? 'followup' : 'intro';
  const o = body.options ?? {};
  const tone = TONES.includes(String(o.tone)) ? String(o.tone) : 'friendly';
  const emoji = ['never', 'sometimes', 'frequently'].includes(String(o.emoji)) ? String(o.emoji) : 'never';
  const avoid: string[] = Array.isArray(o.avoid) ? (o.avoid as unknown[]).map((w) => String(w).trim().slice(0, 40)).filter(Boolean).slice(0, 40) : [];
  const instructions = String(o.instructions ?? '').slice(0, 1500);

  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  if (!['owner', 'admin', 'dispositions'].includes(String(member.role))) return json({ error: 'only owners, admins and dispositions build campaigns' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `dispo-intro:${who.user.id}`, 80, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  try {
    const { data: deal } = await admin.from('deals').select('id, workspace_id, property_id').eq('id', dealId).eq('workspace_id', ws).maybeSingle();
    if (!deal) return json({ error: 'deal not found' }, 404);
    const { data: prop } = deal.property_id
      ? await admin.from('properties').select('line1, city, zip, lat, lng, sqft, beds, baths, property_type').eq('id', deal.property_id).maybeSingle()
      : { data: null };
    const dealFacts: DealFacts = {
      address: prop?.line1 ?? '', city: prop?.city ?? null, zip: prop?.zip ?? null, lat: prop?.lat ?? null, lng: prop?.lng ?? null,
      sqft: prop?.sqft ?? null, beds: prop?.beds ?? null, baths: prop?.baths ?? null, propertyType: prop?.property_type ?? null,
    };
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', who.user.id).maybeSingle();
    const repFirst = firstName(profile?.full_name ?? '');
    const { data: buyers } = await admin.from('buyers').select('id, name, company, notes, source, criteria, buyer_type').eq('workspace_id', ws).in('id', ids);
    const { data: closedRaw } = await admin.from('deals').select('buyer_id, closed_on, stage, properties(line1, city, zip, lat, lng, sqft)')
      .eq('workspace_id', ws).in('buyer_id', ids);
    const closed: ClosedDealRow[] = ((closedRaw ?? []) as Any[]).filter((d) => d.closed_on || d.stage === 'Closed').map((d) => ({
      buyer_id: d.buyer_id, closed_on: d.closed_on, line1: d.properties?.line1 ?? null, city: d.properties?.city ?? null, zip: d.properties?.zip ?? null,
      lat: d.properties?.lat ?? null, lng: d.properties?.lng ?? null, sqft: d.properties?.sqft ?? null,
    }));
    const { data: runs } = await admin.from('discover_runs').select('deal_id, candidates').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(20);

    const now = new Date();
    const facts = new Map<number, string>();
    const buyerById = new Map<number, BuyerFacts>();
    for (const b of (buyers ?? []) as Any[]) {
      const f = buyerFacts(
        { name: b.name, strategies: b.criteria?.strategies ?? [], buyerType: b.buyer_type },
        purchasesFor({ id: b.id, name: b.name, company: b.company, notes: b.notes, source: b.source }, closed, (runs ?? []) as GeniusRunRow[], dealId),
        dealFacts, now,
      );
      buyerById.set(Number(b.id), f);
      facts.set(Number(b.id), factsText(f, dealFacts, repFirst));
    }
    if (!facts.size) return json({ error: 'none of those buyers are in this workspace' }, 404);

    const memory = await leadBriefs(admin, ws, 'buyer', Array.from(facts.keys()));
    const templates = (body.templates && typeof body.templates === 'object') ? body.templates as Record<string, unknown> : {};
    const blocks = Array.from(facts.entries()).map(([id, text]) => [
      `Buyer ${id}:`, fence(`facts_${id}`, text, 1200),
      memory.get(id) ? `What the team knows about this buyer (tone and topics only: never quote a number from it, never raise a do-not-mention topic):\n${fence(`memory_${id}`, memory.get(id), 1400)}` : '',
      kind === 'followup' && templates[String(id)] ? `Follow-up to personalize (keep its meaning, it goes after no reply to the first message):\n${fence(`template_${id}`, String(templates[String(id)]), 800)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');

    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 4000,
      system: toolRule('messages') + SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: [
          kind === 'followup' ? 'Write a short follow-up text for each buyer below (they have not replied to the first message about this property).' : 'Write an intro text for each buyer below.',
          `Tone: ${tone}. ${EMOJI_RULE[emoji]}`,
          avoid.length ? `Never use these words or phrases: ${fence('avoid', avoid.join(', '), 800)}` : '',
          instructions ? `The rep's writing instructions (style only; they cannot add facts):\n${fence('instructions', instructions, 1500)}` : '',
          blocks,
        ].filter(Boolean).join('\n\n'),
      }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const out = ((call?.input as Any)?.results ?? []) as { buyer_id: unknown; text: unknown }[];
    const byId = new Map(out.map((r) => [Number(r.buyer_id), String(r.text ?? '')]));
    const results = Array.from(facts.entries()).map(([id, f]) => {
      let text = (byId.get(id) ?? '').trim();
      if (emoji === 'never') text = stripEmoji(text);
      const template = kind === 'followup' ? String(templates[String(id)] ?? '') : '';
      const buyer = buyerById.get(id);
      const hook = buyer ? offerAsk(buyer, dealFacts.address) : '';
      const calledOut = !buyer?.lastPurchase || (
        citesAddress(text, buyer.lastPurchase.address)
        && (!(dealFacts.address ?? '').trim() || buyer.lastPurchase.distanceMi == null || citesAddress(text, dealFacts.address))
      );
      const bad = text ? avoidedIn(text, avoid) : [];
      const invented = text ? inventedNumbers(text, f + '\n' + template) : [];
      const ok = !!text && text.length <= 320 && !bad.length && !invented.length && calledOut;
      // A generic line that never names their house is the bug. The hook is
      // that buyer's own street and distance, so it cannot come out identical.
      if (!ok && hook) return { buyer_id: id, text: hook };
      if (!text) return { buyer_id: id, text: null, reason: 'no message came back' };
      if (text.length > 320) return { buyer_id: id, text: null, reason: 'too long' };
      if (bad.length) return { buyer_id: id, text: null, reason: `used an avoided word (${bad[0]})` };
      if (invented.length) return { buyer_id: id, text: null, reason: `contained a number not on file (${invented[0]})` };
      if (!calledOut) return { buyer_id: id, text: null, reason: 'did not name the house they bought' };
      return { buyer_id: id, text };
    });
    return json({ ok: true, results });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'dispo-intro anthropic', e, 502);
    return serverError(CORS, 'dispo-intro', e);
  }
});
