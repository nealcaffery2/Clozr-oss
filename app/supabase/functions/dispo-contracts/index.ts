/**
 * POST /dispo-contracts — the Dispositions Drive, read for its contracts:
 * every assignment PDF under the team's dispo folder becomes a row in
 * wholesaler_deals, and every LLC on it a row in wholesaler_entities, so
 * Genius can ask "who does this wholesaler sell to" and the dispo rep can
 * see every end buyer we ever assigned to, with the person who signed and
 * their email and phone off the e-signature block.
 *
 * Actions (a member's JWT, roles owner/admin/dispositions unless noted):
 *   status  { workspace_id }                 → { config, drive_connected, email, entities, deals }
 *   save    { workspace_id, folder }         owner/admin: the Drive folder (a link or an id) to read
 *   run     { workspace_id }                 one pass now (the tree is walked in budgeted steps; run again to continue)
 *   harvest {}                               service role (pg_cron, dispo_contracts_kick): every workspace with a folder
 *   reparse { workspace_id, file_id }        read one Drive file again
 *
 * How a pass works: the folder tree is walked breadth-first and remembered
 * in dispo_contract_sync.state (folders seen, files queued), so a 100-second
 * run picks up where the last stopped. A PDF whose name or folder says
 * contract, assignment, PSA, AB, BC or executed is downloaded (Drive
 * files.get?alt=media, the same read-only grant drive-photos uses) and
 * read by Claude (_shared/contract-parties.ts). A file that is not an
 * assignment is remembered so it is never read twice; a contract already in
 * wholesaler_deals (by Drive file id) is skipped unless reparsed.
 *
 * Env: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (the Drive grant), ANTHROPIC_API_KEY.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';
import { SCOPE, accessFor, has } from '../_shared/google.ts';
import { type DriveItem, FOLDER_MIME, folderAddress, folderIdOf } from '../_shared/drive-tree.ts';
import { partiesFromPdf, type ParsedContract } from '../_shared/contract-parties.ts';
import { type ContractParties, entityDisplay, entityKey, familyOf, legOf, splitProperty } from '../_shared/genius-methods.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const DRIVE = 'https://www.googleapis.com/drive/v3';
const RUN_MS = 100_000;
const OWNER_RUN_MS = 45_000;
const CALLS = 300;
const MAX_PDF = 15 * 1024 * 1024;
/** Optional default Drive folder (DISPO_CONTRACTS_FOLDER_ID); each workspace normally picks its own in Settings. */
const DEFAULT_FOLDER = Deno.env.get('DISPO_CONTRACTS_FOLDER_ID') ?? '';
const OURS = /acme holdings|acme homes/i;

type State = {
  queue?: string[]; folders?: Record<string, string>; seen?: Record<string, number>; skipped?: Record<string, string>; pass_started?: string | null; done_at?: string | null;
};

class Drive {
  calls = 0;
  constructor(private token: string) {}
  async get(path: string, params: Record<string, string>): Promise<Any> {
    if (this.calls >= CALLS) throw new Error('drive: request budget for this run used');
    this.calls++;
    const res = await fetch(`${DRIVE}${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`, { headers: { Authorization: `Bearer ${this.token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive ${res.status}: ${body?.error?.message ?? 'error'}`);
    return body;
  }
  async children(id: string): Promise<DriveItem[]> {
    const out: DriveItem[] = [];
    let pageToken = '';
    do {
      const b = await this.get('/files', {
        q: `'${id}' in parents and trashed = false`, includeItemsFromAllDrives: 'true', pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)', ...(pageToken ? { pageToken } : {}),
      });
      out.push(...(b.files ?? []));
      pageToken = b.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }
  async bytes(id: string): Promise<Uint8Array> {
    if (this.calls >= CALLS) throw new Error('drive: request budget for this run used');
    this.calls++;
    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Drive ${res.status} reading the file`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async meta(id: string): Promise<DriveItem> {
    return await this.get(`/files/${encodeURIComponent(id)}`, { fields: 'id,name,mimeType,modifiedTime,size,webViewLink,parents' });
  }
}

/** A PDF worth reading: an assignment or a purchase contract by name, or any PDF in a folder named for a house or a contract. */
function wantsRead(f: DriveItem, folderName: string): boolean {
  if (f.mimeType !== 'application/pdf') return false;
  const n = f.name.toLowerCase();
  if (/\b(invoice|hud|settlement|title commitment|memo|w-?9|seller info|information form|pcs|disclosure|amendment|termination|release|wire|cd\b|closing statement|deed\b|affidavit|survey|inspection|photos?)\b/.test(n)) return false;
  if (/\b(assignment|assign|contract|psa|agreement|executed|ab\b|bc\b|a-b|b-c|one to four|trec)\b/.test(n)) return true;
  return !!folderAddress(folderName) && /contract|agreement/.test(n);
}

const ensureEntity = async (admin: SupabaseClient, ws: number, name: string | null, patch: Record<string, unknown>): Promise<number | null> => {
  if (!name) return null;
  const display = entityDisplay(name);
  const key = entityKey(display);
  if (!key) return null;
  const { data: have } = await admin.from('wholesaler_entities').select('id, parent_id, email, phone, contact_name').eq('workspace_id', ws).eq('name_key', key).maybeSingle();
  if (have) {
    const upd: Record<string, unknown> = {};
    for (const k of ['email', 'phone', 'contact_name', 'state', 'county'] as const) if (patch[k] && !(have as Any)[k]) upd[k] = patch[k];
    if (Object.keys(upd).length) await admin.from('wholesaler_entities').update(upd).eq('id', have.id);
    return have.id;
  }
  // A shell of a known brand points at the family row, made on demand.
  const fam = familyOf(display);
  let parent: number | null = null;
  if (fam && entityKey(fam) !== key) {
    const { data: p } = await admin.from('wholesaler_entities').upsert({ workspace_id: ws, name: fam, name_key: entityKey(fam), kind: 'wholesaler', source: 'drive' }, { onConflict: 'workspace_id,name_key' }).select('id').maybeSingle();
    parent = p?.id ?? null;
  }
  const { data } = await admin.from('wholesaler_entities').upsert({ workspace_id: ws, name: display, name_key: key, parent_id: parent, source: 'drive', ...patch }, { onConflict: 'workspace_id,name_key' }).select('id').maybeSingle();
  return data?.id ?? null;
};

/** One parsed contract into the database. Returns what it became. */
async function fileContract(admin: SupabaseClient, ws: number, f: DriveItem, p: ContractParties, dealId: number | null): Promise<{ leg: string; assignor: string | null; assignee: string | null }> {
  const leg = legOf(p, OURS);
  const addr = splitProperty(p.property);
  const assignorId = await ensureEntity(admin, ws, p.assignor, { contact_name: p.assignor_person, email: p.assignor_email, phone: p.assignor_phone, state: addr.state });
  const assigneeId = await ensureEntity(admin, ws, p.assignee, { contact_name: p.assignee_person, email: p.assignee_email, phone: p.assignee_phone, state: addr.state });
  await admin.from('wholesaler_deals').upsert({
    workspace_id: ws, assignor_id: assignorId, assignee_id: assigneeId,
    assignor_name: p.assignor ? entityDisplay(p.assignor) : null, assignee_name: p.assignee ? entityDisplay(p.assignee) : null,
    assignor_person: p.assignor_person, assignor_email: p.assignor_email, assignor_phone: p.assignor_phone,
    assignee_person: p.assignee_person, assignee_email: p.assignee_email, assignee_phone: p.assignee_phone,
    property_address: addr.address ?? p.property, city: addr.city, state: addr.state, zip: addr.zip,
    purchase_price: p.purchase_price, assignment_fee: p.assignment_fee, total_price: p.total_price,
    contract_date: p.contract_date, closing_date: p.closing_date, title_company: p.title_company,
    leg, source: 'drive', source_id: f.id, source_url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`, deal_id: dealId,
    raw: { file: f.name, template: p.template, original_seller: p.original_seller, modified: f.modifiedTime ?? null },
  }, { onConflict: 'workspace_id,source,source_id' });
  return { leg, assignor: p.assignor, assignee: p.assignee };
}

/** The deal on this address, when CLOZR has one (same rule drive-photos uses: the address key, else the only property on that street number). */
async function dealFor(admin: SupabaseClient, ws: number, line: string | null): Promise<number | null> {
  const a = line ? folderAddress(line) : null;
  if (!a) return null;
  const { data: props } = await admin.from('properties').select('id').eq('workspace_id', ws).ilike('line1', `${a.line1}%`).limit(2);
  if (!props || props.length !== 1) return null;
  const { data: deal } = await admin.from('deals').select('id').eq('workspace_id', ws).eq('property_id', props[0].id).is('archived_at', null).order('id', { ascending: false }).limit(1).maybeSingle();
  return deal?.id ?? null;
}

/** The row's own account while it still exists and allows Drive, else the first member who does. */
async function driveAccountFor(admin: SupabaseClient, ws: number, accountId: number | null): Promise<Any | null> {
  if (accountId) {
    const { data } = await admin.from('google_accounts').select('*').eq('id', accountId).eq('status', 'active').maybeSingle();
    if (data && has(data, SCOPE.driveRead)) return data;
  }
  const { data } = await admin.from('google_accounts').select('*').eq('workspace_id', ws).eq('status', 'active').order('id');
  return ((data ?? []) as Any[]).find((a) => has(a, SCOPE.driveRead)) ?? null;
}

async function harvestRun(admin: SupabaseClient, row: Any, deadline: number): Promise<Record<string, unknown>> {
  const ws = Number(row.workspace_id);
  // A seeded row has no account yet, and a connection can be removed later:
  // bind whichever member has allowed Drive, so the harvest never waits on a
  // settings click the migration could not make.
  const account = await driveAccountFor(admin, ws, row.account_id);
  if (!account) return { workspace_id: ws, error: 'Nobody has connected Drive yet. Settings → Google → Connect Drive (read-only).' };
  if (account.id !== row.account_id) await admin.from('dispo_contract_sync').update({ account_id: account.id }).eq('workspace_id', ws);
  const token = await accessFor(admin, account);
  if (!token) return { workspace_id: ws, error: `Google wants ${account.email} to approve CLOZR again (Settings → Google).` };
  const now = new Date().toISOString();
  const { data: lease } = await admin.from('dispo_contract_sync').update({ lock_until: new Date(deadline + 120_000).toISOString() })
    .eq('workspace_id', ws).or(`lock_until.is.null,lock_until.lt."${now}"`).select('workspace_id');
  if (!lease?.length) return { workspace_id: ws, skipped: 'A contract harvest is already running.' };

  const drive = new Drive(token);
  const root = String(row.root_folder_id);
  const s: State = row.state ?? {};
  const folders = s.folders ?? {};
  const seen = s.seen ?? {};
  const skipped = s.skipped ?? {};
  let queue = s.queue ?? [];
  if (!folders[root] && !queue.length) { folders[root] = row.root_name ?? 'Dispositions'; queue = [root]; s.pass_started = now; s.done_at = null; }
  const c = { folders: 0, files: 0, read: 0, filed: 0, skipped: 0, errors: 0 };
  const notes: string[] = [];
  const out = () => Date.now() > deadline || drive.calls >= CALLS - 5;
  const { data: known } = await admin.from('wholesaler_deals').select('source_id').eq('workspace_id', ws).eq('source', 'drive');
  const filed = new Set(((known ?? []) as Any[]).map((d) => String(d.source_id)));
  let error: string | null = null;
  const pending: { f: DriveItem; folder: string }[] = [];
  try {
    while (queue.length && !out()) {
      const id = queue[0];
      const name = folders[id] ?? '';
      const kids = await drive.children(id);
      c.folders++;
      for (const k of kids) {
        if (k.mimeType === FOLDER_MIME) { folders[k.id] = k.name; if (!seen[k.id]) queue.push(k.id); continue; }
        c.files++;
        if (filed.has(k.id) || skipped[k.id]) continue;
        if (!wantsRead(k, name)) continue;
        pending.push({ f: k, folder: name });
      }
      seen[id] = Date.now();
      queue = queue.slice(1);
      // Read as we go, so a long tree still lands contracts every run.
      while (pending.length && !out()) {
        const { f, folder } = pending.shift()!;
        if (Number(f.size ?? 0) > MAX_PDF) { skipped[f.id] = 'too large'; c.skipped++; continue; }
        try {
          const bytes = await drive.bytes(f.id);
          const parsed = await partiesFromPdf(bytes, `${folder} / ${f.name}`);
          c.read++;
          if (!parsed.is_assignment || (!parsed.assignor && !parsed.assignee)) { skipped[f.id] = 'not an assignment'; c.skipped++; continue; }
          const dealId = await dealFor(admin, ws, parsed.property ?? folder);
          await fileContract(admin, ws, f, parsed, dealId);
          filed.add(f.id);
          c.filed++;
        } catch (e) {
          c.errors++;
          const msg = (e as Error).message;
          if (/ANTHROPIC_API_KEY/.test(msg)) { error = msg; break; }
          skipped[f.id] = `error: ${msg.slice(0, 120)}`;
          if (notes.length < 5) notes.push(`${f.name}: ${msg.slice(0, 120)}`);
        }
      }
      if (error) break;
    }
    // Anything listed but not yet read goes back on the queue by its folder, so the next run reads it.
    for (const { f } of pending) if (f.parents?.[0] && !queue.includes(f.parents[0])) { queue.push(f.parents[0]); delete seen[f.parents[0]]; }
    if (!queue.length && !error) s.done_at = new Date().toISOString();
  } catch (e) {
    error = (e as Error).message;
  }
  const { count: entities } = await admin.from('wholesaler_entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  await admin.from('dispo_contract_sync').update({
    state: { ...s, queue, folders, seen, skipped }, last_run_at: new Date().toISOString(), last_error: error, lock_until: null,
    files_seen: (row.files_seen ?? 0) + c.files, contracts_read: (row.contracts_read ?? 0) + c.read,
    last_notes: { ...c, entities: entities ?? 0, queued: queue.length, notes, done: !queue.length && !error },
  }).eq('workspace_id', ws);
  return { workspace_id: ws, ...c, queued: queue.length, done: !queue.length && !error, error, notes };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  let body: Any;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const action = String(body.action ?? '');

  if (action === 'harvest') {
    // The cron's key (vault clozr_service_role_key) and this runtime's env key can be
    // different issues of the service key; accept exactly either one (migration 193).
    if (!bearer || (bearer !== serviceKey && (await admin.rpc('is_cron_key', { p_key: bearer })).data !== true)) return json({ error: 'service role only' }, 403);
    const { data: rows } = await admin.from('dispo_contract_sync').select('*').eq('enabled', true).order('last_run_at', { ascending: true, nullsFirst: true });
    const list = (rows ?? []) as Any[];
    const deadline = Date.now() + RUN_MS;
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length && Date.now() < deadline; i++) {
      const r = await harvestRun(admin, list[i], Date.now() + (deadline - Date.now()) / (list.length - i)).catch((e) => ({ workspace_id: list[i].workspace_id, error: (e as Error).message }));
      console.log('dispo-contracts', JSON.stringify(r).slice(0, 500));
      results.push(r);
    }
    return json({ ok: true, results });
  }

  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const ws = Number(body.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const role = String(member.role);
  const rl = await rateLimit(admin, `dispo-contracts:${who.user.id}`, 30, 60);
  if (!rl.allowed) return tooMany(cors, rl);

  const { data: row } = await admin.from('dispo_contract_sync').select('*').eq('workspace_id', ws).maybeSingle();
  const driveAccount = async () => {
    const { data } = await admin.from('google_accounts').select('id, email, scopes, status').eq('workspace_id', ws).eq('status', 'active').order('id');
    return ((data ?? []) as Any[]).find((a) => (a.scopes ?? []).includes(SCOPE.driveRead)) ?? null;
  };

  if (action === 'status') {
    const acct = await driveAccount();
    const [{ count: entities }, { count: deals }, { count: buyers }] = await Promise.all([
      admin.from('wholesaler_entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws),
      admin.from('wholesaler_deals').select('id', { count: 'exact', head: true }).eq('workspace_id', ws),
      admin.from('wholesaler_entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).in('kind', ['buyer', 'both']),
    ]);
    return json({ config: row ? { folder: row.root_folder_id, root_name: row.root_name, enabled: row.enabled, last_run_at: row.last_run_at, last_error: row.last_error, last_notes: row.last_notes, files_seen: row.files_seen, contracts_read: row.contracts_read, queued: (row.state?.queue ?? []).length, done_at: row.state?.done_at ?? null } : null,
      drive_connected: !!acct, email: acct?.email ?? null, entities: entities ?? 0, deals: deals ?? 0, buyers: buyers ?? 0, default_folder: DEFAULT_FOLDER });
  }

  if (!['owner', 'admin', 'dispositions'].includes(role)) return json({ error: 'owners, admins and dispositions only' }, 403);

  if (action === 'save') {
    if (!['owner', 'admin'].includes(role)) return json({ error: 'owners and admins only' }, 403);
    const folder = folderIdOf(String(body.folder ?? DEFAULT_FOLDER)) ?? DEFAULT_FOLDER;
    if (!folder) return json({ error: 'Pick the Drive folder your contracts live in.' }, 422);
    const acct = await driveAccount();
    if (!acct) return json({ error: 'Connect Drive first: Settings → Google → Connect Drive (read-only).' }, 409);
    let rootName: string | null = null;
    try { const token = await accessFor(admin, acct); if (token) rootName = (await new Drive(token).meta(folder)).name ?? null; } catch (e) { return json({ error: `Drive could not open that folder: ${(e as Error).message}` }, 422); }
    await admin.from('dispo_contract_sync').upsert({ workspace_id: ws, account_id: acct.id, root_folder_id: folder, root_name: rootName, enabled: true, state: {}, last_error: null, lock_until: null }, { onConflict: 'workspace_id' });
    return json({ ok: true, folder, root_name: rootName });
  }

  if (action === 'run') {
    let cfg = row;
    if (!cfg) {
      if (!DEFAULT_FOLDER) return json({ error: 'Pick the Drive folder your contracts live in first.' }, 409);
      const acct = await driveAccount();
      if (!acct) return json({ error: 'Connect Drive first: Settings → Google → Connect Drive (read-only).' }, 409);
      const { data } = await admin.from('dispo_contract_sync').upsert({ workspace_id: ws, account_id: acct.id, root_folder_id: DEFAULT_FOLDER, root_name: 'Dispositions', enabled: true }, { onConflict: 'workspace_id' }).select('*').maybeSingle();
      cfg = data;
    }
    if (!cfg) return json({ error: 'No contract harvest is set up for this workspace.' }, 409);
    const r = await harvestRun(admin, cfg, Date.now() + OWNER_RUN_MS);
    return json({ ok: !r.error, ...r });
  }

  if (action === 'reparse') {
    if (!row?.account_id) return json({ error: 'Set up the harvest first.' }, 409);
    const fileId = String(body.file_id ?? '').trim();
    if (!fileId) return json({ error: 'file_id is required' }, 422);
    const { data: account } = await admin.from('google_accounts').select('*').eq('id', row.account_id).maybeSingle();
    const token = account ? await accessFor(admin, account) : null;
    if (!token) return json({ error: 'Google wants the Drive connection approved again (Settings → Google).' }, 409);
    const drive = new Drive(token);
    const f = await drive.meta(fileId);
    const parsed: ParsedContract = await partiesFromPdf(await drive.bytes(fileId), f.name);
    if (!parsed.is_assignment) return json({ ok: false, parsed, note: 'Claude did not read this as an assignment.' });
    const filedAs = await fileContract(admin, ws, f, parsed, await dealFor(admin, ws, parsed.property));
    return json({ ok: true, parsed, ...filedAs });
  }

  return json({ error: 'unknown action' }, 400);
});
