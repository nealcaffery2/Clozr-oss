/**
 * iVueit (ivueit.com): a local Vuer photographs a house on order.
 *
 * The REST API (swaggerhub iVueit/Rest_API_Production 1.5.6): log in with the
 * workspace's API key and secret for a token, create a Vue at an address on a
 * survey template, then read the Vue until it has a submission and copy the
 * submission's photos. Tokens are short lived and an order is a handful of
 * calls, so every request logs in fresh.
 *
 * Used by the ivueit function (order, check, cancel, sweep, setup) and
 * ivueit-webhook (VueCompleted).
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { submissionPhotos } from './ivueit-photos.ts';

export const IVUEIT_PRODUCTION = 'https://prod.data.ivueit.network';

type Any = Record<string, unknown>;

export class IvueitError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

export type IvueitCreds = { key: string; secret: string; base: string; templateId: string | null; hookToken: string | null };

export async function ivueitCreds(admin: SupabaseClient, ws: number): Promise<IvueitCreds> {
  const { data } = await admin.from('workspace_integration_secrets')
    .select('ivueit_api_key, ivueit_secret, ivueit_base_url, ivueit_template_id, ivueit_hook_token')
    .eq('workspace_id', ws).maybeSingle();
  const r = (data ?? {}) as Record<string, string | null>;
  const key = String(r.ivueit_api_key ?? '').trim();
  const secret = String(r.ivueit_secret ?? '').trim();
  if (!key || !secret) throw new IvueitError('iVueit is not connected. An owner adds the API key and secret under Settings → Integrations.', 422);
  return {
    key, secret,
    base: String(r.ivueit_base_url ?? '').trim().replace(/\/+$/, '') || IVUEIT_PRODUCTION,
    templateId: r.ivueit_template_id ? String(r.ivueit_template_id) : null,
    hookToken: r.ivueit_hook_token ? String(r.ivueit_hook_token) : null,
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).slice(0, 300);
    try {
      const j = JSON.parse(t) as Any;
      const m = j.message ?? j.error ?? j.detail;
      if (typeof m === 'string' && m) return m;
    } catch { /* not JSON */ }
    return t || `iVueit answered ${res.status}.`;
  } catch {
    return `iVueit answered ${res.status}.`;
  }
}

export async function ivueitLogin(c: IvueitCreds): Promise<string> {
  const res = await fetch(`${c.base}/login/v1/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey: c.key, secret: c.secret }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const why = await readError(res);
    throw new IvueitError(res.status === 401 || res.status === 403 || /api key|secret|not found|invalid|unauthori/i.test(why)
      ? 'iVueit did not accept the API key and secret. Check them under Settings → Integrations (staging and production keys differ).'
      : `iVueit login failed: ${why}`, 422);
  }
  const j = await res.json().catch(() => ({})) as Any;
  const token = typeof j.body === 'string' ? j.body : typeof j.token === 'string' ? j.token : '';
  if (!token) throw new IvueitError('iVueit login returned no token.');
  return token;
}

/** One API call with the token. `raw` is a body already serialized (nanosecond timestamps). */
export async function ivu(c: IvueitCreds, token: string, path: string, init: { method?: string; body?: unknown; raw?: string } = {}): Promise<Any> {
  const res = await fetch(`${c.base}${path}`, {
    method: init.method ?? 'GET',
    headers: { x_ivueit_auth_token: token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new IvueitError(await readError(res), res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 422 : 502);
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text) as Any; } catch { return { body: text }; }
}

export type IvueitTemplate = { id: string; name: string; description: string; cost: number | null; slaHours: number | null; minutes: number | null };

export async function ivueitTemplates(c: IvueitCreds, token: string): Promise<IvueitTemplate[]> {
  const j = await ivu(c, token, '/api/v1/survey/templates');
  const list = Array.isArray(j.surveys) ? j.surveys as Any[] : Array.isArray(j) ? j as unknown as Any[] : [];
  return list
    .filter((s) => s && s.archived !== true && s.adminArchived !== true && s.published !== false)
    .map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? 'Survey'),
      description: String(s.description ?? ''),
      // autoCostPerVue is in cents in iVueit's portal.
      cost: Number.isFinite(Number(s.autoCostPerVue)) ? Number(s.autoCostPerVue) / 100 : null,
      slaHours: Number.isFinite(Number(s.autoSlaHours)) ? Number(s.autoSlaHours) : null,
      minutes: Number.isFinite(Number(s.durationEstimateInMinutes)) ? Number(s.durationEstimateInMinutes) : null,
    }))
    .filter((s) => s.id);
}

/** The template a Vue runs on: the saved one, else the only one the account has. */
export async function pickTemplate(c: IvueitCreds, token: string, asked?: string | null): Promise<string> {
  if (asked) return asked;
  if (c.templateId) return c.templateId;
  const list = await ivueitTemplates(c, token);
  if (list.length === 1) return list[0].id;
  if (!list.length) throw new IvueitError('This iVueit account has no survey templates yet. Ask iVueit to set up the property photo survey.', 422);
  throw new IvueitError('Pick which iVueit survey to order under Settings → Integrations.', 422);
}

export type VueAddress = { line1: string; city: string; state: string; zip: string };

/** Nanoseconds since the epoch, exact (a JS number loses the low digits). */
const ns = (ms: number) => (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();

export async function createVue(c: IvueitCreds, token: string, o: {
  templateId: string; addr: VueAddress; name: string; notes: string; urgent: boolean; meta: Record<string, string>;
}): Promise<{ vueId: string; batchId: string | null }> {
  const now = Date.now();
  const days = o.urgent ? 2 : 7;
  const body = {
    surveyTemplate: o.templateId,
    startsAt: '08:00',
    endsAt: '19:00',
    publishAt: '__PUBLISH__',
    expiresAt: { value: '__EXPIRES__' },
    isInternal: false,
    repeat: true,
    urgent: o.urgent,
    selectedDays: JSON.stringify({ selectedDays: [0, 1, 2, 3, 4, 5, 6] }),
    backgroundCheckRequired: false,
    highQualityRequired: false,
    includePhotoTimestamp: true,
    vueData: {
      vueName: o.name.slice(0, 120),
      vueNotes: o.notes.slice(0, 2000),
      vueAddress: o.addr.line1,
      vueCity: o.addr.city,
      vueStateOrProvinceTwoCharacterCode: o.addr.state.toUpperCase(),
      vueZipOrPostalCode: o.addr.zip,
      vueCustomMetadata: o.meta,
    },
  };
  const raw = JSON.stringify(body)
    .replace('"__PUBLISH__"', ns(now))
    .replace('"__EXPIRES__"', ns(now + days * 86_400_000));
  const j = await ivu(c, token, '/api/v1/batch/import', { method: 'POST', raw });
  const vueId = String(j.vueId ?? (j.vue as Any | undefined)?.id ?? '');
  if (!vueId) throw new IvueitError('iVueit took the order but returned no Vue id.');
  return { vueId, batchId: j.batchId ? String(j.batchId) : null };
}

const extOf = (mime: string) => (/png/i.test(mime) ? 'png' : /heic/i.test(mime) ? 'heic' : /webp/i.test(mime) ? 'webp' : 'jpg');

export type PhotoOrder = { id: number; workspace_id: number; deal_id: number; vue_id: string | null; status: string; created_at: string; address?: string | null; ordered_by?: string | null };
/**
 * The deal team's bell: acquisitions rep, lead manager, both dispo reps, the
 * TC, and whoever ordered. A deal with no TC on it rings every TC in the
 * workspace, so the file never waits on photos nobody saw.
 */
export async function notifyDealTeam(admin: SupabaseClient, o: { workspace_id: number; deal_id: number; ordered_by?: string | null }, title: string, body: string): Promise<number> {
  const cols = 'owner_id, dispo_rep_id, dispo_rep2_id, tc_rep_id, lead_manager_id, seller_id';
  let deal = (await admin.from('deals').select(cols).eq('id', o.deal_id).maybeSingle()).data as Record<string, unknown> | null;
  if (!deal) deal = (await admin.from('deals').select('owner_id, dispo_rep_id, dispo_rep2_id, tc_rep_id, seller_id').eq('id', o.deal_id).maybeSingle()).data as Record<string, unknown> | null;
  const ids = new Set<string>();
  for (const k of ['owner_id', 'dispo_rep_id', 'dispo_rep2_id', 'tc_rep_id', 'lead_manager_id']) {
    const v = deal?.[k];
    if (typeof v === 'string' && v) ids.add(v);
  }
  if (o.ordered_by) ids.add(o.ordered_by);
  if (!deal?.tc_rep_id) {
    const { data: tcs } = await admin.from('workspace_members').select('user_id').eq('workspace_id', o.workspace_id).eq('role', 'tc');
    for (const t of (tcs ?? []) as { user_id: string }[]) ids.add(t.user_id);
  }
  // Only people still on the workspace.
  const { data: members } = await admin.from('workspace_members').select('user_id').eq('workspace_id', o.workspace_id).in('user_id', [...ids]);
  const to = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id);
  if (!to.length) return 0;
  const sellerId = typeof deal?.seller_id === 'number' ? deal.seller_id : null;
  const { error } = await admin.from('notifications').insert(to.map((user_id) => ({
    workspace_id: o.workspace_id, user_id, category: 'Photos', title: title.slice(0, 120), body: body.slice(0, 500), deal_id: o.deal_id, seller_id: sellerId,
  })));
  if (error) console.error('ivueit notify', error.message);
  return error ? 0 : to.length;
}


/**
 * Read the order's Vue. With a submission: copy its photos and report PDF onto
 * the deal and mark the order completed. Returns the order's status after.
 */
export async function checkOrder(admin: SupabaseClient, c: IvueitCreds, token: string, o: PhotoOrder): Promise<{ status: string; photos: number }> {
  if (!o.vue_id) return { status: o.status, photos: 0 };
  const now = new Date().toISOString();
  let vue: Any;
  try {
    vue = await ivu(c, token, `/api/v1/vue/${encodeURIComponent(o.vue_id)}`);
  } catch (e) {
    if (e instanceof IvueitError && e.status === 404) {
      await admin.from('photo_orders').update({ status: 'canceled', error: 'iVueit no longer has this Vue.', checked_at: now }).eq('id', o.id);
      return { status: 'canceled', photos: 0 };
    }
    throw e;
  }
  const cost = Number(vue.cost);
  const submissionId = String(vue.submissionId ?? '').trim();
  if (!submissionId) {
    const expiresNs = Number(vue.expiresAt);
    const expired = Number.isFinite(expiresNs) && expiresNs > 0 && expiresNs / 1e6 < Date.now();
    await admin.from('photo_orders').update({ checked_at: now, ...(Number.isFinite(cost) ? { cost } : {}) }).eq('id', o.id);
    const { data: lapsed } = expired
      ? await admin.from('photo_orders').update({ status: 'failed', error: 'The order expired before a Vuer shot it. Order again.' })
        .eq('id', o.id).eq('status', 'ordered').select('id')
      : { data: [] };
    if ((lapsed ?? []).length) {
      await notifyDealTeam(admin, o, `iVueit photos not shot · ${o.address ?? 'a deal'}`, 'The order expired before a Vuer took it. Order again from the deal sheet or the TC file.');
    }
    return { status: expired ? 'failed' : 'ordered', photos: 0 };
  }

  const sub = await ivu(c, token, `/api/v1/surveysubmission/${encodeURIComponent(submissionId)}`);
  const photos = submissionPhotos(sub);
  const ws = o.workspace_id;
  const deal = o.deal_id;
  const prefix = `ws/${ws}/deals/${deal}/ivueit-${o.vue_id.slice(0, 8)}`;

  const { data: had } = await admin.from('deal_files').select('storage_path, is_cover, kind').eq('deal_id', deal);
  const have = new Set(((had ?? []) as { storage_path: string | null }[]).map((r) => r.storage_path).filter(Boolean));
  const hasCover = ((had ?? []) as { is_cover: boolean | null; kind: string }[]).some((r) => r.kind === 'photo' && r.is_cover);
  let saved = 0;
  let firstNewId: number | null = null;

  for (let i = 0; i < photos.length; i += 6) {
    const batch = photos.slice(i, i + 6).map((p, j) => ({ p, n: i + j + 1 }));
    await Promise.all(batch.map(async ({ p, n }) => {
      const path = `${prefix}-${String(n).padStart(3, '0')}.${extOf(p.mime)}`;
      if (have.has(path)) { saved++; return; }
      try {
        const res = await fetch(p.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = res.headers.get('content-type') || p.mime;
        const up = await admin.storage.from('deal-files').upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) return;
        const { data: row } = await admin.from('deal_files').insert({
          workspace_id: ws, deal_id: deal, kind: 'photo', source: 'ivueit',
          name: `iVueit ${String(n).padStart(2, '0')}${p.caption ? ' · ' + p.caption.slice(0, 80) : ''}`,
          caption: p.caption ? p.caption.slice(0, 280) : null,
          storage_path: path, content_type: type, byte_size: bytes.byteLength, position: 1000 + n,
        }).select('id').single();
        saved++;
        if (n === 1 && row) firstNewId = (row as { id: number }).id;
      } catch (e) {
        console.error('ivueit photo copy', { order: o.id, n, err: String(e) });
      }
    }));
  }
  if (!hasCover && firstNewId != null) await admin.from('deal_files').update({ is_cover: true }).eq('id', firstNewId);

  // The PDF iVueit writes for the Vue, filed with the deal's documents.
  const pdfId = String(vue.pdfFileId ?? vue.pdfFileIdPhotos ?? '').trim();
  const pdfPath = `${prefix}-report.pdf`;
  if (pdfId && !have.has(pdfPath)) {
    try {
      const link = await ivu(c, token, `/api/v1/file/url/${encodeURIComponent(pdfId)}`);
      const href = String(link.url ?? '');
      const res = href ? await fetch(href, { signal: AbortSignal.timeout(30_000) }) : null;
      if (res?.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const up = await admin.storage.from('deal-files').upload(pdfPath, bytes, { contentType: 'application/pdf', upsert: true });
        if (!up.error) {
          await admin.from('deal_files').insert({
            workspace_id: ws, deal_id: deal, kind: 'file', source: 'ivueit', name: 'iVueit photo report.pdf',
            storage_path: pdfPath, content_type: 'application/pdf', byte_size: bytes.byteLength,
          });
        }
      }
    } catch (e) {
      console.error('ivueit report copy', { order: o.id, err: String(e) });
    }
  }

  if (photos.length && saved === 0) {
    await admin.from('photo_orders').update({ checked_at: now, submission_id: submissionId, error: 'The photos are in but none copied yet. Check again in a minute.' }).eq('id', o.id);
    return { status: 'ordered', photos: 0 };
  }
  // Only the run that flips the order to completed tells the team (the
  // webhook, the sweep and Check now can land on the same Vue together).
  const { data: flipped } = await admin.from('photo_orders').update({
    status: 'completed', submission_id: submissionId, photo_count: saved, error: null,
    checked_at: now, completed_at: now, ...(Number.isFinite(cost) ? { cost } : {}),
  }).eq('id', o.id).neq('status', 'completed').select('id');
  const first = (flipped ?? []).length > 0;
  if (!first) await admin.from('photo_orders').update({ photo_count: saved, checked_at: now }).eq('id', o.id);
  if (first) {
    await notifyDealTeam(admin, o, `iVueit photos are in · ${o.address ?? 'your deal'}`,
      `${saved} photo${saved === 1 ? '' : 's'} from the Vuer${pdfId ? ' and the photo report' : ''}, on the deal under Files & photos.`);
    await admin.from('activity').insert({
      workspace_id: ws, entity_type: 'deal', entity_id: deal, kind: 'photos',
      title: 'iVueit photos are in', body: `${saved} photo${saved === 1 ? '' : 's'} from the Vuer, on the deal under Files & photos.`,
    });
  }
  return { status: 'completed', photos: saved };
}
