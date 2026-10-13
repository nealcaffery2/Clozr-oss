// The browser half of the Podio import. Everything that talks to Podio — and
// the client secret and app tokens — stays in the podio-import edge function;
// this module only calls it and names the shapes it answers with.

import { supabase } from './supabase';

export type PodioAppKey = 'deals' | 'submissions' | 'contacts' | 'buyers' | 'vendors' | 'team' | 'wholesalers' | 'acquisitions' | 'communications' | 'deals2' | 'other';
export type PodioStatus = {
  connected: boolean; client_id_hint: string | null; has_secret: boolean;
  apps: { key: PodioAppKey; app_id: number; token_hint: string | null }[];
  last_mapping: { mapping?: Record<string, string>; stage_option_ids?: number[] } | null; last_import_at: string | null;
  /** The ten-minute live sync (podio-import `sync`, migration 132). `available: false` until the migration is applied. */
  sync?: PodioSyncStatus;
};
export type PodioSyncCounts = { seen: number; unchanged: number; created: number; updated: number; stage_moves: number; unmapped: number; ambiguous: number; skipped: number; failed: number; comms?: number; comms_linked?: number };
export type PodioSyncRun = {
  at: string; counts: PodioSyncCounts; podio_requests: number; unmapped: Record<string, number>;
  ambiguous: { app: string; item_id: number; deal_ids: number[] }[]; errors: { app: string; item_id: number; message: string }[];
  warnings: string[]; progress: Record<string, { done: number; of: number | null; full: boolean } | null>;
};
export type PodioSyncStatus =
  | { available: false }
  | {
    available: true; enabled: boolean; apps: string[]; last_sync_at: string | null; last_error: string | null; last_run: PodioSyncRun | null;
    running: boolean; linked: number; unmatched: number; unmapped: Record<string, number>;
    /** Apps saved without a token ("Submissions app has no token: not syncing"). Also copied onto last_run.warnings. */
    warnings?: string[];
    /** CLOZR → Podio: submission stage moves made here, written back to the Podio item (migration 160). null before it. */
    push?: PodioPushStatus | null;
  };
export type PodioPushStatus = {
  waiting: number; sent: number; skipped: number; failed: number;
  recent: { item_id: number; to_stage: string | null; status: 'skipped' | 'failed'; result: string | null; done_at: string | null }[];
};
export type PodioSyncResult = Partial<PodioSyncRun> & { workspace_id: number; skipped?: string; error?: string | null };

const APP_LABEL: Record<string, string> = { submissions: 'Submissions', deals: 'Deals', acquisitions: 'Acquisitions', communications: 'Communications' };

/** One line for what a sync run did ("212 read · 3 new · 14 updated · 6 stage moves"). */
export function syncSummary(r: Pick<PodioSyncRun, 'counts'> & Partial<PodioSyncRun>): string {
  const c = r.counts;
  const parts = [`${c.seen} read`, `${c.created} new`, `${c.updated} updated`, `${c.stage_moves} stage move${c.stage_moves === 1 ? '' : 's'}`];
  if (c.comms) parts.push(`${c.comms.toLocaleString('en-US')} calls and texts (${(c.comms_linked ?? 0).toLocaleString('en-US')} on a contact)`);
  if (c.unmapped) parts.push(`${c.unmapped} with a stage CLOZR does not have`);
  if (c.ambiguous) parts.push(`${c.ambiguous} matching more than one record`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.join(' · ');
}

/** "Submissions: first pass, 300 of 3,700" for every app with a pass still in progress. */
export function syncProgress(p: PodioSyncRun['progress'] | null | undefined): string[] {
  return Object.entries(p ?? {}).flatMap(([k, v]) => (v ? [`${APP_LABEL[k] ?? k}: ${v.full ? 'first pass' : 'catching up'}, ${v.done.toLocaleString('en-US')}${v.of ? ' of ' + v.of.toLocaleString('en-US') : ''}`] : []));
}
export type PodioFieldDef = { field_id: number; external_id: string; type: string; label: string; options?: { id: number; text: string; clozr: string | null }[]; referenced_apps?: number[] };
export type PodioTarget = { key: string; label: string; group: string; kind: string; role?: string; types: string[] };
export type PodioInspect = {
  app: { app_id: number; name: string; item_name: string };
  fields: PodioFieldDef[]; targets: PodioTarget[]; guess: Record<string, string>; mapping: Record<string, string>;
  stage_options: { id: number; text: string; clozr: string | null; checked: boolean }[];
  referenced_apps: { app_id: number; has_token: boolean }[];
};
export type PodioParty = {
  target: string; role: string; ref: string; source_id: string; name: string; email: string | null; phone: string | null; company: string | null;
  match: { table: 'sellers' | 'buyers' | 'vendors' | 'team'; id: number | string; label: string } | null;
};
export type PodioDeal = {
  item_id: number; title: string; link: string | null; address: string | null; podio_stage: string | null; stage: string | null;
  parties: PodioParty[]; warnings: string[]; existing_deal_id: number | null;
};
export type PodioPreview = { total: number; offset: number; deals: PodioDeal[]; warnings: string[] };
type Pair = { created: number; updated: number };
export type PodioImportResult = {
  counts: { deals: Pair; sellers: Pair; buyers: Pair; vendors: Pair; properties: Pair; transactions: Pair; parties: number; skipped: number };
  imported: { item_id: number; deal_id: number; seller_id: number | null; address: string }[];
  errors: { item_id: number; message: string }[]; warnings: string[];
};

export async function podio<T>(workspaceId: number, action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('podio-import', { body: { workspace_id: workspaceId, action, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    throw new Error(message);
  }
  return data as T;
}
