// The one Claude model every function uses, so a switch is one line.
export const CLAUDE_MODEL = "claude-sonnet-5-5";

// Sonnet 5.5 rejects a forced tool_choice (any / tool) with a 400, so a
// function that needs a single tool call asks for it in the system prompt and
// sends tool_choice auto instead.
export const toolRule = (name: string) => `Always reply by calling the ${name} tool, never with plain text.\n\n`;

// These are one-shot extraction and scoring calls with small max_tokens.
// Sonnet 5.5 thinks by default and could spend the budget before the tool
// call; between_tools is its supported way to turn thinking off.
export const CLAUDE_THINKING = { type: "between_tools" } as const;
