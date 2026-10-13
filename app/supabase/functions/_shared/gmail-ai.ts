// The AI fallback for mail the rules in gmail-match.ts could not file: a
// buyer, title company or lender on several deals writing without naming a
// street. The model picks one of those deals or none; anything else it says
// is discarded (pickFromAi). Without ANTHROPIC_API_KEY, or on any failure,
// this answers null and the rules' result stands, so the sync never waits on
// or breaks because of it.
import { WRITING_RULE } from './no-ai-slop.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { type DealRef, pickFromAi } from './gmail-match.ts';
import { fence, UNTRUSTED_RULE } from './security.ts';
import { CLAUDE_MODEL } from './models.ts';

const MODEL = CLAUDE_MODEL;
/** Per sync run: the mail that needs it is rare, and a backlog drains over the next runs. */
export const AI_PER_RUN = 10;

const SYSTEM = `You file real-estate deal email into the right deal folder of a wholesaling CRM.
You get one email and the deals its sender or recipients are on. Pick the deal the email is about.
Answer null when the email does not clearly concern exactly one of the listed deals; a wrong folder is worse than none.`;

const SCHEMA = {
  type: 'object',
  properties: { deal_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
  required: ['deal_id'],
  additionalProperties: false,
};

export type AiMessage = { subject: string; from: string; to: string[]; text: string };

export function aiKey(): string | null {
  return Deno.env.get('ANTHROPIC_API_KEY') || null;
}

export async function classifyDeal(apiKey: string | null, msg: AiMessage, candidates: DealRef[]): Promise<number | null> {
  if (!apiKey || candidates.length < 2) return null;
  try {
    const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
    const client = new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
    const list = candidates.slice(0, 25).map((d) => `${d.id}: ${d.label || d.street || 'deal ' + d.id}`).join('\n');
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM + UNTRUSTED_RULE + WRITING_RULE,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: `Deals (id: property):\n${list}\n\nEmail:\n${fence('email', `From: ${msg.from}\nTo: ${msg.to.join(', ')}\nSubject: ${msg.subject}\n\n${msg.text}`, 6000)}`,
      }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return pickFromAi(text, candidates);
  } catch (err) {
    console.error('gmail ai route failed', String(err));
    return null;
  }
}
