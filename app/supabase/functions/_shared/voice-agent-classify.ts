// What happened on an AI call, read from the post-call payload: which tools
// the agent used and what the caller said. No imports, so voice-agent.ts can
// use it without a cycle.
//
// Tool calls are exact (the transcript lists them by name); the caller's own
// words are matched by keyword and are a heuristic, which stats says so about.
// Neither writes anything to a record: this feeds voice_agent_calls only.

export type CallFlags = {
  booked: boolean;
  transferred: boolean;
  dnc_requested: boolean;
  not_interested: boolean;
  /** Distinct tool names the agent called successfully. */
  tools: string[];
  /** save_qualification's outcome when the agent set one, else the strongest flag, else null. */
  outcome: string | null;
};

/** A caller or texter asking us to stop, in their own words. Shared with the AI agent runner (ai-agent.ts). */
export const DNC_WORDS = /\b(stop calling|don'?t call( me)?( again| anymore)?|do not call|take me off|remove me|put me on (?:your|the) (?:do not call|dnc)|never call( me)? again|quit calling|stop contacting)\b/i;
const NOT_INTERESTED = /\b(not interested|not selling|not for sale|no,? thanks?|no,? thank you|don'?t want to sell|not looking to sell|not (?:going|planning) to sell)\b/i;

type Turn = { role?: string; message?: string | null; tool_calls?: { tool_name?: string; params_as_json?: string }[]; tool_results?: { tool_name?: string; is_error?: boolean; result_value?: unknown }[] };

const parse = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
};

export function classifyCall(turns: unknown): CallFlags {
  const list = (Array.isArray(turns) ? turns : []) as Turn[];
  const failed = new Set<string>();
  const called = new Set<string>();
  let outcome: string | null = null;
  let userText = '';
  // book_appointment is called once for open times and once to book: only a call
  // with a time (or a result that says booked) is a booking.
  let bookTried = false;
  let bookConfirmed: boolean | null = null;
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    for (const r of t.tool_results ?? []) {
      if (r?.is_error && r.tool_name) failed.add(r.tool_name);
      if (r?.tool_name === 'book_appointment' && !r.is_error) {
        const v = parse(r.result_value);
        if (v && typeof v.booked === 'boolean') bookConfirmed = bookConfirmed === true || v.booked;
      }
    }
    for (const c of t.tool_calls ?? []) {
      if (!c?.tool_name) continue;
      called.add(c.tool_name);
      if (c.tool_name === 'save_qualification' && typeof c.params_as_json === 'string') {
        try { const o = JSON.parse(c.params_as_json)?.outcome; if (typeof o === 'string' && o) outcome = o.slice(0, 40); } catch { /* not JSON: no outcome */ }
      }
      if (c.tool_name === 'book_appointment') {
        // No params at all is an older payload: count it as the booking it used to mean.
        const p = typeof c.params_as_json === 'string' ? parse(c.params_as_json) : null;
        if (c.params_as_json === undefined || (p && typeof p.starts_at === 'string' && p.starts_at.trim())) bookTried = true;
      }
    }
    if (t.role === 'user' && typeof t.message === 'string') userText += t.message + '\n';
  }
  const tools = [...called].filter((n) => !failed.has(n)).sort();
  const booked = bookConfirmed ?? (tools.includes('book_appointment') && bookTried);
  const transferred = tools.includes('transfer_to_number');
  const dnc = tools.includes('mark_do_not_contact') || DNC_WORDS.test(userText) || outcome === 'do_not_contact';
  const notInterested = outcome === 'not_interested' || (!booked && !transferred && NOT_INTERESTED.test(userText));
  return {
    booked, transferred, dnc_requested: dnc, not_interested: notInterested && !dnc, tools,
    outcome: outcome ?? (booked ? 'booked' : transferred ? 'transferred' : dnc ? 'do_not_contact' : notInterested ? 'not_interested' : null),
  };
}
