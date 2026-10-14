// The workspace, loaded from Supabase in the shape the screens already speak.
//
// Every CLOZR screen renders `D` from lib/clozr-types.ts — a bundled sample
// graph. This module produces the same shape from the signed-in user's own
// rows, so the screens do not have to change: useClozr merges what comes back
// over `D` and the rest of the app never learns where its data came from.
//
// Two categories deliberately do NOT come from here and fall through to the
// bundled module:
//
//   Reference content — STAGES, IMG, rehab presets, exit templates, the TC
//   checklist templates, the automation palette. That is product configuration,
//   the same for every workspace, and belongs in the bundle.
//
//   Underwriting output — comps, propertyIntel. Those are COMPR's, and they
//   arrive through the ingest door like everything else rather than being
//   invented here.
//
// Anything with a table returns real rows, and an empty workspace returns empty
// arrays rather than the sample data. That is the whole point: a blank CRM has
// to look blank.

import { bellFromComms } from './bell-events';
import { notifLink } from './notif-target';
import {
  D,
  type ActionPlan, type Buyer, type CalendarDay, type Comp, type Communication, type Deal, type Enrollment, type InboxItem,
  type Notification, type Offer, type Person, type PlanStep, type Property, type Rep, type Task, type TimelineEntry,
  type TcChecklist, type TcDeadline, type TcDocument, type TcEarnest, type Transaction, type Walkthrough,
} from './clozr-types';
import { laneDrive } from './lane';
import { emailPlain, looksLikeHtml } from './email-html';
import { supabase } from './supabase';
import { listingUrl } from './dispo';
import { canonicalPhotos, collectPhotos, isGalleryImage, photosLineUrls, urlsIn } from './house-photos';
import { contractSla, localIsoDay, plusIsoDays, type ContractSla } from './deal-close';
import { PIPELINE_STAGES, buyerStageOf, clozrHeldStage, podioStageLabel, type PodioSubmission } from './stages';
import { teamTc } from './team';
import { type BuyBox, labelOf, normalizeBuyBox, summarizeBuyBox, BUYER_TYPES, CHANNELS } from './buyer-profile';
import type { ReportRaw } from './reporting';
import type { OfferGapPersonRow, OfferGapRow } from './database.types';
import { dealTypeLabel } from './deal-types';
import { dealMarketLabel, marketLabel, normalizeMarkets, normalizePlace } from './place-names';
import { BULK_BUYER_SOURCE, PROSPECT_LISTS, prospectListId } from './prospect-lists';
import { isTireKicker } from './tire-kicker';
import { type KeyCol, type Page, keysetRead } from './keyset';
import { DELTA_MAX_AGE_MS, type RowCache, mergeDelta, newestStamp, sinceOf } from './delta-rows';
import { vendorSellersByDeal, type SellerPartyRow } from './vendor-sellers';

/** The slice of the graph this module can speak for. */
export type LiveData = {
  /** Pipeline columns: the deal stages (lib/stages). Overrides the sample graph's twelve. */
  STAGES: string[];
  /** deal ↔ buyer matches the database wrote (deal_buyer_matches), keyed by prefixed ids. */
  matches: MatchView[];
  team: Record<string, Rep>;
  people: Person[];
  /** Archived sellers that still own an open deal: on their records, never on a People list. */
  archivedPeople?: Person[];
  deals: Deal[];
  /** Every Podio Submissions item with Podio's own stage (lib/stages PodioSubmission); empty without the Podio sync. */
  podioSubmissions?: PodioSubmission[];
  buyers: Buyer[];
  vendors: ReturnType<typeof mapVendor>[];
  /**
   * Migration 70's offer_gaps / offer_gap_people: how close each offer came to
   * the ask, and that rolled up to the person to call back. The views own the
   * arithmetic and de-duplicate deals carrying two wholesaler parties, so the
   * screens read gaps rather than recompute them.
   */
  offerGaps: OfferGap[];
  offerGapPeople: OfferGapPerson[];
  communications: Communication[];
  timeline: TimelineEntry[];
  tasks: Task[];
  inbox: InboxItem[];
  notifications: Notification[];
  enrollments: Enrollment[];
  actionPlans: ActionPlan[];
  offers: Offer[];
  walkthroughs: Walkthrough[];
  calendar: CalendarDay[];
  transactions: Transaction[];
  /**
   * Underwriting output, and a buyer-portal feed CLOZR does not collect. Listed
   * here so a live workspace gets an empty one rather than falling through to
   * the bundled sample — which is how someone else's comps ended up on a
   * signed-in user's screen.
   */
  comps: Comp[];
  propertyIntel: [string, string, string][];
  engagementFeed: [string, string][];
  tcItems: never[];
  tcBlockers: never[];
  tcFeed: never[];
  reporting: {
    kpis: [string, string, string][];
    funnel: [string, string, number][];
    activity: [string, string][];
    leaderboard: { rep: string; calls: number; talk: string; contacts: number; offers: number; contracts: number; revenue: string; conv: string }[];
    sources: [string, number, string][];
    monthly: number[];
    /** The rows behind the Reporting screen, with real timestamps (lib/reporting.ts). */
    raw?: ReportRaw;
  };
};

// ---- formatting -------------------------------------------------------------
// The mock graph stores display strings ("3h ago", "Today", "$186,000") because
// it was lifted from a design prototype. Rather than rewrite every screen to
// format at render time, the mapping does it here, once.

const MIN = 60_000;

/** Minutes between then and now; the record timelines sort on this. */
function minutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / MIN));
}

export function relative(iso: string | null): string {
  const m = minutesAgo(iso);
  if (m === null) return '—';
  if (m < 1) return 'Just now';
  if (m < 60) return m + 'm ago';
  if (m < 60 * 24) return Math.floor(m / 60) + 'h ago';
  const d = Math.floor(m / (60 * 24));
  if (d === 1) return 'Yesterday';
  if (d < 7) return d + 'd ago';
  return new Date(iso!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Today" / "Tomorrow" / "Sep 30" — what the task and calendar rows show. */
function dayLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(new Date())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return 'Overdue · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Which list a task belongs in, from its due date rather than its label: the
 * label says "Yesterday" for a day-late task, and a text match on "overdue"
 * filed that one under upcoming, off the queue a rep works from. Anything due
 * before the start of today is overdue; anything due before tomorrow is today.
 */
function dueBucket(iso: string | null): 'overdue' | 'today' | 'upcoming' {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'upcoming';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return t < today ? 'overdue' : t < tomorrow ? 'today' : 'upcoming';
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const money = (n: number | null | undefined) =>
  n == null ? null : '$' + Math.round(Number(n)).toLocaleString('en-US');

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ---- row shapes -------------------------------------------------------------
// Narrow local types rather than the generated Database types: these describe
// exactly the columns selected below, so a change to the select fails here
// rather than somewhere downstream.

type SellerRow = {
  id: number; name: string; email: string | null; phone: string | null;
  property_address: string | null; asking_price: number | null; motivation: string | null;
  timeline: string | null; condition: string | null; occupancy: string | null;
  mortgage: string | null; desired_close: string | null; decision_makers: string | null;
  intake?: Record<string, unknown> | null;
  lead_stage: string; stage_entered_at: string | null; notes: string | null; source: string | null;
  created_at: string; created_by: string | null; property_id: number | null;
  assigned_to: string | null; tags: string[] | null;
  properties: PropertyRow | null;
};
type PropertyRow = {
  id: number; line1: string; city: string | null; state: string | null; zip: string | null;
  beds: number | null; baths: number | null; sqft: number | null; year_built: number | null;
  property_type: string | null; apn: string | null;
  /** Geocoded point, for the People map. */
  lat?: number | null; lng?: number | null;
};
type CommRow = {
  id: number; seller_id: number | null; deal_id?: number | null; channel: string; direction: string | null;
  occurred_at: string; body: string | null; summary: string | null; subject: string | null;
  duration_s: number | null; recording_url: string | null; from_phone: string | null;
  status: string | null; source: string;
  buyer_id: number | null;
  /** Email only: the sender and the To/Cc list, as the sync stored them. */
  from_email?: string | null; to_email?: string | null;
  /** The source's own id; for Gmail, the RFC Message-ID a reply threads on. */
  source_id?: string | null;
  /** Migration 67: the AI summary of a recorded call, when call-sync has it. */
  ai_notes: { summary?: string | null; next_step?: string | null } | null; score_overall: number | null;
  /** Who sent or took it (migration 153 fills it from the line when the source did not). */
  rep_id?: string | null; to_phone?: string | null;
  /** Migration 269: the AI agent that sent it, when one did. */
  ai_agent_key?: string | null;
};
type DealRow = {
  /** Migration 118. */
  archived_at?: string | null; archived_reason?: string | null;
  id: number; seller_id: number | null; stage: string; stage_entered_at: string | null; offer_amount: number | null;
  created_at: string;
  arv: number | null; rehab: number | null; mao: number | null;
  wholesale_offer?: number | null; institutional_offer?: number | null; assignment_fee: number | null;
  hero_image_url: string | null; buyer_report_url: string | null; compr_cma_url: string | null;
  /** Migration 120: the submission's source photo link (Podio Photos, a folder, a listing). */
  photos_url?: string | null;
  contract_date: string | null; close_date: string | null;
  option_ends_on?: string | null; buyer_option_ends_on?: string | null;
  owner_id: string | null;
  market: string | null; updated_at: string; buyer_id: number | null;
  underwriting_url: string | null;
  /** Migration 169: the Podio "Ai Compr Tool" report link. */
  compr_report_url?: string | null;
  /** Migration 46: the deal's title company (kept in step with its title party). */
  title_vendor_id?: number | null; title_contact?: string | null; title_email?: string | null;
  // Deal sheet fields its section reminders check (lib/section-gaps).
  title_phone?: string | null; earnest_money?: number | null; condition_notes?: string | null; occupancy_notes?: string | null;
  dispo_rep_id?: string | null; tc_rep_id?: string | null; marketing_started_on?: string | null;
  // Deal Tracker columns (migration 45).
  tracker_no: number | null; closed_on: string | null; sold_price: number | null;
  property_id: number | null; lead_stage: string | null; asking_price: number | null; submitted_at: string | null; target_assignment: number | null;
  marketing_headline: string | null; marketing_description: string | null; marketing_url: string | null; garage_spaces: number | null;
  price_drop: number | null; marketed_price: number | null; marketed_fee: number | null;
  dispo_upsell: number | null; dispo_fee: number | null; transaction_type: string | null;
  contract_status: string | null; lead_source: string | null; acq_agent: string | null;
  dispo_agent: string | null; lead_manager: string | null; coordinator: string | null;
  /** The deal's house. Embedded on the deals read so the shell does not also page the whole properties table. */
  properties?: { line1: string; city: string | null; state: string | null; zip: string | null; lat?: number | null; lng?: number | null } | { line1: string; city: string | null; state: string | null; zip: string | null; lat?: number | null; lng?: number | null }[] | null;
};
type MatchRow = { id: number; deal_id: number; buyer_id: number; score: number; reasons: string[]; status: string; sent_at: string | null; viewed_at: string | null; replied_at: string | null; updated_at: string };
export type OfferGap = {
  dealId: string;
  /** Prefixed ids, so the People and vendor lists can key on them directly. */
  vendorId: string | null;
  sellerId: string | null;
  company: string; contact: string; address: string; stage: string;
  ask: number; offer: number; high: number | null;
  gapToOffer: number; gapToHigh: number | null; closestGap: number;
  at: string | null;
};
export type OfferGapPerson = {
  kind: 'vendor' | 'seller';
  /** Prefixed: 'v12' for a wholesaler contact, 's34' for a seller. */
  id: string;
  company: string; contact: string; email: string; phone: string;
  offers: number; closeCalls: number;
  closestGap: number | null; closestToOffer: number | null; closestToHigh: number | null;
  declined: number; won: number; lastOfferAt: string | null;
};

export type MatchView = { id: string; dealId: string; buyerId: string; score: number; reasons: string[]; status: string; sent: string | null; viewed: string | null; replied: string | null };
type TaskRow = {
  id: number; seller_id: number | null; deal_id: number | null; buyer_id: number | null;
  title: string; task_type: string; priority: string;
  due_at: string | null; assigned_to: string | null; done: boolean;
  notes: string | null; completed_at: string | null; created_at: string;
};
type BuyerRow = {
  id: number; name: string; company: string | null; email: string | null; phone: string | null; created_by?: string | null;
  markets: string[]; max_purchase_price: number | null; buy_box: string | null;
  status: string; notes: string | null; source: string | null;
  buyer_type: string | null; criteria: unknown; vetted_at: string | null; vip: boolean; blacklisted_at: string | null;
  preferred_channel: string; created_at: string; last_activity_at: string | null; tags: string[] | null;
  entity_type: string | null;
};
type VendorRow = {
  id: number; business_name: string; contact_name: string | null; email: string | null;
  phone: string | null; service_type: string | null; markets: string[]; status: string;
  notes: string | null;
  /** Migration 80: where this contact works, and whether they are the company's main contact there. */
  city?: string | null; state?: string | null; office_address?: string | null; is_main_poc?: boolean;
  /** Migration 91: the source's true count, kept by refresh_vendor_source_stats. */
  deals_brought?: number | null; offers_sent?: number | null; offers_accepted?: number | null; deals_closed?: number | null;
};
type NotificationRow = {
  id: number; category: string; title: string; body: string | null;
  seller_id: number | null; buyer_id?: number | null; deal_id?: number | null; read_at: string | null; created_at: string;
  /** Set when addressed to one member (the select is theirs or nobody's). */
  user_id?: string | null;
  /** Migration 152: the other side's number on a text notification. */
  phone_key?: string | null;
};
type PinRow = { id: number; pinned_at: string | null; pinned_by: string | null };
type ActivityRow = {
  id: number; entity_type: string; entity_id: number; kind: string; title: string;
  body: string | null; actor_id: string | null; occurred_at: string;
  /** Migration 269: the AI agent behind an 'ai_agent' line. */
  ai_agent_key?: string | null;
};
type PlanRow = {
  id: number; name: string; trigger_event: string | null; active: boolean;
  description?: string | null;
  settings?: unknown;
  action_plan_steps: { id: number; position: number; channel: string; delay_hours: number; title: string | null; body: string | null }[];
};
type EnrollmentRow = { id: number; plan_id: number; seller_id: number | null; buyer_id?: number | null; status: string; step_index: number };
type OfferRowDb = {
  id: number; deal_id: number | null; buyer_id: number | null; amount: number | null; status: string; sent_at: string;
  /** What the buyer attached: emd, close_days, contingency (lib/buyer-desk). Null on older rows. */
  terms: { emd?: number | null; close_days?: number | null; contingency?: string | null } | null;
};
type AppointmentRow = {
  id: number; seller_id: number | null; buyer_id: number | null;
  title: string; kind: string; starts_at: string;
  assigned_to: string | null; source: string | null; created_at: string; deleted_at: string | null;
};
type MemberRow = { user_id: string; role: string; profiles: { full_name: string | null; title: string | null; avatar_url: string | null; email?: string | null } | null };

// ---- id conventions ---------------------------------------------------------
// The screens key on string ids and the database uses bigints, so every id is
// prefixed by entity. The prefixes also keep a seller and a buyer with the same
// numeric id from colliding in the shared lookups the shell does.

const sid = (n: number) => 's' + n;
const did = (n: number) => 'd' + n;
const bid = (n: number) => 'b' + n;
const cid = (n: number) => 'c' + n;
const kid = (n: number) => 'k' + n;

// ---- mapping ----------------------------------------------------------------

const BLANK_PROPERTY: Property = {
  addr: '—', city: '', st: '', zip: '', beds: 0, baths: 0, sqft: 0, year: 0,
  lot: '—', type: '—', img: '', apn: '—',
};

/**
 * The market a lead belongs to: city and a state abbreviation, "Charlotte, NC".
 * A deal market that is only a state ("NC", "North Carolina") uses the
 * property's city. Never a spelled-out state name.
 */
export function personMarket(dealMarket: string | null | undefined, city: string | null | undefined, state: string | null | undefined): string {
  return dealMarketLabel(dealMarket, city, state) || '—';
}

function mapProperty(p: PropertyRow | null, fallbackAddress: string | null): Property {
  if (!p) return { ...BLANK_PROPERTY, addr: fallbackAddress || '—' };
  // One spelling per place (lib/place-names): a state typed into the city column
  // moves over, "san antonio tx" reads San Antonio, TX. Migration 122 fixes
  // the rows themselves; this keeps the screens right for a row it has not
  // reached yet.
  const place = normalizePlace({ city: p.city, state: p.state, zip: p.zip });
  return {
    propertyId: String(p.id),
    addr: p.line1,
    city: place.city || '',
    st: place.state || '',
    zip: place.zip || '',
    beds: Number(p.beds ?? 0),
    baths: Number(p.baths ?? 0),
    sqft: p.sqft ?? 0,
    year: p.year_built ?? 0,
    lot: '—',
    type: p.property_type || '—',
    // No photo until a source sends one; the screens fall back to a placeholder.
    img: '',
    apn: p.apn || '—',
    ...(p.lat != null && p.lng != null ? { lat: Number(p.lat), lng: Number(p.lng) } : {}),
  };
}

function mapVendor(v: VendorRow) {
  const place = normalizePlace({ city: v.city, state: v.state });
  const markets = normalizeMarkets(v.markets, place.state);
  return {
    id: 'v' + v.id,
    name: v.business_name,
    kind: v.service_type || 'Contractor',
    contact: v.contact_name || '—',
    phone: v.phone || '—',
    email: v.email || '—',
    market: marketLabel(markets[0]) || 'All',
    rating: 0,
    note: v.notes || '',
    city: place.city || '',
    state: place.state || '',
    markets,
    office: v.office_address || '',
    mainPoc: !!v.is_main_poc,
    subs: v.deals_brought ?? 0,
    offered: v.offers_sent ?? 0,
    accepted: v.offers_accepted ?? 0,
    closed: v.deals_closed ?? 0,
  };
}

/** List copy: a summary when there is one, otherwise the words of the body. HTML stays out of the row. */
function mailPreview(summary: string | null | undefined, body: string | null | undefined, fallback: string): string {
  if (summary && !looksLikeHtml(summary)) return summary;
  const raw = body || '';
  if (!raw) return fallback;
  if (looksLikeHtml(raw)) return emailPlain(raw).replace(/\s+/g, ' ').trim().slice(0, 280) || fallback;
  return raw;
}

function mapCommunication(c: CommRow, sellerName: Map<number, string>): Communication {
  const party = c.seller_id ? sellerName.get(c.seller_id) || 'Unknown' : c.from_phone || 'Unknown';
  return {
    id: cid(c.id),
    personId: c.seller_id ? sid(c.seller_id) : '',
    ...(c.buyer_id ? { buyerId: bid(c.buyer_id) } : {}),
    channel: c.channel,
    dir: c.direction === 'inbound' ? 'in' : 'out',
    party,
    // Attribution comes from the activity/actor trail, not the communications
    // row — an inbound call has no rep until someone picks it up.
    user: null,
    ts: minutesAgo(c.occurred_at) ?? 0,
    time: relative(c.occurred_at),
    preview: mailPreview(c.summary, c.body, c.subject || '—'),
    ...(c.duration_s ? { dur: Math.floor(c.duration_s / 60) + 'm ' + (c.duration_s % 60) + 's' } : {}),
    ...(c.status ? { status: c.status } : {}),
  };
}

/**
 * One seller record's communications, read on their own rather than out of
 * the workspace-wide load (the newest 500 rows across everyone). A deal's
 * email — its buyer, its title company, anyone else on the thread — carries
 * the deal but not the seller (migration 78, gmail-match.ts), so it never
 * reached the record; and on a busy workspace an older thread falls past the
 * 500. Null when the read fails, so the caller keeps what the load had.
 */
type Line = { user_id: string | null; label: string };
/** The workspace's lines by their last 10 digits (migration 153): whose each is, or its name. Read once per workspace. */
const lineCache = new Map<number, Promise<Map<string, Line>>>();
export function lineLabels(workspaceId: number): Promise<Map<string, Line>> {
  let p = lineCache.get(workspaceId);
  if (!p) {
    const sb = supabase;
    p = (sb ? Promise.resolve(sb.from('rep_phone_numbers' as never).select('phone_e164,user_id,label').eq('workspace_id', workspaceId)) : Promise.resolve({ data: [] as unknown[] }))
      .then((r) => new Map(((r.data ?? []) as { phone_e164: string; user_id: string | null; label: string }[]).map((x) => [x.phone_e164.replace(/\D/g, '').slice(-10), { user_id: x.user_id, label: x.label }] as const)))
      .catch(() => new Map<string, Line>());
    lineCache.set(workspaceId, p);
  }
  return p;
}

/** Drop a workspace's cached lines after Settings → Numbers renames one or changes its owner. */
export function forgetLineLabels(workspaceId: number): void {
  lineCache.delete(workspaceId);
}

/** An AI agent as the activity log shows it: its name and picture (voice_agent_settings, migration 123). */
export type AgentFace = { key: string; name: string; avatar: string | null };
/** The workspace's AI agents by agent_key. Read once per workspace, like the lines. */
const agentCache = new Map<number, Promise<Map<string, AgentFace>>>();
export function agentFaces(workspaceId: number): Promise<Map<string, AgentFace>> {
  let p = agentCache.get(workspaceId);
  if (!p) {
    const sb = supabase;
    type Row = { agent_key: string; name: string | null; avatar_url: string | null; live_name: string | null; draft_name: string | null };
    p = (sb ? Promise.resolve(sb.from('voice_agent_settings' as never).select('agent_key,name,avatar_url,live_name:live_settings->identity->>name,draft_name:settings->identity->>name').eq('workspace_id', workspaceId)) : Promise.resolve({ data: [] as unknown[], error: null }))
      .then((r) => {
        // A failed read is not cached: the next record open asks again.
        if ('error' in r && r.error) agentCache.delete(workspaceId);
        return r;
      })
      .then((r) => new Map(((r.data ?? []) as Row[]).map((x) => [x.agent_key, {
        key: x.agent_key,
        name: (x.name || x.live_name || x.draft_name || x.agent_key.replace(/_/g, ' ')).trim(),
        avatar: x.avatar_url || null,
      }] as const)))
      .catch(() => { agentCache.delete(workspaceId); return new Map<string, AgentFace>(); });
    agentCache.set(workspaceId, p);
  }
  return p;
}

/** Drop a workspace's cached agents after one is renamed or gets a new picture. */
export function forgetAgentFaces(workspaceId: number): void {
  agentCache.delete(workspaceId);
}

/**
 * The agent a row names (ai_agent_key), else, for an 'ai_agent' line written
 * before migration 269, the agent its title names ("AI agent Riley sent a text").
 */
function agentOfRow(key: string | null | undefined, agents: Map<string, AgentFace> | undefined, title?: string): AgentFace | null {
  if (!agents?.size) return null;
  if (key) return agents.get(key) ?? null;
  if (!title?.startsWith('AI agent ')) return null;
  for (const a of agents.values()) if (a.name && title.startsWith(`AI agent ${a.name} `)) return a;
  return null;
}

const COMM_COLS = 'id,seller_id,buyer_id,deal_id,channel,direction,occurred_at,body,summary,subject,duration_s,recording_url,from_phone,to_phone,rep_id,status,source,ai_notes,score_overall,from_email,to_email,source_id';
const ACTIVITY_COLS = 'id,entity_type,entity_id,kind,title,body,actor_id,occurred_at';
/** False once the database says ai_agent_key is missing (the app shipped before migration 269 ran). */
let agentColumn = true;
const commCols = (agent: boolean) => (agent ? COMM_COLS + ',ai_agent_key' : COMM_COLS);
const activityCols = (agent: boolean) => (agent ? ACTIVITY_COLS + ',ai_agent_key' : ACTIVITY_COLS);
/** A read that asks for ai_agent_key, and asks again without it when the column is not there yet. */
async function withAgentColumn<T extends { error: { message: string } | null }>(make: (agent: boolean) => PromiseLike<T>): Promise<T> {
  if (agentColumn) {
    const r = await make(true);
    if (!r.error || !/ai_agent_key/.test(r.error.message)) return r;
    agentColumn = false;
  }
  return make(false);
}

/**
 * Who an outbound message reads as from: its rep, else the owner or name of the
 * line it went out on. `user` is that teammate's id when one resolves, so the
 * feed can show their photo; a line with only a label credits no one.
 */
function sentByFor(lines: Map<string, Line>, repName: (id: string | null) => string) {
  const member = (id: string | null | undefined) => { const n = id ? repName(id) : ''; return n && n !== 'CLOZR' ? n : null; };
  return (c: CommRow): { name: string | null; user: string | null } => {
    const line = lines.get(String(c.from_phone ?? '').replace(/\D/g, '').slice(-10));
    const rep = member(c.rep_id);
    if (rep) return { name: rep, user: c.rep_id ?? null };
    const owner = member(line?.user_id);
    if (owner) return { name: owner, user: line!.user_id };
    return { name: line?.label ?? null, user: null };
  };
}

/**
 * The open record's own feed, read by seller *and* its deals: the workspace
 * load holds only the newest 300 activity rows and 500 messages across
 * everyone, so a contact whose history is older (every Podio import, every
 * partner with hundreds of submissions) showed an empty timeline. Merged into
 * the record's feed in useClozr.
 */
export async function loadRecordTimeline(
  workspaceId: number, sellerId: number, dealIds: number[], sellerLabel: string, repName: (id: string | null) => string,
): Promise<TimelineEntry[] | null> {
  if (!supabase) return null;
  const actOr = [`and(entity_type.eq.seller,entity_id.eq.${sellerId})`, ...(dealIds.length ? [`and(entity_type.eq.deal,entity_id.in.(${dealIds.join(',')}))`] : [])].join(',');
  const commOr = [`seller_id.eq.${sellerId}`, ...(dealIds.length ? [`deal_id.in.(${dealIds.join(',')})`] : [])].join(',');
  const [acts, comms, lines, agents] = await Promise.all([
    withAgentColumn((a) => supabase!.from('activity').select(activityCols(a))
      .eq('workspace_id', workspaceId).or(actOr).order('occurred_at', { ascending: false }).limit(500)),
    withAgentColumn((a) => supabase!.from('communications')
      .select(commCols(a))
      .eq('workspace_id', workspaceId).or(commOr).order('occurred_at', { ascending: false }).limit(500)),
    lineLabels(workspaceId),
    agentFaces(workspaceId),
  ]);
  const sentBy = sentByFor(lines, repName);
  if (acts.error || comms.error) return null;
  const names = new Map([[sellerId, sellerLabel]]);
  const commRows = (comms.data ?? []) as unknown as CommRow[];
  const callNotes = linkCallNotes(commRows);
  return [
    ...((acts.data ?? []) as unknown as ActivityRow[]).map((a) => ({ at: a.occurred_at, e: mapActivity(a, repName, agents) })),
    ...commRows.map((c) => {
      const base = commTimeline(c, names, undefined, sentBy, agents);
      const notes = callNotes.notesByCall.get(c.id);
      const e = notes ? { ...base, callNote: notes.join('\n\n') } : callNotes.placed.has(c.id) ? { ...base, underCall: true } : base;
      // Every message read here is about this contact or one of its deals.
      return { at: c.occurred_at, e: { ...e, entity: e.entity && e.entity.startsWith('s') ? e.entity : sid(sellerId) } };
    }),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((x) => ({ ...x.e, at: x.at }));
}

/**
 * One buyer's own history, the way loadRecordTimeline reads a seller's. The
 * workspace load holds only the newest 500 messages across everyone, so a
 * buyer's older email and calls were missing from their Activity feed (and
 * an email thread showed only its latest messages).
 */
export async function loadBuyerTimeline(
  workspaceId: number, buyerId: number, repName: (id: string | null) => string,
): Promise<TimelineEntry[] | null> {
  if (!supabase) return null;
  const [acts, comms, lines, agents] = await Promise.all([
    withAgentColumn((a) => supabase!.from('activity').select(activityCols(a))
      .eq('workspace_id', workspaceId).eq('entity_type', 'buyer').eq('entity_id', buyerId)
      .order('occurred_at', { ascending: false }).limit(500)),
    withAgentColumn((a) => supabase!.from('communications')
      .select(commCols(a))
      .eq('workspace_id', workspaceId).eq('buyer_id', buyerId).order('occurred_at', { ascending: false }).limit(500)),
    lineLabels(workspaceId),
    agentFaces(workspaceId),
  ]);
  if (acts.error || comms.error) return null;
  const sentBy = sentByFor(lines, repName);
  const entity = 'b' + buyerId;
  return [
    ...((acts.data ?? []) as unknown as ActivityRow[]).map((a) => ({ at: a.occurred_at, e: mapActivity(a, repName, agents) })),
    // A message on a seller's deal that also names this buyer still belongs on the buyer's feed.
    ...((comms.data ?? []) as unknown as CommRow[]).map((c) => ({ at: c.occurred_at, e: { ...commTimeline(c, new Map(), undefined, sentBy, agents), entity } })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((x) => ({ ...x.e, at: x.at }));
}

/**
 * Texts with one number that did not go through Talkr — the team's smrtPhone
 * history from Podio, mostly — newest 300. The Inbox thread is Talkr's own
 * store, which only has what Talkr carried, so without these a contact
 * texted from smrtPhone showed their replies and none of ours.
 */
export type PhoneText = { dir: 'in' | 'out'; body: string; at: string };
export async function loadPhoneTexts(workspaceId: number, e164: string): Promise<PhoneText[] | null> {
  if (!supabase || !/^\+\d{8,15}$/.test(e164)) return null;
  // Two reads, one per side, so each walks its own index
  // (communications_sms_from_idx / _to_idx: workspace, phone, occurred_at)
  // instead of an OR across both phone columns.
  const side = (col: 'from_phone' | 'to_phone', direction: 'inbound' | 'outbound') => supabase!.from('communications')
    .select('direction,body,occurred_at')
    .eq('workspace_id', workspaceId).eq('channel', 'sms').eq(col, e164).eq('direction', direction)
    .or('source.is.null,source.neq.talkr')
    .order('occurred_at', { ascending: false }).limit(300);
  const [ins, outs] = await Promise.all([side('from_phone', 'inbound'), side('to_phone', 'outbound')]);
  if (ins.error || outs.error || !ins.data || !outs.data) return null;
  return ([...ins.data, ...outs.data] as { direction: string; body: string | null; occurred_at: string }[])
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    .slice(0, 300)
    .filter((r) => (r.body ?? '').trim())
    .map((r) => ({ dir: r.direction === 'inbound' ? 'in' : 'out', body: r.body!.trim(), at: r.occurred_at }));
}

/**
 * A Talkr thread with the number's other texts merged in, oldest first. A text
 * already in the thread (same direction and words within ten minutes — a
 * reply both systems logged) is shown once.
 */
export function mergeThread<T extends PhoneText>(thread: T[], other: PhoneText[]): (T | PhoneText)[] {
  const near = (a: PhoneText, b: PhoneText) => a.dir === b.dir && a.body.trim() === b.body.trim() && Math.abs(Date.parse(a.at) - Date.parse(b.at)) < 600_000;
  const extra = other.filter((o) => !thread.some((t) => near(t, o)));
  return [...thread, ...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function loadRecordComms(
  workspaceId: number,
  sellerId: number,
  dealIds: number[],
  sellerLabel: string,
): Promise<Communication[] | null> {
  if (!supabase) return null;
  const or = [`seller_id.eq.${sellerId}`, ...(dealIds.length ? [`deal_id.in.(${dealIds.join(',')})`] : [])].join(',');
  const { data, error } = await supabase.from('communications')
    .select('id,seller_id,buyer_id,deal_id,channel,direction,occurred_at,body,summary,subject,duration_s,recording_url,from_phone,to_phone,rep_id,status,source,ai_notes,score_overall,from_email,to_email,source_id')
    .eq('workspace_id', workspaceId).or(or).order('occurred_at', { ascending: false }).limit(500);
  if (error || !data) return null;
  const names = new Map([[sellerId, sellerLabel]]);
  return (data as (CommRow & { from_email?: string | null; to_email?: string | null })[]).map((c) => {
    const m = mapCommunication(c, names);
    // Someone other than the seller (a buyer, the title company): name them
    // by the address on the email rather than "Unknown".
    const other = c.seller_id !== sellerId ? (c.direction === 'inbound' ? c.from_email : c.to_email) : null;
    return { ...m, personId: sid(sellerId), ...(other ? { party: other } : {}) };
  });
}

/**
 * Call notes sit under the call they were typed on. An older note was saved when the
 * call ends and the call row arrives from Talkr on its own clock, so there is
 * no shared id: the note belongs to the latest call on the same record in the
 * three hours before it. With no such call it stands alone as "Call note".
 */
const CALL_NOTE_WINDOW_MS = 3 * 3600_000;
function linkCallNotes(comms: CommRow[]): { notesByCall: Map<number, string[]>; placed: Set<number> } {
  const notesByCall = new Map<number, string[]>();
  const placed = new Set<number>();
  const calls = comms.filter((c) => c.channel === 'call');
  // The outcome and note written on the call itself (lib/call-outcome-write).
  // The entry's body is the AI summary when there is one, so the outcome line
  // goes under it here rather than being hidden behind it.
  for (const c of calls) if (c.summary && c.ai_notes?.summary) notesByCall.set(c.id, [c.summary]);
  for (const n of comms) {
    if (n.channel !== 'note' || n.subject !== 'Call note' || !n.body) continue;
    const at = Date.parse(n.occurred_at);
    const call = calls
      .filter((c) => (n.seller_id ? c.seller_id === n.seller_id : !!n.buyer_id && c.buyer_id === n.buyer_id))
      .filter((c) => { const t = Date.parse(c.occurred_at); return t <= at && at - t <= CALL_NOTE_WINDOW_MS; })
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
    if (!call) continue;
    notesByCall.set(call.id, [...(notesByCall.get(call.id) ?? []), n.body]);
    placed.add(n.id);
  }
  return { notesByCall, placed };
}

/**
 * A conversation as a timeline entry.
 *
 * The record's Activity tab reads the timeline, and the timeline used to be
 * built from `activity` rows alone — so a text or a note only showed until the
 * page reloaded, which read as the message having been dropped. A
 * communication is an event on the record; it belongs on the same feed, and
 * its type matches what the Texts and Calls filters already look for.
 */
function commTimeline(c: CommRow, sellerName: Map<number, string>, ours: Set<string> = new Set(), sentBy?: (c: CommRow) => { name: string | null; user: string | null }, agents?: Map<string, AgentFace>): TimelineEntry {
  const from = (c.from_email ?? '').trim().toLowerCase();
  const inbound = c.channel === 'email' && from && ours.size ? !ours.has(from) : c.direction === 'inbound';
  const type = c.channel === 'sms'
    ? (inbound ? 'sms_in' : 'sms_out')
    : c.channel === 'note' ? 'note' : c.channel;
  // An outbound row credits the rep who sent it (rep_id, or the line's owner
  // or name, migration 153), else the system that carried it; an inbound one
  // was the seller.
  // An AI agent's text, email, voicemail or call is the agent's, not the rep it went out as (migration 269).
  const src = c.source || 'system';
  const agent = !inbound ? agentOfRow(c.ai_agent_key, agents) : null;
  const by = !inbound && !agent ? sentBy?.(c) : undefined;
  const who = c.channel === 'email' && inbound && from ? from
    : agent ? agent.name
    : !inbound ? (by?.name || (src === 'clozr' ? 'CLOZR' : src.charAt(0).toUpperCase() + src.slice(1)))
    : c.seller_id ? sellerName.get(c.seller_id) || 'Unknown' : c.from_phone || 'Unknown';
  // A text we sent says how far it got; "failed" is the word that has to reach
  // the person who sent it, so it goes in the title rather than a badge. A
  // call says how long it lasted, because eight seconds and eight minutes are
  // different events.
  const state = !inbound && c.status && c.status !== 'sent' ? ' · ' + c.status : '';
  const mins = c.duration_s ? Math.floor(c.duration_s / 60) + 'm ' + (c.duration_s % 60) + 's' : null;
  // A scored call carries its grade in the title, so the feed shows coaching at a glance.
  const graded = c.channel === 'call' && typeof c.score_overall === 'number' ? ' · ' + c.score_overall + '/100' : '';
  const isTc = c.channel === 'note' && /^tc\b/i.test(c.subject || '');
  const title = isTc ? 'TC'
    : c.channel === 'note' ? (c.subject === 'Call note' ? 'Call note' : 'Note added')
    : c.channel === 'call' ? (inbound && (!c.status || /^(no_answer|missed|busy|failed|canceled|cancelled|unanswered|rejected)$/i.test(c.status)) ? 'Missed call' : (inbound ? 'Inbound call' : 'Outbound call')) + (mins ? ' · ' + mins : '') + graded
      : c.channel === 'voicemail' ? 'Voicemail' + (mins ? ' · ' + mins : '')
        : c.channel === 'email' ? 'Email' + (inbound ? ' received' : ' sent')
          : 'Text' + (inbound ? ' received' : ' sent') + state;
  return {
    id: 'ct' + c.id,
    type: isTc ? 'tc' : type,
    user: by?.user ?? null,
    who,
    ...(agent ? { agent } : {}),
    time: relative(c.occurred_at),
    title,
    // What the AI heard beats the disposition line, which beats a raw body.
    ...(c.ai_notes?.summary || c.body || c.summary ? { body: c.ai_notes?.summary || c.summary || c.body || '' } : {}),
    ...(c.seller_id ? { entity: sid(c.seller_id) } : c.buyer_id ? { entity: 'b' + c.buyer_id } : {}),
    ...(c.deal_id ? { dealId: did(c.deal_id) } : {}),
    ...(c.channel === 'email' ? {
      email: {
        subject: c.subject || '(no subject)',
        from: c.from_email || '',
        fromName: inbound && c.seller_id && sellerName.get(c.seller_id) && sellerName.get(c.seller_id) !== 'No name' ? sellerName.get(c.seller_id)! : '',
        to: (c.to_email || '').split(',').map((a) => a.trim()).filter(Boolean),
        inbound,
        body: c.body || '',
        sourceId: c.source_id?.startsWith('<') ? c.source_id : null,
      },
    } : {}),
  };
}

/** A seller's most recent communication: what "Last contact" and "never contacted" read. */
type LastComm = { channel: string; occurred_at: string };

function mapPerson(s: SellerRow, last: LastComm | null, nextTask: TaskRow | undefined, deal: DealRow | undefined): Person {
  return {
    id: sid(s.id),
    name: s.name || 'No name',
    // The seller's own stage. The deal has its own (mapDeal); the database keeps the two in step.
    stage: s.lead_stage || 'Lead',
    // Lead score is a model output CLOZR does not compute yet. No score is
    // honest; a zero read as "0 COLD" on every record, and inventing a number
    // would put a confident-looking figure on a record that nothing has scored.
    score: null,
    // Who owns the lead: an explicit assignment, else whoever owns the deal.
    // Not the creator — an import is not an assignment.
    assigned: s.assigned_to || deal?.owner_id || null,
    source: s.source || 'Manual',
    phone: s.phone || '—',
    email: s.email || '—',
    lastComm: last ? `${last.channel.toUpperCase()} · ${relative(last.occurred_at)}` : 'No contact yet',
    lastCommTs: last ? minutesAgo(last.occurred_at) : null,
    nextTask: nextTask ? `${nextTask.title} · ${dayLabel(nextTask.due_at)}` : 'No task scheduled',
    offer: money(deal?.offer_amount),
    created: shortDate(s.created_at),
    ...(s.created_at ? { createdAt: s.created_at } : {}),
    tags: s.tags ?? [],
    // The Deals and Dispo Market menus are built from this, so it is one
    // label per place: "Charlotte, NC". A state-only market uses the
    // property's city. A deal's own market names the place; the property's
    // city and state stand in when it has none.
    market: personMarket(deal?.market, s.properties?.city, s.properties?.state),
    notes: s.notes ?? null,
    motivation: s.motivation || '—',
    timeline: s.timeline || '—',
    condition: s.condition || '—',
    occupancy: s.occupancy || '—',
    mortgage: s.mortgage || '—',
    asking: money(s.asking_price) || '—',
    desiredClose: s.desired_close || '—',
    decisionMakers: s.decision_makers || '—',
    intake: s.intake && typeof s.intake === 'object' && !Array.isArray(s.intake) ? s.intake : {},
    // The hero is COMPR's front photo of the subject when a run has left one on
    // the deal; without it the record falls back to Street View (useClozr).
    property: { ...mapProperty(s.properties, s.property_address), img: deal?.hero_image_url || '' },
  };
}

const ACTIVE = new Set(['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow']);
/**
 * Which of a contact's deals stands for the contact: an open contract beats a
 * closed or terminated one, which beats a submission (Prospect); ties go to the
 * newest. A partner contact can carry hundreds of submissions (migration 49).
 */
export function dealRank(d: { stage?: string | null; id: number | string; contract_date?: string | null; submitted_at?: string | null }): number {
  const tier = ACTIVE.has(d.stage ?? '') ? 3e12 : d.stage && d.stage !== 'Prospect' ? 2e12 : 1e12;
  const when = Date.parse(d.contract_date ?? d.submitted_at ?? '') || 0;
  return tier + when / 1e3 + Number(String(d.id).replace(/\D/g, '')) / 1e9;
}

function mapDeal(d: DealRow, staleDays: number, prop?: { line1: string; city: string | null; state: string | null; zip: string | null; lat?: number | null; lng?: number | null }): Deal {
  const n = (v: number | null) => (v == null ? null : Number(v));
  // The fee actually earned when dispo closed it, else what it was marketed at.
  const assignment = n(d.dispo_fee) ?? n(d.assignment_fee) ?? n(d.marketed_fee);
  const inStage = d.stage_entered_at ? Math.floor((minutesAgo(d.stage_entered_at) ?? 0) / (60 * 24)) : staleDays;
  return {
    stage: d.stage,
    archived: !!d.archived_at, archivedReason: d.archived_reason ?? null,
    id: did(d.id),
    createdAt: d.created_at,
    personId: d.seller_id ? sid(d.seller_id) : '',
    contract: d.offer_amount == null ? null : Number(d.offer_amount),
    arv: d.arv == null ? null : Number(d.arv),
    rehab: d.rehab == null ? null : Number(d.rehab),
    mao: d.mao == null ? null : Number(d.mao),
    wholesale: d.wholesale_offer == null ? null : Number(d.wholesale_offer),
    institutional: d.institutional_offer == null ? null : Number(d.institutional_offer),
    underwritingUrl: d.underwriting_url,
    ...(d.compr_report_url ? { comprReportUrl: d.compr_report_url } : {}),
    ...(d.hero_image_url ? { heroUrl: d.hero_image_url } : {}),
    ...(d.photos_url && /^https?:\/\//i.test(d.photos_url) ? { sourcePhotos: [d.photos_url.trim()] } : {}),
    ...(d.buyer_report_url ? { buyerReportUrl: d.buyer_report_url } : {}),
    ...(d.compr_cma_url ? { cmaPdfUrl: d.compr_cma_url } : {}),
    assignment,
    profit: assignment,
    close: d.close_date ? shortDate(d.close_date) : null,
    optionEndsOn: d.option_ends_on ?? null,
    buyerOptionEndsOn: d.buyer_option_ends_on ?? null,
    daysInStage: inStage,
    health: staleDays > 14 ? 'at-risk' : staleDays > 7 ? 'watch' : 'good',
    owner: d.owner_id,
    hasTitle: !!(d.title_vendor_id || d.title_contact || d.title_email),
    facts: {
      earnest: n(d.earnest_money ?? null), condition: d.condition_notes ?? null, occupancy: d.occupancy_notes ?? null,
      dispoRep: d.dispo_rep_id ?? null, tcRep: d.tc_rep_id ?? null,
      titleVendor: d.title_vendor_id != null, titleVendorId: d.title_vendor_id != null ? 'v' + d.title_vendor_id : null, titleContact: d.title_contact ?? null, titleEmail: d.title_email ?? null, titlePhone: d.title_phone ?? null,
      marketingStarted: d.marketing_started_on ?? null,
    },
    ...(d.buyer_id ? { buyerId: bid(d.buyer_id) } : {}),
    // The deal's own property: a partner contact carries many deals, each on its own house.
    ...(prop ? { addr: prop.line1, city: normalizePlace({ city: prop.city, state: prop.state }).city ?? '', st: prop.state ?? '', zip: prop.zip ?? '' } : {}),
    ...(prop?.lat != null && prop?.lng != null ? { lat: Number(prop.lat), lng: Number(prop.lng) } : {}),
    ...(d.property_id != null ? { propertyId: String(d.property_id) } : {}),
    leadStage: d.lead_stage, asking: n(d.asking_price), submittedAt: d.submitted_at, targetAssignment: n(d.target_assignment),
    marketing: { headline: d.marketing_headline, description: d.marketing_description, url: d.marketing_url, garage: n(d.garage_spaces) },
    tracker: {
      no: d.tracker_no, contractDate: d.contract_date, scheduledClose: d.close_date, closedOn: d.closed_on,
      sellerPrice: n(d.offer_amount), priceDrop: n(d.price_drop), marketedPrice: n(d.marketed_price), marketedFee: n(d.marketed_fee),
      dispoPrice: n(d.sold_price), dispoUpsell: n(d.dispo_upsell), dispoFee: n(d.dispo_fee),
      acqAgent: d.acq_agent, dispoAgent: d.dispo_agent, transactionType: d.transaction_type,
      leadManager: d.lead_manager, coordinator: d.coordinator, contractStatus: d.contract_status, leadSource: d.lead_source,
    },
    structure: dealTypeLabel(d.transaction_type) || null,
  };
}

function byBuyer<T>(rows: T[], idOf: (row: T) => number | null): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const id = idOf(row);
    if (id == null) continue;
    const list = out.get(id);
    if (list) list.push(row);
    else out.set(id, [row]);
  }
  return out;
}

/** A buyer_scores row: the response rate and the counts behind it (touches sent, answered, offers, closed). */
type ResponseScore = { buyer_id: number; response_rate: number | null; stats: { touches?: number; answered?: number; offers?: number; closed?: number } | null };

function mapBuyer(b: BuyerRow, matches: MatchRow[], offers: OfferRowDb[], comms: CommRow[] = [], deals: DealRow[] = [], score: ResponseScore | null = null): Buyer {
  const box: BuyBox = normalizeBuyBox(b.criteria && typeof b.criteria === 'object' && Object.keys(b.criteria as object).length
    ? b.criteria
    : { locations: { cities: b.markets ?? [] }, price: { max: b.max_purchase_price } });
  const sm = summarizeBuyBox(box);
  const mine = matches.filter((m) => m.buyer_id === b.id);
  const best = mine.reduce((a, m) => Math.max(a, m.score), 0);
  const myOffers = offers.filter((o) => o.buyer_id === b.id);
  const mineComms = comms.filter((c) => c.buyer_id === b.id);
  const mineDeals = deals.filter((d) => d.buyer_id === b.id);
  const closed = mineDeals.filter((d) => /closed/i.test(d.stage)).sort((a, b2) => Date.parse(b2.closed_on ?? b2.close_date ?? '') - Date.parse(a.closed_on ?? a.close_date ?? ''));
  // Every text, email, call and deal send the team made, and how many the
  // buyer answered (buyer-score's counts). Without a score yet: deal sends.
  const dealSends = mine.filter((m) => m.sent_at).length;
  const scored = score?.response_rate != null && (score.stats?.touches ?? 0) > 0;
  const sent = scored ? Number(score!.stats!.touches) : dealSends;
  const responsePct = scored ? Number(score!.response_rate) : dealSends ? Math.round((mine.filter((m) => m.replied_at).length / dealSends) * 100) : 0;
  const prospectList = prospectListId(b.tags, b.status, b.source, { vetted: !!b.vetted_at, vip: b.vip, buyerType: b.buyer_type });
  const holding = PROSPECT_LISTS.some((list) => list.id === prospectList && list.holding);
  const status = b.blacklisted_at ? 'Blacklisted' : /inactive/i.test(b.status) ? 'Inactive' : holding || /prospect/i.test(b.status) ? 'Prospect' : b.vip ? 'VIP' : b.vetted_at ? 'Vetted' : 'Follow-up';
  return {
    id: bid(b.id),
    name: b.name,
    company: b.company || b.name,
    initials: initialsOf(b.name),
    status,
    stage: buyerStageOf(b.status),
    markets: normalizeMarkets(sm.markets.length ? sm.markets : b.markets),
    type: b.buyer_type ? labelOf(BUYER_TYPES, b.buyer_type) : '—',
    // Response: answered over sent, once anything has been sent.
    engagement: responsePct,
    sent,
    responseKnown: sent > 0,
    tireKicker: isTireKicker({
      sent,
      responsePct,
      offers: Math.max(myOffers.length, Number(score?.stats?.offers ?? 0)),
      purchases: Math.max(closed.length, Number(score?.stats?.closed ?? 0)),
    }),
    stars: b.vip ? 5 : b.vetted_at ? 4 : 0,
    phone: b.phone || '—',
    email: b.email || '—',
    pref: labelOf(CHANNELS, b.preferred_channel || 'email_and_sms'),
    doNot: b.blacklisted_at ? 'Blacklisted' : sm.avoid.length ? sm.avoid.join(', ') : '—',
    buyBox: {
      price: sm.price, year: sm.year, sqft: sm.sqft, beds: sm.beds, baths: sm.baths, type: sm.type, rehab: sm.rehab, exit: sm.exit,
      minCap: sm.minCap, maxCashOut: sm.maxArv, minCashFlow: sm.minCashFlow, avoid: sm.avoid,
    },
    match: best,
    ceiling: box.price.max != null ? '$' + Math.round(box.price.max).toLocaleString('en-US') : (money(b.max_purchase_price) || '—'),
    rehabTol: sm.rehab,
    strategy: sm.exit,
    lastPurchase: closed[0] ? shortDate(closed[0].closed_on ?? closed[0].close_date) : '—',
    lastActivity: b.last_activity_at ? relative(b.last_activity_at) : relative(b.created_at),
    createdAt: b.created_at,
    lastActivityAt: b.last_activity_at ?? b.created_at,
    offers: myOffers.length + ' submitted',
    why: mine.length ? Array.from(new Set(mine.flatMap((m) => m.reasons))).slice(0, 4) : [],
    issue: box.location_prefs.length ? '' : 'Buy box has no location — add one to get match scores.',
    vip: b.vip, vetted: !!b.vetted_at, blacklisted: !!b.blacklisted_at, buyerType: b.buyer_type,
    entityType: b.entity_type, tags: b.tags ?? [], source: b.source, prospectList,
    activity: {
      calls: mineComms.filter((c) => c.channel === 'call').length,
      texts: mineComms.filter((c) => c.channel === 'sms').length,
      emails: mineComms.filter((c) => c.channel === 'email').length,
      viewed: mine.filter((m) => m.viewed_at).length, clicks: 0,
      offers: myOffers.length, walkthroughs: 0, purchases: closed.length,
      declines: mine.filter((m) => m.status === 'not_interested').length,
    },
    summary: [b.notes, sm.oneLine].filter((x): x is string => !!x),
  };
}

/** One page of the free-agent realtor corpus. The shell never loads these rows. */
export async function loadRealtorCorpus(
  workspaceId: number,
  opts: { q?: string; offset?: number; limit?: number; state?: string; city?: string } = {},
): Promise<{ ok: boolean; rows: Buyer[]; total: number; message?: string }> {
  if (!supabase) return { ok: false, rows: [], total: 0, message: 'Not signed in' };
  const state = (opts.state ?? '').trim().toUpperCase();
  const city = (opts.city ?? '').trim();
  const base = { p_workspace_id: workspaceId, p_q: opts.q ?? '', p_limit: opts.limit ?? 50, p_offset: opts.offset ?? 0 };
  let res = state || city
    ? await supabase.rpc('search_free_agent_buyers_geo', { ...base, p_state: state, p_city: city })
    : await supabase.rpc('search_free_agent_buyers', base);
  // Before migration 106 there is no geo search: fall back to the market text
  // match, which finds "Dallas, TX" as a substring when search is empty.
  if (res.error && (state || city) && /could not find the function|PGRST202|does not exist/i.test(res.error.message + ' ' + (res.error.code ?? ''))) {
    const place = city ? (city.includes(',') || !state ? city : `${city}, ${state}`) : `, ${state}`;
    res = await supabase.rpc('search_free_agent_buyers', { ...base, p_q: base.p_q || place });
  }
  const { data, error } = res;
  if (error) return { ok: false, rows: [], total: 0, message: error.message };
  const payload = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as { total?: number; rows?: unknown };
  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = rawRows.map((raw) => mapBuyer(realtorBuyerRow(raw), [], [], [], []));
  return { ok: true, rows, total: Number(payload.total ?? 0) };
}

/**
 * Every "City, ST" in the realtor corpus with a count (migration 106), for the
 * Realtors city and state filters. Empty when the function is not there yet.
 */
export async function loadRealtorMarkets(workspaceId: number): Promise<{ city: string; state: string; count: number }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('free_agent_markets', { p_workspace_id: workspaceId });
  if (error || !Array.isArray(data)) return [];
  return (data as { market?: unknown; count?: unknown }[]).flatMap((r) => {
    const [c, st] = String(r.market ?? '').split(',').map((x) => x.trim());
    return c && /^[A-Za-z]{2}$/.test(st ?? '') ? [{ city: c, state: st.toUpperCase(), count: Number(r.count) || 0 }] : [];
  });
}

/** A realtor picked on the map: what the Buyers bulk bar needs to reach them (BuyerBulkBar's `bulk.buyers`). */
export type RealtorPick = { dbId: number; name: string; company: string; phone: string; email: string; pref: string; inactive: boolean; blacklisted: boolean; protected: boolean };

/**
 * Every realtor in these markets ("Phoenix, AZ"), up to 5,000, for the map's
 * lasso (migration 126). `total` is the full count, so a caller can say when
 * the cap cut it short.
 */
export async function loadRealtorsInMarkets(workspaceId: number, markets: string[]): Promise<{ ok: boolean; total: number; rows: RealtorPick[] }> {
  if (!supabase || !markets.length) return { ok: !!supabase, total: 0, rows: [] };
  const { data, error } = await supabase.rpc('free_agents_in_markets', { p_workspace_id: workspaceId, p_markets: markets, p_limit: 5000 });
  if (error || !data || typeof data !== 'object') return { ok: false, total: 0, rows: [] };
  const d = data as { total?: unknown; rows?: unknown };
  const rows = (Array.isArray(d.rows) ? d.rows : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
    return {
      dbId: Number(r.id), name: str('name') || '—', company: str('company'), phone: str('phone'), email: str('email'),
      pref: labelOf(CHANNELS, str('preferred_channel') || 'email_and_sms'), inactive: str('status') === 'Inactive', blacklisted: r.blacklisted === true || str('status') === 'Blacklisted',
      // A corpus agent is a realtor, never a fund; only a VIP mark keeps them off an AI agent.
      protected: str('status') === 'VIP',
    };
  }).filter((r) => Number.isFinite(r.dbId) && r.dbId > 0);
  return { ok: true, total: Number(d.total) || rows.length, rows };
}

function realtorBuyerRow(raw: unknown): BuyerRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
  return {
    id: Number(r.id) || 0,
    name: str('name') || '—',
    company: str('company'),
    email: str('email'),
    phone: str('phone'),
    markets: Array.isArray(r.markets) ? r.markets.filter((m): m is string => typeof m === 'string') : [],
    max_purchase_price: typeof r.max_purchase_price === 'number' ? r.max_purchase_price : null,
    buy_box: str('buy_box'),
    status: str('status') || 'active',
    notes: str('notes'),
    source: str('source'),
    buyer_type: str('buyer_type'),
    entity_type: str('entity_type'),
    criteria: r.criteria && typeof r.criteria === 'object' ? r.criteria : null,
    vetted_at: str('vetted_at'),
    vip: r.vip === true,
    blacklisted_at: str('blacklisted_at'),
    preferred_channel: str('preferred_channel') || 'email_and_sms',
    created_at: str('created_at') || '',
    last_activity_at: str('last_activity_at'),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** A task's due fields as mapTask writes them, for a reschedule patched on screen. */
export function taskDueFields(dueAt: string | null): Pick<Task, 'due' | 'bucket' | 'dueAt'> {
  return { due: dayLabel(dueAt), bucket: dueBucket(dueAt), dueAt };
}

function mapTask(t: TaskRow, sellerOfDeal?: (dealId: number) => number | null | undefined): Task {
  const due = dayLabel(t.due_at);
  const fromDeal = !t.seller_id && t.deal_id && sellerOfDeal ? sellerOfDeal(t.deal_id) : null;
  const sellerId = t.seller_id ?? fromDeal ?? null;
  return {
    id: kid(t.id),
    title: t.title,
    personId: sellerId ? sid(sellerId) : '',
    type: t.task_type,
    due,
    assigned: t.assigned_to,
    priority: t.priority,
    done: t.done,
    bucket: dueBucket(t.due_at),
    dueAt: t.due_at,
    ...(t.notes ? { note: t.notes } : {}),
    ...(t.deal_id ? { dealId: did(t.deal_id) } : {}),
    ...(t.buyer_id ? { buyerId: bid(t.buyer_id) } : {}),
  };
}

/** Stage moves, offers and automation — the events a communication is not. */
function mapActivity(a: ActivityRow, repName: (id: string | null) => string, agents?: Map<string, AgentFace>): TimelineEntry {
  // An agent's line is the agent's, even when a rep switched it on (the rep is named in the title).
  const agent = a.kind === 'ai_agent' ? agentOfRow(a.ai_agent_key, agents, a.title) : null;
  return {
    id: 'a' + a.id,
    type: a.kind,
    user: agent ? null : a.actor_id,
    ...(agent ? { agent } : {}),
    // No actor means a webhook or automation wrote it; name the source.
    who: agent ? agent.name : a.actor_id ? repName(a.actor_id)
      : /pandadoc/i.test(a.title + (a.body ?? '')) ? 'PandaDoc'
        : a.kind === 'ai_agent' ? 'AI agent' : a.kind === 'contract' ? 'E-sign' : a.kind === 'email' ? 'Gmail' : a.kind === 'task' ? 'Automation' : a.kind === 'tc' ? (/^Lane\b/.test(a.title) ? 'Lane' : 'TC') : 'System',
    time: relative(a.occurred_at),
    title: a.title,
    ...(a.body ? { body: a.body } : {}),
    entity: (a.entity_type === 'seller' ? 's' : a.entity_type === 'buyer' ? 'b' : a.entity_type === 'deal' ? 'd' : a.entity_type + ':') + a.entity_id,
  };
}

function planAudience(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const a = (settings as { audience?: unknown }).audience;
  return typeof a === 'string' && a.trim() ? a.trim().toLowerCase() : undefined;
}

function mapPlan(p: PlanRow): ActionPlan {
  const steps: PlanStep[] = [...(p.action_plan_steps ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      id: 'ps' + s.id,
      channel: s.channel,
      delay: s.delay_hours === 0 ? 'Immediately'
        : s.delay_hours < 24 ? s.delay_hours + ' hours'
          : Math.round(s.delay_hours / 24) + ' days',
      title: s.title || '',
      content: s.body || '',
      generated: false,
    }));
  const audience = planAudience(p.settings);
  return {
    id: 'ap' + p.id,
    name: p.name,
    trigger: p.trigger_event || 'Manual',
    active: p.active,
    description: p.description || '',
    steps,
    ...(audience ? { audience } : {}),
  };
}

// ---- the load ---------------------------------------------------------------

/**
 * Read one workspace. Every query is workspace-scoped and RLS enforces it
 * again server-side, so a wrong id here returns nothing rather than someone
 * else's pipeline.
 *
 * Errors are not thrown: a failed table gives an empty collection and the app
 * shows an empty screen instead of a crash. `ok` says whether every read
 * succeeded, so the UI can distinguish "you have no leads" from "we could not
 * reach the database", which look identical otherwise and mean opposite things.
 */
// ---- the TC file --------------------------------------------------------------

type TxRowDb = {
  id: number; deal_id: number | null; property_id: number | null; seller_id: number | null; buyer_id: number | null;
  title_company: string | null; escrow_officer: string | null; title_email: string | null; title_phone: string | null;
  emd_amount: number | null; emd_received_at: string | null; option_ends_on: string | null; close_date: string | null;
  status: string; created_at: string;
  deal_type: string; contract_date: string | null; ctc_target: string | null;
  checklist: Record<string, boolean> | null; hud: Record<string, boolean> | null;
  tc_review: string | null; signoff: string | null; buyer_financing: string | null; lender: string | null; structure: string | null;
};
type ContractRowDb = {
  id: number; deal_id: number | null; seller_id: number | null; kind: string; name: string; status: string;
  sent_at: string | null; viewed_at: string | null; completed_at: string | null; created_at: string;
  provider?: string | null;
};

// The TC file's days are the browser's local days (lib/deal-close): toISOString's UTC
// turned "today" into tomorrow every evening in the US.
const isoDay = (d: Date) => localIsoDay(d);
const plusDays = (iso: string, n: number) => plusIsoDays(iso, n);

/**
 * The SOP's 10-minute contract clock for a file: the deal being created to the
 * seller contract (PSA) going out. A lead's deal sheet is made at intake as a
 * Prospect, days before any offer, so when the PSA draft was started more than
 * an hour after the deal row, the clock starts at that draft instead. With no
 * PSA sent yet, only a deal made in the last two days is on the clock: an
 * older one (an import, a Prospect sheet) has no clock rather than a false
 * "late".
 */
function slaFor(createdAt: string | null, contracts: ContractRowDb[], today: Date): ContractSla | null {
  if (!createdAt) return null;
  const made = Date.parse(createdAt);
  if (!Number.isFinite(made)) return null;
  const psa = contracts.filter((c) => c.kind === 'psa' && c.sent_at).sort((a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? ''))[0];
  if (psa) {
    const drafted = Date.parse(psa.created_at);
    const start = Number.isFinite(drafted) && drafted - made > 3_600_000 ? psa.created_at : createdAt;
    return contractSla(start, psa.sent_at, today);
  }
  const ageDays = (today.getTime() - made) / 86_400_000;
  return ageDays >= 0 && ageDays <= 2 ? contractSla(createdAt, null, today) : null;
}

/**
 * A transactions row (migration 36) as the TC screen's file. The checklist
 * template is picked by deal_type; the ticks are the row's jsonb. Deadlines
 * are the rail's dates counted from D0 and back from the close; documents are
 * the contracts on the deal; the next actions are what Lane's daily drive
 * says has slipped or fired. A commitment is "Received" once its checklist
 * line is ticked — the exceptions themselves arrive when Lane reads one.
 */
function mapTransaction(
  row: TxRowDb, sellerName: string, buyerName: string, state: string | null, contracts: ContractRowDb[], today: Date,
  tcName: string, dealCreatedAt?: string | null,
): Transaction {
  const template = (D.tcChecklists as Record<string, TcChecklist>)[row.deal_type] ?? null;
  const tasks = template ? template.phases.flatMap((p) => p.tasks) : [];
  const done = row.checklist ?? {};
  const hudDone = row.hud ?? {};
  const tick = (re: RegExp) => { const t = tasks.find((x) => re.test(x.t)); return !!(t && done[t.id]); };
  const d0 = row.contract_date;
  const close = row.close_date;
  const todayIso = isoDay(today);
  const dl = (id: string, k: string, date: string | null, owner: string, met: boolean, note = ''): TcDeadline | null => {
    if (!date) return null;
    const status = met ? 'met' : date < todayIso ? 'overdue' : plusDays(todayIso, 2) >= date ? 'due' : 'open';
    return { id, k, date: shortDate(date), owner, status, note };
  };
  const fileOpen = tasks.filter((t) => /^D[123]$/.test(t.day)).every((t) => !!done[t.id]) && tasks.length > 0;
  const commitIn = tick(/prelim title commitment/i);
  const ctcIn = tick(/Clear to Close|Confirm buyer CTC/i);
  const hudAll = !!template && template.hud.every((h) => !!hudDone[h.id]);
  const deadlines = [
    d0 ? dl('dl-open', 'File open', plusDays(d0, 3), 'TC', fileOpen, 'D3') : null,
    d0 ? dl('dl-commit', 'Title commitment', plusDays(d0, 7), 'Title', commitIn, 'D7 · call title D6 EOD') : null,
    dl('dl-ctc', 'Clear to close', row.ctc_target ?? (d0 ? plusDays(d0, 10) : null), 'Title', ctcIn, 'D10 target'),
    dl('dl-option', 'Option period ends', row.option_ends_on, 'Buyer', !!(row.option_ends_on && row.option_ends_on < todayIso)),
    close ? dl('dl-hud', 'HUD/CD review + owner sign-off', plusDays(close, -2), 'TC', hudAll && !!row.signoff, 'T-2 · hard gate') : null,
    close ? dl('dl-wire', 'Wire verbal verification', plusDays(close, -1), 'TC', tick(/wire instructions by phone/i), 'T-1') : null,
    dl('dl-close', 'Funding', close, 'Title', tick(/Funding day/i)),
  ].filter((d): d is TcDeadline => !!d);
  const ownerOf = (kind: string) => (kind === 'psa' ? 'Acquisitions' : kind === 'assignment' ? 'Dispo' : 'TC');
  const documents: TcDocument[] = contracts.map((c) => ({
    id: 'c' + c.id, k: c.name, owner: ownerOf(c.kind),
    status: c.status === 'completed' ? 'Received' : c.status === 'sent' || c.status === 'viewed' ? 'Sent' : 'Outstanding',
    due: shortDate(c.completed_at ?? c.sent_at ?? c.created_at),
  }));
  const earnest: TcEarnest[] = row.emd_amount != null || row.emd_received_at
    ? [{
        id: 'emd', party: 'Seller EMD', amount: money(row.emd_amount) ?? '—', holder: row.title_company ?? 'Title',
        due: d0 ? shortDate(plusDays(d0, 2)) : '—', received: row.emd_received_at ? shortDate(row.emd_received_at) : null,
        status: row.emd_received_at ? 'Received' : d0 && plusDays(d0, 2) < todayIso ? 'Overdue' : 'Pending',
      }]
    : [];
  const tx: Transaction = {
    id: 'tx' + row.id, dbId: row.id,
    dealId: row.deal_id ? did(row.deal_id) : '', personId: row.seller_id ? sid(row.seller_id) : '',
    escrow: row.title_company ? `${row.title_company} · file ${row.id}` : `File ${row.id}`,
    dealType: row.deal_type === 'novation' ? 'novation' : 'assignment',
    d0: shortDate(d0), ctcTarget: shortDate(row.ctc_target ?? (d0 ? plusDays(d0, 10) : null)),
    d0Iso: d0, closingIso: close,
    done, hudDone, tcReview: row.tc_review, signoff: row.signoff,
    titleCo: row.title_company ?? '—', titleContact: row.escrow_officer ?? '—',
    titlePhone: row.title_phone ?? '—', titleEmail: row.title_email ?? '—',
    opened: shortDate(row.created_at), closing: shortDate(close),
    commitment: {
      status: ctcIn ? 'Cleared' : commitIn ? 'Received' : 'Pending',
      received: null, effective: null, exceptions: [],
    },
    earnest, deadlines, documents, nextActions: [],
    state, buyerName, buyerFinancing: row.buyer_financing, lender: row.lender, structure: row.structure,
    contractSla: slaFor(dealCreatedAt ?? null, contracts, today),
  };
  // What Lane's drive says has slipped or fired, as the "who owes what" list.
  const drive = laneDrive(tx, template, today, tcName);
  const sevOf = (level: string) => (level === 'red' ? 'critical' : 'warning');
  tx.nextActions = [
    ...drive.triggers.map((t, i) => ({ id: 'tr' + i, who: t.escalate ?? tcName, role: 'TC', what: `${t.signal} — ${t.action}`, due: drive.dayMarker, severity: sevOf(t.level) })),
    ...drive.overdue.slice(0, 6).map((t) => ({ id: 'ov' + t.id, who: t.owner === 'TC' ? tcName : t.owner, role: t.owner, what: t.task, due: `Past ${t.day}`, severity: t.critical ? 'critical' : 'warning' })),
    ...drive.dueToday.slice(0, 6).map((t) => ({ id: 'dt' + t.id, who: t.owner === 'TC' ? tcName : t.owner, role: t.owner, what: t.task, due: `Due ${t.day}`, severity: 'info' })),
  ];
  return tx;
}

/** Rows of communications the reporting read takes; past it, long ranges undercount and the screen says so. */
const REPORT_COMMS_CAP = 10_000;

/**
 * Every row, not the first 1,000. PostgREST caps a response at the project's
 * max rows (1,000 by default), so a workspace with 11,000 leads loaded a
 * tenth of them. Pages need a stable order, so each caller ends its order
 * on `id`.
 *
 * A full page is followed by up to four more at once. Waiting on each page
 * in turn made the shell sit through a dozen round trips before it could
 * draw. A shared cap keeps those bursts from opening dozens of connections.
 * `cap` stops a read that only wants the newest N rows (reporting).
 */
const PAGE = 1000;
const PAGE_BATCH = 4;
const MAX_INFLIGHT = 8;
let inflight = 0;
const waiters: (() => void)[] = [];
function withSlot<T>(work: () => PromiseLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      inflight += 1;
      let p: Promise<T>;
      try { p = Promise.resolve(work()); } catch (e) { p = Promise.reject(e); }
      p.then(resolve, reject).finally(() => {
        inflight -= 1;
        waiters.shift()?.();
      });
    };
    if (inflight < MAX_INFLIGHT) start();
    else waiters.push(start);
  });
}
/**
 * A page that times out (a 500 when the database is busy, as right after a
 * deploy when every tab reloads at once) is asked for again, twice, before
 * the read gives up. One failed page used to drop the whole table from the
 * screen: every seller gone because page 12 of 14 timed out.
 */
const PAGE_RETRIES = 2;
const transientPage = (r: Page) => !r.status || r.status >= 500;
/**
 * A page that never answers held the whole first load (and its slot) for
 * good: the skeleton stayed up with nothing in the log. Each read now gives
 * up after PAGE_TIMEOUT_MS and comes back as status 0, which the retry above
 * treats as a timeout.
 */
const PAGE_TIMEOUT_MS = 25_000;
function timed<T>(make: () => PromiseLike<T>): () => PromiseLike<T> {
  return () => {
    const q = make() as PromiseLike<T> & { abortSignal?: (s: AbortSignal) => PromiseLike<T> };
    return typeof q.abortSignal === 'function' ? q.abortSignal(AbortSignal.timeout(PAGE_TIMEOUT_MS)) : q;
  };
}
/** One read, asked for again on a timeout the way a page is. */
async function again<T extends Page>(make: () => PromiseLike<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await withSlot(timed(make));
    if (!r.error || attempt >= PAGE_RETRIES || !transientPage(r)) return r;
    await new Promise((ok) => setTimeout(ok, 500 * 3 ** attempt));
  }
}
/** Keyset order for a read ordered by `id` alone. */
const BY_ID: KeyCol[] = [{ col: 'id', asc: true }];
/** Keyset order for a read ordered by `name`, then `id`. */
const BY_NAME: KeyCol[] = [{ col: 'name', asc: true }, { col: 'id', asc: true }];
/** Keyset order for a read ordered newest first by `occurred_at`, then `id`. */
const BY_OCCURRED: KeyCol[] = [{ col: 'occurred_at', asc: false }, { col: 'id', asc: false }];
/** How many pinned messages and pinned activity rows the workspace load reads. */
const PINS_CAP = 200;
/**
 * With `keys` (the read's ORDER BY, ending on a unique column the select
 * returns), pages are keyset pages, read one after another: each starts after
 * the last row of the one before, so page 14 costs what page 1 does
 * (lib/keyset.ts keysetRead). Without, OFFSET pages read in parallel bursts,
 * fine for a table of a few thousand narrow rows; a big table, or one with an
 * embed, should pass `keys`.
 */
async function all<T extends Page>(
  make: () => { range: (from: number, to: number) => PromiseLike<T> },
  cap = Number.POSITIVE_INFINITY,
  keys?: KeyCol[],
): Promise<T> {
  const fetchPage = async (page: () => PromiseLike<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const r = await withSlot(timed(page));
      if (!r.error || attempt >= PAGE_RETRIES || !transientPage(r)) return r;
      await new Promise((ok) => setTimeout(ok, 500 * 3 ** attempt));
    }
  };
  if (keys?.length) return keysetRead(make, keys, { pageSize: PAGE, cap, fetchPage });
  const take = (from: number): Promise<T> => fetchPage(() => make().range(from, from + PAGE - 1));
  const first = await take(0);
  if (first.error) return first;
  const rows: unknown[] = [...(first.data ?? [])];
  if ((first.data ?? []).length < PAGE || rows.length >= cap) return { ...first, data: rows.slice(0, cap) };
  for (let from = PAGE; ; from += PAGE * PAGE_BATCH) {
    const n = Math.min(PAGE_BATCH, Math.ceil((cap - rows.length) / PAGE));
    const batch = await Promise.all(Array.from({ length: n }, (_, i) => take(from + i * PAGE)));
    for (const r of batch) {
      if (r.error) return r;
      rows.push(...(r.data ?? []));
      if ((r.data ?? []).length < PAGE || rows.length >= cap) return { ...r, data: rows.slice(0, cap) };
    }
  }
}

type CachedRow = { id: number; updated_at?: string | null };
const rowCaches = new Map<string, RowCache<CachedRow>>();
const ok200 = <T,>(data: unknown[]) => ({ data, error: null, count: null, status: 200, statusText: 'OK' }) as unknown as T;

/**
 * A big table read for a reload: the cached rows plus what changed since
 * (lib/delta-rows.ts). The first read, a different workspace, a cache older
 * than DELTA_MAX_AGE_MS or any failed delta read takes the whole table.
 * `full` and `since` select the same columns, including updated_at; `ids`
 * has the same filters as `full`, so a row deleted or archived drops out.
 * `extraIds` names rows changed through a joined table (a seller's property).
 */
async function cachedRead<T extends Page>(name: string, ws: number, q: {
  full: () => Promise<T>;
  ids: () => PromiseLike<Page>;
  since: (iso: string) => PromiseLike<Page>;
  byIds: (ids: number[]) => PromiseLike<Page>;
  extraIds?: (iso: string) => Promise<number[]>;
  order: (a: CachedRow, b: CachedRow) => number;
}): Promise<T> {
  const c = rowCaches.get(name);
  const readAll = async () => {
    const r = await q.full();
    const rows = (r.data ?? []) as CachedRow[];
    if (!r.error) rowCaches.set(name, { ws, at: Date.now(), cursor: newestStamp(rows), rows: new Map(rows.map((x) => [x.id, x] as const)) });
    else rowCaches.delete(name);
    return r;
  };
  const since = c && c.ws === ws && Date.now() - c.at < DELTA_MAX_AGE_MS ? sinceOf(c.cursor) : null;
  if (!c || !since) return readAll();
  const [idsQ, changedQ, extra] = await Promise.all([q.ids(), q.since(since), q.extraIds?.(since) ?? Promise.resolve([])]);
  if (idsQ.error || changedQ.error) return readAll();
  const ids = ((idsQ.data ?? []) as CachedRow[]).map((r) => r.id);
  const changed = (changedQ.data ?? []) as CachedRow[];
  const { rows, missing } = mergeDelta(c.rows, ids, changed);
  const seen = new Set(changed.map((r) => r.id));
  const refetch = [...new Set([...missing, ...extra.filter((id) => rows.has(id) && !seen.has(id))])];
  for (let i = 0; i < refetch.length; i += 200) {
    const r = await q.byIds(refetch.slice(i, i + 200));
    if (r.error) return readAll();
    for (const row of (r.data ?? []) as CachedRow[]) rows.set(row.id, row);
  }
  c.rows = rows;
  c.cursor = newestStamp(rows.values(), c.cursor);
  return ok200<T>([...rows.values()].sort(q.order));
}

/** Ids from an id-only read; a failed read names nothing. */
const idsOf = (r: Page) => (r.error ? [] : ((r.data ?? []) as { id: number }[]).map((x) => x.id));

/**
 * One row per seller: channel and time of their latest communication.
 * Migration 113 returns the whole set as one jsonb value (one round trip,
 * ~50ms). A database without that function falls back to the embedded read,
 * which is the same answer spread across a page per thousand sellers.
 */
async function loadLastTouch(workspaceId: number): Promise<Map<number, LastComm>> {
  const out = new Map<number, LastComm>();
  if (!supabase) return out;
  const rpc = await supabase.rpc('seller_last_touch', { p_workspace: workspaceId });
  if (!rpc.error) {
    const rows = Array.isArray(rpc.data) ? rpc.data : [];
    for (const row of rows as { id?: number; channel?: string; occurred_at?: string }[]) {
      if (row.id == null || !row.occurred_at) continue;
      out.set(row.id, { channel: row.channel || 'note', occurred_at: row.occurred_at });
    }
    return out;
  }
  const q = await all(() => supabase!.from('sellers')
    .select('id,communications!communications_seller_id_fkey(channel,occurred_at)')
    .eq('workspace_id', workspaceId).is('archived_at', null)
    .order('occurred_at', { referencedTable: 'communications', ascending: false })
    .limit(1, { referencedTable: 'communications' })
    .order('id'), Number.POSITIVE_INFINITY, BY_ID);
  for (const r of (q.data ?? []) as unknown as { id: number; communications: LastComm[] | null }[]) {
    const c = r.communications?.[0];
    if (c?.occurred_at) out.set(r.id, c);
  }
  return out;
}

function dealProperty(p: DealRow['properties']): { line1: string; city: string | null; state: string | null; zip: string | null; lat?: number | null; lng?: number | null } | undefined {
  if (!p) return undefined;
  return Array.isArray(p) ? p[0] : p;
}

const SELLER_COLS = 'id,name,email,phone,property_address,asking_price,motivation,timeline,condition,occupancy,mortgage,desired_close,decision_makers,intake,lead_stage,stage_entered_at,notes,source,created_at,created_by,property_id,assigned_to,tags,properties(id,line1,city,state,zip,beds,baths,sqft,year_built,property_type,apn,lat,lng)';

const BUYER_COLS = 'id,name,company,email,phone,markets,max_purchase_price,buy_box,status,notes,source,buyer_type,entity_type,criteria,vetted_at,vip,blacklisted_at,preferred_channel,created_at,created_by,last_activity_at,tags,updated_at';

const DEAL_COLS ='id,seller_id,property_id,lead_stage,asking_price,submitted_at,target_assignment,marketing_headline,marketing_description,marketing_url,garage_spaces,stage,stage_entered_at,offer_amount,arv,rehab,mao,wholesale_offer,institutional_offer,assignment_fee,hero_image_url,photos_url,buyer_report_url,compr_cma_url,contract_date,close_date,option_ends_on,buyer_option_ends_on,owner_id,market,updated_at,buyer_id,underwriting_url,compr_report_url,title_vendor_id,title_contact,title_email,title_phone,earnest_money,condition_notes,occupancy_notes,dispo_rep_id,tc_rep_id,marketing_started_on,tracker_no,closed_on,sold_price,price_drop,marketed_price,marketed_fee,dispo_upsell,dispo_fee,transaction_type,contract_status,lead_source,acq_agent,dispo_agent,lead_manager,coordinator,created_at,archived_at,archived_reason,properties(line1,city,state,zip,lat,lng)';

/** A workspace with nothing in it: what a failed load shows. */
export function emptyLiveData(): LiveData {
  return {
    STAGES: [...PIPELINE_STAGES], matches: [],
    team: {}, people: [], deals: [], buyers: [], vendors: [], offerGaps: [], offerGapPeople: [],
    communications: [],
    timeline: [], tasks: [], inbox: [], notifications: [], enrollments: [], actionPlans: [],
    offers: [], walkthroughs: [], calendar: [], transactions: [],
    comps: [], propertyIntel: [], engagementFeed: [],
    tcItems: [], tcBlockers: [], tcFeed: [],
    reporting: { kpis: [], funnel: [], activity: [], leaderboard: [], sources: [], monthly: [] },
  };
}

/**
 * `shell`: the first screen's read. The newest PAGE sellers and what Home,
 * Today and the menus need (tasks, the latest messages and activity, the
 * team, notifications), with every other table left empty. It paints in one
 * round of reads instead of after every page of every table; the full read
 * runs beside it and replaces it when it lands (lib/use-crm.ts).
 */
export async function loadWorkspace(workspaceId: number, opts: { shell?: boolean } = {}): Promise<{ ok: boolean; data: LiveData }> {
  const shell = !!opts.shell;
  /** A read the shell leaves for the full load: an empty answer, no request. */
  const full = <T,>(read: () => PromiseLike<T>): Promise<T> =>
    shell ? Promise.resolve({ data: [], error: null, count: null, status: 200, statusText: 'OK' } as unknown as T) : Promise.resolve(read());
  const empty = emptyLiveData();
  if (!supabase) return { ok: false, data: empty };
  const w = workspaceId;
  // A mention is addressed to one teammate; everything else is workspace-wide.
  const uid = (await supabase.auth.getSession()).data.session?.user.id;

  // Photos, offer gaps, and the reporting history load after this returns
  // (enrichWorkspace). They are not on the first screen, and waiting on them
  // kept People, Buyers, and Deals blank.
  const [
    sellersQ, commsQ, dealsQ, tasksQ, buyersQ, vendorsQ,
    notifsQ, activityQ, plansQ, enrollQ, membersQ, offersQ, apptsQ, matchesQ, txQ, contractsQ,
    pinCommsQ, pinActsQ, rosterQ, mailboxesQ, lastTouch,
    underwriterQ, buyerOwnerQ, dealUnderwriterQ, buyerArchivedQ, podioSubsQ, dealMovesQ, sellerPartiesQ, bandSetQ,
    buyerScoresQ,
  ] = await Promise.all([
    shell
      ? all(() => supabase!.from('sellers')
        .select(SELLER_COLS)
        .eq('workspace_id', w).is('archived_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }),
      PAGE, [{ col: 'created_at', asc: false }, { col: 'id', asc: false }])
      : cachedRead('sellers', w, {
        full: () => all(() => supabase!.from('sellers').select(SELLER_COLS + ',updated_at')
          .eq('workspace_id', w).is('archived_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }),
        Number.POSITIVE_INFINITY, [{ col: 'created_at', asc: false }, { col: 'id', asc: false }]),
        ids: () => all(() => supabase!.from('sellers').select('id').eq('workspace_id', w).is('archived_at', null).order('id'), Number.POSITIVE_INFINITY, BY_ID),
        since: (iso) => all(() => supabase!.from('sellers').select(SELLER_COLS + ',updated_at')
          .eq('workspace_id', w).is('archived_at', null).gte('updated_at', iso).order('id'), Number.POSITIVE_INFINITY, BY_ID),
        byIds: (ids) => again(() => supabase!.from('sellers').select(SELLER_COLS + ',updated_at').in('id', ids)),
        // A seller row embeds its property, whose edits do not touch the seller.
        extraIds: async (iso) => {
          const props = idsOf(await all(() => supabase!.from('properties').select('id').eq('workspace_id', w).gte('updated_at', iso).order('id'), Number.POSITIVE_INFINITY, BY_ID));
          const out: number[] = [];
          for (let i = 0; i < props.length; i += 200) {
            out.push(...idsOf(await again(() => supabase!.from('sellers').select('id').eq('workspace_id', w).in('property_id', props.slice(i, i + 200)))));
          }
          return out;
        },
        order: (a, b) => {
          const x = String((a as { created_at?: string }).created_at ?? ''), y = String((b as { created_at?: string }).created_at ?? '');
          return x === y ? b.id - a.id : x < y ? 1 : -1;
        },
      }),
    again(() => withAgentColumn((a) => supabase!.from('communications')
      .select(commCols(a))
      .eq('workspace_id', w).order('occurred_at', { ascending: false }).limit(500))),
    full(() => all(() => supabase!.from('deals')
      .select(DEAL_COLS)
      .eq('workspace_id', w).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    all(() => supabase!.from('tasks')
      .select('id,seller_id,deal_id,buyer_id,title,task_type,priority,due_at,assigned_to,done,notes,completed_at,created_at')
      .eq('workspace_id', w).order('due_at', { ascending: true, nullsFirst: false }).order('id'),
      Number.POSITIVE_INFINITY, [{ col: 'due_at', asc: true, nullable: true }, { col: 'id', asc: true }]),
    // The free-agent corpus is six figures of rows in both tables. The shell
    // works the people we actually market to. Buyers › Realtors pages that
    // corpus through search_free_agent_buyers. isDistinct matches the partial
    // shell indexes; paging the corpus is what timed the request out.
    full(() => cachedRead('buyers', w, {
      full: () => all(() => supabase!.from('buyers').select(BUYER_COLS)
        .eq('workspace_id', w).isDistinct('source', BULK_BUYER_SOURCE).order('name').order('id'), Number.POSITIVE_INFINITY, BY_NAME),
      ids: () => all(() => supabase!.from('buyers').select('id').eq('workspace_id', w).isDistinct('source', BULK_BUYER_SOURCE).order('id'), Number.POSITIVE_INFINITY, BY_ID),
      since: (iso) => all(() => supabase!.from('buyers').select(BUYER_COLS)
        .eq('workspace_id', w).isDistinct('source', BULK_BUYER_SOURCE).gte('updated_at', iso).order('id'), Number.POSITIVE_INFINITY, BY_ID),
      byIds: (ids) => again(() => supabase!.from('buyers').select(BUYER_COLS).in('id', ids)),
      order: (a, b) => {
        const x = String((a as { name?: string }).name ?? ''), y = String((b as { name?: string }).name ?? '');
        return x === y ? a.id - b.id : x < y ? -1 : 1;
      },
    })),
    full(() => all(() => supabase!.from('vendors')
      .select('id,business_name,contact_name,email,phone,service_type,markets,status,notes,city,state,office_address,is_main_poc,deals_brought,offers_sent,offers_accepted,deals_closed')
      .eq('workspace_id', w).neq('status', 'archived').isDistinct('source', BULK_BUYER_SOURCE).order('business_name').order('id'),
      Number.POSITIVE_INFINITY, [{ col: 'business_name', asc: true }, { col: 'id', asc: true }])),
    supabase.from('notifications')
      .select('*')
      // Only what is addressed to me: a row with no recipient is nobody's, not everybody's.
      .eq('workspace_id', w).eq('user_id', uid ?? '00000000-0000-0000-0000-000000000000').order('created_at', { ascending: false }).limit(50),
    again(() => withAgentColumn((a) => supabase!.from('activity')
      .select(activityCols(a))
      .eq('workspace_id', w).order('occurred_at', { ascending: false }).limit(300))),
    supabase.from('action_plans')
      .select('id,name,description,trigger_event,active,settings,action_plan_steps(id,position,channel,delay_hours,title,body)')
      .eq('workspace_id', w).order('name'),
    full(() => all(() => supabase!.from('enrollments').select('id,plan_id,seller_id,buyer_id,status,step_index').eq('workspace_id', w).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    supabase.from('workspace_members').select('user_id,role,profiles(full_name,title,avatar_url,email)').eq('workspace_id', w),
    full(() => all(() => supabase!.from('offers').select('id,deal_id,buyer_id,amount,status,sent_at,terms').eq('workspace_id', w).order('sent_at', { ascending: false }).order('id'),
      Number.POSITIVE_INFINITY, [{ col: 'sent_at', asc: false }, { col: 'id', asc: true }])),
    // Every appointment, oldest first, by keyset pages: one read stopped at
    // PostgREST's 1,000 rows and, oldest first, dropped the newest.
    full(() => all(() => supabase!.from('appointments').select('id,seller_id,buyer_id,title,kind,starts_at,assigned_to,source,created_at,deleted_at')
      .eq('workspace_id', w).order('starts_at').order('id'), Number.POSITIVE_INFINITY, [{ col: 'starts_at', asc: true }, { col: 'id', asc: true }])),
    full(() => all(() => supabase!.from('deal_buyer_matches').select('id,deal_id,buyer_id,score,reasons,status,sent_at,viewed_at,replied_at,updated_at').eq('workspace_id', w).order('score', { ascending: false }).order('id'),
      Number.POSITIVE_INFINITY, [{ col: 'score', asc: false }, { col: 'id', asc: true }])),
    full(() => all(() => supabase!.from('transactions')
      .select('id,deal_id,property_id,seller_id,buyer_id,title_company,escrow_officer,title_email,title_phone,emd_amount,emd_received_at,option_ends_on,close_date,status,created_at,deal_type,contract_date,ctc_target,checklist,hud,tc_review,signoff,buyer_financing,lender,structure')
      .eq('workspace_id', w).order('close_date', { ascending: true, nullsFirst: false }).order('id'),
      Number.POSITIVE_INFINITY, [{ col: 'close_date', asc: true, nullable: true }, { col: 'id', asc: true }])),
    full(() => all(() => supabase!.from('contracts').select('id,deal_id,seller_id,kind,name,status,sent_at,viewed_at,completed_at,created_at,provider')
      .eq('workspace_id', w).order('created_at', { ascending: false }).order('id', { ascending: false }),
      Number.POSITIVE_INFINITY, [{ col: 'created_at', asc: false }, { col: 'id', asc: false }])),
    // Pins (migration 43) are their own reads, so a database without the
    // columns yet loses the Pinned section and nothing else.
    // Newest PINS_CAP of each, on a partial index (migration 227): unbounded and
    // unindexed, these read every message and every activity row in the workspace.
    supabase.from('communications').select('id,pinned_at,pinned_by').eq('workspace_id', w).not('pinned_at', 'is', null)
      .order('pinned_at', { ascending: false }).limit(PINS_CAP),
    supabase.from('activity').select('id,pinned_at,pinned_by').eq('workspace_id', w).not('pinned_at', 'is', null)
      .order('pinned_at', { ascending: false }).limit(PINS_CAP),
    // Our own addresses: an email from one of these was sent by us, whatever
    // the stored direction says (see ourAddresses below).
    supabase.from('workspace_roster').select('email').eq('workspace_id', w),
    supabase.from('google_accounts').select('email').eq('workspace_id', w),
    // Latest touch per seller, so a lead last reached before the newest 500
    // messages does not read "No contact yet".
    shell ? Promise.resolve(new Map<number, LastComm>()) : loadLastTouch(w),
    // Underwriters (migration 122) are their own read, so a database without
    // the column yet loses the Underwriter line and nothing else.
    full(() => all(() => supabase!.from('sellers').select('id,underwriter_id')
      .eq('workspace_id', w).is('archived_at', null).not('underwriter_id', 'is', null).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // Who each buyer is assigned to (migration 128): its own read, so a
    // database without the column yet loses the Owner line and nothing else.
    full(() => all(() => supabase!.from('buyers').select('id,assigned_to')
      .eq('workspace_id', w).isDistinct('source', BULK_BUYER_SOURCE).not('assigned_to', 'is', null).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // A submission's own underwriter (migration 130), read alone for the same reason.
    full(() => all(() => supabase!.from('deals').select('id,underwriter_id')
      .eq('workspace_id', w).not('underwriter_id' as never, 'is', null).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // Archived buyers (migration 131), read alone for the same reason: they
    // leave every list. A database without the column archives nobody.
    // Only the shell's buyers can be hidden by it, so the corpus is left out
    // here too (it was paged through for nothing).
    full(() => all(() => supabase!.from('buyers').select('id')
      .eq('workspace_id', w).isDistinct('source', BULK_BUYER_SOURCE).not('archived_at' as never, 'is', null).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // Podio's Submissions items (migration 132's ledger), so the Submissions
    // counts are Podio's own. A database without the table counts deals instead.
    full(() => all(() => supabase!.from('podio_items' as never).select('item_id,deal_id,podio_stage,created_on,note')
      .eq('workspace_id' as never, w as never).eq('app_key' as never, 'submissions' as never).order('item_id' as never),
      Number.POSITIVE_INFINITY, [{ col: 'item_id', asc: true }])),
    // The submission stage moves a person made (migration 125's stage_events,
    // changed_by set): CLOZR never writes them back to Podio, so these say
    // which Podio items CLOZR has moved on since.
    full(() => all(() => supabase!.from('stage_events' as never).select('id,entity_id,to_stage,changed_at')
      .eq('workspace_id' as never, w as never).eq('entity_type' as never, 'deal' as never).eq('field' as never, 'lead_stage' as never)
      .not('changed_by' as never, 'is', null).order('changed_at' as never).order('id' as never),
      Number.POSITIVE_INFINITY, [{ col: 'changed_at', asc: true }, { col: 'id', asc: true }])),
    // Vendors attached as the seller (role seller + vendor_id). A miss leaves
    // those names off the submission; it does not fail the rest of the load.
    full(() => all(() => supabase!.from('deal_parties').select('id,deal_id,vendor_id,role,name,company,email,phone')
      .eq('workspace_id', w).eq('role', 'seller').not('vendor_id', 'is', null).order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // Low / high offers a person set (migration 184), read alone for the same
    // reason: a database without the columns treats every band as COMPR's.
    full(() => all(() => supabase!.from('deals').select('id,offer_low_set_at,offer_high_set_at' as never)
      .eq('workspace_id', w).or('offer_low_set_at.not.is.null,offer_high_set_at.not.is.null').order('id'), Number.POSITIVE_INFINITY, BY_ID)),
    // Response rate and its counts from buyer-score (migration 106), read from
    // each buyer's whole history. The comms above are only the newest 500, so
    // the list cannot work a reply rate out from them.
    full(() => all(() => supabase!.from('buyer_scores').select('buyer_id,response_rate,stats')
      .eq('workspace_id', w).order('buyer_id'), Number.POSITIVE_INFINITY, [{ col: 'buyer_id', asc: true }])),
  ]);

  const ok = ![sellersQ, commsQ, dealsQ, tasksQ, buyersQ, vendorsQ, notifsQ, activityQ, plansQ, enrollQ, membersQ, offersQ, apptsQ]
    .some((q) => q.error);

  const sellers = (sellersQ.data ?? []) as unknown as SellerRow[];
  const comms = (commsQ.data ?? []) as unknown as CommRow[];
  const deals = (dealsQ.data ?? []) as unknown as DealRow[];
  // Oldest first, so each deal ends on its latest move by a person.
  const personMoveByDeal = new Map(((dealMovesQ.error ? [] : dealMovesQ.data ?? []) as unknown as { entity_id: number; to_stage: string | null }[])
    .map((r) => [Number(r.entity_id), r.to_stage] as const));
  const leadStageById = new Map(deals.map((d) => [d.id, d.lead_stage] as const));
  const taskRows = (tasksQ.data ?? []) as unknown as TaskRow[];
  const archivedBuyers = new Set(((buyerArchivedQ.data ?? []) as unknown as { id: number }[]).map((r) => r.id));
  const buyers = ((buyersQ.data ?? []) as unknown as BuyerRow[]).filter((b) => !archivedBuyers.has(b.id));
  const vendors = (vendorsQ.data ?? []) as unknown as VendorRow[];
  const notifs = (notifsQ.data ?? []) as unknown as NotificationRow[];
  const acts = (activityQ.data ?? []) as unknown as ActivityRow[];
  const plans = (plansQ.data ?? []) as unknown as PlanRow[];
  const enrolls = (enrollQ.data ?? []) as unknown as EnrollmentRow[];
  const members = (membersQ.data ?? []) as unknown as MemberRow[];
  const offerRows = (offersQ.data ?? []) as unknown as OfferRowDb[];
  const appts = (apptsQ.data ?? []) as unknown as AppointmentRow[];
  // Matches are optional reads: an acquisitions rep cannot see buyers, and that is not a failed load.
  const matchRows = (matchesQ.data ?? []) as unknown as MatchRow[];
  // So are the TC file and the contracts: RLS scopes them to the roles that work them.
  const txRows = (txQ.data ?? []) as unknown as TxRowDb[];
  const contractRows = (contractsQ.data ?? []) as unknown as ContractRowDb[];

  // Offer gaps, photos, and the long reporting read arrive in enrichWorkspace
  // so the first paint does not wait on them.
  const offerGaps: OfferGap[] = [];
  const offerGapPeople: OfferGapPerson[] = [];

  // The team roster: workspace members, not a table of its own. Reps are keyed
  // by auth uid, which is what every assigned/owner column already stores.
  const team: Record<string, Rep> = {};
  for (const m of members) {
    const name = m.profiles?.full_name || 'Teammate';
    team[m.user_id] = {
      id: m.user_id,
      name,
      initials: initialsOf(name),
      role: m.profiles?.title || (m.role === 'tc' ? 'Transaction coordinator' : m.role === 'owner' ? 'Owner' : 'Member'),
      dept: m.role === 'tc' ? 'TC' : m.role === 'dispositions' ? 'Dispo' : m.role === 'partnerships' ? 'Partnerships' : 'Acquisitions',
      memberRole: m.role,
      ...(m.profiles?.avatar_url ? { avatar: m.profiles.avatar_url } : {}),
    };
  }
  const repName = (id: string | null) => (id && team[id] ? team[id].name : 'CLOZR');
  const [lines, agents] = await Promise.all([lineLabels(w), agentFaces(w)]);
  const sentBy = sentByFor(lines, repName);
  // Whose conversation a message is: the rep on it, else the owner of the line it came in or went out on.
  const commOwner = (c: CommRow): string | null => {
    const num = String((c.direction === 'inbound' ? c.to_phone : c.from_phone) ?? '').replace(/\D/g, '').slice(-10);
    return c.rep_id ?? lines.get(num)?.user_id ?? null;
  };

  // A contact's deal is its live contract, else its latest real deal, else its latest submission.
  const dealBySeller = new Map<number, DealRow>();
  for (const d of deals) {
    if (d.seller_id == null) continue;
    const cur = dealBySeller.get(d.seller_id);
    if (!cur || dealRank(d) > dealRank(cur)) dealBySeller.set(d.seller_id, d);
  }

  const sellerName = new Map<number, string>(sellers.map((s) => [s.id, s.name]));

  // Latest contact per seller: the one-shot read, else the timeline's newest
  // 500, whichever is later. comms arrive newest-first.
  const lastBySeller = new Map<number, LastComm>(lastTouch);
  for (const c of comms) {
    if (c.seller_id == null) continue;
    const cur = lastBySeller.get(c.seller_id);
    if (!cur || Date.parse(c.occurred_at) > Date.parse(cur.occurred_at)) lastBySeller.set(c.seller_id, c);
  }
  const underwriterBySeller = new Map(((underwriterQ.data ?? []) as unknown as { id: number; underwriter_id: string }[])
    .map((r) => [r.id, r.underwriter_id]));
  const buyerOwner = new Map(((buyerOwnerQ.data ?? []) as unknown as { id: number; assigned_to: string }[])
    .map((r) => [r.id, r.assigned_to]));
  // Tasks arrive soonest-due first, so the first open task per seller is the next one.
  const nextTaskBySeller = new Map<number, TaskRow>();
  for (const t of taskRows) {
    if (t.done || t.seller_id == null || nextTaskBySeller.has(t.seller_id)) continue;
    nextTaskBySeller.set(t.seller_id, t);
  }
  const people = sellers.map((s) => ({
    ...mapPerson(s, lastBySeller.get(s.id) ?? null, nextTaskBySeller.get(s.id), dealBySeller.get(s.id)),
    underwriter: underwriterBySeller.get(s.id) ?? null,
  }));
  // A partner archived out of People can still own open submissions (iFinder
  // sends hundreds). Their rows load too, apart from people, so a submission
  // opens its record instead of falling back to the deal sheet. A miss only
  // means those submissions open their deal sheet, as before.
  const loaded = new Set(sellers.map((s) => s.id));
  const missingSellers = [...new Set(deals.filter((d) => !d.archived_at && d.seller_id != null && !loaded.has(d.seller_id)).map((d) => d.seller_id!))];
  const archivedQ = missingSellers.length && !shell
    ? await supabase!.from('sellers').select(SELLER_COLS).eq('workspace_id', w).in('id', missingSellers)
    : null;
  const archivedPeople = ((archivedQ && !archivedQ.error ? archivedQ.data ?? [] : []) as unknown as SellerRow[]).map((s) => ({
    ...mapPerson(s, lastBySeller.get(s.id) ?? null, nextTaskBySeller.get(s.id), dealBySeller.get(s.id)),
    underwriter: underwriterBySeller.get(s.id) ?? null,
  }));
  const underwriterByDeal = new Map(((dealUnderwriterQ.data ?? []) as unknown as { id: number; underwriter_id: string }[])
    .map((r) => [r.id, r.underwriter_id]));
  const bandSetByDeal = new Map(((bandSetQ.error ? [] : bandSetQ.data ?? []) as unknown as { id: number; offer_low_set_at: string | null; offer_high_set_at: string | null }[])
    .map((r) => [r.id, { lowSet: !!r.offer_low_set_at, highSet: !!r.offer_high_set_at }]));
  const sellersOnDeal = vendorSellersByDeal(
    (sellerPartiesQ.error ? [] : sellerPartiesQ.data ?? []) as SellerPartyRow[],
    vendors,
  );
  const mappedDeals = deals.map((d) => {
    const m0 = mapDeal(d, Math.floor((minutesAgo(d.updated_at) ?? 0) / (60 * 24)), dealProperty(d.properties));
    const uw = underwriterByDeal.get(d.id);
    const vendorSellers = sellersOnDeal.get(d.id);
    const bandSet = bandSetByDeal.get(d.id);
    const m = { ...m0, ...(uw ? { underwriter: uw } : {}), ...(vendorSellers?.length ? { vendorSellers } : {}), ...(bandSet ?? {}) };
    // The hero is on the deal row. Gallery photos, listings, and amendments arrive with enrichWorkspace.
    return m.heroUrl ? { ...m, photoUrl: m.heroUrl } : m;
  });
  const communications = comms.map((c) => mapCommunication(c, sellerName));

  // Inbox is a view over communications, not its own table: the newest inbound
  // message per seller, which is exactly what the screen lists. Storing it
  // separately would mean two places to keep in step for no gain.
  const seen = new Set<number>();
  const seenBuyers = new Set<number>();
  const inbox: InboxItem[] = [];
  for (const c of comms) {
    if (c.seller_id != null && !seen.has(c.seller_id) && c.direction === 'inbound') {
      seen.add(c.seller_id);
      inbox.push({
        id: 'i' + c.id,
        personId: sid(c.seller_id),
        channel: c.channel === 'sms' ? 'SMS' : c.channel[0].toUpperCase() + c.channel.slice(1),
        preview: mailPreview(c.summary, c.body, '—'),
        time: relative(c.occurred_at),
        unread: 0,
        assigned: null,
        fromPhone: c.from_phone, fromEmail: c.from_email ?? null, subject: c.subject,
      });
    }
    if (c.buyer_id != null && !seenBuyers.has(c.buyer_id) && c.direction === 'inbound') {
      seenBuyers.add(c.buyer_id);
      inbox.push({
        id: 'ib' + c.id,
        personId: null,
        buyerId: bid(c.buyer_id),
        channel: c.channel === 'sms' ? 'SMS' : c.channel[0].toUpperCase() + c.channel.slice(1),
        preview: mailPreview(c.summary, c.body, '—'),
        time: relative(c.occurred_at),
        unread: 0,
        assigned: null,
        fromPhone: c.from_phone, fromEmail: c.from_email ?? null, subject: c.subject,
      });
    }
  }

  // Rows the first Gmail pull wrote called anything not from a CRM contact
  // "outbound", so a title company's email to us read as one we sent. The
  // sender decides it: from one of our own addresses is sent, else received.
  const ours = new Set([...((rosterQ.data ?? []) as { email: string | null }[]), ...((mailboxesQ.data ?? []) as { email: string | null }[])]
    .map((r) => (r.email ?? '').trim().toLowerCase()).filter(Boolean));
  const matchesByBuyer = byBuyer(matchRows, (m) => m.buyer_id);
  const offersByBuyer = byBuyer(offerRows, (o) => o.buyer_id);
  const commsByBuyer = byBuyer(comms, (c) => c.buyer_id);
  const dealsByBuyer = byBuyer(deals, (d) => d.buyer_id);
  const scoreByBuyer = new Map(((buyerScoresQ.error ? [] : buyerScoresQ.data ?? []) as unknown as ResponseScore[]).map((r) => [Number(r.buyer_id), r] as const));
  const callNotes = linkCallNotes(comms);
  const pins = new Map<string, PinRow>([
    ...((pinCommsQ.data ?? []) as unknown as PinRow[]).map((r) => ['ct' + r.id, r] as const),
    ...((pinActsQ.data ?? []) as unknown as PinRow[]).map((r) => ['a' + r.id, r] as const),
  ]);
  const pinned = (e: TimelineEntry): TimelineEntry => {
    const r = pins.get(e.id);
    return r?.pinned_at ? { ...e, pinnedAt: r.pinned_at, pinnedBy: r.pinned_by } : e;
  };
  return {
    ok,
    data: {
      STAGES: [...PIPELINE_STAGES],
      matches: matchRows.map((m) => ({
        id: 'm' + m.id, dealId: did(m.deal_id), buyerId: bid(m.buyer_id), score: m.score, reasons: m.reasons ?? [], status: m.status,
        sent: m.sent_at ? relative(m.sent_at) : null, viewed: m.viewed_at ? relative(m.viewed_at) : null, replied: m.replied_at ? relative(m.replied_at) : null,
      })),
      team,
      people,
      archivedPeople,
      deals: mappedDeals,
      podioSubmissions: ((podioSubsQ.error ? [] : podioSubsQ.data ?? []) as unknown as { item_id: number; deal_id: number | null; podio_stage: string | null; created_on: string | null; note: string | null }[])
        .map((r) => ({
          itemId: Number(r.item_id), dealId: r.deal_id != null ? did(r.deal_id) : null, stage: podioStageLabel(r.podio_stage), createdOn: r.created_on, note: r.note,
          clozrStage: r.deal_id != null ? clozrHeldStage(leadStageById.get(Number(r.deal_id)), personMoveByDeal.get(Number(r.deal_id))) : null,
        })),
      buyers: buyers.map((b) => ({
        ...mapBuyer(
          b,
          matchesByBuyer.get(b.id) ?? [],
          offersByBuyer.get(b.id) ?? [],
          commsByBuyer.get(b.id) ?? [],
          dealsByBuyer.get(b.id) ?? [],
          scoreByBuyer.get(b.id) ?? null,
        ),
        assigned: buyerOwner.get(b.id) ?? null,
      })),
      vendors: vendors.map(mapVendor),
      offerGaps,
      offerGapPeople,
      communications,
      // One feed: what was done to the record (activity) and what was said on
      // it (communications), newest first.
      timeline: [
        ...acts.map((a) => ({ at: a.occurred_at, e: pinned(mapActivity(a, repName, agents)) })),
        // An email Gmail matched to a seller and a buyer lands on both records.
        ...comms.flatMap((c) => {
          const base = pinned(commTimeline(c, sellerName, ours, sentBy, agents));
          const notes = callNotes.notesByCall.get(c.id);
          const e = notes ? { ...base, callNote: notes.join('\n\n') } : callNotes.placed.has(c.id) ? { ...base, underCall: true } : base;
          const rows = e.entity ? [{ at: c.occurred_at, e }] : [];
          if (c.buyer_id) rows.push({ at: c.occurred_at, e: { ...e, id: e.id + ':b', entity: bid(c.buyer_id) } });
          return rows.length ? rows : [{ at: c.occurred_at, e }];
        }),
      ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((x) => ({ ...x.e, at: x.at })),
      tasks: (() => {
        const sellerByDeal = new Map<number, number | null>();
        for (const d of deals) sellerByDeal.set(d.id, d.seller_id);
        return taskRows.map((t) => mapTask(t, (id) => sellerByDeal.get(id)));
      })(),
      inbox,
      notifications: notifs.map((n): Notification => {
        // A Dispo note (a buyer replying to a campaign, migration 86) opens the
        // buyer, where the reply thread is; one with only a deal opens that
        // deal's dispo property, which is keyed by the deal's seller.
        const dispoSeller = n.category === 'Dispo' && n.deal_id ? deals.find((d) => d.id === n.deal_id)?.seller_id ?? null : null;
        return {
          id: 'n' + n.id,
          cat: n.category,
          // Lane's check-in is long; the bell shows its title and Lane's panel the note.
          text: n.category === 'Lane' ? n.title : n.body ? `${n.title} — ${n.body}` : n.title,
          ...(n.category === 'Lane' && n.body ? { body: n.body } : {}),
          time: relative(n.created_at),
          unread: !n.read_at,
          direct: !!n.user_id,
          // The exact spot: the record's tab, the deal, the thread (lib/notif-target).
          link: notifLink(n, dispoSeller),
        };
      }).concat(bellFromComms(communications.map((c, i) => ({
        owner: commOwner(comms[i]),
        id: c.id,
        channel: c.channel,
        dir: c.dir,
        party: c.party,
        time: c.time,
        ts: c.ts,
        preview: c.preview,
        status: c.status,
        dur: c.dur,
        personId: c.personId || undefined,
        buyerId: c.buyerId,
        phone: comms[i].direction === 'inbound' ? comms[i].from_phone : null,
        at: comms[i].occurred_at,
      })))),
      enrollments: enrolls.map((e) => ({
        id: 'en' + e.id,
        personId: e.seller_id ? sid(e.seller_id) : '',
        buyerId: e.buyer_id ? bid(e.buyer_id) : '',
        planId: 'ap' + e.plan_id,
        step: e.step_index + 1,
        status: e.status,
        note: '',
      })),
      actionPlans: plans.map(mapPlan),

      // An offer row carries the number and who made it, and the EMD, close
      // days and contingency when they were logged with it. Proof of funds and
      // a confidence score are fields the prototype's screen shows and the
      // table does not have — they read as unknown rather than as a fabricated
      // figure on a real offer.
      offers: offerRows.map((o) => ({
        id: 'o' + o.id,
        buyerId: o.buyer_id ? bid(o.buyer_id) : '',
        dealId: o.deal_id ? did(o.deal_id) : '',
        offer: Number(o.amount ?? 0),
        // The terms the buyer gave when the offer was logged; a row without
        // them still reads as unknown.
        emd: Number(o.terms?.emd ?? 0) || 0,
        inspection: o.terms?.contingency || '—',
        closing: o.terms?.close_days ? `${o.terms.close_days} days` : shortDate(o.sent_at),
        financing: '—',
        pof: '—',
        terms: o.status,
        confidence: 0,
        flags: [],
      })),

      walkthroughs: appts.filter((a) => /walk/i.test(a.kind)).map((a) => ({
        id: 'w' + a.id,
        buyerId: a.buyer_id ? bid(a.buyer_id) : '',
        personId: a.seller_id ? sid(a.seller_id) : '',
        date: shortDate(a.starts_at),
        time: new Date(a.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        // An appointment row carries no confirmation; it is scheduled, nothing more.
        status: 'Scheduled',
      })),

      // The calendar is appointments and dated tasks, grouped by day — not a
      // table of its own.
      calendar: buildCalendar(appts, taskRows),

      // A transaction's screen is built on the Acme Homes contract-to-close
      // checklist. The file is the transactions row (migration 36 opens one
      // the moment a deal goes under contract); documents are the deal's
      // contracts; the exceptions land when Lane reads a commitment.
      transactions: txRows.map((t) => {
        const seller = sellers.find((s) => s.id === t.seller_id);

        // The deal's close date is the one the Deal Sheet edits and the board
        // and calendar show; the file's copy only stands in when the deal is
        // not readable to this role, so the countdown and deadlines never sit
        // on a date the deal has moved off.
        const deal = t.deal_id ? deals.find((d) => d.id === t.deal_id) : undefined;
        // The buyer the deal names now, so the file's buyer id and name agree.
        const buyer = buyers.find((b) => b.id === (deal?.buyer_id ?? t.buyer_id));
        // Since migration 239 the file follows the deal in the database; reading
        // the deal first still covers a load between a save and that trigger.
        return mapTransaction(
          deal ? {
            ...t, close_date: deal.close_date ?? t.close_date, contract_date: deal.contract_date ?? t.contract_date,
            option_ends_on: deal.option_ends_on ?? t.option_ends_on, buyer_id: deal.buyer_id ?? t.buyer_id,
          } : t, seller?.name ?? '', buyer?.name ?? '', seller?.properties?.state ?? null,
          contractRows.filter((c) => (t.deal_id && c.deal_id === t.deal_id) || (!t.deal_id && t.seller_id && c.seller_id === t.seller_id)),
          new Date(), teamTc(team)?.name ?? 'TC', deal?.created_at ?? null,
        );
      }),
      tcItems: [],
      tcBlockers: [],
      tcFeed: [],

      comps: [],
      propertyIntel: [],
      engagementFeed: [],

      reporting: {
        ...buildReporting(people, mappedDeals, comms, team),
        raw: {
          members: members.map((m) => ({ id: m.user_id, name: m.profiles?.full_name || 'Teammate', role: m.role, email: m.profiles?.email ?? null, avatar: m.profiles?.avatar_url ?? null })),
          sellers: sellers.map((x) => ({ id: x.id, name: x.name, created_at: x.created_at, source: x.source, assigned_to: x.assigned_to, stage: x.lead_stage, address: x.properties?.line1 || x.property_address, email: x.email, phone: x.phone, tags: x.tags ?? [], stage_entered_at: x.stage_entered_at })),
          // Money columns, the long call history, and offer direction fill in
          // from enrichWorkspace. Until then reporting uses the rows already
          // on screen, and says the call history is still short.
          deals: deals.map((d) => ({
            id: d.id, seller_id: d.seller_id, buyer_id: d.buyer_id, stage: d.stage, created_at: d.created_at,
            stage_entered_at: d.stage_entered_at, contract_date: d.contract_date, close_date: d.close_date,
            closed_on: d.closed_on, marketing_started_on: null, owner_id: d.owner_id, dispo_rep_id: null,
            offer_amount: d.offer_amount, arv: d.arv, mao: d.mao, assignment_fee: d.assignment_fee,
            sold_price: d.sold_price, dispo_fee: d.dispo_fee, wholesale_fee: null, total_cogs: null,
            team_commissions_paid: null, deal_net_profit: null, final_profit: null,
            lead_source: d.lead_source, market: d.market, marketed_price: d.marketed_price, coordinator: d.coordinator,
          })),
          comms: comms.map((c) => ({
            seller_id: c.seller_id, buyer_id: c.buyer_id, rep_id: c.rep_id, from_phone: c.from_phone, to_phone: c.to_phone,
            channel: c.channel, direction: c.direction, occurred_at: c.occurred_at, duration_s: c.duration_s, status: c.status,
          })),
          lines: [...lines.entries()].map(([phone10, l]) => ({ phone10, user_id: l.user_id, label: l.label })),
          commsCapped: comms.length >= 500,
          partial: 'loading',
          offers: [],
          contracts: contractRows.map((c) => ({ id: c.id, deal_id: c.deal_id, kind: c.kind, status: c.status, provider: c.provider ?? null, sent_at: c.sent_at, viewed_at: c.viewed_at, completed_at: c.completed_at, created_at: c.created_at })),
          matches: matchRows,
          buyers: buyers.map((b) => ({ id: b.id, name: b.name, vip: b.vip, created_at: b.created_at, last_activity_at: b.last_activity_at, blacklisted_at: b.blacklisted_at, created_by: b.created_by ?? null })),
          transactions: txRows.map((t) => ({ deal_id: t.deal_id, close_date: t.close_date, status: t.status, title_company: t.title_company })),
          appointments: appts,
          tasks: taskRows,
        },
      },
    },
  };
}

export type DealPhotoRow = { deal_id: number; url: string; source?: string | null; is_cover?: boolean | null; position?: number | null };
type DealAmendRow = { deal_id: number; field: string; old_value: number | null; new_value: number | null; delta: number; changed_by: string | null; changed_at: string };

/** Cover, else the deal's hero, else the first public photo. Same order the shell used to apply before first paint. */
function attachDealMedia(deals: Deal[], photos: DealPhotoRow[], links: { deal_id: number; slug: string }[], amends: DealAmendRow[]): Deal[] {
  const firstPhoto = new Map<number, string>();
  const firstPublicPhoto = new Map<number, string>();
  const firstComprPhoto = new Map<number, string>();
  const photosByDeal = new Map<number, { url: string; source: string | null; cover: boolean; position: number | null }[]>();
  const coverPhoto = new Map<number, string>();
  for (const p of photos) {
    if (p.is_cover && !coverPhoto.has(p.deal_id)) coverPhoto.set(p.deal_id, p.url);
    if (!firstPhoto.has(p.deal_id)) firstPhoto.set(p.deal_id, p.url);
    const pub = /^https:\/\//i.test(p.url) && !/\/storage\/v1\/object\/(?:sign|authenticated)\//i.test(p.url);
    if (pub && !firstPublicPhoto.has(p.deal_id)) firstPublicPhoto.set(p.deal_id, p.url);
    if (p.source === 'compr' && pub && !firstComprPhoto.has(p.deal_id)) firstComprPhoto.set(p.deal_id, p.url);
    const list = photosByDeal.get(p.deal_id) ?? [];
    list.push({ url: p.url, source: p.source ?? null, cover: !!p.is_cover, position: p.position ?? null });
    photosByDeal.set(p.deal_id, list);
  }
  const listingByDeal = new Map<number, string>();
  for (const l of links) if (l.slug && !listingByDeal.has(l.deal_id)) listingByDeal.set(l.deal_id, listingUrl(l.slug));
  const latestAmend = new Map<number, DealAmendRow>();
  for (const a of amends) if (!latestAmend.has(a.deal_id)) latestAmend.set(a.deal_id, a);
  return deals.map((m) => {
    const id = Number(m.id.slice(1));
    const a = latestAmend.get(id);
    const listing = listingByDeal.get(id);
    const gallery = canonicalPhotos([...(photosByDeal.get(id) ?? []), { url: m.heroUrl, source: null, cover: true }]);
    const images = gallery.filter(isGalleryImage);
    const loose = gallery.filter((u) => !isGalleryImage(u));
    const photo = [coverPhoto.get(id), m.heroUrl, firstComprPhoto.get(id), firstPublicPhoto.get(id), firstPhoto.get(id)].find(isGalleryImage);
    let next = m;
    if (photo) next = { ...next, photoUrl: photo };
    if (images.length) next = { ...next, photos: images };
    if (loose.length) next = { ...next, sourcePhotos: collectPhotos([...(m.sourcePhotos ?? []), ...loose]) };
    if (listing) next = { ...next, listingUrl: listing, photosUrl: listing + '#photos' };
    return a
      ? { ...next, amended: { field: a.field, from: a.old_value == null ? null : Number(a.old_value), to: a.new_value == null ? null : Number(a.new_value), delta: Number(a.delta), by: a.changed_by, at: a.changed_at } }
      : next;
  });
}

function mapOfferGaps(rows: OfferGapRow[]): OfferGap[] {
  return rows.map((g) => ({
    dealId: did(g.deal_id),
    vendorId: g.vendor_id == null ? null : 'v' + g.vendor_id,
    sellerId: g.seller_id == null ? null : sid(g.seller_id),
    company: g.company || '—',
    contact: g.contact || '—',
    address: g.address || '—',
    stage: g.lead_stage || '—',
    ask: Number(g.asking_price),
    offer: Number(g.offer_amount),
    high: g.uw_high == null ? null : Number(g.uw_high),
    gapToOffer: Number(g.gap_to_offer),
    gapToHigh: g.gap_to_high == null ? null : Number(g.gap_to_high),
    closestGap: Number(g.closest_gap),
    at: g.updated_at,
  }));
}

function mapOfferGapPeople(rows: OfferGapPersonRow[]): OfferGapPerson[] {
  return rows.map((r) => ({
    kind: r.party_kind,
    id: (r.party_kind === 'vendor' ? 'v' : 's') + r.party_id,
    company: r.company || '—',
    contact: r.contact || '—',
    email: r.email || '—',
    phone: r.phone || '—',
    offers: Number(r.offers),
    closeCalls: Number(r.close_calls),
    closestGap: r.closest_gap == null ? null : Number(r.closest_gap),
    closestToOffer: r.closest_gap_to_offer == null ? null : Number(r.closest_gap_to_offer),
    closestToHigh: r.closest_gap_to_high == null ? null : Number(r.closest_gap_to_high),
    declined: Number(r.declined),
    won: Number(r.won),
    lastOfferAt: r.last_offer_at,
  }));
}

/**
 * One seller as the workspace load would map them, with their deals: what a
 * save on that record changed, read in five small indexed queries instead of
 * the ~29 reads of loadWorkspace (lib/use-crm.ts refreshSeller). Null when
 * the seller is gone or unreadable; the caller falls back to a full reload.
 */
export type SellerSlice = { sellerId: number; person: Person | null; deals: Deal[] };
export async function loadSellerSlice(workspaceId: number, sellerId: number): Promise<SellerSlice | null> {
  if (!supabase) return null;
  const w = workspaceId;
  const [sellerQ, dealsQ, taskQ, lastQ, uwQ] = await Promise.all([
    supabase.from('sellers').select(SELLER_COLS + ',archived_at').eq('workspace_id', w).eq('id', sellerId).maybeSingle(),
    supabase.from('deals').select(DEAL_COLS).eq('workspace_id', w).eq('seller_id', sellerId).order('id'),
    supabase.from('tasks').select('id,seller_id,deal_id,buyer_id,title,task_type,priority,due_at,assigned_to,done,notes,completed_at,created_at')
      .eq('workspace_id', w).eq('seller_id', sellerId).eq('done', false)
      .order('due_at', { ascending: true, nullsFirst: false }).order('id').limit(1),
    supabase.from('communications').select('channel,occurred_at')
      .eq('seller_id', sellerId).order('occurred_at', { ascending: false }).limit(1),
    supabase.from('sellers').select('id,underwriter_id').eq('workspace_id', w).eq('id', sellerId).maybeSingle(),
  ]);
  if (sellerQ.error || dealsQ.error) return null;
  const deals = (dealsQ.data ?? []) as unknown as DealRow[];
  let best: DealRow | undefined;
  for (const d of deals) if (!best || dealRank(d) > dealRank(best)) best = d;
  const row = sellerQ.data as unknown as SellerRow | null;
  const last = ((lastQ.data ?? []) as LastComm[])[0] ?? null;
  const task = ((taskQ.data ?? []) as unknown as TaskRow[])[0];
  const uw = (uwQ.data as { underwriter_id?: string | null } | null)?.underwriter_id ?? null;
  return {
    sellerId,
    person: row && !(row as { archived_at?: string | null }).archived_at
      ? { ...mapPerson(row, last, task, best), underwriter: uw }
      : null,
    deals: deals.map((d) => {
      const m = mapDeal(d, Math.floor((minutesAgo(d.updated_at) ?? 0) / (60 * 24)), dealProperty(d.properties));
      return m.heroUrl ? { ...m, photoUrl: m.heroUrl } : m;
    }),
  };
}

/**
 * Several new sellers in two reads per 200 ids (the seller rows, then their
 * deals), for a realtime burst. Null when a read failed. Last touch and the
 * underwriter are left for the next full load: this only puts the lead on
 * the list. A save on one record still uses loadSellerSlice.
 */
export async function loadSellerSlices(workspaceId: number, ids: number[]): Promise<SellerSlice[] | null> {
  if (!supabase) return null;
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!unique.length) return [];
  const w = workspaceId;
  const out: SellerSlice[] = [];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const [sellerQ, dealsQ] = await Promise.all([
      supabase.from('sellers').select(SELLER_COLS + ',archived_at').eq('workspace_id', w).in('id', chunk),
      supabase.from('deals').select(DEAL_COLS).eq('workspace_id', w).in('seller_id', chunk).order('id'),
    ]);
    if (sellerQ.error || dealsQ.error) return null;
    const deals = (dealsQ.data ?? []) as unknown as DealRow[];
    const bySeller = new Map<number, DealRow[]>();
    for (const d of deals) {
      if (d.seller_id == null) continue;
      const list = bySeller.get(d.seller_id) ?? [];
      list.push(d);
      bySeller.set(d.seller_id, list);
    }
    for (const row of (sellerQ.data ?? []) as unknown as (SellerRow & { archived_at?: string | null })[]) {
      const theirs = bySeller.get(row.id) ?? [];
      let best: DealRow | undefined;
      for (const d of theirs) if (!best || dealRank(d) > dealRank(best)) best = d;
      out.push({
        sellerId: row.id,
        person: row.archived_at ? null : mapPerson(row, null, undefined, best),
        deals: theirs.map((d) => {
          const m = mapDeal(d, Math.floor((minutesAgo(d.updated_at) ?? 0) / (60 * 24)), dealProperty(d.properties));
          return m.heroUrl ? { ...m, photoUrl: m.heroUrl } : m;
        }),
      });
    }
  }
  return out;
}

/**
 * The loaded workspace with one seller's slice in place: their person row
 * replaced (or added at the top, for a lead that just arrived), each of their
 * deals replaced field by field. What the slice does not read (photos, the
 * listing, amendments, the underwriter and vendor sellers on a deal) stays as
 * the last full load left it. A deal the slice no longer returns is left
 * alone: a move to another seller is rare and the next full load settles it.
 */
export function mergeSlice<T extends { people: Person[]; deals: Deal[] }>(data: T, slice: SellerSlice): T {
  const pid = sid(slice.sellerId);
  let people = data.people;
  const at = people.findIndex((p) => p.id === pid);
  if (!slice.person) {
    if (at >= 0) people = people.filter((p) => p.id !== pid);
  } else if (at >= 0) {
    people = people.slice();
    people[at] = { ...people[at], ...slice.person };
  } else {
    people = [slice.person, ...people];
  }
  const fresh = new Map(slice.deals.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let deals = data.deals.map((d) => {
    const f = fresh.get(d.id);
    if (!f) return d;
    seen.add(d.id);
    return {
      ...d, ...f,
      // The gallery and the source links were sorted by enrichWorkspace; the slice's are raw.
      ...(d.photos && !f.photos ? { photos: d.photos } : {}),
      ...(d.sourcePhotos ? { sourcePhotos: d.sourcePhotos } : {}),
      ...(d.photoUrl && !f.heroUrl ? { photoUrl: d.photoUrl } : {}),
    };
  });
  const added = slice.deals.filter((d) => !seen.has(d.id));
  if (added.length) deals = [...deals, ...added];
  return { ...data, people, deals };
}

async function loadReportComms(workspaceId: number) {
  const cols = 'id,seller_id,buyer_id,rep_id,from_phone,to_phone,channel,direction,occurred_at,duration_s,status';
  const q = await all(() => supabase!.from('communications').select(cols)
    .eq('workspace_id', workspaceId).order('occurred_at', { ascending: false }).order('id', { ascending: false }), REPORT_COMMS_CAP, BY_OCCURRED);
  if (q.error && /rep_id/.test(q.error.message)) {
    return all(() => supabase!.from('communications')
      .select('id,seller_id,buyer_id,channel,direction,occurred_at,duration_s,status')
      .eq('workspace_id', workspaceId).order('occurred_at', { ascending: false }).order('id', { ascending: false }), REPORT_COMMS_CAP, BY_OCCURRED);
  }
  return q;
}

/**
 * Source photo links onto the deal the Photos button reads.
 * A seller's intake or "Photos:" notes speak only for the deal on their own
 * property, or their only deal — a partner contact holds many houses.
 * An image URL joins the gallery; a folder or listing stays a link.
 */
function attachSourcePhotos(deals: Deal[], people: Person[], links: { deal_id: number; url: string }[]): Deal[] {
  const byDeal = new Map<number, string[]>();
  for (const r of links) {
    if (!r.url) continue;
    const list = byDeal.get(r.deal_id) ?? [];
    list.push(r.url);
    byDeal.set(r.deal_id, list);
  }
  const personOf = new Map(people.map((p) => [p.id, p]));
  const byPerson = new Map<string, Deal[]>();
  for (const d of deals) {
    const list = byPerson.get(d.personId) ?? [];
    list.push(d);
    byPerson.set(d.personId, list);
  }
  return deals.map((d) => {
    const id = Number(d.id.slice(1));
    const extra = [...(byDeal.get(id) ?? [])];
    const person = personOf.get(d.personId);
    const theirs = byPerson.get(d.personId) ?? [];
    const owns = !!person && ((person.property.propertyId && d.propertyId === person.property.propertyId) || theirs.length === 1);
    if (owns && person) {
      const intake = person.intake?.photos;
      if (typeof intake === 'string') extra.push(...urlsIn(intake));
      extra.push(...photosLineUrls(person.notes));
    }
    const all = collectPhotos([...(d.sourcePhotos ?? []), ...extra]);
    if (!all.length && !(d.sourcePhotos ?? []).length) return d;
    const images = all.filter(isGalleryImage);
    const folders = all.filter((u) => !isGalleryImage(u));
    let next = d;
    if (images.length) next = { ...next, photos: collectPhotos([...(d.photos ?? []), ...images]) };
    next = { ...next, sourcePhotos: folders };
    return next;
  });
}

/**
 * One photo per live deal, for the board and the record header: the deal's
 * marked cover, else its first COMPR photo, else its first (migration 226,
 * deal_cover_photos). The old read took the workspace's 5,000 oldest photos,
 * so once there were 136,000 most live deals showed none (8 of 9 with photos),
 * and it timed out sorting them. The gallery loads when a deal opens
 * (loadDealGallery). A database without the function reads the old way.
 */
async function loadCoverPhotos(workspaceId: number): Promise<{ data: DealPhotoRow[] | null; error: { message: string } | null }> {
  // One jsonb array (not rows), so PostgREST's 1,000-row page cannot cut it.
  const rpc = await again(async () => {
    const r = await supabase!.rpc('deal_cover_photos' as never, { p_workspace: workspaceId } as never);
    return { ...r, data: r.error ? null : (Array.isArray(r.data) ? r.data : []) as unknown[] };
  });
  if (!rpc.error) return { data: rpc.data as unknown as DealPhotoRow[], error: null };
  const old = await all(() => supabase!.from('deal_files')
    .select('deal_id,url,source,is_cover,position')
    .eq('workspace_id', workspaceId).eq('kind', 'photo').not('url', 'is', null)
    .order('created_at').order('id'), 5000);
  return { data: (old.data ?? null) as DealPhotoRow[] | null, error: old.error };
}

/** The most photos one deal's gallery reads. */
const GALLERY_CAP = 1000;
/** Every photo on these deals, in upload order, for the gallery of an open deal. Null when the read failed. */
export async function loadDealGallery(dealIds: number[]): Promise<DealPhotoRow[] | null> {
  if (!supabase || !dealIds.length) return [];
  const { data, error } = await supabase.from('deal_files')
    .select('deal_id,url,source,is_cover,position')
    .in('deal_id', dealIds).eq('kind', 'photo').not('url', 'is', null)
    .order('created_at').order('id').limit(GALLERY_CAP * dealIds.length);
  return error ? null : (data ?? []) as DealPhotoRow[];
}

/**
 * A deal with its full gallery: the loaded photos first in their own order,
 * then whatever the deal already showed (its hero, intake and source links).
 */
export function withGallery(d: Deal, rows: DealPhotoRow[]): Deal {
  const mine = rows.filter((r) => did(r.deal_id) === d.id);
  if (!mine.length) return d;
  const gallery = canonicalPhotos([
    ...mine.map((p) => ({ url: p.url, source: p.source ?? null, cover: !!p.is_cover, position: p.position ?? null })),
    { url: d.heroUrl, source: null, cover: true },
  ]).filter(isGalleryImage);
  const photos = collectPhotos([...gallery, ...(d.photos ?? [])]);
  return photos.length ? { ...d, photos, photoUrl: d.photoUrl ?? photos[0] } : d;
}

/**
 * Photos, price amendments, offer gaps, and the reporting history.
 * Called after the shell is on screen. A failed read leaves that slice as the
 * shell already drew it.
 *
 * The five reporting reads (offer gaps, the long communications history, and
 * the deal and offer columns Reporting needs) run only when `opts.reporting`
 * is set. Home keeps the 500-row communications read from the shell. Until
 * Reporting or the leaderboard has loaded them, `partial` stays `loading`.
 */
export async function enrichWorkspace(
  workspaceId: number, data: LiveData, reuse?: LiveData | null, opts?: { reporting?: boolean },
): Promise<LiveData> {
  if (!supabase) return data;
  const w = workspaceId;
  // Offer gaps and the reporting history are the heavy reads and change
  // slowly; `reuse` (the last enriched load) stands in for them between
  // refreshes. Photos, links and price changes follow every write.
  const skip = Promise.resolve({ data: null, error: { message: 'reused' } });
  const heavy = !!opts?.reporting && !reuse;
  const [photoQ, photoLinkQ, linksQ, amendQ, gapsQ, gapPeopleQ, reportDealsQ, reportCommsQ, reportOffersQ] = await Promise.all([
    loadCoverPhotos(w),
    // Source photo links (Podio Photos, a Drive folder, a listing). Separate from
    // the image read so a folder is not crowded out of the 5,000-photo page.
    all(() => supabase!.from('deal_files')
      .select('deal_id,url,category,name')
      .eq('workspace_id', w).eq('kind', 'link').not('url', 'is', null)
      .or('category.eq.photos,name.ilike.photos')
      .order('id'), Number.POSITIVE_INFINITY, BY_ID),
    supabase.from('deal_public_links').select('deal_id, slug').eq('workspace_id', w).eq('active', true),
    all(() => supabase!.from('deal_price_changes')
      .select('deal_id,field,old_value,new_value,delta,changed_by,changed_at')
      .eq('workspace_id', w).order('changed_at', { ascending: false }).order('id', { ascending: false }), 2000,
      [{ col: 'changed_at', asc: false }, { col: 'id', asc: false }]),
    heavy ? all(() => supabase!.from('offer_gaps')
      .select('deal_id,seller_id,vendor_id,company,contact,address,lead_stage,asking_price,offer_amount,uw_high,gap_to_offer,gap_to_high,closest_gap,updated_at')
      .eq('workspace_id', w).order('closest_gap').order('deal_id')) : skip,
    heavy ? all(() => supabase!.from('offer_gap_people')
      .select('party_kind,party_id,company,contact,email,phone,offers,close_calls,closest_gap,closest_gap_to_offer,closest_gap_to_high,declined,won,last_offer_at')
      .eq('workspace_id', w).order('close_calls', { ascending: false }).order('party_id')) : skip,
    heavy ? all(() => supabase!.from('deals')
      .select('id,seller_id,buyer_id,stage,created_at,stage_entered_at,contract_date,close_date,closed_on,marketing_started_on,owner_id,dispo_rep_id,offer_amount,arv,mao,assignment_fee,dispo_fee,sold_price,wholesale_fee,total_cogs,team_commissions_paid,deal_net_profit,final_profit,lead_source,market,marketed_price,coordinator')
      .eq('workspace_id', w).order('id'), Number.POSITIVE_INFINITY, BY_ID) : skip,
    heavy ? loadReportComms(w) : skip,
    heavy ? all(() => supabase!.from('offers')
      .select('id,deal_id,seller_id,buyer_id,direction,amount,status,sent_at,responded_at,created_by')
      .eq('workspace_id', w).order('id'), Number.POSITIVE_INFINITY, BY_ID) : skip,
  ]);
  if (reuse) {
    data = { ...data, offerGaps: reuse.offerGaps, offerGapPeople: reuse.offerGapPeople };
    const was = reuse.reporting.raw;
    if (was && data.reporting.raw) {
      data = { ...data, reporting: { ...data.reporting, raw: { ...data.reporting.raw, deals: was.deals, comms: was.comms, commsCapped: was.commsCapped, offers: was.offers } } };
    }
  }
  const raw = data.reporting.raw;
  const failed = (q: { error: { message: string } | null }) => !!q.error && q.error.message !== 'reused';
  // A reload that did not ask for reporting must not clear `loading`, or Home
  // would show zero offers. A reused load keeps the partial it already had.
  let partial: ReportRaw['partial'] = raw?.partial;
  if (heavy) partial = failed(reportDealsQ) || failed(reportCommsQ) || failed(reportOffersQ) ? 'failed' : undefined;
  else if (reuse?.reporting.raw) partial = reuse.reporting.raw.partial;
  return {
    ...data,
    deals: attachSourcePhotos(
      attachDealMedia(
        data.deals,
        photoQ.error ? [] : (photoQ.data ?? []) as DealPhotoRow[],
        linksQ.error ? [] : (linksQ.data ?? []) as { deal_id: number; slug: string }[],
        amendQ.error ? [] : (amendQ.data ?? []) as DealAmendRow[],
      ),
      data.people,
      photoLinkQ.error ? [] : (photoLinkQ.data ?? []) as { deal_id: number; url: string }[],
    ),
    offerGaps: gapsQ.error ? data.offerGaps : mapOfferGaps((gapsQ.data ?? []) as OfferGapRow[]),
    offerGapPeople: gapPeopleQ.error ? data.offerGapPeople : mapOfferGapPeople((gapPeopleQ.data ?? []) as OfferGapPersonRow[]),
    reporting: raw ? {
      ...data.reporting,
      raw: {
        ...raw,
        deals: reportDealsQ.error ? raw.deals : (reportDealsQ.data ?? []) as unknown as ReportRaw['deals'],
        comms: reportCommsQ.error ? raw.comms : (reportCommsQ.data ?? []) as unknown as ReportRaw['comms'],
        commsCapped: reportCommsQ.error ? raw.commsCapped : (reportCommsQ.data?.length ?? 0) >= REPORT_COMMS_CAP,
        offers: reportOffersQ.error ? raw.offers : (reportOffersQ.data ?? []) as unknown as ReportRaw['offers'],
        partial,
      },
    } : data.reporting,
  };
}

/** Appointments and dated tasks, grouped into the days the calendar renders. */
function buildCalendar(appts: AppointmentRow[], tasks: TaskRow[]): CalendarDay[] {
  const byDay = new Map<string, { t: string; title: string; kind: string }[]>();
  const push = (iso: string, item: { t: string; title: string; kind: string }) => {
    const day = new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  };
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  for (const a of appts) push(a.starts_at, { t: clock(a.starts_at), title: a.title, kind: a.kind });
  for (const t of tasks) {
    if (!t.due_at || t.done) continue;
    push(t.due_at, { t: clock(t.due_at), title: t.title, kind: t.task_type });
  }
  return [...byDay.entries()].map(([day, items]) => ({ day, items }));
}

/**
 * Reporting, from the pipeline rather than from a fixture.
 *
 * Only what the data actually supports. Cost per lead needs ad spend, talk time
 * needs per-call duration attributed to a rep, and month-by-month history needs
 * more than one month of rows — those are absent rather than estimated, because
 * a made-up number on a reporting screen is worse than a blank one.
 */
function buildReporting(
  people: Person[], deals: Deal[], comms: CommRow[], team: Record<string, Rep>,
): LiveData['reporting'] {
  const stage = (name: string) => people.filter((p) => p.stage === name).length;
  const CONTRACT = ['Under Contract', 'Dispo', 'Assigned', 'Closing', 'Closed'];
  const contracted = people.filter((p) => CONTRACT.includes(p.stage)).length;
  const revenue = deals.reduce((a, d) => a + (d.assignment || 0), 0);
  const pct = (n: number) => (people.length ? Math.round((n / people.length) * 100) : 0);

  // Lead sources: share of leads per source, most first. Cost per lead needs
  // ad spend CLOZR does not hold, so it reads as an em-dash.
  const bySource = new Map<string, number>();
  for (const p of people) bySource.set(p.source || 'Unknown', (bySource.get(p.source || 'Unknown') ?? 0) + 1);
  const sources: [string, number, string][] = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => [k, pct(n), '—']);

  // Activity: what actually happened, counted from communications.
  const calls = comms.filter((c) => c.channel === 'call');
  const talkMin = Math.round(calls.reduce((a, c) => a + (c.duration_s ?? 0), 0) / 60);
  const activity: [string, string][] = [
    ['Calls', String(calls.length)],
    ['Talk time', talkMin ? `${Math.floor(talkMin / 60)}h ${talkMin % 60}m` : '0m'],
    ['Texts', String(comms.filter((c) => c.channel === 'sms').length)],
    ['Emails', String(comms.filter((c) => c.channel === 'email').length)],
    ['Voicemails', String(comms.filter((c) => c.channel === 'voicemail').length)],
    ['Notes', String(comms.filter((c) => c.channel === 'note').length)],
  ];

  // Assignment revenue by close month, last twelve months, oldest first — the
  // shape the bar chart reads. Deals with no close date land nowhere.
  const monthly = Array.from({ length: 12 }, () => 0);
  const nowD = new Date();
  for (const d of deals) {
    if (!d.close || !d.assignment) continue;
    const when = Date.parse(d.close + ' ' + nowD.getFullYear());
    if (Number.isNaN(when)) continue;
    const diff = (nowD.getFullYear() - new Date(when).getFullYear()) * 12 + (nowD.getMonth() - new Date(when).getMonth());
    if (diff >= 0 && diff < 12) monthly[11 - diff] += d.assignment;
  }

  // Team: per rep, from what is assigned to them and the deals they own.
  // Per-rep call counts wait on Talkr attributing calls to a rep.
  const leaderboard = Object.values(team).map((r) => {
    const mine = people.filter((p) => p.assigned === r.id);
    const owned = deals.filter((d) => d.owner === r.id);
    const contracts = mine.filter((p) => CONTRACT.includes(p.stage)).length;
    const rev = owned.reduce((a, d) => a + (d.assignment || 0), 0);
    return {
      rep: r.id, calls: 0, talk: '—', contacts: mine.length,
      offers: mine.filter((p) => !!p.offer).length, contracts,
      revenue: rev ? '$' + Math.round(rev).toLocaleString('en-US') : '$0',
      conv: mine.length ? Math.round((contracts / mine.length) * 100) + '%' : '—',
    };
  }).sort((a, b) => b.contracts - a.contracts);

  return {
    kpis: [
      ['Leads', String(people.length), ''],
      ['Contracts', String(contracted), ''],
      ['Closed', String(stage('Closed')), ''],
      ['Assignment revenue', revenue ? '$' + Math.round(revenue).toLocaleString('en-US') : '$0', ''],
    ],
    funnel: [
      ['New Lead', String(stage('New Lead')), pct(stage('New Lead'))],
      ['Contacted', String(stage('Contacted')), pct(stage('Contacted'))],
      ['Qualified', String(stage('Qualified')), pct(stage('Qualified'))],
      ['Offer Sent', String(stage('Offer Sent')), pct(stage('Offer Sent'))],
      ['Under Contract', String(contracted), pct(contracted)],
      ['Closed', String(stage('Closed')), pct(stage('Closed'))],
    ],
    activity,
    leaderboard,
    sources,
    monthly,
  };
}

/** Reverse of the id prefixes above, for turning a screen id back into a row. */
export const dbId = (prefixed: string): number => Number(prefixed.replace(/^[a-z]+/, ''));

export type { LiveData as CrmData };

