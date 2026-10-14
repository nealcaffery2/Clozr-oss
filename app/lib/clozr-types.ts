// Entity shapes for the CLOZR mock graph. These mirror the prototype's data
// model: person -> property -> deal -> communication -> task -> offer -> buyer
// -> transaction. Swap CLOZR_DATA for API data later; keep these shapes.
import { CLOZR_DATA } from './clozr-data';
import type { GapFacts } from './section-gaps';
import type { NotifLink } from './notif-target';

export type Stage =
  | 'New Lead' | 'Contacted' | 'Qualified' | 'Appointment' | 'Offer Sent' | 'Negotiation'
  | 'Under Contract' | 'Dispo' | 'Assigned' | 'Closing' | 'Closed' | 'Lost';

export type Rep = {
  id: string;
  name: string;
  initials: string;
  role: string;
  dept: string;
  /** The workspace role (lib/team Role: owner, admin, acquisitions, dispositions, tc, member, notary). */
  memberRole?: string;
  avatar?: string;
  lb?: { calls: number; sms: number; emails: number; conversations: number };
};

export type Property = {
  /** The database id, when this came from a workspace. Absent in the sample graph. */
  propertyId?: string;
  addr: string; city: string; st: string; zip: string;
  beds: number; baths: number; sqft: number; year: number;
  lot: string; type: string; img: string; apn: string;
  /** Extra shots we already have (demo interiors, or a live gallery). The hero stays in `img`. */
  photos?: string[];
  /** Where it is, when the property has been geocoded (live only). */
  lat?: number; lng?: number;
};

export type Person = {
  id: string; name: string; stage: string;
  /** A lead score, 0–100. Null where nothing has scored the lead (every live one, for now). */
  score: number | null;
  assigned: string | null; source: string; phone: string; email: string;
  lastComm: string; lastCommTs: number | null; nextTask: string;
  offer: string | null; created: string; tags: string[]; market: string;
  /** Live rows only: when the seller was created, ISO. `created` is only its "Sep 23" label. */
  createdAt?: string;
  /** Live rows only: seller notes (Podio import leaves `Podio stage: …` here). */
  notes?: string | null;
  motivation: string; timeline: string; condition: string; occupancy: string;
  mortgage: string; asking: string; desiredClose: string; decisionMakers: string;
  /** Disposition-form answers that have no column of their own (migration 93). */
  intake?: Record<string, unknown> | null;
  /** Live rows only: who underwrites this lead (migration 121). */
  underwriter?: string | null;
  property: Property;
};

export type Deal = {
  id: string; personId: string;
  /** Migration 118: off every board and list until unarchived (Deals → Archived). */
  archived?: boolean; archivedReason?: string | null;
  /** Live rows only: when the deal was created, ISO. */
  createdAt?: string;
  contract: number | null; arv: number | null; rehab: number | null;
  assignment: number | null; profit: number | null;
  close: string | null; daysInStage: number; health: string; owner: string | null;
  /** Who underwrites this submission (deals.underwriter_id, migration 130). */
  underwriter?: string | null;
  /** YYYY-MM-DD. Seller purchase option, and the buyer's option on an assignment. */
  optionEndsOn?: string | null;
  buyerOptionEndsOn?: string | null;
  /** Live only: whether the deal has a title company on its team (migration 46). */
  hasTitle?: boolean;
  /** Live only: the deal sheet fields its section reminders check (lib/section-gaps). */
  facts?: GapFacts;
  /** Live rows only: COMPR's MAO and the link to its report (`/r/<lead id>` at Compr). */
  mao?: number | null;
  /** COMPR wholesale (low) / institutional (high) offer band for the underwriter. */
  wholesale?: number | null;
  institutional?: number | null;
  /** A person set the low / the high (migration 184): COMPR syncs leave that side alone. */
  lowSet?: boolean;
  highSet?: boolean;
  underwritingUrl?: string | null;
  /** Live rows only: a Podio submission's COMPR report link ("Ai Compr Tool", migration 169). */
  comprReportUrl?: string | null;
  /** Live rows only: the deal's own stage (lib/stages DEAL_STAGES). The sample graph keys deals on the seller's stage. */
  stage?: string;
  /** Live rows only: the 2026 Deal Tracker's columns, as the sheet names them. */
  tracker?: DealTracker;
  /** Live rows only: the deal's own property and submission facts (migration 49). */
  /** Live rows only: the latest amended price (migration 48). */
  amended?: { field: string; from: number | null; to: number | null; delta: number; by: string | null; at: string };
  /** Live rows only: what the dispo blast says (migration 52) and a shareable photo link. */
  marketing?: { headline: string | null; description: string | null; url: string | null; garage: number | null };
  photoUrl?: string;
  /** Live rows only: COMPR's front photo of the subject (deals.hero_image_url), the record's hero. */
  heroUrl?: string;
  /** Every public photo URL on the deal, hero first. Image URLs only. */
  photos?: string[];
  /** Source photo links (Podio Photos, a Drive folder, a listing). Not drawn as tiles. */
  sourcePhotos?: string[];
  /** Live rows only: public COMPR buyer report (thecompr.com/v/<token>). */
  buyerReportUrl?: string | null;
  /** Live rows only: downloadable buyer CMA PDF from COMPR comps. */
  cmaPdfUrl?: string | null;
  /** Live rows only: the public listing page (photos live here). */
  listingUrl?: string | null;
  photosUrl?: string | null;
  /** Live rows only: the deal's own property row, which a partner contact's record matches against its address. */
  propertyId?: string;
  addr?: string; city?: string; leadStage?: string | null; asking?: number | null; submittedAt?: string | null; targetAssignment?: number | null;
  /** Live rows only: the property's state, ZIP and geocoded point, for the People map. */
  st?: string; zip?: string; lat?: number; lng?: number;
  /** Live rows only: the buyer attached to this deal (purchases / assignment). */
  buyerId?: string;
  /** Assignment, JV, Double Close, or Novation. Empty until someone sets it. */
  structure?: string | null;
  /**
   * Vendors on deal_parties as role seller. Separate from personId (deals.seller_id):
   * a sellers-table seller stays, and these are the vendor records attached beside them.
   */
  vendorSellers?: { id: string; name: string; phone: string; email: string; company: string }[];
};

export type DealTracker = {
  no: number | null; contractDate: string | null; scheduledClose: string | null; closedOn: string | null;
  sellerPrice: number | null; priceDrop: number | null; marketedPrice: number | null; marketedFee: number | null;
  dispoPrice: number | null; dispoUpsell: number | null; dispoFee: number | null;
  acqAgent: string | null; dispoAgent: string | null; transactionType: string | null;
  leadManager: string | null; coordinator: string | null; contractStatus: string | null; leadSource: string | null;
};

export type BuyBox = {
  price: string; year: string; sqft: string; beds: string; baths: string;
  type: string; rehab: string; exit: string; minCap: string;
  maxCashOut: string; minCashFlow: string; avoid: string[];
};

export type Buyer = {
  id: string; name: string; company: string; initials: string; status: string;
  /** The teammate this buyer is assigned to (buyers.assigned_to, migration 128). */
  assigned?: string | null;
  /** Where the buyer is with us (buyers.status, lib/stages BUYER_STAGES). `status` is the derived label (VIP, Vetted…). */
  stage?: string;
  markets: string[]; type: string; engagement: number; stars: number;
  /** Touches the team sent (texts, emails, calls, deal sends). Missing on sample rows that only store a response percent. */
  sent?: number | null;
  /** False until something has been sent: the response rate is then unknown, not 0%. */
  responseKnown?: boolean;
  /** Low response, or offers that never close. See lib/tire-kicker.ts. */
  tireKicker?: boolean;
  phone: string; email: string; pref: string; doNot: string;
  buyBox: BuyBox; match: number; ceiling: string; rehabTol: string; strategy: string;
  lastPurchase: string; lastActivity: string; offers: string;
  /** Live rows only: when the buyer was created, ISO. */
  createdAt?: string;
  /** Live rows only: last_activity_at, ISO, so the list sorts by it rather than by its "3d ago" text. */
  lastActivityAt?: string | null;
  why: string[]; issue: string;
  /** Live rows only. */
  vip?: boolean; vetted?: boolean; blacklisted?: boolean; buyerType?: string | null; tags?: string[];
  /** buyers.source. Discovery sources (buyr, genius) file into a prospect list until vetted. */
  source?: string | null;
  /** Holding list id from lib/prospect-lists. Null on the real buyer list. */
  prospectList?: string | null;
  /** buyers.entity_type when someone has set it; the name is the only other evidence. */
  entityType?: string | null;
  activity: {
    calls: number; texts: number; emails: number; viewed: number; clicks: number;
    offers: number; walkthroughs: number; purchases: number; declines: number;
  };
  summary: string[];
};

export type TimelineEntry = {
  id: string; type: string; user: string | null; who: string; time: string;
  /** Live rows only: when it happened (ISO), so rows loaded apart (stage history) sort in among the rest. */
  at?: string;
  title: string; body?: string; recording?: boolean;
  /** A call: the rep's call notes, shown under its recording. A call note: set when it is shown there instead. */
  callNote?: string; underCall?: boolean;
  /** Live rows only: the record this happened on ("s8", "b3"), so a record shows its own history. */
  entity?: string;
  /** Live rows only: the deal a message is about ("d12"), so a partner's submission shows its own messages. */
  dealId?: string;
  /** Pinned to the top of the record's feed (migration 43): when, and by whom. */
  pinnedAt?: string; pinnedBy?: string | null;
  ai?: { summary: string; objections: string[]; next: string };
  /** The AI agent that did it (migration 269): the feed shows its name and picture instead of a rep's. */
  agent?: { key: string; name: string; avatar: string | null };
  /** An email: what the record's feed draws as a message (components/record/EmailEntry.tsx) rather than a text blob. */
  email?: {
    subject: string; from: string; fromName: string; to: string[]; inbound: boolean; body: string;
    /** The RFC Message-ID Gmail filed it under ("<…>"), so a reply from the feed lands in the same Gmail thread. */
    sourceId?: string | null;
  };
};

export type Comp = {
  id: string; addr: string; dist: number; sale: string; price: number; ppsf: number;
  sqft: number; beds: number; baths: number; year: number; stories: number;
  cond: string; sub: string; inc: boolean; x: number; y: number; img: string; reason: string;
};

export type RehabRow = { k: string; low: number; med: number; heavy: number };
export type Exit = { k: string; offer: number; profit: number; note: string };

export type InboxItem = {
  id: string; personId?: string | null; buyerId?: string | null;
  channel: string; preview: string; time: string; unread: number; assigned: string | null;
  /** Who it came from and what about, so Home can open its Inbox thread (inboxHandoff). */
  fromPhone?: string | null; fromEmail?: string | null; subject?: string | null;
};

export type Task = {
  id: string; title: string; personId: string; type: string; due: string;
  assigned: string | null; priority: string; done: boolean; bucket: string;
  /** What to say or send. An action plan fills this in when it queues a step. */
  note?: string;
  /** Live rows only: the due time, ISO. `due` is only its "Today" label. */
  dueAt?: string | null;
  /** Live rows only: the deal a checklist task hangs on when it has no seller_id. */
  dealId?: string | null;
  /** Live rows only: a buyer-plan task's buyer. */
  buyerId?: string | null;
};

export type Notification = {
  id: string; cat: string; text: string; time: string; unread: boolean;
  /** Where clicking it goes (lib/notif-target): the record, plus its tab, deal or text thread. */
  link: NotifLink;
  /** Addressed to this user (notifications.user_id), not a broadcast or a bell item built from a message. */
  direct?: boolean;
  /** Lane's own notes (category Lane): the full check-in, shown in Lane's panel. */
  body?: string;
  /** A missed call or text (lib/bell-events): the other side's number, so reading the thread in the Inbox clears it. */
  phone?: string;
};

export type Offer = {
  id: string; buyerId: string;
  /** Live rows only: the deal the offer is on. */
  dealId?: string;
  offer: number; emd: number; inspection: string;
  closing: string; financing: string; pof: string; terms: string;
  confidence: number; flags: string[];
};

export type Walkthrough = {
  id: string; buyerId: string; personId: string; date: string; time: string; status: string;
};

export type TcItem = { k: string; done: boolean; owner: string; date: string; blocker?: string };
export type TcBlocker = { level: string; text: string; who: string };
export type TcFeedItem = { who: string; role: string; time: string; text: string };

export type Communication = {
  id: string; personId: string; buyerId?: string;
  /** call | sms | email | voicemail */
  channel: string;
  /** 'in' = they contacted us, 'out' = we contacted them */
  dir: string;
  /** The person on the other end — seller, buyer, or a third party like title. */
  party: string;
  /** Rep who sent/took it; null for purely inbound with no owner. */
  user: string | null;
  /** Minutes ago. Ascending = older; record timelines sort on this. */
  ts: number;
  time: string; preview: string; dur?: string;
  /** Live rows only: queued | sent | delivered | failed, for a text we sent. */
  status?: string;
};

export type TcException = {
  id: string; ref: string; kind: string; text: string;
  /** critical | warning | cleared */
  severity: string;
  owner: string; due: string; status: string;
};
export type TcEarnest = {
  id: string; party: string; amount: string; holder: string;
  due: string; received: string | null; status: string;
};
export type TcDeadline = {
  id: string; k: string; date: string; owner: string;
  /** met | due | open | overdue */
  status: string;
  note: string;
};
export type TcDocument = { id: string; k: string; owner: string; status: string; due: string };
export type TcNextAction = {
  id: string; who: string; role: string; what: string; due: string;
  /** critical | warning | info */
  severity: string;
};
export type TcTask = {
  id: string; t: string; note: string; day: string; owner: string;
  /** On the printed form this is the orange critical path. */
  critical: boolean;
};
export type TcPhase = { k: string; sub: string; tasks: TcTask[] };
export type TcMilestone = { k: string; t: string; sub: string };
export type TcHudLine = { id: string; k: string };
/** One Acme Homes contract-to-close template, keyed by deal type. */
export type TcChecklist = {
  label: string; flow: string; d0: string; target: string;
  milestones: TcMilestone[]; phases: TcPhase[]; hud: TcHudLine[];
};

export type Transaction = {
  id: string; dealId: string; personId: string; escrow: string;
  /** Selects the checklist template: 'assignment' | 'novation'. */
  dealType: string;
  /** Contract date the D-numbers count from, and the Clear-to-Close target. */
  d0: string; ctcTarget: string;
  /** Checklist and HUD progress, keyed by task id. */
  done: Record<string, boolean>;
  hudDone: Record<string, boolean>;
  tcReview: string | null;
  signoff: string | null;
  titleCo: string; titleContact: string; titlePhone: string; titleEmail: string;
  opened: string; closing: string;
  commitment: {
    /** Received | Pending | Cleared */
    status: string;
    received: string | null; effective: string | null;
    exceptions: TcException[];
  };
  earnest: TcEarnest[];
  deadlines: TcDeadline[];
  documents: TcDocument[];
  nextActions: TcNextAction[];
  /** Live rows only: the dates as ISO, so Lane's day markers don't parse display strings. */
  d0Iso?: string | null;
  closingIso?: string | null;
  /** Live rows only: what Lane needs to be lender- and structure-aware. */
  state?: string | null;
  buyerName?: string | null;
  buyerFinancing?: string | null;
  lender?: string | null;
  structure?: string | null;
  /** Live rows only: the database id, for writes. */
  dbId?: number;
  /** Live rows only: the SOP's 10-minute clock from the deal's creation to the seller contract going out (lib/deal-close). */
  contractSla?: { minutes: number | null; late: boolean; waiting: boolean; label: string } | null;
};

export type PlanStep = {
  id: string;
  /** sms | call | email | task */
  channel: string;
  delay: string; title: string; content: string;
  /** True once an AI layer wrote this step's content. Reserved; nothing sets it yet. */
  generated: boolean;
};
export type ActionPlan = {
  id: string; name: string; trigger: string; active: boolean;
  description: string; steps: PlanStep[];
  /** seller | buyer | tc | source — who the plan is for. Blank means seller (legacy). */
  audience?: string;
};
export type Enrollment = {
  id: string;
  /** Seller contact id (`s123` / `p1`). Empty when this enrolment is for a buyer. */
  personId: string;
  /** Buyer contact id (`b123`). Empty when this enrolment is for a seller. */
  buyerId?: string;
  planId: string;
  /** 1-based index of the step the contact is on. */
  step: number;
  /** active | paused | done */
  status: string;
  note: string;
};
export type Vendor = {
  id: string; name: string; kind: string; contact: string;
  phone: string; email: string; market: string; rating: number; note: string;
  /** Live only (migration 80): location, every market served, office line, main point of contact. */
  city?: string; state?: string; markets?: string[]; office?: string; mainPoc?: boolean;
  /** Live only (migration 91): deals this source sent us, offered on, accepted, closed. */
  subs?: number; offered?: number; accepted?: number; closed?: number;
};

export type CalendarDay = { day: string; items: { t: string; title: string; kind: string }[] };

export type AutomationStep = { when: string; type: string; text: string };

/**
 * The mock graph, cast to the entity shapes above. The raw module is a literal
 * so TypeScript infers over-narrow types (e.g. `stage: "Qualified"`); this is
 * the one place we widen it.
 */
export const D = {
  IMG: CLOZR_DATA.IMG as Record<string, string>,
  team: CLOZR_DATA.team as unknown as Record<string, Rep>,
  STAGES: CLOZR_DATA.STAGES as Stage[],
  people: CLOZR_DATA.people as unknown as Person[],
  deals: CLOZR_DATA.deals as unknown as Deal[],
  buyers: CLOZR_DATA.buyers as unknown as Buyer[],
  timeline: CLOZR_DATA.timeline as unknown as TimelineEntry[],
  comps: CLOZR_DATA.comps as unknown as Comp[],
  rehab: CLOZR_DATA.rehab as RehabRow[],
  exits: CLOZR_DATA.exits as Exit[],
  propertyIntel: CLOZR_DATA.propertyIntel as [string, string, string][],
  inbox: CLOZR_DATA.inbox as unknown as InboxItem[],
  tasks: CLOZR_DATA.tasks as unknown as Task[],
  notifications: CLOZR_DATA.notifications as unknown as Notification[],
  offers: CLOZR_DATA.offers as unknown as Offer[],
  walkthroughs: CLOZR_DATA.walkthroughs as unknown as Walkthrough[],
  engagementFeed: CLOZR_DATA.engagementFeed as [string, string][],
  tcItems: CLOZR_DATA.tcItems as unknown as TcItem[],
  tcBlockers: CLOZR_DATA.tcBlockers as TcBlocker[],
  tcFeed: CLOZR_DATA.tcFeed as TcFeedItem[],
  communications: CLOZR_DATA.communications as unknown as Communication[],
  transactions: CLOZR_DATA.transactions as unknown as Transaction[],
  tcChecklists: CLOZR_DATA.tcChecklists as unknown as Record<string, TcChecklist>,
  actionPlans: CLOZR_DATA.actionPlans as unknown as ActionPlan[],
  enrollments: CLOZR_DATA.enrollments as unknown as Enrollment[],
  vendors: CLOZR_DATA.vendors as unknown as Vendor[],
  reporting: CLOZR_DATA.reporting as unknown as {
    kpis: [string, string, string][];
    funnel: [string, string, number][];
    activity: [string, string][];
    leaderboard: { rep: string; calls: number; talk: string; contacts: number; offers: number; contracts: number; revenue: string; conv: string }[];
    sources: [string, number, string][];
    monthly: number[];
  },
  automation: CLOZR_DATA.automation as unknown as {
    trigger: string; conditions: string[]; steps: AutomationStep[]; palette: string[];
  },
  calendar: CLOZR_DATA.calendar as unknown as CalendarDay[],
};
