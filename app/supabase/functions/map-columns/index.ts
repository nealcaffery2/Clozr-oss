/**
 * POST /map-columns — the AI half of the bulk importer.
 *
 * The client's own matcher (lib/import.ts autoMap) handles the exports it
 * knows by column name. This is for the file it does not know: some other
 * CRM's export with headers like "Prop Sit Addr" or a column of values that
 * only make sense read together. Claude gets the headers and a few sample
 * rows and returns one CLOZR target per column, with a reason, so the person
 * importing can see why and override.
 *
 * Nothing is written here. The mapping goes back to the browser, which still
 * shows it for correction before a single row is imported.
 *
 * Needs the ANTHROPIC_API_KEY secret on the project:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-…
 * Until it is set, the function answers 503 with a plain message and the
 * button in the importer says so.
 *
 * Body:    { headers: string[], samples: string[][], targets: {key,label}[] }
 * Returns: { ok, mapping: { [columnIndex]: target }, reasons: { [columnIndex]: string } }
 *
 * Sheet:   { action: 'sheet', url } → { ok, csv, name } — a Google Sheets link
 *          read as CSV for the importer. Google's export answers no CORS, so
 *          the browser cannot fetch it itself. Only docs.google.com sheet
 *          links are fetched (nothing else on the network is reachable from
 *          here), and only sheets shared "anyone with the link": a private
 *          sheet answers its sign-in page, which is reported, not imported.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, isTeammate, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

/**
 * An organization-level Anthropic key (one not created inside a workspace)
 * must name the workspace on every request. ANTHROPIC_WORKSPACE_ID is the
 * optional secret that does that; a workspace-scoped key needs nothing.
 */
function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}
const WORKSPACE_HINT =
  'The Anthropic key is an organization key, so Anthropic needs a workspace: either create the key inside a workspace '
  + '(console.anthropic.com → API keys → choose a workspace) or add the ANTHROPIC_WORKSPACE_ID secret with that workspace\'s id.';

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Signed-in users only: it spends money.
  const authHeader = req.headers.get('authorization') ?? '';
  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  if (!(await isTeammate(asCaller, who.user.id))) return json({ error: 'not a member of a workspace' }, 403);

  // Peek at the body first: the sheet read spends nothing and needs no AI key.
  const raw = await req.text();
  let peek: { action?: string; url?: string } = {};
  try { peek = JSON.parse(raw); } catch { /* reported below */ }
  if (peek.action === 'sheet') return json(...(await readGoogleSheet(String(peek.url ?? ''))));

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json({ error: 'AI mapping is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);
  }

  // Each call spends money: a per-user hourly ceiling.
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `map-columns:${who.user.id}`, 30, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  let body: { headers?: string[]; samples?: string[][]; targets?: { key: string; label: string }[]; kind?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const headers = (body.headers ?? []).map(String).slice(0, 200);
  const samples = (body.samples ?? []).slice(0, 8).map((r) => r.map((v) => String(v ?? '').slice(0, 120)));
  const targets = body.targets ?? [];
  if (!headers.length || !targets.length) return json({ error: 'headers and targets are required' }, 422);

  const targetKeys = targets.map((t) => t.key);
  const kind = body.kind === 'buyers' || body.kind === 'vendors' ? body.kind : 'sellers';
  const kindNoun = kind === 'buyers' ? 'cash buyer' : kind === 'vendors' ? 'vendor' : 'lead';
  const client = new Anthropic({ apiKey, ...anthropicHeaders() });

  // A strict tool is the reliable way to get one target per column back as
  // data rather than prose: the schema is enforced, so there is nothing to
  // parse and nothing to second-guess.
  const tool: Anthropic.Tool = {
    name: 'submit_mapping',
    description: 'Return the CLOZR target field for every source column, by column index.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['columns'],
      properties: {
        columns: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['index', 'target', 'reason', 'confidence'],
            properties: {
              index: { type: 'integer' },
              target: { type: 'string', enum: targetKeys },
              reason: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
    },
  };

  const table = [headers, ...samples].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');

  try {
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 16000,
      system: toolRule('submit_mapping') +
        `You map columns from a real-estate ${kindNoun} export (Podio, PropStream, DealMachine, InvestorLift, BatchLeads, REISift, or a hand-made spreadsheet) onto the fields of a wholesaling CRM. `
        + 'Use the header first, then the sample values. Every source column gets exactly one target. '
        + (targetKeys.includes('extra')
          ? 'Use "extra" for anything that has no field: it is kept on the record as it is. Use "skip" only for a column that is plainly empty or junk. '
            + 'phone, email, phone_type, phone_dnc, notes, tags and extra may take several columns (Phone 1…5 are all phone, the first is the main number; "Phone 2 Type" is phone_type, "Phone 2 DNC" and "Phone 2 Litigator" are phone_dnc); '
            + 'every other target should be used for at most one column — if two compete, give the better one the target and make the other "extra". '
          : 'Use "skip" for anything that has no home. '
            + 'Each target other than "skip" should be used for at most one column — if two columns compete, give the better one the target and skip the other. ')
        + (kind === 'buyers'
          ? 'These are cash buyers / investors: the person or company buying properties is the buyer; areas they buy in are markets; a price range column is max_price. Strategy (fix and flip, buy and hold) is strategy, not buyer_type. min_year_build / min_sqft / min_bedroom are min_year / min_sqft / min_beds. DispoGenius no_hoa / req_garage flags are restrictions / requirements. type=vetted_buyer is vetted, not buyer_type. dnd is wants_calls (inverted). '
          : kind === 'vendors'
            ? 'These are vendors (title companies, lenders, contractors, inspectors): the business is name, the person is contact_name, what they do is service_type. '
            : 'A single column holding a whole address is full_address; separate street / city / state / zip columns are addr / city / st / zip. The person who owns the property is the seller. '
            + 'The owner\'s mailing address columns are mail_addr / mail_unit / mail_city / mail_st / mail_zip, never the property\'s. An estimated or market value (AVM) is est_value, not arv. ')
        + 'Prefer a mobile number for phone. A column holding a unique id from the source system is source_id. '
        + 'Give each column a confidence: high when the header names the field outright, medium when inferred, low when it is a guess. '
        + 'Targets: ' + targets.map((t) => `${t.key} = ${t.label}`).join('; ') + '.'
        + UNTRUSTED_RULE,
      tools: [tool],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'Header row, then up to eight sample rows, as CSV:\n\n' + fence('csv_export', table, 40_000) }],
    });

    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return json({ error: 'the model returned no mapping' }, 502);
    const cols = (call.input as { columns: { index: number; target: string; reason: string; confidence: string }[] }).columns;
    const mapping: Record<number, string> = {};
    const reasons: Record<number, string> = {};
    const confidence: Record<number, string> = {};
    for (const c of cols) {
      if (c.index < 0 || c.index >= headers.length) continue;
      mapping[c.index] = targetKeys.includes(c.target) ? c.target : 'skip';
      reasons[c.index] = c.reason;
      confidence[c.index] = c.confidence;
    }
    headers.forEach((_, i) => { if (!(i in mapping)) mapping[i] = 'skip'; });
    return json({ ok: true, mapping, reasons, confidence, usage: res.usage });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError && /anthropic-workspace-id/.test(e.message)) return json({ error: WORKSPACE_HINT }, 503);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'map-columns anthropic', e, 502);
    return serverError(CORS, 'map-columns', e);
  }
});

/** The spreadsheet id and tab (gid) of a Google Sheets link, or null for anything else. */
export function sheetLink(url: string): { id: string; gid: string | null } | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const id = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(u.pathname)?.[1];
  if (!id) return null;
  const gid = /(?:^|[#&?])gid=(\d+)/.exec(u.hash + '&' + u.search)?.[1] ?? null;
  return { id, gid };
}

async function readGoogleSheet(url: string): Promise<[Record<string, unknown>, number]> {
  const link = sheetLink(url);
  if (!link) return [{ error: 'That is not a Google Sheets link. Paste the address from the browser bar of the sheet.' }, 422];
  const exp = `https://docs.google.com/spreadsheets/d/${link.id}/export?format=csv${link.gid ? `&gid=${link.gid}` : ''}`;
  let res: Response;
  try {
    res = await fetch(exp, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    console.error('sheet fetch', (e as Error).message);
    return [{ error: 'Google did not answer. Try again, or download the sheet as .xlsx and upload it.' }, 502];
  }
  const type = res.headers.get('content-type') ?? '';
  // A private sheet redirects to Google's sign-in page, which is HTML.
  if (!res.ok || type.includes('text/html')) {
    return [{ error: 'Google would not share that sheet. Set it to "Anyone with the link can view" (Share → General access), or download it as .xlsx and upload it.' }, 403];
  }
  const csv = await res.text();
  if (csv.length > 15_000_000) return [{ error: 'That sheet is too big to read in one go. Split it, or upload it as a file.' }, 413];
  const disp = res.headers.get('content-disposition') ?? '';
  const name = /filename\*=UTF-8''([^;]+)/i.exec(disp)?.[1] ?? /filename="([^"]+)"/i.exec(disp)?.[1] ?? null;
  return [{ ok: true, csv, name: name ? decodeURIComponent(name).replace(/\.csv$/i, '') : null }, 200];
}
