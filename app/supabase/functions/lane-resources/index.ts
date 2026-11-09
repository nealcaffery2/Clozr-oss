/**
 * POST /lane-resources — the team's reference docs behind Lane's Resources
 * button (migration 400). Lane reads them through search_resources().
 *
 * Body: { action, workspace_id, ... } as a member (the caller's JWT).
 *   status                         → { drive_connected, can_add, can_admin }
 *   add { kind: 'file', file_path, file_name, mime_type, title?, category_id? }
 *       The file is already in the private `resources` bucket at
 *       ws/<workspace>/<uuid>/<name> (the panel uploads it under storage RLS).
 *       PDF text comes from pdf.js, and a PDF with no text layer (a scan) is
 *       transcribed by Claude; Word from word/document.xml; Markdown and text
 *       as they are.
 *   add { kind: 'text', text, title?, category_id? }   pasted text
 *   add { kind: 'drive', link, title?, category_id? }  a Drive or Docs link,
 *       read with the caller's own Google connection (Drive read-only, the
 *       scope Settings → Google → Connect Drive grants). Google Docs export as
 *       text, Sheets as CSV, Slides as text; PDF and Word files download.
 *                                → { ok, id, title, chunks, chars }
 *   remove { id }   owners and admins: the row, its sections and the file.
 *   reindex { id }  owners and admins: re-cut a doc's sections from its text.
 *
 * Adding needs owner, admin, acquisitions, dispositions or tc. Every write to
 * resources and resource_chunks is the service role, after the role check;
 * reads elsewhere are the caller's own, under RLS.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and
 * ANTHROPIC_API_KEY (only for scanned PDFs; without it a scan is refused with
 * a message saying so).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { unzipSync, strFromU8 } from 'npm:fflate@0.8.2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import { SCOPE, accessFor, has } from '../_shared/google.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING } from '../_shared/models.ts';
import { recordUsage } from '../_shared/ai-usage.ts';
import { chunkText, docxText, driveFileId, normalizeText, titleFromFile, titleFromMarkdown } from '../_shared/resource-text.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const WRITERS = ['owner', 'admin', 'acquisitions', 'dispositions', 'tc', 'sdr'];
const ADMINS = ['owner', 'admin'];
const MAX_BYTES = 25 * 1024 * 1024;
/** A doc's text is capped so one upload cannot fill the table; about 300 pages. */
const MAX_CHARS = 1_000_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class UserError extends Error {}

// ─── Extraction ──────────────────────────────────────────────────────────────

/** A scanned PDF has no text layer: Claude reads the pages and writes them out. */
async function pdfByClaude(bytes: Uint8Array): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new UserError('This PDF is a scan with no text in it, and reading scans needs the ANTHROPIC_API_KEY secret. Upload a text PDF or paste the text.');
  if (bytes.length > 20 * 1024 * 1024) throw new UserError('This PDF is a scan over 20 MB. Split it or paste the text.');
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  const client = new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const stream = client.messages.stream({
    model: CLAUDE_MODEL,
    // A transcription, not a judgment: thinking only spends the budget.
    thinking: CLAUDE_THINKING,
    max_tokens: 64000,
    system: `You transcribe documents for a real estate team's reference library. Write out the attached PDF's text exactly as printed, in reading order, as Markdown: headings as #, lists as -, tables as Markdown tables. Do not summarize, correct, or add anything. If a page is unreadable, write [unreadable page N].${UNTRUSTED_RULE} The PDF is such data.`,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: 'Transcribe this document.' },
      ],
    }],
  });
  const msg = await stream.finalMessage();
  await recordUsage(null, { feature: 'lane_resources_pdf', model: msg.model, usage: msg.usage });
  if (msg.stop_reason === 'refusal') throw new UserError('Claude would not read this PDF. Paste the text instead.');
  return msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function extract(bytes: Uint8Array, mime: string, name: string): Promise<string> {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    let text = '';
    // Loaded here so a pdf.js problem only breaks PDF uploads.
    try { const { pdfText } = await import('../_shared/pdf-text.ts'); text = await pdfText(bytes); } catch (e) { console.warn('pdf.js', e); }
    if (text.replace(/\s/g, '').length >= 40) return text;
    return await pdfByClaude(bytes);
  }
  if (mime === DOCX || /\.docx$/i.test(name)) {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' }); } catch { throw new UserError(`${name} is not a readable Word file. Save it as .docx or PDF and try again.`); }
    const xml = files['word/document.xml'];
    if (!xml) throw new UserError(`${name} has no document body. Save it as .docx or PDF and try again.`);
    return docxText(strFromU8(xml));
  }
  if (/^text\//.test(mime) || /\.(md|markdown|txt|csv)$/i.test(name)) return new TextDecoder().decode(bytes);
  throw new UserError(`${name}: CLOZR reads PDF, Word (.docx), Markdown and text files.`);
}

/** A Drive file as text, read with the caller's Google token. */
async function driveDoc(token: string, id: string): Promise<{ name: string; text: string; mime: string; url: string }> {
  const auth = { Authorization: `Bearer ${token}` };
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`, { headers: auth });
  if (metaRes.status === 404) throw new UserError('Drive could not find that file, or your Google account cannot open it. Check the link and its sharing.');
  if (!metaRes.ok) throw new UserError(`Drive refused the file (${metaRes.status}). Reconnect Drive in Settings → Google and try again.`);
  const meta = await metaRes.json() as { name: string; mimeType: string; size?: string; webViewLink?: string };
  const exportAs: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };
  const url = meta.webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  if (exportAs[meta.mimeType]) {
    // Docs export as Markdown when Drive offers it (headings kept), else text.
    if (meta.mimeType === 'application/vnd.google-apps.document') {
      const md = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text%2Fmarkdown`, { headers: auth });
      if (md.ok) return { name: meta.name, text: await md.text(), mime: 'text/markdown', url };
    }
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType])}`, { headers: auth });
    if (!r.ok) throw new UserError(`Drive would not export ${meta.name} (${r.status}).`);
    return { name: meta.name, text: await r.text(), mime: exportAs[meta.mimeType], url };
  }
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) throw new UserError(`${meta.name} is a Google file type CLOZR cannot read. Use a Doc, Sheet, Slides deck, PDF or Word file.`);
  if (Number(meta.size ?? 0) > MAX_BYTES) throw new UserError(`${meta.name} is over 25 MB.`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: auth });
  if (!r.ok) throw new UserError(`Drive would not download ${meta.name} (${r.status}).`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { name: meta.name, text: await extract(bytes, meta.mimeType, meta.name), mime: meta.mimeType, url };
}

// ─── Writing a doc ───────────────────────────────────────────────────────────

async function writeChunks(admin: SupabaseClient, ws: number, resourceId: number, title: string, body: string): Promise<number> {
  const chunks = chunkText(title, body);
  const { error: delErr } = await admin.from('resource_chunks').delete().eq('resource_id', resourceId);
  if (delErr) throw delErr;
  for (let i = 0; i < chunks.length; i += 200) {
    const rows = chunks.slice(i, i + 200).map((c) => ({ resource_id: resourceId, workspace_id: ws, ord: c.ord, heading: c.heading, body: c.body }));
    const { error } = await admin.from('resource_chunks').insert(rows);
    if (error) throw error;
  }
  return chunks.length;
}

async function categoryOk(admin: SupabaseClient, ws: number, id: unknown): Promise<number | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { data } = await admin.from('resource_categories').select('id').eq('workspace_id', ws).eq('id', n).maybeSingle();
  return data ? n : null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

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

  let body: Record<string, Any>;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id);
  if (!Number.isInteger(ws) || ws <= 0) return json({ error: 'workspace_id is required' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const role = String((member as Any).role ?? '');
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  try {
    if (body.action === 'status') {
      const { data: account } = await admin.from('google_accounts').select('id, scopes').eq('workspace_id', ws).eq('user_id', who.user.id).eq('shared', false).maybeSingle();
      return json({ drive_connected: !!account && has(account as Any, SCOPE.driveRead), can_add: WRITERS.includes(role), can_admin: ADMINS.includes(role) });
    }

    if (body.action === 'add') {
      if (!WRITERS.includes(role)) return json({ error: 'Your role can read resources but not add them. Ask an admin.' }, 403);
      const rl = await rateLimit(admin, `lane-resources:${who.user.id}`, 120, 3600);
      if (!rl.allowed) return tooMany(CORS, rl);
      const categoryId = await categoryOk(admin, ws, body.category_id);
      const given = String(body.title ?? '').trim().slice(0, 200);
      let text = '';
      let row: Record<string, unknown> = {};

      if (body.kind === 'text') {
        text = String(body.text ?? '');
        if (!text.trim()) return json({ error: 'Paste the text first.' }, 422);
        row = { source: 'paste' };
      } else if (body.kind === 'file') {
        const path = String(body.file_path ?? '');
        if (!path.startsWith(`ws/${ws}/`) || path.includes('..')) return json({ error: 'file_path is not in this workspace' }, 422);
        const name = String(body.file_name ?? path.split('/').pop() ?? 'file').slice(0, 200);
        const mime = String(body.mime_type ?? '');
        const { data: blob, error } = await admin.storage.from('resources').download(path);
        if (error || !blob) return json({ error: 'The upload is not in storage. Try adding the file again.' }, 404);
        if (blob.size > MAX_BYTES) return json({ error: `${name} is over 25 MB.` }, 413);
        text = await extract(new Uint8Array(await blob.arrayBuffer()), mime, name);
        row = { source: 'upload', file_path: path, file_name: name, mime_type: mime || null, byte_size: blob.size };
      } else if (body.kind === 'drive') {
        const id = driveFileId(String(body.link ?? ''));
        if (!id) return json({ error: 'That is not a Google Drive or Docs link.' }, 422);
        const { data: account } = await admin.from('google_accounts').select('*').eq('workspace_id', ws).eq('user_id', who.user.id).eq('shared', false).maybeSingle();
        if (!account || !has(account as Any, SCOPE.driveRead)) return json({ error: 'Connect Drive first: Settings → Google → Connect Drive.' }, 409);
        const token = await accessFor(admin, account as Any);
        if (!token) return json({ error: 'Your Google connection has expired. Reconnect it in Settings → Google.' }, 409);
        const d = await driveDoc(token, id);
        text = d.text;
        row = { source: 'drive', drive_url: d.url, file_name: d.name, mime_type: d.mime };
      } else {
        return json({ error: 'kind must be file, text or drive' }, 422);
      }

      text = normalizeText(text);
      if (!text) return json({ error: 'No text came out of that file. If it is a scan or an image, paste the text instead.' }, 422);
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
      const title = given || titleFromMarkdown(text) || titleFromFile(String(row.file_name ?? 'Untitled'));
      const { data: ins, error: insErr } = await admin.from('resources')
        .insert({ workspace_id: ws, category_id: categoryId, title, body: text, created_by: who.user.id, ...row })
        .select('id').single();
      if (insErr) throw insErr;
      const id = (ins as Any).id as number;
      const chunks = await writeChunks(admin, ws, id, title, text);
      return json({ ok: true, id, title, chunks, chars: text.length });
    }

    if (body.action === 'remove' || body.action === 'reindex') {
      if (!ADMINS.includes(role)) return json({ error: 'Only owners and admins can do that.' }, 403);
      const id = Number(body.id);
      const { data: doc } = await admin.from('resources').select('id, title, body, file_path').eq('workspace_id', ws).eq('id', id).maybeSingle();
      if (!doc) return json({ error: 'That doc is not in this workspace.' }, 404);
      if (body.action === 'reindex') {
        const chunks = await writeChunks(admin, ws, id, (doc as Any).title, (doc as Any).body);
        return json({ ok: true, id, chunks });
      }
      if ((doc as Any).file_path) await admin.storage.from('resources').remove([(doc as Any).file_path]);
      const { error } = await admin.from('resources').delete().eq('id', id);
      if (error) throw error;
      return json({ ok: true, id });
    }

    return json({ error: 'unknown action' }, 422);
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 422);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'lane-resources anthropic', e, 502);
    return serverError(CORS, 'lane-resources', e);
  }
});
