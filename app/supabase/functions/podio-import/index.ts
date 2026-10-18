/**
 * POST /podio-import — bring Acme Homes' active Podio deals, and everyone on
 * them, into CLOZR.
 *
 * Body: { workspace_id, action, ... }
 *   status      → { connected, client_id_hint, has_secret, apps: [{ key, app_id, token_hint }], last_mapping, last_import_at }
 *   save        { client_id?, client_secret?, apps: [{ key, app_id, app_token? }] } — a blank secret/token keeps the stored one
 *   disconnect  deletes the stored credentials
 *   test        → { app_name, field_count }
 *   inspect     → { app, fields, targets, guess, mapping, stage_field, stage_options }
 *   preview     { mapping, stage_option_ids, offset?, limit? } → { total, deals: [resolved deal], warnings }
 *   import      { mapping, stage_option_ids, item_ids } → { counts, imported, errors }
 *   sync        the live sync for this workspace, now (see "live sync" below), after sending CLOZR's stage moves
 *               ("Write-back", podio_outbox) → { counts, unmapped, ambiguous, errors, progress, push }
 *   sync_enabled { enabled } turns the ten-minute sync on or off for this workspace
 *
 * Service role (pg_cron's podio_sync_kick every ten minutes, migration 132): any
 * body → the write-back of CLOZR's submission stage moves, then the live sync,
 * for every workspace with sync_enabled, after the reply
 * (EdgeRuntime.waitUntil). Same service-role check as jotform-import's sync.
 * {"action":"history"} (podio_history_kick, migration 147) → the history pass
 * instead: each synced item's past stage moves, offers and comments onto its
 * record's timeline, oldest items first, once.
 *
 * Who: owner or admin of workspace_id (checked with the caller's JWT, then the
 * service role does the work). Credentials live in podio_connections, which no
 * client role can read; nothing secret is ever returned.
 *
 * Podio (developers.podio.com):
 *   POST /oauth/token/v2  grant_type=app, app_id, app_token, client_id, client_secret → { access_token }
 *     An app token reads only its own app, so each referenced app (Contacts,
 *     Buyers, Vendors, Team) needs its own id + token to read phone/email;
 *     without one the reference's title (the name) is still used.
 *   GET  /app/{app_id}                          field definitions
 *   POST /item/app/{app_id}/filter/             { filters: { field_id: [option ids] }, limit, offset } → { total, items }
 *   GET  /item/{item_id}                        one item with its field values
 *   PUT  /item/{item_id}/value/{field_id}       [option id] — the write-back of a CLOZR stage move (podio_outbox, migration 160)
 *   Header: Authorization: OAuth2 <access_token>
 *
 * Idempotent: deals carry source='podio', source_id=<item id>; people carry
 * source_id "item:<id>" / "profile:<id>"; deal_parties from Podio are replaced
 * per deal on every run. The UI imports in batches of ~10 item_ids so one call
 * stays well inside the edge wall clock.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany, isServiceCaller } from '../_shared/security.ts';
import {
  type Mapping, type PodioField, type PodioPerson, type PartyRole, DEFAULT_IMPORT_STAGES, TARGETS, TEAM_ROLES, VENDOR_TYPE,
  clozrStage, dealColumns, fieldOf, guessMapping, nameKey, personFromItem, phoneKey, readAddress, readCategories, readPeople,
  readText, sellerStageFor,
} from '../_shared/podio-map.ts';
import {
  type Comm, type DealCandidate, type PropertyDeal, type RosterMember, type StageMove, type Submission, SUBMISSION_SELLER_STAGES, addressKeysOf, appliedSnapshot,
  commentText, cursorAfterPage, duplicateArchiveNote, historyCallCap, historyLines, matchRoster, mergePodioBlock, pickAnySourceDeal, pickPipelineDeal, pickSubmissionDeal, pickZipTwin,
  pipelineStage, podioIso, readAcquisition, readComm, readSubmission, sellerStageOf,
  sinceFrom, stageMove, stopSyncPage, submissionSourceId, syncPatch, tally, tokenWarnings, unchangedSince, podioUntouched, type PodioOption, pushDecision,
  type MoneyKey, MONEY_KEYS, SUBMISSION_MONEY_FIELDS, podioMoney, valuesPush,
} from '../_shared/podio-sync.ts';
import { cleanEntity, entityKey, personKey, submissionStage } from '../_shared/podio-keys.ts';
import { classifyDoc } from '../_shared/deal-docs.ts';
import { type People, COMM_COLS, KINDS, absorb, addrSig, candidates, findRow, keep, newPeople, partyKeys, unasked, unchangedComms } from './page.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
type AppCred = { key: string; app_id: number; app_token: string };
type Conn = {
  client_id: string | null; client_secret: string | null; apps: AppCred[]; last_mapping: Any; last_import_at: string | null;
  connected_by?: string | null; sync_enabled?: boolean; last_sync_at?: string | null; last_sync_error?: string | null;
  last_sync_notes?: Any; sync_cursor?: Any;
};

const PODIO = 'https://api.podio.com';
/**
 * Every database write this function makes says it came from Podio
 * (request.headers), so podio_outbox_values (migration 163) never queues
 * Podio's own amounts to be written back to Podio.
 */
const PODIO_SOURCE = { 'x-clozr-source': 'podio' };
const hint = (s: string | null | undefined) => (s ? '••••' + s.slice(-4) : null);

class Podio {
  private tokens = new Map<number, Promise<string>>();
  /** Requests made by this instance (token requests included); `cap` stops a run before Podio's hourly limit does. */
  calls = 0;
  constructor(private conn: Conn, private cap = Infinity) {}
  get spent() { return this.calls >= this.cap; }
  cred(appId: number) { return this.conn.apps.find((a) => Number(a.app_id) === Number(appId) && a.app_token); }
  private token(appId: number): Promise<string> {
    let t = this.tokens.get(appId);
    if (!t) {
      const c = this.cred(appId);
      if (!c) return Promise.reject(new Error(`Podio: no app token saved for app ${appId}`));
      this.calls++;
      t = fetch(`${PODIO}/oauth/token/v2`, {
        // v2 reads a JSON body; a form body arrives as null ("Invalid value null (null): must be object").
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'app', app_id: Number(c.app_id), app_token: c.app_token, client_id: this.conn.client_id ?? '', client_secret: this.conn.client_secret ?? '' }),
      }).then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok || !b.access_token) throw new Error(`Podio refused the credentials for app ${appId} (${b.error_description ?? b.error ?? r.status})`);
        return b.access_token as string;
      });
      this.tokens.set(appId, t);
    }
    return t;
  }
  async call(appId: number, path: string, body?: unknown, method?: 'PUT'): Promise<Any> {
    if (this.calls >= this.cap) throw new Error('Podio: request budget for this run used — the next run continues');
    const token = await this.token(appId);
    this.calls++;
    const r = await fetch(PODIO + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { Authorization: `OAuth2 ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 420 || r.status === 429) throw new Error('Podio: rate limit reached — wait a few minutes and continue');
    if (!r.ok) throw new Error(`Podio ${path.split('?')[0]} → ${r.status}`, { cause: r.status });
    // A write may answer with no body.
    return method === 'PUT' ? r.json().catch(() => ({})) : r.json();
  }
  /** A file's bytes (GET /file/{id}/raw). */
  async raw(appId: number, fileId: number): Promise<Uint8Array> {
    if (this.calls >= this.cap) throw new Error('Podio: request budget for this run used — the next run continues');
    const token = await this.token(appId);
    this.calls++;
    const r = await fetch(`${PODIO}/file/${fileId}/raw`, { headers: { Authorization: `OAuth2 ${token}` } });
    if (r.status === 420 || r.status === 429) throw new Error('Podio: rate limit reached — wait a few minutes and continue');
    if (!r.ok) throw new Error(`Podio /file/${fileId}/raw → ${r.status}`, { cause: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }
}

function fieldsOf(app: Any): PodioField[] {
  return (app.fields ?? []).filter((f: Any) => f.status !== 'deleted').map((f: Any) => ({
    field_id: f.field_id, external_id: f.external_id, type: f.type, label: f.label ?? f.config?.label ?? f.external_id,
    options: (f.config?.settings?.options ?? []).filter((o: Any) => o.status !== 'deleted').map((o: Any) => ({ id: o.id, text: o.text, clozr: clozrStage(o.text) })),
    referenced_apps: (f.config?.settings?.referenced_apps ?? []).map((a: Any) => a.app_id),
  }));
}

// ---- resolving a Podio deal ---------------------------------------------------

type Match = { table: 'sellers' | 'buyers' | 'vendors' | 'team'; id: number | string; label: string } | null;
type Party = PodioPerson & { target: string; role: PartyRole; match: Match };
type Resolved = {
  item_id: number; title: string; link: string | null; address: string | null; podio_stage: string | null; stage: string | null;
  parties: Party[]; warnings: string[]; columns: Record<string, string | number | null>;
  addr: ReturnType<typeof readAddress>; existing_deal_id: number | null;
};

const PARTY_TARGETS = TARGETS.filter((t) => t.kind === 'party');

async function resolveItems(podio: Podio, items: Any[], mapping: Mapping, warnOnce: Set<string>, fetchRefs = true): Promise<Resolved[]> {
  const refCache = new Map<number, Promise<Any | null>>();
  const fetchRef = (p: PodioPerson): Promise<Any | null> => {
    if (!fetchRefs || podio.spent || !p.item_id || !p.app_id || !podio.cred(p.app_id)) return Promise.resolve(null);
    let hit = refCache.get(p.item_id);
    if (!hit) { hit = podio.call(p.app_id, `/item/${p.item_id}`).catch(() => null); refCache.set(p.item_id, hit); }
    return hit;
  };
  const out: Resolved[] = [];
  for (const item of items) {
    const warnings: string[] = [];
    const parties: Party[] = [];
    for (const t of PARTY_TARGETS) {
      const f = fieldOf(item, mapping[t.key]);
      for (const p of readPeople(f)) {
        if (p.ref === 'item' && p.app_id && !podio.cred(p.app_id)) {
          const appName = f?.values?.find((v: Any) => v.value?.item_id === p.item_id)?.value?.app?.config?.name ?? `app ${p.app_id}`;
          const w = `No token for the Podio "${appName}" app (${p.app_id}) — ${t.label.toLowerCase()} imported by name only. Add it under Extra apps for phone and email.`;
          warnOnce.add(w);
        }
        parties.push({ ...p, target: t.key, role: t.role!, match: null });
      }
    }
    // Referenced items give phone, email and company.
    await Promise.all(parties.map(async (p) => {
      const ref = await fetchRef(p);
      if (!ref) return;
      const d = personFromItem(ref);
      p.name = p.name || d.name; p.email = p.email ?? d.email; p.phone = p.phone ?? d.phone; p.company = p.company ?? d.company;
    }));
    const addr = readAddress(fieldOf(item, mapping.address));
    if (!addr) warnings.push('No property address — the deal will be imported without a property.');
    const stageText = readCategories(fieldOf(item, mapping.stage))[0] ?? readText(fieldOf(item, mapping.stage));
    const stage = clozrStage(stageText);
    if (!stage) warnings.push(`Podio stage "${stageText ?? '—'}" has no CLOZR deal stage; this deal will be skipped.`);
    if (!parties.some((p) => p.role === 'seller')) warnings.push('No seller on the Podio item — a seller named after the property is created.');
    out.push({
      item_id: item.item_id, title: item.title ?? '', link: item.link ?? null, address: addr?.full ?? null,
      podio_stage: stageText ?? null, stage, parties, warnings, columns: dealColumns(item, mapping), addr, existing_deal_id: null,
    });
  }
  return out;
}

/**
 * What a page of Podio deals has read (page.ts): sellers and buyers by key, the
 * roster, properties by address key, the import lines. Sellers, buyers,
 * properties and import lines the page writes go back in.
 *
 * Two reads stay per item, as before. The deal by Podio item id, right before
 * its write: no unique key stops a second deal for one item, only that read.
 * And the vendors: that read is PostgREST's first 1,000 of the workspace's
 * 127,898 rows, and whether a vendor made a moment ago is among them depends on
 * where Postgres put it (16 of the newest 200 are), so only a fresh read gives
 * the same answer.
 */
type Pre = {
  sellers: People; buyers: People; roster?: Any[];
  keyOf: Map<string, string | null>; props: Map<string, number>; propsAsked: Set<string>;
  imported: Set<string>; importAsked: Set<string>;
};
const newPre = (): Pre => ({
  sellers: newPeople(), buyers: newPeople(),
  keyOf: new Map(), props: new Map(), propsAsked: new Set(), imported: new Set(), importAsked: new Set(),
});
/** The seller columns matchParties matches on, and the ones writeDeal fills in. */
const SELLER_KEY_COLS = 'id,name,email,phone,phone_key,source,source_id,property_id,property_address';
const BUYER_KEY_COLS = 'id,name,company,email,phone_key,source,source_id';

/** The sellers, buyers and roster these deals need that the page has not read: one query per table and key kind. */
async function loadPeople(admin: SupabaseClient, ws: number, pre: Pre, deals: Resolved[]) {
  const keys = partyKeys(deals.flatMap((d) => d.parties));
  const people = async (table: 'sellers' | 'buyers', cols: string, pool: People) => {
    const want = unasked(pool, keys);
    const res = await Promise.all(KINDS.map((k) => {
      if (!want[k].length) return null;
      const q = admin.from(table).select(cols).eq('workspace_id', ws);
      return (k === 'source_id' ? q.eq('source', 'podio') : q).in(k, want[k]);
    }));
    KINDS.forEach((k, i) => { if (res[i]) absorb(pool, k, want[k], must(res[i]!) ?? []); });
  };
  await Promise.all([
    people('sellers', SELLER_KEY_COLS, pre.sellers),
    people('buyers', BUYER_KEY_COLS, pre.buyers),
    pre.roster ? null : admin.from('workspace_roster').select('user_id,full_name,email,role').eq('workspace_id', ws)
      .then((r) => { pre.roster = must(r) ?? []; }),
  ]);
  return keys;
}

/** The address keys, properties and "Imported from Podio" lines these deals need that the page has not read. */
async function loadPlaces(admin: SupabaseClient, ws: number, pre: Pre, deals: Resolved[]) {
  const addrs = new Map(deals.flatMap((d) => (d.addr && !pre.keyOf.has(addrSig(d.addr)) ? [[addrSig(d.addr), d.addr] as const] : [])));
  await Promise.all([...addrs].map(async ([sig, a]) => {
    const { data } = ok(await admin.rpc('address_key', { p_line1: a.line1, p_city: a.city ?? '', p_state: a.state ?? '', p_zip: a.zip ?? '' }));
    pre.keyOf.set(sig, (data as string | null) ?? null);
  }));
  const keys = [...new Set(deals.map((d) => (d.addr ? pre.keyOf.get(addrSig(d.addr)) : null)))].filter((k): k is string => !!k && !pre.propsAsked.has(k));
  const exts = [...new Set(deals.map((d) => 'podio:item:' + d.item_id))].filter((e) => !pre.importAsked.has(e));
  const [props, lines] = await Promise.all([
    keys.length ? admin.from('properties').select('id,address_key').eq('workspace_id', ws).in('address_key', keys) : null,
    exts.length ? admin.from('activity').select('external_id').eq('workspace_id', ws).in('external_id', exts) : null,
  ]);
  for (const p of props ? must(props) ?? [] : []) pre.props.set(p.address_key, p.id);
  for (const k of keys) pre.propsAsked.add(k);
  for (const l of lines ? must(lines) ?? [] : []) pre.imported.add(l.external_id);
  for (const e of exts) pre.importAsked.add(e);
}

/** Point every party at the CLOZR row it would update (or null = new). One query per table and key kind, none for a key the page already read. */
async function matchParties(admin: SupabaseClient, ws: number, deals: Resolved[], pre: Pre = newPre()) {
  const [keys, vendorsRes, dealsRes] = await Promise.all([
    loadPeople(admin, ws, pre, deals),
    admin.from('vendors').select('id,business_name,contact_name,email,phone,service_type,source,source_id').eq('workspace_id', ws),
    admin.from('deals').select('id,source_id').eq('workspace_id', ws).eq('source', 'podio').in('source_id', deals.map((d) => String(d.item_id))),
  ]);
  const vendors: Any[] = must(vendorsRes) ?? [];
  const dealOf = new Map((must(dealsRes) ?? []).map((d: Any) => [String(d.source_id), d.id]));
  const sellers = candidates(pre.sellers, keys);
  const buyers = candidates(pre.buyers, keys);
  const roster: Any[] = pre.roster ?? [];
  const find = findRow;
  for (const d of deals) {
    d.existing_deal_id = dealOf.get(String(d.item_id)) ?? null;
    for (const p of d.parties) {
      if (p.role === 'seller') {
        const r = find(sellers, p, ['name'], (x) => x.phone_key);
        p.match = r ? { table: 'sellers', id: r.id, label: r.name } : null;
      } else if (p.role === 'buyer') {
        const r = find(buyers, p, ['name', 'company'], (x) => x.phone_key);
        p.match = r ? { table: 'buyers', id: r.id, label: r.company ? `${r.company} · ${r.name}` : r.name } : null;
      } else if (TEAM_ROLES.includes(p.role)) {
        const em = p.email?.toLowerCase(); const nk = nameKey(p.name);
        const r = roster.find((m) => em && m.email?.toLowerCase() === em) ?? roster.find((m) => nk && nameKey(m.full_name) === nk)
          ?? roster.find((m) => nk && nameKey(m.full_name).split(' ')[0] === nk.split(' ')[0] && nameKey(m.full_name).split(' ').pop() === nk.split(' ').pop());
        p.match = r ? { table: 'team', id: r.user_id, label: r.full_name || r.email } : null;
        if (!r) d.warnings.push(`${p.name || 'A teammate'} (${p.role}) is not a member of this workspace — kept as a name on the deal team.`);
      } else if (p.target !== 'title_contact') {
        const r = find(vendors, p, ['business_name', 'contact_name'], (x) => phoneKey(x.phone));
        p.match = r ? { table: 'vendors', id: r.id, label: r.business_name } : null;
      }
    }
  }
}

// ---- writing ------------------------------------------------------------------

type Counts = Record<'deals' | 'sellers' | 'buyers' | 'vendors' | 'properties' | 'transactions', { created: number; updated: number }> & { parties: number; skipped: number };
const bump = (c: Counts, k: keyof Omit<Counts, 'parties' | 'skipped'>, created: boolean) => { c[k][created ? 'created' : 'updated']++; };
const compact = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) as Partial<T>;
const must = (r: { data: unknown; error: Any }): Any => { if (r.error) throw new Error(r.error.message); return r.data; };
/** The whole response, for a read that decides a write: a failed read throws instead of reading as "nothing there". */
const ok = <T extends { error: Any }>(r: T): T => { if (r.error) throw new Error(r.error.message); return r; };

/** Buyers and vendors on a deal that CLOZR does not have yet. */
async function createPeople(admin: SupabaseClient, ws: number, userId: string | null, d: Resolved, c: Counts, pre?: Pre) {
  for (const p of d.parties.filter((x) => x.role === 'buyer')) {
    if (p.match) { bump(c, 'buyers', false); continue; }
    const made = must(await admin.from('buyers').insert({ workspace_id: ws, name: p.name || p.company || 'Buyer', company: p.company, email: p.email?.toLowerCase() ?? null, phone: p.phone, source: 'podio', source_id: p.source_id, created_by: userId }).select(BUYER_KEY_COLS).single());
    if (pre) keep(pre.buyers, made);
    p.match = { table: 'buyers', id: made.id, label: p.name }; bump(c, 'buyers', true);
  }
  for (const p of d.parties.filter((x) => VENDOR_TYPE[x.role] && x.target !== 'title_contact')) {
    if (p.match) { bump(c, 'vendors', false); continue; }
    const business = p.company || p.name || VENDOR_TYPE[p.role]!;
    const id = must(await admin.from('vendors').insert({ workspace_id: ws, business_name: business, contact_name: p.company && p.name !== p.company ? p.name : null, email: p.email, phone: p.phone, service_type: VENDOR_TYPE[p.role], source: 'podio', source_id: p.source_id, created_by: userId }).select('id').single()).id;
    p.match = { table: 'vendors', id, label: business }; bump(c, 'vendors', true);
  }
}

/** One deal. `pre` is the page's reads (matchParties got the same one); the rows written here go back into it. */
async function writeDeal(admin: SupabaseClient, ws: number, userId: string | null, d: Resolved, c: Counts, opts: { sellerStage?: string | null; tc?: boolean } = {}, pre: Pre = newPre()) {
  if (!d.stage) { c.skipped++; return null; }
  const src = String(d.item_id);
  await loadPlaces(admin, ws, pre, [d]);

  // Property, on the database's own address key (properties_key_uniq: one per key).
  let propertyId: number | null = null;
  if (d.addr) {
    const key = pre.keyOf.get(addrSig(d.addr));
    const hit = key ? pre.props.get(key) : undefined;
    if (hit) { propertyId = hit; bump(c, 'properties', false); }
    else {
      const made = must(await admin.from('properties').insert({ workspace_id: ws, line1: d.addr.line1, city: d.addr.city, state: d.addr.state, zip: d.addr.zip, source: 'podio', source_id: 'item:' + src }).select('id,address_key').single());
      propertyId = made.id;
      if (made.address_key) pre.props.set(made.address_key, made.id);
      bump(c, 'properties', true);
    }
  }

  // Sellers: the first is the deal's seller, the rest co-sellers on the same property.
  const sellerParties = d.parties.filter((p) => p.role === 'seller');
  if (!sellerParties.length) sellerParties.push({ ref: 'text', source_id: `deal:${src}:seller`, name: d.addr?.line1 || d.title || `Podio deal ${src}`, email: null, phone: null, company: null, target: 'seller', role: 'seller', match: null });
  // The live sync creates a deal whose Podio stage CLOZR cannot map at Prospect, and leaves the seller's stage alone.
  const sellerStage = opts.sellerStage === undefined ? sellerStageFor(d.stage) : opts.sellerStage;
  let sellerId: number | null = null;
  for (const [i, p] of sellerParties.entries()) {
    const base = compact({ email: p.email, phone: p.phone, property_id: propertyId, property_address: d.addr?.full });
    if (p.match) {
      const id = Number(p.match.id);
      const patch: Record<string, unknown> = i === 0 && sellerStage ? { lead_stage: sellerStage } : {};
      // The page read this seller (matchParties) and keeps every write to it, so this is what a fresh read says.
      const cur = pre.sellers.rows.get(id) ?? must(await admin.from('sellers').select(SELLER_KEY_COLS).eq('id', id).maybeSingle());
      for (const [k, v] of Object.entries(base)) if (cur && (cur as Any)[k] == null) patch[k] = v;
      if (cur && !cur.source_id) Object.assign(patch, { source: 'podio', source_id: p.source_id });
      if (Object.keys(patch).length) {
        const [fresh] = must(await admin.from('sellers').update(patch).eq('id', id).select(SELLER_KEY_COLS));
        if (fresh) keep(pre.sellers, fresh); else pre.sellers.rows.delete(id);
      }
      bump(c, 'sellers', false);
      if (i === 0) sellerId = id;
    } else {
      // The first seller goes in at the contract stage (the stage trigger opens their deal, adopted below);
      // co-sellers keep the default stage so they do not open deals of their own.
      const row: Record<string, unknown> & { name: string } = { workspace_id: ws, name: p.name || 'Seller', ...base, source: 'podio', source_id: p.source_id, created_by: userId, ...(i === 0 ? (sellerStage ? { lead_stage: sellerStage } : {}) : { notes: 'Co-seller on a Podio deal' }) };
      const made = must(await admin.from('sellers').insert(row).select(SELLER_KEY_COLS).single());
      keep(pre.sellers, made);
      p.match = { table: 'sellers', id: made.id, label: row.name };
      bump(c, 'sellers', true);
      if (i === 0) sellerId = made.id;
    }
  }

  await createPeople(admin, ws, userId, d, c, pre);

  const first = (target: string) => d.parties.find((p) => p.target === target && p.match);
  const titleCo = d.parties.find((p) => p.target === 'title_company');
  const titleContact = d.parties.find((p) => p.target === 'title_contact');
  const team = (target: string) => { const p = first(target); return p?.match?.table === 'team' ? String(p.match.id) : null; };
  const dealPatch = compact({
    ...d.columns,
    stage: d.stage, seller_id: sellerId, property_id: propertyId,
    owner_id: team('acquisitions'), dispo_rep_id: team('dispositions'), dispo_rep2_id: team('dispositions2'), tc_rep_id: team('tc'),
    buyer_id: first('buyer')?.match?.id as number | undefined,
    title_vendor_id: titleCo?.match?.table === 'vendors' ? titleCo.match.id as number : undefined,
    title_contact: titleContact?.name,
    title_email: d.columns.title_email ?? titleContact?.email ?? titleCo?.email,
    title_phone: d.columns.title_phone ?? titleContact?.phone ?? titleCo?.phone,
    market: d.columns.market,
  });

  // The deal: ours from a previous run, else the one the seller's stage trigger opened, else a new one.
  let dealId = d.existing_deal_id;
  if (!dealId && sellerId) {
    const { data } = ok(await admin.from('deals').select('id').eq('workspace_id', ws).eq('seller_id', sellerId)
      .or('source.is.null,source.neq.podio').not('stage', 'in', '("Closed","Terminated","Realtor Referral")')
      .order('created_at', { ascending: false }).limit(1));
    dealId = data?.[0]?.id ?? null;
  }
  if (dealId) {
    must(await admin.from('deals').update({ ...dealPatch, source: 'podio', source_id: src, updated_at: new Date().toISOString() }).eq('id', dealId).select('id'));
    bump(c, 'deals', false);
  } else {
    dealId = must(await admin.from('deals').insert({ workspace_id: ws, ...dealPatch, source: 'podio', source_id: src, created_by: userId }).select('id').single()).id as number;
    bump(c, 'deals', true);
  }

  // The TC file: filled if it exists (or the contract-stage trigger just opened it), opened if not.
  const tx = compact({
    title_company: titleCo?.match?.label ?? titleCo?.company ?? titleCo?.name, escrow_officer: titleContact?.name,
    emd_amount: d.columns.earnest_money, option_ends_on: d.columns.option_ends_on, close_date: d.columns.close_date,
    contract_date: d.columns.contract_date, title_email: dealPatch.title_email, title_phone: dealPatch.title_phone,
    buyer_id: dealPatch.buyer_id, seller_id: sellerId, property_id: propertyId,
  });
  const { data: txRow } = ok(await admin.from('transactions').select('id').eq('deal_id', dealId).limit(1));
  if (txRow?.[0]) { must(await admin.from('transactions').update(tx).eq('id', txRow[0].id).select('id')); bump(c, 'transactions', false); }
  else if (opts.tc !== false) { must(await admin.from('transactions').insert({ workspace_id: ws, deal_id: dealId, status: 'open', created_by: userId, ...tx })); bump(c, 'transactions', true); }

  // Deal team: Podio's rows for this deal are replaced wholesale, so a re-run never duplicates.
  must(await admin.from('deal_parties').delete().eq('deal_id', dealId).eq('source', 'podio').select('id'));
  const seen = new Set<string>();
  const partyRows = d.parties.map((p) => ({
    workspace_id: ws, deal_id: dealId, role: p.role, name: p.name || null, company: p.company, email: p.email, phone: p.phone,
    seller_id: p.match?.table === 'sellers' ? p.match.id : null, buyer_id: p.match?.table === 'buyers' ? p.match.id : null,
    vendor_id: p.match?.table === 'vendors' ? p.match.id : p.target === 'title_contact' && titleCo?.match?.table === 'vendors' ? titleCo.match.id : null,
    user_id: p.match?.table === 'team' ? p.match.id : null, source: 'podio', source_id: p.source_id,
  })).filter((r) => {
    const k = [r.role, r.source_id, r.vendor_id, r.buyer_id, r.seller_id, r.user_id].join('|');
    return seen.has(k) ? false : (seen.add(k), true);
  });
  if (sellerParties[0] && !d.parties.includes(sellerParties[0] as Party)) {
    const sp = sellerParties[0];
    partyRows.unshift({ workspace_id: ws, deal_id: dealId, role: 'seller', name: sp.name, company: null, email: null, phone: null, seller_id: sellerId, buyer_id: null, vendor_id: null, user_id: null, source: 'podio', source_id: sp.source_id });
  }
  if (partyRows.length) must(await admin.from('deal_parties').insert(partyRows));
  c.parties += partyRows.length;

  // One activity line on the seller, once.
  if (sellerId) {
    const ext = 'podio:item:' + src;
    if (!pre.imported.has(ext)) {
      const team = d.parties.map((p) => `${p.role.replace('_', ' ')}: ${p.name || p.company}`).join(' · ');
      const { error } = await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: sellerId, kind: 'import', title: 'Imported from Podio', body: `${d.podio_stage ?? d.stage}${d.link ? ' · ' + d.link : ''}${team ? '\n' + team : ''}`, actor_id: userId, external_id: ext });
      if (!error) pre.imported.add(ext);
    }
  }
  return { item_id: d.item_id, deal_id: dealId, seller_id: sellerId, property_id: propertyId, address: d.address ?? d.title };
}

// ---- live sync ----------------------------------------------------------------
//
// Podio keeps moving after the 2026-09-13 Excel snapshot: new submissions, new
// stages, offers, deals going under contract. `sync` reads the Submissions and
// the Deals app of every connected workspace for items Podio touched since the
// last pass (filter last_event_on, oldest first, paged), and writes each one
// onto the record it already is in CLOZR:
//
//   1. the item ledger (podio_items, by item id), else
//   2. the Excel import's keys: a submission is the deal whose source_id is
//      "submission:<address key>|<partner key>|…" (_shared/podio-sync.ts
//      pickSubmissionDeal); a Deals-app item the Podio deal on its address that
//      is already on the pipeline, the wholesaler's, else the newest
//      (pickPipelineDeal), else a deal the manual import keyed by item id, else
//   3. a new record — a submission deal on the partner's contact, or a deal
//      through writeDeal like the manual import.
//
// Field rule (syncPatch): Podio fills what CLOZR left empty and overwrites only
// a value that changed in Podio since the sync last applied it; nothing is ever
// blanked. A stage is applied the same way through the existing mappers
// (submissionStage for submissions, clozrStage for deals), not over a move a
// person made in CLOZR since Podio's change, and an unmapped label never moves
// anything: the record's other fields still update and the label is counted in
// last_sync_notes and flagged on the ledger row (stage_unmapped). The
// stage_events triggers (migration 125) record every move; the sync adds the
// same activity rows the app writes.
//
// A run is bounded: SYNC_CALL_CAP Podio requests and a wall-clock budget split
// between the two apps. The window and offset of an unfinished pass are kept in
// sync_cursor, so the first run (no last pass: everything) continues on the
// next tick instead of starting over. One run per workspace at a time
// (sync_lock_until).

// Acquisitions first so the Communications pass finds its sellers; Communications is history in bulk (a page at a time).
const SYNC_APPS = ['acquisitions', 'submissions', 'deals', 'communications'] as const;
type SyncApp = (typeof SYNC_APPS)[number];
/** Smaller pages so a kill loses at most one page, and the cursor is on disk before the next Podio call. */
const SYNC_PAGE = 40;
/** Podio requests per run. Six runs an hour stay under ~500/hour, half of Podio's ~1000/hour per client. */
const SYNC_CALL_CAP = 80;
const CRON_BUDGET_MS = 110_000;
const OWNER_BUDGET_MS = 40_000;
const CONTRACT_STAGES = new Set(['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow']);

type Cursor = { since: string | null; offset: number | null; pass_started: string | null; filter_key?: string; total?: number; retry?: number[] };
type Ledger = {
  item_id: number; deal_id: number | null; seller_id: number | null; property_id: number | null;
  last_event_on: string | null; applied: Record<string, Any> | null; podio_stage: string | null;
};
type SyncCounts = { seen: number; unchanged: number; created: number; updated: number; stage_moves: number; unmapped: number; ambiguous: number; skipped: number; failed: number; comms: number; comms_linked: number };
type SyncCtx = {
  admin: SupabaseClient; ws: number; conn: Conn; podio: Podio; deadline: number; actor: string | null;
  counts: SyncCounts; unmapped: Record<string, number>; ambiguous: { app: string; item_id: number; deal_ids: number[] }[];
  errors: { app: string; item_id: number; message: string }[]; warnOnce: Set<string>; mapping?: Mapping;
  sellerStages?: string[]; roster?: Map<string, string>; rosterMembers?: RosterMember[];
  /** Items this run has applied (created or re-read past the unchanged check). The CPU cap counts these, not Podio calls alone. */
  worked: number;
  /** Writes sync_cursor and last_sync_notes. Set by syncWorkspace; absent in tests. */
  flush?: () => Promise<void>;
  /** The current page's reads for Deals-app items (matchParties, writeDeal). */
  pre?: Pre;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outOfBudget = (c: SyncCtx) => stopSyncPage({
  applied: c.worked, calls: c.podio.calls, callCap: SYNC_CALL_CAP, now: Date.now(), deadline: c.deadline,
});
const stopsRun = (m: string) => m.startsWith('Podio: rate limit') || m.startsWith('Podio: request budget');
const likeEsc = (v: string) => v.replace(/[\\%_]/g, (m) => '\\' + m);
const lastEventOf = (item: Any) => podioIso(item?.last_event_on ?? item?.last_edit_on ?? item?.created_on);
const newCounts = (): Counts => ({ deals: { created: 0, updated: 0 }, sellers: { created: 0, updated: 0 }, buyers: { created: 0, updated: 0 }, vendors: { created: 0, updated: 0 }, properties: { created: 0, updated: 0 }, transactions: { created: 0, updated: 0 }, parties: 0, skipped: 0 });

async function ledgerFor(c: SyncCtx, ids: number[]): Promise<Map<number, Ledger>> {
  const { data } = ok(await c.admin.from('podio_items').select('item_id,deal_id,seller_id,property_id,last_event_on,applied,podio_stage')
    .eq('workspace_id', c.ws).in('item_id', ids));
  return new Map((data ?? []).map((r: Any) => [Number(r.item_id), r as Ledger]));
}
async function remember(c: SyncCtx, row: Record<string, unknown>) {
  must(await c.admin.from('podio_items').upsert({ workspace_id: c.ws, synced_at: new Date().toISOString(), ...row }, { onConflict: 'workspace_id,item_id' }).select('item_id'));
}

/** A person moved this stage in CLOZR after Podio's change (stage_events with an author). */
async function movedInClozr(c: SyncCtx, entity: 'deal' | 'seller', id: number, field: string, since: string | null) {
  let q = c.admin.from('stage_events').select('id').eq('entity_type', entity).eq('entity_id', id).eq('field', field).not('changed_by', 'is', null);
  if (since) q = q.gt('changed_at', since);
  const { data } = ok(await q.limit(1));
  return !!data?.length;
}

async function logStage(c: SyncCtx, entity: 'deal' | 'seller', id: number, title: string, label: string | null, itemId: number, at: string | null, field: string) {
  await c.admin.from('activity').insert({
    workspace_id: c.ws, entity_type: entity, entity_id: id, kind: 'stage', title, body: `From Podio${label ? ` (${label})` : ''}`,
    actor_id: null, external_id: `podio:${itemId}:${field}:${at ?? ''}`,
  }).then(() => null, () => null);
}

const noteUnmapped = (c: SyncCtx, mv: StageMove) => { if (mv.kind === 'unmapped') { c.counts.unmapped++; tally(c.unmapped, mv.label); } };

/**
 * A partner's contact carries the stage of its newest submission (migration 49),
 * while it is still in a submission stage: a contact the deal trigger moved on
 * (Under Contract, Closed…) keeps its stage.
 */
async function followNewest(c: SyncCtx, sellerId: number, dealId: number, stage: string, s: Submission) {
  const { data: newest } = await c.admin.from('deals').select('id').eq('workspace_id', c.ws).eq('seller_id', sellerId).not('lead_stage', 'is', null)
    .order('submitted_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).limit(1);
  if (newest?.[0]?.id !== dealId) return;
  const { data: sel } = await c.admin.from('sellers').select('lead_stage').eq('id', sellerId).maybeSingle();
  if (!sel || sel.lead_stage === stage || (sel.lead_stage && !SUBMISSION_SELLER_STAGES.has(sel.lead_stage))) return;
  must(await c.admin.from('sellers').update({ lead_stage: stage }).eq('id', sellerId).select('id'));
  await logStage(c, 'seller', sellerId, 'Stage → ' + stage, s.podio_stage, s.item_id, s.last_event_on, 'seller_stage');
  c.counts.stage_moves++;
}

/** The contact's phone and email, only where CLOZR has none (a number another record holds is left off). */
async function fillContact(c: SyncCtx, sellerId: number, s: Submission) {
  if (!s.phone && !s.email) return;
  const { data: cur } = await c.admin.from('sellers').select('phone,email').eq('id', sellerId).maybeSingle();
  if (!cur) return;
  const patch = syncPatch(cur, { phone: s.phone, email: s.email }, null);
  if (Object.keys(patch).length) await c.admin.from('sellers').update(patch).eq('id', sellerId).then(() => null, () => null);
}

async function fillFacts(c: SyncCtx, propertyId: number, facts: Submission['facts']) {
  if (!Object.keys(facts).length) return;
  const { data: cur } = await c.admin.from('properties').select('beds,baths,sqft,year_built,property_type').eq('id', propertyId).maybeSingle();
  const patch = cur ? syncPatch(cur, facts, null) : {};
  if (Object.keys(patch).length) await c.admin.from('properties').update(patch).eq('id', propertyId).then(() => null, () => null);
}

async function withSellers(c: SyncCtx, rows: Any[]): Promise<DealCandidate[]> {
  const ids = [...new Set(rows.map((r) => r.seller_id).filter(Boolean))];
  const { data } = ids.length ? ok(await c.admin.from('sellers').select('id,phone_key,email').in('id', ids)) : { data: [] };
  const by = new Map((data ?? []).map((x: Any) => [x.id, x]));
  return rows.map((r) => ({ id: r.id, source_id: r.source_id, stage: r.stage, submitted_at: r.submitted_at, seller_phone_key: by.get(r.seller_id)?.phone_key ?? null, seller_email: by.get(r.seller_id)?.email ?? null }));
}

/** The Podio deals the Excel import put on these address keys. */
async function addressDeals(c: SyncCtx, keys: string[], withDealKey: boolean): Promise<Any[]> {
  const rows = new Map<number, Any>();
  const cols = 'id,source_id,stage,submitted_at,seller_id';
  for (const k of keys) {
    const qs = [c.admin.from('deals').select(cols).eq('workspace_id', c.ws).eq('source', 'podio').like('source_id', `submission:${likeEsc(k)}|%`).limit(50)];
    if (withDealKey) qs.push(c.admin.from('deals').select(cols).eq('workspace_id', c.ws).eq('source', 'podio').eq('source_id', 'deal:' + k).limit(5));
    for (const r of await Promise.all(qs)) for (const row of must(r) ?? []) rows.set(row.id, row);
  }
  return [...rows.values()];
}

// ---- Submissions app ----------------------------------------------------------

const SUBMISSION_DEAL_COLS = 'id,seller_id,property_id,lead_stage,asking_price,motivation,offer_amount,arv,rehab,mao,wholesale_offer,institutional_offer,earnest_money,underwriting_url,compr_report_url,occupancy_notes,market,submitted_at,notes,photos_url,garage_spaces,underwriter_id,owner_id,podio_item_id';
type Addr = { line1: string; city: string | null; state: string | null; zip: string | null };

async function rosterOf(c: SyncCtx): Promise<RosterMember[]> {
  if (!c.rosterMembers) {
    const { data } = ok(await c.admin.from('workspace_roster').select('user_id,full_name,email').eq('workspace_id', c.ws));
    c.rosterMembers = (data ?? []) as RosterMember[];
    c.roster = new Map(c.rosterMembers.filter((m) => m.full_name).map((m) => [nameKey(m.full_name), m.user_id]));
  }
  return c.rosterMembers;
}

const noteAmbiguous = async (c: SyncCtx, base: Record<string, unknown>, itemId: number, ids: number[]) => {
  c.counts.ambiguous++;
  c.ambiguous.push({ app: 'submissions', item_id: itemId, deal_ids: ids });
  await remember(c, { ...base, note: `Matches ${ids.length} CLOZR deals on this address (deals ${ids.join(', ')}); none was changed.` });
};

/** Deals on these properties, live and archived, with the seller's phone and email for the contact tie-break. */
async function propertyDeals(c: SyncCtx, propertyIds: number[]): Promise<PropertyDeal[]> {
  if (!propertyIds.length) return [];
  const { data } = ok(await c.admin.from('deals')
    .select('id,source,source_id,stage,lead_stage,submitted_at,seller_id,created_at,archived_at,archived_reason')
    .eq('workspace_id', c.ws).in('property_id', propertyIds).limit(80));
  const rows = data ?? [];
  const base = await withSellers(c, rows);
  const extra = new Map(rows.map((r: Any) => [r.id as number, r]));
  return base.map((b) => {
    const r = extra.get(b.id);
    return { ...b, lead_stage: r?.lead_stage ?? null, archived_at: r?.archived_at ?? null, archived_reason: r?.archived_reason ?? null, created_at: r?.created_at ?? null };
  });
}

/** Live deals created within ±2 h on this zip — the Jotform twin of a submission that has no street. */
async function zipWindowDeals(c: SyncCtx, zip: string, created: string): Promise<PropertyDeal[]> {
  const t = Date.parse(created);
  if (Number.isNaN(t)) return [];
  const from = new Date(t - 2 * 60 * 60 * 1000).toISOString();
  const to = new Date(t + 2 * 60 * 60 * 1000).toISOString();
  const { data: props } = ok(await c.admin.from('properties').select('id').eq('workspace_id', c.ws).eq('zip', zip).limit(400));
  const pids = (props ?? []).map((p: Any) => p.id as number);
  if (!pids.length) return [];
  const { data } = ok(await c.admin.from('deals')
    .select('id,source,source_id,stage,lead_stage,submitted_at,seller_id,created_at,archived_at,archived_reason')
    .eq('workspace_id', c.ws).in('property_id', pids).is('archived_at', null).gte('created_at', from).lte('created_at', to).limit(40));
  const rows = data ?? [];
  const base = await withSellers(c, rows);
  const extra = new Map(rows.map((r: Any) => [r.id as number, r]));
  return base.map((b) => ({ ...b, zip, lead_stage: extra.get(b.id)?.lead_stage ?? null, created_at: extra.get(b.id)?.created_at ?? null, archived_at: null }));
}

async function syncSubmission(c: SyncCtx, app: AppCred, item: Any, led: Ledger | undefined) {
  const s = readSubmission(item);
  if (unchangedSince(led, s.last_event_on)) { c.counts.unchanged++; return; }
  const base = { item_id: s.item_id, app_key: 'submissions', app_id: app.app_id, podio_stage: s.podio_stage || null, created_on: s.created, last_event_on: s.last_event_on };

  let dealId = led?.deal_id ?? null;
  let by = dealId ? 'item id' : null;
  if (!dealId && s.test) {
    c.counts.skipped++;
    await remember(c, { ...base, note: 'A test submission: not brought over.' });
    return;
  }
  if (!dealId && s.address && s.address_keys.length) {
    const pick = pickSubmissionDeal(await withSellers(c, await addressDeals(c, s.address_keys, false)), s);
    if (pick && 'ambiguous' in pick) { await noteAmbiguous(c, base, s.item_id, pick.ambiguous); return; }
    if (pick) { dealId = pick.id; by = pick.by; }
    if (!dealId) {
      const deals = await propertyDeals(c, await propertyIdsFor(c, s.variants));
      const dup = duplicateArchiveNote(deals);
      if (dup) {
        c.counts.skipped++;
        await remember(c, { ...base, note: dup });
        return;
      }
      const any = pickAnySourceDeal(deals, s);
      if (any && 'ambiguous' in any) { await noteAmbiguous(c, base, s.item_id, any.ambiguous); return; }
      if (any) { dealId = any.id; by = any.by; }
    }
  } else if (!dealId) {
    const twin = s.zip && s.created ? pickZipTwin(await zipWindowDeals(c, s.zip, s.created), s, s.zip) : null;
    if (twin && 'ambiguous' in twin) { await noteAmbiguous(c, base, s.item_id, twin.ambiguous); return; }
    if (twin) { dealId = twin.id; by = twin.by; }
    else {
      c.counts.skipped++;
      await remember(c, { ...base, note: 'No street address on the Podio item: nothing to match or create.' });
      return;
    }
  }
  c.worked++;
  if (!dealId) return createSubmission(c, s, base);

  const { data: deal } = ok(await c.admin.from('deals').select(SUBMISSION_DEAL_COLS).eq('id', dealId).eq('workspace_id', c.ws).maybeSingle());
  if (!deal) {
    c.counts.skipped++;
    await remember(c, { ...base, note: 'Its CLOZR deal was deleted; not recreated.' });
    return;
  }
  const roster = await rosterOf(c);
  const uw = s.underwriters.map((p) => matchRoster(roster, p)).find((id): id is string => !!id) ?? null;
  const acq = s.acquisitions.map((p) => matchRoster(roster, p)).find((id): id is string => !!id) ?? null;
  const last = led?.applied ?? null;
  const inc: Record<string, unknown> = { ...s.cols, submitted_at: s.created };
  // The Podio item id is stored once. A deal that already names one keeps it.
  if (!deal.podio_item_id) inc.podio_item_id = s.item_id;
  if (deal.photos_url) delete inc.photos_url;
  else if (s.photos_url) inc.photos_url = s.photos_url;
  if (uw) inc.underwriter_id = uw;
  const patch = syncPatch(deal, inc, last);
  // Acquisitions fills a blank owner and never overwrites one CLOZR already has.
  if (!deal.owner_id && acq) patch.owner_id = acq;
  const notes = mergePodioBlock(deal.notes, s.block);
  if (notes !== (deal.notes ?? '')) patch.notes = notes;
  let mv = stageMove({ label: s.podio_stage, mapped: s.stage, current: deal.lead_stage, lastApplied: last?.lead_stage });
  if (mv.kind === 'set' && await movedInClozr(c, 'deal', deal.id, 'lead_stage', s.last_event_on)) mv = { kind: 'keep', why: 'moved in CLOZR since' };
  noteUnmapped(c, mv);
  if (mv.kind === 'set') patch.lead_stage = mv.to;
  if (Object.keys(patch).length) {
    must(await c.admin.from('deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', deal.id).select('id'));
    c.counts.updated++;
  } else c.counts.unchanged++;
  if (mv.kind === 'set') {
    c.counts.stage_moves++;
    await logStage(c, 'deal', deal.id, 'Stage → ' + mv.to, s.podio_stage, s.item_id, s.last_event_on, 'lead_stage');
    if (deal.seller_id) await followNewest(c, deal.seller_id, deal.id, mv.to, s);
  }
  if (deal.seller_id) await fillContact(c, deal.seller_id, s);
  if (s.dead) await markDead(c, deal.id, deal.seller_id, s.item_id);
  if (deal.property_id) await fillFacts(c, deal.property_id, s.facts);
  await addSubmissionParties(c, deal.id, s, roster);
  await attachSourcePhotos(c.admin, c.ws, deal.id, s.photo_urls);
  await pullLinkedComprPhotos(c.admin, c.ws, deal.id, s.cols.compr_report_url, s.photo_urls);
  await remember(c, {
    ...base, deal_id: deal.id, seller_id: deal.seller_id, property_id: deal.property_id, matched_by: by, stage_unmapped: mv.kind === 'unmapped',
    applied: appliedSnapshot(last, { ...inc, ...(s.stage && s.podio_stage ? { lead_stage: s.stage } : {}) }),
    note: mv.kind === 'keep' && mv.why === 'moved in CLOZR since' ? `Podio says "${s.podio_stage}"; kept CLOZR's ${deal.lead_stage ?? '—'} (moved in CLOZR after Podio's change).` : null,
  });
}

/** The database's address_key for one parsed address, and the property that already has it. */
async function findPropertyId(c: SyncCtx, a: Addr): Promise<number | null> {
  const { data: key } = ok(await c.admin.rpc('address_key', { p_line1: a.line1, p_city: a.city ?? '', p_state: a.state ?? '', p_zip: a.zip ?? '' }));
  if (!key) return null;
  return ok(await c.admin.from('properties').select('id').eq('workspace_id', c.ws).eq('address_key', key).limit(1)).data?.[0]?.id ?? null;
}

/** Every variant, each tried against address_key(), before anything is inserted. */
async function propertyIdsFor(c: SyncCtx, variants: Addr[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<string>();
  for (const a of variants) {
    const sig = `${a.line1}|${a.city ?? ''}|${a.state ?? ''}|${a.zip ?? ''}`.toUpperCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    const id = await findPropertyId(c, a);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The property on this address (the database's own address key), its facts filled; made when there is none. Every variant is tried before an insert. */
async function propertyFor(c: SyncCtx, a: Addr, facts: Submission['facts'], itemId: number, variants?: Addr[]): Promise<number> {
  const list = variants?.length ? variants : [a];
  const hit = (await propertyIdsFor(c, list))[0] ?? (list.some((v) => v.line1 === a.line1 && v.zip === a.zip) ? null : await findPropertyId(c, a));
  if (hit) { await fillFacts(c, hit, facts); return hit; }
  return must(await c.admin.from('properties').insert({ workspace_id: c.ws, line1: a.line1, city: a.city, state: a.state, zip: a.zip, ...facts, source: 'podio', source_id: 'item:' + itemId }).select('id').single()).id;
}

/** Every Photos link as a deal_files row the Photos button opens. A URL already on the deal is skipped. */
async function attachSourcePhotos(admin: SupabaseClient, ws: number, dealId: number, urls: string[]) {
  const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
  if (!clean.length) return;
  const { data: have } = ok(await admin.from('deal_files').select('url').eq('deal_id', dealId).in('url', clean));
  const got = new Set((have ?? []).map((r: { url: string | null }) => r.url));
  const rows = clean.filter((u) => !got.has(u)).map((url) => ({
    workspace_id: ws, deal_id: dealId, kind: 'link' as const, name: 'Photos', url, source: 'podio', category: 'photos',
  }));
  if (rows.length) await admin.from('deal_files').insert(rows).then(() => null, () => null);
  // New links go to COMPR, and so does a deal that still has none of COMPR's
  // photos: Mark Spain's photo page is drawn by script, so COMPR reading it is
  // the only way its pictures reach the album. A deal COMPR already filled is
  // left alone until a new link comes in, so a sync does not re-pull the set.
  const { count: comprPhotos } = rows.length ? { count: 0 } : ok(await admin.from('deal_files')
    .select('id', { count: 'exact', head: true }).eq('deal_id', dealId).eq('source', 'compr'));
  queueComprRoundTrip(admin, ws, dealId, rows.length || !comprPhotos ? clean.length : 0);
}

/**
 * A submission with a COMPR report link ("Ai Compr Tool") and none of COMPR's
 * photos yet: pull them. Mark Spain and Offerpad send no photo links, so the
 * report's photos are the only ones the house has. A pull only, never a run.
 */
async function pullLinkedComprPhotos(admin: SupabaseClient, ws: number, dealId: number, reportUrl: string | null | undefined, photoLinks: string[]) {
  // A deal with photo links already went to COMPR from attachSourcePhotos.
  if (photoLinks.length || !reportUrl || !/thecompr\.(?:com|ai)\/r\//i.test(reportUrl)) return;
  const { count } = ok(await admin.from('deal_files').select('id', { count: 'exact', head: true }).eq('deal_id', dealId).eq('source', 'compr'));
  if (count) return;
  queueComprRoundTrip(admin, ws, dealId, 1, true);
}

/**
 * A submission just landed (or its photos changed). A deal COMPR already
 * knows gets its photos pulled back. A deal with no report is underwritten
 * with every photo link and the house facts, and that pull happens at the
 * end of the run. After the response, so the sync is not held for COMPR.
 */
function queueComprRoundTrip(admin: SupabaseClient, ws: number, dealId: number, photoCount: number, pullOnly = false) {
  if (!photoCount) return;
  const run = (async () => {
    const { data: deal } = await admin.from('deals').select('seller_id').eq('id', dealId).maybeSingle();
    const sellerId = deal?.seller_id;
    if (!sellerId) return;
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/compr-underwrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
        body: JSON.stringify({ workspace_id: ws, seller_id: sellerId, deal_id: dealId, action: 'round_trip', ...(pullOnly ? { pull_only: true } : {}) }),
      });
      if (!res.ok) console.error('podio compr', { status: res.status, deal: dealId, body: (await res.text()).slice(0, 300) });
    } catch (e) {
      console.error('podio compr', { deal: dealId, err: (e as Error).message });
    }
  })();
  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(run);
}

/** Underwriters (dispositions, team) and funds (role other), added when the deal does not list them yet. */
async function addSubmissionParties(c: SyncCtx, dealId: number, s: Submission, roster: RosterMember[]) {
  if (!s.underwriters.length && !s.funds.length) return;
  const { data: have } = ok(await c.admin.from('deal_parties').select('role,name,source_id,user_id').eq('deal_id', dealId));
  const rows: Record<string, unknown>[] = [];
  for (const u of s.underwriters) {
    const userId = matchRoster(roster, u);
    const sourceId = 'team:' + (u.email ?? personKey(u.name));
    const exists = (have ?? []).some((h: Any) => h.role === 'dispositions' && (
      h.source_id === sourceId || (userId && h.user_id === userId) || (u.name && h.name && nameKey(h.name) === nameKey(u.name))));
    if (!exists) rows.push({ workspace_id: c.ws, deal_id: dealId, role: 'dispositions', name: u.name, email: u.email, user_id: userId, source: 'podio', source_id: sourceId });
  }
  for (const f of s.funds) {
    const sourceId = 'fund:' + f.toLowerCase();
    if ((have ?? []).some((h: Any) => h.role === 'other' && h.source_id === sourceId)) continue;
    rows.push({ workspace_id: c.ws, deal_id: dealId, role: 'other', name: f, company: 'Fund — deal sent to', source: 'podio', source_id: sourceId });
  }
  if (rows.length) await c.admin.from('deal_parties').insert(rows).then(() => null, () => null);
}

/** "Marked dead in Podio" on the timeline once, and a Dead tag on the partner contact. */
async function markDead(c: SyncCtx, dealId: number, sellerId: number | null, itemId: number) {
  await c.admin.from('activity').insert({
    workspace_id: c.ws, entity_type: 'deal', entity_id: dealId, kind: 'note', title: 'Marked dead in Podio',
    body: 'Marked dead in Podio', actor_id: null, external_id: `podio:${itemId}:dead`,
  }).then(() => null, () => null);
  if (!sellerId) return;
  const { data: sel } = ok(await c.admin.from('sellers').select('tags').eq('id', sellerId).maybeSingle());
  const tags: string[] = Array.isArray(sel?.tags) ? sel.tags : [];
  if (!tags.includes('Dead')) await c.admin.from('sellers').update({ tags: [...tags, 'Dead'] }).eq('id', sellerId).then(() => null, () => null);
}

/** A submission CLOZR has never seen: a deal on its partner's contact (made if there is none), on its property. */
async function createSubmission(c: SyncCtx, s: Submission, base: Record<string, unknown>) {
  const a = s.address!;
  const propertyId = await propertyFor(c, a, s.facts, s.item_id, s.variants);
  const roster = await rosterOf(c);
  const uw = s.underwriters.map((p) => matchRoster(roster, p)).find((id): id is string => !!id) ?? null;
  const acq = s.acquisitions.map((p) => matchRoster(roster, p)).find((id): id is string => !!id) ?? null;

  // The partner's one contact (migration 49): from its other submissions, else by phone or email, else new.
  let sellerId: number | null = null;
  if (s.partner_key) {
    const { data } = ok(await c.admin.from('deals').select('seller_id').eq('workspace_id', c.ws).eq('source', 'podio')
      .like('source_id', `submission:%|${likeEsc(s.partner_key)}|%`).not('seller_id', 'is', null).order('id', { ascending: false }).limit(1));
    sellerId = data?.[0]?.seller_id ?? null;
  }
  if (!sellerId && s.phone) sellerId = ok(await c.admin.from('sellers').select('id').eq('workspace_id', c.ws).eq('phone_key', s.phone).order('id').limit(1)).data?.[0]?.id ?? null;
  if (!sellerId && s.email) sellerId = ok(await c.admin.from('sellers').select('id').eq('workspace_id', c.ws).ilike('email', likeEsc(s.email)).order('id').limit(1)).data?.[0]?.id ?? null;
  const vendor = s.partner_key
    ? ok(await c.admin.from('vendors').select('id,business_name').eq('workspace_id', c.ws).eq('source', 'podio').eq('source_id', 'partner:' + s.partner_key).limit(1)).data?.[0] ?? null
    : null;
  const stage = s.stage ?? 'New Submission';
  const where = [a.line1, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const isNewSeller = !sellerId;
  if (!sellerId) {
    const row = {
      workspace_id: c.ws, name: s.person ?? vendor?.business_name ?? s.entity ?? 'Unknown submitter', phone: s.phone, email: s.email,
      property_id: propertyId, property_address: where, lead_stage: stage, created_by: c.actor,
      tags: ['Podio submission', ...(vendor?.business_name ? [vendor.business_name] : s.entity ? [s.entity] : []), ...(s.dead ? ['Dead'] : [])], source: 'podio', source_id: 'item:' + s.item_id,
    };
    const first = await c.admin.from('sellers').insert(row).select('id').single();
    // A phone another record holds (sellers_phone_uniq): the contact goes in without it.
    sellerId = (first.error ? must(await c.admin.from('sellers').insert({ ...row, phone: null }).select('id').single()) : first.data).id as number;
  }
  const head = [`Podio submission${s.entity ? ' · ' + s.entity : ''}`, s.podio_stage && !s.stage ? `Podio stage: ${s.podio_stage}` : '', s.link ?? ''].filter(Boolean).join('\n');
  const dealId = must(await c.admin.from('deals').insert({
    workspace_id: c.ws, property_id: propertyId, seller_id: sellerId, stage: 'Prospect', lead_stage: stage,
    source: 'podio', source_id: submissionSourceId(s), submitted_at: s.created, created_by: c.actor, ...compact(s.cols),
    podio_item_id: s.item_id, ...(s.photos_url ? { photos_url: s.photos_url } : {}),
    ...(uw ? { underwriter_id: uw } : {}), ...(acq ? { owner_id: acq } : {}),
    notes: mergePodioBlock(head, s.block),
  }).select('id').single()).id as number;
  if (vendor) {
    await c.admin.from('deal_parties').insert({ workspace_id: c.ws, deal_id: dealId, role: 'wholesaler', vendor_id: vendor.id, name: s.person, company: vendor.business_name, email: s.email, phone: s.phone, source: 'podio', source_id: 'partner:' + s.partner_key }).then(() => null, () => null);
  }
  await attachSourcePhotos(c.admin, c.ws, dealId, s.photo_urls);
  await pullLinkedComprPhotos(c.admin, c.ws, dealId, s.cols.compr_report_url, s.photo_urls);
  await addSubmissionParties(c, dealId, s, roster);
  await c.admin.from('activity').insert({
    workspace_id: c.ws, entity_type: 'seller', entity_id: sellerId, kind: 'import', title: 'New submission from Podio',
    body: [where, s.podio_stage ? 'Podio stage: ' + s.podio_stage : '', s.link ?? ''].filter(Boolean).join('\n'), actor_id: null, external_id: 'podio:item:' + s.item_id,
  }).then(() => null, () => null);
  if (s.dead) await markDead(c, dealId, isNewSeller ? null : sellerId, s.item_id);
  if (!isNewSeller) await followNewest(c, sellerId, dealId, stage, s);
  const unmapped = !!s.podio_stage && !s.stage;
  if (unmapped) { c.counts.unmapped++; tally(c.unmapped, s.podio_stage); }
  c.counts.created++;
  await remember(c, {
    ...base, deal_id: dealId, seller_id: sellerId, property_id: propertyId, matched_by: 'new', stage_unmapped: unmapped,
    applied: appliedSnapshot(null, { ...s.cols, submitted_at: s.created, podio_item_id: s.item_id, ...(uw ? { underwriter_id: uw } : {}), ...(s.stage && s.podio_stage ? { lead_stage: s.stage } : {}) }), note: null,
  });
}

// ---- Deals app ------------------------------------------------------------------

/** The Deals app mapping: the one the owner last imported with, else the guess. */
async function dealsMapping(c: SyncCtx, app: AppCred): Promise<Mapping> {
  if (c.mapping) return c.mapping;
  const fields = fieldsOf(await c.podio.call(app.app_id, `/app/${app.app_id}`));
  const known = new Set(fields.map((f) => f.external_id));
  const saved = Object.fromEntries(Object.entries((c.conn.last_mapping?.mapping ?? {}) as Mapping)
    .filter(([k, v]) => typeof v === 'string' && known.has(v) && TARGETS.some((t) => t.key === k)));
  c.mapping = saved.stage ? saved : { ...guessMapping(fields), ...saved };
  return c.mapping;
}

async function syncDealItem(c: SyncCtx, app: AppCred, item: Any, led: Ledger | undefined) {
  const lastEvent = lastEventOf(item);
  if (podioUntouched(led, lastEvent)) { c.counts.unchanged++; return; }
  c.worked++;
  const mapping = await dealsMapping(c, app);
  const itemId = Number(item.item_id);
  const base = { item_id: itemId, app_key: 'deals', app_id: app.app_id, created_on: podioIso(item.created_on), last_event_on: lastEvent };

  // Find the deal before resolving people, so referenced items are fetched only for a new one.
  let dealId: number | null = led?.deal_id ?? null;
  let by: string | null = dealId ? 'item id' : null;
  if (!dealId) {
    const { data } = ok(await c.admin.from('deals').select('id').eq('workspace_id', c.ws).eq('source', 'podio').eq('source_id', String(itemId)).limit(1));
    if (data?.[0]) { dealId = data[0].id; by = 'item id (manual import)'; }
  }
  if (!dealId) {
    const addrField = fieldOf(item, mapping.address);
    const keys = addressKeysOf(readText(addrField) ?? '', addrField);
    if (keys.length) {
      let rows = await addressDeals(c, keys, true);
      // A deal another Deals-app item already owns is not this one.
      if (rows.length) {
        const { data: owned } = ok(await c.admin.from('podio_items').select('deal_id,item_id').eq('workspace_id', c.ws).eq('app_key', 'deals').in('deal_id', rows.map((r) => r.id)));
        const taken = new Set((owned ?? []).filter((o: Any) => Number(o.item_id) !== itemId).map((o: Any) => o.deal_id));
        rows = rows.filter((r) => !taken.has(r.id));
      }
      const wholesaler = entityKey(cleanEntity(readText(fieldOf(item, mapping.wholesaler)) ?? '').name);
      const pick = pickPipelineDeal(await withSellers(c, rows), wholesaler);
      if (pick && !('ambiguous' in pick)) { dealId = pick.id; by = pick.by; }
    }
  }

  const [d] = await resolveItems(c.podio, [item], mapping, c.warnOnce, !dealId);
  await matchParties(c.admin, c.ws, [d], c.pre);
  const label = d.podio_stage ?? '';
  const mapped = pipelineStage(label);

  if (!dealId) {
    // New: the manual import's writer. An unmapped stage still brings the deal, at Prospect, seller stage untouched.
    const unmapped = !!label && !mapped;
    d.stage = mapped ?? 'Prospect';
    const r = await writeDeal(c.admin, c.ws, c.actor, d, newCounts(), { sellerStage: mapped ? undefined : null, tc: CONTRACT_STAGES.has(d.stage) }, c.pre);
    if (unmapped) { c.counts.unmapped++; tally(c.unmapped, label); }
    c.counts.created++;
    await remember(c, {
      ...base, deal_id: r?.deal_id ?? null, seller_id: r?.seller_id ?? null, property_id: r?.property_id ?? null, matched_by: 'new',
      podio_stage: label || null, stage_unmapped: unmapped, applied: appliedSnapshot(null, { ...d.columns, ...(mapped ? { stage: mapped } : {}) }), note: null,
    });
    return;
  }

  const { data: cur } = ok(await c.admin.from('deals').select('*').eq('id', dealId).eq('workspace_id', c.ws).maybeSingle());
  if (!cur) {
    c.counts.skipped++;
    await remember(c, { ...base, podio_stage: label || null, note: 'Its CLOZR deal was deleted; not recreated.' });
    return;
  }
  // The deal keeps its seller and property; buyers and vendors CLOZR does not have yet are added.
  await createPeople(c.admin, c.ws, c.actor, d, newCounts(), c.pre);
  const first = (t: string) => d.parties.find((p) => p.target === t && p.match);
  const team = (t: string) => { const p = first(t); return p?.match?.table === 'team' ? String(p.match.id) : null; };
  const titleCo = d.parties.find((p) => p.target === 'title_company');
  const titleContact = d.parties.find((p) => p.target === 'title_contact');
  const inc: Record<string, unknown> = compact({
    ...d.columns,
    owner_id: team('acquisitions'), dispo_rep_id: team('dispositions'), dispo_rep2_id: team('dispositions2'), tc_rep_id: team('tc'),
    buyer_id: first('buyer')?.match?.id, title_vendor_id: titleCo?.match?.table === 'vendors' ? titleCo.match.id : undefined,
    title_contact: titleContact?.name, title_email: d.columns.title_email ?? titleContact?.email ?? titleCo?.email,
    title_phone: d.columns.title_phone ?? titleContact?.phone ?? titleCo?.phone,
  });
  const last = led?.applied ?? null;
  // Notes are a running log: Podio's notes are added below CLOZR's when they changed, never written over them.
  const podioNotes = typeof inc.notes === 'string' ? inc.notes : null;
  delete inc.notes;
  const patch = syncPatch(cur, inc, last);
  if (podioNotes && podioNotes !== last?.notes && !String(cur.notes ?? '').includes(podioNotes)) {
    patch.notes = cur.notes ? `${cur.notes}\n\nFrom Podio:\n${podioNotes}` : podioNotes;
  }
  let mv = stageMove({ label, mapped, current: cur.stage, lastApplied: last?.stage });
  if (mv.kind === 'set' && await movedInClozr(c, 'deal', cur.id, 'stage', lastEvent)) mv = { kind: 'keep', why: 'moved in CLOZR since' };
  noteUnmapped(c, mv);
  if (mv.kind === 'set') patch.stage = mv.to;
  if (Object.keys(patch).length) {
    must(await c.admin.from('deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', cur.id).select('id'));
    c.counts.updated++;
  } else c.counts.unchanged++;
  if (mv.kind === 'set') {
    c.counts.stage_moves++;
    await logStage(c, 'deal', cur.id, 'Deal → ' + mv.to, label, itemId, lastEvent, 'stage');
  }

  // The TC file: same rule; opened when the deal is (now) under contract.
  const txInc: Record<string, unknown> = compact({
    title_company: titleCo?.match?.label ?? titleCo?.company ?? titleCo?.name, escrow_officer: titleContact?.name,
    emd_amount: d.columns.earnest_money, option_ends_on: d.columns.option_ends_on, close_date: d.columns.close_date,
    contract_date: d.columns.contract_date, title_email: inc.title_email, title_phone: inc.title_phone, buyer_id: inc.buyer_id,
  });
  const { data: txRows } = ok(await c.admin.from('transactions').select('*').eq('deal_id', cur.id).limit(1));
  if (txRows?.[0]) {
    const tp = syncPatch(txRows[0], txInc, last?.tx ?? null);
    if (Object.keys(tp).length) must(await c.admin.from('transactions').update(tp).eq('id', txRows[0].id).select('id'));
  } else if (CONTRACT_STAGES.has(String(patch.stage ?? cur.stage))) {
    must(await c.admin.from('transactions').insert({ workspace_id: c.ws, deal_id: cur.id, status: 'open', seller_id: cur.seller_id, property_id: cur.property_id, created_by: c.actor, ...txInc }));
  }

  // The deal team: whoever Podio names that the deal does not list yet. Nothing is removed.
  const { data: have } = ok(await c.admin.from('deal_parties').select('role,name,source_id,vendor_id,buyer_id,user_id').eq('deal_id', cur.id));
  const rows = d.parties.filter((p) => p.role !== 'seller').map((p) => ({
    workspace_id: c.ws, deal_id: cur.id, role: p.role, name: p.name || null, company: p.company, email: p.email, phone: p.phone,
    buyer_id: p.match?.table === 'buyers' ? p.match.id : null,
    vendor_id: p.match?.table === 'vendors' ? p.match.id : p.target === 'title_contact' && titleCo?.match?.table === 'vendors' ? titleCo.match.id : null,
    user_id: p.match?.table === 'team' ? p.match.id : null, source: 'podio', source_id: p.source_id,
  })).filter((r, i, all) => all.findIndex((x) => x.role === r.role && x.source_id === r.source_id) === i)
    .filter((r) => !(have ?? []).some((h: Any) => h.role === r.role && (
      (h.source_id && h.source_id === r.source_id) || (r.vendor_id && h.vendor_id === r.vendor_id) || (r.buyer_id && h.buyer_id === r.buyer_id)
      || (r.user_id && h.user_id === r.user_id) || (r.name && h.name && nameKey(h.name) === nameKey(r.name)))));
  if (rows.length) await c.admin.from('deal_parties').insert(rows).then(() => null, () => null);

  await remember(c, {
    ...base, deal_id: cur.id, seller_id: cur.seller_id, property_id: cur.property_id, matched_by: by, podio_stage: label || null,
    stage_unmapped: mv.kind === 'unmapped',
    applied: { ...appliedSnapshot(last, { ...inc, notes: podioNotes }), ...(mapped ? { stage: mapped } : {}), tx: appliedSnapshot(last?.tx ?? null, txInc) },
    note: mv.kind === 'keep' && mv.why === 'moved in CLOZR since' ? `Podio says "${label}"; kept CLOZR's ${cur.stage} (moved in CLOZR after Podio's change).` : null,
  });
}

// ---- Acme Homes › Acquisitions (sellers) -----------------------------------------
//
// One seller per item: the ledger's, else ours from an earlier pass (source_id
// "acq:<item>"), else the seller with its phone or email, else new. Fields follow
// syncPatch; the Lead Stage is the same vocabulary as seller_stages and moves the
// seller like a Podio deal stage does (not over a move made in CLOZR since). A
// new seller keeps Podio's created date, so 9,500 old leads never count as new.

const SELLER_COLS = 'id,name,email,phone,property_id,property_address,lead_stage,asking_price,motivation,timeline,occupancy,mortgage,notes,owner2_name,import_extra';

async function sellerStages(c: SyncCtx): Promise<string[]> {
  if (!c.sellerStages) c.sellerStages = (ok(await c.admin.from('seller_stages').select('label')).data ?? []).map((r: Any) => String(r.label));
  return c.sellerStages;
}

/** Podio history about these numbers that no record claimed yet now belongs to this seller. */
async function relinkComms(c: SyncCtx, sellerId: number, phones: string[]) {
  if (!phones.length) return;
  const list = phones.map((p) => `"${p}"`).join(',');
  const { count } = await c.admin.from('communications').update({ seller_id: sellerId }, { count: 'exact' }).eq('workspace_id', c.ws).eq('source', 'podio')
    .is('seller_id', null).is('buyer_id', null).or(`from_phone.in.(${list}),to_phone.in.(${list})`);
  c.counts.comms_linked += count ?? 0;
}

async function syncAcquisition(c: SyncCtx, app: AppCred, item: Any, led: Ledger | undefined) {
  const a = readAcquisition(item);
  if (podioUntouched(led, a.last_event_on)) { c.counts.unchanged++; return; }
  c.worked++;
  const base = { item_id: a.item_id, app_key: 'acquisitions', app_id: app.app_id, podio_stage: a.podio_stage || null, created_on: a.created, last_event_on: a.last_event_on };
  if (!a.name && !a.phones.length && !a.emails.length && !a.address) {
    c.counts.skipped++;
    await remember(c, { ...base, note: 'No name, phone, email or address on the Podio item: nothing to bring over.' });
    return;
  }
  const stage = sellerStageOf(a.podio_stage, await sellerStages(c));
  const unmapped = !!a.podio_stage && !stage;
  if (unmapped) { c.counts.unmapped++; tally(c.unmapped, a.podio_stage); }

  let sellerId: number | null = led?.seller_id ?? null;
  let by: string | null = sellerId ? 'item id' : null;
  const find = async (q: Any, how: string) => {
    if (sellerId) return;
    const id = ok(await q.order('id').limit(1)).data?.[0]?.id;
    if (id) { sellerId = id; by = how; }
  };
  await find(c.admin.from('sellers').select('id').eq('workspace_id', c.ws).eq('source', 'podio').eq('source_id', 'acq:' + a.item_id), 'item id');
  if (a.phones.length) await find(c.admin.from('sellers').select('id').eq('workspace_id', c.ws).in('phone_key', a.phones), 'phone');
  if (a.phones.length) await find(c.admin.from('seller_phones').select('id:seller_id').eq('workspace_id', c.ws).in('phone_key', a.phones), 'phone');
  if (a.emails[0]) await find(c.admin.from('sellers').select('id').eq('workspace_id', c.ws).ilike('email', likeEsc(a.emails[0])), 'email');

  // Only a street address makes a property ("Atlanta, GA" alone does not).
  const propertyId = a.address?.line1 && /^\d/.test(a.address.line1) ? await propertyFor(c, a.address, a.facts, a.item_id) : null;
  const where = a.address ? [a.address.line1, a.address.city, [a.address.state, a.address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null;
  const inc: Record<string, unknown> = {
    ...a.cols, name: a.name, email: a.emails[0] ?? null, phone: a.phones[0] ?? null, owner2_name: a.owner2,
    property_id: propertyId, property_address: where,
  };
  const extra = { ...a.extra, 'Podio link': a.link ?? '' };

  if (!sellerId) {
    const row = {
      workspace_id: c.ws, ...compact(inc), name: a.name ?? 'Unknown seller', lead_stage: stage ?? 'Lead',
      other_emails: a.emails.slice(1), tags: ['Podio acquisition', ...(a.source ? [a.source] : [])],
      import_extra: extra, source: 'podio', source_id: 'acq:' + a.item_id,
      ...(a.created ? { created_at: a.created } : {}), created_by: null,
    };
    const first = await c.admin.from('sellers').insert(row).select('id').single();
    // A phone another record holds (sellers_phone_uniq): the seller goes in without it.
    sellerId = (first.error ? must(await c.admin.from('sellers').insert({ ...row, phone: null }).select('id').single()) : first.data).id as number;
    by = 'new';
    c.counts.created++;
  } else {
    const { data: cur } = ok(await c.admin.from('sellers').select(SELLER_COLS).eq('id', sellerId).eq('workspace_id', c.ws).maybeSingle());
    if (!cur) {
      c.counts.skipped++;
      await remember(c, { ...base, note: 'Its CLOZR seller was deleted; not recreated.' });
      return;
    }
    const last = led?.applied ?? null;
    const patch = syncPatch(cur, inc, last);
    // Notes are a running log: Podio's are added below CLOZR's when they changed, never written over them.
    delete patch.notes;
    if (a.cols.notes && a.cols.notes !== last?.notes && !String(cur.notes ?? '').includes(a.cols.notes)) {
      patch.notes = cur.notes ? `${cur.notes}\n\nFrom Podio:\n${a.cols.notes}` : a.cols.notes;
    }
    if (!cur.import_extra) patch.import_extra = extra;
    let mv = stageMove({ label: a.podio_stage, mapped: stage, current: cur.lead_stage, lastApplied: last?.lead_stage });
    if (mv.kind === 'set' && await movedInClozr(c, 'seller', cur.id, 'lead_stage', a.last_event_on)) mv = { kind: 'keep', why: 'moved in CLOZR since' };
    if (mv.kind === 'set') patch.lead_stage = mv.to;
    if (Object.keys(patch).length) {
      const r = await c.admin.from('sellers').update(patch).eq('id', cur.id).select('id');
      // A phone another record holds: everything else still goes in.
      if (r.error && patch.phone) { delete patch.phone; must(await c.admin.from('sellers').update(patch).eq('id', cur.id).select('id')); } else must(r);
      c.counts.updated++;
    } else c.counts.unchanged++;
    if (mv.kind === 'set') {
      c.counts.stage_moves++;
      await logStage(c, 'seller', cur.id, 'Stage → ' + mv.to, a.podio_stage, a.item_id, a.last_event_on, 'lead_stage');
    }
  }
  // Every number after the first, for the dialer and for matching texts.
  const more = a.phones.slice(1).map((p, i) => ({ workspace_id: c.ws, seller_id: sellerId, phone: p, phone_key: p, position: i + 1, kind: 'other', source: 'podio' }));
  if (more.length) await c.admin.from('seller_phones').upsert(more, { onConflict: 'seller_id,phone', ignoreDuplicates: true }).then(() => null, () => null);
  await relinkComms(c, sellerId!, a.phones);
  await remember(c, {
    ...base, seller_id: sellerId, property_id: propertyId, matched_by: by, stage_unmapped: unmapped,
    applied: appliedSnapshot(led?.applied ?? null, { ...inc, ...(stage ? { lead_stage: stage } : {}) }), note: null,
  });
}

// ---- Acme Homes › Communications (smrtPhone calls and texts) ------------------------
//
// ~43,000 rows of history, so a page at a time: who each one is with (the
// Contact item the Acquisitions pass linked, else the number on a seller, one of
// a seller's other numbers, or a buyer), then one upsert keyed on the item id.
// Migration 137 keeps rows older than a day from opening inbox threads or
// waking anything. A row nobody claims keeps its numbers and is linked when its
// seller arrives (relinkComms).

async function syncComms(c: SyncCtx, items: Any[]) {
  const comms = items.map(readComm).filter((x): x is Comm => !!x);
  c.counts.skipped += items.length - comms.length;
  if (!comms.length) return;
  const refIds = [...new Set(comms.flatMap((x) => x.contact_item_ids))];
  const phones = [...new Set(comms.map((x) => x.contact_phone).filter(Boolean) as string[])];
  const none = Promise.resolve({ data: [] as Any[], error: null });
  const [ledRes, selRes, morRes, buyRes] = await Promise.all([
    refIds.length ? c.admin.from('podio_items').select('item_id,seller_id').eq('workspace_id', c.ws).in('item_id', refIds).not('seller_id', 'is', null) : none,
    phones.length ? c.admin.from('sellers').select('id,phone_key').eq('workspace_id', c.ws).in('phone_key', phones) : none,
    phones.length ? c.admin.from('seller_phones').select('seller_id,phone_key').eq('workspace_id', c.ws).in('phone_key', phones) : none,
    phones.length ? c.admin.from('buyers').select('id,phone_key').eq('workspace_id', c.ws).in('phone_key', phones) : none,
  ]);
  // A failed read is not "nobody has this number": the page stops instead of writing the rows unlinked.
  const byItem = new Map((must(ledRes) ?? []).map((r: Any) => [Number(r.item_id), r.seller_id as number]));
  const byPhone = new Map<string, number>();
  for (const r of (must(morRes) ?? []) as Any[]) byPhone.set(r.phone_key, r.seller_id);
  for (const r of (must(selRes) ?? []) as Any[]) byPhone.set(r.phone_key, r.id);
  const buyer = new Map((must(buyRes) ?? []).map((r: Any) => [r.phone_key as string, r.id as number]));
  if (!c.roster) {
    const { data } = ok(await c.admin.from('workspace_roster').select('user_id,full_name').eq('workspace_id', c.ws));
    c.roster = new Map((data ?? []).filter((m: Any) => m.full_name).map((m: Any) => [nameKey(m.full_name), m.user_id]));
  }
  const rows = comms.map((x) => {
    const sellerId = x.contact_item_ids.map((i) => byItem.get(i)).find(Boolean) ?? (x.contact_phone ? byPhone.get(x.contact_phone) : undefined) ?? null;
    const buyerId = !sellerId && x.contact_phone ? buyer.get(x.contact_phone) ?? null : null;
    return {
      workspace_id: c.ws, source: 'podio', source_id: String(x.item_id), ...x.row,
      seller_id: sellerId, buyer_id: buyerId, rep_id: x.owner ? c.roster!.get(nameKey(x.owner)) ?? null : null,
    };
  });
  // The window overlaps the last run, and Podio hands back the same items run after run (the same
  // six on every run of 2026-10-17 from 13:03): a row already stored exactly as this page has it is not written again.
  const [stored, lines] = await Promise.all([
    c.admin.from('communications').select(COMM_COLS).eq('workspace_id', c.ws).eq('source', 'podio').in('source_id', rows.map((r) => r.source_id)),
    c.admin.from('rep_phone_numbers').select('phone_e164,user_id').eq('workspace_id', c.ws).not('user_id', 'is', null),
  ]);
  const lineOwner = new Map<string, string>((must(lines) ?? []).map((r: Any) => [r.phone_e164 as string, r.user_id as string]));
  const same = unchangedComms(rows, must(stored) ?? [], lineOwner, Date.now());
  const write = rows.filter((r) => !same.has(r.source_id));
  if (write.length) must(await c.admin.from('communications').upsert(write, { onConflict: 'workspace_id,source,source_id' }).select('id'));
  c.counts.comms += rows.length;
  c.counts.comms_linked += rows.filter((r) => r.seller_id || r.buyer_id).length;
}

// ---- the pass ----------------------------------------------------------------------

async function syncOne(c: SyncCtx, key: SyncApp, app: AppCred, item: Any, led: Ledger | undefined) {
  if (!item.fields) item = await c.podio.call(app.app_id, `/item/${item.item_id}`);
  if (key === 'communications') await syncComms(c, [item]);
  else if (key === 'acquisitions') await syncAcquisition(c, app, item, led);
  else if (key === 'submissions') await syncSubmission(c, app, item, led);
  else await syncDealItem(c, app, item, led);
}

/** One app: retries from the last run, then pages of the current pass until the budget runs out. The cursor is updated in place. */
async function syncApp(c: SyncCtx, key: SyncApp, app: AppCred, cursor: Record<string, Cursor>) {
  const prev = cursor[key];
  const cur: Cursor = prev?.offset != null ? { ...prev } : { since: prev?.since ?? null, offset: 0, pass_started: new Date().toISOString(), filter_key: prev?.filter_key, retry: prev?.retry };
  cursor[key] = cur;
  const failed = (id: number, e: unknown) => {
    const m = errMsg(e);
    if (stopsRun(m)) throw e;
    c.counts.failed++;
    c.errors.push({ app: key, item_id: id, message: m.slice(0, 300) });
    console.error('podio sync item', c.ws, key, id, m);
    cur.retry = [...new Set([...(cur.retry ?? []), id])].slice(-50);
  };

  // Items that failed last time are tried again by id (they may not be in the next window).
  c.pre = newPre();
  for (const id of [...(cur.retry ?? [])]) {
    if (outOfBudget(c)) { await c.flush?.(); return; }
    cur.retry = (cur.retry ?? []).filter((x) => x !== id);
    try {
      const item = await c.podio.call(app.app_id, `/item/${id}`);
      await syncOne(c, key, app, item, (await ledgerFor(c, [id])).get(id));
    } catch (e) { failed(id, e); }
  }

  for (;;) {
    if (outOfBudget(c)) { await c.flush?.(); return; }
    const field = cur.filter_key ?? 'last_event_on';
    const from = sinceFrom(cur.since);
    let page: Any;
    try {
      page = await c.podio.call(app.app_id, `/item/app/${app.app_id}/filter/`, {
        filters: from ? { [field]: { from } } : {}, limit: SYNC_PAGE, offset: cur.offset ?? 0, sort_by: 'created_on', sort_desc: false,
      });
    } catch (e) {
      // Not every app filters on last_event_on; last_edit_on is the documented fallback.
      if (from && field === 'last_event_on' && e instanceof Error && e.cause === 400) { cur.filter_key = 'last_edit_on'; continue; }
      throw e;
    }
    const items: Any[] = page.items ?? [];
    cur.total = Number(page.filtered ?? page.total ?? 0) || cur.total;
    const storeCursor = async (processed: number) => {
      const next = cursorAfterPage(cur, processed, { length: items.length, size: SYNC_PAGE });
      if (next.offset == null) cursor[key] = next;
      else Object.assign(cur, next);
      await c.flush?.();
      return next.offset == null;
    };
    if (key === 'communications') {
      // History in bulk: the whole page in a handful of queries, no ledger rows.
      c.counts.seen += items.length;
      await syncComms(c, items);
      if (await storeCursor(items.length)) return;
      continue;
    }
    const ledger = items.length ? await ledgerFor(c, items.map((it) => Number(it.item_id))) : new Map<number, Ledger>();
    c.pre = newPre();
    let i = 0;
    for (; i < items.length; i++) {
      if (outOfBudget(c)) break;
      c.counts.seen++;
      try { await syncOne(c, key, app, items[i], ledger.get(Number(items[i].item_id))); } catch (e) {
        if (stopsRun(errMsg(e))) { await storeCursor(i); throw e; }
        failed(Number(items[i].item_id), e);
      }
    }
    if (await storeCursor(i)) return;
    if (i < items.length) return;
  }
}

/** One workspace, under its lease. Returns what the run did; the same goes to last_sync_notes. */
async function syncWorkspace(admin: SupabaseClient, row: Any, deadline: number) {
  const ws = Number(row.workspace_id);
  const conn: Conn = {
    client_id: row.client_id ?? null, client_secret: row.client_secret ?? null, apps: (row.apps ?? []) as AppCred[],
    last_mapping: row.last_mapping ?? {}, last_import_at: row.last_import_at ?? null, connected_by: row.connected_by ?? null, sync_cursor: row.sync_cursor ?? {},
  };
  const apps = SYNC_APPS.map((k) => [k, conn.apps.find((a) => a.key === k && a.app_token)] as const).filter((x): x is readonly [SyncApp, AppCred] => !!x[1]);
  const missingToken = tokenWarnings(conn.apps.filter((a) => (SYNC_APPS as readonly string[]).includes(a.key)));
  if (!conn.client_id || !conn.client_secret || !apps.length) {
    if (missingToken.length) {
      await admin.from('podio_connections').update({
        last_sync_notes: { ...(row.last_sync_notes ?? {}), at: new Date().toISOString(), warnings: missingToken },
      }).eq('workspace_id', ws);
    }
    return { workspace_id: ws, skipped: 'Podio is not connected, or no Acquisitions / Submissions / Deals / Communications app token is saved.', warnings: missingToken };
  }

  const startedAt = new Date().toISOString();
  const { data: lease } = await admin.from('podio_connections').update({ sync_lock_until: new Date(deadline + 120_000).toISOString() })
    .eq('workspace_id', ws).or(`sync_lock_until.is.null,sync_lock_until.lt."${startedAt}"`).select('workspace_id');
  if (!lease?.length) return { workspace_id: ws, skipped: 'A sync is already running for this workspace.' };

  const c: SyncCtx = {
    admin, ws, conn, podio: new Podio(conn, SYNC_CALL_CAP), deadline, actor: conn.connected_by ?? null,
    counts: { seen: 0, unchanged: 0, created: 0, updated: 0, stage_moves: 0, unmapped: 0, ambiguous: 0, skipped: 0, failed: 0, comms: 0, comms_linked: 0 },
    unmapped: {}, ambiguous: [], errors: [], warnOnce: new Set(), worked: 0,
  };
  const cursor: Record<string, Cursor> = { ...(conn.sync_cursor ?? {}) };
  const progressOf = () => Object.fromEntries(Object.entries(cursor).map(([k, v]) => [k, v?.offset != null ? { done: v.offset, of: v.total ?? null, full: !v.since } : null]));
  const warningsOf = () => [...missingToken, ...c.warnOnce].slice(0, 20);
  // After every page, so a CPU kill does not restart the pass at the same offset.
  c.flush = async () => {
    await admin.from('podio_connections').update({
      sync_cursor: cursor,
      last_sync_notes: {
        at: startedAt, counts: c.counts, podio_requests: c.podio.calls, unmapped: c.unmapped, ambiguous: c.ambiguous.slice(0, 50),
        errors: c.errors.slice(0, 50), warnings: warningsOf(), progress: progressOf(), partial: true,
      },
    }).eq('workspace_id', ws);
  };
  let error: string | null = null;
  // Apps mid-backfill go last: whatever the caught-up apps leave of the budget goes to the backfill.
  apps.sort(([a], [b]) => Number(cursor[a]?.offset != null) - Number(cursor[b]?.offset != null));
  try {
    for (const [i, [key, app]] of apps.entries()) {
      // Each app gets its share of what is left, so a long Submissions backfill does not starve Deals.
      c.deadline = Date.now() + (deadline - Date.now()) / (apps.length - i);
      await syncApp(c, key, app, cursor);
    }
  } catch (e) {
    error = errMsg(e);
    console.error('podio sync', ws, error);
  }
  const progress = progressOf();
  const notes = {
    at: startedAt, counts: c.counts, podio_requests: c.podio.calls, unmapped: c.unmapped, ambiguous: c.ambiguous.slice(0, 50),
    errors: c.errors.slice(0, 50), warnings: warningsOf(), progress,
  };
  await admin.from('podio_connections').update({
    sync_cursor: cursor, last_sync_error: error, last_sync_notes: notes, sync_lock_until: null,
    ...(error ? {} : { last_sync_at: new Date().toISOString() }),
  }).eq('workspace_id', ws);
  return { workspace_id: ws, error, ...notes };
}

// ---- Write-back: a submission moved in CLOZR is moved in Podio -----------------
//
// podio_outbox (migrations 160, 162) holds every Submissions item whose deal a
// person moved in CLOZR (kind 'stage'), or whose low offer, high offer or offer
// price changed in CLOZR (kind 'values'). Each run sends the queue before
// syncing: the item is read (one GET), pushDecision / valuesPush say whether
// CLOZR's value goes over Podio's (the later change wins, the sync's own rule),
// and the item is written (one PUT, silent so item followers are not notified
// of each move). The ledger then carries what Podio now says, so the
// Submissions counts move at once and the next sync finds nothing to change.
// While the outbox has rows, the Submissions history pass keeps a smaller
// share of that app's Podio budget so the write-back goes first and history
// still moves.

/** Podio requests per run for the write-back: two per item, plus the token and the app's fields. */
const PUSH_CALL_CAP = 120;
const PUSH_BUDGET_MS = 45_000;
const PUSH_TRIES = 5;
type PushCounts = { sent: number; already: number; skipped: number; failed: number; superseded: number };
type PushResult = PushCounts & { workspace_id: number; podio_requests?: number; error?: string | null };
type MoneyField = { field_id: number; label: string; currency: string };

/** The Submissions app's Stage field and its options, and the money fields the offer amounts go to. */
async function submissionFieldsOf(podio: Podio, app: AppCred): Promise<{
  stage: { field_id: number; options: PodioOption[] } | null; money: Partial<Record<MoneyKey, MoneyField>>;
}> {
  const a = await podio.call(app.app_id, `/app/${app.app_id}`);
  const live = (a.fields ?? []).filter((x: Any) => x.status !== 'deleted');
  const labelOf = (x: Any) => String(x.label ?? x.config?.label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const f = live.find((x: Any) => x.type === 'category' && labelOf(x) === 'stage');
  const stage = f
    ? { field_id: Number(f.field_id), options: (f.config?.settings?.options ?? []).filter((o: Any) => o.status !== 'deleted')
      .map((o: Any) => ({ id: Number(o.id), text: String(o.text ?? ''), status: o.status ?? 'active' })) }
    : null;
  const money: Partial<Record<MoneyKey, MoneyField>> = {};
  for (const k of MONEY_KEYS) {
    const label = SUBMISSION_MONEY_FIELDS[k];
    const m = live.find((x: Any) => x.type === 'money' && labelOf(x) === label.toLowerCase());
    if (m) money[k] = { field_id: Number(m.field_id), label, currency: String(m.config?.settings?.allowed_currencies?.[0] ?? 'USD') };
  }
  return { stage, money };
}

async function pushWorkspace(admin: SupabaseClient, row: Any, deadline: number): Promise<PushResult> {
  const ws = Number(row.workspace_id);
  const n: PushCounts = { sent: 0, already: 0, skipped: 0, failed: 0, superseded: 0 };
  const now = () => new Date().toISOString();
  const { data: queue, error: qErr } = await admin.from('podio_outbox')
    .select('id,item_id,deal_id,kind,to_stage,vals,podio_stage_at_move,moved_at,status,attempts,claimed_until')
    .eq('workspace_id', ws).in('status', ['pending', 'sending']).order('id').limit(400);
  if (qErr) return { workspace_id: ws, ...n, error: qErr.message };
  const ready = (queue ?? []).filter((r: Any) => r.status === 'pending' || !r.claimed_until || Date.parse(r.claimed_until) < Date.now());
  if (!ready.length) return { workspace_id: ws, ...n };
  const app = ((row.apps ?? []) as AppCred[]).find((a) => a.key === 'submissions' && a.app_token);
  if (!row.client_id || !row.client_secret || !app) return { workspace_id: ws, ...n, error: 'Changes for Podio are waiting: no Submissions app token is saved.' };

  // Only the newest stage move of an item is sent; older ones queued alongside it are superseded.
  // Amounts are queued one row per item (the trigger merges into the pending one), each sent in turn.
  const newest = new Map<number, Any>();
  for (const r of ready) if ((r.kind ?? 'stage') === 'stage') newest.set(Number(r.item_id), r);
  const stale = ready.filter((r: Any) => (r.kind ?? 'stage') === 'stage' && newest.get(Number(r.item_id)) !== r).map((r: Any) => r.id);
  if (stale.length) {
    await admin.from('podio_outbox').update({ status: 'superseded', done_at: now(), result: 'A newer move of this submission replaced it.' }).in('id', stale);
    n.superseded += stale.length;
  }
  const work = [...newest.values(), ...ready.filter((r: Any) => r.kind === 'values')];

  const conn: Conn = { client_id: row.client_id, client_secret: row.client_secret, apps: row.apps ?? [], last_mapping: {}, last_import_at: null };
  const podio = new Podio(conn, PUSH_CALL_CAP);
  let fields: Awaited<ReturnType<typeof submissionFieldsOf>>;
  try { fields = await submissionFieldsOf(podio, app); } catch (e) { return { workspace_id: ws, ...n, error: errMsg(e) }; }
  const field = fields.stage;

  const finish = (id: number, status: string, result: string) =>
    admin.from('podio_outbox').update({ status, result, claimed_until: null, ...(status === 'pending' ? {} : { done_at: now() }) }).eq('id', id);
  let error: string | null = null;
  for (const r of work) {
    if (Date.now() > deadline || podio.calls + 2 > PUSH_CALL_CAP) break;
    // Claimed for three minutes, so an overlapping run leaves it alone.
    const { data: claim } = await admin.from('podio_outbox')
      .update({ status: 'sending', claimed_until: new Date(Date.now() + 180_000).toISOString(), attempts: Number(r.attempts ?? 0) + 1 })
      .eq('id', r.id).in('status', ['pending', 'sending']).or(`claimed_until.is.null,claimed_until.lt."${now()}"`).select('id');
    if (!claim?.length) continue;
    const itemId = Number(r.item_id);
    try {
      if (r.kind === 'values') {
        const out = await pushValues(admin, podio, app, fields.money, ws, r);
        if (out.sent) n.sent++; else if (out.already) n.already++; else n.skipped++;
        await finish(r.id, out.sent || out.already ? 'done' : 'skipped', out.result);
        continue;
      }
      if (!field) { n.skipped++; await finish(r.id, 'skipped', 'The Submissions app has no category field named Stage.'); continue; }
      const item = await podio.call(app.app_id, `/item/${itemId}`);
      const cur = (item.fields ?? []).find((f: Any) => Number(f.field_id) === field.field_id);
      const podioNow = String(cur?.values?.[0]?.value?.text ?? '');
      const d = pushDecision({
        to: r.to_stage, options: field.options, podioNow, podioAtMove: r.podio_stage_at_move,
        itemLastEvent: lastEventOf(item), movedAt: r.moved_at,
      });
      if (d.kind === 'skip') {
        n.skipped++;
        await finish(r.id, 'skipped', d.why === 'no such stage in Podio'
          ? `Podio's Stage has no "${r.to_stage}" option; Podio still says "${podioNow || '(blank)'}".`
          : `Podio's stage changed to "${podioNow || '(blank)'}" after this move; Podio's is kept (the sync brings it over).`);
        continue;
      }
      if (d.kind === 'put') await podio.call(app.app_id, `/item/${itemId}/value/${field.field_id}?silent=true`, [d.option.id], 'PUT');
      const text = d.kind === 'put' ? d.option.text : podioNow;
      // The ledger follows: the counts move now, and the next sync sees Podio already agreeing.
      const { data: led } = ok(await admin.from('podio_items').select('applied').eq('workspace_id', ws).eq('item_id', itemId).maybeSingle());
      await admin.from('podio_items').update({
        podio_stage: text, stage_unmapped: false, applied: { ...(led?.applied ?? {}), lead_stage: r.to_stage },
        ...(d.kind === 'put' ? { last_event_on: now() } : {}), synced_at: now(),
      }).eq('workspace_id', ws).eq('item_id', itemId);
      if (d.kind === 'put') n.sent++; else n.already++;
      await finish(r.id, 'done', d.kind === 'put' ? `Podio → ${text}` : `Podio already said ${text}`);
    } catch (e) {
      const m = errMsg(e);
      if (stopsRun(m)) { await finish(r.id, 'pending', m); error = m; break; }
      n.failed++;
      const last = Number(r.attempts ?? 0) + 1 >= PUSH_TRIES;
      await finish(r.id, last ? 'failed' : 'pending', m.slice(0, 300));
      console.error('podio push', ws, itemId, m);
    }
  }
  return { workspace_id: ws, ...n, podio_requests: podio.calls, error };
}

const usd = (v: number) => '$' + Math.round(v).toLocaleString('en-US');

/** One item's offer amounts to Podio: read it, write the fields valuesPush allows in one PUT, and move the ledger with them. */
async function pushValues(
  admin: SupabaseClient, podio: Podio, app: AppCred, money: Partial<Record<MoneyKey, MoneyField>>, ws: number, r: Any,
): Promise<{ sent: boolean; already: boolean; result: string }> {
  const itemId = Number(r.item_id);
  const want = Object.fromEntries(Object.entries((r.vals ?? {}) as Record<string, unknown>).filter(([k]) => k in SUBMISSION_MONEY_FIELDS && money[k as MoneyKey]));
  const missing = Object.keys(r.vals ?? {}).filter((k) => k in SUBMISSION_MONEY_FIELDS && !money[k as MoneyKey]).map((k) => `"${SUBMISSION_MONEY_FIELDS[k as MoneyKey]}"`);
  if (!Object.keys(want).length) return { sent: false, already: false, result: `The Submissions app has no money field ${missing.join(' or ') || 'for these amounts'}.` };
  const item = await podio.call(app.app_id, `/item/${itemId}`);
  const podioNow = Object.fromEntries(MONEY_KEYS.map((k) => [k, money[k] ? podioMoney(item, money[k]!.label) : null]));
  const { data: led } = ok(await admin.from('podio_items').select('applied').eq('workspace_id', ws).eq('item_id', itemId).maybeSingle());
  const d = valuesPush({ want, podioNow, applied: led?.applied ?? null, itemLastEvent: lastEventOf(item), movedAt: r.moved_at });
  const put = Object.entries(d.put) as [MoneyKey, number][];
  if (put.length) {
    await podio.call(app.app_id, `/item/${itemId}?silent=true`, {
      fields: Object.fromEntries(put.map(([k, v]) => [String(money[k]!.field_id), [{ value: String(v), currency: money[k]!.currency }]])),
    }, 'PUT');
  }
  // The ledger follows, so the next sync reads Podio agreeing and leaves the deal alone.
  // The high offer is also what the sync reads as MAO, so that snapshot moves with it.
  const agreed = Object.fromEntries([...put, ...d.already.map((k) => [k, want[k]] as const)].map(([k, v]) => [k, Number(v)]));
  if (Object.keys(agreed).length) {
    await admin.from('podio_items').update({
      applied: { ...(led?.applied ?? {}), ...agreed, ...('institutional_offer' in agreed ? { mao: agreed.institutional_offer } : {}) },
      ...(put.length ? { last_event_on: new Date().toISOString() } : {}), synced_at: new Date().toISOString(),
    }).eq('workspace_id', ws).eq('item_id', itemId);
  }
  const words = [
    put.length ? 'Podio → ' + put.map(([k, v]) => `${SUBMISSION_MONEY_FIELDS[k]} ${usd(v)}`).join(', ') : '',
    d.already.length ? 'Podio already said ' + d.already.map((k) => SUBMISSION_MONEY_FIELDS[k]).join(', ') : '',
    d.skipped.length ? 'kept Podio\'s ' + d.skipped.map((k) => SUBMISSION_MONEY_FIELDS[k]).join(', ') + ' (blank in CLOZR, or changed in Podio after)' : '',
    missing.length ? `no field ${missing.join(', ')} in Podio` : '',
  ].filter(Boolean).join('; ');
  return { sent: put.length > 0, already: !put.length && d.already.length > 0, result: words || 'Nothing to send.' };
}

// ---- History: what happened in Podio before CLOZR ------------------------------
//
// The live sync applies an item's current values and logs moves it sees from
// then on. What happened before (stage moves, offers, comments) only Podio's
// per-item revisions hold: GET /item/{id}/revision/ (the last 30), one
// /revision/{n-1}/{n} diff per change, GET /comment/item/{id}/. That is a few
// requests per item at Podio's 1,000 an hour per app, so it is its own pass
// (podio_history_kick, ten-minutely, migration 147): the items in created
// order, each app with its own request budget, the offset kept in
// podio_connections.history_cursor. Lines go on the item's deal (a submission,
// a pipeline deal) or seller (an acquisition) dated when they happened in
// Podio; external_id keeps a rerun from adding them twice. Changes after the
// live sync first saw the item are left to the live sync.

const HISTORY_APPS = ['submissions', 'acquisitions', 'deals'] as const;
/** Podio requests per app per run: six runs an hour stay ~720/hour, under the 1,000 the app's token gets, with room for the live sync. */
const HISTORY_CALL_CAP = 120;
type HistCursor = { offset: number; total?: number; done_at?: string | null };
type HistCounts = { items: number; lines: number; comments: number; files: number; files_skipped: number; waiting: number; failed: number };
/** Bigger Podio files are listed in the notes, not copied. */
const HISTORY_FILE_MAX = 25 * 1024 * 1024;
const filesOf = (item: Any): Any[] | null => (Array.isArray(item.files) ? item.files : Number(item.file_count ?? 0) > 0 ? null : []);

/**
 * The item's Podio files, copied into storage (deal-files) on its deal: a
 * submission's or pipeline deal's own, an acquisition's newest deal. A seller
 * with no deal keeps none (counted). Keyed podio:file:<id>, so once.
 */
async function historyFiles(admin: SupabaseClient, ws: number, podio: Podio, app: AppCred, item: Any, led: Any, n: HistCounts) {
  const files = filesOf(item) ?? ((await podio.call(app.app_id, `/item/${Number(item.item_id)}`)).files ?? []);
  if (!files.length) return;
  let dealId: number | null = led.deal_id ?? null;
  if (!dealId && led.seller_id) {
    dealId = (await admin.from('deals').select('id').eq('workspace_id', ws).eq('seller_id', led.seller_id).order('id', { ascending: false }).limit(1)).data?.[0]?.id ?? null;
  }
  if (!dealId) { n.files_skipped += files.length; return; }
  const keys = files.map((f: Any) => `podio:file:${f.file_id}`);
  const { data: have } = await admin.from('deal_files').select('source_id').eq('deal_id', dealId).in('source_id', keys);
  const done = new Set((have ?? []).map((r: Any) => r.source_id));
  for (const f of files) {
    const key = `podio:file:${f.file_id}`;
    if (done.has(key)) continue;
    if (Number(f.size ?? 0) > HISTORY_FILE_MAX) { n.files_skipped++; continue; }
    const bytes = await podio.raw(app.app_id, Number(f.file_id));
    const name = String(f.name ?? `podio-${f.file_id}`);
    const type = f.mimetype || 'application/octet-stream';
    const path = `ws/${ws}/deals/${dealId}/podio-${f.file_id}-${name.replace(/[^\w.\- ]+/g, '_').slice(-120)}`;
    const up = await admin.storage.from('deal-files').upload(path, bytes, { contentType: type, upsert: true });
    if (up.error) throw new Error(`upload ${name}: ${up.error.message}`);
    const doc = classifyDoc(name, '', type);
    const { error } = await admin.from('deal_files').insert({
      workspace_id: ws, deal_id: dealId, kind: doc === 'photos' ? 'photo' : 'file', name: name.slice(0, 180), storage_path: path,
      content_type: type, byte_size: bytes.byteLength, source: 'podio', source_id: key, category: doc,
      ...(doc === 'photos' ? {} : { visible_to_buyers: false }),
    });
    if (error && error.code !== '23505') throw new Error(`deal_files ${name}: ${error.message}`);
    n.files++;
  }
}

async function historyItem(admin: SupabaseClient, ws: number, podio: Podio, app: AppCred, item: Any, led: Any, stageOf: (l: string) => string | null, n: HistCounts) {
  const entity = led.deal_id ? { entity_type: 'deal', entity_id: led.deal_id } : { entity_type: 'seller', entity_id: led.seller_id };
  const before = led.first_seen_at ? Date.parse(led.first_seen_at) : Date.now();
  const id = Number(item.item_id);
  const rows: Record<string, unknown>[] = [];
  const rev = Number(item.current_revision?.revision ?? item.revision ?? NaN);
  if (rev !== 0) {
    const revs: Any[] = await podio.call(app.app_id, `/item/${id}/revision/`);
    const steps = revs.filter((r) => Number(r.revision) > 0 && Date.parse(podioIso(r.created_on) ?? '') < before);
    for (let i = 0; i < steps.length; i += 5) {
      const chunk = steps.slice(i, i + 5);
      const diffs = await Promise.all(chunk.map((r) => podio.call(app.app_id, `/item/${id}/revision/${Number(r.revision) - 1}/${r.revision}`)));
      chunk.forEach((r, j) => {
        const by = r.created_by?.name ? ` · ${r.created_by.name}` : '';
        for (const l of historyLines(diffs[j], stageOf)) {
          rows.push({
            workspace_id: ws, ...entity, kind: l.kind, title: l.title, body: `In Podio${l.kind === 'stage' && !/^Dead/i.test(l.title) ? ` (${l.raw})` : ''}${by}`,
            actor_id: null, occurred_at: podioIso(r.created_on), external_id: `podio:${id}:rev${r.revision}:${l.field_id}`,
          });
        }
      });
    }
  }
  if (Number(item.comment_count ?? 1) > 0) {
    const comments: Any[] = await podio.call(app.app_id, `/comment/item/${id}/`).catch((e) => { if (stopsRun(errMsg(e))) throw e; return []; });
    for (const cm of comments) {
      const text = commentText(cm);
      if (!text || Date.parse(podioIso(cm.created_on) ?? '') >= before) continue;
      rows.push({
        workspace_id: ws, ...entity, kind: 'note', title: `Podio comment${cm.created_by?.name ? ' · ' + cm.created_by.name : ''}`, body: text.slice(0, 8000),
        actor_id: null, occurred_at: podioIso(cm.created_on), external_id: `podio:comment:${cm.comment_id}`,
      });
      n.comments++;
    }
  }
  if (rows.length) must(await admin.from('activity').upsert(rows, { onConflict: 'workspace_id,kind,external_id', ignoreDuplicates: true }).select('id'));
  n.lines += rows.length;
  await historyFiles(admin, ws, podio, app, item, led, n);
  n.items++;
}

/** One app's share of a history run: from its offset, item by item, until its budget or the deadline. */
async function historyApp(admin: SupabaseClient, ws: number, conn: Conn, key: string, app: AppCred, cur: HistCursor, deadline: number, n: HistCounts, errors: Any[], callCap = HISTORY_CALL_CAP) {
  const podio = new Podio(conn, callCap);
  let stageOf: (l: string) => string | null = (l) => pipelineStage(l);
  if (key === 'submissions') stageOf = (l) => submissionStage(l);
  if (key === 'acquisitions') {
    // seller_stages is one global list (no workspace_id), as syncPatch reads it.
    const { data } = ok(await admin.from('seller_stages').select('label'));
    const labels = (data ?? []).map((r: Any) => r.label as string);
    stageOf = (l) => sellerStageOf(l, labels);
  }
  for (;;) {
    if (Date.now() > deadline || podio.calls >= callCap - 8) return;
    const page = await podio.call(app.app_id, `/item/app/${app.app_id}/filter/`, { limit: 100, offset: cur.offset, sort_by: 'created_on', sort_desc: false });
    const items: Any[] = page.items ?? [];
    cur.total = Number(page.filtered ?? page.total ?? 0) || cur.total;
    if (!items.length) { cur.done_at = new Date().toISOString(); return; }
    const { data: led } = await admin.from('podio_items').select('item_id,deal_id,seller_id,first_seen_at').eq('workspace_id', ws).in('item_id', items.map((it) => Number(it.item_id)));
    const ledger = new Map((led ?? []).map((r: Any) => [Number(r.item_id), r]));
    for (const it of items) {
      // Room for this item's revisions (up to 30 diffs), comments and files, else the next run.
      const need = 3 + Math.min(30, Number(it.current_revision?.revision ?? it.revision ?? 30)) + (filesOf(it)?.length ?? Number(it.file_count ?? 0));
      // An item bigger than a whole run starts on a fresh budget and finishes over several (files already copied are skipped).
      const room = Math.min(need, callCap - 10);
      if (Date.now() > deadline || podio.calls + room > callCap) return;
      const l = ledger.get(Number(it.item_id));
      // Not synced yet (the live sync's backfill is behind): wait for it.
      if (!l) { n.waiting++; return; }
      if (l.deal_id || l.seller_id) {
        try { await historyItem(admin, ws, podio, app, it, l, stageOf, n); } catch (e) {
          if (stopsRun(errMsg(e))) return;
          n.failed++;
          errors.push({ app: key, item_id: Number(it.item_id), message: errMsg(e).slice(0, 300) });
        }
      }
      cur.offset++;
    }
  }
}

async function historyWorkspace(admin: SupabaseClient, row: Any, deadline: number) {
  const ws = Number(row.workspace_id);
  const conn: Conn = {
    client_id: row.client_id ?? null, client_secret: row.client_secret ?? null, apps: (row.apps ?? []) as AppCred[],
    last_mapping: row.last_mapping ?? {}, last_import_at: row.last_import_at ?? null, connected_by: row.connected_by ?? null, sync_cursor: row.sync_cursor ?? {},
  };
  if (!conn.client_id || !conn.client_secret) return { workspace_id: ws, skipped: 'Podio is not connected.' };
  const cursor: Record<string, HistCursor> = { ...(row.history_cursor ?? {}) };
  const todo = HISTORY_APPS.map((k) => [k, conn.apps.find((a) => a.key === k && a.app_token)] as const)
    .filter((x): x is readonly [typeof HISTORY_APPS[number], AppCred] => !!x[1] && !cursor[x[0]]?.done_at);
  if (!todo.length) return { workspace_id: ws, skipped: 'History is done.' };
  // Stage moves waiting to go back to Podio keep most of the Submissions app's
  // budget. History still runs, on what is left, so a non-empty outbox cannot stall it.
  const { count: queued } = await admin.from('podio_outbox').select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws).in('status', ['pending', 'sending']);
  const submissionsCap = historyCallCap(queued ?? 0, HISTORY_CALL_CAP);
  const n: HistCounts = { items: 0, lines: 0, comments: 0, files: 0, files_skipped: 0, waiting: 0, failed: 0 };
  const errors: Any[] = [];
  let error: string | null = null;
  // Each app has its own token and so its own Podio limit: they run side by side.
  await Promise.all(todo.map(async ([key, app]) => {
    const cur = (cursor[key] = { ...cursor[key], offset: cursor[key]?.offset ?? 0 });
    const cap = key === 'submissions' ? submissionsCap : HISTORY_CALL_CAP;
    try { await historyApp(admin, ws, conn, key, app, cur, deadline, n, errors, cap); } catch (e) { error = errMsg(e); console.error('podio history', ws, key, error); }
  }));
  const notes = { at: new Date().toISOString(), counts: n, errors: errors.slice(0, 30), error, progress: cursor };
  await admin.from('podio_connections').update({ history_cursor: cursor, history_notes: notes }).eq('workspace_id', ws);
  return { workspace_id: ws, ...notes };
}

// ---- handler ------------------------------------------------------------------

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'sign in first' }, 401);

  // The ten-minute live sync: pg_cron with the service role (podio_sync_kick, migration 132), every workspace at once.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const bearer = authHeader.slice(7).trim();
  if (await isServiceCaller(createClient(url, serviceKey, { auth: { persistSession: false } }), bearer)) {
    const admin = createClient(url, serviceKey, { global: { headers: PODIO_SOURCE }, auth: { persistSession: false } });
    const { data: rows, error } = await admin.from('podio_connections').select('*').eq('sync_enabled', true);
    if (error) return serverError(CORS, 'podio-import sync', error);
    const list = rows ?? [];
    const kick = await req.json().catch(() => ({}));
    if (kick?.action === 'history') {
      EdgeRuntime.waitUntil((async () => {
        const deadline = Date.now() + CRON_BUDGET_MS;
        for (const row of list) {
          try { console.log('podio history', JSON.stringify(await historyWorkspace(admin, row, deadline))); } catch (e) { console.error('podio history failed', row.workspace_id, errMsg(e)); }
        }
      })());
      return json({ ok: true, workspaces: list.length }, 202);
    }
    const run = async () => {
      const deadline = Date.now() + CRON_BUDGET_MS;
      // CLOZR's stage moves go to Podio first (inside the same budget), so the sync that follows reads Podio agreeing.
      for (const row of list) {
        try {
          const p = await pushWorkspace(admin, row, Math.min(deadline, Date.now() + PUSH_BUDGET_MS));
          if (p.sent || p.skipped || p.failed || p.error) console.log('podio push', JSON.stringify(p));
        } catch (e) { console.error('podio push failed', row.workspace_id, errMsg(e)); }
      }
      for (const [i, row] of list.entries()) {
        try {
          const r = await syncWorkspace(admin, row, Date.now() + (deadline - Date.now()) / (list.length - i));
          console.log('podio sync', JSON.stringify({ workspace_id: r.workspace_id, skipped: (r as Any).skipped, error: (r as Any).error, counts: (r as Any).counts }));
        } catch (e) {
          console.error('podio sync failed', row.workspace_id, errMsg(e));
        }
      }
    };
    // pg_net gives up after five seconds; the work carries on past the reply.
    EdgeRuntime.waitUntil(run());
    return json({ ok: true, workspaces: list.length }, 202);
  }

  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who.user) return json({ error: 'sign in first' }, 401);

  let body: Any;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(body.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const action = String(body.action ?? 'status');

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { global: { headers: PODIO_SOURCE }, auth: { persistSession: false } });
  const { data: me } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return json({ error: 'only an owner or admin can connect or import from Podio' }, 403);

  const rl = await rateLimit(admin, `podio-import:${who.user.id}`, 600, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  // select('*'): the sync columns (migration 132) are read when they exist, and nothing breaks before.
  // A failed read is not "not connected": `save` would keep no stored token or secret.
  const { data: row, error: rowErr } = await admin.from('podio_connections').select('*').eq('workspace_id', ws).maybeSingle();
  if (rowErr) return serverError(CORS, 'podio-import', rowErr);
  const conn: Conn = { client_id: row?.client_id ?? null, client_secret: row?.client_secret ?? null, apps: (row?.apps ?? []) as AppCred[], last_mapping: row?.last_mapping ?? {}, last_import_at: row?.last_import_at ?? null };
  const dealsApp = conn.apps.find((a) => a.key === 'deals');
  const ready = !!(conn.client_id && conn.client_secret && dealsApp?.app_token);

  try {
    if (action === 'status') {
      // The live sync: what the last run did, and the Podio stage labels CLOZR has no stage for.
      const { data: flagged } = await admin.from('podio_items').select('podio_stage,app_key').eq('workspace_id', ws).eq('stage_unmapped', true).limit(2000);
      const { count: linked } = await admin.from('podio_items').select('item_id', { count: 'exact', head: true }).eq('workspace_id', ws).not('deal_id', 'is', null);
      const { count: unmatched } = await admin.from('podio_items').select('item_id', { count: 'exact', head: true }).eq('workspace_id', ws).is('deal_id', null).not('note', 'is', null);
      const unmapped: Record<string, number> = {};
      const appName: Record<string, string> = { deals: 'Deals', submissions: 'Submissions', acquisitions: 'Acquisitions' };
      for (const f of (flagged ?? []) as Any[]) tally(unmapped, `${appName[f.app_key] ?? f.app_key}: ${f.podio_stage ?? '(blank)'}`);
      const syncApps = conn.apps.filter((a) => (SYNC_APPS as readonly string[]).includes(a.key) && a.app_token).map((a) => a.key);
      const tokenWarn = tokenWarnings(conn.apps.filter((a) => (SYNC_APPS as readonly string[]).includes(a.key)));
      const lastRun = row.last_sync_notes ? { ...row.last_sync_notes } : null;
      if (lastRun && tokenWarn.length) {
        const have = new Set<string>(Array.isArray(lastRun.warnings) ? lastRun.warnings : []);
        lastRun.warnings = [...(Array.isArray(lastRun.warnings) ? lastRun.warnings : []), ...tokenWarn.filter((w) => !have.has(w))];
      }
      // CLOZR → Podio: submission stage moves waiting, and the last ones that did not go (migration 160; none before it).
      const outbox = async (st: string[]) => (await admin.from('podio_outbox').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).in('status', st)).count ?? 0;
      const { data: notSent, error: obErr } = await admin.from('podio_outbox').select('item_id,to_stage,status,result,done_at')
        .eq('workspace_id', ws).in('status', ['skipped', 'failed']).order('id', { ascending: false }).limit(10);
      const push = obErr ? null : {
        waiting: await outbox(['pending', 'sending']), sent: await outbox(['done']), skipped: await outbox(['skipped']), failed: await outbox(['failed']),
        recent: notSent ?? [],
      };
      return json({
        connected: ready, client_id_hint: hint(conn.client_id), has_secret: !!conn.client_secret,
        apps: conn.apps.map((a) => ({ key: a.key, app_id: a.app_id, token_hint: hint(a.app_token) })),
        last_mapping: conn.last_mapping, last_import_at: conn.last_import_at,
        sync: row && 'sync_enabled' in row ? {
          available: true, enabled: !!row.sync_enabled, apps: syncApps, last_sync_at: row.last_sync_at ?? null, last_error: row.last_sync_error ?? null,
          last_run: lastRun, running: !!(row.sync_lock_until && Date.parse(row.sync_lock_until) > Date.now()),
          linked: linked ?? 0, unmatched: unmatched ?? 0, unmapped, push, warnings: tokenWarn,
        } : { available: false },
      });
    }
    if (action === 'sync_enabled') {
      const { error } = await admin.from('podio_connections').update({ sync_enabled: !!body.enabled }).eq('workspace_id', ws);
      if (error) return serverError(CORS, 'podio-import sync_enabled', error);
      return json({ ok: true });
    }
    if (action === 'sync') {
      // "Sync now": the same run the cron makes, for this workspace, inside the request.
      if (!row) return json({ error: 'Podio is not connected.' }, 409);
      if (!('sync_enabled' in row)) return json({ error: 'The live sync needs migration 132 applied first.' }, 409);
      const end = Date.now() + OWNER_BUDGET_MS;
      const push = await pushWorkspace(admin, row, Date.now() + OWNER_BUDGET_MS / 3).catch((e) => ({ error: errMsg(e) }));
      const r = await syncWorkspace(admin, row, end);
      return json({ ok: true, ...r, push });
    }
    if (action === 'save') {
      const apps: AppCred[] = [];
      for (const a of (Array.isArray(body.apps) ? body.apps : []) as Any[]) {
        const appId = Number(a.app_id);
        if (!Number.isInteger(appId) || appId <= 0) continue;
        const token = String(a.app_token ?? '').trim() || conn.apps.find((x) => Number(x.app_id) === appId)?.app_token || '';
        apps.push({ key: String(a.key || 'other').slice(0, 20), app_id: appId, app_token: token });
      }
      const next = {
        workspace_id: ws, connected_by: who.user.id, apps,
        client_id: String(body.client_id ?? '').trim() || conn.client_id,
        client_secret: String(body.client_secret ?? '').trim() || conn.client_secret,
      };
      const { error } = await admin.from('podio_connections').upsert(next, { onConflict: 'workspace_id' });
      if (error) return serverError(CORS, 'podio-import save', error);
      await admin.rpc('audit_event', { p_workspace_id: ws, p_action: 'podio.connect', p_detail: { apps: apps.map((a) => ({ key: a.key, app_id: a.app_id })) } }).then(() => null, () => null);
      return json({ ok: true });
    }
    if (action === 'disconnect') {
      await admin.from('podio_connections').delete().eq('workspace_id', ws);
      return json({ ok: true });
    }

    if (!ready) return json({ error: 'Podio is not connected — save a client ID, client secret and the Deals app ID and token first.' }, 409);
    const podio = new Podio(conn);
    const app = await podio.call(dealsApp!.app_id, `/app/${dealsApp!.app_id}`);
    const fields = fieldsOf(app);

    if (action === 'test') return json({ ok: true, app_name: app.config?.name ?? 'Deals', item_name: app.config?.item_name ?? null, field_count: fields.length });

    const saved: Mapping = (body.mapping && typeof body.mapping === 'object') ? body.mapping : {};
    const known = new Set(fields.map((f) => f.external_id));
    const mapping: Mapping = Object.fromEntries(Object.entries(saved).filter(([k, v]) => typeof v === 'string' && known.has(v) && TARGETS.some((t) => t.key === k)));
    const stageField = fields.find((f) => f.external_id === (mapping.stage ?? guessMapping(fields).stage));

    if (action === 'inspect') {
      const guess = guessMapping(fields);
      const last: Mapping = Object.fromEntries(Object.entries((conn.last_mapping?.mapping ?? {}) as Mapping).filter(([, v]) => known.has(v)));
      const use = Object.keys(last).length ? last : guess;
      const sf = fields.find((f) => f.external_id === use.stage);
      const lastStages: number[] = conn.last_mapping?.stage_option_ids ?? [];
      const referenced = [...new Set(fields.flatMap((f) => f.referenced_apps ?? []))];
      return json({
        app: { app_id: dealsApp!.app_id, name: app.config?.name, item_name: app.config?.item_name },
        fields, targets: TARGETS, guess, mapping: use,
        stage_options: (sf?.options ?? []).map((o) => ({ ...o, clozr: clozrStage(o.text), checked: lastStages.length ? lastStages.includes(o.id) : DEFAULT_IMPORT_STAGES.includes(clozrStage(o.text) ?? '') })),
        referenced_apps: referenced.map((id) => ({ app_id: id, has_token: !!podio.cred(id) })),
      });
    }

    const optionIds: number[] = (Array.isArray(body.stage_option_ids) ? body.stage_option_ids : []).map(Number).filter(Number.isFinite);
    if (!stageField || !optionIds.length) return json({ error: 'pick the stage field and at least one stage' }, 422);
    const warnOnce = new Set<string>();

    if (action === 'preview') {
      const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 50);
      const offset = Math.max(Number(body.offset) || 0, 0);
      const page = await podio.call(dealsApp!.app_id, `/item/app/${dealsApp!.app_id}/filter/`, { filters: { [stageField.field_id]: optionIds }, limit, offset, sort_by: 'created_on', sort_desc: true });
      const items: Any[] = page.items ?? [];
      const full = await Promise.all(items.map((it) => (it.fields ? it : podio.call(dealsApp!.app_id, `/item/${it.item_id}`))));
      const deals = await resolveItems(podio, full, mapping, warnOnce);
      await matchParties(admin, ws, deals);
      await admin.from('podio_connections').update({ last_mapping: { mapping, stage_option_ids: optionIds } }).eq('workspace_id', ws);
      return json({ total: page.filtered ?? page.total ?? items.length, offset, deals: deals.map(({ columns: _c, addr: _a, ...d }) => d), warnings: [...warnOnce] });
    }

    if (action === 'import') {
      const ids: number[] = (Array.isArray(body.item_ids) ? body.item_ids : []).map(Number).filter(Number.isFinite).slice(0, 15);
      if (!ids.length) return json({ error: 'item_ids is required (up to 15 per call)' }, 422);
      const counts: Counts = { deals: { created: 0, updated: 0 }, sellers: { created: 0, updated: 0 }, buyers: { created: 0, updated: 0 }, vendors: { created: 0, updated: 0 }, properties: { created: 0, updated: 0 }, transactions: { created: 0, updated: 0 }, parties: 0, skipped: 0 };
      const imported: Any[] = []; const errors: { item_id: number; message: string }[] = [];
      const failed = (id: number, e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        console.error('podio-import item', id, message);
        errors.push({ item_id: id, message: message.startsWith('Podio') ? message : 'Could not write this deal: ' + message.slice(0, 200) });
        return message.includes('rate limit');
      };
      // Podio first, item by item as before. Then the page's people, deals, properties and import
      // lines in one read each, and the deals written in order, each seeing what the ones before it wrote.
      const page: { id: number; d?: Resolved; skip?: true; err?: unknown }[] = [];
      for (const id of ids) {
        try {
          const item = await podio.call(dealsApp!.app_id, `/item/${id}`);
          const [d] = await resolveItems(podio, [item], mapping, warnOnce);
          page.push(optionIds.some((o) => (fieldOf(item, stageField.external_id)?.values ?? []).some((v: Any) => v.value?.id === o)) ? { id, d } : { id, skip: true });
        } catch (e) {
          page.push({ id, err: e });
          if (errMsg(e).includes('rate limit')) break;
        }
      }
      const pre = newPre();
      const ds = page.flatMap((x) => (x.d ? [x.d] : []));
      if (ds.length) await Promise.all([loadPeople(admin, ws, pre, ds), loadPlaces(admin, ws, pre, ds)]);
      for (const x of page) {
        if (x.skip) { counts.skipped++; continue; }
        if (!x.d) { failed(x.id, x.err); continue; }
        try {
          await matchParties(admin, ws, [x.d], pre);
          const r = await writeDeal(admin, ws, who.user.id, x.d, counts, {}, pre);
          if (r) imported.push(r);
        } catch (e) {
          if (failed(x.id, e)) break;
        }
      }
      await admin.from('podio_connections').update({ last_import_at: new Date().toISOString(), last_mapping: { mapping, stage_option_ids: optionIds } }).eq('workspace_id', ws);
      return json({ ok: true, counts, imported, errors, warnings: [...warnOnce] });
    }
    return json({ error: 'action must be status, save, disconnect, test, inspect, preview, import, sync or sync_enabled' }, 422);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('Podio')) return json({ error: message }, 502);
    return serverError(CORS, 'podio-import', e);
  }
});
