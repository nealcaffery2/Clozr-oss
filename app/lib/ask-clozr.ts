// Ask CLOZR — questions and small jobs over the signed-in workspace.
//
// The `ask-clozr` edge function runs a streaming tool loop over CLOZR's own
// data (the Today focus list, tasks, sellers, notes, deals, Compr outcomes,
// action plans) and writes the answer; this is the wire. The answer streams
// in as it is written (onEvent), with a line for each tool it runs. Cards
// come back as { kind, id } pairs rather than callbacks, because the function
// has no idea how the shell opens a record — useClozr turns each one into a
// `go()` against openPerson / openBuyer / openDispo.
//
// The sample workspace (/demo) never gets here: useClozr keeps its scripted
// answers for the demo graph and only calls this when a workspace is signed in.

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabase } from './supabase';
import { guardedFetch, isReadOnly } from './read-only';

export type AskCardKind = 'seller' | 'buyer' | 'deal';
export type AskCard = { kind: AskCardKind; id: number; title: string; subtitle: string };
export type AskTurn = { role: 'user' | 'clozr'; text: string };
export type AskResult = { answer: string; cards: AskCard[] };
/** What the Today screen shows, sent along so "do the second one" means its second row. */
export type AskFocusItem = { id: string; kind: string; record: { kind: 'seller' | 'deal'; id: number }; title: string; detail: string; why?: string };
export type AskEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error' }
  | { type: 'cards'; cards: AskCard[] };

/** "Checking your tasks…" — what the panel says while a tool runs. */
export const TOOL_LABEL: Record<string, string> = {
  todays_focus: 'Reading your day',
  list_my_tasks: 'Checking tasks',
  create_task: 'Creating the task',
  complete_task: 'Completing the task',
  search_sellers: 'Searching sellers',
  get_seller: 'Opening the seller',
  update_seller_stage: 'Moving the seller',
  add_note: 'Adding the note',
  find_buyers: 'Searching buyers',
  list_deals: 'Checking deals',
  get_deal: 'Opening the deal',
  update_deal_stage: 'Moving the deal',
  list_stages: 'Reading the stages',
  list_action_plans: 'Reading action plans',
  enroll_in_action_plan: 'Enrolling',
  show_records: 'Picking the records',
};

async function messageOf(res: Response): Promise<string> {
  try { return ((await res.json()) as { error?: string }).error ?? `Ask CLOZR answered ${res.status}.`; } catch { return `Ask CLOZR answered ${res.status}.`; }
}

/**
 * Ask, reading the answer as it streams. Throws with the function's own
 * message (a missing API key, a rate limit) so the panel can show it as the
 * answer rather than a bare "failed to send a request".
 */
export async function askClozr(
  workspaceId: number, question: string, history: AskTurn[] = [],
  opts: { focus?: AskFocusItem[]; onEvent?: (e: AskEvent) => void; signal?: AbortSignal } = {},
): Promise<AskResult> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error('Sign in again to ask CLOZR.');
  const body = {
    workspace_id: workspaceId, question, history: history.slice(-6), stream: true,
    // A View-as preview asks without the tools that change things.
    read_only: isReadOnly(),
    ...(opts.focus?.length ? { context: { focus: opts.focus.slice(0, 6) } } : {}),
  };
  let res: Response;
  try {
    // Raw fetch for the stream, so it takes the client's read-only guard by hand.
    res = await guardedFetch(`${SUPABASE_URL}/functions/v1/ask-clozr`, {
      method: 'POST', signal: opts.signal,
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error((e as Error).name === 'AbortError' ? 'Stopped.' : 'Could not reach Ask CLOZR. Check the connection and try again.');
  }
  if (!res.ok) throw new Error(await messageOf(res));
  if (!(res.headers.get('content-type') ?? '').includes('ndjson') || !res.body) {
    // An older deployment answers in one piece.
    const r = (await res.json().catch(() => ({}))) as { ok?: boolean; answer?: string; cards?: AskCard[]; error?: string };
    if (!r.ok || typeof r.answer !== 'string') throw new Error(r.error ?? 'Ask CLOZR returned nothing.');
    opts.onEvent?.({ type: 'text', text: r.answer });
    return { answer: r.answer, cards: Array.isArray(r.cards) ? r.cards : [] };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let cards: AskCard[] = [];
  let done: AskResult | null = null;
  let failed: string | null = null;
  const handle = (line: string) => {
    let ev: { type?: string; text?: string; name?: string; status?: string; cards?: AskCard[]; answer?: string; error?: string };
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'text' && typeof ev.text === 'string') { text += ev.text; opts.onEvent?.({ type: 'text', text: ev.text }); }
    else if (ev.type === 'tool' && ev.name) opts.onEvent?.({ type: 'tool', name: ev.name, status: ev.status === 'done' ? 'done' : ev.status === 'error' ? 'error' : 'start' });
    else if (ev.type === 'cards' && Array.isArray(ev.cards)) { cards = ev.cards; opts.onEvent?.({ type: 'cards', cards }); }
    else if (ev.type === 'done') done = { answer: typeof ev.answer === 'string' ? ev.answer : text.trim(), cards: Array.isArray(ev.cards) ? ev.cards : cards };
    else if (ev.type === 'error') failed = ev.error ?? 'Ask CLOZR could not answer.';
  };
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(line);
      }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    throw new Error((e as Error).name === 'AbortError' ? 'Stopped.' : 'The connection dropped mid-answer. Ask again.');
  }
  if (failed) throw new Error(failed);
  if (done) return done;
  if (text.trim()) return { answer: text.trim(), cards };
  throw new Error('Ask CLOZR returned nothing.');
}
