// The one Claude model every function uses, so a switch is one line.
export const CLAUDE_MODEL = "claude-sonnet-5-5";

// Sonnet 5.5 rejects a forced tool_choice (any / tool) with a 400, so a
// function that needs a single tool call asks for it in the system prompt and
// sends tool_choice auto instead.
export const toolRule = (name: string) => `Always reply by calling the ${name} tool, never with plain text.\n\n`;

// A system prompt as one block with a prompt-cache marker. Tools render before
// the system prompt, so the marker covers both. Batch jobs (lead memory, the
// AI agent's next touch, reply suggestions) send the same system text dozens of
// times a minute, and every call after the first reads it at a tenth of the
// input price. The text must be byte-identical between calls: no dates, ids or
// names inside it. Under the model's 512-token minimum it is not cached and
// costs nothing extra.
export const cachedSystem = (text: string) =>
  [{ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } }];

// These are one-shot extraction and scoring calls with small max_tokens.
// Sonnet 5.5 thinks by default and could spend the budget before the tool
// call; between_tools is its supported way to turn thinking off.
export const CLAUDE_THINKING = { type: "between_tools" } as const;

// Deal memory reads whole contract PDFs next to weeks of email. It ran on Opus
// 5.5 ($89 of a $180 month); Haiku 5.5 is 40x cheaper per token. The price and
// term conflicts it must catch are also checked by rule (termConflicts in
// deal-memory.ts), so a miss by the model still shows up as an issue.
export const CLAUDE_HAIKU_MODEL = "claude-haiku-5-5";

// Background jobs nobody outside the team reads (lead memory, Gmail filing,
// call profiles, record suggestions) run on Haiku 5.5: 20x under Sonnet 5.5
// per token. Anything a seller or buyer reads stays on CLAUDE_MODEL.
// Haiku rejects Sonnet's between_tools; "disabled" is its thinking-off,
// accepted at effort high or below (the default is medium).
export const HAIKU_THINKING = { type: "disabled" } as const;

// Dollars per million tokens, Anthropic list price (Oct 2026). Used by
// _shared/ai-usage.ts to put a cost on every call; a model missing here is
// logged with cost 0, so add a row when a new model lands.
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
// `long` is the rate card for a prompt (input + cache read + cache write) over
// `over` tokens: Haiku 5.5 bills a prompt above 100K at 5x the whole request.
export const MODEL_PRICES: Record<string, Rates & { long?: Rates & { over: number } }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
