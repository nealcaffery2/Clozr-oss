// The read-only switch behind "View as" (lib/view-as.ts).
//
// useClozr already turns its own writes off with `canWrite`, but plenty of
// screens save on their own — Settings, Account, the deal team, the inbox
// composer, Deal Sheet, campaigns, Talkr settings — and each of those would
// need its own check, which is exactly how some were missed. So the check sits
// where every write has to pass: the fetch the Supabase client uses (tables,
// rpc, edge functions, storage, auth) and the two Talkr request helpers.
// A forgotten caller still cannot save; it gets a refusal that reads like any
// other failed save, with READ_ONLY_MESSAGE as its text.
//
// The switch is module state because the Supabase client is module state. It
// is turned on and off by useReadOnlyWrites in the app page only, and turned
// off again when that page goes away, so it cannot outlive the preview.

export const READ_ONLY_MESSAGE = 'Read-only preview · nothing was saved';

let on = false;
const listeners = new Set<() => void>();

/** Whether writes are being refused right now. */
export const isReadOnly = () => on;

/** Turn refusing on or off. Only the app page's View-as hook calls this. */
export function setReadOnly(next: boolean) {
  on = next;
}

/**
 * Hear about each refused write, so the page can say so even when the caller
 * that tried it ignores its error.
 */
export function onReadOnlyRefusal(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// ---- what counts as a write -------------------------------------------------

/** Database functions that only read, so a preview can still call them. */
const READ_RPCS = new Set(['address_key', 'import_address_lookup']);

/**
 * Edge functions a preview may still call: `true` when the whole function only
 * reads (the AI drafting and answering ones return text and save nothing), or
 * the actions that only read. Anything not listed is treated as a write.
 */
const READ_FUNCTIONS: Record<string, true | ((b: Record<string, unknown>) => boolean)> = {
  // Ask CLOZR can write (tasks, notes, stages, plans) when asked; a preview
  // sends read_only and the function then offers it no write tools.
  'ask-clozr': (b) => b.read_only === true,
  'clozr-today': true,
  lane: true,
  'record-suggest': true,
  'call-profile': true,
  'dispo-intro': true,
  'draft-template': true,
  'draft-action-plan': true,
  'map-columns': true,
  'jev-triage': true,
  'google-oauth': (b) => b.action === 'status',
  // Opening an attachment reads it; saving it onto the deal writes a file.
  'google-sync': (b) => b.action === 'attachment' && !b.save_to_deal,
  'compr-underwrite': (b) => b.action === 'assets',
  deliverability: (b) => b.action === 'overview' || b.action === 'postmaster' || b.action === 'resend_status',
  'cold-pool': (b) => b.action === 'overview' || b.action === 'health',
  contracts: (b) => ['render', 'links', 'pdf', 'fields'].includes(String(b.action)),
  pandadoc: (b) => ['templates', 'template', 'preview', 'pdf'].includes(String(b.action)),
  // Estimates and portfolios spend credits and log them; the address lookup does not.
  'genius-discover': (b) => b.action === 'autocomplete',
  offers: (b) => b.action === 'price',
  'podio-import': (b) => ['status', 'test', 'inspect'].includes(String(b.action)),
  'jotform-import': (b) => b.action === 'forms',
  'brex-sync': (b) => b.action === 'status',
  'ten-dlc-register': (b) => b.action === 'check',
  // A preview may look at the agents, their prompts, versions, scenarios, calls and stats, hear a voice and open a test session; saving, publishing, rolling back, creating, duplicating, deleting and scoring are writes.
  // AI agents on records (migration 123): looking at the agents, a record's status and log and the report reads; chatting, switching, bulk and avatars write.
  'ai-agent': (b) => ['agents', 'status', 'log', 'report', 'autopilot'].includes(String(b.action)),
  'voice-agent-admin': (b) => ['list_agents', 'templates', 'get', 'preview_prompt', 'versions', 'diff', 'scenarios', 'calls', 'stats', 'voices', 'preview', 'test_session'].includes(String(b.action)),
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function bodyJson(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a request to the Supabase project would change something. */
export function isSupabaseWrite(url: string, method: string, body: unknown): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  let path: string;
  try { path = new URL(url).pathname; } catch { return true; }
  const rpc = /\/rest\/v1\/rpc\/([^/?]+)/.exec(path);
  if (rpc) return !READ_RPCS.has(rpc[1]!);
  if (path.includes('/rest/v1/')) return true;
  const fn = /\/functions\/v1\/([^?]+)/.exec(path);
  if (fn) {
    const rule = READ_FUNCTIONS[fn[1]!];
    if (rule === true) return false;
    return !(rule && rule(bodyJson(body)));
  }
  // Signing a download link, listing a folder and reading a file's details
  // are POSTs too; uploads, moves and removals are the writes.
  if (path.includes('/storage/v1/')) return !/\/storage\/v1\/object\/(sign|list|info)\//.test(path);
  // Signing in, refreshing the token and signing out must keep working. The
  // account itself (name, email, password) and its authenticators are writes.
  if (path.includes('/auth/v1/')) return /\/auth\/v1\/(user|factors)/.test(path);
  return true;
}

/**
 * Bookkeeping the app writes by itself when something is merely opened — read
 * marks, the inbox watermark, presence. Refused like any write, but without the
 * toast, because nobody asked to save anything.
 */
const QUIET = [
  /\/rest\/v1\/(communication_user_state|inbox_user_prefs)\b/,
  /\/v1\/conversations\/[^/]+\/read$/,
  /\/v1\/presence$/,
];
const isQuiet = (url: string) => QUIET.some((re) => re.test(url.split('?')[0]!));

/** Talkr endpoints that take a POST but change nothing: tokens, previews, drafts, sign-in. */
const TALKR_READS = [
  /^\/v1\/auth\//,
  /^\/v1\/voice\/token$/,
  /^\/v1\/transcription\/token$/,
  /\/routing\/simulate$/,
  /\/preview$/,
  /^\/v1\/ai\/sequence-draft$/,
];

/** Whether a Talkr API request (path from /v1) would change something. */
export function isTalkrWrite(path: string, method = 'GET'): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  const p = path.split('?')[0]!;
  return !TALKR_READS.some((re) => re.test(p));
}

// ---- refusing ---------------------------------------------------------------

/**
 * The answer a refused write gets instead of a network call: a 403 whose body
 * carries the message under both `message` (PostgREST, storage) and `error`
 * (how the edge-function callers read theirs), so it reaches the toast.
 */
export function readOnlyResponse(url: string, error: string = READ_ONLY_MESSAGE): Response {
  // Said a beat later so it lands after any "Saved" a careless caller raises.
  if (typeof window !== 'undefined' && !isQuiet(url)) window.setTimeout(() => listeners.forEach((l) => l()), 80);
  return new Response(JSON.stringify({ ok: false, error, message: READ_ONLY_MESSAGE, code: 'read_only' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The fetch the Supabase client (and the few raw edge-function calls) use:
 * the ordinary fetch, except that while a preview is open a write is answered
 * with a refusal and never leaves the browser.
 */
export const guardedFetch: typeof fetch = (input, init) => {
  if (on) {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const url = urlOf(input);
    if (isSupabaseWrite(url, method, init?.body)) return Promise.resolve(readOnlyResponse(url));
  }
  return fetch(input, init);
};
