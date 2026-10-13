// The database, as the browser client sees it.
//
// Hand-written rather than generated, for one reason worth keeping: a generated
// file would expose `ingest_sources.key_hash` and the Talkr signing secret to
// autocomplete, and the rule here is that neither is ever readable from the
// client. What the client may touch is a deliberate subset, and this file is
// where that decision is written down.
//
// Keep it in step with supabase/migrations/. A column that exists in Postgres
// and not here simply cannot be selected; a column here that does not exist in
// Postgres fails at runtime instead of at build, so add columns in both places.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/**
 * The shape every workspace table shares: identity primary key, workspace
 * scope, and timestamps the database fills in.
 *
 * `Insert` takes the columns that are NOT NULL with no default (named per
 * table) plus anything else optionally; `id` is `never` because it is
 * `generated always as identity` and Postgres rejects a supplied value.
 */
type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, 'id' | Required>> & { id?: never };
  Update: Partial<Omit<Row, 'id'>> & { id?: never };
  Relationships: [];
};

export type Profile = {
  id: string;
  full_name: string | null;
  /** Copied from auth.users at signup, so teammates can see who is who. */
  email: string | null;
  avatar_url: string | null;
  phone: string | null;
  title: string | null;
  /** Floor-show pass alerts. Default on (migration 173). */
  notify_leaderboard: boolean;
  /** Floor-show badge popup, toast, sound, and catch-up. Default on (migration 173). */
  notify_badges: boolean;
  created_at: string;
  updated_at: string;
};

export type Workspace = {
  id: number; name: string; owner_id: string; created_at: string; updated_at: string;
  /** The calendar feed's secret; minted by ensure_calendar_token(). */
  calendar_token: string | null;
  /** Integration settings, admin-only: places_key. */
  settings: Json;
};

export type WorkspaceMember = {
  workspace_id: number; user_id: string; role: string; joined_at: string;
  notary_state?: string | null; notary_commission_expires?: string | null;
  notary_commission_number?: string | null; notary_county?: string | null; notary_stamp_svg?: string | null;
};

export type IngestSource = {
  id: number; workspace_id: number; name: string; label: string | null;
  key_prefix: string; active: boolean; last_used_at: string | null; created_at: string;
};

export type Seller = {
  id: number; workspace_id: number; name: string;
  email: string | null; phone: string | null; phone_key: string | null;
  property_address: string | null; property_id: number | null;
  asking_price: number | null; motivation: string | null; lead_stage: string;
  /** The record's Details card, free text (migration 66). */
  timeline: string | null; condition: string | null; occupancy: string | null;
  mortgage: string | null; desired_close: string | null; decision_makers: string | null;
  notes: string | null; source: string | null; source_id: string | null;
  /** Disposition-form answers with no column of their own (migration 93). */
  intake?: Json;
  created_by: string | null; created_at: string; updated_at: string;
  // Bulk actions on the People list (migration 20).
  assigned_to: string | null; tags: string[]; archived_at: string | null;
  /** Migration 121: who underwrites this lead. */
  underwriter_id?: string | null;
  /** When lead_stage last changed (migration 26). */
  stage_entered_at: string;
  /** Migration 134: what an import brings beyond the core fields. Optional: older databases lack them (lib/import-extras.ts). */
  mailing_line1?: string | null; mailing_city?: string | null; mailing_state?: string | null; mailing_zip?: string | null;
  do_not_mail?: boolean | null; owner2_name?: string | null; other_emails?: string[]; import_extra?: Json;
};

export type Property = {
  id: number; workspace_id: number; address_key: string | null;
  line1: string; city: string | null; state: string | null; zip: string | null;
  apn: string | null; beds: number | null; baths: number | null;
  sqft: number | null; year_built: number | null; property_type: string | null;
  source: string | null; source_id: string | null;
  created_at: string; updated_at: string;
  // Matching inputs (migration 26).
  county: string | null; condition: string | null; attributes: string[]; lot_sqft: number | null;
  lat: number | null; lng: number | null;
  /** Migration 134: what a list says about the house with no column of its own (lib/import-extras.ts FACTS). */
  facts?: Json;
  /** Migration 201: house facts COMPR wrote, left off the next COMPR request; and when COMPR last wrote one. */
  compr_filled?: string[];
  compr_filled_at?: string | null;
};

export type Buyer = {
  id: number; workspace_id: number; name: string; company: string | null;
  email: string | null; phone: string | null; phone_key: string | null;
  markets: string[]; max_purchase_price: number | null; buy_box: string | null;
  status: string; notes: string | null; source: string | null; source_id: string | null;
  created_by: string | null; created_at: string; updated_at: string;
  // The Genius profile (migration 26). `criteria` is the buy box the matcher reads.
  buyer_type: string | null; entity_type: string | null; criteria: Json;
  min_purchase_price: number | null; vetted_at: string | null; vip: boolean; blacklisted_at: string | null;
  preferred_channel: string; wants_calls: boolean; wants_follow_ups: boolean; wants_sold_alerts: boolean;
  pof_url: string | null; pof_verified_at: string | null; website: string | null; tags: string[];
  last_activity_at: string | null;
  /** Migration 54: inactive until this date ("N days from active again" rule). */
  active_again_at: string | null;
  /** Migration 128: the teammate the buyer is assigned to. Optional: older databases lack it. */
  assigned_to?: string | null;
  /** Migration 192: the Genius method that found them, and its proof. Optional: older databases lack it. */
  found_via?: string | null;
  found_evidence?: Json | null;
};

/** Migration 192: an LLC or person on an assignment in the Dispositions Drive, or on a deed a method read. */
export type WholesalerEntityRow = {
  id: number; workspace_id: number; name: string; name_key: string; parent_id: number | null;
  kind: 'wholesaler' | 'buyer' | 'both' | 'title' | 'unknown'; state: string | null; county: string | null;
  contact_name: string | null; email: string | null; phone: string | null; website: string | null;
  source: 'drive' | 'deed' | 'manual' | 'genius' | 'contract'; first_seen: string | null; last_seen: string | null; deals: number;
  buyer_id: number | null; vendor_id: number | null; notes: string | null; meta: Json; created_at: string; updated_at: string;
};
export type WholesalerDealRow = {
  id: number; workspace_id: number; assignor_id: number | null; assignee_id: number | null; assignor_name: string | null; assignee_name: string | null;
  assignee_person: string | null; assignee_email: string | null; assignee_phone: string | null; assignor_person: string | null; assignor_email: string | null; assignor_phone: string | null;
  property_address: string | null; city: string | null; state: string | null; zip: string | null; county: string | null;
  purchase_price: number | null; assignment_fee: number | null; total_price: number | null; contract_date: string | null; closing_date: string | null; title_company: string | null;
  leg: 'AB' | 'BC' | 'AA' | 'deed' | 'unknown'; source: 'drive' | 'deed' | 'manual'; source_id: string; source_url: string | null; deal_id: number | null; raw: Json; created_at: string;
};
export type WholesalerTopBuyerRow = { workspace_id: number; wholesaler_id: number; buyer_id: number; deals: number; last_deal: string | null; volume: number | null; states: string[] | null; counties: string[] | null };
/** Migration 192: a campaign recipe (the channels and the cadence) the one-screen builder offers; workspace_id null is a built-in. */
export type DispoCampaignPresetRow = { id: number; workspace_id: number | null; key: string; name: string; blurb: string; steps: Json; position: number; created_at: string };
export type DispoContractSyncRow = {
  workspace_id: number; account_id: number | null; root_folder_id: string; root_name: string | null; enabled: boolean; state: Json;
  files_seen: number; contracts_read: number; last_run_at: string | null; last_error: string | null; last_notes: Json | null; lock_until: string | null; updated_at: string;
};

/**
 * The buyer-facing page for a deal (migration public_listing_page_rpcs). The
 * slug is random, so the address is only ever in the link and never guessable;
 * `view_count` and `unique_viewers` are maintained by dispo_public_view() on
 * the server, never written from here.
 */
export type DealPublicLink = {
  id: number;
  workspace_id: number;
  deal_id: number;
  slug: string;
  active: boolean;
  show_viewers: boolean;
  show_address: boolean;
  allow_offers: boolean;
  on_marketplace: boolean;
  headline: string | null;
  description: string | null;
  expires_at: string | null;
  view_count: number;
  unique_viewers: number;
  created_at: string;
  updated_at: string;
};

/** A buyer the matcher scored against a deal (migration 26). */
export type DealBuyerMatch = {
  id: number; workspace_id: number; deal_id: number; buyer_id: number;
  score: number; reasons: string[]; status: string;
  sent_at: string | null; viewed_at: string | null; replied_at: string | null;
  created_at: string; updated_at: string;
};

/** A PandaDoc document on a deal, seller or buyer (migration 26). */
export type Contract = {
  id: number; workspace_id: number; deal_id: number | null; seller_id: number | null; buyer_id: number | null;
  kind: string; template_id: string | null; template_name: string | null; pandadoc_id: string | null;
  name: string; status: string; recipients: Json; tokens: Json;
  sent_at: string | null; viewed_at: string | null; completed_at: string | null; last_event: Json | null;
  created_by: string | null; created_at: string; updated_at: string;
  // CLOZR's own engine (migration 27): which engine, the filled body, the PDF in storage.
  provider: 'pandadoc' | 'clozr'; template_key: string | null; body_md: string | null; pdf_path: string | null; sha256: string | null;
  offer_id: number | null; expires_at: string | null; message: string | null;
  needs_notary?: boolean; notary_mode?: 'digital' | 'wet' | 'vendor' | null; notary_status?: string | null; notary_vendor?: string | null; notarized_at?: string | null;
  // AI extraction (migration 116).
  extract_status?: 'running' | 'done' | 'failed' | null; extracted_at?: string | null; extract_error?: string | null;
};
/** A contract template: system rows have workspace_id null; a workspace row with the same key overrides it (migration 27). */
export type DocTemplate = {
  id: number; workspace_id: number | null; key: string; name: string; kind: string; body_md: string;
  signers: { role: string; label: string; party: 'seller' | 'seller2' | 'buyer' | 'company' | string; optional?: boolean }[];
  sort: number; active: boolean; created_by: string | null; created_at: string; updated_at: string;
};
/** One signer on a CLOZR-engine contract. The token never reaches the browser of anyone but the signer. */
export type ContractSigner = {
  id: number; workspace_id: number; contract_id: number; role: string; label: string | null; name: string | null; email: string | null; phone: string | null;
  sort: number; status: 'pending' | 'viewed' | 'signed' | 'declined'; viewed_at: string | null; consented_at: string | null; signed_at: string | null;
  declined_at: string | null; decline_reason: string | null; signature_name: string | null; ip: string | null; created_at: string;
  email_verified_at?: string | null; access_gate?: string | null; view_seconds?: number | null; view_open_at?: string | null;
};
/** An offer: outbound to a seller (ours) or inbound from a buyer on a deal. */
export type Offer = {
  id: number; workspace_id: number; deal_id: number | null; property_id: number | null; buyer_id: number | null; seller_id: number | null;
  direction: 'inbound' | 'outbound'; amount: number | null; status: string; sent_at: string; responded_at: string | null; notes: string | null;
  basis: string | null; expires_on: string | null; contract_id: number | null; terms: Json | null;
  created_by: string | null; created_at: string; updated_at: string;
};
export type ContractEvent = { id: number; workspace_id: number; contract_id: number; event: string; payload: Json | null; created_at: string };
/** A term docs-extract read off a contract's PDF (migration 116). Written only by the function. */
export type ContractExtractionRow = {
  id: number; workspace_id: number; contract_id: number | null; deal_file_id: number | null; deal_id: number | null;
  field_key: string; value: string; confidence: number | null; page: number | null; bbox: Json | null;
  applied_to_deal_at: string | null; applied_by: string | null; dismissed_at: string | null; model: string | null; created_at: string;
};

/** One Genius Mode run: nearby cash buyers found for a deal (migration 26). */
export type DiscoverRun = {
  id: number; workspace_id: number; deal_id: number | null; seller_id: number | null;
  radius_mi: number; months: number; kinds: string[] | null; subject: Json; sales_scanned: number; candidates: Json;
  created_by: string | null; created_at: string;
  /** Migration 83: a saved search — where, with what filters, how it went and what it cost. */
  address: string | null; filters: Json; status: 'running' | 'done' | 'error'; error: string | null;
  properties_scanned: number | null; buyer_count: number | null; top_score: number | null; credits: Json; finished_at: string | null;
};

/** Every number a buyer has, one row each; Genius Mode marks them good or wrong. */
/** Migration 106. */
export type BuyerScoreRow = {
  buyer_id: number; workspace_id: number; response_rate: number | null; score: number | null;
  reason: string | null; source: 'ai' | 'rule'; model: string | null; stats: Json; computed_at: string;
};

/** Migration 110: the brief and facts every channel reads (lib/lead-memory.ts cleans `facts`). */
export type LeadMemoryRow = {
  workspace_id: number; record_kind: 'seller' | 'buyer'; record_id: number; brief: string; facts: Json;
  source_count: number; last_source_at: string | null; model: string | null; updated_at: string;
};

/** Migration 111: one row per voice agent (workspace_id + agent_key). `settings` is the draft, `live_settings` what was last published. voice_agent_secrets has no client access and no type here. */
export type VoiceAgentSettingsRow = {
  workspace_id: number; agent_key: string; role: string; name: string; status: 'draft' | 'live'; enabled: boolean;
  settings: Json; live_settings: Json | null; live_version: number; latest_version: number; agent_id: string | null;
  connected_at: string | null; created_at: string; updated_at: string; updated_by: string | null;
};
export type VoiceAgentVersionRow = {
  workspace_id: number; agent_key: string; version: number; settings: Json; prompt: string; note: string; created_by: string | null; created_at: string;
};
export type VoiceAgentCallRow = {
  workspace_id: number; conversation_id: string; agent_key: string; agent_id: string | null; direction: string | null; occurred_at: string;
  duration_s: number | null; status: string | null; seller_id: number | null; buyer_id: number | null; booked: boolean; transferred: boolean;
  dnc_requested: boolean; not_interested: boolean; outcome: string | null; tools: string[]; created_at: string;
};

/** Migration 106. */
export type BlacklistReasonRow = {
  workspace_id: number; record_kind: 'seller' | 'buyer'; record_id: number; reason: string;
  created_by: string | null; created_at: string;
};

export type BuyerPhoneRow = {
  id: number; workspace_id: number; buyer_id: number; contact_id: number | null; phone: string; position: number | null;
  kind: string | null; source: string | null; is_dnc: boolean | null; is_verified: boolean | null;
  call_count: number | null; message_count: number | null; last_contacted_at: string | null;
  created_at: string; updated_at: string; phone_key: string | null;
};

/** Migration 162: a buyer's other email addresses; buyers.email stays the primary. `email_key` is the lower-cased address. */
export type BuyerEmailRow = {
  id: number; workspace_id: number; buyer_id: number; email: string; email_key: string; position: number;
  kind: string | null; source: string | null; created_at: string; updated_at: string;
};

/** Migration 129: a seller's other numbers; sellers.phone stays the primary. `phone` is E.164, `phone_key` set by trigger. */
export type SellerPhoneRow = {
  id: number; workspace_id: number; seller_id: number; phone: string; phone_key: string | null; position: number;
  kind: string | null; source: string | null; is_dnc: boolean; is_wrong: boolean;
  call_count: number; last_called_at: string | null; created_at: string; updated_at: string;
};

export type Vendor = {
  id: number; workspace_id: number; business_name: string; contact_name: string | null;
  email: string | null; phone: string | null; service_type: string | null;
  markets: string[]; status: string; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
  /** Migration 40: where the vendor came from ('podio' + the Podio reference), so a re-import updates it. */
  source: string | null; source_id: string | null;
  /** Migration 80: where this contact works, and the one to call first for the company there. */
  city: string | null; state: string | null; office_address: string | null; is_main_poc: boolean;
};

/** Migration 40: one person or company on a deal, by role. Points at a CLOZR row when there is one. */
export type DealParty = {
  id: number; workspace_id: number; deal_id: number;
  role: 'seller' | 'buyer' | 'title' | 'photographer' | 'wholesaler' | 'listing_agent' | 'buyers_agent' | 'realtor'
    | 'tc' | 'acquisitions' | 'dispositions' | 'lender' | 'contractor' | 'inspector' | 'attorney' | 'other';
  vendor_id: number | null; buyer_id: number | null; seller_id: number | null; user_id: string | null;
  name: string | null; company: string | null; email: string | null; phone: string | null;
  source: string | null; source_id: string | null; created_at: string; updated_at: string;
  /** Migration 186: where they sit in a daisy chain (OOR, W1–W3), and the TC's point of contact. */
  chain_position?: 'OOR' | 'W1' | 'W2' | 'W3' | null; is_poc?: boolean;
};

export type Communication = {
  id: number; workspace_id: number; property_id: number | null; seller_id: number | null;
  channel: string; direction: string | null; occurred_at: string;
  from_phone: string | null; to_phone: string | null;
  subject: string | null; body: string | null; summary: string | null;
  duration_s: number | null; recording_url: string | null;
  /** Carrier status for a message: queued, sent, delivered, failed. Null where no carrier reports. */
  status: string | null;
  source: string; source_id: string; created_at: string;
  /** Migration 37: email lands on a buyer the way it does on a seller, and keeps who it was between. */
  buyer_id: number | null; vendor_id: number | null; from_email: string | null; to_email: string | null;
  /** The deal a message is about, whoever it was with (Gmail sync: gmail-match.ts, migration 78). */
  deal_id: number | null;
  /** Migration 107: how deal_id was chosen. The Gmail sync re-routes only 'rule' and 'ai' rows. */
  deal_routed_by?: 'rule' | 'ai' | 'manual' | null;
  /** Migration 82: Cc and Bcc on their own line; before it the pull folded Cc into to_email. */
  cc_email?: string | null; bcc_email?: string | null;
  /** Migration 67: what call-sync stored for a Talkr call. recording_url may be `storage:<bucket>/<path>`. */
  recording_id: string | null; transcript: string | null; transcript_status: string | null;
  ai_notes: CallAiNotes | null; call_score: Record<string, unknown> | null; score_overall: number | null;
  /** Migration 89: the coaching scorecard (lib/call-coaching.ts). Null until coached. */
  coaching_review?: Record<string, unknown> | null;
  intel_attempts: number; intel_synced_at: string | null;
  /** Migration 85: the rep who handled it (Talkr user on a call, signed-in rep on a text/email); the leaderboard's attribution. */
  rep_id?: string | null; talkr_user_id?: string | null;
  /** Migration 106: timed transcript (lib/call-media.ts CallSegment[]), stored chapters, and 'ai_agent' for an AI Assistant call. */
  transcript_segments?: unknown; call_sections?: unknown; call_origin?: string | null;
};

/**
 * One member's reading state on one email (migration 73). Not columns on
 * `communications`: read and starred belong to a person, and the member-write
 * policy over there lets any member update any row.
 *
 * None of it reaches Gmail — the connection holds gmail.readonly and
 * gmail.send, not gmail.modify — so this is CLOZR's own state.
 */
export type CommunicationUserState = {
  workspace_id: number; user_id: string; communication_id: number;
  read_at: string | null; starred_at: string | null; archived_at: string | null;
  updated_at: string;
};

/** Which connected mailbox holds a stored message (migration 82): how an admin opens one rep's inbox. */
export type CommunicationMailbox = {
  communication_id: number; account_id: number; workspace_id: number; user_id: string; created_at: string;
};

/** A file on an email (migration 82): in Gmail until someone opens it, then in the deal-files bucket. */
export type EmailAttachment = {
  id: number; workspace_id: number; communication_id: number; part_key: string; filename: string;
  content_type: string | null; byte_size: number | null; account_id: number | null; gmail_message_id: string | null;
  storage_path: string | null; deal_file_id: number | null; created_at: string;
};

/** A tracked send's read receipt (migration 82): opens and clicks, counted by the email-track function. */
export type EmailTracking = {
  token: string; workspace_id: number; communication_id: number | null; user_id: string | null;
  recipients: string | null; subject: string | null; sent_at: string;
  opens: number; first_opened_at: string | null; last_opened_at: string | null;
  clicks: number; last_clicked_at: string | null;
};

/** The watermark that stops a first open being several hundred bold threads (migration 73). */
export type InboxUserPrefs = {
  workspace_id: number; user_id: string;
  email_seen_through: string; updated_at: string;
};

/** A named look at the Deals, People or Buyers table (migration 77). `config` is the screen's own shape. */
export type SavedViewRow = {
  id: number; workspace_id: number; user_id: string;
  screen: 'deals' | 'people' | 'buyers'; name: string;
  config: Record<string, unknown>; shared: boolean;
  created_at: string; updated_at: string;
};

/** One seller or buyer on a rep's own call queue (migration 79). Exactly one of seller_id / buyer_id is set. */
export type CallQueueItemRow = {
  id: number; workspace_id: number; user_id: string;
  seller_id: number | null; buyer_id: number | null;
  position: number; created_at: string;
};

/** The AI notes Talkr writes from a transcript, plus its one-paragraph summary. */
export type CallAiNotes = {
  summary?: string | null; key_points?: string[]; seller_motivation?: string | null; timeline?: string | null;
  asking_price?: string | null; property_condition?: string | null; objections?: string[]; next_step?: string | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'mixed' | null; rep_talk_ratio?: number | null; model?: string | null;
  /** Set instead of the notes when Talkr's transcription failed. */
  error?: string | null;
};

/** Migration 67: where the call-sync job stands, per workspace. */
/** A custom report (migration 69): pages, blocks, theme and date settings live in `definition` (lib/report-store.ts ReportDef). */
export type Report = {
  id: number; workspace_id: number; name: string; owner_id: string | null;
  is_private: boolean; is_template: boolean; created_from: string;
  definition: unknown; created_at: string; updated_at: string;
};
/** A formula over two to four widget specs (lib/report-engine.ts Token[] in `formula`). */
export type CustomMetricRow = {
  id: number; workspace_id: number; name: string; description: string | null;
  display_format: string; formula: unknown; polarity: string;
  created_by: string | null; created_at: string; updated_at: string;
};
/** When a report is emailed (supabase/functions/report-mail). */
export type ReportSchedule = {
  report_id: number; workspace_id: number; frequency: string; at_time: string; tz: string;
  date_preset: string; comparison: string; use_widget_dates: boolean;
  from_email: string | null; subject: string | null; recipients: string[]; message: string | null;
  enabled: boolean; next_run_at: string | null; last_run_at: string | null; last_error: string | null;
  created_by: string | null; updated_at: string;
};
/** Migration 168: one Talkr org bound to one workspace. */
export type TalkrConnection = {
  workspace_id: number;
  talkr_org_id: string;
  enabled: boolean;
  connected_by: string | null;
  connected_at: string;
};

export type CallSyncState = {
  workspace_id: number; last_run_at: string | null; last_ok_at: string | null; last_error: string | null;
  calls_seen: number; intel_done: number; intel_pending: number; configured: boolean;
};

/** Migration 68: one line's last check-up from the number guard. */
export type NumberHealth = {
  workspace_id: number; talkr_number_id: string; phone_e164: string; label: string | null;
  grade: string | null; paused: boolean; spam_risk: string | null; spam_category: string | null;
  attestation_a_7d: number | null; attestation_calls_7d: number | null;
  ten_dlc_assigned: boolean | null; ten_dlc_status: string | null; campaign_approved: boolean | null;
  sms_failure_rate_7d: number | null; warnings: unknown[]; checked_at: string | null; snapshot: unknown; updated_at: string;
};

/** Migration 68: one run of the number guard. */
export type NumberGuardRun = {
  id: number; workspace_id: number; ran_at: string; ok: boolean; numbers: number; issues: number; enforced: number;
  summary: { alerts?: string[]; open?: string[]; enforce_errors?: string[]; digest?: string; notified?: number } | null;
  error: string | null;
};

/** Migration 76: where a workspace's 10DLC filing has got to. */
export type TenDlcRegistration = {
  workspace_id: number;
  status: 'draft' | 'submitting' | 'brand_pending' | 'campaign_pending' | 'assigning' | 'active' | 'failed';
  brand_id: string | null; tcr_brand_id: string | null; brand_status: string | null;
  campaign_id: string | null; tcr_campaign_id: string | null; campaign_status: string | null;
  messaging_profile_id: string | null; assignment_task_id: string | null; assignment_status: string | null;
  last_error: string | null;
  /** Telnyx names the offending fields on a rejection. */
  reasons: Array<{ fields?: string[]; description?: string }>;
  submitted_by: string | null; submitted_at: string | null;
  brand_filed_at: string | null; campaign_filed_at: string | null; active_at: string | null;
  updated_at: string;
};

/** Migration 91: workspace enterprise, branded-calling DIR, and the last registry job. */
export type CallerRegistryState = {
  workspace_id: number;
  enterprise_id: string | null; reputation_status: string | null; loa_status: string | null;
  dir_id: string | null; dir_status: string | null;
  fcr_job_id: string | null; fcr_job_status: string | null;
  last_code: string | null; last_code_at: string | null;
  last_error: string | null; last_run_at: string | null;
  notes: unknown[]; updated_at: string;
};

/** Migration 91: one line's place on Free Caller Registry, reputation and branded calling. */
export type CallerLine = {
  workspace_id: number; phone_e164: string; talkr_number_id: string | null;
  fcr_status: 'queued' | 'submitting' | 'submitted' | 'code_ready' | 'verified' | 'registered' | 'failed';
  reputation_enrolled: boolean; branded_attached: boolean; remediation_open: boolean;
  remediation_id: string | null; spam_risk: string | null; last_error: string | null; updated_at: string;
  /** Migration 135: 'rvm' (ringless drops), 'dialer' (live calls) or neither; set through caller_line_set(). */
  pool?: 'rvm' | 'dialer' | null; market_state?: string | null; daily_cap?: number | null; ramp_started_at?: string | null;
  /** Migration 195: the carrier's spam label and when it was read, and whether CNAM is listed on the carrier. */
  spam_category?: string | null; reputation_checked_at?: string | null; cnam_listed?: boolean;
  /** Migration 197: rotation took the line out of the RVM pool (it keeps its number), and the swap it was part of. */
  retired_at?: string | null; retired_reason?: string | null; replaces?: string | null; replaced_by?: string | null;
};

/** Migration 197: one RVM pool rotation step. Written by the rvm-pool function and the admin RPCs; members read. */
export type RvmPoolEvent = {
  id: number; workspace_id: number; phone_e164: string | null;
  action: 'retired' | 'restored' | 'purchase_requested' | 'purchased' | 'purchase_skipped' | 'purchase_failed' | 'dismissed' | 'policy_changed';
  status: 'open' | 'done' | 'dismissed'; reason: string | null; detail: Json;
  actor: string | null; created_at: string; resolved_at: string | null; resolved_by: string | null;
};

/** Migration 91: one Free Caller Registry email read from AgentMail. */
export type CallerRegistryMail = {
  message_id: string; workspace_id: number; from_addr: string | null; subject: string | null;
  code: string | null; confirm_url: string | null; clicked_at: string | null;
  received_at: string | null; created_at: string;
};

/** Migration 76: one carrier webhook, keyed on Telnyx's own event id. */
export type TenDlcEvent = {
  event_id: string; workspace_id: number | null;
  event_type: string | null; payload_type: string | null; status: string | null;
  occurred_at: string | null; received_at: string; payload: unknown;
};

export type Deal = {
  id: number; workspace_id: number; seller_id: number | null; property_id: number | null;
  stage: string; offer_amount: number | null; arv: number | null; rehab: number | null;
  mao: number | null; wholesale_offer: number | null; institutional_offer: number | null; assignment_fee: number | null;
  contract_date: string | null; close_date: string | null;
  owner_id: string | null; market: string | null;
  source: string | null; source_id: string | null; notes: string | null; podio_item_id?: number | null;
  created_by: string | null; created_at: string; updated_at: string;
  // The Podio deal sheet (migration 19). Acquisition:
  underwriting_url: string | null; compr_report_url?: string | null; condition_notes: string | null; occupancy_notes: string | null;
  option_ends_on: string | null; buyer_option_ends_on: string | null; earnest_money: number | null;
  // Contract terms the templates print (migration 179): {{deal.option_fee}}, {{deal.option_days}}, {{deal.emd_days}}, {{deal.special_terms}}, {{deal.tc_fee}}.
  option_fee?: number | null; option_period_days?: number | null; emd_due_days?: number | null; special_provisions?: string | null; tc_fee?: number | null;
  // Disposition:
  dispo_rep_id: string | null; dispo_rep2_id: string | null; buyer_id: number | null;
  sold_price: number | null; marketing_started_on: string | null;
  // Transaction coordination:
  tc_rep_id: string | null; title_vendor_id: number | null; title_contact: string | null;
  title_email: string | null; title_phone: string | null; closed_on: string | null;
  // Admin / COGS inputs:
  cogs_bonuses: number; cogs_lockbox: number; cogs_photos: number; cogs_lead: number;
  cogs_contractor: number; cogs_earnest_lost: number; cogs_notary: number; cogs_title_fees: number;
  cogs_transactional: number; cogs_realtor: number; lac_pct: number; bac_pct: number;
  cogs_flat_fee: number; cogs_concessions: number; team_commissions_paid: number;
  // Terminated contract:
  terminated: boolean; terminated_on: string | null; termination_reason: string | null;
  earnest_refunded: boolean | null;
  /** When stage last changed (migration 26). */
  stage_entered_at: string;
  // The 2026 Deal Tracker's own columns (migration 45).
  lead_stage: string | null; asking_price: number | null; motivation: string | null; submitted_at: string | null;
  marketing_headline: string | null; marketing_description: string | null; marketing_url: string | null; garage_spaces: number | null;
  hero_image_url: string | null; buyer_report_url: string | null; compr_cma_url: string | null;
  /** The source photo folder or listing (migration 120). */
  photos_url?: string | null; drive_photos_synced_at?: string | null;
  compr_photos_synced_at?: string | null;
  /** When a person set the low / the high offer; null follows COMPR's offer (migration 184). */
  offer_low_set_at?: string | null; offer_high_set_at?: string | null;
  /** Busy or timed-out COMPR sweep tries in a row today (migration 184). */
  compr_sweep_tries?: number;
  tracker_no: number | null; target_assignment: number | null; price_drop: number | null; marketed_price: number | null; marketed_fee: number | null;
  dispo_upsell: number | null; dispo_fee: number | null; transaction_type: string | null; contract_status: string | null;
  lead_source: string | null; acq_agent: string | null; dispo_agent: string | null; lead_manager: string | null; coordinator: string | null;
  /** Migration 239: the lead manager as a member; lead_manager is named from it. */
  lead_manager_id?: string | null;
  /** How the house is entered (lockbox, seller lets in, vacant) and the code or instructions; the Ready To Market gate checks them. */
  property_access?: string | null; access_instructions?: string | null;
  // Generated by Postgres from the inputs above; never written by the client.
  wholesale_fee: number; listing_agent_commission: number; buyers_agent_commission: number;
  total_cogs: number; deal_net_profit: number; final_profit: number;
};

/** The generated columns, which an Insert or Update must not carry. */
export type DealGenerated =
  | 'wholesale_fee' | 'listing_agent_commission' | 'buyers_agent_commission'
  | 'total_cogs' | 'deal_net_profit' | 'final_profit';

/** A file or link on a deal (migration 45). */
export type DealFileRow = {
  id: number; workspace_id: number; deal_id: number; kind: 'file' | 'photo' | 'link'; name: string;
  url: string | null; storage_path: string | null; content_type: string | null; byte_size: number | null;
  source: string | null; created_by: string | null; created_at: string;
  visible_to_buyers: boolean; caption: string | null; is_cover: boolean; position: number;
  /** What the document is (title_commitment, closing_disclosure, …) — or a listing photo category. */
  category: string | null;
  /** Migration 80: the email it was pulled off, and its Gmail attachment key (dedupe). */
  communication_id: number | null; source_id: string | null;
  needs_notary?: boolean; notary_mode?: string | null; notary_status?: string | null; contract_id?: number | null;
};

/** An iVueit photo order on a deal (migration 255). Written only by the ivueit function. */
export type PhotoOrderRow = {
  id: number; workspace_id: number; deal_id: number; provider: 'ivueit'; vue_id: string | null;
  status: 'ordered' | 'completed' | 'canceled' | 'failed';
  address: string | null; template_id: string | null; notes: string | null; urgent: boolean;
  submission_id: string | null; photo_count: number; cost: number | null; error: string | null;
  ordered_by: string | null; created_at: string; checked_at: string | null; completed_at: string | null;
};

/** COMPR's public record for a property, written by compr-underwrite (migration 57). Missing is null. */
export type PropertyRecordRow = {
  id: number; workspace_id: number; property_id: number; source: string;
  owner_name: string | null;
  owner_mailing: { line1: string | null; city: string | null; state: string | null; zip: string | null } | null;
  absentee: boolean | null;
  mortgages: { lender: string | null; amount: number | null; balance: number | null; date: string | null; type: string | null; rate_pct: number | null; term_months: number | null }[] | null;
  est_equity: number | null; ltv: number | null; assessed_value: number | null; tax_amount: number | null;
  last_sale: { price: number | null; date: string | null; prior_price: number | null; prior_date: string | null } | null;
  events: { type: string; date: string | null; detail: Record<string, Json | undefined> }[] | null;
  permits: { count: number; last_date: string | null; total_job_value: number | null; tags: Json } | null;
  rent_estimate: number | null; raw: Json | null; fetched_at: string;
};

/** What Lane took from a file's calls, texts, emails and tasks (migration 80). Written by lane-listen; members decide. */
export type LaneUpdateRow = {
  id: number; workspace_id: number; transaction_id: number; deal_id: number | null; seller_id: number | null;
  kind: 'tick' | 'date' | 'task_add' | 'task_done' | 'party' | 'note';
  payload: Json; summary: string; evidence: string | null; confidence: 'high' | 'medium' | 'low';
  source_comm_ids: number[]; status: 'pending' | 'applied' | 'dismissed' | 'undone';
  decided_by: string | null; decided_at: string | null; created_at: string;
};

/** An amended price on a deal, written by the database (migration 48). */
export type DealPriceChangeRow = {
  id: number; workspace_id: number; deal_id: number; field: string;
  old_value: number | null; new_value: number | null; delta: number; changed_by: string | null; changed_at: string;
};

export type TaskRow = {
  id: number; workspace_id: number; seller_id: number | null; deal_id: number | null;
  title: string; task_type: string; priority: string;
  due_at: string | null; assigned_to: string | null;
  done: boolean; completed_at: string | null;
  created_by: string | null; created_at: string; updated_at: string;
  // An action plan's step, queued as work (migration 31).
  /** What to say or send, merge fields already filled in. */
  notes: string | null;
  enrollment_id: number | null;
  plan_step_id: number | null;
};

/** Someone invited to an appointment, and what they said. Google emails the invitation when the event is pushed. */
export type Attendee = {
  email: string; name?: string | null;
  role?: 'seller' | 'buyer' | 'vendor' | 'rep' | 'other';
  status?: 'needsAction' | 'accepted' | 'declined' | 'tentative';
};

export type Appointment = {
  id: number; workspace_id: number; seller_id: number | null;
  property_id: number | null; buyer_id: number | null;
  title: string; kind: string; starts_at: string; ends_at: string | null;
  location: string | null; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
  // Two-way Google sync (migration 35). One Google event per row, on the
  // calendar of assigned_to (else created_by). Any edit flips sync_state back
  // to pending by trigger; the sync stamps last_synced_at when it is level.
  assigned_to: string | null;
  attendees: Attendee[];
  all_day: boolean;
  source: 'clozr' | 'google';
  google_event_id: string | null; google_calendar_id: string | null;
  google_etag: string | null; google_updated_at: string | null;
  sync_state: 'pending' | 'synced' | 'error'; sync_error: string | null;
  last_synced_at: string | null; invites_requested_at: string | null;
  /** Soft delete: hidden at once, purged after the Google event is gone. */
  deleted_at: string | null;
};

export type NotificationRow = {
  id: number; workspace_id: number; user_id: string | null;
  category: string; title: string; body: string | null;
  seller_id: number | null; deal_id: number | null;
  read_at: string | null; created_at: string;
  buyer_id?: number | null;
  /** The other side's number on a text notification (migration 152). */
  phone_key?: string | null;
};

export type OfferRow = {
  id: number; workspace_id: number; deal_id: number | null;
  property_id: number | null; buyer_id: number | null;
  direction: string; amount: number | null; status: string;
  sent_at: string; responded_at: string | null; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
  // Outbound offers to sellers (migration 27).
  seller_id: number | null; basis: string | null; expires_on: string | null; contract_id: number | null; terms: Json | null;
};

export type TransactionRow = {
  id: number; workspace_id: number; deal_id: number | null; property_id: number | null;
  seller_id: number | null; buyer_id: number | null;
  title_company: string | null; escrow_officer: string | null;
  emd_amount: number | null; emd_received_at: string | null;
  option_ends_on: string | null; close_date: string | null; status: string;
  created_by: string | null; created_at: string; updated_at: string;
  // The TC file (migration 36): the checklist track, D0, the ticks, the T-2 gate.
  deal_type: 'assignment' | 'novation'; contract_date: string | null; ctc_target: string | null;
  checklist: Record<string, boolean>; hud: Record<string, boolean>;
  tc_review: string | null; signoff: string | null;
  buyer_financing: string | null; lender: string | null; structure: string | null;
  title_email: string | null; title_phone: string | null;
};

export type TransactionItem = {
  id: number; workspace_id: number; transaction_id: number; position: number;
  label: string; owner_role: string | null; due_date: string | null;
  done: boolean; completed_at: string | null; blocker: string | null;
  created_at: string; updated_at: string;
};

export type ActionPlanRow = {
  id: number; workspace_id: number; name: string;
  trigger_event: string | null; active: boolean;
  created_by: string | null; created_at: string; updated_at: string;
  /** Migration 34: the builder's fields. */
  description: string | null;
  /** manual | stage | tag | new_lead | form */
  trigger_type: string;
  /** The stage name or tag a stage/tag trigger fires on. */
  trigger_value: string | null;
  /** Smart stop, business hours, tone — see lib/plans.ts PlanSettings. */
  settings: Json;
  on_end_next_plan_id: number | null;
  /** Migration 142: where a lead goes when the plan ends — lib/plans.ts OnComplete. Optional: older databases lack it. */
  on_complete?: Json;
};

export type ActionPlanStep = {
  id: number; workspace_id: number; plan_id: number; position: number;
  /** sms | email | call | task | wait | stage | tag | assign | compr_report | rvm */
  channel: string;
  /** Hours since enrolment (cumulative); kept for the older readers. */
  delay_hours: number;
  /** Minutes since the previous step (migration 34). */
  delay_minutes: number;
  title: string | null; body: string | null;
  subject: string | null;
  /** priority / assignee / stage / tag — see lib/plans.ts StepConfig. */
  config: Json;
  created_at: string;
};

export type VmLibraryRow = {
  id: number; workspace_id: number; name: string; script: string;
  audio_path: string | null; seconds: number | null;
  variant_group: string; audience: string; active: boolean;
  created_by: string | null; created_at: string;
};

export type RvmDropRow = {
  id: number; workspace_id: number; seller_id: number | null; buyer_id: number | null;
  phone_e164: string | null; library_id: number | null; script: string | null;
  variant_group: string;
  status: 'queued' | 'sending' | 'ready' | 'dialing' | 'dropped' | 'skipped' | 'answered' | 'failed';
  skip_reason: string | null; last_error: string | null;
  scheduled_at: string; sent_at: string | null;
  enrollment_id: number | null; plan_step_id: number | null;
  /** dropcowboy | slybroadcast | telnyx. Null until a network accepts the job. */
  provider: string | null;
  /** The caller ID this drop went out on, so the next one can use a different line. */
  from_e164: string | null;
  provider_call_id: string | null; webhook_token: string | null;
  created_by: string | null; created_at: string;
  /** Migration 135: one bulk send, a side-effect note (Talkr outreach), and the callback credited to this drop. */
  blast_id?: string | null; notes?: string | null;
  callback_at?: string | null; callback_channel?: string | null; callback_comm_id?: number | null;
  /** Migration 194: the deal the send was about; a callback is filed on it. */
  deal_id?: number | null;
  /** Migration 198: how local the caller ID was: area_code, state, phone_state, neighbor or any. */
  pool_tier?: string | null;
};

export type EnrollmentRow = {
  id: number; workspace_id: number; plan_id: number; seller_id: number | null;
  status: string; step_index: number;
  enrolled_at: string; completed_at: string | null; created_by: string | null;
  /** reply | call | stage | manual when a smart stop ended it; null when it ran out. */
  stopped_reason: string | null;
  /** Migration 142: where the lead went when this run ended, and why. Optional: older databases lack them. */
  routed_enrollment_id?: number | null; routed_plan_id?: number | null; routed_reason?: string | null;
  routed_at?: string | null; route_state?: 'pending' | 'done' | null;
};

/** Migration 142: one decide-once AI step on one lead — what the model chose, why, and what happened. Function-written. */
export type PlanAgentRunRow = {
  id: number; workspace_id: number; enrollment_id: number | null; task_id: number | null; plan_step_id: number | null; seller_id: number | null;
  status: 'running' | 'done' | 'skipped' | 'failed'; goal: string; allowed: string[];
  decision: Json; reason: string | null; actions: Json; claimed_at: string; finished_at: string | null; created_at: string;
};

/** Migration 143: a deal's outcome as sent to Compr's calibration intake, once per (underwrite, outcome). Function-written. */
export type ComprOutcomeRow = {
  id: number; workspace_id: number; underwrite_id: number; deal_id: number | null;
  outcome: 'purchase_close' | 'disposition_close' | 'terminated'; lead_id: string; payload: Json;
  status: 'sent' | 'failed'; http_status: number | null; error: string | null; attempts: number;
  sent_at: string | null; created_at: string; updated_at: string;
};

export type WorkspaceInvite = {
  id: number; workspace_id: number; email: string; role: string;
  full_name: string | null; invited_by: string | null;
  accepted_at: string | null; created_at: string;
};

/** workspace_members joined to profiles: the roster the Team panel lists. */
export type RosterRow = {
  workspace_id: number; user_id: string; role: string; joined_at: string;
  full_name: string | null; title: string | null; avatar_url: string | null; email: string | null;
};

/** Migration 37: a CLOZR-owned SMS or email template. `blocks` is the email editor's source; body_html is generated from it. */
export type MessageTemplateRow = {
  id: number; workspace_id: number; owner_id: string; shared: boolean;
  name: string; channel: 'sms' | 'email'; audience: 'seller' | 'buyer' | 'tc' | 'general';
  category: string | null; subject: string | null;
  body_text: string; body_html: string | null; blocks: unknown[] | null; merge_fields: string[];
  created_at: string; updated_at: string; archived_at: string | null;
};

export type ActivityRow = {
  id: number; workspace_id: number;
  entity_type: string; entity_id: number;
  kind: string; title: string; body: string | null;
  actor_id: string | null; occurred_at: string; created_at: string;
};

/**
 * A member's connected Google account, as the browser is allowed to see it —
 * the tokens are in `google_tokens`, which has RLS on, no policy, and no grant.
 * Rows appear and disappear through the `google-oauth` function, because both
 * ends of that also have to talk to Google, so Insert and Delete are not here.
 */
export type GoogleAccountRow = {
  id: number; workspace_id: number; user_id: string; email: string;
  /** Exactly what Google granted — consent is granular, so features follow this. */
  scopes: string[];
  calendar_id: string | null;
  calendar_sync: boolean; gmail_send: boolean; gmail_read: boolean;
  status: 'active' | 'needs_reauth' | 'revoked';
  last_calendar_sync_at: string | null; last_gmail_sync_at: string | null; last_error: string | null;
  connected_at: string; updated_at: string;
};

/** Migration 38: a Brex account, owner/admin only. The token is in bank_connections, which the browser cannot read. */
export type BankAccountRow = {
  id: number; workspace_id: number; provider: string; external_id: string; kind: 'cash' | 'card';
  name: string | null; current_balance_cents: number | null; available_balance_cents: number | null;
  currency: string; is_primary: boolean; raw: Json; synced_at: string;
};
/** Migration 38: one bank transaction; amount_cents is signed, positive = money in. deal_id is set by tag_bank_transaction. */
export type BankTransactionRow = {
  id: number; workspace_id: number; provider: string; external_id: string; account_id: number | null;
  posted_at: string; amount_cents: number; currency: string; description: string | null;
  counterparty: string | null; category: string | null; deal_id: number | null; raw: Json; synced_at: string;
};

/** Migration 41: an outbound webhook. */
export type WebhookSubscriptionRow = {
  id: number; workspace_id: number; url: string; events: string[]; active: boolean; description: string | null;
  created_by: string | null; created_at: string; last_status: string | null; last_error: string | null; last_delivered_at: string | null;
};
export type WebhookDeliveryRow = {
  id: number; workspace_id: number; subscription_id: number; event: string; payload: Json;
  status: 'pending' | 'sending' | 'retrying' | 'delivered' | 'failed'; attempts: number; request_id: number | null;
  response_code: number | null; error: string | null; next_attempt_at: string | null; last_attempt_at: string | null;
  created_at: string; delivered_at: string | null;
};

/** Migration 53: a dispo campaign, its buyers and every queued message. */
export type DispoCampaignRow = {
  id: number; workspace_id: number; deal_id: number; created_by: string | null;
  status: 'running' | 'paused' | 'done' | 'cancelled'; settings: Json; timezone: string;
  from_phone_number_id: string | null; from_phone: string | null; email_account_id: number | null; from_name: string | null;
  email_provider: 'resend' | 'gmail'; email_sender_id: number | null;
  starts_at: string; created_at: string; updated_at: string;
};
export type EmailSenderRow = {
  id: number; workspace_id: number; provider: 'resend'; from_email: string; from_name: string | null; reply_to: string | null; user_id: string | null; domain: string; active: boolean;
  daily_cap: number; hourly_cap: number; min_gap_seconds: number; window_start: number; window_end: number; window_days: number[];
  timezone: string; ramp_enabled: boolean; ramp_start: number; ramp_increase_pct: number; ramp_target: number; ramp_started_on: string;
  paused: boolean; paused_reason: string | null; paused_at: string | null; paused_auto: boolean;
  created_at: string; updated_at: string;
};
export type DispoRecipientRow = {
  id: number; workspace_id: number; campaign_id: number; deal_id: number; buyer_id: number;
  phone: string | null; email: string | null; level: number | null; probability: number | null;
  status: 'active' | 'replied' | 'interested' | 'not_interested' | 'offered' | 'opted_out' | 'stopped' | 'done';
  talkr_conversation_id: string | null; replied_at: string | null; replied_channel: string | null; offered_at: string | null;
  checked_at: string | null; created_at: string; updated_at: string;
};
export type DispoMessageRow = {
  id: number; workspace_id: number; campaign_id: number; recipient_id: number; buyer_id: number;
  channel: 'sms' | 'email' | 'rvm' | 'ai_call'; kind: 'intro' | 'brief' | 'followup'; seq: number;
  subject: string | null; body: string; body_html: string | null; media_urls: string[];
  send_at: string; only_if_no_reply: boolean;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'skipped' | 'cancelled';
  attempts: number; last_error: string | null; sent_at: string | null; provider_id: string | null; communication_id: number | null;
  created_at: string; updated_at: string;
};
/** Migration 54: one buyer trigger-event rule per workspace. */
export type BuyerAutomationRuleRow = {
  id: number; workspace_id: number;
  rule: 'no_response' | 'not_interested' | 'not_sent' | 'active_again' | 'no_status' | 'lowball';
  enabled: boolean; n: number; pct: number; tag: string; remove_when_false: boolean;
  last_run_at: string | null; created_at: string; updated_at: string;
};

/**
 * Migration 70: one row per deal we offered on. `gap_to_offer` measures the ask
 * against the number we actually sent, `gap_to_high` against our underwriting
 * ceiling; `closest_gap` is the smaller absolute of the two.
 */
export type OfferGapRow = {
  deal_id: number; workspace_id: number; lead_stage: string | null; stage: string | null;
  market: string | null; seller_id: number | null; vendor_id: number | null;
  company: string | null; contact: string | null; email: string | null; phone: string | null;
  address: string | null; city: string | null; state: string | null;
  asking_price: number; offer_amount: number; uw_high: number | null;
  gap_to_offer: number; gap_to_high: number | null; closest_gap: number;
  submitted_at: string | null; updated_at: string | null;
};
/** Migration 70: offer_gaps rolled up to the person to call back. */
export type OfferGapPersonRow = {
  party_kind: 'vendor' | 'seller'; party_id: number; workspace_id: number;
  company: string | null; contact: string | null; email: string | null; phone: string | null;
  offers: number; close_calls: number;
  closest_gap: number | null; closest_gap_to_offer: number | null; closest_gap_to_high: number | null;
  declined: number; won: number; terminated: number; last_offer_at: string | null;
};

/** Migration 121: one rotation — an acquisitions lead rotation or a dispositions deal-type rotation. */
export type RoundRobinRow = {
  id: number; workspace_id: number; name: string;
  team: 'acquisitions' | 'dispositions';
  /** Dispositions only: the deal type it deals out ('any' for every type). */
  deal_type: 'novation' | 'assignment' | 'jv' | 'double_close' | 'any' | null;
  /** Acquisitions only: 'same' also makes the rep the lead's underwriter. */
  underwriter: 'none' | 'same';
  active: boolean; created_by: string | null; created_at: string; updated_at: string;
};
/** Migration 149: one AI roleplay practice session. Written only by the sales-manager function. */
export type RoleplaySessionDbRow = {
  id: number; workspace_id: number; user_id: string; persona: string; difficulty: string; objection: string | null;
  mode: string; status: string; conversation_id: string | null; transcript: Json; feedback: Json | null; score: number | null;
  stage_hit_rate: number | null; duration_s: number | null; started_at: string; ended_at: string | null; updated_at: string;
};

/** Migration 149: a call from outside CLOZR submitted for review. Written only by the sales-manager function. */
export type CallReviewSubmissionRow = {
  id: number; workspace_id: number; user_id: string; rep_id: string | null; call_type: string; title: string | null; source: string;
  file_path: string | null; transcript: string | null; transcript_segments: Json | null; duration_s: number | null; status: string;
  error: string | null; review: Json | null; score: number | null; created_at: string; updated_at: string;
};

/** Migration 149: the AI Sales Manager's per-workspace settings. */
export type SalesCoachSettingsRow = {
  workspace_id: number; roleplay_agent_id: string | null; roleplay_phone: string | null; weekly_email: boolean; weekly_recipients: string[]; weekly_at: string; weekly_tz: string;
  next_weekly_at: string | null; last_weekly_at: string | null; last_weekly_error: string | null; updated_at: string;
};

export type RoundRobinMemberRow = {
  round_robin_id: number; user_id: string; workspace_id: number;
  /** False takes the rep out of the rotation without removing them. */
  active: boolean; last_assigned_at: string | null; assigned_count: number; added_at: string;
};

export type Database = {
  public: {
    Tables: {
      // Reads go through the view; the table itself holds key_hash and the
      // signing secret, and SELECT on it is revoked from `authenticated`.
      ingest_sources_public: {
        Row: IngestSource & { has_signing_secret: boolean; creates: 'seller' | 'wholesaler' | 'buyer'; auto_compr: 'on' | 'off'; has_api_key: boolean; round_robin: string; sync_form: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ingest_sources: {
        Row: IngestSource;
        // Keys are minted by issue_ingest_key() and the secret is written by
        // set_ingest_secret(), so the only client write is enable/disable.
        Insert: never;
        Update: { active?: boolean; label?: string | null };
        Relationships: [];
      };
      profiles: {
        Row: Profile;
        Insert: { id: string } & Partial<Omit<Profile, 'id'>>;
        Update: Partial<Omit<Profile, 'id'>> & { id?: never };
        Relationships: [];
      };
      workspaces: Table<Workspace, 'name' | 'owner_id'>;
      call_sync_state: Table<CallSyncState, 'workspace_id'>;
      talkr_connections: {
        Row: TalkrConnection;
        Insert: { workspace_id: number; talkr_org_id: string; enabled?: boolean; connected_by?: string | null; connected_at?: string };
        Update: { talkr_org_id?: string; enabled?: boolean; connected_by?: string | null };
        Relationships: [];
      };
      communication_user_state: Table<CommunicationUserState, 'workspace_id' | 'user_id' | 'communication_id'>;
      inbox_user_prefs: Table<InboxUserPrefs, 'workspace_id' | 'user_id'>;
      communication_mailboxes: Table<CommunicationMailbox, 'communication_id' | 'account_id' | 'workspace_id' | 'user_id'>;
      email_attachments: Table<EmailAttachment, 'workspace_id' | 'communication_id' | 'part_key' | 'filename'>;
      email_tracking: Table<EmailTracking, 'token' | 'workspace_id'>;
      saved_views: Table<SavedViewRow, 'workspace_id' | 'screen' | 'name'>;
      call_queue_items: Table<CallQueueItemRow, 'workspace_id'>;
      reports: Table<Report, 'workspace_id' | 'name'>;
      custom_metrics: Table<CustomMetricRow, 'workspace_id' | 'name'>;
      report_schedules: Table<ReportSchedule, 'report_id' | 'workspace_id'>;
      number_health: Table<NumberHealth, 'workspace_id' | 'talkr_number_id' | 'phone_e164'>;
      number_guard_runs: Table<NumberGuardRun, 'workspace_id' | 'ok'>;
      ten_dlc_registrations: Table<TenDlcRegistration, 'workspace_id'>;
      ten_dlc_events: Table<TenDlcEvent, 'event_id'>;
      caller_registry_state: Table<CallerRegistryState, 'workspace_id'>;
      caller_lines: Table<CallerLine, 'workspace_id' | 'phone_e164'>;
      rvm_pool_events: { Row: RvmPoolEvent; Insert: never; Update: never; Relationships: [] };
      caller_registry_mail: Table<CallerRegistryMail, 'message_id' | 'workspace_id'>;
      workspace_members: {
        Row: WorkspaceMember;
        Insert: { workspace_id: number; user_id: string; role?: string; joined_at?: string };
        Update: {
          role?: string;
          notary_state?: string | null; notary_commission_expires?: string | null;
          notary_commission_number?: string | null; notary_county?: string | null; notary_stamp_svg?: string | null;
        };
        Relationships: [];
      };

      sellers: Table<Seller, 'workspace_id' | 'name'>;
      properties: Table<Property, 'workspace_id' | 'line1'>;
      buyers: Table<Buyer, 'workspace_id' | 'name'>;
      vendors: Table<Vendor, 'workspace_id' | 'business_name'>;
      communications: Table<Communication, 'workspace_id' | 'channel' | 'source' | 'source_id'>;

      deals: {
        Row: Deal;
        Insert: Pick<Deal, 'workspace_id'> & Partial<Omit<Deal, 'id' | 'workspace_id' | DealGenerated>> & { id?: never };
        Update: Partial<Omit<Deal, 'id' | DealGenerated>> & { id?: never };
        Relationships: [];
      };
      tasks: Table<TaskRow, 'workspace_id' | 'title'>;
      deal_files: Table<DealFileRow, 'workspace_id' | 'deal_id' | 'name'>;
      photo_orders: Table<PhotoOrderRow, 'workspace_id' | 'deal_id'>;
      deal_price_changes: { Row: DealPriceChangeRow; Insert: never; Update: never; Relationships: [] };
      lane_updates: { Row: LaneUpdateRow; Insert: never; Update: Partial<Pick<LaneUpdateRow, 'status' | 'decided_by' | 'decided_at'>>; Relationships: [] };
      property_records: { Row: PropertyRecordRow; Insert: never; Update: never; Relationships: [] };
      appointments: Table<Appointment, 'workspace_id' | 'title' | 'starts_at'>;
      notifications: Table<NotificationRow, 'workspace_id' | 'title'>;
      offers: Table<OfferRow, 'workspace_id'>;
      transactions: Table<TransactionRow, 'workspace_id'>;
      transaction_items: Table<TransactionItem, 'workspace_id' | 'transaction_id' | 'label'>;
      action_plans: Table<ActionPlanRow, 'workspace_id' | 'name'>;
      action_plan_steps: Table<ActionPlanStep, 'workspace_id' | 'plan_id'>;
      vm_library: Table<VmLibraryRow, 'workspace_id' | 'name'>;
      rvm_drops: Table<RvmDropRow, 'workspace_id'>;
      enrollments: Table<EnrollmentRow, 'workspace_id' | 'plan_id'>;
      message_templates: Table<MessageTemplateRow, 'workspace_id' | 'name' | 'channel'>;
      activity: Table<ActivityRow, 'workspace_id' | 'entity_type' | 'entity_id' | 'kind' | 'title'>;
      workspace_invites: Table<WorkspaceInvite, 'workspace_id' | 'email' | 'role'>;
      deal_buyer_matches: Table<DealBuyerMatch, 'workspace_id' | 'deal_id' | 'buyer_id'>;
      // Rows are created by deal_public_link_ensure(); the client only ever
      // flips what the page shows, never the slug or the view counters.
      deal_public_links: {
        Row: DealPublicLink;
        Insert: never;
        Update: Partial<Pick<DealPublicLink, 'active' | 'show_viewers' | 'show_address' | 'allow_offers' | 'on_marketplace' | 'headline' | 'description' | 'expires_at'>>;
        Relationships: [];
      };
      contracts: Table<Contract, 'workspace_id' | 'name'>;
      contract_signers: { Row: ContractSigner; Insert: never; Update: never; Relationships: [] };
      doc_templates: Table<DocTemplate, 'key' | 'name' | 'body_md'>;
      contract_events: { Row: ContractEvent; Insert: never; Update: never; Relationships: [] };
      contract_extractions: { Row: ContractExtractionRow; Insert: never; Update: never; Relationships: [] };
      discover_runs: Table<DiscoverRun, 'workspace_id' | 'radius_mi' | 'months'>;
      buyer_phones: Table<BuyerPhoneRow, 'workspace_id' | 'buyer_id' | 'phone'>;
      buyer_emails: Table<BuyerEmailRow, 'workspace_id' | 'buyer_id' | 'email' | 'email_key'>;
      /** Migration 192: the wholesaler database. */
      wholesaler_entities: Table<WholesalerEntityRow, 'workspace_id' | 'name' | 'name_key'>;
      wholesaler_deals: Table<WholesalerDealRow, 'workspace_id' | 'source_id'>;
      dispo_campaign_presets: Table<DispoCampaignPresetRow, 'key' | 'name'>;
      dispo_contract_sync: { Row: DispoContractSyncRow; Insert: never; Update: never; Relationships: [] };
      seller_phones: Table<SellerPhoneRow, 'workspace_id' | 'seller_id' | 'phone'>;
      /** Migration 83: skip traces, 90 days per owner; `provider` (183) says who answered. Written by genius-discover only. */
      genius_skip_cache: {
        Row: { id: number; workspace_id: number; owner_key: string; owner_name: string | null; hits: Json; provider: string | null; fetched_at: string; fetched_by: string | null };
        Insert: never; Update: never; Relationships: [];
      };
      /** Migration 106: the buyer-score function's cache. Read only from the app. */
      buyer_scores: { Row: BuyerScoreRow; Insert: never; Update: never; Relationships: [] };
      /** Migration 110: written only by the lead-memory function. */
      lead_memory: { Row: LeadMemoryRow; Insert: never; Update: never; Relationships: [] };
      plan_agent_runs: { Row: PlanAgentRunRow; Insert: never; Update: never; Relationships: [] };
      compr_outcomes: { Row: ComprOutcomeRow; Insert: never; Update: never; Relationships: [] };
      /** Migration 111: written only by the voice-agent-admin function and /post-call. */
      voice_agent_settings: { Row: VoiceAgentSettingsRow; Insert: never; Update: never; Relationships: [] };
      voice_agent_versions: { Row: VoiceAgentVersionRow; Insert: never; Update: never; Relationships: [] };
      voice_agent_calls: { Row: VoiceAgentCallRow; Insert: never; Update: never; Relationships: [] };
      /** Migration 106: why a record is on the secret blacklist. */
      blacklist_reasons: Table<BlacklistReasonRow, 'workspace_id' | 'record_kind' | 'record_id' | 'reason'>;
      google_accounts: {
        Row: GoogleAccountRow;
        Insert: never;
        Update: Partial<Pick<GoogleAccountRow, 'calendar_sync' | 'gmail_send' | 'gmail_read'>>;
        Relationships: [];
      };
      deal_parties: Table<DealParty, 'workspace_id' | 'deal_id' | 'role'>;
      bank_accounts: { Row: BankAccountRow; Insert: never; Update: never; Relationships: [] };
      bank_transactions: { Row: BankTransactionRow; Insert: never; Update: never; Relationships: [] };
      seller_stages: { Row: { label: string; sort: number; grp: string; deal_stage: string | null }; Insert: never; Update: never; Relationships: [] };
      deal_stages: { Row: { label: string; sort: number; active_inventory: boolean; hidden: boolean }; Insert: never; Update: never; Relationships: [] };
      // Migration 41. The secret column is not granted; subscriptions are added by webhook_subscribe().
      webhook_subscriptions: {
        Row: WebhookSubscriptionRow;
        Insert: never;
        Update: Partial<Pick<WebhookSubscriptionRow, 'active' | 'description'>>;
        Relationships: [];
      };
      webhook_deliveries: { Row: WebhookDeliveryRow; Insert: never; Update: never; Relationships: [] };
      // Migration 53: created by dispo_campaign_launch(); the client pauses, marks and edits.
      dispo_campaigns: { Row: DispoCampaignRow; Insert: never; Update: Partial<Pick<DispoCampaignRow, 'status'>>; Relationships: [] };
      dispo_campaign_recipients: { Row: DispoRecipientRow; Insert: never; Update: Partial<Pick<DispoRecipientRow, 'status'>>; Relationships: [] };
      dispo_campaign_messages: { Row: DispoMessageRow; Insert: never; Update: Partial<Pick<DispoMessageRow, 'status' | 'body' | 'subject' | 'send_at' | 'last_error' | 'attempts'>>; Relationships: [] };
      buyer_automation_rules: Table<BuyerAutomationRuleRow, 'workspace_id' | 'rule' | 'tag'>;
      email_senders: { Row: EmailSenderRow; Insert: never; Update: never; Relationships: [] };
      round_robins: Table<RoundRobinRow, 'workspace_id' | 'name' | 'team'>;
      round_robin_members: {
        Row: RoundRobinMemberRow;
        Insert: Pick<RoundRobinMemberRow, 'round_robin_id' | 'user_id' | 'workspace_id'> & Partial<RoundRobinMemberRow>;
        Update: Partial<Pick<RoundRobinMemberRow, 'active'>>;
        Relationships: [];
      };
      roleplay_sessions: {
        Row: RoleplaySessionDbRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      call_review_submissions: {
        Row: CallReviewSubmissionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      sales_coach_settings: {
        Row: SalesCoachSettingsRow;
        Insert: Pick<SalesCoachSettingsRow, 'workspace_id'> & Partial<SalesCoachSettingsRow>;
        Update: Partial<Omit<SalesCoachSettingsRow, 'workspace_id'>>;
        Relationships: [];
      };
    };
    Views: {
      workspace_roster: { Row: RosterRow; Relationships: [] };
      wholesaler_top_buyers: { Row: WholesalerTopBuyerRow; Relationships: [] };
      offer_gaps: { Row: OfferGapRow; Relationships: [] };
      offer_gap_people: { Row: OfferGapPersonRow; Relationships: [] };
    };
    Functions: {
      vendor_set_main_poc: { Args: { p_vendor: number; p_on?: boolean }; Returns: undefined };
      /** Migration 194: the bulk RVM pre-send check (lib/rvm-send.ts reads it). Members only. */
      rvm_send_preview: { Args: { p_ws: number; p_seller_ids: number[]; p_buyer_ids: number[] }; Returns: Json };
      /** Migration 197: RVM pool rotation, admins only. */
      rvm_pool_restore: { Args: { p_ws: number; p_phone: string }; Returns: undefined };
      rvm_pool_dismiss: { Args: { p_ws: number; p_event: number }; Returns: undefined };
      rvm_pool_set_replace: { Args: { p_ws: number; p_mode: string; p_monthly_cap: number; p_retire_on: string }; Returns: undefined };
      /** Migration 194: kick rvm-tick now instead of on the next minute. Members only. */
      rvm_send_now: { Args: { p_ws: number }; Returns: undefined };
      /** Migration 135: an admin puts a line in the RVM or dialer pool. */
      caller_line_set: {
        Args: { p_workspace: number; p_phone: string; p_pool: string | null; p_state: string | null; p_daily_cap: number | null; p_ramp_started_at: string | null };
        Returns: undefined;
      };
      issue_ingest_key: {
        Args: { p_workspace_id: number; p_name: string; p_label: string | null };
        Returns: { id: number; name: string; key: string; prefix: string };
      };
      set_ingest_secret: {
        Args: { p_id: number; p_secret: string };
        Returns: undefined;
      };
      ingest_replay: {
        Args: { p_workspace_id: number; p_source: string; p_since?: string };
        Returns: number;
      };
      is_workspace_member: { Args: { ws: number }; Returns: boolean };
      member_role: { Args: { ws: number }; Returns: string | null };
      normalize_phone: { Args: { p_raw: string }; Returns: string | null };
      ensure_calendar_token: { Args: { ws: number; rotate?: boolean }; Returns: string };
      normalize_address: { Args: { p_raw: string }; Returns: string | null };
      has_role: { Args: { ws: number; roles: string[] }; Returns: boolean };
      /** The matcher (migration 26): rows written to deal_buyer_matches. */
      set_ingest_setting: { Args: { p_id: number; p_key: 'creates' | 'auto_compr' | 'jotform_api_key' | 'round_robin' | 'sync_form'; p_value: string }; Returns: undefined };
      set_investorbase_key: { Args: { p_workspace_id: number; p_key: string }; Returns: undefined };
      investorbase_connected: { Args: { p_workspace_id: number }; Returns: boolean };
      set_ivueit_keys: { Args: { p_workspace_id: number; p_key: string | null; p_secret: string | null; p_base_url: string | null; p_template_id: string | null }; Returns: undefined };
      ivueit_settings: { Args: { p_workspace_id: number }; Returns: { connected: boolean; base_url: string | null; template_id: string | null } };
      webhook_subscribe: {
        Args: { p_workspace_id: number; p_url: string; p_events: string[]; p_description?: string | null };
        Returns: { id: number; secret: string };
      };
      webhook_send_test: { Args: { p_subscription_id: number }; Returns: number };
      webhook_retry: { Args: { p_delivery_id: number }; Returns: undefined };
      tag_bank_transaction: { Args: { p_id: number; p_deal_id: number | null }; Returns: undefined };
      match_deal: { Args: { p_deal_id: number; p_min?: number }; Returns: number };
      rematch_workspace: { Args: { p_workspace_id: number; p_min?: number }; Returns: number };
      buyer_state_code: { Args: { p: string }; Returns: string | null };
      deal_public_link_ensure: {
        Args: { p_deal_id: number; p_headline?: string | null; p_description?: string | null };
        Returns: DealPublicLink;
      };
      dispo_campaign_launch: {
        Args: { p_workspace_id: number; p_deal_id: number; p_settings: Json; p_delivery: Json; p_recipients: Json };
        Returns: number;
      };
      dispo_message_sent: {
        Args: { p_message_id: number; p_provider_id: string; p_communication_id: number | null; p_status?: string; p_conversation_id?: string | null };
        Returns: undefined;
      };
      buyer_automations_apply: { Args: { p_workspace_id?: number | null; p_buyer_id?: number | null }; Returns: number };
      match_buyer: { Args: { p_buyer_id: number; p_min?: number }; Returns: number };
      buyers_list_opt_in: {
        Args: { p_workspace_id: number; p_name: string; p_email?: string | null; p_phone?: string | null; p_markets?: string[]; p_strategy?: string | null; p_sms_ok?: boolean; p_deal_id?: number | null };
        Returns: { buyer_id: number; created: boolean };
      };
      // The same normalisation the generated address_key column uses, exposed
      // so the client can ask "is this the address I already have?" without
      // reimplementing it and drifting.
      address_key: {
        Args: { p_line1: string; p_city: string; p_state: string; p_zip: string };
        Returns: string;
      };
      /** Paged free-agent realtors (migration 96). The shell does not hydrate this corpus. */
      search_free_agent_buyers: {
        Args: { p_workspace_id: number; p_q?: string; p_limit?: number; p_offset?: number };
        Returns: Json;
      };
      /** Migration 106: the same search with a state code and a city ("Dallas" or "Dallas, TX"). */
      search_free_agent_buyers_geo: {
        Args: { p_workspace_id: number; p_q?: string; p_limit?: number; p_offset?: number; p_state?: string; p_city?: string };
        Returns: Json;
      };
      /** Migration 106: every "City, ST" in the realtor corpus with a count. */
      free_agent_markets: { Args: { p_workspace_id: number }; Returns: Json };
      /** Latest communication per live seller, one jsonb array. */
      seller_last_touch: { Args: { p_workspace: number }; Returns: Json };
      /** Migration 125: one record's stage moves, newest first (a seller with its deals', or a buyer). */
      /** Migration 126: realtors in any of these markets, for the Buyers map lasso. */
      free_agents_in_markets: {
        Args: { p_workspace_id: number; p_markets: string[]; p_limit?: number };
        Returns: Json;
      };
      record_stage_history: {
        Args: { p_workspace_id: number; p_entity: string; p_id: number };
        Returns: {
          id: number; entity_type: 'seller' | 'deal' | 'buyer'; entity_id: number; field: string; from_stage: string | null; to_stage: string;
          changed_at: string; changed_by: string | null; source: string; deal_label: string | null;
        }[];
      };
      /** Migration 125: who has ever been at a stage, optionally inside a window. */
      stage_history_ids: {
        Args: { p_workspace_id: number; p_entity: string; p_stage: string; p_from?: string | null; p_to?: string | null };
        Returns: { kind: string; id: number }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
