// Workspace-level integration settings and the calendar feed.
//
// Keys live in workspaces.settings (jsonb) and are readable by every member,
// writable by owner/admin (RLS). The Google Places key is a browser key by
// nature — it is sent to Google from the visitor's browser and should be
// restricted to this site's domain in the Google console, which is what makes
// it safe to keep here rather than behind a function. COMPR's and Claude's
// keys are project secrets (COMPR_API_KEY, ANTHROPIC_API_KEY) read only by
// the edge functions; the browser never sees them.

import { SUPABASE_URL, supabase } from './supabase';
import type { TenDlcFacts } from '../supabase/functions/_shared/tendlc';
import type { RegistryFacts } from '../supabase/functions/_shared/caller-registry';
import type { RvmPoolSettings } from './rvm-pool';

/**
 * The Google Places key, checked in like the Supabase publishable key and for
 * the same reason: it is sent to Google from the visitor's browser on every
 * address field, so it is public by construction. Hiding it in a dashboard
 * hides it from the repo and from nobody else — what makes it safe is the
 * website restriction on the key in the Google console, not secrecy.
 *
 * Baking it in is also what keeps setup to nothing. A new workspace gets
 * working address autocomplete on the day it is created, with no one to tell
 * and no field to fill in. A workspace that wants its own billing can still
 * override it (workspaces.settings.places_key), which is the only reason that
 * column still exists.
 */
const DEFAULT_PLACES_KEY = '';
export const PLACES_KEY = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY || DEFAULT_PLACES_KEY;

export type WorkspaceSettings = {
  /**
   * Optional override for PLACES_KEY above — only for a workspace that bills
   * its own Google project. Normally unset, and there is no UI for it.
   */
  places_key?: string;
  /**
   * Talkr Platform API origin. Empty means the production deployment. No key:
   * Talkr trusts this workspace's Supabase sign-in directly (see lib/talkr.ts).
   */
  talkr_url?: string;
  /**
   * Talkr kill switch. `enabled: false` stops server and browser mirrors for
   * this workspace. The org id on the row in `talkr_connections` is what the
   * sync trusts; this copy is for the settings screen.
   */
  talkr?: {
    enabled?: boolean; org_id?: string;
    /**
     * Migration 275: other workspaces (same owner) on this Talkr org whose
     * contacts' calls and texts are filed there and kept out of this one
     * (lib/talkr-elsewhere). Settings → Talkr → Account edits it.
     */
    elsewhere?: number[];
  };
  /** What contracts print for the buying entity, and who signs for it. */
  company?: { name?: string; legal?: string; address?: string; signer?: string; title?: string; email?: string; phone?: string;
    /** Who holds the earnest money on the purchase agreement; defaults to the legal entity. */
    escrow?: string;
    /** The letterhead logo on documents CLOZR lays out itself: a small PNG or JPEG data URL (see ContractSettings). */
    logo?: string;
    /** The agent block TREC and state forms print ({{company.brokerage_*}}, {{company.supervisor_*}}). */
    brokerage_name?: string; brokerage_address?: string; brokerage_license?: string;
    supervisor_name?: string; supervisor_phone?: string; supervisor_license?: string };
  /**
   * Reps zeroed on the leaderboard after a bulk import. Values are ISO
   * timestamps; activity before that instant is left off their numbers.
   */
  leaderboard_resets?: Record<string, string>;
  /** The board's day and week boundaries (IANA zone); unset is America/Chicago. */
  leaderboard_tz?: string;
  /** Members left off the board (non-selling owners, admins, TCs), by user id. */
  leaderboard_exclude?: string[];
  /** The TV's goals: monthly closed revenue, pipeline total, termination ceiling. */
  leaderboard_goals?: { monthlyClosed?: number; pipelineTotal?: number; terminationPercentMax?: number };
  /** The monthly wheel prize, and when an admin last set it. */
  floor_show?: { monthlyPrize?: string; monthlyDetail?: string; updatedAt?: string | null };
  /** How offers are priced and whether COMPR runs generate one automatically. */
  offers?: { auto?: boolean; basis?: 'mao' | 'wholesale' | 'pct_arv'; pct?: number; round_to?: number; expires_days?: number; emd?: number; close_days?: number; send?: boolean;
    /** Which template Generate offer fills; defaults to the cash offer letter. */
    template_key?: string;
    /** The offer document: a Acme Homes template signed in CLOZR (default), or PandaDoc when an API key is on the project. */
    engine?: 'clozr' | 'pandadoc'; pandadoc_template_id?: string; pandadoc_template_name?: string;
    /** How a sent offer reaches the seller: email (default on), and a text with the signing link. */
    email?: boolean; sms?: boolean };
  /** The 10DLC brand and campaign facts ten-dlc-register files (Settings → Workspace → Company & 10DLC). */
  ten_dlc?: TenDlcFacts;
  /** The Telnyx enterprise contact, Free Caller Registry inbox and branded calling (caller-registry). */
  caller_registry?: RegistryFacts;
  /** The RVM number pool's warm-up ramp, ceiling and per-drop cost (lib/rvm-pool.ts, rvm-tick). */
  rvm_pool?: RvmPoolSettings;
  /**
   * This workspace's blast sender, "Acme Homes <deals@deals.yourcompany.com>". Written
   * only by the deliverability function (blast_sender); unset means the
   * project's MAIL_FROM_BLASTS.
   */
  blast_from?: string;
  /** Extra Resend blast domains beyond the blast sender's (each verified on Resend first). */
  blast_domains?: string[];
  /** Blast addresses per rep per domain (default 10, at most 25). */
  blast_addresses_per_rep?: number;
};

export type { RvmPoolSettings };

/**
 * Boot asks for the settings from several places at once (the workspace
 * load, the floor, Talkr). One read serves them all for SETTINGS_MEMO_MS, for
 * one workspace at a time; saveSettings and a failed read drop it. Each
 * caller gets its own copy, as each got its own read before.
 */
const SETTINGS_MEMO_MS = 10_000;
let settingsMemo: { ws: number; at: number; p: Promise<WorkspaceSettings> } | null = null;

export function loadSettings(workspaceId: number): Promise<WorkspaceSettings> {
  const sb = supabase;
  if (!sb) return Promise.resolve({});
  let m = settingsMemo;
  if (!m || m.ws !== workspaceId || Date.now() - m.at >= SETTINGS_MEMO_MS) {
    const p = Promise.resolve(sb.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle()).then(({ data, error }) => {
      if (error) settingsMemo = null;
      return (data?.settings as WorkspaceSettings | null) ?? {};
    });
    p.catch(() => { settingsMemo = null; });
    m = settingsMemo = { ws: workspaceId, at: Date.now(), p };
  }
  return m.p.then((s) => structuredClone(s));
}

export async function saveSettings(workspaceId: number, patch: WorkspaceSettings): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // Merged onto a fresh read, not the memo; the next load reads what was saved.
  settingsMemo = null;
  const current = await loadSettings(workspaceId);
  const next: WorkspaceSettings = { ...current, ...patch };
  for (const k of Object.keys(next) as (keyof WorkspaceSettings)[]) if (!next[k]) delete next[k];
  const { error } = await supabase.from('workspaces').update({ settings: next }).eq('id', workspaceId);
  settingsMemo = null;
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** The ICS URL Google Calendar subscribes to. Minting is idempotent; rotate invalidates the old one. */
export async function calendarFeedUrl(workspaceId: number, rotate = false): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('ensure_calendar_token', { ws: workspaceId, rotate });
  if (error || !data) return { ok: false, message: error?.message ?? 'Could not mint a token.' };
  return { ok: true, url: `${SUPABASE_URL}/functions/v1/calendar-feed?token=${data}` };
}
