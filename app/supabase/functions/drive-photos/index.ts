/**
 * POST /drive-photos — a deal's Google Drive photo folder as photos on the deal.
 *
 * Podio left each deal's photos as a Drive folder link (a Files row,
 * deals.photos_url, or a "Photos:" line in the deal's or seller's notes), and
 * an <img> cannot show a folder, so the record drew Street View. This reads
 * the folder and its subfolders the way COMPR's resolver does
 * (_shared/drive-photos.ts) and writes one photo row per image through
 * drive_photos_apply (migration 120). Nothing is copied: each row is Google's
 * own image URL, and the folder stays the source of truth.
 *
 * Deal:  { action: 'deal', workspace_id, deal_id, force? } as a member who can
 *        see the deal → { ok, linked, photos, urls, hero_url, failed }. A deal
 *        with COMPR photos is skipped (COMPR's set is the gallery) unless
 *        force, which the Files card's button sends.
 * Sync:  { action: 'sync', limit? } service role only, from the
 *        clozr-drive-photo-sync cron → { ok, deals, synced, photos, failed }.
 *
 * The deals folder (migration 139, docs/drive-sync.md):
 *   { action: 'tree' }  service role, the clozr-drive-tree-sync cron: every workspace's folder
 *   { action: 'tree_status', workspace_id }            → { config, drive_connected, email }
 *   { action: 'tree_save', workspace_id, folder }      owner/admin: the folder (link or id), read
 *        with the caller's own Google connection (Drive read-only), then one run
 *   { action: 'tree_run', workspace_id }               owner/admin: one run now
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import { driveLinks, resolveDrivePhotos } from '../_shared/drive-photos.ts';
import { type DriveItem, FOLDER_MIME, fileRow, folderAddress, folderIdOf, galleryFolder } from '../_shared/drive-tree.ts';
import { SCOPE, accessFor, has } from '../_shared/google.ts';

type Any = any;
type Outcome = { linked: boolean; skipped?: 'compr'; photos: number; urls: string[]; hero_url: string | null; failed: number };

async function syncDeal(admin: Any, dealId: number, force: boolean): Promise<Outcome> {
  const none: Outcome = { linked: false, photos: 0, urls: [], hero_url: null, failed: 0 };
  if (!force) {
    const { count } = await admin.from('deal_files').select('id', { count: 'exact', head: true })
      .eq('deal_id', dealId).eq('kind', 'photo').eq('source', 'compr');
    if (count) return { ...none, linked: true, skipped: 'compr' };
  }
  const { data: links, error } = await admin.rpc('deal_photo_links', { p_deal_id: dealId });
  if (error) throw new Error(error.message);
  const drive = driveLinks(((links ?? []) as string[]).join('\n'));
  if (!drive.length) return none;

  const r = await resolveDrivePhotos(drive);
  // Every folder failed (unshared, deleted, Google erroring): keep what the
  // deal already shows rather than wiping it on a bad minute.
  if (!r.photos.length && r.failed) {
    await admin.from('deals').update({ drive_photos_synced_at: new Date().toISOString() }).eq('id', dealId);
    return { ...none, linked: true, failed: r.failed };
  }
  const { data: applied, error: e2 } = await admin.rpc('drive_photos_apply', { p_deal_id: dealId, p_photos: r.photos });
  if (e2) throw new Error(e2.message);
  const a = (applied ?? {}) as { photos?: number; hero_url?: string | null };
  const hero = a.hero_url ?? null;
  const urls = r.photos.map((p) => p.url);
  return {
    linked: true, photos: a.photos ?? 0, hero_url: hero, failed: r.failed,
    urls: hero ? [hero, ...urls.filter((u) => u !== hero)] : urls,
  };
}

// ---- the deals folder (migration 139, docs/drive-sync.md) ---------------------
//
// A workspace's Drive deals folder, read with a teammate's own Google
// connection (Drive read-only). The first pass lists every folder from the
// top; after that each run asks Drive for what changed since the last one.
// A folder named for a property ("2016 Meadow lane, Richmond, Tx 77469") is
// matched to the deal on that property, and everything under it is filed on
// that deal — documents as files, pictures (outside Comps / Docs subfolders)
// as photos. Rows are only ever added: a file deleted in Drive stays listed.

const DRIVE = 'https://www.googleapis.com/drive/v3';
const TREE_BUDGET_MS = 100_000;
const TREE_OWNER_MS = 40_000;
const TREE_CALLS = 400;
/** folder id → [parent id, deal id (0 = none, -1 = an address no deal matched, -2 = not under the deals folder)]. */
type Folders = Record<string, [string, number]>;
type TreeState = { folders?: Folders; queue?: string[]; since?: string | null; pass_started?: string | null; unmatched?: Record<string, string> };
type TreeCounts = { folders: number; files: number; photos: number; matched: number; unmatched: number; calls: number };

class Drive {
  calls = 0;
  constructor(private token: string) {}
  async get(path: string, params: Record<string, string>): Promise<Any> {
    if (this.calls >= TREE_CALLS) throw new Error('drive: request budget for this run used');
    this.calls++;
    const res = await fetch(`${DRIVE}${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`, { headers: { Authorization: `Bearer ${this.token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive ${res.status}: ${body?.error?.message ?? 'error'}`);
    return body;
  }
  /** Every child of a folder (all pages). */
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
}

/** The deal on the property this address is: the database's address key, else the one property on that number and street. */
async function dealForAddress(admin: Any, ws: number, a: NonNullable<ReturnType<typeof folderAddress>>): Promise<number> {
  const { data: key } = await admin.rpc('address_key', { p_line1: a.line1, p_city: a.city ?? '', p_state: a.state ?? '', p_zip: a.zip ?? '' });
  let ids: number[] = key ? ((await admin.from('properties').select('id').eq('workspace_id', ws).eq('address_key', key).limit(5)).data ?? []).map((r: Any) => r.id) : [];
  if (!ids.length) {
    const m = /^(\d+[A-Za-z]?)\s+([A-Za-z0-9]+)/.exec(a.line1);
    if (m) {
      let q = admin.from('properties').select('id').eq('workspace_id', ws).ilike('line1', `${m[1]} ${m[2].replace(/[%_\\]/g, '')}%`);
      if (a.state) q = q.eq('state', a.state);
      const rows = (await q.limit(3)).data ?? [];
      if (rows.length === 1) ids = [rows[0].id];
    }
  }
  if (!ids.length) return -1;
  const { data } = await admin.from('deals').select('id').eq('workspace_id', ws).in('property_id', ids).order('created_at', { ascending: false }).limit(1);
  return data?.[0]?.id ?? -1;
}

/** File what is under deal folders; rows the deal already has (same Drive id or same photo URL) are left as they are. */
async function fileOnDeals(admin: Any, rows: Record<string, unknown>[], c: TreeCounts) {
  if (!rows.length) return;
  const deals = [...new Set(rows.map((r) => r.deal_id as number))];
  const { data: have } = await admin.from('deal_files').select('deal_id,source_id,url').in('deal_id', deals)
    .or(`source_id.in.(${rows.map((r) => `"${r.source_id}"`).join(',')}),url.in.(${rows.map((r) => `"${r.url}"`).join(',')})`);
  const seen = new Set((have ?? []).flatMap((h: Any) => [`${h.deal_id}|${h.source_id}`, `${h.deal_id}|${h.url}`]));
  const fresh = rows.filter((r) => !seen.has(`${r.deal_id}|${r.source_id}`) && !seen.has(`${r.deal_id}|${r.url}`));
  if (!fresh.length) return;
  const { error } = await admin.from('deal_files').insert(fresh);
  // One duplicate fails the batch: then one at a time, skipping the duplicates.
  if (error) for (const r of fresh) await admin.from('deal_files').insert(r).then(() => null, () => null);
  for (const r of fresh) r.kind === 'photo' ? c.photos++ : c.files++;
}

async function treeRun(admin: Any, row: Any, deadline: number) {
  const ws = Number(row.workspace_id);
  const { data: account } = await admin.from('google_accounts').select('*').eq('id', row.account_id).maybeSingle();
  if (!account) return { workspace_id: ws, error: 'The Google connection used for Drive is gone. Connect Drive again from Settings → Google.' };
  if (!has(account, SCOPE.driveRead)) return { workspace_id: ws, error: `${account.email} has not allowed Drive. Settings → Google → Connect Drive.` };
  const token = await accessFor(admin, account);
  if (!token) return { workspace_id: ws, error: `Google wants ${account.email} to approve CLOZR again (Settings → Google).` };

  const now = new Date().toISOString();
  const { data: lease } = await admin.from('drive_sync').update({ lock_until: new Date(deadline + 120_000).toISOString() })
    .eq('workspace_id', ws).or(`lock_until.is.null,lock_until.lt."${now}"`).select('workspace_id');
  if (!lease?.length) return { workspace_id: ws, skipped: 'A Drive sync is already running.' };

  const drive = new Drive(token);
  const root = String(row.root_folder_id);
  const s: TreeState = row.state ?? {};
  const folders: Folders = s.folders ?? {};
  let queue = s.queue ?? [];
  const unmatched = s.unmatched ?? {};
  if (!folders[root]) { folders[root] = ['', 0]; queue = [root]; s.since = null; s.pass_started = now; }
  const c: TreeCounts = { folders: 0, files: 0, photos: 0, matched: 0, unmatched: 0, calls: 0 };
  const out = () => Date.now() > deadline || drive.calls >= TREE_CALLS - 5;
  const nameOf: Record<string, string> = {};

  /** A folder just met under `parent`: its deal (its own address, else its parent's) and whether its pictures are gallery photos. */
  const place = async (f: DriveItem, parent: string) => {
    const parentDeal = folders[parent]?.[1] ?? 0;
    let deal = parentDeal > 0 ? parentDeal : 0;
    if (deal === 0) {
      const a = folderAddress(f.name);
      if (a) {
        deal = await dealForAddress(admin, ws, a);
        if (deal > 0) c.matched++; else { unmatched[f.id] = f.name; c.unmatched++; }
      }
    }
    folders[f.id] = [parent, deal];
    nameOf[f.id] = f.name;
    return deal;
  };
  const gallery = (folderId: string) => galleryFolder(nameOf[folderId] ?? '');

  let error: string | null = null;
  try {
    // Address folders no deal matched before: the deal may exist now (the Podio backfill is still arriving).
    for (const [id, name] of Object.entries(unmatched).slice(0, 40)) {
      if (out()) break;
      const a = folderAddress(name);
      const deal = a ? await dealForAddress(admin, ws, a) : -1;
      if (deal > 0) { delete unmatched[id]; if (folders[id]) folders[id][1] = deal; queue.push(id); c.matched++; }
    }

    // Folders to list in full: the first pass, and folders that arrived or were matched since.
    while (queue.length && !out()) {
      const id = queue[0];
      const deal = folders[id]?.[1] ?? 0;
      const kids = await drive.children(id);
      const rows: Record<string, unknown>[] = [];
      for (const k of kids) {
        if (k.mimeType === FOLDER_MIME) {
          nameOf[k.id] = k.name;
          await place(k, id);
          queue.push(k.id);
          c.folders++;
        } else if (deal > 0) {
          const r = fileRow(k, ws, deal, gallery(id));
          if (r) rows.push(r);
        }
      }
      await fileOnDeals(admin, rows, c);
      queue.shift();
    }
    if (!queue.length && !s.since) s.since = s.pass_started ?? now;

    // After the first pass: what Drive changed since the last run, placed by its parents.
    if (!queue.length && s.since && !out()) {
      const from = new Date(Date.parse(s.since) - 10 * 60_000).toISOString();
      const scope: Record<string, string> = row.drive_id ? { corpora: 'drive', driveId: String(row.drive_id) } : { corpora: 'allDrives' };
      let pageToken = '';
      let complete = true;
      do {
        if (out()) { complete = false; break; }
        const b = await drive.get('/files', {
          q: `modifiedTime > '${from}' and trashed = false`, includeItemsFromAllDrives: 'true', pageSize: '500', orderBy: 'modifiedTime',
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)', ...scope, ...(pageToken ? { pageToken } : {}),
        });
        const rows: Record<string, unknown>[] = [];
        for (const f of (b.files ?? []) as DriveItem[]) {
          const parent = f.parents?.[0];
          if (!parent || f.id === root) continue;
          // Climb to a folder already placed; whatever is not under the deals folder is remembered as outside.
          const chain: Array<{ id: string; name: string; parent: string }> = [];
          let cur = parent;
          while (!folders[cur] && chain.length < 12 && !out()) {
            const meta = await drive.get(`/files/${cur}`, { fields: 'id,name,parents' }).catch(() => null);
            const up = meta?.parents?.[0] ?? '';
            chain.push({ id: cur, name: meta?.name ?? '', parent: up });
            if (!up) break;
            cur = up;
          }
          const inside = !!folders[cur] && folders[cur][1] !== -2;
          for (const link of chain.reverse()) {
            if (inside) { await place({ id: link.id, name: link.name, mimeType: FOLDER_MIME }, link.parent); queue.push(link.id); }
            else folders[link.id] = ['', -2];
          }
          if (!inside) continue;
          if (f.mimeType === FOLDER_MIME) {
            if (!folders[f.id]) { await place(f, parent); queue.push(f.id); c.folders++; }
            continue;
          }
          const deal = folders[parent]?.[1] ?? 0;
          if (deal > 0) { const r = fileRow(f, ws, deal, gallery(parent)); if (r) rows.push(r); }
        }
        await fileOnDeals(admin, rows, c);
        pageToken = b.nextPageToken ?? '';
      } while (pageToken);
      if (complete) s.since = now;
    }
  } catch (e) {
    error = (e as Error).message;
    console.error('drive tree', ws, error);
  }
  c.calls = drive.calls;
  const notes = {
    at: now, counts: c, first_pass: !s.since, folders_left: queue.length,
    unmatched: Object.values(unmatched).slice(0, 50), unmatched_total: Object.keys(unmatched).length,
    deal_folders: Object.values(folders).filter(([, d]) => d > 0).length,
  };
  await admin.from('drive_sync').update({
    state: { folders, queue, since: s.since ?? null, pass_started: s.pass_started ?? null, unmatched },
    last_error: error, last_notes: notes, lock_until: null, updated_at: new Date().toISOString(),
    ...(error ? {} : { last_run_at: new Date().toISOString() }),
  }).eq('workspace_id', ws);
  return { workspace_id: ws, error, ...notes };
}

/** Owner / admin of the workspace, from the caller's own JWT. */
async function adminOf(url: string, authHeader: string, admin: Any, ws: number): Promise<string | null> {
  const asCaller: Any = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return null;
  const { data: me } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  return me && ['owner', 'admin'].includes(me.role) ? who.user.id : null;
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const admin: Any = createClient(url, serviceKey, { auth: { persistSession: false } });
  // Exactly the env key or the cron's vault key (they can be different issues).
  const internal = await isServiceCaller(admin, bearer);

  let body: { action?: string; workspace_id?: number; deal_id?: number; force?: boolean; limit?: number; folder?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  try {
    if (body.action === 'sync') {
      if (!internal) return json({ error: 'service only' }, 403);
      const limit = Math.max(1, Math.min(40, Number(body.limit) || 25));
      const { data: queue, error } = await admin.rpc('drive_photo_queue', { p_limit: limit });
      if (error) throw new Error(error.message);
      const rows = (queue ?? []) as { deal_id: number }[];
      let synced = 0; let photos = 0; const failed: number[] = [];
      // Four deals at a time; each one already reads its folders four at a time.
      for (let i = 0; i < rows.length; i += 4) {
        await Promise.all(rows.slice(i, i + 4).map(async ({ deal_id }) => {
          try {
            const out = await syncDeal(admin, deal_id, false);
            if (out.photos) { synced++; photos += out.photos; }
          } catch (e) {
            failed.push(deal_id);
            console.error('drive photo sync', deal_id, (e as Error).message);
            await admin.from('deals').update({ drive_photos_synced_at: new Date().toISOString() }).eq('id', deal_id);
          }
        }));
      }
      console.log('drive photo sync', { deals: rows.length, synced, photos, failed: failed.length });
      return json({ ok: true, deals: rows.length, synced, photos, failed });
    }

    if (body.action === 'tree') {
      if (!internal) return json({ error: 'service only' }, 403);
      const { data: rows } = await admin.from('drive_sync').select('*').eq('enabled', true).not('account_id', 'is', null);
      const list = (rows ?? []) as Any[];
      const run = async () => {
        const deadline = Date.now() + TREE_BUDGET_MS;
        for (const [i, row] of list.entries()) {
          const r = await treeRun(admin, row, Date.now() + (deadline - Date.now()) / (list.length - i)).catch((e) => ({ workspace_id: row.workspace_id, error: (e as Error).message }));
          console.log('drive tree', JSON.stringify(r).slice(0, 500));
        }
      };
      // pg_net gives up after five seconds; the walk carries on past the reply.
      (globalThis as Any).EdgeRuntime?.waitUntil ? (globalThis as Any).EdgeRuntime.waitUntil(run()) : await run();
      return json({ ok: true, workspaces: list.length }, 202);
    }

    if (body.action === 'tree_status' || body.action === 'tree_save' || body.action === 'tree_run') {
      const ws = Number(body.workspace_id);
      if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
      const userId = await adminOf(url, authHeader, admin, ws);
      if (!userId) return json({ error: 'only an owner or admin can set up the Drive folder' }, 403);
      const { data: account } = await admin.from('google_accounts').select('*').eq('workspace_id', ws).eq('user_id', userId).maybeSingle();
      const { data: cfg } = await admin.from('drive_sync').select('*').eq('workspace_id', ws).maybeSingle();

      if (body.action === 'tree_status') {
        const { state: _s, lock_until, ...config } = (cfg ?? {}) as Any;
        return json({
          config: cfg ? { ...config, running: !!(lock_until && Date.parse(lock_until) > Date.now()) } : null,
          email: account?.email ?? null, drive_connected: !!account && has(account, SCOPE.driveRead),
        });
      }
      if (body.action === 'tree_save') {
        if (!account || !has(account, SCOPE.driveRead)) return json({ error: 'Connect Drive first (Settings → Google → Connect Drive).' }, 409);
        const id = folderIdOf(String(body.folder ?? ''));
        if (!id) return json({ error: 'Paste the folder link from Google Drive (drive.google.com/drive/folders/…).' }, 422);
        const token = await accessFor(admin, account);
        if (!token) return json({ error: 'Google wants this connection approved again (Settings → Google).' }, 409);
        const meta = await new Drive(token).get(`/files/${id}`, { fields: 'id,name,mimeType,driveId' }).catch((e) => ({ error: (e as Error).message }));
        if (meta.error || meta.mimeType !== FOLDER_MIME) return json({ error: `${account.email} cannot open that folder in Drive${meta.error ? ` (${meta.error})` : ''}.` }, 422);
        const { error } = await admin.from('drive_sync').upsert({
          workspace_id: ws, account_id: account.id, root_folder_id: id, root_name: meta.name, drive_id: meta.driveId ?? null,
          enabled: true, state: cfg?.root_folder_id === id ? cfg.state : {}, last_error: null, updated_at: new Date().toISOString(),
        }, { onConflict: 'workspace_id' });
        if (error) throw new Error(error.message);
      } else if (!cfg) return json({ error: 'No Drive folder set yet.' }, 409);
      const { data: row } = await admin.from('drive_sync').select('*').eq('workspace_id', ws).single();
      return json({ ok: true, ...(await treeRun(admin, row, Date.now() + TREE_OWNER_MS)) });
    }

    if (body.action === 'deal') {
      const workspaceId = Number(body.workspace_id);
      const dealId = Number(body.deal_id);
      if (!Number.isFinite(workspaceId) || !Number.isFinite(dealId)) return json({ error: 'workspace_id and deal_id are required' }, 422);
      if (!internal) {
        const asCaller: Any = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
          global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
        });
        const { data: who } = await asCaller.auth.getUser();
        if (!who?.user) return json({ error: 'sign in first' }, 401);
        const rl = await rateLimit(admin, `drive-photos:${who.user.id}`, 240, 3600);
        if (!rl.allowed) return tooMany(CORS, rl);
        // Read as the caller: RLS decides whether they may see this deal.
        const { data: seen } = await asCaller.from('deals').select('id').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
        if (!seen) return json({ error: 'deal not found' }, 404);
      }
      return json({ ok: true, ...(await syncDeal(admin, dealId, body.force === true)) });
    }

    return json({ error: 'unknown action' }, 422);
  } catch (e) {
    return serverError(CORS, 'drive-photos', e, 502);
  }
});
