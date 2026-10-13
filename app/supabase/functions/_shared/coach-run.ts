// One Anthropic call that returns the coaching scorecard. Shared by call-coach
// (on demand, and the hang-up) and call-sync (once the recording transcript lands).
import { WRITING_RULE } from './no-ai-slop.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import {
  COACHING_SYSTEM, COACHING_TOOL, buildReview, type CallCoachingReview, type CoachingSource,
} from '../../../lib/call-coaching.ts';
import { fence, UNTRUSTED_RULE } from './security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from './models.ts';

const MODEL = CLAUDE_MODEL;

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

export async function coachTranscript(opts: {
  apiKey: string;
  transcript: string;
  repName: string;
  prospectName: string;
  source: CoachingSource;
  talk: { rep: number; prospect: number } | null;
  /** The transcript as "[n] m:ss Rep: text" lines (lib/call-media.ts segmentsForPrompt), so insights carry times. */
  timeline?: string | null;
  /** Call length in seconds; a call under a minute gets no missed-deal flags. */
  durationS?: number | null;
  /** False on a buyer call. */
  sellerCall?: boolean;
  /** "Submit a call for review": what kind of call this is (lib/sales-framework.ts CALL_TYPES), one line for the prompt. */
  callTypePrompt?: string | null;
}): Promise<CallCoachingReview> {
  const client = new Anthropic({ apiKey: opts.apiKey, ...anthropicHeaders() });
  const split = opts.talk
    ? `Talk split, already measured, use it and do not invent another: prospect ${opts.talk.prospect}, rep ${opts.talk.rep}.`
    : 'Speaker labels were not clear. Estimate prospect_talk as the prospect share of the words, 0 to 100.';
  const user = `${opts.callTypePrompt ? opts.callTypePrompt + '\n' : ''}Rep first name: ${opts.repName}\nProspect first name: ${opts.prospectName}\n${split}\n\nTranscript${opts.timeline ? ', one line per turn with its time' : ''}:\n${fence('transcript', opts.timeline || opts.transcript, 24_000)}`;

  let lastError = 'Scorecard was empty.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.create({
      model: MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 4000,
      system: toolRule('scorecard') + COACHING_SYSTEM + UNTRUSTED_RULE + WRITING_RULE,
      tools: [COACHING_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: attempt === 0 ? user : user + `\n\nYour last scorecard was rejected: ${lastError} Send a clean one.` }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const built = buildReview(call?.input, {
      repName: opts.repName,
      prospectName: opts.prospectName,
      talk: opts.talk,
      durationS: opts.durationS ?? null,
      sellerCall: opts.sellerCall,
    });
    if (built.ok) {
      return { ...built.review, model: MODEL, source: opts.source, scored_at: new Date().toISOString() };
    }
    lastError = built.error;
  }
  throw new Error(lastError);
}
