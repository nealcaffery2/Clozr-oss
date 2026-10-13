// CLOZR view-model. A direct port of the Claude Design prototype's logic class
// (state + renderVals + leaderboardVals + askAi) into a React hook.
//
// Everything the screens render comes from the object this returns, so swapping
// the mock graph in lib/clozr-data.ts for API data is the only change needed to
// put this on a real backend.
'use client';

import { isProtectedBuyer } from '@/lib/ai-agent-client';
import type { BulkRecord } from '@/app/components/ai-agent/BulkAgentPanel';
import { emailGist, looksHtml } from '@/lib/email-text';
import { requestInboxSms, requestInboxThread, threadKeyFor } from '@/app/clozr/screens/inboxHandoff';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import { closeBadge, closeSortKey } from '@/lib/close-date';
import type React from 'react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { D as MOCK, type ActionPlan, type Buyer, type Communication, type Deal, type Enrollment, type InboxItem, type Notification, type Person, type PlanStep, type Stage, type Property, type Rep, type Task, type TimelineEntry, type Vendor } from '@/lib/clozr-types';
import { LANE_PROMPTS, LANE_START, askLane, deleteLaneChat, laneContext, laneDrive, listLaneChats, loadLaneMessages, type LaneAction, type LaneCard, type LaneChat, type LaneDraft, type LaneRefTarget, type LaneTurn } from '@/lib/lane';
import { TOOL_LABEL, askClozr, type AskCard, type AskCardKind, type AskFocusItem, type AskTurn } from '@/lib/ask-clozr';
import {
  applyCallFacts, applyComprReport, saveOfferBand as saveOfferBandWrite, archiveBuyers, archiveDeals, archiveSellers, archiveVendors, setVendorLocation, setVendorMainPoc, assignSellers, assignBuyers, setSellerUnderwriter, createCommunication, createTask, deletePlan as deletePlanWrite,
  claimSeller, createAppointment, parseDue,
  enrollInPlan, enrollBuyerInPlan, logActivity, markNotificationsRead, pauseEnrollment, pinTimelineEntry, resumeEnrollment, saveAdd, savePlan as savePlanWrite,
  setStage as setStageWrite, setDealStage as setDealStageWrite, setSubmissionStage, assignDeals, setDealUnderwriter, matchDeal as matchDealWrite, setTaskDone, setTaskDue, setTcGate, setTcTick, tagSellers, untagSellers, tagBuyers, untagBuyers, saveWhatWeKnow, updateSellerDetails, updateTcFile,
  setStageMany, eachLimited, openDealOnProperty, type FieldValue, type WriteResult,
} from '@/lib/crm-write';
import { useConfirm } from '@/components/ds/Confirm';
import { buyersForPipelineDeal, pipelineDealOptions } from '@/lib/buyer-pipeline';
import { ENDING_STAGES, fridayOverrideAsk, isFridayIso, readyToMarketChecks, tcFileBlockers } from '@/lib/deal-close';
import { stopEnrollment } from '@/lib/plans';
import { SMART_LIST_QUIET_MIN, isDeadLeadStage, isReactivationLead } from '@/lib/reactivation';
import { BUYER_STAGES, PIPELINE_STAGES, PODIO_NEW_SUBMISSIONS, PODIO_SUBMISSION_STAGES, PODIO_TOTAL_SUBMISSIONS, SELLER_STAGES, podioItemInList, podioRowStage, type PodioSubmission, SELLER_STAGE_LABELS, dealStageColor, isDealStage, offDispo, onDispoBoard, sellerStageColor, sellerStageForDeal, sellerStageGroup, sellerUnderContract, nativeSubmissionDeals, submissionListMatch, isDeadStage, opensDeal, leadStagePicks } from '@/lib/stages';
import { submissionIdentity, submissionOpenTarget } from '@/lib/vendor-sellers';
import { formatPhone, toE164 } from '@/lib/talkr';
import { PHONE_OTHER_TAB } from '@/lib/softphone-lock';
import type { IconName } from '@/app/components/talkr/Icon';
import { fmtDuration, parseMoney, relativeTime, useTalkrPhone } from './useTalkrPhone';
import type { CallDto } from '@/lib/talkr';
import { PARTNER_START_LIST, draftPlan, teamTc, type Role, canSee, canSeeBuyers, isAdmin, landingFor, peopleListOk, seesSellerLists } from '@/lib/team';
import { STAGE_BAR, endsNumberWalk, outcomeToast, planOutcome, repZoneNow, stageBarIndex, stageGroup, type OutcomeKey, type OutcomePlan, type Vocab } from '@/lib/call-outcomes';
import { VM_DROPPED_EVENT, advancesAfterSave, afterVmDrop } from '@/lib/dial-engine';
import { DEFAULT_RVM_WINDOW, hasDnc, inWindow, zoneForRvm, zonedClock } from '@/lib/rvm';
import { recentOutboundFromNumbers, spinOrgCallerId } from '@/lib/caller-spin';
import { loadLinePools } from '@/lib/line-pools';
import { marketState } from '@/lib/rvm-pool';
import { buildToday, dueTaskFor, mergeTodayAi, tasksByPerson, todayCandidates, TODAY_GROUPS, type TodayAiRank, type TodayDone, type TodayRow } from '@/lib/today';
import { rankToday, todayAiKey } from '@/lib/today-ai';
import { zoneForNumber } from '@/lib/talkr-web/time';
import { comprLeadOfDealNow, pullCompr, runCompr, runComprMany, sendComprReport, syncComprMarketing } from '@/lib/compr';
import { type ComprReport, comprLeadIdFromUrl, comprLeadIdOfDeal, comprUrl, parseComprMessage } from '@/lib/compr-embed';
import { comprReportDealId } from '@/lib/compr-sync';
import { adoptComprWindow, claimComprPull, comprReportHref, comprRunEnded, comprRunInFlight, comprRunStarted, comprWaitHref, comprWindowDeal, comprWindowSpoke, navigateComprWindow, showComprReport } from '@/lib/compr-window';
import { adjacentOpenRow, adjacentRecordId, adjacentStage, openRowId, stepIndex, stepLabel, submissionRowKey } from '@/lib/people-keys';
import { deleteSmartList, insertSmartList, loadSmartLists, smartListVisible } from '@/lib/smart-lists';
import { buyerListIds, buyerListLabelOf, effectiveBuyerList, inBuyerList } from '@/lib/buyer-list-profile';
import { loadPeopleMemoryRaw, readPeopleMemory, writePeopleMemory } from '@/lib/people-memory';
import { openTcFiles, stepTc as nextTcId, tcPlace } from '@/lib/tc-nav';
import { dealPinsFor, isArchivedRecord, recordListOf, urlDealOf } from '@/lib/url-deal';
import { type NavHash, type NavRef, backAction, decodeNavHash, encodeNavHash, formatFrom, parseFrom, sameRef } from '@/lib/nav-hash';
import type { BackTarget } from '@/components/ds/BackLink';
import { EMAIL_FILTERS, PHONE_FILTERS, matchesContactFilters } from '@/lib/contact-presence';
import { isPicked, joinPicks, keepPicks, matchesAnyPick, matchesPick, picksLabel, picksOf, togglePick } from '@/lib/multi-filter';
import { firstN, inListOrder, type AssignBlock } from '@/lib/bulk-assign';
import { dealTypeLabel } from '@/lib/deal-types';
import { DEFAULT_PINNED_LISTS, applySmartListDrop, layoutSmartLists, togglePinnedList } from '@/lib/smart-list-layout';
import { plansForRecord } from '@/lib/action-plan-catalog';
import { loadDismissedNotifs, mergeDismissed, notificationDbIds, saveDismissedNotifs, visibleNotifs, forRep } from '@/lib/notif-dismiss';
import { loadBellDismissals, saveBellDismissals } from '@/lib/bell-dismissals';
import { phoneTail } from '@/lib/bell-events';
import { withFloorBellMutes } from '@/lib/floor-notify';
import { useFloorNotifyPrefs } from '@/lib/floor-notify-prefs';
import { GAP_BELL_CAT, sectionGaps, type SectionGap } from '@/lib/section-gaps';
import { flagsForStage, formatSourceScore, isDealSource, isNationalSource, sourceGetsEmailFollowup, sourceScorecard } from '@/lib/source-score';
import { recommendStage } from '@/app/components/record/record-logic';
import { type Recipient, sendSummary, textMany } from '@/lib/sms';
import { restoreDraft, withRestored } from '@/lib/compose-drafts';
import { sendEmail } from '@/lib/google';
import { openReach } from '@/app/components/record/reach';
import { emailPlain, looksLikeHtml } from '@/lib/email-html';
import { prefillCampaign } from '@/lib/dispo-campaign';
import { loadRealtorCorpus, loadRealtorMarkets } from '@/lib/crm';
import type { PatchTable } from '@/lib/use-crm';
import { dispoFields } from '@/lib/dispo-fields';
import { listingUrl } from '@/lib/dispo';
import { demoFor } from '@/components/dispo-campaign/demo-data';
import { indexByPhone, syncTalkrToRecords } from '@/lib/talkr-sync';
import { dialWithExtension, onExtensionOpenRecord } from '@/lib/talkr-extension';
import { generateOffer as generateOfferWrite, logOffer as logOfferWrite, offerMoney } from '@/lib/offers';
import { useCallQueue, type QueueKind } from '@/lib/call-queue';
import { marketTiming } from '@/lib/dispo-sop';
import { dbId, dealRank, taskDueFields, loadBuyerTimeline, loadPhoneTexts, loadRecordComms, loadRecordTimeline, mergeThread, personMarket, type PhoneText, relative, type MatchView, type OfferGap, type OfferGapPerson } from '@/lib/crm';
import { marketLabel, stateCodeOf as placeStateCode, stateNameOf } from '@/lib/place-names';
import { historyWindow, loadStageHistory, stageEventEntry, stageHistoryIds, type HistoryMatch, type StageEvent } from '@/lib/stage-history';
import { HISTORY_WHEN, MONEY_BUCKETS, PROPERTY_STEPS, STACK_STEPS, SUBMISSION_STEPS, anyInRange, atLeastOf, listStack, moneyRange } from '@/lib/people-stack';
import { GAP_WITHIN, closeCallsNeeded, gapOf, withinOf } from '@/lib/offer-gap';
import { offerBand } from '@/lib/offer-band';
import { addedOn, inDrawnOrder, peopleColumnSort, peopleSortColumn } from '@/lib/list-sort';
import { recall } from '@/lib/screen-memory';
import { TASK_VIEWS, dueLabel, inTaskView, overdueFirst } from '@/lib/task-views';
import { taskRecordOf } from '@/lib/task-record';
import { optionAtRisk, optionReadouts } from '@/supabase/functions/_shared/option-clock';
import { DEAL_COL_LABELS, trackerSheet } from '@/lib/deal-tracker-sheet';
import { whatWeKnowFields } from '@/lib/what-we-know';
import { ENTITY_LABELS, STATE_NAMES, buildGazetteer, entityKind, resolveMarkets, type EntityKind, type Place } from '@/lib/market-geo';
import { openPopup, propertyLinks, streetViewImage } from '@/lib/property-links';
import { collectPhotos, demoGallery, photoIndexOf } from '@/lib/house-photos';
import { loadDealAlbum, pullDrivePhotos } from '@/lib/deal-files';
import { CUSTOM_TAB, REPORT_RANGES, REPORT_TABS, type Kpi, type ReportRaw, buildReport, homeKpis, rangeOf, reportCsv, sampleReportRaw } from '@/lib/reporting';
import { BUYR, COMPR, DEAL_MACHINE, LANE, TALKR_INK, TALKR_TINT } from '@/app/clozr/brand';
import { boardFace } from '@/lib/rep-art';
import { BADGES, DEFAULT_TZ, type Goals, PERIODS as LB_PERIODS, type SalesPerson, applyLeaderboardResets, badgesFor, buildBadgeContext, buildLeaderboard, calculatePoints, getCalls, getContracts, getConversations, resolveTitles } from '@/lib/leaderboard';
import { getLeaderboardResetRev, getLeaderboardResets, getMonthlyPrize, subscribeLeaderboardResets } from '@/lib/floor-store';
import { confirmDialerReady } from '@/lib/dialer-readiness';
import {
  emptyTally, nowMs, outcomeForDisposition, parseSavedRun, personKey, readPrefs, requestSessionSetup, resumeLabel, runAgainCounts,
  runAgainList, runKey, sessionProgress, tallyDrop, tallyOutcome, type ListFacts, type RunAgainFilter, type SavedRun, type SessionTally,
  type SetupListOption,
} from '@/lib/dial-session';
import { dialNumbers, loadBuyerPhones, loadSellerPhones, markPrimaryWrong, markSellerPhone, noteDialled, peopleLeft, spliceNumbers, walkKey, type DialNumber, type QueueDepth } from '@/lib/seller-phones';
import { buyerStatusTone, typeTone } from '@/lib/people-colors';
import { isDmProspect } from '@/lib/prospect-lists';
import { BLACKLIST_MESSAGE, blockReason, isBlacklisted, type BlockReason, type Contactable } from '@/lib/blacklist';
import { isSecretBlacklisted, SECRET_BLACKLIST_TAG, visibleTags } from '@/lib/secret-list';
import { saveBlacklistReason } from '@/lib/blacklist-reasons';
import { isTireKicker } from '@/lib/tire-kicker';
import type { ClozrRecord } from '@/app/components/talkr/CallContext';
import { READ_ONLY_MESSAGE } from '@/lib/read-only';
import { buyerContactProblem } from '@/lib/buyer-contact';
import { sellersSharingProperty } from '@/lib/crm-write';
import { writeCallOutcome } from '@/lib/call-outcome-write';
import { useAlternateOwners } from '@/lib/contact-alternates';
import { findQuickAddDuplicate, mergeQuickAdd, mergeToast, type QuickDupe } from '@/lib/quick-add-dupes';
import { type AddDrafts, draftFor, dropDraft, hasTyped, keepDraft } from '@/lib/quick-add-draft';
import type { CmdAction, CmdData } from './command-rows';
import { parseSearch, searchKey, searchRank, searchRows, type SearchKey } from '@/lib/list-search';
import { onWorkspaceReset } from '@/lib/active-workspace';
import { foldEmailThreads } from '@/lib/email-thread';
import { useRecordFeedLive } from './useRecordFeedLive';
import { heatText, responseTone, tempText } from '@/lib/heat';

/** Every record type Quick Add can create. */
export type AddKind = 'seller' | 'coseller' | 'address' | 'property' | 'buyer' | 'deal' | 'task' | 'appointment' | 'note' | 'vendor';
/**
 * What the Quick Add sheet asks before it writes: the seller or buyer typed is
 * already in the workspace (lib/quick-add-dupes), or an address edit is on a
 * property other sellers share.
 */
export type AddAsk =
  | { kind: 'dupe'; dupe: QuickDupe }
  | { kind: 'scope'; others: { id: number; name: string }[]; address: string };

/**
 * What a toast is saying: a write that landed, one that did not, or anything
 * else. Every toast used to wear the same green square, so "Could not save"
 * looked exactly like "Saved".
 */
export type ToastTone = 'success' | 'error' | 'info';

/** How a toast from a canWrite-off branch reads when it was written for the demo. */
const DEMO_ANSWER = /\(demo\)$|signed-in workspace\.?$|^Sign in (to|with) /;
/** What those answers say in a live workspace this user can only read. */
const READ_ONLY_LIVE = 'Read-only · nothing was saved';
/** Seller columns the record edits, and the Person field each one shows as (patchLocal). */
const SELLER_VIEW_FIELD: Record<string, string> = {
  condition: 'condition', motivation: 'motivation', timeline: 'timeline', occupancy: 'occupancy', mortgage: 'mortgage',
  desired_close: 'desiredClose', decision_makers: 'decisionMakers', notes: 'notes', asking_price: 'asking', name: 'name',
};
/** People's list, filters and search, kept per tab (sessionStorage). */
const PEOPLE_VIEW_KEY = 'clozr.peopleView';

/** The People toolbar filter set. 'Any' means the filter is off. */
export type PeopleFilters = {
  owner: string; stage: string; source: string; tag: string; date: string; sort: string;
  /** 'Any' | 'Not run' | 'Run' — whether COMPR has underwritten the lead. */
  compr?: string;
  /**
   * Offer gaps (migration 70). `gapBasis` and `gapWithin` are modifiers, not
   * filters: they say which number the two counts below are measured against,
   * and on their own they narrow nothing, so they are left out of the active
   * filter count the way `sort` is.
   */
  gapBasis?: string;
  gapWithin?: string;
  /** 'Any' | '1+' | '2+' | '3+' | '5+' — times they came within `gapWithin`. */
  closeCalls?: string;
  /** 'Any' | '1+' | '3+' | '5+' — offers of theirs that were declined. */
  declined?: string;
  /** 'Any' | a wholesaler company — who submitted the deal. */
  submitter?: string;
  /** 'Any' | 'Has phone' | 'No phone'. */
  phone?: string;
  /** 'Any' | 'Has email' | 'No email'. */
  email?: string;
  /**
   * Stage history (migration 125): a stage they have ever been at, whatever
   * they are at now, and when they reached it. `historyWhen` and the two
   * dates are modifiers of `history`, not filters of their own.
   */
  history?: string;
  historyWhen?: string;
  historyFrom?: string;
  historyTo?: string;
  /** Offer and ARV: a bucket, or 'Custom' with `…Min`/`…Max` ("150k"). Any of their deals in range matches. */
  offer?: string; offerMin?: string; offerMax?: string;
  arv?: string; arvMin?: string; arvMax?: string;
  market?: string;
  /** List stacking: '5+' deals sent, '2+' properties held, '3+' lists they are on. */
  subs?: string;
  props?: string;
  stack?: string;
};

export type CallTarget = {
  name: string; phone: string; personId?: string | null; buyerId?: string | null;
  /** The number is one of the record's other numbers (a seller_phones / buyer_phones id), not its own phone. */
  phoneId?: number | null;
  /** The deal the call is about, when the screen it was placed from knows (a deal sheet, a record on one deal). */
  dealId?: string | null;
};
/**
 * One row of a running call-queue session; `queueItemId` is set for people the
 * rep queued by hand. A person with several numbers to try has one row per
 * number, side by side, `n` of `of` (lib/seller-phones.ts spliceNumbers).
 */
/** What an archive (Shift+Delete on People, Ctrl+A on Buyers, a bulk bar, a deal) would archive, waiting on Yes / No. */
export type ArchiveAsk = {
  kind: 'seller' | 'buyer' | 'deal' | 'vendor';
  ids: string[];
  names: string[];
  /** A seller's open deals, archived with them unless unticked (they would stay on the board with no seller). */
  deals: { id: string; addr: string }[];
  /** Asked on an open record: Yes moves on to the next one. */
  fromRecord: boolean;
  /** A deal whose seller has no other open deal: the seller can go too, if ticked. */
  seller?: { id: string; name: string } | null;
};

type QueueRunItem = { target: CallTarget; queueItemId?: string; claim?: boolean; n?: number; of?: number };
type QueueRun = {
  title: string; list: QueueRunItem[]; pos: number; dialed: number; skipped: number;
  mode: 'power' | 'predictive'; dropped: number;
  /** Set when predictive refused the rest of the list because their local window is closed. */
  hold: string | null;
  /** Numbers per person; `loading` while their other numbers are still being read. */
  depth: QueueDepth;
  loading: boolean;
  /** The row rung last, -1 before the first: whose numbers the walk is on. */
  at: number;
  /** People reached this session (walkKey): the rest of their numbers are passed over. */
  reached: string[];
  /** What the calls came to (lib/dial-session.ts), for the session bar and the finished summary. */
  tally: SessionTally;
  /** The row whose outcome is in `tally` already, so one call is counted once. */
  talliedAt: number;
  /** The list as the rep started it, one row per person: what "Run the same list again" dials. */
  origin: QueueRunItem[];
  startedAt: number;
};
/** A session that has stopped, finished or ended by the rep: the summary shows it until Done. */
type QueueDone = {
  run: QueueRun;
  how: 'finished' | 'ended';
  endedAt: number;
};
/** The call-summary fields the wrap-up shows the rep and Accept writes back (wrapFields, acceptWrap). */
export type WrapKey = 'motivation' | 'timeline' | 'price_expectation' | 'objection' | 'follow_up' | 'suggested_task';

/**
 * What an outcome save has done so far. A retry skips every step already
 * `ok`, so it never stacks a second task; `failed` names what did not land.
 */
export type OutcomeLedger = { ok: Record<string, true>; failed: { step: string; label: string; message: string }[]; saved: boolean };
export type OutcomeSaveOpts = {
  /** The call notes: written as a Call note, and sent to Talkr with the disposition. */
  notes: string;
  /** The rep's edits to the call summary's CRM fields (conversation outcomes only). */
  facts?: Partial<Record<WrapKey, string>>;
  /** Empties the softphone's notes draft in the same tick the call closes, so it is not saved twice. */
  clearNotes?: () => void;
  /** The ledger of an earlier attempt, when this is a retry. */
  ledger?: OutcomeLedger | null;
  /**
   * The house the outcome is about, when the record is pinned to one: its
   * stage moves with `subDealId` (a real submission, deals.lead_stage), and
   * Offer accepted opens `dealId`, or a deal on `propertyId`.
   */
  house?: OutcomeHouse | null;
};
export type OutcomeHouse = { subDealId: string | null; dealId: string | null; propertyId: number | null };

/** The list "View imported" opens: what the last import in this session wrote. */
export const LAST_IMPORT = 'Last import';
/**
 * A Submissions row id: 'sub:d12', or 'sub:d12~4567' for a further Podio item
 * on the same deal (a resubmission CLOZR keeps as one house). The deal part.
 */
export const subKey = (id: string) => (id.startsWith('sub:') ? id.split('~')[0] : id);
const subDealId = (id: string) => subKey(id).slice(4);

export type ClozrState = {
  screen: string;
  /** Notification categories muted from the panel, each until a timestamp. */
  /** Notification categories muted for the hour; the mute action clears each on a timer. */
  mutedCats: Record<string, boolean>;
  /** When each mute from the bell ends (ms), for the bell's "Muted: texts (until 3:40)" line. */
  mutedUntil: Record<string, number>;
  /** Which Matches-tab chips are switched on. */
  matchFilterOn: Record<string, boolean>;
  personId: string;
  /** The deal the Deal Sheet opens, when a contact carries several (a partner's submissions). */
  dealSheetDealId?: string | null;
  /**
   * The deal sheet was opened because the rep just put this deal under
   * contract: it asks for the deal type and the Acquisition section until they
   * say Finished. The deal already exists either way.
   */
  dealSheetPrompt?: boolean;
  /**
   * The submission the seller record is showing, when it was opened from a
   * submission row: a partner contact (Offerpad) carries one deal per house it
   * sent, and the record then works that house (its stage, owner, underwriter
   * and activity), not the contact's.
   */
  personDealId?: string | null;
  /** What the last import in this session wrote, for the "View imported" list (LAST_IMPORT). */
  lastImport?: { kind: 'sellers' | 'submissions' | 'buyers' | 'vendors'; label: string; ids: string[] } | null;
  /** The submissions list narrowed to one partner (a submission's "All of Offerpad"). */
  subPartner?: { id: string; name: string } | null;
  buyerId: string;
  dispoId: string;
  /** The deal a dispo row opened, when one seller has more than one contract. */
  dispoDealId?: string | null;
  tcId: string;
  /** The deal a TC row opened, when one seller has more than one deal (a wholesaler's submissions). */
  tcDealId?: string | null;
  /**
   * Where this screen was opened from, `<screen>[:<record id>]` (lib/nav-hash).
   * go() sets it and the address carries it, so every Back link (BackLink,
   * `backFor`) survives a reload and a seller opened from a deal knows which.
   */
  navFrom: string | null;
  personTab: string;
  composerTab: string;
  composerText: string;
  comprTab: string;
  compsInc: Record<string, boolean>;
  rehabPreset: 'low' | 'med' | 'heavy';
  visionRun: boolean;
  exitSel: string;
  peopleList: string;
  /** Full smart-list order, including pins. Empty until the saved layout loads. */
  smartListOrder: string[];
  /** Labels pinned to the top of the smart-list rail. */
  pinnedSmartLists: string[];
  /** The row the arrow keys are on, and which list that index belongs to. */
  peopleCursor: number;
  cursorList: string;
  /** A record opened before the reload that carries it has landed (a merge into an archived duplicate). */
  recordLoading: string | null;
  /** Hidden from People and Buyers until Account restores them. The tag is the copy that survives a reload. */
  secretIds: string[];
  /** The name-and-access dialog for a new smart list. */
  smartListOpen: boolean;
  /** COMPR numbers just written to a deal, shown at once while the reload that carries them lands. */
  dealPatches: Record<string, Partial<Deal>>;
  /** Deals whose COMPR report was graded without most of the record's photos (pull's photos_missing). */
  comprPhotoGaps: Record<string, { own: number; graded: number }>;
  /** Sellers (person ids) whose Run COMPR is underway on the record, so the button says so. */
  comprRunning: string[];
  /** An offer just logged on a record, shown on it at once; the reload that follows carries the same price. */
  offerPatches: Record<string, string>;
  /** Buyers (database ids) waiting on the AI agent picker from Genius or a deal's campaign builder. */
  agentPick: number[] | null;
  /** Gmail-style quick text or email, anchored on the Talkr button. */
  quickReach: { channel: 'text' | 'email'; personId: string } | null;
  /** Email compose on the buyer record. Text uses the bar already on the page. */
  buyerCompose: 'email' | null;
  /** Centered slideshow of the photos we have on one property. */
  photoShow: { id: number; title: string; photos: string[]; index: number } | null;
  /** Photos just read out of a deal's Drive folder, by deal row id, until the next workspace load carries them. */
  drivePhotos: Record<string, string[]>;
  /** Visible column keys per smart list, so a column choice saves with the list. */
  peopleColsByList: Record<string, string[]>;
  colsOpen: boolean;
  peopleSel: Record<string, boolean>;
  peopleQ: string;
  /** Buyers list: which list chip is on, the arrow-key row, and list search/Genius filter. */
  buyerList: string;
  buyerCursor: number;
  buyerCursorList: string;
  buyerQ: string;
  buyerGeniusOnly: boolean;
  /** Vendor lists: narrow by type ('Any' | service_type) and by state ('Any' | 'TX' …), grouped or flat. */
  vendorType: string;
  vendorState: string;
  vendorView: 'grouped' | 'table';
  /** Deal sources: at least this many submissions ('Any' | '10+' …), and the order the list is in. */
  vendorSubs: string;
  vendorSort: string;
  /** The TC file's activity feed: everything, or one kind. */
  tcFeedFilter: 'All' | 'TC & Lane' | 'Calls' | 'Texts' | 'Email';
  /** Which table the Import screen writes to; set by whichever list opened it. */
  importKind: 'sellers' | 'submissions' | 'buyers' | 'vendors';
  dealsView: 'pipeline' | 'table';
  /** Deals screen shows the archive instead of live deals (migration 118). */
  dealsArchived: boolean;
  /** Columns added to the Deals board beyond the pipeline: a deal stage (Terminated…) or 'Seller · <seller stage>'. */
  dealExtraStages: string[];
  stageOverrides: Record<string, string>;
  /**
   * A live deal dropped on a board column (or moved by a stage picker), shown
   * there before the save lands. It retires once a read carries that stage, not
   * on the first read: another card's save reloads before this one has landed.
   */
  dealStageOverrides: Record<string, { stage: string }>;
  dragging: string | null;
  dispoFilter: string;
  dispoTab: string;
  campaignStep: number;
  campaignLaunched: boolean;
  acceptedOffer: string | null;
  matchQ: string;
  talkrFolder: string;
  talkrConv: string;
  dialerOpen: boolean;
  /**
   * Phones only: the full-screen phone is tucked away behind its "return to
   * call" pill while the call carries on. The dialer is still open.
   */
  phoneMin: boolean;
  /** The sample-data demo's scripted incoming call (/demo?ring=1). */
  demoIncoming: { from: string; name: string } | null;
  dialerTab: string;
  dialNumber: string;
  callState: 'idle' | 'live' | 'wrap';
  callSec: number;
  transcriptN: number;
  callTarget: CallTarget | null;
  muted: boolean;
  hold: boolean;
  rec: boolean;
  ai: boolean;
  /** In-call DTMF pad. */
  keypadOpen: boolean;
  /** The warm-transfer / conference picker under the call controls. */
  transferOpen: 'transfer' | 'conference' | null;
  transferTo: string;
  callerIdOpen: boolean;
  inboxChannel: string;
  inboxFilter: string;
  inboxConv: string;
  tasksView: string;
  /** The task the command bar opened on Tasks: highlighted and scrolled to. */
  taskFocus: string | null;
  tasksDone: Record<string, boolean>;
  /** Tasks just ticked done: still on screen while they fade out of an open list. */
  taskLeaving: Record<string, boolean>;
  // The TC overrides are per file, keyed by transaction id first: ticks and
  // stamps on one file must never show on another file of the same deal type,
  // or clear that file's T-2 gate in Lane's drive.
  /** Checklist ticks this session: tcDone[transaction id][task id]. */
  tcDone: Record<string, Record<string, boolean>>;
  /** HUD/CD lines verified this session: tcHud[transaction id][line id]. */
  tcHud: Record<string, Record<string, boolean>>;
  /** Optimistic TC file stamps until reload (review, owner sign-off, EMD received), per transaction id. */
  tcGates: Record<string, { review?: string | null; signoff?: string | null; emdReceived?: string | null }>;
  reportTab: string;
  reportRange: string;
  /** The ⌘K command bar. What is typed in it and which row is picked live in the bar itself. */
  searchOpen: boolean;
  /** The Contracts popup (People, Dispo, Buyers and the record's Contracts button). */
  contractsOpen: boolean;
  /** What the command bar opens with already typed ('' for an empty bar). */
  searchQ: string;
  /** Bumped to move focus into the record's composer (the command bar's "text kara" hands off here). */
  composerFocusSeq: number;
  /** The record's Make offer sheet. Leaving the screen closes it. */
  offerSheetOpen: boolean;
  /** The last records opened, newest first: 'person:<id>' or 'buyer:<id>'. The command bar lists them on an empty query. */
  recentIds: string[];
  quickAddOpen: boolean;
  /** The buyer profile form: null closed; buyerId null = new buyer. Live mode only. */
  profileOpen: { buyerId: number | null } | null;
  notifOpen: boolean;
  notifRead: Record<string, boolean>;
  aiOpen: boolean;
  aiQ: string;
  aiAnswer: AiAnswer | null;
  aiBusy: boolean;
  /** The live thread, so a follow-up question knows what was just asked. */
  aiHistory: AskTurn[];
  /** Home's scope: 'me', 'team', or a teammate's user id. Only an owner or admin can change it. */
  teamView: string;
  teamMenuOpen: boolean;
  accountMenuOpen: boolean;
  /** The Tools menu that holds the product links when the nav is too narrow for them. */
  toolsMenuOpen: boolean;
  toast: string | null;
  /** Bumped on every toast so the dismissal timer re-arms on a repeat message. */
  toastSeq: number;
  /**
   * The tone of the toast raised at `seq`. Keyed to the sequence rather than
   * stored bare, because a few writers set `toast` straight into state
   * (sendToThread, Quick Add), and those must read as info rather than
   * inherit the red of an error that came before them.
   */
  toastTone: { seq: number; tone: ToastTone } | null;
  /** A button on the toast raised at `seq` (Undo on a ticked task or a mute), keyed like `toastTone`. */
  toastAction: { seq: number; label: string; run: () => void } | null;
  /** Bumped on every dial so the call clock restarts on a call-during-a-call. */
  callSeq: number;
  tvMode: boolean;
  lbPeriod: string;
  lbSort: string;
  lbScope: string;
  lbQ: string;
  lbMenu: { period?: boolean; sort?: boolean; scope?: boolean };
  lbPointsOpen: boolean;
  lbBadgesOpen?: boolean;
  /** The head-to-head card's week, side by side. */
  lbH2hOpen?: boolean;
  /** Which Supabase-backed record list is showing on the `liveLists` screen. */
  liveSection: string;
  /** Records created in-session. Merged over the seed graph so every screen sees them. */
  newPeople: Person[];
  newDeals: Deal[];
  newComms: Communication[];
  newBuyers: Buyer[];
  newTasks: Task[];
  newVendors: Vendor[];
  newAppointments: { id: string; day: string; t: string; title: string; kind: string }[];
  /** Action plans created in the builder, and who is enrolled in what. */
  newPlans: ActionPlan[];
  newEnrollments: Enrollment[];
  planId: string;
  planDraft: { name: string; trigger: string; steps: PlanStep[] } | null;
  /** Smart lists saved from the current filter set. */
  savedLists: { id: string; name: string; filters: PeopleFilters; cols: string[]; access?: string[]; mine?: boolean }[];
  /** People toolbar filters. */
  pf: PeopleFilters;
  pfOpen: string | null;
  /** The People "More filters" panel: stage history, money, market, list stacking. */
  pfMoreOpen: boolean;
  /** The person whose offered deals the offer-gap drill-down is showing, prefixed id. */
  gapOpen: string | null;
  /** Calendar view toggle. */
  calView: string;
  /** True on phone-width viewports. Set after mount so SSR and hydration agree. */
  isMobile: boolean;
  /** The mobile "More" sheet listing screens that don't fit the tab bar. */
  moreOpen: boolean;
  notifCat: string;
  dismissedAlerts: Record<string, boolean>;
  buyerTab: string;
  /** Filter selections for the Deals / Dispo / Buyers / Tasks toolbars. */
  gf: {
    dealOwner: string; dealMarket: string; dealStatus: string;
    dispoMarket: string; dispoRep: string;
    /** Markets are filtered state-then-city (lib/market-geo), not by raw string. */
    buyerState: string; buyerCity: string; buyerEntity: string;
    buyerType: string; buyerStatus: string; buyerStage: string;
    /** 'Any' | 'Has phone' | 'No phone' and the email pair. */
    buyerPhone: string; buyerEmail: string;
    /** Who the buyer is assigned to (migration 128): rep names and/or 'Unassigned'. */
    buyerOwner?: string;
    /** A stage the buyer has ever been at (migration 125), and when they reached it. */
    buyerHistory?: string; buyerHistoryWhen?: string; buyerHistoryFrom?: string; buyerHistoryTo?: string;
    /** A deal already on the pipeline: the list is the buyers matched to it. */
    buyerDeal?: string;
    taskType: string; taskAssigned: string;
  };
  /** Which create dialog is open, and the field values it has collected. */
  addOpen: null | AddKind;
  addForm: Record<string, string>;
  /** A question the open dialog is waiting on (a duplicate, an address shared by co-sellers). */
  addAsk: AddAsk | null;
  /** The Ctrl+A archive prompt (components/ArchiveConfirm.tsx): who would be archived, and their open deals. */
  archiveAsk: ArchiveAsk | null;
  /** While the dialog checks before writing: what it is doing. */
  addBusy: string | null;
  /** Why the last save from the open dialog failed; the form stays as typed under it. */
  addError: string | null;
  /** What the open dialog was opened with (the record it is for), and the drafts put away per kind (lib/quick-add-draft). */
  addSeed: Record<string, string>;
  addDrafts: AddDrafts;
  /**
   * Messages sent from a thread composer, keyed `talkr:<id>` / `inbox:<id>` /
   * `buyer:<id>`. The threads themselves are scripted sample conversations, so
   * without somewhere to put it a sent message had nowhere to appear — which is
   * why Send used to be a toast and nothing else.
   */
  sent: Record<string, { text: string; time: string }[]>;
  /** Home queue items completed or snoozed this session, keyed by title. */
  queueCleared: Record<string, boolean>;
  /**
   * The call-queue session a rep is working through: the list as it stood when
   * Start session was pressed, in order, and how far along it is. A snapshot,
   * because the queue drops people as they are called and a list that moves
   * under the cursor is how the same person gets rung twice or someone gets
   * skipped. Null when no session is running.
   */
  queueRun: QueueRun | null;
  /** The session that just stopped, for the finished summary. */
  queueDone: QueueDone | null;
  /** A session saved in this browser that the rep can pick back up (lib/dial-session.ts). */
  queueResume: SavedRun | null;
  /** Suggested-queue people already called this session, so suggestions move on to someone else. */
  queueCalled: Record<string, boolean>;
  /** Which bulk-action picker is open above the People list. */
  bulkMenu: null | 'assign' | 'stage' | 'tag' | 'plan';
  /** The channel the People bulk composer is open on, or null when it is closed. */
  bulkSend: null | 'sms' | 'email' | 'rvm';
  /** Where "Start action plan" came from, so the builder can send you back. */
  planReturnTo: string | null;
  /** True while Claude is drafting a plan. */
  planDrafting: boolean;
  /** Channel filter on a record's communications timeline. */
  commsChannel: string;
  /** Teammate filter on a record's activity feed ('Any', a rep name, or 'System'). */
  recordUser: string;
  /** Pins set this session, by timeline entry id (null = unpinned); over the loaded ones. */
  pins: Record<string, { at: string; by: string | null } | null>;
  pinsOpen: boolean;
  /** Lane (TC assistant) drawer. */
  laneOpen: boolean;
  /**
   * The record the open Lane thread is about. go() leaves the drawer and the
   * thread up when you navigate, so the screen underneath can be a different
   * seller by the time a citation is clicked; following it must use the file
   * Lane actually read, not whatever is on screen now.
   */
  lanePersonId: string | null;
  laneQ: string;
  laneThread: LaneTurn[];
  laneBusy: boolean;
  /** My Lane chats, newest first (signed in: lane_chats; the sample: this session's). */
  laneChats: LaneChat[];
  /** The chat on screen; null is a new chat that has not been asked anything yet. */
  laneChatId: number | null;
  /** The drawer shows the chat list instead of a chat. */
  laneList: boolean;
  /** The sample workspace's chats live here, by id, since nothing stores them. */
  laneLocal: Record<number, LaneTurn[]>;
  /** Today: the row picked in the list (the call target wins while a call is up). */
  todaySel: string | null;
  /** Today's session ledger: sellers whose outcome was saved, by id. */
  todayDone: Record<string, TodayDone>;
  /** Set by an outcome save in a running session; the next call waits for the phone to go idle. */
  advanceAfterSave: boolean;
  /** "Log without calling" armed the picker for this seller. */
  logArmed: string | null;
};

export type AiCard = { t: string; s: string; go: () => void };
export type AiAnswer = {
  q: string;
  text: string;
  cards: AiCard[];
  /** Empty when the answer has no call to action; `hasCta` gates rendering. */
  cta: string;
  ctaGo: () => void;
  hasCards: boolean;
  hasCta: boolean;
};

/** Slideshow id so a late photo fetch cannot overwrite a newer one. */
let photoShowSeq = 0;
/** At most this many sellers re-read after one Talkr sync pass. */
const TALKR_REFRESH_MAX = 5;
/** The timer that drops a deal's on-screen COMPR numbers once the reload has them. */
const dealPatchTimers = new Map<string, number>();
/** The same for an offer just logged on a record. */
const offerPatchTimers = new Map<string, number>();
/** Lead stages a house is underwritten in: opening one pulls what COMPR has saved for it. */
const UNDERWRITING_STAGES = new Set(['New Submission', 'New Submissions', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete']);

const INITIAL: ClozrState = {
  screen: 'home', personId: 'p1', buyerId: 'b1', dispoId: 'p6', tcId: 'p6',
  personTab: 'Activity', composerTab: 'Text', composerText: '',
  comprTab: 'Overview', compsInc: {}, rehabPreset: 'med', visionRun: false, exitSel: 'Wholesale',
  peopleList: 'My Leads', smartListOrder: [], pinnedSmartLists: DEFAULT_PINNED_LISTS, peopleCursor: 0, cursorList: 'My Leads', secretIds: [], smartListOpen: false, dealPatches: {}, comprPhotoGaps: {}, comprRunning: [], offerPatches: {}, agentPick: null, quickReach: null, buyerCompose: null, photoShow: null, drivePhotos: {}, peopleColsByList: {}, colsOpen: false, peopleSel: {}, peopleQ: '', buyerList: 'buyers', buyerCursor: 0, buyerCursorList: 'buyers', buyerQ: '', buyerGeniusOnly: false, vendorType: 'Any', vendorState: 'Any', vendorSubs: 'Any', vendorSort: 'Name', vendorView: 'grouped', tcFeedFilter: 'All', importKind: 'sellers',
  dealsView: 'pipeline', dealsArchived: false, dealExtraStages: [], stageOverrides: {}, dealStageOverrides: {}, dragging: null,
  dispoFilter: 'Active Inventory', dispoTab: 'Overview', campaignStep: 1, campaignLaunched: false, acceptedOffer: null, matchQ: '', matchFilterOn: {}, mutedCats: {}, mutedUntil: {},
  talkrFolder: 'Inbox', talkrConv: 'i1',
  dialerOpen: false, phoneMin: false, demoIncoming: null, dialerTab: 'Dial', dialNumber: '', callState: 'idle', callSec: 0, transcriptN: 0,
  callTarget: null, muted: false, hold: false, rec: true, ai: true,
  keypadOpen: false, transferOpen: null, transferTo: '', callerIdOpen: false,
  inboxChannel: 'All', inboxFilter: 'Mine', inboxConv: 'i1',
  tasksView: 'Today', taskFocus: null, tasksDone: {}, taskLeaving: {},
  tcDone: {}, tcHud: {}, tcGates: {}, reportTab: 'Overview', reportRange: '30 Days',
  searchOpen: false, contractsOpen: false, searchQ: '', composerFocusSeq: 0, offerSheetOpen: false, recentIds: [], quickAddOpen: false, profileOpen: null, notifOpen: false, notifRead: {}, aiOpen: false, aiQ: '', aiAnswer: null, aiBusy: false, aiHistory: [],
  teamView: 'me', teamMenuOpen: false, accountMenuOpen: false, toolsMenuOpen: false, toast: null, toastSeq: 0, toastTone: null, toastAction: null, callSeq: 0,
  tvMode: false,
  lbPeriod: 'last-30-days', lbSort: 'points', lbScope: 'all', lbQ: '', lbMenu: {}, lbPointsOpen: false,
  liveSection: 'Sellers',
  newPeople: [], newDeals: [], newComms: [], newBuyers: [], newTasks: [], newVendors: [],
  newAppointments: [], newPlans: [], newEnrollments: [], planId: 'ap1', planDraft: null,
  savedLists: [],
  navFrom: null, recordLoading: null,
  pf: {
    owner: 'Any', stage: 'Any', source: 'Any', tag: 'Any', date: 'Any', compr: 'Any', sort: 'Recent',
    gapBasis: 'Either', gapWithin: 'Within $20k', closeCalls: 'Any', declined: 'Any', submitter: 'Any',
    phone: 'Any', email: 'Any',
    history: 'Any', historyWhen: 'Ever', historyFrom: 'Any', historyTo: 'Any',
    offer: 'Any', offerMin: 'Any', offerMax: 'Any', arv: 'Any', arvMin: 'Any', arvMax: 'Any',
    market: 'Any', subs: 'Any', props: 'Any', stack: 'Any',
  },

  pfOpen: null, gapOpen: null, pfMoreOpen: false,
  calView: 'Week', isMobile: false, moreOpen: false, notifCat: 'All', buyerTab: 'Activity', dismissedAlerts: {},
  gf: { dealOwner: 'Any', dealMarket: 'Any', dealStatus: 'Any', dispoMarket: 'Any', dispoRep: 'Any', buyerState: 'Any', buyerCity: 'Any', buyerEntity: 'Any', buyerType: 'Any', buyerStatus: 'Any', buyerStage: 'Any', buyerPhone: 'Any', buyerEmail: 'Any', buyerOwner: 'Any', buyerHistory: 'Any', buyerHistoryWhen: 'Any', buyerHistoryFrom: 'Any', buyerHistoryTo: 'Any', buyerDeal: 'Any', taskType: 'Any', taskAssigned: 'Any' },
  addOpen: null, addForm: {}, sent: {}, queueCleared: {}, queueRun: null, queueDone: null, queueResume: null, queueCalled: {}, bulkMenu: null, bulkSend: null, planReturnTo: null, planDrafting: false,
  commsChannel: 'All', recordUser: 'Any', pins: {}, pinsOpen: true,
  laneOpen: false, lanePersonId: null, laneQ: '', laneThread: [], laneBusy: false, laneChats: [], laneChatId: null, laneList: false, laneLocal: {},
  addAsk: null, addBusy: null, addError: null, addSeed: {}, addDrafts: {}, archiveAsk: null,
  todaySel: null, todayDone: {}, advanceAfterSave: false, logArmed: null,
};

/** The suggested reply Inbox shows on its AI card and pastes with "Use reply". */
const INBOX_SUGGESTION =
  "Happy to — calling you in 5. If it's easier I can also send the revised numbers by text first.";

// ---- pure helpers -----------------------------------------------------------

// One formatter, built once: toLocaleString('en-US') builds a new one per call,
// and these run for every row on every render.
const EN_US = new Intl.NumberFormat('en-US');
const money = (n: number | null | undefined) => (n == null ? '—' : '$' + EN_US.format(Math.round(n)));
/**
 * A value built on first read, then kept. The view below is rebuilt on every
 * state change, keystrokes included, and most of its lists belong to one
 * screen: built lazily, a list costs nothing on the screens that never read it.
 */
const lazy = <T,>(build: () => T): (() => T) => {
  let built = false;
  let value: T;
  return () => {
    if (!built) { value = build(); built = true; }
    return value;
  };
};
/** "9/13/26": the deal tracker's dates. */
const TRACKER_DAY = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
const kFmt = (n: number | null | undefined) => (n == null ? '—' : '$' + Math.round(n / 1000) + 'K');
/** Stages that are no longer pipeline: their fees are booked or gone, not projected. */
const PIPELINE_DONE = new Set(['Closed', 'Terminated', 'Realtor Referral']);
const AMEND_LABEL: Record<string, string> = { offer_amount: 'Seller price', sold_price: 'Dispo price', marketed_price: 'Marketed price', marketed_fee: 'Marketed fee', dispo_fee: 'Dispo fee', assignment_fee: 'Assignment fee', target_assignment: 'Target assignment', price_drop: 'Price drop' };

/** "Marketed price −$5,000 · Sep 13" — the latest amended price on a deal, or ''. */
const amendedLabel = (d: Deal | undefined) => {
  const a = d?.amended;
  if (!a) return '';
  const amt = (a.delta < 0 ? '−$' : '+$') + EN_US.format(Math.abs(Math.round(a.delta)));
  return `${AMEND_LABEL[a.field] ?? a.field} ${amt} · ${new Date(a.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};

const STAGE_COLORS: Record<string, string> = {
  // A stage walk that reads left to right as a spectrum; green only once money is committed.
  'New Lead': '#0284c7', Contacted: '#64748b', Qualified: '#0891b2', Appointment: '#7c3aed',
  'Offer Sent': '#d97706', Negotiation: '#ea580c', 'Under Contract': '#15803d', Dispo: '#ff7a45',
  Assigned: '#c026d3', Closing: '#16a34a', Closed: '#18181b', Lost: '#dc2626',
};

const stageColor = (s: string) => STAGE_COLORS[s] || (isDealStage(s) ? dealStageColor(s) : sellerStageColor(s));
/** Scores read on the temperature scale (lib/heat.ts): hot red to cold blue, grey when unscored. */
const scoreColor = (n: number | null) => heatText(n);
/** HOT / WARM / COLD in the same colours. */
const tempColor = (t: string) => tempText(t);
/** A Back link was clicked; useClozr's history effect decides where it goes. */
const BACK_EVENT = 'clozr:back';
/**
 * What a live workspace takes from the bundled sample: product templates
 * only, the same for every workspace (lib/crm.ts says why). Everything else a
 * screen reads comes from lib/crm, and is empty when the workspace is.
 */
const LIVE_TEMPLATES: Pick<typeof MOCK, 'IMG' | 'tcChecklists' | 'rehab' | 'exits'> = {
  /** No stock photos on a real house: a record without a photo shows none. */
  IMG: {},
  /** The Acme Homes contract-to-close checklists, by deal type. */
  tcChecklists: MOCK.tcChecklists,
  /** Underwriting is COMPR's; a live record never borrows the sample's rehab or exits. */
  rehab: [],
  exits: [],
};
/** Screens a Back link may return to; a `from` naming anything else falls back to the screen's own default. */
const RECORD_BACK_SCREENS = [
  'today', 'home', 'inbox', 'tasks', 'calendar', 'deals', 'dispo', 'people', 'buyers', 'reporting', 'leaderboard',
  'dialer', 'dealSheet', 'tc', 'person', 'buyer', 'dispoProperty', 'plans', 'contracts', 'coaching', 'talkr', 'genius',
];
/** What a screen is called when something has to be said about it. */
const SCREEN_LABELS: Record<string, string> = {
  home: 'Home', people: 'People', person: 'Seller record', inbox: 'Inbox', tasks: 'Tasks', calendar: 'Calendar',
  deals: 'Deals', dispo: 'Dispo', dispoProperty: 'Dispo property', buyers: 'Buyers', buyer: 'Buyer record',
  tc: 'Transaction coordination', dealSheet: 'Deal sheet', import: 'Import', automations: 'Automations',
  plans: 'Action plans', reporting: 'Reporting', coaching: 'Coaching', leaderboard: 'Leaderboard', talkr: 'Talkr', dialer: 'Dialer', settings: 'Settings',
  account: 'Account', liveLists: 'Lists', genius: 'Genius Mode', buyr: 'Buyr', today: 'Today', contracts: 'Contracts',
  dealMachine: 'Deal Machine',
};

/**
 * The screens a link may name. The address carries the screen and, on a
 * record screen, the record: `#screen=person&id=s42`. It rides in the hash
 * rather than the query string so it never collides with the params the page
 * reads on arrival (Google's `?google=`), and because the router treats a
 * hash-only Back or Forward as the same page instead of re-rendering it.
 */
const URL_SCREENS = [
  'home', 'people', 'person', 'import', 'inbox', 'tasks', 'calendar', 'deals', 'dealSheet', 'dispo', 'dispoProperty',
  'buyers', 'buyer', 'genius', 'tc', 'reporting', 'dialer', 'plans', 'automations', 'leaderboard', 'settings',
  'account', 'liveLists', 'dealMachine', 'buyr', 'today', 'contracts', 'coaching',
] as const;
type UrlScreen = (typeof URL_SCREENS)[number];
/** Which piece of state holds the record a record screen shows. */
const RECORD_KEY: Partial<Record<string, 'personId' | 'buyerId' | 'dispoId' | 'tcId'>> = {
  person: 'personId', dealSheet: 'personId', buyer: 'buyerId', dispoProperty: 'dispoId', tc: 'tcId',
};
/**
 * The hash for a screen and its record. Home is the bare address, unless the
 * role lands somewhere else: then a bare address means that landing, and Home
 * has to say so to survive a reload.
 */
/** Quick-reach rows stay words: a short summary, else the plain text of the email. */
function reachBody(t: { body?: string; email?: { body?: string } | null }): string {
  const summary = t.body && !looksLikeHtml(t.body) ? t.body : '';
  const raw = t.email?.body || t.body || '';
  return (summary || emailPlain(raw)).replace(/\s+/g, ' ').trim();
}

function hashFor(screen: string, id: string | null, bareHome = true, deal?: string | null, from?: string | null): string {
  return encodeNavHash({ screen, id, deal: deal ?? null, from: from ?? null }, bareHome);
}
function readHash(): NavHash | null {
  return decodeNavHash(window.location.hash);
}
/** The record (and pinned house) a state has open on its screen, for `from` and the history index. */
function navRefOf(st: Pick<ClozrState, 'screen' | 'personId' | 'buyerId' | 'dispoId' | 'tcId' | 'dispoDealId' | 'personDealId' | 'dealSheetDealId' | 'tcDealId'>): NavRef {
  const k = RECORD_KEY[st.screen];
  return { screen: st.screen, id: k ? st[k] || null : null, deal: urlDealOf(st) };
}
/** The state that opens a NavRef's record on its screen, pinned to the same house. */
function recordStateFor(ref: NavRef): Partial<ClozrState> {
  const k = RECORD_KEY[ref.screen];
  if (!k) return {};
  return {
    ...(ref.id ? { [k]: ref.id, ...(ref.screen === 'tc' || ref.screen === 'dealSheet' ? { personId: ref.id } : {}) } : {}),
    // A seller-less deal sheet is its deal alone.
    ...(ref.screen === 'dealSheet' && !ref.id ? { personId: '' } : {}),
    ...dealPinsFor(ref.screen, ref.deal ?? null),
  };
}
const healthColor = (h: string) => (h === 'good' ? '#16a34a' : h === 'watch' ? '#d97706' : '#dc2626');
/** What the People search box matches a lead on: name first, then contact, property and tags. */
const personSearchKey = (p: Person) => searchKey(
  [p.name],
  [p.email, p.property.addr, p.property.city, p.property.st, p.property.zip, p.property.apn, p.market, p.source, ...p.tags],
  [p.phone],
);
/** What the Buyers search box matches: name and company first, then contact, markets and tags. */
const buyerSearchKey = (b: Buyer, placeLabels: string[]) => searchKey(
  [b.name, b.company],
  [b.email, b.type, b.buyerType, b.status, b.source, ...b.markets, ...placeLabels, ...visibleTags(b.tags ?? [])],
  [b.phone],
);
const initialsOf = (name: string | null | undefined) => (name ?? '').split(' ').map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase();


const LB_SORTS: [string, string][] = [['points', 'Points'], ['contracts', 'Contracts'], ['conversations', 'Conversations'], ['calls', 'Calls']];
const LB_SCOPES: [string, string][] = [['all', 'Individual'], ['acquisitions', 'Acquisitions'], ['disposition', 'Disposition']];

/** Toast wording per record type, shared by the live and demo paths. */
const ADD_SAVED: Record<string, string> = {
  seller: 'Lead added', property: 'Property added', buyer: 'Buyer added',
  vendor: 'Vendor added', deal: 'Deal created', task: 'Task created',
  appointment: 'Appointment set', note: 'Note added',
};

/** What the Quick Add dialog shows while its write is out. */
const ADD_SAVING = 'Saving…';

/** Put the Quick Add dialog away, keeping what was typed as that kind's draft. */
const putAwayAdd = (prev: ClozrState): Partial<ClozrState> => ({
  addOpen: null, addForm: {}, addAsk: null, addBusy: null, addError: null,
  addDrafts: prev.addOpen ? keepDraft(prev.addDrafts, prev.addOpen, prev.addSeed, prev.addForm) : prev.addDrafts,
});

/**
 * Stand-ins for a workspace with nothing in it.
 *
 * The record screens are written against "the seller you are looking at", and
 * in an empty workspace there is no such thing. Threading an optional through
 * the several hundred fields derived from it would touch every screen; a blank
 * record does not, and the screens show an empty state over the top of it.
 *
 * Before these existed an empty workspace did not render an empty CRM — it
 * threw on `P.id` and rendered nothing at all.
 */
const BLANK_PROPERTY: Property = {
  addr: '—', city: '', st: '', zip: '', beds: 0, baths: 0, sqft: 0, year: 0,
  lot: '—', type: '—', img: '', apn: '—',
};

const BLANK_PERSON: Person = {
  id: '', name: '—', stage: 'New Lead', score: 0, assigned: null, source: '—',
  phone: '—', email: '—', lastComm: '—', lastCommTs: null, nextTask: '—',
  offer: null, created: '—', tags: [], market: '—', motivation: '—',
  timeline: '—', condition: '—', occupancy: '—', mortgage: '—', asking: '—',
  desiredClose: '—', decisionMakers: '—', property: BLANK_PROPERTY,
};

const BLANK_BUYER: Buyer = {
  id: '', name: '—', company: '—', initials: '—', status: '—', markets: [],
  type: '—', engagement: 0, stars: 0, phone: '—', email: '—', pref: '—', doNot: '—',
  buyBox: {
    price: '—', year: '—', sqft: '—', beds: '—', baths: '—', type: '—', rehab: '—',
    exit: '—', minCap: '—', maxCashOut: '—', minCashFlow: '—', avoid: [],
  },
  match: 0, ceiling: '—', rehabTol: '—', strategy: '—', lastPurchase: '—',
  lastActivity: '—', offers: '0', why: [], issue: '',
  activity: { calls: 0, texts: 0, emails: 0, viewed: 0, clicks: 0, offers: 0, walkthroughs: 0, purchases: 0, declines: 0 },
  summary: [],
};

const BLANK_PLAN: ActionPlan = {
  id: '', name: 'No action plans yet', trigger: '—', active: false,
  description: '', steps: [],
};

/** A muted alert type as the bell names it: "texts", "calls", "offer alerts". */
const mutedLabel = (cat: string) => (cat === 'SMS' ? 'texts' : cat === 'Call' ? 'calls' : cat.toLowerCase() + ' alerts');

const BLANK_INBOX: InboxItem = {
  id: '', personId: null, buyerId: null, channel: 'SMS', preview: '—', time: '—',
  unread: 0, assigned: null,
};

// Lane chats (see openLane / runLane in useClozr).
/** Put a chat at the top of the list (it was just used), replacing its old row. */
const upsertLaneChat = (list: LaneChat[], c: LaneChat) => [c, ...list.filter((x) => x.id !== c.id)];
const laneSellerOf = (pid: string | null | undefined) => (pid && /^s\d+$/.test(pid) ? dbId(pid) : null);
/** The state that shows one chat. Signed in, its turns load in the Lane effect in useClozr. */
const laneChatPatch = (prev: ClozrState, id: number, local: boolean): Partial<ClozrState> => {
  const chat = prev.laneChats.find((c) => c.id === id);
  return {
    laneList: false, laneChatId: id, laneQ: '',
    lanePersonId: chat?.sellerId ? 's' + chat.sellerId : chat?.personId ?? null,
    laneThread: local ? prev.laneLocal[id] ?? [] : prev.laneChatId === id ? prev.laneThread : [],
  };
};

let clientNow: Date | null = null;
const NOW_STORE = {
  subscribe: () => () => {},
  // Cached, because getSnapshot must return the same value every call or React
  // re-renders forever.
  getSnapshot: (): Date | null => (clientNow ??= new Date()),
  getServerSnapshot: (): Date | null => null,
};

/** The sample graph's own stage names (lib/clozr-data). A workspace never has these; it reads seller_stages. */
const DEMO_CONTRACT_STAGES = ['Under Contract', 'Dispo', 'Assigned', 'Closing', 'Closed'];
/** Under contract or beyond. Live reads the seller stage list; only the sample adds its own names. */
const underContract = (stage: string, live = true) => sellerUnderContract(stage) || (!live && DEMO_CONTRACT_STAGES.includes(stage));

// ---- hook -------------------------------------------------------------------

/** The Matches-tab chips: each narrows the scored list on a fact the row already carries. */
const MATCH_CHIPS: { label: string; pass: (x: { score: number; status: string; mstatus: string }) => boolean }[] = [
  { label: 'Score ≥ 80', pass: (x) => x.score >= 80 },
  { label: 'VIP', pass: (x) => x.status === 'VIP' },
  { label: 'Vetted', pass: (x) => x.status === 'Vetted' || x.status === 'Institutional' },
  { label: 'Replied', pass: (x) => ['replied', 'interested', 'offered', 'under_contract', 'closed'].includes(x.mstatus) },
  { label: 'Hide passed', pass: (x) => x.mstatus !== 'not_interested' },
];

export function useClozr({ showAiCards = true, live = null, me = null, workspaceId = null, crmOk = true, crmPartial = false, reload, refreshSeller, refreshDeal, loadGallery, patchLocal, workspaceName = null, role = null, placesKey = null, talkrUrl = null, readOnly = false, offerSend = false, ready = true, board = undefined }: {
  /** Talkr Platform origin from Settings → Integrations; null means Talkr's production API. */
  talkrUrl?: string | null;
  showAiCards?: boolean;
  /**
   * The signed-in workspace, loaded by lib/crm.ts. Without it the hook runs on
   * the bundled sample graph — which is what /demo does, and what every screen
   * was built against.
   *
   * Merged over the mock rather than replacing it, because two kinds of thing
   * live in that module: workspace data, which `live` supplies, and reference
   * content — stage names, rehab presets, exit templates, the TC checklist
   * templates, the automation palette — which is the same for every workspace
   * and stays in the bundle.
   */
  live?: (Partial<Omit<typeof MOCK, 'STAGES'>> & {
    STAGES?: string[]; matches?: MatchView[]; offerGaps?: OfferGap[]; offerGapPeople?: OfferGapPerson[];
    archivedPeople?: Person[];
  }) | null;
  /** The signed-in user's id; the sample rep in the demo. */
  me?: string | null;
  /** The workspace every write is scoped to. Null in the demo, which saves nothing. */
  workspaceId?: number | null;
  /**
   * False when the workspace read failed. An empty workspace and an unreachable
   * database look identical on screen and mean opposite things, so the empty
   * states need to know which one they are showing.
   */
  crmOk?: boolean;
  /** The first screen shows the newest 1,000 sellers; the rest are still loading. */
  crmPartial?: boolean;
  /** The workspace's leaderboard settings (zone, exclusions, goals); the in-app board honours them like the TV feed. */
  board?: BoardSettings;
  /** Re-read the whole workspace after a bulk or structural write. No-op in the demo. */
  reload?: () => void;
  /** Re-read one seller and their deals after a save on that record (lib/use-crm.ts). */
  refreshSeller?: (sellerId: number) => Promise<void>;
  /** Re-read one deal's seller and deals after a save on that deal. */
  refreshDeal?: (dealId: number) => Promise<void>;
  /** Read every photo on these deals into their galleries. */
  loadGallery?: (dealIds: number[]) => Promise<void>;
  /** Change rows already on screen with no read (lib/use-crm.ts patchLocal). */
  patchLocal?: (table: PatchTable, row: { id: string } & Record<string, unknown>) => void;
  /** The workspace's own name, for the screens that used to say "Acme Homes". */
  workspaceName?: string | null;
  /** Google Places key from Settings → Integrations; address fields autocomplete when set. */
  placesKey?: string | null;
  /**
   * The signed-in user's role. Decides which screens exist in the nav and
   * which a direct navigation is allowed to reach. RLS enforces the same rule
   * on the data; this keeps the UI from offering doors the database will not
   * open. Null in the demo, which shows everything.
   */
  role?: Role | null;
  /** An admin's "View as" preview (lib/view-as.ts): everything renders, nothing writes. */
  readOnly?: boolean;
  /**
   * Settings → Offers "send right away". The offers function reads it as
   * `settings.offers.send ?? false`, so unset means the offer is created as a
   * draft and the TC is told it is ready to send; the copy says the same.
   */
  offerSend?: boolean;
  /**
   * True once the workspace and the role are loaded. The screen and record in
   * the URL are restored only then, so a reload is checked against the real
   * records and the real role rather than the sample graph it starts on.
   * The demo has nothing to wait for.
   */
  ready?: boolean;
} = {}) {
  const [s, setS] = useState<ClozrState>(INITIAL);
  const floorResetRev = useSyncExternalStore(subscribeLeaderboardResets, getLeaderboardResetRev, () => 0);
  const floorNotify = useFloorNotifyPrefs();
  // The smart-list order lives in localStorage. Read it after mount so the
  // server render and the first client render agree on the default pins.
  useEffect(() => {
    let cancel = false;
    queueMicrotask(() => {
      if (cancel) return;
      try {
        const raw = localStorage.getItem('clozr.smartListLayout');
        if (!raw) return;
        const j = JSON.parse(raw) as { order?: unknown; pinned?: unknown };
        const order = Array.isArray(j.order) ? j.order.filter((x): x is string => typeof x === 'string') : [];
        const pinned = Array.isArray(j.pinned) ? j.pinned.filter((x): x is string => typeof x === 'string') : DEFAULT_PINNED_LISTS;
        setS((st) => ({ ...st, smartListOrder: order, pinnedSmartLists: pinned }));
      } catch { /* a bad saved layout falls back to the defaults */ }
    });
    return () => { cancel = true; };
  }, []);
  // Dismissed bell rows (missed calls, texts) have no notifications row to
  // mark, so the ids live in the browser. Read after mount, same as the pins.
  useEffect(() => {
    let cancel = false;
    queueMicrotask(() => {
      if (cancel) return;
      const ids = loadDismissedNotifs();
      if (!ids.length) return;
      setS((st) => ({ ...st, notifRead: mergeDismissed(st.notifRead, ids) }));
    });
    return () => { cancel = true; };
  }, []);
  // The sample graph is the demo. A live workspace gets its own rows and only
  // the static templates on LIVE_TEMPLATES; nothing else from the sample can
  // fall through onto a signed-in screen (someone else's photos, rehab lines
  // or automation used to, wherever lib/crm had no key of its own).
  const D = useMemo(() => {
    const demo = {
      ...MOCK, matches: [] as MatchView[],
      offerGaps: [] as OfferGap[], offerGapPeople: [] as OfferGapPerson[], archivedPeople: [] as Person[],
      // The sample graph keeps its twelve stages.
      STAGES: MOCK.STAGES as unknown as Stage[],
    };
    if (!live) return demo;
    return {
      ...LIVE_TEMPLATES, matches: [] as MatchView[],
      offerGaps: [] as OfferGap[], offerGapPeople: [] as OfferGapPerson[], archivedPeople: [] as Person[],
      ...live,
      // Live workspaces hand over the deal-stage pipeline.
      STAGES: (live.STAGES ?? []) as unknown as Stage[],
    } as unknown as typeof demo;
  }, [live]);

  // A save on one record re-reads that record (five small reads), not the
  // whole workspace (about 29). Anything else, or the demo, reloads as before.
  const refreshPerson = useCallback((pid: string | null | undefined) => {
    const n = pid && /^s\d+$/.test(pid) ? Number(pid.slice(1)) : NaN;
    if (refreshSeller && Number.isFinite(n)) void refreshSeller(n);
    else reload?.();
  }, [refreshSeller, reload]);
  const refreshDealOf = useCallback((dealId: string | number | null | undefined, photos = false) => {
    const n = typeof dealId === 'number' ? dealId : dealId && /^d\d+$/.test(dealId) ? Number(dealId.slice(1)) : NaN;
    if (!refreshDeal || !Number.isFinite(n)) { reload?.(); return; }
    void refreshDeal(n);
    if (photos) void loadGallery?.([n]);
  }, [refreshDeal, loadGallery, reload]);

  // The open seller record's own communications, read by seller *or* deal:
  // the workspace load is the newest 500 rows across everyone and only by
  // seller, so a deal's email with its buyer or title company, or an older
  // thread, never reached the record. Merged into commsFor below.
  const [recordComms, setRecordComms] = useState<{ pid: string; rows: Communication[] } | null>(null);
  // The open seller record's own timeline (activity and messages, by seller and
  // deal): the workspace load is the newest few hundred across everyone.
  const [recordTimeline, setRecordTimeline] = useState<{ pid: string; rows: TimelineEntry[] } | null>(null);
  // The same for an open buyer record (loadBuyerTimeline).
  const [buyerRecordTimeline, setBuyerRecordTimeline] = useState<{ bid: string; rows: TimelineEntry[] } | null>(null);
  // The rep's own call queue (lib/call-queue.ts, migration 79): one per rep,
  // each seller or buyer on it once.
  const cq = useCallQueue(workspaceId, me);
  const REALTOR_PAGE = 50;
  const [realtorPin, setRealtorPin] = useState<Buyer | null>(null);
  const [realtorOffset, setRealtorOffset] = useState(0);
  const [realtorCorpusTotal, setRealtorCorpusTotal] = useState(0);
  const [realtorPage, setRealtorPage] = useState<{ rows: Buyer[]; total: number; loading: boolean }>({ rows: [], total: 0, loading: false });
  const [realtorMarkets, setRealtorMarkets] = useState<{ city: string; state: string; count: number }[]>([]);
  // Once per workspace: keyed on `live` itself, every save's reload re-ran two
  // RPCs over the six-figure realtor table.
  const liveOn = !!live;
  // Saved smart lists (lib/smart-lists.ts): the workspace's own once signed in,
  // this browser's in the demo. A failed read keeps what the session holds.
  const [smartListsReady, setSmartListsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadSmartLists<Partial<PeopleFilters>>(liveOn ? workspaceId : null, liveOn ? me : null).then((rows) => {
      if (!alive) return;
      if (rows) {
        setS((st) => ({
          ...st,
          savedLists: rows.map((l) => ({ id: l.id, name: l.name, filters: { ...INITIAL.pf, ...l.filters }, cols: l.cols, access: l.access, mine: l.mine })),
        }));
      }
      setSmartListsReady(true);
    });
    return () => { alive = false; };
  }, [liveOn, workspaceId, me]);
  useEffect(() => {
    if (!liveOn || workspaceId == null) return;
    let cancel = false;
    void loadRealtorCorpus(workspaceId, { q: '', limit: 0, offset: 0 }).then((res) => {
      if (!cancel && res.ok) setRealtorCorpusTotal(res.total);
    });
    return () => { cancel = true; };
  }, [liveOn, workspaceId]);
  // The markets walk the whole realtor corpus and only Buyers reads them (the
  // Realtors city and state filters, the map), so they load the first time
  // Buyers opens rather than on every app load. An empty answer (the RPC
  // failed or timed out) is asked again on the next visit.
  const onBuyersScreen = s.screen === 'buyers';
  const marketsFor = useRef<number | null>(null);
  useEffect(() => {
    if (!liveOn || workspaceId == null || !onBuyersScreen || marketsFor.current === workspaceId) return;
    const ws = workspaceId;
    marketsFor.current = ws;
    void loadRealtorMarkets(ws).then((m) => {
      if (marketsFor.current !== ws) return;
      setRealtorMarkets(m);
      if (!m.length) marketsFor.current = null;
    });
  }, [liveOn, workspaceId, onBuyersScreen]);
  useEffect(() => {
    if (!live || workspaceId == null || s.buyerList !== 'realtors') {
      let cancel = false;
      queueMicrotask(() => {
        if (cancel) return;
        setRealtorPage((cur) => (cur.rows.length || cur.loading ? { ...cur, rows: [], loading: false } : cur));
      });
      return () => { cancel = true; };
    }
    let cancel = false;
    const q = s.buyerQ.trim();
    // The Buyers city and state filters apply to the realtor page on the server.
    // The corpus is searched one state and city at a time: the first pick stands in for several.
    const stateName = picksOf(s.gf.buyerState)[0] ?? '';
    const geoState = stateName ? Object.keys(STATE_NAMES).find((c) => STATE_NAMES[c] === stateName) ?? '' : '';
    const geoCity = picksOf(s.gf.buyerCity)[0] ?? '';
    const handle = window.setTimeout(() => {
      setRealtorPage((cur) => ({ ...cur, loading: true }));
      void loadRealtorCorpus(workspaceId, { q, offset: realtorOffset, limit: REALTOR_PAGE, state: geoState, city: geoCity }).then((res) => {
        if (cancel) return;
        if (!res.ok) {
          setRealtorPage((cur) => ({ ...cur, loading: false }));
          return;
        }
        setRealtorPage({ rows: res.rows, total: res.total, loading: false });
        if (!q && !geoState && !geoCity) setRealtorCorpusTotal(res.total);
      });
    }, q ? 280 : 0);
    return () => { cancel = true; window.clearTimeout(handle); };
  }, [live, workspaceId, s.buyerList, s.buyerQ, realtorOffset, s.gf.buyerState, s.gf.buyerCity]);
  const recordPid = live && workspaceId != null && s.screen === 'person' && s.personId ? s.personId : null;
  const recordBid = live && workspaceId != null && s.screen === 'buyer' && s.buyerId ? s.buyerId : null;
  // A reply synced from Gmail, a text or a call filed on the open record redraws its feed.
  const feedNonce = useRecordFeedLive(workspaceId, { sellerId: recordPid ? dbId(recordPid) : null, buyerId: recordBid ? dbId(recordBid) : null });
  // The open record's stage history (migration 125), for its timeline: the
  // seller with every one of its deals, or the buyer. Reloaded with the
  // workspace, so a move made here shows on the next load.
  const [recordStages, setRecordStages] = useState<{ key: string; rows: StageEvent[] } | null>(null);
  const stageKey = recordPid ? 's:' + recordPid : live && workspaceId != null && s.screen === 'buyer' && s.buyerId ? 'b:' + s.buyerId : null;
  useEffect(() => {
    if (!stageKey || workspaceId == null) return;
    let alive = true;
    const [kind, id] = stageKey.split(':');
    void loadStageHistory(workspaceId, kind === 's' ? 'seller' : 'buyer', dbId(id))
      .then((rows) => { if (alive && rows) setRecordStages({ key: stageKey, rows }); });
    return () => { alive = false; };
  }, [stageKey, workspaceId, D]);

  // "Ever been at this stage", for the People and Buyers filters: the database
  // answers with ids (lib/stage-history), held against the question asked so
  // a stale answer never filters a new one. Asked again on every workspace
  // load, since a move made since then changes the answer.
  const peopleHistoryKey = live && workspaceId != null && s.pf.history && s.pf.history !== 'Any'
    ? ['seller', s.pf.history, s.pf.historyWhen ?? 'Ever', s.pf.historyFrom ?? 'Any', s.pf.historyTo ?? 'Any'].join('|') : null;
  const buyerHistoryKey = live && workspaceId != null && s.gf.buyerHistory && s.gf.buyerHistory !== 'Any'
    ? ['buyer', s.gf.buyerHistory, s.gf.buyerHistoryWhen ?? 'Ever', s.gf.buyerHistoryFrom ?? 'Any', s.gf.buyerHistoryTo ?? 'Any'].join('|') : null;
  const [historyHits, setHistoryHits] = useState<Record<string, HistoryMatch>>({});
  useEffect(() => {
    if (workspaceId == null) return;
    let alive = true;
    for (const key of [peopleHistoryKey, buyerHistoryKey]) {
      if (!key) continue;
      const [entity, stage, when, from, to] = key.split('|');
      const w = historyWindow(when, from, to);
      void stageHistoryIds(workspaceId, entity as 'seller' | 'buyer', stage, w.from, w.to).then((m) => {
        if (alive) setHistoryHits((h) => ({ ...h, [key]: m ?? { sellers: new Set(), deals: new Set(), buyers: new Set() } }));
      });
    }
    return () => { alive = false; };
  }, [peopleHistoryKey, buyerHistoryKey, workspaceId, D]);
  const recordDealIds = useMemo(
    () => (recordPid ? [...D.deals, ...s.newDeals].filter((d) => d.personId === recordPid).map((d) => dbId(d.id)) : []),
    [recordPid, D.deals, s.newDeals],
  );
  const recordDealKey = recordDealIds.join(',');
  // The workspace load has one cover photo per deal (migration 226); the open
  // seller record or Dispo property reads its deals' whole galleries. Only
  // deals still showing one photo or none are asked for, so a gallery
  // already loaded (it survives a record refresh) is not read again.
  const galleryPid = live && workspaceId != null
    ? (s.screen === 'person' ? s.personId : s.screen === 'dispoProperty' ? s.dispoId : null) || null
    : null;
  const galleryKey = galleryPid
    ? D.deals.filter((d) => d.personId === galleryPid && (d.photos?.length ?? 0) <= 1).map((d) => dbId(d.id)).filter(Number.isFinite).join(',')
    : '';
  useEffect(() => {
    if (!galleryKey || !loadGallery) return;
    void loadGallery(galleryKey.split(',').map(Number));
  }, [galleryKey, loadGallery]);
  const recordName = (recordPid && [...D.people, ...(D.archivedPeople ?? [])].find((p) => p.id === recordPid)?.name) || '';
  useEffect(() => {
    if (!recordPid || workspaceId == null) return;
    let alive = true;
    void loadRecordComms(workspaceId, dbId(recordPid), recordDealKey ? recordDealKey.split(',').map(Number) : [], recordName)
      .then((rows) => { if (alive && rows) setRecordComms({ pid: recordPid, rows }); });
    return () => { alive = false; };
  }, [recordPid, workspaceId, recordDealKey, recordName, s.newComms.length]);

  // The real phone. Signed in means Talkr: calls, transcript, intelligence and
  // the inbox come from Talkr Platform. The demo keeps the scripted call.
  const phoneEnabled = workspaceId != null;
  /**
   * A call the power dialer opened.
   *
   * `startCall` puts the screen on a call before it dials, which is how every
   * screen knows there is one. A dial session's Next creates the call on the
   * server and hands the record straight to the softphone, so it never passes
   * through there — and without this the audio would be live while the dialer
   * still showed a keypad.
   */
  // The view-model's phone lookup, for the callbacks above it (onCallOpened).
  const dialerRecordForRef = useRef<((number: string) => { target: CallTarget } | null) | null>(null);
  const onCallOpened = useCallback((call: CallDto) => {
    const other = call.direction === 'outbound' ? call.to_number : call.from_number;
    const shown = formatPhone(other);
    // The person behind the number, so the call is filed on them at hang-up
    // (setRecordTarget), the AI context knows who it is, and the wrap-up writes
    // to their record. A number on no record stays a bare number.
    const found = dialerRecordForRef.current?.(other)?.target ?? null;
    setS((prev) => ({
      ...prev,
      dialerOpen: true,
      phoneMin: false,
      dialerTab: 'Dial',
      callState: 'live',
      callSec: 0,
      transcriptN: 0,
      callSeq: prev.callSeq + 1,
      callTarget: found ? { ...found, phone: shown } : { name: call.contact_name ?? shown, phone: shown, personId: null },
      dialNumber: shown,
      keypadOpen: false,
      transferOpen: null,
      callerIdOpen: false,
    }));
  }, []);

  // Undoes onCallOpened when the browser could not open the leg (mic refused,
  // softphone down), the same way a failed click-to-call does in startCall.
  const onCallFailed = useCallback(() => {
    setS((prev) => ({ ...prev, callState: 'idle' }));
  }, []);

  const phone = useTalkrPhone({ enabled: phoneEnabled, talkrUrl, aiEnabled: s.ai, onCallOpened, onCallFailed });
  const alternates = useAlternateOwners(live ? workspaceId : null);
  const sp = phone.sp;
  const ME = me ?? 'taylor';
  /**
   * Writes persist only when this is a real workspace. The demo runs the same
   * code paths against session state and saves nothing, which is what makes it
   * safe to hand to a stranger.
   */
  const canWrite = !!live && workspaceId !== null && !readOnly;
  // Bell rows dismissed on another device (migration 189), merged in on top of
  // this browser's own list. Read again when the workspace data reloads.
  useEffect(() => {
    if (!live || workspaceId === null || !me) return;
    let cancel = false;
    void loadBellDismissals(workspaceId, me).then((ids) => {
      if (cancel || !ids?.length) return;
      setS((st) => ({ ...st, notifRead: mergeDismissed(st.notifRead, ids) }));
    });
    return () => { cancel = true; };
  }, [live, workspaceId, me]);

  /**
   * Today — null while prerendering, the real date on the client.
   *
   * The app ships as a static export built once and served for weeks, so a date
   * computed during the prerender would be the build date: wrong on screen, and
   * a hydration mismatch besides. useSyncExternalStore is the way to say "the
   * server and the client legitimately disagree here" without setting state
   * inside an effect. It is read once per session rather than ticking, so a tab
   * left open overnight keeps yesterday's date until it is reloaded.
   */
  const now = useSyncExternalStore(NOW_STORE.subscribe, NOW_STORE.getSnapshot, NOW_STORE.getServerSnapshot);
  const rep = useCallback((id: string | null | undefined) => (id ? D.team[id] : null), [D]);
  const repName = useCallback(
    (id: string | null | undefined) => rep(id)?.name ?? 'Unassigned', [rep]);
  /** Avatar letters. A leftover assigned/owner id is not always on the roster. */
  const repInit = useCallback(
    (id: string | null | undefined) => rep(id)?.initials ?? '—', [rep]);
  // The open record's own timeline (loadRecordTimeline): after repName, which names its rows.
  useEffect(() => {
    if (!recordPid || workspaceId == null) return;
    let alive = true;
    void loadRecordTimeline(workspaceId, dbId(recordPid), recordDealKey ? recordDealKey.split(',').map(Number) : [], recordName, (id) => repName(id))
      .then((rows) => { if (alive && rows) setRecordTimeline({ pid: recordPid, rows }); });
    return () => { alive = false; };
  }, [recordPid, workspaceId, recordDealKey, recordName, s.newComms.length, D, repName, feedNonce]);
  useEffect(() => {
    if (!recordBid || workspaceId == null) return;
    let alive = true;
    void loadBuyerTimeline(workspaceId, dbId(recordBid), (id) => repName(id))
      .then((rows) => { if (alive && rows) setBuyerRecordTimeline({ bid: recordBid, rows }); });
    return () => { alive = false; };
  }, [recordBid, workspaceId, D, repName, feedNonce]);
  /** Monotonic id source. A ref, not Date.now(), so render stays pure. */
  const uidRef = useRef(0);
  const nextId = useCallback((prefix: string) => prefix + '_' + (++uidRef.current).toString(36) + Math.random().toString(36).slice(2, 6), []);

  // Track the phone breakpoint. Starts false so the server-rendered markup and
  // the first client render agree; the effect corrects it immediately after.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const apply = () => setS((prev) => (prev.isMobile === mq.matches ? prev : { ...prev, isMobile: mq.matches }));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  /** Latest state, readable from callbacks that must not be re-created on every change. */
  const sRef = useRef(s);
  useEffect(() => { sRef.current = s; }, [s]);

  const set = useCallback((patch: Partial<ClozrState> | ((prev: ClozrState) => Partial<ClozrState>)) => {
    setS((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
  }, []);

  // Raising a toast is state only; the dismissal timer is owned by an effect
  // below. `toastSeq` re-arms it when the same message fires twice in a row.
  // Say 'success' only once a write has landed, and 'error' when it has not.
  //
  // With canWrite off, the branches below answer as the demo does: "Saved
  // (demo)", "Sign in to …", "… runs on a signed-in workspace." In a View-as
  // preview none of that is true — the admin is signed in, and nothing saved —
  // so those answers are swapped here, once, for the read-only one.
  const { confirm, confirmReason } = useConfirm();
  /** A TC note being saved (sendTcMsg), so a second Enter does not post it twice. */
  const tcNoteBusy = useRef(false);
  const toast = useCallback((msg: string, tone: ToastTone = 'info', action?: { label: string; run: () => void }) => {
    // A live workspace this user can't write to is read-only too, never "(demo)".
    if ((readOnly || (!!live && !canWrite)) && DEMO_ANSWER.test(msg)) { msg = readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE; tone = 'info'; }
    set((prev) => ({
      toast: msg, toastSeq: prev.toastSeq + 1, toastTone: { seq: prev.toastSeq + 1, tone },
      toastAction: action ? { seq: prev.toastSeq + 1, ...action } : null,
    }));
  }, [set, readOnly, live, canWrite]);
  // A toast with an Undo button; the shell shows it while this toast is up.
  const toastUndo = useCallback((msg: string, undo: () => void) => {
    toast(msg);
    set((prev) => ({ toastAction: { seq: prev.toastSeq, label: 'Undo', run: undo } }));
  }, [toast, set]);
  // The bell's Mute quiets one kind of alert for an hour, and says so: the
  // toast offers Undo, and the bell shows it until it ends (notifMutes).
  const unmuteCat = useCallback((cat: string) => set((st) => {
    const m = { ...st.mutedCats };
    const u = { ...st.mutedUntil };
    delete m[cat];
    delete u[cat];
    return { mutedCats: m, mutedUntil: u };
  }), [set]);
  const muteCat = useCallback((cat: string) => {
    const until = Date.now() + 3_600_000;
    set((st) => ({ mutedCats: { ...st.mutedCats, [cat]: true }, mutedUntil: { ...st.mutedUntil, [cat]: until } }));
    toastUndo('Muted ' + mutedLabel(cat) + ' for 1 hour', () => unmuteCat(cat));
  }, [set, toastUndo, unmuteCat]);
  // Each mute ends on its own hour. One timer for the soonest, owned by this
  // effect, so it is cleared on unmount and re-armed when the mutes change
  // (muted again since, that one keeps its own hour).
  const mutedUntil = s.mutedUntil;
  useEffect(() => {
    const entries = Object.entries(mutedUntil);
    if (!entries.length) return;
    const [cat, until] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    const t = setTimeout(() => { if (sRef.current.mutedUntil[cat] === until) unmuteCat(cat); }, Math.max(0, until - Date.now()));
    return () => clearTimeout(t);
  }, [mutedUntil, unmuteCat]);
  const calledBack = sp.calledBack;
  const clearCalledBack = sp.clearCalledBack;
  useEffect(() => {
    if (!calledBack) return;
    const who = calledBack;
    queueMicrotask(() => {
      toast(`${formatPhone(who)} called back while you were on a line. Finish this one, then ring them back.`);
      clearCalledBack();
    });
  }, [calledBack, clearCalledBack, toast]);
  const copyText = useCallback((label: string, text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).then(() => toast(label + ' copied'), () => toast('Copy blocked by the browser'));
    } else toast('Clipboard unavailable');
  }, [toast]);

  /**
   * Send whatever is in the shared composer into one thread.
   *
   * Every thread composer in the app — Talkr, Inbox, the buyer record — writes
   * to the same `composerText`, so a send has to clear it as well as record it.
   * They previously did neither: the message stayed in the box and never
   * appeared in the conversation.
   */
  const sendToThread = useCallback((key: string, msg: string) => {
    setS((prev) => {
      const text = prev.composerText.trim();
      if (!text) return { ...prev, toast: 'Type a message first', toastSeq: prev.toastSeq + 1 };
      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return {
        ...prev,
        composerText: '',
        sent: { ...prev.sent, [key]: [...(prev.sent[key] ?? []), { text, time }] },
        toast: msg,
        toastSeq: prev.toastSeq + 1,
      };
    });
  }, []);

  /**
   * Which screens this role can open, for the screens to hide the buttons
   * that lead anywhere else. The rule itself lives in lib/team.ts.
   */
  const can = useMemo(
    () => Object.fromEntries(URL_SCREENS.map((k) => [k, canSee(role, k)])) as Record<UrlScreen, boolean>,
    [role],
  );
  /** Where this role starts the day: the screen a bare address and the logo open. */
  const landing = landingFor(role);

  const go = useCallback((screen: string, extra?: Partial<ClozrState>) => {
    // A screen this role cannot see is not a destination. The buttons that
    // lead to one are hidden (see `can`); this is the net under anything that
    // slips through. It used to drop the rep on Home without a word, which
    // read as the button being broken, so stay put and say why.
    if (!canSee(role, screen)) {
      toast('That screen isn’t available for your role');
      return;
    }
    set((st) => {
      // A sticky QuickReach keeps its person while the rep browses other
      // screens — they asked to finish the message before closing it. Its
      // draft is its own (lib/compose-drafts), so the record composer here
      // starts from the record's own draft, never the quick box's text.
      const sticky = !!st.quickReach && !('quickReach' in (extra || {}) && (extra as { quickReach?: unknown }).quickReach === null);
      return {
        screen, quickAddOpen: false, notifOpen: false, searchOpen: false, contractsOpen: false,
        teamMenuOpen: false, accountMenuOpen: false, toolsMenuOpen: false, offerSheetOpen: false,
        composerText: '',
        ...(sticky ? { quickReach: st.quickReach } : {}),
        // Partnerships opens People on its submissions, never a seller list it does not have.
        ...(screen === 'people' && !peopleListOk(role, st.peopleList, st.savedLists.some((l) => l.name === st.peopleList)) ? { peopleList: PARTNER_START_LIST } : {}),
        // A record pinned to one submission (personDealId) stays pinned only while
        // you stay on it. Arriving from anywhere else without naming a house opens
        // the contact itself, not the house last opened from a submission list.
        ...(screen === 'person' && extra?.personId !== undefined && !('personDealId' in extra)
          && (st.screen !== 'person' || extra.personId !== st.personId) ? { personDealId: null } : {}),
        // The under-contract prompt belongs to the deal sheet it opened; leaving ends it.
        ...(screen !== 'dealSheet' ? { dealSheetPrompt: false } : {}),
        ...(screen !== 'tasks' ? { taskFocus: null } : {}),
        // "Start action plan" names where it came from; leaving Plans ends that.
        ...(screen !== 'plans' ? { planReturnTo: null } : {}),
        // Where this screen was opened from, for its Back link and the address
        // (`from=`). Staying on the screen (a tab, a filter, or walking record
        // to record with the arrows) keeps the one it had, so Back still goes
        // to the list or screen you started from.
        navFrom: screen === st.screen ? st.navFrom : formatFrom(navRefOf(st)),
        ...(extra || {}),
      };
    });
  }, [set, role, toast]);

  // Every record opened goes to the front of recentIds (the command bar's empty-query list).
  const noteRecent = useCallback((key: string) => set((prev) => ({ recentIds: [key, ...prev.recentIds.filter((k) => k !== key)].slice(0, 8) })), [set]);
  const openPerson = useCallback((id: string) => { go('person', { personId: id, personTab: 'Activity', personDealId: null }); noteRecent('person:' + id); }, [go, noteRecent]);
  // A row that names one deal opens the record pinned to it. A wholesaler or
  // partner carries every house they sent on one contact, so the record left
  // unpinned shows their best-ranked deal: for Complete Homes, an old one.
  const openPersonDeal = useCallback((id: string, dealId: string | null | undefined) => {
    if (!dealId) return openPerson(id);
    go('person', { personId: id, personTab: 'Activity', personDealId: dealId });
    noteRecent('person:' + id);
  }, [go, noteRecent, openPerson]);
  const openBuyer = useCallback((id: string) => {
    const hit = realtorPage.rows.find((b) => b.id === id);
    if (hit) setRealtorPin(hit);
    go('buyer', { buyerId: id });
    noteRecent('buyer:' + id);
  }, [go, noteRecent, realtorPage.rows]);
  // A row that means "this deal" (a closing on Home, a notification, a search
  // hit) opens the deal where this role works it. Every role can open the
  // property record, so a role without Dispo or TC lands there instead of on
  // a screen it cannot see. Buttons that name the screen are hidden instead.
  const openDispo = useCallback((id: string, tab?: string, dealId?: string | null) => {
    // The record a role without Dispo lands on stays pinned to the same house.
    if (!canSee(role, 'dispoProperty')) return openPersonDeal(id, dealId);
    go('dispoProperty', { dispoId: id, dispoTab: tab || 'Overview', dispoDealId: dealId ?? null });
    noteRecent('person:' + id);
  }, [go, openPersonDeal, role, noteRecent]);
  const openTc = useCallback((id: string, dealId?: string | null) => (canSee(role, 'tc')
    ? go('tc', { tcId: id, personId: id, tcDealId: dealId ?? null })
    : openPersonDeal(id, dealId)), [go, openPersonDeal, role]);

  // ---- The address bar ------------------------------------------------------
  // The screen and its record live in the URL, so a reload comes back to the
  // same place and Back and Forward step through CLOZR's own screens. Every
  // navigation ends in state (go(), Quick Add, Lane's citations all set
  // `screen` directly), so the URL follows the state rather than go().

  /**
   * The URL key for a state: its screen and, on a record screen, the record
   * and the house it is pinned to (a partner's submission, a TC file, a deal
   * sheet), so Back, Forward and a reload come back to the same house.
   */
  const urlKeyOf = (st: Pick<ClozrState, 'screen' | 'personId' | 'buyerId' | 'dispoId' | 'tcId' | 'dispoDealId' | 'personDealId' | 'dealSheetDealId' | 'tcDealId' | 'navFrom'>) => {
    const k = RECORD_KEY[st.screen];
    const deal = urlDealOf(st);
    // A deal sheet with no seller (a submission whose seller is a vendor) is
    // keyed by its deal alone.
    if (st.screen === 'dealSheet' && !st.personId && deal) return hashFor('dealSheet', null, landing === 'home', deal, st.navFrom);
    // A record screen with no record open has nothing to link to; point the
    // address at the list it came from so a reload doesn't fail.
    if (k && !st[k]) return hashFor(st.screen === 'buyer' ? 'buyers' : st.screen === 'dispoProperty' ? 'dispo' : st.screen === 'tc' ? 'deals' : 'people', null);
    return hashFor(st.screen, k ? st[k] : null, landing === 'home', deal, st.navFrom);
  };
  /** What the address bar says right now, so a state that matches it is not pushed again. */
  const urlKeyRef = useRef<string | null>(null);
  /** False until the address has been read back into state once. */
  const restoredRef = useRef(false);
  /**
   * This tab's own history, by `history.state.clozrIdx`: what each entry
   * shows, so a Back link can tell whether the entry before this one is where
   * it goes (then history.back(), and browser Back agrees) or not (then it
   * replaces this entry). Entries from before a reload are unknown (null).
   */
  const navIdxRef = useRef(0);
  const navEntriesRef = useRef<(NavRef | null)[]>([]);
  /** The next address change replaces the current entry instead of pushing one (a Back link). */
  const replaceNextRef = useRef(false);
  const noteEntry = (idx: number, ref: NavRef | null) => {
    navIdxRef.current = idx;
    navEntriesRef.current[idx] = ref;
  };
  const historyIdx = (): number => {
    const st = window.history.state as { clozrIdx?: unknown } | null;
    return st && typeof st.clozrIdx === 'number' ? st.clozrIdx : 0;
  };

  /**
   * Put a screen named in the URL on screen, or Home when this role cannot
   * see it. A record that is not loaded (archived, or not in this workspace)
   * lands on the list it belongs to instead. Returns the hash that now
   * describes the state, so the caller can correct the address when it
   * named something that could not be opened.
   */
  const applyUrl = useCallback((): string => {
    const want = readHash();
    const prev = sRef.current;
    const people = [...D.people, ...prev.newPeople, ...(D.archivedPeople ?? [])];
    const buyers = [...D.buyers, ...prev.newBuyers];
    const known = !!want && (URL_SCREENS as readonly string[]).includes(want.screen);
    const key = want ? RECORD_KEY[want.screen] : undefined;
    // A deal sheet with no seller is keyed by its deal alone; the sheet loads
    // it by id and says so if it is gone.
    const bareSheet = want?.screen === 'dealSheet' && !want.id && !!want.deal;
    const found = !key || bareSheet || (!!want?.id && (key === 'buyerId'
      ? buyers.some((b) => b.id === want.id)
      : people.some((p) => p.id === want.id)));
    const ok = !!want && known && canSee(role, want.screen) && found;
    // A record that is not loaded: archived records are never loaded up front,
    // so look this one up and say which it is, on the list it belongs to.
    const list = want && known && canSee(role, want.screen) && !found ? recordListOf(want.screen) : null;
    const missList = list && canSee(role, list) ? list : null;
    if (want && !ok) {
      const kind = key === 'buyerId' ? 'buyer' : 'seller';
      const id = want.id ? dbId(want.id) : NaN;
      if (list && workspaceId != null && Number.isFinite(id)) {
        void isArchivedRecord(workspaceId, kind, id).then((archived) => toast(archived ? 'That record is archived' : 'That record isn’t in this workspace'));
      } else {
        toast(!known ? 'That link doesn’t point to a CLOZR screen'
          : !canSee(role, want.screen) ? 'That screen isn’t available for your role'
            : 'That record isn’t in this workspace');
      }
    }
    const screen = ok ? want!.screen : missList ?? landing;
    const deal = ok ? want?.deal ?? null : null;
    const record: Partial<ClozrState> = ok && key && (want!.id || bareSheet)
      ? { [key]: want!.id ?? '', ...(screen === 'tc' ? { personId: want!.id ?? '' } : {}), ...dealPinsFor(screen, deal) }
      : {};
    setS((st) => ({
      ...st, screen, ...record,
      quickAddOpen: false, notifOpen: false, searchOpen: false, teamMenuOpen: false, accountMenuOpen: false, toolsMenuOpen: false,
      moreOpen: false, composerText: st.screen === screen ? st.composerText : '',
      ...(screen === 'person' && st.screen !== 'person' ? { personTab: 'Activity' } : {}),
      // Where it was opened from, as the address says; nothing when it doesn't.
      navFrom: ok ? want!.from : null,
      ...(screen === 'people' && !peopleListOk(role, st.peopleList, st.savedLists.some((l) => l.name === st.peopleList)) ? { peopleList: PARTNER_START_LIST } : {}),
    }));
    return hashFor(screen, ok && want!.id && key ? want!.id : null, landing === 'home', deal, ok ? want!.from : null);
  }, [D, role, toast, landing, workspaceId]);

  // State → URL. Declared before the restore below so that, in the commit
  // where the restore runs, this sees the not-yet-restored state and waits.
  const urlKey = urlKeyOf(s);
  const urlRef = navRefOf(s);
  const urlRefKey = formatFrom(urlRef);
  useEffect(() => {
    if (!restoredRef.current || urlKey === urlKeyRef.current) return;
    urlKeyRef.current = urlKey;
    const ref = parseFrom(urlRefKey);
    // Keep the path and any query string the page reads; only the hash is ours.
    const url = window.location.pathname + window.location.search + urlKey;
    if (replaceNextRef.current) {
      replaceNextRef.current = false;
      noteEntry(navIdxRef.current, ref);
      window.history.replaceState({ clozrIdx: navIdxRef.current }, '', url);
      return;
    }
    const idx = navIdxRef.current + 1;
    // Anything forward of here is gone once a new entry is pushed.
    navEntriesRef.current.length = idx;
    noteEntry(idx, ref);
    window.history.pushState({ clozrIdx: idx }, '', url);
  }, [urlKey, urlRefKey]);

  // URL → state, once, when the records and the role are known.
  useEffect(() => {
    if (!ready || restoredRef.current) return;
    restoredRef.current = true;
    // A bare address is Home, which is where the app starts anyway; leave the
    // state alone rather than undo anything opened while the data loaded.
    // A role that lands elsewhere (acquisitions: Today) goes there, and the
    // address is replaced rather than pushed, so Back does not bounce off a
    // bare entry.
    const idx = historyIdx();
    const here = window.location.pathname + window.location.search;
    if (!readHash()) {
      if (landing !== 'home' && sRef.current.screen === 'home') {
        const key = hashFor(landing, null);
        setS((st) => ({ ...st, screen: landing }));
        urlKeyRef.current = key;
        noteEntry(idx, { screen: landing, id: null });
        window.history.replaceState({ ...(window.history.state ?? {}), clozrIdx: idx }, '', here + key);
        return;
      }
      urlKeyRef.current = '';
      noteEntry(idx, { screen: 'home', id: null });
      window.history.replaceState({ ...(window.history.state ?? {}), clozrIdx: idx }, '', here + window.location.hash);
      return;
    }
    const key = applyUrl();
    urlKeyRef.current = key;
    const at = decodeNavHash(key);
    noteEntry(idx, at ? { screen: at.screen, id: at.id } : { screen: 'home', id: null });
    window.history.replaceState({ ...(window.history.state ?? {}), clozrIdx: idx }, '', here + key);
  }, [ready, applyUrl, landing]);

  /**
   * What a Back link does when clicked (lib/nav-hash backAction): step back
   * when the entry before this one is where it goes, else replace this entry.
   * The links fire a `clozr:back` event and this effect answers it, because
   * the history index lives in refs, which the view-model can't read while it
   * renders.
   */
  useEffect(() => {
    const onBack = (e: Event) => {
      const { from, fallback } = (e as CustomEvent<{ from: NavRef | null; fallback: NavRef }>).detail;
      const act = backAction(from, navEntriesRef.current[navIdxRef.current - 1] ?? null, fallback);
      if (act.kind === 'history') { window.history.back(); return; }
      replaceNextRef.current = true;
      go(act.to.screen, { ...recordStateFor(act.to), navFrom: null });
      // When the address doesn't change (the fallback is where it already
      // points), no entry is written; don't let the flag turn the next
      // ordinary navigation into a replace. This click's effects have run by then.
      setTimeout(() => { replaceNextRef.current = false; }, 0);
    };
    window.addEventListener(BACK_EVENT, onBack);
    return () => window.removeEventListener(BACK_EVENT, onBack);
  }, [go]);

  // Back and Forward between CLOZR's own screens.
  useEffect(() => {
    const onPop = () => {
      if (!restoredRef.current) return;
      const idx = historyIdx();
      const key = applyUrl();
      urlKeyRef.current = key;
      const at = decodeNavHash(key);
      noteEntry(idx, at ? { screen: at.screen, id: at.id } : { screen: 'home', id: null });
      if (key !== window.location.hash) {
        window.history.replaceState({ clozrIdx: idx }, '', window.location.pathname + window.location.search + key);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyUrl]);

  // Starting a call is state only — the per-second tick is an effect keyed on
  // the call state, so it starts and stops with the call and cleans up on unmount.
  const placeCall = sp.placeCall;
  const hangupCall = sp.hangup;
  const resetPhone = phone.reset;
  /** Open the leg in this tab: the ordinary click-to-call. */
  const meNow = phone.data.me;
  const dialHere = useCallback((to: string, target?: CallTarget | null, opts?: { session?: boolean }) => {
    const shown = formatPhone(to);
    set((prev) => ({
      dialerOpen: true, phoneMin: false, dialerTab: 'Dial', callState: 'live', callSec: 0, transcriptN: 0,
      callSeq: prev.callSeq + 1,
      callTarget: target && target.name && target.name !== target.phone ? { ...target, phone: shown } : { name: shown, phone: shown, personId: target?.personId ?? null },
      dialNumber: shown, keypadOpen: false, transferOpen: null, callerIdOpen: false,
    }));
    const lines = meNow?.org_numbers ?? [];
    // A dedicated pin is the number the rep chose for one-off calls. A list
    // ignores it and rotates, so the list does not burn that one line.
    const pin = !opts?.session && meNow?.caller_id_mode === 'dedicated' ? meNow.default_phone_number_id : null;
    // The lead's state, so a same-state dialer-pool line is preferred when no line shares their area code.
    const lead = target?.personId ? [...D.people, ...s.newPeople].find((p) => p.id === target.personId) : undefined;
    const buyerRec = !lead && target?.buyerId ? [...D.buyers, ...s.newBuyers].find((b) => b.id === target.buyerId) : undefined;
    const destState = lead?.property?.st || (buyerRec ? marketState(buyerRec.markets) : null);
    void spinOrgCallerId({
      lines,
      dest: to,
      pinId: pin,
      load: recentOutboundFromNumbers,
      destState,
      linePools: () => loadLinePools(workspaceId),
    }).then((from) => {
      if (from?.notice) toast(from.notice, 'info');
      placeCall({ to_number: to, ...(from ? { from_phone_number_id: from.id } : {}) }).catch((err: Error & { code?: string }) => {
        set({ callState: 'idle' });
        // End pressed before anything was dialled: back to the keypad, quietly.
        if (err.code === 'cancelled') return;
        // Another tab has the phone. That is not a microphone failure, and
        // the softphone row already offers Use phone here.
        if (err.code === 'other_tab' || err.message === PHONE_OTHER_TAB) {
          toast(PHONE_OTHER_TAB, 'error');
          return;
        }
        // No tel: fallback: a call from the rep's own phone skips Talkr's DNC and
        // quiet-hours checks and is never logged. Say what broke instead.
        toast(err.code === 'device' ? 'Calling needs the microphone — allow it for this site and try again. ' + err.message : err.message, 'error');
      });
    }).catch((err: unknown) => {
      set({ callState: 'idle' });
      toast(err instanceof Error ? err.message : 'No Telnyx line is available for live calls.', 'error');
    });
  }, [set, placeCall, toast, meNow, D, workspaceId, s.newPeople, s.newBuyers]);

  /**
   * The seller or buyer behind a number that CLOZR itself says not to call: a
   * DNC tag, or a blacklisted buyer. Matched on the record the call carries and
   * on the number, so the same seller dialled from the keypad or a phone link
   * is caught too. Talkr's own suppression list still applies on top of this
   * whenever the call goes through Talkr; this is the half Talkr cannot see.
   */
  const doNotCall = useCallback((target: CallTarget | null | undefined): { name: string; reason: BlockReason } | null => {
    if (!target) return null;
    const e = toE164(target.phone ?? '');
    const same = (id: string, ph: string) => id === target.personId || id === target.buyerId || (!!e && toE164(ph) === e);
    const sellers = [...D.people.filter((p) => !s.newPeople.some((n) => n.id === p.id)), ...s.newPeople];
    // The blacklist first (secret tag, buyer blacklisted_at): the Blacklist
    // button only writes the secret tag, which the DNC pattern never matched.
    const hit = [...sellers, ...D.buyers, ...s.newBuyers].flatMap((x) => (same(x.id, x.phone) ? [{ name: x.name, reason: blockReason(x) }] : []));
    const found = hit.find((h) => h.reason === 'blacklisted') ?? hit.find((h) => h.reason);
    return found ? { name: found.name, reason: found.reason! } : null;
  }, [D.people, D.buyers, s.newPeople, s.newBuyers]);

  const talkrStatus = phone.data.status;
  /** Ring someone. False when nothing was dialled (refused, or no phone yet), which a session needs to know. */
  const startCall = useCallback((target?: CallTarget | null, opts?: { session?: boolean }): boolean => {
    const dnc = doNotCall(target);
    if (dnc) { toast(dnc.reason === 'blacklisted' ? `${dnc.name}: ${BLACKLIST_MESSAGE}` : `${dnc.name} is marked do not call.`, 'error'); return false; }
    if (phoneEnabled) {
      const to = toE164(target?.phone ?? '');
      if (!to) { toast('Enter a number to call'); return false; }
      const shown = formatPhone(to);
      // The extension holds the softphone: it is the only surface registered
      // with the carrier, so this tab has no leg to open. Hand the number over
      // rather than failing at a device that was never brought up — and if
      // the extension never reports the call, it is gone: dial here instead.
      if (phone.extension.holdingSoftphone && dialWithExtension(to, () => {
        toast('The Talkr extension didn’t pick that up — calling from this tab.');
        dialHere(to, target, opts);
      })) {
        set({ dialerOpen: false });
        toast(`Calling ${shown} in the Talkr extension`);
        return true;
      }
      // Talkr is down or refused: do not route around it. Its suppression
      // list, quiet hours and number guard only apply to calls it places.
      if (talkrStatus === 'unreachable' || talkrStatus === 'error') {
        toast('Talkr isn’t reachable right now, so the call was not placed. Try again in a moment.', 'error');
        return false;
      }
      // Talkr does not know this rep yet: the rep's own phone is the only way
      // left. CLOZR's do-not-call check above has already run, and the attempt
      // is logged as a note, not a call, since nothing confirms it was dialled
      // and Reporting must not count it as one.
      if (talkrStatus === 'unlinked') {
        const rec = target?.personId || target?.buyerId ? target : null;
        if (canWrite && workspaceId !== null && rec) {
          void createCommunication(workspaceId, {
            sellerId: rec.personId ? dbId(rec.personId) : null, buyerId: rec.buyerId ? dbId(rec.buyerId) : null,
            channel: 'note', direction: 'outbound',
            body: `Dialled ${shown} from the rep's own phone (Talkr was not available, so there is no recording or duration).`,
          }).then((r) => (r.ok ? refreshPerson(rec.personId) : toast('That call was not logged: ' + r.message, 'error')));
        }
        window.location.href = 'tel:' + to;
        return true;
      }
      if (talkrStatus !== 'ok') { toast('The phone is still connecting. Try again in a moment.'); return false; }
      dialHere(to, target, opts);
      return true;
    }
    set((prev) => ({
      dialerOpen: true, phoneMin: false, dialerTab: 'Dial', callState: 'live', callSec: 0, transcriptN: 1,
      callSeq: prev.callSeq + 1,
      callTarget: target || { name: 'Kara Mitchell', phone: '(210) 555-0136', personId: 'p1' },
      dialNumber: (target && target.phone) || '(210) 555-0136',
    }));
    return true;
  }, [set, phoneEnabled, toast, dialHere, phone.extension.holdingSoftphone, doNotCall, talkrStatus, canWrite, workspaceId, refreshPerson]);

  const endCall = useCallback(() => {
    if (phoneEnabled) hangupCall();
    set({ callState: 'wrap', keypadOpen: false, transferOpen: null });
  }, [set, phoneEnabled, hangupCall]);

  const finishCall = useCallback((msg: string, tone: ToastTone = 'info') => {
    if (phoneEnabled) resetPhone();
    // Back to the keypad for the next call; on a phone the full-screen phone
    // comes out from behind its pill, since that is where the wrap-up was saved.
    set({ callState: 'idle', callSec: 0, transcriptN: 0, hold: false, muted: false, keypadOpen: false, transferOpen: null, dialerTab: 'Dial', phoneMin: false });
    toast(msg, tone);
  }, [set, toast, phoneEnabled, resetPhone]);

  // /demo?ring=1: the sample data has no carrier to ring it, so the demo
  // stages one incoming call a moment after load. That is the only way to see
  // (and test) the incoming-call screen without a Talkr-linked workspace.
  useEffect(() => {
    if (phoneEnabled) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('ring') !== '1') return;
    url.searchParams.delete('ring');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    window.setTimeout(() => set({ demoIncoming: { from: '+12105550142', name: 'Maria Lopez' } }), 1200);
  }, [phoneEnabled, set]);

  // ?phone=keypad|recents|queue|voicemail opens the full-screen phone on that
  // tab (a Home Screen shortcut or a link), once the phone breakpoint is known.
  useEffect(() => {
    if (!s.isMobile) return;
    const url = new URL(window.location.href);
    const tab = ({ keypad: 'Dial', recents: 'Recent', queue: 'Queue', voicemail: 'Voicemail' } as Record<string, string>)[url.searchParams.get('phone') ?? ''];
    if (!url.searchParams.has('phone')) return;
    url.searchParams.delete('phone');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    // Deferred a tick: this reads the address bar, an outside system, once.
    if (tab) window.setTimeout(() => set({ dialerOpen: true, phoneMin: false, dialerTab: tab }), 0);
  }, [s.isMobile, set]);

  // The softphone is the source of truth for the call's phase: a seller who
  // hangs up ends the call whether or not the rep pressed the button. The
  // scripted state still drives the demo, so the two are reconciled here
  // rather than copied into `s` (which would be a render behind).
  const callState: ClozrState['callState'] = !phoneEnabled
    ? s.callState
    : sp.phase === 'wrapup'
      ? (s.callState === 'idle' ? 'idle' : 'wrap')
      : sp.phase === 'in_call'
        ? 'live'
        : s.callState;
  // Mute and hold read back from the softphone rather than being remembered here.
  const muted = phoneEnabled ? sp.muted : s.muted;
  const hold = phoneEnabled ? sp.onHold : s.hold;
  // In-call panels close with the call.
  const keypadOpen = s.keypadOpen && callState === 'live';
  const transferOpen = callState === 'live' ? s.transferOpen : null;

  // ⌘K the command bar, Escape, Q for Quick Add, then 1–8 to pick the kind
  // (the menu labels each row "Q 1" … "Q 8"). The Quick Add rows are built
  // with the view-model below; the handler reads them through a ref so a chord
  // typed before the next render still lands on the right row.
  const quickAddRef = useRef<(() => void)[]>([]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
      // e.code: ⌘K on a Dvorak or non-Latin layout still means the bar.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        e.stopPropagation();
        // Opening puts the Quick Add menu away, so a digit typed into the bar is never read as its chord.
        set((prev) => (prev.searchOpen ? { searchOpen: false } : { searchOpen: true, searchQ: '', quickAddOpen: false }));
        return;
      }
      if (e.key === 'Escape') {
        // In the Quick Add dialog Escape is the field's first: an open seller
        // picker or address list closes itself, and a field lets go of the
        // focus. Only then does Escape put the dialog away, and what was typed
        // waits as a draft for the next time it opens.
        const dialog = target?.closest<HTMLElement>('[data-screen-label="Create record"]');
        if (dialog && typing) {
          const menu = (target?.getAttribute('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true')
            || [...document.querySelectorAll<HTMLElement>('.pac-container')].some((p) => p.offsetParent !== null && p.childElementCount > 0);
          if (!menu) dialog.focus();
          return;
        }
        // The open command bar handles its own Escape: back out of a second
        // list first, and give focus back to where it was when it closes.
        set((prev) => (prev.searchOpen ? {} : { quickAddOpen: false, profileOpen: null, notifOpen: false, aiOpen: false, teamMenuOpen: false, accountMenuOpen: false, toolsMenuOpen: false, ...(prev.addOpen ? putAwayAdd(prev) : {}), laneOpen: false, colsOpen: false, pfOpen: null, gapOpen: null }));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!typing && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        set((prev) => ({ quickAddOpen: !prev.quickAddOpen }));
        return;
      }
      if (!typing && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        set((prev) => ({ laneOpen: !prev.laneOpen, aiOpen: false }));
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const go = quickAddRef.current[Number(e.key) - 1];
        set((prev) => {
          if (!prev.quickAddOpen || !go) return {};
          e.preventDefault();
          queueMicrotask(go);
          return {};
        });
      }
    };
    // Capture: the chord wins even when a screen (or a framed app) stops
    // propagation lower down.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [set]);

  // Live-call clock: ticks once a second while a call is up, and advances the
  // live transcript every four seconds.
  useEffect(() => {
    if (callState !== 'live') return;
    const id = setInterval(() => {
      set((prev) => ({
        callSec: phoneEnabled ? (sp.startedAt ? Math.floor((Date.now() - sp.startedAt) / 1000) : 0) : prev.callSec + 1,
        transcriptN: phoneEnabled ? 0 : Math.min(8, 1 + Math.floor(prev.callSec / 4)),
      }));
    }, 1000);
    return () => clearInterval(id);
  }, [callState, s.callSeq, set, phoneEnabled, sp.startedAt]);

  // The tone of the toast on screen now; anything raised without one is info.
  const toastTone: ToastTone = s.toastTone && s.toastTone.seq === s.toastSeq ? s.toastTone.tone : 'info';
  const toastAction = s.toastAction && s.toastAction.seq === s.toastSeq ? s.toastAction : null;

  // Auto-dismiss the toast. An error stays longer: it is the one message
  // that asks the reader to do something, and 2.6 seconds is not enough to
  // read "Could not save…" and what follows it.
  useEffect(() => {
    if (!s.toast) return;
    // One with a button (Undo) stays long enough to reach for it.
    const id = setTimeout(() => set({ toast: null }), toastTone === 'error' ? 6000 : toastAction ? 5000 : 2600);
    return () => clearTimeout(id);
  }, [s.toast, s.toastSeq, toastTone, toastAction, set]);

  // ---- graph writes ---------------------------------------------------------
  // Creating a record appends to the session graph in state; the view-model
  // memo merges it over the seed data, so a new seller or property is visible
  // on the record, in People, in search, on the pipeline and in reporting
  // immediately. Swap these for API POSTs when there is a backend.

  // Opening a kind with a draft waiting brings it back (lib/quick-add-draft);
  // a dialog already open is put away first, so its form is kept too.
  const openAdd = useCallback(
    (kind: AddKind, seed: Record<string, string> = {}) => set((prev) => {
      const drafts = prev.addOpen ? keepDraft(prev.addDrafts, prev.addOpen, prev.addSeed, prev.addForm) : prev.addDrafts;
      const draft = draftFor(drafts, kind, seed);
      return { addOpen: kind, addSeed: draft?.seed ?? seed, addForm: draft?.form ?? seed, addDrafts: drafts, quickAddOpen: false, addAsk: null, addBusy: null, addError: null };
    }),
    [set],
  );
  const closeAdd = useCallback(() => set(putAwayAdd), [set]);
  /** Clear: the form back to what it was opened with, and its draft gone. */
  const clearAdd = useCallback(() => set((prev) => (prev.addOpen && !prev.addBusy
    ? { addForm: prev.addSeed, addAsk: null, addError: null, addDrafts: dropDraft(prev.addDrafts, prev.addOpen) } : {})), [set]);
  // The form holds still while the dialog checks it (addBusy), so the answer is about what was typed.
  const setAddField = useCallback(
    (k: string, v: string) => set((prev) => (prev.addBusy ? {} : { addForm: { ...prev.addForm, [k]: v }, addError: null })),
    [set],
  );

  /**
   * Live Quick Add once nothing is left to ask: write, re-read, then open what
   * was made. The dialog holds the form until the write answers: a failed save
   * leaves everything as typed with the reason under it (or, put away
   * meanwhile, in its draft), and a saved one closes and opens the record.
   */
  const finishAdd = useCallback((kind: AddKind, typed: Record<string, string>) => {
    if (workspaceId === null) return;
    // A new deal closing on a Friday needs a typed reason first (createDeal logs it on the deal).
    const closeIso = kind === 'deal' && !typed.fridayReason ? parseDue(typed.close || '')?.slice(0, 10) ?? null : null;
    if (closeIso && isFridayIso(closeIso)) {
      void confirmReason(fridayOverrideAsk(closeIso)).then((why) => {
        if (!why) return set({ addError: 'Not saved. Pick a close date Monday to Thursday, or give a reason to keep Friday.' });
        write({ ...typed, fridayReason: why });
      });
      return;
    }
    write(typed);
    function write(typed: Record<string, string>) {
      if (workspaceId === null) return;
    // A TC adding a lead or a deal is its TC unless she picked someone else.
    const f = role === 'tc' && (kind === 'seller' || kind === 'deal') && !typed.tc && me ? { ...typed, tc: me } : typed;
    set({ addBusy: ADD_SAVING, addAsk: null, addError: null });
    void saveAdd(workspaceId, kind, f, me).then((r) => {
      // Still the dialog that sent it, not one put away or opened afresh meanwhile.
      const still = sRef.current.addOpen === kind && sRef.current.addBusy === ADD_SAVING;
      if (!r.ok) {
        const message = r.message || 'Could not save that.';
        set((prev) => (still ? { addBusy: null, addError: message }
          : prev.addDrafts[kind] ? {} : { addDrafts: keepDraft(prev.addDrafts, kind, {}, typed) }));
        return toast(still ? message : message + ' · Open Quick Add again to retry', 'error');
      }
      set((prev) => ({ ...(still ? { addOpen: null, addForm: {}, addAsk: null, addBusy: null, addError: null } : {}), addDrafts: dropDraft(prev.addDrafts, kind) }));
      reload?.();
      toast(kind === 'address' ? r.message || 'Address saved' : ADD_SAVED[kind] ?? 'Saved', 'success');
      // Straight to what was made, as the demo does. A task, an appointment or a
      // note stays where it was made; so does a property with nobody on it.
      if (r.id != null) {
        if (kind === 'seller') openPerson('s' + r.id);
        else if (kind === 'buyer') openBuyer('b' + r.id);
        else if (kind === 'deal' && f.personId) openPersonDeal(f.personId, r.dealId != null ? 'd' + r.dealId : null);
        else if (kind === 'property' && (f.personId || f.vendorId)) openPersonDeal('s' + r.id, r.dealId != null ? 'd' + r.dealId : null);
        else if (kind === 'property' && f.name?.trim()) openPerson('s' + r.id);
      }
      // COMPR runs on its own for a new lead, property or deal unless the form switched it off.
      // A property with nobody on it answers with the property's id, not a seller's.
      const bare = kind === 'property' && !f.personId && !f.vendorId && !f.name?.trim();
      const sellerId = kind === 'deal' ? (f.personId ? dbId(f.personId) : NaN) : bare ? NaN : r.id ?? NaN;
      const hasAddress = kind === 'deal' || !!(f.addr || '').trim();
      // A deal, or a house tied to a seller or a vendor, is underwritten as that deal's house.
      const onDeal = (kind === 'deal' || (kind === 'property' && (f.personId || f.vendorId))) ? r.dealId ?? null : null;
      if (['seller', 'property', 'deal'].includes(kind) && f.compr !== 'Off' && hasAddress && Number.isFinite(sellerId)) {
        void runCompr(workspaceId, sellerId, onDeal).then((c) => { toast(c.ok ? 'COMPR finished · numbers on the record' : 'COMPR: ' + c.message, c.ok ? 'success' : 'error'); if (c.ok) reload?.(); });
      }
    });
    }
  }, [workspaceId, me, role, reload, set, toast, openPerson, openBuyer, openPersonDeal, confirmReason]);

  /**
   * Creates whichever record the open dialog is for and wires it into the
   * graph. Every branch appends to session state, which the view-model memo
   * merges over the seed data — so a new record is visible everywhere that
   * reads the graph, not just on the screen that made it.
   */
  const submitAdd = useCallback(() => {
    // Live mode writes to Postgres and re-reads. Deliberately not optimistic:
    // an optimistic row carries an invented id, and when the re-read brings
    // back the real row you have the same record on screen twice. A short wait
    // beats a phantom duplicate in a CRM.
    if (canWrite) {
      const kind = s.addOpen;
      const f = s.addForm;
      if (!kind || s.addBusy || workspaceId === null) return;
      // A seller or buyer may already be here under that phone, email or
      // address: look first, and ask (AddAsk) rather than make a second one.
      // A new property typed with a new seller (or nobody) is checked as that
      // seller: the house may already be a lead here.
      // A check still out when the dialog was closed (or opened afresh) must
      // not go on to write: its form is no longer the one on screen.
      const still = () => sRef.current.addOpen === kind && sRef.current.addForm === f;
      const newSeller = kind === 'property' && !f.personId && !f.vendorId;
      if (kind === 'seller' || kind === 'buyer' || newSeller) {
        set({ addBusy: 'Checking for duplicates…' });
        void findQuickAddDuplicate(workspaceId, kind === 'buyer' ? 'buyer' : 'seller', f).then(
          (dupe) => { if (still()) { if (dupe) set({ addBusy: null, addAsk: { kind: 'dupe', dupe } }); else finishAdd(kind, f); } },
          () => { if (still()) finishAdd(kind, f); },
        );
        return;
      }
      // An address edit on a property other sellers share: just this seller, or everyone on it?
      // (Not asked when the address was left as it was.)
      const typed = [f.addr, f.city, [f.st, f.zip].filter((x) => x?.trim()).join(' ')].map((x) => (x ?? '').trim()).filter(Boolean).join(', ');
      if (kind === 'address' && f.editing && !f.scope && f.personId && typed !== f.was) {
        set({ addBusy: 'Checking who else is on this property…' });
        void sellersSharingProperty(workspaceId, f.personId).then((others) => {
          if (!still()) return;
          if (others.length) set({ addBusy: null, addAsk: { kind: 'scope', others, address: f.was || '' } });
          else finishAdd(kind, { ...f, scope: 'seller' });
        });
        return;
      }
      finishAdd(kind, f);
      return;
    }
    setS((prev) => {
      const f = prev.addForm;
      const val = (k: string) => (f[k] || '').trim();
      const name = val('name');
      const kind = prev.addOpen;
      if (!kind) return prev;
      const uid = nextId('r').slice(2);
      const done = (patch: Partial<ClozrState>, msg: string): ClozrState => ({
        ...prev, ...patch, addOpen: null, addForm: {}, addDrafts: dropDraft(prev.addDrafts, kind),
        toast: msg, toastSeq: prev.toastSeq + 1,
      });
      const allPeople = [...D.people, ...prev.newPeople];

      if (kind === 'seller' || kind === 'coseller') {
        if (!name) return prev;
        // A co-seller inherits the property of the record it was added from, so
        // heirs and spouses join one address instead of creating a second.
        // A new lead brings its own.
        const host = allPeople.find((p) => p.id === f.hostId);
        if (kind === 'coseller' && !host) return prev;
        if (kind === 'seller') {
          const pid = 'p_' + uid;
          const np: Person = {
            id: pid, name, stage: 'New Lead', score: null, assigned: null,
            source: val('source') || 'Manual',
            phone: val('phone') || '—', email: val('email') || '—',
            lastComm: 'No contact yet', lastCommTs: null, nextTask: 'No task scheduled',
            offer: null, created: 'Today', tags: [], market: val('city') || '—',
            motivation: val('motivation') || '—', timeline: '—', condition: '—',
            occupancy: '—', mortgage: '—', asking: val('asking') || '—',
            desiredClose: '—', decisionMakers: name,
            property: {
              addr: val('addr') || '—', city: val('city') || '—',
              st: (val('st') || '').toUpperCase(), zip: val('zip') || '—',
              beds: 0, baths: 0, sqft: 0, year: 0, lot: '—', type: 'SFR',
              img: D.IMG.a ?? '', apn: '—',
            },
          };
          return done(
            { newPeople: [...prev.newPeople, np], screen: 'person', personId: pid, personTab: 'Activity' },
            name + ' added',
          );
        }
        if (!host) return prev;
        const np: Person = {
          id: 'p_' + uid, name, stage: host.stage, score: host.score,
          assigned: host.assigned, source: 'Added on record',
          phone: val('phone') || '—', email: val('email') || '—',
          lastComm: '—', lastCommTs: null, nextTask: 'Introduce and confirm authority',
          offer: host.offer, created: 'Today', tags: val('role') ? [val('role')] : [],
          market: host.market, motivation: host.motivation, timeline: host.timeline,
          condition: host.condition, occupancy: host.occupancy, mortgage: host.mortgage,
          asking: host.asking, desiredClose: host.desiredClose,
          decisionMakers: host.decisionMakers, property: { ...host.property },
        };
        return done({ newPeople: [...prev.newPeople, np] }, name + ' added to ' + host.property.addr);
      }

      if (kind === 'address') {
        const addr = val('addr');
        if (!addr) return prev;
        const host = allPeople.find((p) => p.id === f.personId);
        if (!host) return prev;
        const patched: Person = {
          ...host,
          property: { ...host.property, addr, city: val('city') || host.property.city, st: (val('st') || host.property.st).toUpperCase(), zip: val('zip') || host.property.zip },
        };
        // The sample graph is immutable; a session override carries the edit.
        return done({ newPeople: [...prev.newPeople.filter((p) => p.id !== host.id), patched] }, 'Address saved');
      }

      if (kind === 'property') {
        const addr = val('addr');
        if (!name || !addr) return prev;
        const num = (k: string, fb: number) => {
          const n = parseInt((f[k] || '').replace(/[^0-9]/g, ''), 10);
          return Number.isFinite(n) && n > 0 ? n : fb;
        };
        const pid = 'p_' + uid;
        const np: Person = {
          id: pid, name, stage: 'New Lead', score: null, assigned: null, source: 'Added on record',
          phone: val('phone') || '—', email: val('email') || '—',
          lastComm: '—', lastCommTs: null, nextTask: 'First call · Now',
          offer: null, created: 'Today', tags: [], market: val('city') || 'Unassigned',
          motivation: '—', timeline: '—', condition: 'Unknown', occupancy: '—',
          mortgage: '—', asking: val('asking') || '—', desiredClose: '—', decisionMakers: name,
          property: {
            addr, city: val('city') || '—', st: (val('st') || 'TX').toUpperCase(), zip: val('zip') || '—',
            beds: num('beds', 3), baths: num('baths', 2), sqft: num('sqft', 1500),
            year: num('year', 1990), lot: val('lot') || '—', type: val('type') || 'SFR',
            img: D.IMG.a ?? '', apn: val('apn') || 'Pending',
          },
        };
        const nd: Deal = {
          id: 'd_' + uid, personId: pid, contract: null, arv: null, rehab: null,
          assignment: null, profit: null, close: null, daysInStage: 0, health: 'good', owner: null,
        };
        return done(
          { newPeople: [...prev.newPeople, np], newDeals: [...prev.newDeals, nd],
            screen: 'person', personId: pid, personTab: 'Activity' },
          addr + ' created',
        );
      }

      if (kind === 'buyer') {
        if (!name) return prev;
        const bid = 'b_' + uid;
        const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
        const markets = val('markets') ? val('markets').split(',').map((m) => m.trim()).filter(Boolean) : ['DFW'];
        const nb: Buyer = {
          id: bid, name, company: val('company') || name, initials, status: 'Active',
          markets, type: val('type') || 'Individual · Rental', engagement: 50, stars: 3,
          phone: val('phone') || '—', email: val('email') || '—', pref: 'SMS', doNot: '—',
          buyBox: {
            price: val('price') || '—', year: '—', sqft: '—', beds: '—', baths: '—',
            type: 'SFR', rehab: '—', exit: '—', minCap: '—', maxCashOut: '—', minCashFlow: '—', avoid: [],
          },
          match: 0, ceiling: val('price') || '—', rehabTol: '—', strategy: '—',
          lastPurchase: '—', lastActivity: 'Today', offers: '0 submitted',
          why: [], issue: 'Buy box is incomplete — fill it in to get match scores.',
          activity: { calls: 0, texts: 0, emails: 0, viewed: 0, clicks: 0, offers: 0, walkthroughs: 0, purchases: 0, declines: 0 },
          summary: ['Added today'],
        };
        return done(
          { newBuyers: [...prev.newBuyers, nb], screen: 'buyer', buyerId: bid },
          name + ' added to buyers',
        );
      }

      if (kind === 'deal') {
        // A deal attaches to an existing seller; that seller's stage moves with it.
        const host = allPeople.find((p) => p.id === f.personId);
        if (!host) return prev;
        const money = (k: string) => {
          const n = parseInt((f[k] || '').replace(/[^0-9]/g, ''), 10);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const nd: Deal = {
          id: 'd_' + uid, personId: host.id, contract: money('contract'), arv: money('arv'),
          rehab: money('rehab'), assignment: money('assignment'), profit: money('assignment'),
          close: val('close') || null, daysInStage: 0, health: 'good', owner: host.assigned,
        };
        const stage = val('stage') || 'Under Contract';
        return done(
          { newDeals: [...prev.newDeals, nd],
            stageOverrides: { ...prev.stageOverrides, [host.id]: stage },
            screen: 'person', personId: host.id },
          'Deal created on ' + host.property.addr,
        );
      }

      if (kind === 'task') {
        const title = val('title');
        if (!title) return prev;
        const host = allPeople.find((p) => p.id === f.personId) || allPeople[0];
        const due = val('due') || 'Today';
        const nt: Task = {
          id: 'k_' + uid, title, personId: host.id, type: val('type') || 'Call',
          due, assigned: host.assigned, priority: val('priority') || 'Medium', done: false,
          bucket: /overdue/i.test(due) ? 'overdue' : /today|now/i.test(due) ? 'today' : 'upcoming',
        };
        return done({ newTasks: [...prev.newTasks, nt] }, 'Task created · ' + title);
      }

      if (kind === 'appointment') {
        const title = val('title');
        if (!title) return prev;
        const na = {
          id: 'ap_' + uid, day: val('day') || 'Today', t: val('time') || '10:00 AM',
          title, kind: val('type') || 'Appointment',
        };
        return done({ newAppointments: [...prev.newAppointments, na] }, 'Appointment set · ' + title);
      }

      if (kind === 'note') {
        const body = val('body');
        if (!body) return prev;
        const host = allPeople.find((p) => p.id === f.personId) || allPeople[0];
        const nc: Communication = {
          id: 'c_' + uid, personId: host.id, channel: 'note', dir: 'out',
          party: host.name, user: ME, ts: 0, time: 'Just now', preview: body,
        };
        return done({ newComms: [...prev.newComms, nc] }, 'Note added to ' + host.name);
      }

      // vendor
      if (!name) return prev;
      const nv: Vendor = {
        id: 'v_' + uid, name, kind: val('kind') || 'Contractor', contact: val('contact') || '—',
        phone: val('phone') || '—', email: val('email') || '—', market: val('market') || 'All',
        rating: 0, note: val('note') || '',
      };
      return done({ newVendors: [...prev.newVendors, nv] }, name + ' added to vendors');
    });
  }, [nextId, D, ME, canWrite, s.addOpen, s.addForm, s.addBusy, workspaceId, set, finishAdd]);

  /**
   * The answer to the dialog's question. A duplicate: `fill` adds what was
   * typed to the record already here, `overwrite` writes it over, `create`
   * makes the new record anyway (sellers only), `cancel` goes back to the
   * form. An address shared by co-sellers: move just this seller, or everyone.
   */
  const resolveAddAsk = useCallback((choice: 'fill' | 'overwrite' | 'create' | 'seller' | 'everyone' | 'cancel') => {
    const ask = s.addAsk;
    const kind = s.addOpen;
    const f = s.addForm;
    if (!ask || !kind) return;
    if (choice === 'cancel') return set({ addAsk: null });
    if (!canWrite || workspaceId === null) return;
    if (ask.kind === 'scope') {
      if (choice === 'seller' || choice === 'everyone') finishAdd(kind, { ...f, scope: choice });
      return;
    }
    if (choice === 'create') { if (ask.dupe.canCreate) finishAdd(kind, f); return; }
    if (choice !== 'fill' && choice !== 'overwrite') return;
    const { dupe } = ask;
    // As finishAdd: the question stays up until the write answers, and a failure leaves it there to choose again.
    set({ addBusy: ADD_SAVING, addError: null });
    void mergeQuickAdd(workspaceId, dupe.kind, dupe.id, f, choice, me).then((r) => {
      const still = sRef.current.addOpen === kind && sRef.current.addBusy === ADD_SAVING;
      if (!r.ok) {
        if (still) set({ addBusy: null, addError: r.message || 'Could not save that.' });
        return toast(r.message || 'Could not save that.', 'error');
      }
      set((prev) => ({ ...(still ? { addOpen: null, addForm: {}, addAsk: null, addBusy: null, addError: null } : {}), addDrafts: dropDraft(prev.addDrafts, kind) }));
      reload?.();
      // An archived duplicate is not in the loaded graph until that reload
      // lands; the record says it is opening rather than "Pick a seller".
      if (dupe.kind === 'seller') { set({ recordLoading: 's' + dupe.id }); openPerson('s' + dupe.id); } else openBuyer('b' + dupe.id);
      toast(mergeToast(r.name || dupe.name, choice, r.changed ?? []), 'success');
    });
  }, [s.addAsk, s.addOpen, s.addForm, canWrite, workspaceId, me, set, finishAdd, reload, toast, openPerson, openBuyer]);

  /**
   * Mirror an optimistic change into the database.
   *
   * The screens move a card, tick a task and flip a stage against session state
   * so the UI answers immediately. These carry the same change to Postgres and,
   * once it lands, drop the local override and re-read — so what you end up
   * looking at is what was actually saved, not what we assumed.
   */
  const persistStage = useCallback((personId: string, stage: string, onSaved?: () => void) => {
    if (!canWrite) return;
    void setStageWrite(workspaceId, personId, stage, me).then((r) => {
      // Saved: the override stays until a load shows the stage (the effect
      // below). Dropping it here snapped the stage back for the whole reload.
      if (r.ok) { onSaved?.(); return refreshPerson(personId); }
      setS((prev) => {
        if (prev.stageOverrides[personId] !== stage) return prev;
        const next = { ...prev.stageOverrides };
        delete next[personId];
        return { ...prev, stageOverrides: next };
      });
      toast(r.message || 'Could not save that stage.', 'error');
    });
  }, [canWrite, workspaceId, me, refreshPerson, toast]);

  /** A submission's own stage (deals.lead_stage); the override is keyed 'sub:' + deal id. */
  const persistSubmissionStage = useCallback((dealIds: string[], stage: string, onSaved?: () => void) => {
    if (!canWrite || workspaceId == null) return;
    void setSubmissionStage(workspaceId, dealIds, stage, me).then((r) => {
      if (r.ok) {
        onSaved?.();
        // A few houses re-read alone; a bulk move re-reads the workspace.
        if (dealIds.length <= 3) dealIds.forEach((id) => refreshDealOf(id));
        else reload?.();
        return;
      }
      setS((prev) => {
        const next = { ...prev.stageOverrides };
        for (const id of dealIds) if (next['sub:' + id] === stage) delete next['sub:' + id];
        return { ...prev, stageOverrides: next };
      });
      toast(r.message || 'Could not save that stage.', 'error');
    });
  }, [canWrite, workspaceId, me, reload, refreshDealOf, toast]);

  // A saved stage override retires once loaded data carries the same stage.
  useEffect(() => {
    const keys = Object.keys(sRef.current.stageOverrides);
    if (!keys.length) return;
    const has = (k: string, st: string) => (k.startsWith('sub:')
      ? D.deals.some((d) => 'sub:' + d.id === k && d.leadStage === st)
      : D.people.some((p) => p.id === k && p.stage === st));
    setS((prev) => {
      const stale = Object.entries(prev.stageOverrides).filter(([k, st]) => has(k, st)).map(([k]) => k);
      if (!stale.length) return prev;
      const next = { ...prev.stageOverrides };
      for (const k of stale) delete next[k];
      return { ...prev, stageOverrides: next };
    });
  }, [D]);
  // The same for a deal moved on the pipeline: it retires once loaded data has
  // the deal at that stage (or the deal is gone).
  useEffect(() => {
    if (!Object.keys(sRef.current.dealStageOverrides).length) return;
    const byId = new Map(D.deals.map((d) => [d.id, d] as const));
    setS((prev) => {
      const stale = Object.entries(prev.dealStageOverrides).filter(([id, o]) => { const d = byId.get(id); return !d || d.stage === o.stage; }).map(([id]) => id);
      if (!stale.length) return prev;
      const next = { ...prev.dealStageOverrides };
      for (const id of stale) delete next[id];
      return { ...prev, dealStageOverrides: next };
    });
  }, [D]);
  // The record waiting on a reload (recordLoading) has it once the data changes.
  useEffect(() => {
    if (!sRef.current.recordLoading) return;
    setS((prev) => (prev.recordLoading ? { ...prev, recordLoading: null } : prev));
  }, [D]);

  /** A card moved on the pipeline: the deal's own stage. The seller follows in the database. */
  const persistDealStage = useCallback((dealId: string, stage: string, overrideNote?: string | null) => {
    if (!canWrite) return;
    // The card moves on the drop; the save and the full re-read follow. The
    // move holds until a load carries it (the effect below): the reload after
    // one card's save must not snap a second card dropped meanwhile back.
    setS((prev) => ({ ...prev, dealStageOverrides: { ...prev.dealStageOverrides, [dealId]: { stage } } }));
    void setDealStageWrite(workspaceId, dealId, stage, me).then((r) => {
      if (!r.ok) {
        setS((prev) => {
          if (prev.dealStageOverrides[dealId]?.stage !== stage) return prev;
          const next = { ...prev.dealStageOverrides };
          delete next[dealId];
          return { ...prev, dealStageOverrides: next };
        });
        return toast(r.message || 'Could not save that stage.', 'error');
      }
      reload?.();
      if (overrideNote && workspaceId != null) void logActivity(workspaceId, 'deal', dbId(dealId), 'stage', 'Ready To Market override', overrideNote, me).catch(() => {});
      if (stage === 'Ready To Market' && workspaceId != null) {
        const id = dbId(dealId);
        const row = D.deals.find((d) => d.id === dealId);
        const sellerId = row ? dbId(row.personId) : NaN;
        void import('@/lib/dispo').then(({ publishDeal }) => publishDeal(id)).catch(() => {});
        if (Number.isFinite(sellerId)) void syncComprMarketing(workspaceId, sellerId, id).catch(() => {});
      }
    });
  }, [canWrite, workspaceId, me, reload, toast, D.deals]);

  const persistTask = useCallback((taskId: string, done: boolean) => {
    if (!canWrite) return;
    void setTaskDone(taskId, done, me).then((r) => {
      if (!r.ok) {
        // The tick did not stick: put the box back the way the database has it.
        setS((prev) => {
          const next = { ...prev.tasksDone };
          delete next[taskId];
          return { ...prev, tasksDone: next };
        });
        return toast(r.message || 'Could not save that task.', 'error');
      }
      // The override stays: it is what the database now says, and it keeps a
      // just-completed task on screen (struck through) instead of vanishing.
      // The row changes in place; its seller's next task is re-read.
      if (!patchLocal) return reload?.();
      patchLocal('tasks', { id: taskId, done });
      refreshPerson(D.tasks.find((t) => t.id === taskId)?.personId);
    });
  }, [canWrite, me, reload, patchLocal, refreshPerson, D.tasks, toast]);

  /**
   * Move a task's due time, through the same write as the record's Reschedule,
   * and say `saved` only once it has landed. Snooze used to hide the row (or
   * un-tick the task) and announce it with nothing written, so the task was
   * back exactly where it was on the next load. `onFail` undoes whatever the
   * caller showed in the meantime.
   */
  const persistTaskDue = useCallback((taskId: string, due: Date, saved: string, onFail?: () => void) => {
    if (!canWrite) return toast(saved + ' (demo)');
    void setTaskDue(taskId, due.toISOString()).then((r) => {
      if (!r.ok) {
        onFail?.();
        return toast(r.message || 'Could not reschedule.', 'error');
      }
      toast(saved, 'success');
      if (!patchLocal) return reload?.();
      patchLocal('tasks', { id: taskId, ...taskDueFields(due.toISOString()) });
      refreshPerson(D.tasks.find((t) => t.id === taskId)?.personId);
    });
  }, [canWrite, reload, patchLocal, refreshPerson, D.tasks, toast]);

  // ---- Lane -----------------------------------------------------------------


  /** Show one chat. */
  const openLaneChat = useCallback((id: number) => set((prev) => ({ laneOpen: true, ...laneChatPatch(prev, id, workspaceId === null) })), [set, workspaceId]);

  // Signed in, the chat on screen is read from lane_messages whenever it
  // changes and whenever an answer lands: the stored chat is the truth (Lane
  // may have filed the question under that property's existing chat). A
  // question in flight wins; its answer re-runs this.
  const { laneChatId, laneBusy } = s;
  useEffect(() => {
    if (workspaceId === null || laneChatId == null || laneBusy) return;
    let gone = false;
    void loadLaneMessages(laneChatId).then((turns) => {
      if (!gone) setS((p) => (p.laneChatId === laneChatId && !p.laneBusy && (turns.length || !p.laneThread.length) ? { ...p, laneThread: turns } : p));
    });
    return () => { gone = true; };
  }, [workspaceId, laneChatId, laneBusy]);

  /**
   * Sends a question to Lane in the chat on screen and appends the turn.
   * Signed in, the `lane` edge function finds the records itself, keeps the
   * chat and files it under the property it is about — which can be another
   * property's own chat, and then that chat is the one shown. The sample
   * workspace answers from the stub in lib/lane.ts, from the file on screen.
   * `pid` asks about that record's property (the TC screen's sweep buttons).
   */
  const runLane = useCallback(
    (q: string, pid?: string) => {
      const question = (q || '').trim();
      if (!question) return;
      const cur = sRef.current;
      if (cur.laneBusy) return;
      // Asked from a record: that record's chat, whatever the drawer showed.
      const switching = !!pid && pid !== cur.lanePersonId;
      const personId = pid || cur.lanePersonId;
      const sellerDb = laneSellerOf(personId);
      const askedIn = switching ? cur.laneChats.find((c) => (sellerDb ? c.sellerId === sellerDb : c.personId === pid))?.id ?? null : cur.laneChatId;
      const history = switching ? (workspaceId === null && askedIn != null ? cur.laneLocal[askedIn] ?? [] : []) : cur.laneThread;
      const asked: LaneTurn = { role: 'tc', text: question };
      set({ laneQ: '', laneBusy: true, laneList: false, laneChatId: askedIn, lanePersonId: personId ?? null, laneThread: [...history, asked] });
      const tcName = teamTc(D.team)?.name ?? 'TC';

      // The sample has no records behind it: the stub answers from the file on screen.
      let context = null;
      if (workspaceId === null) {
        const p = [...D.people, ...cur.newPeople].find((x) => x.id === personId);
        const tx = p ? D.transactions.find((t) => t.personId === p.id) : undefined;
        if (p && tx) {
          const done = { ...tx.done };
          for (const [id, v] of Object.entries(cur.tcDone[tx.id] ?? {})) if (Number.isNaN(Number(id))) done[id] = v;
          const gates = cur.tcGates[tx.id] ?? {};
          context = laneContext({
            ...tx, done,
            hudDone: { ...tx.hudDone, ...cur.tcHud[tx.id] },
            tcReview: gates.review !== undefined ? gates.review : tx.tcReview,
            signoff: gates.signoff !== undefined ? gates.signoff : tx.signoff,
          }, {
            address: [p.property.addr, p.property.city, p.property.st].filter(Boolean).join(', '),
            seller: p.name,
            buyer: canSeeBuyers(role) ? (tx.buyerName || 'Harbor Capital · Chris Anderson') : 'not visible for this role',
            state: p.property.st || null,
            tcName,
          });
        }
      }

      askLane({
        question, context, history, workspaceId, tcName,
        chatId: askedIn,
        focus: askedIn == null && sellerDb ? { sellerId: sellerDb } : null,
      })
        .then((res) => {
          const answer: LaneTurn = { role: 'lane', text: res.answer, refs: res.refs, drafts: res.drafts, actions: res.actions, cards: res.cards };
          if (workspaceId === null) {
            // The sample: the chat lives in state, titled by the record it was asked on.
            setS((prev) => {
              const p = [...D.people, ...prev.newPeople].find((x) => x.id === personId);
              const id = askedIn ?? Date.now();
              const thread = [...history, asked, answer];
              const chat: LaneChat = { id, title: p?.property.addr || question.slice(0, 60), sellerId: null, personId: personId ?? null, dealId: null, address: p?.property.addr || null, updatedAt: new Date().toISOString() };
              const here = prev.laneChatId === askedIn;
              return {
                ...prev, laneBusy: false,
                laneLocal: { ...prev.laneLocal, [id]: thread },
                laneChats: upsertLaneChat(prev.laneChats, chat),
                ...(here ? { laneChatId: id, laneThread: thread } : {}),
              };
            });
            return;
          }
          const chat = res.chat ?? null;
          setS((prev) => {
            const here = prev.laneChatId === askedIn || (!!chat && prev.laneChatId === chat.id);
            return {
              ...prev, laneBusy: false,
              laneChats: chat ? upsertLaneChat(prev.laneChats, chat) : prev.laneChats,
              ...(here
                ? {
                    laneChatId: chat?.id ?? prev.laneChatId,
                    lanePersonId: chat?.sellerId ? 's' + chat.sellerId : prev.lanePersonId,
                    laneThread: res.movedFrom ? [asked, answer] : [...prev.laneThread, answer],
                  }
                : {}),
            };
          });
          if (chat && res.movedFrom) toast(`Filed under ${chat.title} — that property's chat`, 'success');
        })
        .catch((e: Error) => {
          setS((prev) => ({
            ...prev,
            laneBusy: false,
            laneThread: prev.laneChatId === askedIn
              ? [...prev.laneThread, { role: 'lane', text: `Lane is unavailable right now${e?.message ? ` — ${e.message}` : '.'}` } as LaneTurn]
              : prev.laneThread,
          }));
        });
    },
    [D, workspaceId, role, set, toast],
  );

  /**
   * Open Lane. From a record: that property's chat, or a new chat filed under
   * it. From the nav: the chat you were in, else your chats. Lane never swaps
   * the record on screen and never guesses a file: in a new chat it finds the
   * property from what you ask.
   */
  const openLane = useCallback((pid?: string) => {
    set((prev) => {
      const base = { laneOpen: true, aiOpen: false, moreOpen: false, searchOpen: false };
      if (!pid) return { ...base, laneList: prev.laneList || (prev.laneChatId == null && !prev.laneThread.length && prev.laneChats.length > 0) };
      const sellerDb = laneSellerOf(pid);
      const chat = prev.laneChats.find((c) => (sellerDb ? c.sellerId === sellerDb : c.personId === pid));
      if (chat) return chat.id === prev.laneChatId ? { ...base, laneList: false } : { ...base, ...laneChatPatch(prev, chat.id, workspaceId === null) };
      if (prev.lanePersonId === pid && prev.laneChatId == null) return { ...base, laneList: false };
      return { ...base, laneList: false, laneChatId: null, lanePersonId: pid, laneThread: [], laneQ: '' };
    });
    if (!pid && workspaceId !== null) void listLaneChats(workspaceId).then((chats) => { if (chats.length) set({ laneChats: chats }); });
  }, [set, workspaceId]);

  /** A new, empty chat: Lane files it once it knows the property. */
  const newLaneChat = useCallback(() => set({ laneOpen: true, laneList: false, laneChatId: null, lanePersonId: null, laneThread: [], laneQ: '' }), [set]);

  const removeLaneChat = useCallback((id: number, title: string) => {
    if (!window.confirm(`Delete the chat "${title}"? Its messages go with it.`)) return;
    const drop = () => set((prev) => ({
      laneChats: prev.laneChats.filter((c) => c.id !== id),
      ...(prev.laneChatId === id ? { laneChatId: null, laneThread: [], lanePersonId: null } : {}),
    }));
    if (workspaceId === null) { drop(); return; }
    void deleteLaneChat(id).then((ok) => (ok ? drop() : toast('That chat did not delete.', 'error')));
  }, [set, toast, workspaceId]);

  // My chats, once the workspace is known, so Lane opened from a record finds
  // that property's chat straight away.
  useEffect(() => {
    if (workspaceId === null) return;
    let gone = false;
    void listLaneChats(workspaceId).then((chats) => { if (!gone) set({ laneChats: chats }); });
    return () => { gone = true; };
  }, [workspaceId, set]);

  /**
   * Follow one of Lane's citations to the part of the file it names. Lane
   * answers over a side panel, so the screen underneath is wherever you were;
   * this puts the TC tab up and scrolls the section into view. Same shape as
   * openGenius below — the tab has to render before there is anything to
   * scroll to.
   */
  const openLaneRef = useCallback((target: LaneRefTarget) => {
    if (target === 'none') return;
    set((prev) => ({ screen: 'person', personId: prev.lanePersonId ?? prev.personId, personTab: 'TC' }));
    setTimeout(() => document.getElementById(`tc-${target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
  }, [set]);

  /** Open a dispo property on its Genius tab, on the deal that was clicked. */
  const openGenius = useCallback((id: string, dealId?: string | null) => openDispo(id, 'Genius', dealId), [openDispo]);

  const { aiBusy, aiHistory } = s;

  const askAi = useCallback((q: string, opts: { focus?: AskFocusItem[] } = {}) => {
    if (!q || !q.trim()) return;
    // A signed-in workspace goes to the `ask-clozr` edge function, which runs
    // a streaming tool loop over this workspace's own rows. Everything below it
    // is the scripted answer for the /demo sample graph, which has no server.
    if (live && workspaceId != null) {
      // One question at a time: a second would race its answer into the panel.
      if (aiBusy) return;
      const question = q.trim();
      const history = aiHistory;
      // A deal card carries the deal's id; the dispo screen is keyed on its seller.
      const openDeal = (id: string) => {
        const d = D.deals.find((x) => dbId(x.id) === Number(id.slice(1)));
        if (d) openDispo(d.personId, undefined, d.id); else toast('That deal is not in inventory any more.');
      };
      const open: Record<AskCardKind, (id: string) => void> = { seller: openPerson, buyer: openBuyer, deal: openDeal };
      const toCards = (list: AskCard[]): AiCard[] => list.map((c) => ({ t: c.title, s: c.subtitle, go: () => open[c.kind](`${c.kind === 'seller' ? 's' : c.kind === 'buyer' ? 'b' : 'd'}${c.id}`) }));
      const answer = (text: string, cards: AiCard[]) => ({ q: question, text, cards, cta: '', ctaGo: () => {}, hasCards: cards.length > 0, hasCta: false });
      set({ aiQ: '', aiOpen: true, aiBusy: true, aiAnswer: answer('Reading your records…', []) });
      // The answer streams in; the panel repaints at most every 60 ms.
      let text = '';
      let status = '';
      let cards: AiCard[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const paint = () => {
        timer = null;
        setS((prev) => (prev.aiBusy ? { ...prev, aiAnswer: answer(text || `${status || 'Reading your records'}…`, cards) } : prev));
      };
      const schedule = () => { if (!timer) timer = setTimeout(paint, 60); };
      void askClozr(workspaceId, question, history, {
        focus: opts.focus,
        onEvent: (e) => {
          if (e.type === 'text') text += e.text;
          else if (e.type === 'tool') status = e.status === 'start' ? TOOL_LABEL[e.name] ?? 'Working' : status;
          else if (e.type === 'cards') cards = toCards(e.cards);
          schedule();
        },
      })
        .then((r) => {
          if (timer) clearTimeout(timer);
          const turns: AskTurn[] = [{ role: 'user', text: question }, { role: 'clozr', text: r.answer }];
          set({ aiBusy: false, aiHistory: [...history, ...turns].slice(-6), aiAnswer: answer(r.answer, toCards(r.cards)) });
        })
        .catch((e: unknown) => {
          if (timer) clearTimeout(timer);
          const message = e instanceof Error ? e.message : 'Ask CLOZR could not answer.';
          set({
            aiBusy: false,
            aiAnswer: {
              q: question, text: `${text ? text.trim() + '\n\n' : ''}${message}\n\nFor a transaction file — title, earnest money, the HUD — Lane reads those.`,
              cards, cta: 'Ask Lane', ctaGo: () => { openLane(); set({ laneQ: question }); }, hasCards: cards.length > 0, hasCta: true,
            },
          });
        });
      return;
    }
    const lower = q.toLowerCase();
    let ans: { text: string; cards: AiCard[]; cta: string; ctaGo: () => void };

    const draft = 'Hi Ronald, Diego with Acme Homes. Saw you had a chance to look over the $186K offer on Cypress. '
      + 'Happy to walk through the numbers or adjust the close date — what would make this an easy yes for you and your wife?';
    const openDraft = () => {
      openPerson('p2');
      set({ composerTab: 'Text', composerText: draft, aiOpen: false });
    };

    if (lower.includes('call') && lower.includes('taylor')) {
      ans = {
        text: 'Taylor should call Kara Mitchell now — she reviewed the offer 18 minutes ago and texted asking for a call. After that: Harold Kim (voicemail confirming Saturday) and Derek Ross (repair breakdown due).',
        cards: [
          { t: 'Kara Mitchell', s: '123 Oakview Dr · Qualified · 92 HOT', go: () => openPerson('p1') },
          { t: 'Harold Kim', s: '9021 Brookhollow · Appointment · 79', go: () => openPerson('p12') },
          { t: 'Derek Ross', s: '81 Meadow Lane · Negotiation · 84', go: () => openPerson('p4') },
        ],
        cta: 'Start call queue (3)',
        ctaGo: () => startCall({ name: 'Kara Mitchell', phone: '(210) 555-0136', personId: 'p1' }),
      };
    } else if (lower.includes('opened an offer') || lower.includes("haven't been contacted")) {
      ans = {
        text: 'I found 2 sellers who opened an offer but have no outbound contact today.',
        cards: [
          { t: 'Ronald Moore', s: '1803 Cypress · opened 3× · last contact 3h ago', go: () => openPerson('p2') },
          { t: 'Gary Whitfield', s: '615 Lake Ridge · opened 1× · last contact 2d ago', go: () => openPerson('p7') },
        ],
        cta: 'Start call queue (2)',
        ctaGo: () => startCall({ name: 'Ronald Moore', phone: '(713) 555-0192', personId: 'p2' }),
      };
    } else if (lower.includes('at risk')) {
      ans = {
        text: '3 contracts are at risk. Pine Terrace is the most urgent — closing in 1 day with buyer EMD overdue.',
        cards: [
          { t: '388 Pine Terrace', s: 'Closing · buyer EMD overdue 6h', go: () => openTc('p8') },
          { t: '615 Lake Ridge', s: 'Offer Sent · expires Tue · no contact 2d', go: () => openPerson('p7') },
          { t: '81 Meadow Lane', s: 'Negotiation · 9 days in stage', go: () => openPerson('p4') },
        ],
        cta: 'Open TC file',
        ctaGo: () => openTc('p8'),
      };
    } else if (lower.includes('buyers for oakview') || lower.includes('find buyers')) {
      ans = {
        text: '4 buy boxes match 123 Oakview Drive at the target price. Amherst and Fortune Acquisitions are the strongest.',
        cards: [
          { t: 'Amherst', s: 'Match 96% · Institutional · SFR rental', go: () => openBuyer('b4') },
          { t: 'Fortune Acquisitions', s: 'Match 91% · Fund · heavy rehab OK', go: () => openBuyer('b5') },
          { t: 'Evergreen Residential', s: 'Match 86% · ceiling $260K is tight', go: () => openBuyer('b6') },
        ],
        cta: 'Open Buy Boxes in COMPR',
        ctaGo: () => set({ screen: 'person', personId: 'p1', comprTab: 'Buy Boxes', aiOpen: false }),
      };
    } else if (lower.includes('reject')) {
      const openComps = () => set({ screen: 'person', personId: 'p1', comprTab: 'Comps', aiOpen: false });
      ans = {
        text: '5109 Culebra Crossing was rejected because it crosses Culebra Rd (a major arterial) and belongs to the Culebra Park subdivision, which prices ~11% below Oakview Estates. 210 Timber Path was rejected for build era and story count.',
        cards: [{ t: '5109 Culebra Crossing', s: 'Rejected · arterial + subdivision cluster', go: openComps }],
        cta: 'Open comps',
        ctaGo: openComps,
      };
    } else if (lower.includes('conversion')) {
      const openTeam = () => go('reporting', { reportTab: 'Team', aiOpen: false });
      ans = {
        text: 'Taylor Reed has the best conversion this month: 22.0% contact-to-contract (9 contracts on 41 offers). Diego is at 19.4%.',
        cards: [
          { t: 'Taylor Reed', s: '684 calls · 41 offers · 9 contracts · $198,400', go: openTeam },
          { t: 'Diego Ortiz', s: '611 calls · 36 offers · 7 contracts · $164,900', go: openTeam },
        ],
        cta: 'Open team report',
        ctaGo: openTeam,
      };
    } else if (lower.includes('draft')) {
      ans = {
        text: `Draft for Ronald Moore:\n\n"${draft}"`,
        cards: [{ t: 'Ronald Moore', s: 'Insert into composer', go: openDraft }],
        cta: 'Open in composer',
        ctaGo: openDraft,
      };
    } else if (lower.includes('willow')) {
      ans = {
        text: '3 buyers opened Willow Street without submitting an offer. Blue Mesa is the warmest — viewed photos twice and requested a walkthrough.',
        cards: [
          { t: 'Blue Mesa Investments', s: 'Viewed 2× · walkthrough requested', go: () => openBuyer('b3') },
          { t: 'Fortune Acquisitions', s: 'Opened email · clicked report', go: () => openBuyer('b5') },
          { t: 'Lone Star Rentals', s: 'Opened email', go: () => openBuyer('b7') },
        ],
        cta: 'Text all 3',
        ctaGo: () => toast('SMS nudge sent to 3 buyers'),
      };
    } else {
      ans = {
        text: `I searched people, properties, deals, buyers and tasks for "${q}". Try one of the examples below, or ask about a seller, a property, or a rep.`,
        cards: [], cta: '', ctaGo: () => {},
      };
    }

    set({
      aiAnswer: { q, hasCards: ans.cards.length > 0, hasCta: !!ans.cta, ...ans },
      aiQ: '',
    });
  }, [go, openBuyer, openDispo, openPerson, openTc, set, startCall, toast, live, openLane, workspaceId, aiBusy, aiHistory]);

  // --------------------------------------------------------------------------
  // View-model
  // --------------------------------------------------------------------------
  // Talkr is the inbox when the workspace is signed in and Talkr knows the rep.
  const talkrLive = phoneEnabled && phone.data.status === 'ok';
  const activeConvId = talkrLive
    ? (phone.data.convs.some((c) => c.id === s.talkrConv) ? s.talkrConv : phone.data.convs[0]?.id ?? null)
    : null;
  const loadMessages = phone.loadMessages;
  useEffect(() => {
    if (activeConvId) loadMessages(activeConvId);
  }, [activeConvId, loadMessages]);
  // The open thread's number's texts outside Talkr (smrtPhone via Podio): our side of those conversations.
  const activeNumber = talkrLive ? (phone.data.convs.find((c) => c.id === activeConvId)?.their_number ?? null) : null;
  const [phoneTexts, setPhoneTexts] = useState<{ num: string; rows: PhoneText[] } | null>(null);
  useEffect(() => {
    if (!activeNumber || workspaceId == null) return;
    let alive = true;
    void loadPhoneTexts(workspaceId, activeNumber).then((rows) => { if (alive && rows) setPhoneTexts({ num: activeNumber, rows }); });
    return () => { alive = false; };
  }, [activeNumber, workspaceId]);

  /**
   * Talkr's threads, mirrored onto the CRM records they belong to.
   *
   * A seller's reply happens in Talkr with CLOZR nowhere near it, and Talkr
   * emits no message webhook to tell us. But the browser is already subscribed
   * to its event stream, so the moment a thread changes we copy it across.
   * Rows are keyed by Talkr's message id, so this is idempotent and a reply
   * lands on the record's timeline beside the text that prompted it.
   */
  const sellerByPhone = useMemo(
    () => indexByPhone(live?.people ?? [], dbId),
    [live],
  );
  const talkrSignature = [
    phone.data.convs.map((c) => c.id + ':' + (c.last_message_at ?? '')).join('|'),
    phone.data.history.map((h) => h.id + ':' + h.status).join('|'),
  ].join('#');
  const syncedRef = useRef('');
  useEffect(() => {
    if (!canWrite || workspaceId === null || talkrSignature === '#') return;
    if (syncedRef.current === talkrSignature) return;
    syncedRef.current = talkrSignature;
    // Only the sellers that got a new message or call are re-read; a busy
    // first pass (a new browser) leaves the rest to the next full load.
    void syncTalkrToRecords(workspaceId, phone.data.convs, phone.data.history, sellerByPhone, phone.data.me?.org?.id)
      .then((ids) => { for (const id of (ids ?? []).slice(0, TALKR_REFRESH_MAX)) refreshPerson('s' + id); });
    // The arrays are what talkrSignature summarises; depending on their
    // identity would re-sync on every poll that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talkrSignature, canWrite, workspaceId, sellerByPhone, refreshPerson]);

  // What the CRM knows about the party on the line, so the model does not
  // re-ask it and never voices our numbers.
  const setIntelContext = phone.setContext;
  const targetPersonId = s.callTarget?.personId ?? null;
  useEffect(() => {
    if (!phoneEnabled) return;
    const p = targetPersonId ? [...D.people, ...s.newPeople].find((x) => x.id === targetPersonId) : null;
    setIntelContext(
      p
        ? {
            contact_name: p.name,
            address: p.property?.addr ?? null,
            stage: s.stageOverrides[p.id] || p.stage,
            notes: [p.motivation, p.timeline, p.asking ? `asking ${p.asking}` : null].filter(Boolean).join(' · ') || null,
          }
        : s.callTarget
          ? { contact_name: s.callTarget.name }
          : null,
    );
  }, [phoneEnabled, targetPersonId, s.callTarget, s.newPeople, s.stageOverrides, D.people, setIntelContext]);

  // The record the call is filed on at hang-up: the one dialled, seller or buyer (lib/call-file.ts).
  const setRecordTarget = phone.setRecordTarget;
  const targetBuyerId = s.callTarget?.buyerId ?? null;
  // The deal it is about: the one the call was placed from, else the house the
  // record is pinned to. Unknown, call-file.ts takes the seller's newest.
  const targetDealId = s.callTarget?.dealId
    ?? (s.screen === 'person' && targetPersonId && s.personId === targetPersonId ? s.personDealId ?? null : null);
  useEffect(() => {
    const idOf = (v: string | null) => { const n = v ? dbId(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
    const sellerId = idOf(targetPersonId);
    const buyerId = sellerId === null ? idOf(targetBuyerId) : null;
    setRecordTarget(canWrite && workspaceId !== null && (sellerId !== null || buyerId !== null)
      ? { workspaceId, sellerId, buyerId, dealId: sellerId !== null ? idOf(targetDealId) : null } : null);
  }, [canWrite, workspaceId, targetPersonId, targetBuyerId, targetDealId, setRecordTarget]);

  // ---- Today's list ----------------------------------------------------------
  // Built here rather than inside the view-model, which re-renders every
  // second during a call (the call clock), so the list is rebuilt only when
  // the people, tasks, deals or the session ledger change (lib/today.ts).
  const todayVocab: Vocab = live ? 'live' : 'demo';
  const todayRules = useMemo(() => {
    if (!now) return { rows: [] as TodayRow[], more: 0 };
    const people = [
      ...D.people.map((p) => s.newPeople.find((n) => n.id === p.id) || p),
      ...s.newPeople.filter((n) => !D.people.some((p) => p.id === n.id)),
    ].map((p) => ({ ...p, stage: s.stageOverrides[p.id] || p.stage }));
    const tasks = [...D.tasks, ...s.newTasks].map((t) => ({ ...t, done: s.tasksDone[t.id] ?? t.done }));
    const best = new Map<string, Deal>();
    for (const d of [...D.deals, ...s.newDeals]) {
      const cur = best.get(d.personId);
      if (!cur || dealRank({ id: d.id, stage: d.stage, contract_date: d.tracker?.contractDate, submitted_at: d.submittedAt })
        > dealRank({ id: cur.id, stage: cur.stage, contract_date: cur.tracker?.contractDate, submitted_at: cur.submittedAt })) best.set(d.personId, d);
    }
    return buildToday({ people, tasks, dealOf: (pid) => best.get(pid), me: ME, now, vocab: todayVocab, done: s.todayDone, role });
  }, [D, s.newPeople, s.stageOverrides, s.newTasks, s.tasksDone, s.newDeals, s.todayDone, ME, now, todayVocab, role]);

  // The bell: only what is mine (lib/notif-dismiss forRep). A teammate's
  // text, call, voicemail or alert stays with them, for owners and admins too.
  // Deal sheet sections still blank on a live pipeline deal, for the rep on
  // that section (lib/section-gaps). The day is in the id, so one dismissed
  // today comes back tomorrow if the section is still blank.
  const sectionGapList = useMemo(() => {
    if (!live || !me) return [] as SectionGap[];
    const day = new Date().toISOString().slice(0, 10);
    return sectionGaps(D.deals, me, role === 'owner' || role === 'admin').map((g) => ({ ...g, id: `${g.id}:${day}` }));
  }, [D, live, me, role]);
  const myNotifications = useMemo(() => {
    if (!live) return D.notifications;
    const sellerRep = new Map<string, string | null>([...D.people, ...s.newPeople].map((p) => [p.id, p.assigned]));
    const buyerRep = new Map<string, string | null>(D.buyers.map((b) => [b.id, b.assigned ?? null]));
    const gaps: Notification[] = sectionGapList.map((g) => ({
      id: g.id, cat: GAP_BELL_CAT[g.cat], text: g.text, time: 'Deal sheet', unread: true, direct: true,
      link: { screen: 'person', id: g.personId },
    }));
    return [...gaps, ...forRep(D.notifications, ME, sellerRep, buyerRep, role === 'owner')];
  }, [D, s.newPeople, live, role, ME, sectionGapList]);

  // Clozr AI's order (lib/today-ai.ts): the rules' list shows first, the
  // ranked order swaps in when it lands, once per workspace, rep and day.
  // No key or any failure leaves the rules' order and its footer.
  const [todayAi, setTodayAi] = useState<{ key: string; rank: TodayAiRank } | null>(null);
  const todayRulesRef = useRef(todayRules);
  useEffect(() => { todayRulesRef.current = todayRules; }, [todayRules]);
  const todayAiCacheKey = live && ready && workspaceId != null && now && todayRules.rows.length ? todayAiKey(workspaceId, ME, now) : null;
  const todayAiName = ((me && D.team[me]?.name) || '').trim().split(/\s+/)[0] ?? '';
  useEffect(() => {
    if (!todayAiCacheKey || workspaceId == null) return;
    let cancel = false;
    void rankToday(todayAiCacheKey, workspaceId, todayAiName, todayCandidates(todayRulesRef.current.rows)).then((rank) => {
      if (!cancel && rank) setTodayAi({ key: todayAiCacheKey, rank });
    });
    return () => { cancel = true; };
  }, [todayAiCacheKey, workspaceId, todayAiName]);
  const todayAiNow = todayAi && todayAi.key === todayAiCacheKey ? todayAi.rank : null;
  const todayBase = useMemo(
    () => ({ ...todayRules, rows: mergeTodayAi(todayRules.rows, todayAiNow), source: todayAiNow ? 'ai' as const : 'rules' as const, greeting: todayAiNow?.greeting ?? '' }),
    [todayRules, todayAiNow],
  );

  // The buyer list's heavy per-row work: placing free-text markets, reading
  // the entity, and the row each buyer draws as. It only changes when the
  // buyers or the address book do, so it is not redone on every keystroke,
  // call tick or menu toggle the way everything inside V is.
  const buyerIndex = useMemo(() => {
    const buyers: Buyer[] = canSeeBuyers(role) ? [...D.buyers, ...s.newBuyers] : [];
    const people = [
      ...D.people.filter((p) => !s.newPeople.some((n) => n.id === p.id)),
      ...s.newPeople,
    ];
    // The city → state gazetteer is our own address history: a city we have
    // actually worked is a city we can place.
    const marketGaz = buildGazetteer(people.map((p) => ({ city: p.property.city, state: p.property.st })));
    const places = new Map<string, Place[]>(buyers.map((b) => [b.id, resolveMarkets(b.markets, marketGaz)]));
    const entityOf = new Map<string, EntityKind>(buyers.map((b) => [b.id, entityKind(b.name, b.company, b.entityType)]));
    const placesOf = (id: string) => places.get(id) ?? [];
    const rows = buyers.map((b) => ({ b, row: {
      id: b.id, company: b.company, name: b.name, initials: b.initials, status: b.status, stage: b.stage ?? '',
      statusColor: buyerStatusTone(b.status).fg,
      markets: (placesOf(b.id).some((p) => p.state) ? placesOf(b.id).map((p) => p.label) : b.markets).join(', '),
      marketList: b.markets, places: placesOf(b.id),
      placeLabels: placesOf(b.id).map((p) => p.label),
      entity: ENTITY_LABELS[entityOf.get(b.id) ?? 'unclear'],
      isLlc: entityOf.get(b.id) === 'llc',
      type: b.type, price: b.buyBox.price, exit: b.buyBox.exit,
      engagement: b.engagement, responseKnown: b.responseKnown !== false,
      tireKicker: b.tireKicker ?? isTireKicker({ sent: b.sent ?? null, responsePct: b.engagement, offers: b.activity?.offers ?? 0, purchases: b.activity?.purchases ?? 0 }),
      get engColor() { return responseTone(this.responseKnown ? this.engagement : null, this.tireKicker).text; },
      lastPurchase: b.lastPurchase, lastActivity: b.lastActivity, lastActivityAt: b.lastActivityAt ?? null, pref: b.pref,
      genius: (b.tags ?? []).includes('genius'),
      prospectList: b.prospectList ?? null,
      assigned: b.assigned ?? null, owner: b.assigned ? D.team[b.assigned]?.name ?? 'Teammate' : '',
      source: b.source ?? null,
      phone: b.phone && b.phone !== '—' ? b.phone : '', email: b.email && b.email !== '—' ? b.email : '',
      added: b.createdAt ? addedOn(b.createdAt) : '—', addedAt: b.createdAt || '',
      tags: visibleTags(b.tags ?? []).join(', '), buyerType: b.buyerType || '', offers: b.offers || '',
      strategy: b.strategy || '', ceiling: b.ceiling || '', doNot: b.doNot || '',
      // Every field the Buyers search box matches, normalized once (lib/list-search).
      search: buyerSearchKey(b, placesOf(b.id).map((p) => p.label)),
      open: () => openBuyer(b.id),
    } }));
    /** Buyers per state, for ordering the menu by where the desk actually works. */
    const stateCounts = new Map<string, number>();
    let unplacedBuyers = 0;
    for (const b of buyers) {
      const pl = placesOf(b.id);
      for (const st of new Set(pl.map((p) => p.state).filter((x): x is string => !!x))) {
        stateCounts.set(st, (stateCounts.get(st) ?? 0) + 1);
      }
      if (pl.some((p) => !p.state)) unplacedBuyers += 1;
    }
    // What the Buyers bulk bar looks each selected buyer up in.
    const bulk = Object.fromEntries(buyers.map((b) => [b.id, {
      dbId: dbId(b.id), name: b.name, company: b.company, phone: b.phone === '—' ? '' : b.phone, email: b.email === '—' ? '' : b.email,
      pref: b.pref, inactive: b.status === 'Inactive', blacklisted: !!b.blacklisted || b.status === 'Blacklisted',
      // VIP buyers and funds never go on an AI agent (lib/ai-agent-client, migration 123).
      protected: isProtectedBuyer({ vip: b.vip || b.status === 'VIP', buyerType: b.buyerType, entityType: b.entityType, type: b.type }),
    }]));
    // Every "City, ST" a buyer works, once and in menu order: the City filter
    // reads this instead of walking every buyer's places on each render.
    const cityPlaces = [...new Map(buyers.flatMap((b) => placesOf(b.id)).filter((p) => p.city).map((p) => [`${p.city}, ${p.state}`, p])).entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, p]) => ({ label, city: p.city!, state: p.state }));
    return { marketGaz, places, entityOf, rows, stateCounts, unplacedBuyers, bulk, cityPlaces };
  }, [role, D.buyers, D.team, s.newBuyers, D.people, s.newPeople, openBuyer]);

  // Each lead's search key (lib/list-search), built when the leads change
  // rather than on every search, so a query only runs substring checks.
  const peopleSearchKeys = useMemo(() => {
    const m = new Map<string, SearchKey>();
    for (const p of [...D.people, ...s.newPeople]) m.set(p.id, personSearchKey(p));
    return m;
  }, [D.people, s.newPeople]);

  // The merged graph (the loaded data with this session's edits), apart from
  // V. V rebuilds on every state change, the live-call clock each second and
  // every keystroke in a composer among them, and re-merging 13,000 people,
  // 5,000 deals and 12,000 buyers each time was a large share of that
  // rebuild. These change only when the data or a session edit does.
  const graph = useMemo(() => {
    // The live graph: the seed data with anything created this session merged in.
    // Every lookup below goes through these, so a new seller shows up on the
    // property, in People, in search, on the pipeline and in reporting at once.
    const people: Person[] = [
      ...D.people.map((p) => s.newPeople.find((n) => n.id === p.id) || p),
      ...s.newPeople.filter((n) => !D.people.some((p) => p.id === n.id)),
    ].map((p) => {
      // Copy only what a session stage move or a just-logged offer changed:
      // twelve thousand fresh objects per render was a cost on every keystroke.
      const stage = s.stageOverrides[p.id];
      const offer = s.offerPatches[p.id];
      const moved = !!stage && stage !== p.stage;
      const offered = offer !== undefined && offer !== p.offer;
      return moved || offered ? { ...p, ...(moved ? { stage } : {}), ...(offered ? { offer } : {}) } : p;
    });
    const deals: Deal[] = [...D.deals.map((d) => {
      const o = s.dealStageOverrides[d.id];
      const staged = o && o.stage !== d.stage ? { ...d, stage: o.stage } : d;
      const p = s.dealPatches[d.id];
      return p ? { ...staged, ...p } : staged;
    }), ...s.newDeals];
    // A 'Prospect' deal only holds a lead's underwriting numbers (every Podio
    // submission has one). The record still reads it; totals, closings and
    // boards count the deals that are real.
    const pipelineDeals = deals.filter((d) => d.stage !== 'Prospect' && !d.archived);
    const comms: Communication[] = [...D.communications, ...s.newComms];
    // Acquisitions never gets buyer records in the client graph — RLS already
    // empties the live load; scrubbing here covers demo / view-as too.
    const seeBuyers = canSeeBuyers(role);
    const buyers: Buyer[] = seeBuyers ? [...D.buyers, ...s.newBuyers] : [];
    const tasks: Task[] = [...D.tasks, ...s.newTasks];
    const vendors: Vendor[] = [...D.vendors, ...s.newVendors];
    // Session edits OVERRIDE the seed entry with the same id rather than sitting
    // after it, otherwise a lookup would keep finding the stale seed version.
    const plans: ActionPlan[] = [
      ...D.actionPlans.map((pl) => s.newPlans.find((n) => n.id === pl.id) || pl),
      ...s.newPlans.filter((n) => !D.actionPlans.some((pl) => pl.id === n.id)),
    ];
    // A session enrollment with planId '' and status 'done' is a tombstone: it
    // suppresses that contact's seed enrollment and is not itself listed.
    const enrollments: Enrollment[] = [
      ...D.enrollments.filter((e) => !s.newEnrollments.some((n) => {
        if (n.planId !== '' && n.planId !== e.planId) return false;
        if (e.buyerId) return !!n.buyerId && n.buyerId === e.buyerId;
        return !!n.personId && n.personId === e.personId;
      })),
      ...s.newEnrollments.filter((n) => n.status !== 'done'),
    ];
    // Shadow the module-scope helpers so nothing below can read the seed data alone.
    // By id, not a scan: with five figures of leads a find() per deal card,
    // task and inbox row was most of a render.
    const personById = new Map(people.map((p) => [p.id, p]));
    // An archived partner who still owns open submissions: reachable by id so
    // those submissions open the record, but on no People list or search.
    for (const p of D.archivedPeople ?? []) if (!personById.has(p.id)) personById.set(p.id, p);
    return { people, deals, pipelineDeals, comms, seeBuyers, buyers, tasks, vendors, plans, enrollments, personById };
  }, [D, role, s.newPeople, s.stageOverrides, s.offerPatches, s.dealStageOverrides, s.dealPatches, s.newDeals, s.newComms, s.newBuyers, s.newTasks, s.newVendors, s.newPlans, s.newEnrollments]);

  /** Hidden from People and Buyers until Account restores them (a session pick, or the tag that survives a reload). */
  const secretHidden = useCallback((id: string, tags?: string[] | null) => s.secretIds.includes(id) || isSecretBlacklisted(tags), [s.secretIds]);

  // The Buyers filters over every buyer, apart from V for the same reason as
  // graph: the clock and the composer no longer re-filter 12,000 buyers.
  const buyerView = useMemo(() => {
    const { deals, personById } = graph;
    const person = (id: string) => personById.get(id);
    // Markets arrive as free text and hold four kinds of thing at once: state
    // codes, cities, counties and ZIPs. lib/market-geo places each one so the
    // filters can read state → city instead of listing every raw string.
    //
    // The city → state gazetteer is our own address history: a city we have
    // actually worked is a city we can place. Nothing that fails to resolve is
    // dropped — it collects under "Needs a state" and stays selectable.
    const marketGaz = buyerIndex.marketGaz;
    const NO_STATE = 'Needs a state';
    const buyerPlaces = buyerIndex.places;
    const buyerEntityOf = buyerIndex.entityOf;
    const placesOf = (id: string) => buyerPlaces.get(id) ?? [];
    const { stateCounts, unplacedBuyers } = buyerIndex;
    const stateOptions = [...stateCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (STATE_NAMES[a[0]] ?? a[0]).localeCompare(STATE_NAMES[b[0]] ?? b[0]))
      .map(([code]) => STATE_NAMES[code] ?? code);
    const stateCodeOf = (name: string) =>
      Object.keys(STATE_NAMES).find((c) => STATE_NAMES[c] === name) ?? null;
    // State, City and the rest take several picks (lib/multi-filter); a buyer passes on any one.
    const statePicks = picksOf(s.gf.buyerState);
    const cityPicks = picksOf(s.gf.buyerCity);
    // One state picked: its cities read by bare name. Several: "City, ST".
    const pickedState = statePicks.length === 1 && statePicks[0] !== NO_STATE
      ? stateCodeOf(statePicks[0])
      : null;
    const pickedStateCodes = statePicks.filter((st) => st !== NO_STATE).map((st) => stateCodeOf(st)).filter((c): c is string => !!c);
    /**
     * Cities to offer. Inside a chosen state the bare name is unambiguous;
     * across all states it needs its state to tell two Dallases apart.
     */
    const cityOptions = pickedState
      ? Array.from(new Set(buyerIndex.cityPlaces.filter((p) => p.state === pickedState).map((p) => p.city))).sort((a, b) => a.localeCompare(b))
      : buyerIndex.cityPlaces.filter((p) => !pickedStateCodes.length || (!!p.state && pickedStateCodes.includes(p.state))).map((p) => p.label);
    const matchesState = (b: { id: string }) => {
      if (!statePicks.length) return true;
      return placesOf(b.id).some((p) => (p.state ? pickedStateCodes.includes(p.state) : statePicks.includes(NO_STATE)));
    };
    const matchesCity = (b: { id: string }) => {
      if (!cityPicks.length) return true;
      return placesOf(b.id).some((p) =>
        p.city && cityPicks.includes(pickedState ? p.city : `${p.city}, ${p.state}`));
    };

    const ownerPicks = picksOf(s.gf.buyerOwner);
    // Deals already on the pipeline, so Buyers can show who fits one of them.
    const buyerPipelineMenu = pipelineDealOptions(deals.map((d) => ({
      id: d.id, stage: d.stage || '', archived: !!d.archived,
      addr: d.addr || person(d.personId)?.property.addr || 'Deal',
    })));
    const buyerDealLabel = s.gf.buyerDeal ?? 'Any';
    const pickedPipeline = buyerDealLabel === 'Any' ? null : buyerPipelineMenu.find((c) => c.label === buyerDealLabel) ?? null;
    const pickedDeal = pickedPipeline ? deals.find((d) => d.id === pickedPipeline.id) : undefined;
    const dealScores = buyersForPipelineDeal(
      pickedPipeline ? D.matches.filter((m) => m.dealId === pickedPipeline.id).map((m) => ({ buyerId: m.buyerId, score: m.score })) : [],
      pickedDeal?.buyerId,
      buyerDealLabel !== 'Any',
    );
    const buyerRows = buyerIndex.rows
      .filter(({ b }) => !secretHidden(b.id, b.tags)
        && matchesState(b)
        && matchesCity(b)
        && matchesPick(s.gf.buyerEntity, ENTITY_LABELS[buyerEntityOf.get(b.id) ?? 'unclear'])
        && matchesPick(s.gf.buyerType, b.type)
        && matchesPick(s.gf.buyerStatus, b.status)
        && matchesPick(s.gf.buyerStage, b.stage ?? '')
        && (!ownerPicks.length || ownerPicks.some((o) => (o === 'Unassigned' ? !b.assigned : D.team[b.assigned ?? '']?.name === o)))
        && matchesContactFilters(b.phone, b.email, s.gf.buyerPhone, s.gf.buyerEmail)
        // Ever at a stage (migration 125): nothing matches until the database answers.
        && (!buyerHistoryKey || !!historyHits[buyerHistoryKey]?.buyers.has(dbId(b.id)))
        && (!dealScores || dealScores.has(b.id)))
      .map(({ b, row }) => ({ ...row, dealMatch: dealScores?.get(b.id) ?? 0 }));
    return { marketGaz, NO_STATE, unplacedBuyers, stateOptions, stateCodeOf, cityOptions, buyerPipelineMenu, buyerRows };
  }, [graph, buyerIndex, secretHidden, s.gf, D.team, D.matches, buyerHistoryKey, historyHits]);

  // Buyer search over every buyer, ranked once per query. The query is
  // deferred, so typing in the search box redraws at once and the 12,000-row
  // ranking follows when React has a moment, instead of blocking each key.
  const buyerQDeferred = useDeferredValue(s.buyerQ);
  const buyerSearchView = useMemo(() => {
    const search = parseSearch(buyerQDeferred);
    const ranks = new Map<string, number>();
    if (search) {
      for (const b of buyerView.buyerRows) {
        const r = searchRank(b.search, search);
        if (r >= 0) ranks.set(b.id, r);
      }
    }
    return { search, ranks };
  }, [buyerView.buyerRows, buyerQDeferred]);

  const V = useMemo(() => {
    const fmt = money;
    const { people, deals, pipelineDeals, comms, seeBuyers, buyers, tasks, vendors, plans, enrollments, personById } = graph;
    /**
     * Archive a deal from anywhere it shows (the board, the list, Dispo, the
     * deal sheet, the record) — or bring it back. It is one deal row, so it
     * leaves (or rejoins) every one of those at once. Archiving asks first in
     * the in-app prompt (ArchiveConfirm), which offers the chain reaction: the
     * seller too, when this was their last open deal. answerArchive does the
     * write. `fromRecord` is a submission archived from its own record: Yes
     * moves on to the next row, as a seller's does.
     */
    const archiveDealFlow = (dealId: string, archive = true, fromRecord = false) => {
      const d = deals.find((x) => x.id === dealId);
      if (!d) return;
      const p = people.find((x) => x.id === d.personId);
      const what = d.addr || p?.property.addr || 'this deal';
      if (archive) {
        if (readOnly) return toast('Read-only: nothing archived');
        const othersOpen = deals.some((x) => x.personId === d.personId && x.id !== d.id && !x.archived && x.stage !== 'Prospect' && x.stage !== 'Closed');
        set({ archiveAsk: { kind: 'deal', ids: [d.id], names: [what], deals: [], fromRecord, seller: p && !othersOpen ? { id: p.id, name: p.name } : null } });
        return;
      }
      if (!canWrite) { toast('Restored (demo)'); return; }
      void archiveDeals([dbId(d.id)], false, null).then((r) => {
        if (!r.ok) return toast(r.message || 'That did not save.', 'error');
        refreshDealOf(d.id);
        toast(`${what} is back on the board`, 'success');
      });
    };
    // A live lead has no score yet. Where Talkr has a thread with its number,
    // Talkr's hot/warm/cold is the one temperature it can honestly show; with
    // neither, the record shows nothing rather than "0 COLD".
    const talkrTemp = new Map<string, string>();
    if (talkrLive) {
      for (const c of phone.data.convs) {
        const t = (c.temperature ?? '').toUpperCase();
        if ((t === 'HOT' || t === 'WARM' || t === 'COLD') && !talkrTemp.has(c.their_number)) talkrTemp.set(c.their_number, t);
      }
    }
    const leadTemp = (p: Person): string => (p.score != null
      ? (p.score >= 85 ? 'HOT' : p.score >= 70 ? 'WARM' : 'COLD')
      : talkrTemp.get(toE164(p.phone) ?? '') ?? '');
    const person = (id: string) => personById.get(id);

    /**
     * A person, as the texting layer wants them: the database id, the number,
     * and the property the merge fields talk about. Null when the record is
     * gone, so a stale selection cannot text nobody.
     */
    const recipientOf = (id: string): Recipient | null => {
      const p = person(id);
      if (!p) return null;
      return {
        sellerId: dbId(p.id),
        name: p.name,
        phone: p.phone,
        address: p.property.addr,
        city: p.property.city,
        state: p.property.st,
        zip: p.property.zip,
      };
    };
    const textCtx = { repName: (me && D.team[me]?.name) || '', company: workspaceName || '' };
    // A contact's deal: its open contract, else its latest real deal, else its latest submission (lib/crm dealRank).
    const rankOf = (d: Deal) => dealRank({ id: d.id, stage: d.stage, contract_date: d.tracker?.contractDate, submitted_at: d.submittedAt });
    const bestDeal = new Map<string, Deal>();
    // The contact's deal on their own address. A partner contact carries many
    // deals; their property card names their own house, so its photo has to
    // come from that house's deal, not from their newest submission.
    const ownDeal = new Map<string, Deal>();
    const dealCountByPerson = new Map<string, number>();
    for (const d of deals) {
      if (!d.archived) dealCountByPerson.set(d.personId, (dealCountByPerson.get(d.personId) ?? 0) + 1);
      const cur = bestDeal.get(d.personId);
      if (!cur || rankOf(d) > rankOf(cur)) bestDeal.set(d.personId, d);
      if (!d.propertyId) continue;
      const key = d.personId + '|' + d.propertyId;
      const own = ownDeal.get(key);
      if (!own || rankOf(d) > rankOf(own)) ownDeal.set(key, d);
    }
    const dealOf = (pid: string) => bestDeal.get(pid);
    const photoDealOf = (p: Person) => (p.property.propertyId ? ownDeal.get(p.id + '|' + p.property.propertyId) : undefined) || dealOf(p.id);
    const buyerById = new Map(buyers.map((b) => [b.id, b]));
    const buyer = (id: string) => buyerById.get(id)
      || realtorPage.rows.find((b) => b.id === id)
      || (realtorPin?.id === id ? realtorPin : undefined);
    // The seller stage list. Live workspaces run the 44-stage acquisitions
    // list; the sample graph keeps its twelve. D.STAGES is the pipeline
    // (deal stages) in live mode.
    const sellerStages: string[] = live ? SELLER_STAGE_LABELS : (D.STAGES as string[]);
    const dealStageOf = (d: Deal | undefined, p: Person | undefined) => d?.stage ?? p?.stage ?? '';

    // The record in view. The demo falls back to a sample record; a live
    // workspace never opens an arbitrary one — no selection is a blank record,
    // and the shell asks you to pick one instead of rendering it.
    const P0 = person(s.personId) || (live ? null : people[0]) || BLANK_PERSON;
    // Opened from a submission row: the record is that house (see personDealId).
    // A seller with one deal and no submission has nothing to pin: the record
    // is already that house, and its stage stays the seller's own.
    const recordPin = live && s.personDealId && P0 !== BLANK_PERSON
      ? deals.find((d) => d.id === s.personDealId && d.personId === P0.id) : undefined;
    const focusDeal = recordPin && (recordPin.stage === 'Prospect' || (dealCountByPerson.get(P0.id) ?? 0) > 1) ? recordPin : undefined;
    // The stage is the seller's own (sellers.lead_stage) unless the pinned deal
    // is a real submission with a stage of its own (deals.lead_stage). A team
    // deal at Prospect, or one of a seller's several houses, shows that house
    // but never takes the seller's stage away: it used to write
    // deals.lead_stage and read "New Submission" on an ordinary lead.
    const stageDeal = focusDeal && focusDeal.leadStage != null ? focusDeal : undefined;
    const P: Person = focusDeal ? {
      ...P0,
      stage: stageDeal ? (s.stageOverrides['sub:' + stageDeal.id] || stageDeal.leadStage || P0.stage) : P0.stage,
      assigned: focusDeal.owner ?? P0.assigned,
      underwriter: focusDeal.underwriter ?? null,
      asking: focusDeal.asking != null ? fmt(focusDeal.asking) : '—',
      offer: focusDeal.contract != null ? fmt(focusDeal.contract) : null,
      property: {
        ...P0.property,
        addr: focusDeal.addr || P0.property.addr, city: focusDeal.city ?? P0.property.city,
        st: focusDeal.st ?? P0.property.st, zip: focusDeal.zip ?? P0.property.zip,
        ...(focusDeal.lat != null && focusDeal.lng != null ? { lat: focusDeal.lat, lng: focusDeal.lng } : {}),
        ...(focusDeal.propertyId ? { propertyId: focusDeal.propertyId } : {}),
        img: focusDeal.heroUrl || focusDeal.photos?.[0] || '',
      },
    } : P0;
    /** The record's deal: the submission it was opened on, else the contact's best deal. */
    const recDealOf = (pid: string) => (focusDeal && pid === P.id ? focusDeal : dealOf(pid));
    // The deal COMPR opens on: the house the Property card shows (and whose
    // address COMPR is handed), so Underwrite lands on that house's report. A
    // seller's best deal can be another house, or one never run. When this
    // house's own deal has no report, another deal on the same house that has one.
    const comprDeal = (() => {
      const home = focusDeal || photoDealOf(P);
      if (!live || comprLeadIdOfDeal(home)) return home;
      const pid = P.property.propertyId;
      if (!pid) return home;
      return deals.find((d) => d.personId === P.id && d.propertyId === pid && !!comprLeadIdOfDeal(d)) ?? home;
    })();

    // ---- COMPR beside the record (lib/compr-window.ts) ----
    /** What COMPR just wrote on a deal, on screen at once; the reload that follows carries the same numbers. */
    const patchDeal = (dealId: string, patch: Partial<Deal>) => {
      set((st) => ({ dealPatches: { ...st.dealPatches, [dealId]: { ...st.dealPatches[dealId], ...patch } } }));
      const prev = dealPatchTimers.get(dealId);
      if (prev) window.clearTimeout(prev);
      dealPatchTimers.set(dealId, window.setTimeout(() => {
        dealPatchTimers.delete(dealId);
        set((st) => {
          if (!st.dealPatches[dealId]) return {};
          const rest = { ...st.dealPatches };
          delete rest[dealId];
          return { dealPatches: rest };
        });
      }, 30_000));
    };
    /**
     * A report COMPR painted, or an edit it saved, onto its deal: ARV, rehab
     * and MAO from COMPR, the low and high that follow unless a person set
     * them. On screen now, in the database a moment later.
     */
    const applyComprToDeal = (dealId: string, r: ComprReport) => {
      if (!canWrite || workspaceId === null) return;
      const d = deals.find((x) => x.id === dealId);
      const sellerId = d ? dbId(d.personId) : NaN;
      if (!d || !Number.isFinite(sellerId)) return;
      const band = offerBand({ mao: r.mao, low: d.wholesale, high: d.institutional, lowSet: d.lowSet, highSet: d.highSet });
      patchDeal(dealId, {
        arv: r.arv, rehab: r.rehab, mao: band.mao, wholesale: band.low, institutional: band.high,
        ...(r.reportUrl ? { underwritingUrl: r.reportUrl } : {}),
      });
      void applyComprReport(workspaceId, sellerId, me, {
        leadId: r.leadId, status: r.status, arv: r.arv, rehab: r.rehab, mao: r.mao,
        wholesale: r.wholesale, institutional: r.institutional, confidence: r.confidence, reportUrl: r.reportUrl,
        condition: r.condition, arvLow: r.arvLow, arvHigh: r.arvHigh, compCount: r.compCount,
        beds: r.beds ?? null, baths: r.baths ?? null, redFlags: r.redFlags,
      }, dbId(dealId)).then((res) => {
        if (!res.ok) return toast(res.message ?? 'Could not save the COMPR numbers to the deal.', 'error');
        if (!res.changed) return;
        const $ = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));
        toast(`COMPR saved to ${d.addr || 'the deal'}: ARV ${$(r.arv)} · rehab ${$(r.rehab)} · MAO ${$(band.mao)}`, 'success');
        // A slider or comp edit changes the numbers, not the photos or share
        // links: show it now. A fresh report also pulls its photos and hero.
        if (r.adjusted) { refreshDealOf(dealId); return; }
        void syncComprMarketing(workspaceId, sellerId, dbId(dealId)).finally(() => refreshDealOf(dealId, true));
      });
    };
    /** Whether the deal's report is missing the record's photos, as the last pull said. */
    const noteComprPhotos = (dealId: string, gap: { own: number; graded: number } | null) => set((st) => {
      const had = st.comprPhotoGaps[dealId];
      if (gap) return had && had.own === gap.own && had.graded === gap.graded ? {} : { comprPhotoGaps: { ...st.comprPhotoGaps, [dealId]: gap } };
      if (!had) return {};
      const rest = { ...st.comprPhotoGaps };
      delete rest[dealId];
      return { comprPhotoGaps: rest };
    });
    /**
     * COMPR's saved numbers onto a deal (compr-underwrite pull): no run,
     * nothing billed. `check` writes nothing: a record past underwriting only
     * learns whether its report is missing the record's photos.
     */
    const pullComprDeal = (dealId: string, minGapMs = 4_000, check = false) => {
      if (!canWrite || workspaceId === null) return;
      const id = dbId(dealId);
      if (!Number.isFinite(id) || !claimComprPull(dealId, minGapMs)) return;
      void pullCompr(workspaceId, id, check).then((r) => {
        if (!r.ok) return;
        noteComprPhotos(dealId, r.photosMissing ? { own: r.ownPhotos, graded: r.reportPhotos ?? 0 } : null);
        if (!r.changed) return;
        patchDeal(dealId, {
          ...(r.arv != null ? { arv: r.arv } : {}), ...(r.rehab != null ? { rehab: r.rehab } : {}), ...(r.mao != null ? { mao: r.mao } : {}),
          ...(r.low != null ? { wholesale: r.low } : {}), ...(r.high != null ? { institutional: r.high } : {}),
        });
        refreshDealOf(dealId, true);
      });
    };
    /**
     * Open in COMPR: the deal's report in the COMPR window beside CLOZR. A deal
     * COMPR has never run is underwritten first, server side with every photo
     * CLOZR has, while the window says so; the report opens in that window when
     * the run lands. From a click: a browser opens a new window only for one.
     */
    const comprAddress = (p: Person, d: Deal) =>
      [d.addr || p.property.addr, d.city ?? p.property.city, [d.st ?? p.property.st, d.zip ?? p.property.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const openComprDeal = (p: Person, d: Deal | undefined) => {
      if (!live || !d) { navigateComprWindow(`${comprUrl()}/app`); return; }
      const target = { dealId: d.id, addr: d.addr || p.property.addr };
      const lead = comprLeadIdOfDeal(d);
      if (lead) { showComprReport(lead, target); return; }
      if (readOnly || !canWrite || workspaceId === null) {
        navigateComprWindow(`${comprUrl()}/app`);
        return toast('COMPR has not run this house yet.');
      }
      const address = comprAddress(p, d);
      const photos = d.photos?.length ?? 0;
      navigateComprWindow(comprWaitHref({ address, photos, dealId: d.id }), target);
      toast(`Underwriting ${target.addr} in COMPR${photos ? ` with ${photos} photos` : ''}…`);
      comprRunStarted(d.id);
      void runCompr(workspaceId, dbId(d.personId), dbId(d.id)).then((r) => {
        comprRunEnded(d.id);
        const id = r.ok ? comprLeadIdFromUrl(r.reportUrl) : null;
        if (!id) {
          const why = r.ok ? 'COMPR finished without a report link.' : r.message;
          navigateComprWindow(comprWaitHref({ address, photos }) + '&error=' + encodeURIComponent(why));
          return toast('COMPR: ' + why, 'error');
        }
        navigateComprWindow(comprReportHref(id));
        refreshDealOf(d.id, true);
      });
    };
    /**
     * Run COMPR from the record, in place: no window, the numbers land on the
     * card when the run does. For a house COMPR has never run; a seller with no
     * deal yet gets one (compr-underwrite opens a Prospect deal).
     */
    const runComprOnRecord = (p: Person, d: Deal | undefined) => {
      if (!live || workspaceId === null) return toast('COMPR runs on a live workspace.');
      if (readOnly || !canWrite) return toast(READ_ONLY_MESSAGE);
      if (s.comprRunning.includes(p.id) || (d && comprRunInFlight(d.id))) return;
      const sellerId = dbId(p.id);
      if (!Number.isFinite(sellerId)) return;
      const addr = d?.addr || p.property.addr || 'this house';
      set((st) => ({ comprRunning: [...st.comprRunning, p.id] }));
      if (d) comprRunStarted(d.id);
      toast(`Running COMPR on ${addr}…`);
      void runCompr(workspaceId, sellerId, d ? dbId(d.id) : undefined).then((r) => {
        if (d) comprRunEnded(d.id);
        set((st) => ({ comprRunning: st.comprRunning.filter((x) => x !== p.id) }));
        if (!r.ok) return toast('COMPR: ' + r.message, 'error');
        const $ = (n: number | null | undefined) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));
        toast(`COMPR ran ${addr}: ARV ${$(r.arv)} · rehab ${$(r.rehab)} · MAO ${$(r.mao)}`, 'success');
        if (d) refreshDealOf(d.id, true);
        else refreshPerson(p.id);
      });
    };
    /**
     * Re-run the deal's report in place (same link) with every photo on the
     * record: offered when COMPR graded it without most of them (a Drive folder
     * it could not open, Street View). The window waits, then shows it again.
     */
    const refreshComprPhotos = (p: Person, d: Deal | undefined) => {
      const lead = comprLeadIdOfDeal(d);
      if (!live || !d || !lead) return;
      if (readOnly || !canWrite || workspaceId === null) return toast(READ_ONLY_MESSAGE);
      const gap = s.comprPhotoGaps[d.id];
      const photos = gap?.own ?? d.photos?.length ?? 0;
      const address = comprAddress(p, d);
      const target = { dealId: d.id, addr: d.addr || p.property.addr };
      navigateComprWindow(comprWaitHref({ address, photos }), target);
      noteComprPhotos(d.id, null);
      toast(`Re-running ${target.addr} in COMPR with ${photos} photos…`);
      comprRunStarted(d.id);
      void runCompr(workspaceId, dbId(d.personId), dbId(d.id), { refreshLead: lead }).then((r) => {
        comprRunEnded(d.id);
        if (!r.ok) {
          if (gap) noteComprPhotos(d.id, gap);
          navigateComprWindow(comprWaitHref({ address, photos }) + '&error=' + encodeURIComponent(r.message));
          return toast('COMPR: ' + r.message, 'error');
        }
        navigateComprWindow(comprReportHref(lead));
        refreshDealOf(d.id, true);
      });
    };
    const B = buyer(s.buyerId) || (live ? null : buyers[0]) || BLANK_BUYER;
    const DP0 = people.find((p) => p.id === s.dispoId) || (live ? null : people[5] || people[0]) || BLANK_PERSON;
    const pinnedDeal = s.dispoDealId ? deals.find((d) => d.id === s.dispoDealId && d.personId === DP0.id) : undefined;
    // Inventory is one row per deal. The person's card can name a different
    // house (150 Quartz) than the contract that was clicked (344 Copper Ridge).
    const DP: Person = pinnedDeal?.addr ? {
      ...DP0,
      property: {
        ...DP0.property,
        addr: pinnedDeal.addr,
        city: pinnedDeal.city ?? DP0.property.city,
        st: pinnedDeal.st ?? DP0.property.st,
        zip: pinnedDeal.zip ?? DP0.property.zip,
        ...(pinnedDeal.lat != null && pinnedDeal.lng != null ? { lat: pinnedDeal.lat, lng: pinnedDeal.lng } : {}),
        ...(pinnedDeal.propertyId ? { propertyId: pinnedDeal.propertyId } : {}),
        // The person's photo is their best deal's house; another house never borrows it.
        img: pinnedDeal.heroUrl || pinnedDeal.photos?.[0] || ((dealCountByPerson.get(DP0.id) ?? 0) <= 1 ? DP0.property.img : ''),
      },
    } : DP0;
    const DD = pinnedDeal || dealOf(DP.id) || ({} as Partial<Deal> & Record<string, never>);
    const TP = people.find((p) => p.id === s.tcId) || (live ? null : people[5] || people[0]) || BLANK_PERSON;
    // A seller can have many deals (a wholesaler sends dozens), so the file is
    // the deal it was opened on, else the deal that has a transaction file,
    // else the seller's best deal.
    const tcPinned = s.tcDealId ? deals.find((d) => d.id === s.tcDealId && d.personId === TP.id) : undefined;
    const tcTxDealId = tcPinned ? null : D.transactions.find((t) => t.personId === TP.id && t.dealId)?.dealId;
    const TD = tcPinned || (tcTxDealId ? deals.find((d) => d.id === tcTxDealId) : undefined) || dealOf(TP.id) || ({} as Partial<Deal> & Record<string, never>);
    /** The transaction file for the deal on the TC screen: that deal's own, else the seller's. */
    const tcTxOf = () => (TD.id ? D.transactions.find((t) => t.dealId === TD.id) : undefined) || D.transactions.find((t) => t.personId === TP.id) || null;
    const dd = DD as { contract?: number | null; arv?: number | null; rehab?: number | null; assignment?: number | null };
    const td = TD as { contract?: number | null; assignment?: number | null; close?: string | null };

    // The record in front of the rep, for the global tools that act on "this
    // one" (COMPR, + Task, a call note). `personId` is only the last seller
    // opened, so read from it these ran on a seller the rep had left long ago:
    // COMPR from a dispo property opened some other seller. A record screen's
    // own record wins; otherwise the seller on the line; otherwise nothing.
    const callE164 = s.callTarget && callState !== 'idle' ? toE164(s.callTarget.phone) : null;
    const callPid = callState === 'idle' ? null
      : s.callTarget?.personId || (callE164 ? people.find((p) => toE164(p.phone) === callE164)?.id : null) || null;
    const focusPid = s.screen === 'person' || s.screen === 'dealSheet' ? P.id || null
      : s.screen === 'dispoProperty' ? DP.id || null
        : s.screen === 'tc' ? TP.id || null
          : callPid;
    /** COMPR's report for the record in focus, in the COMPR window beside CLOZR. */
    const openComprHere = () => {
      set({ moreOpen: false });
      if (!focusPid) return toast('Open a seller or a property first — COMPR runs on the record in front of you.');
      if (focusPid === P.id) return openComprDeal(P, comprDeal);
      if (s.screen === 'dispoProperty' && focusPid === DP.id) return openComprDeal(DP, DD.id ? DD as Deal : undefined);
      if (s.screen === 'tc' && focusPid === TP.id) return openComprDeal(TP, TD.id ? TD as Deal : undefined);
      const p = person(focusPid);
      if (p) openComprDeal(p, dealOf(focusPid));
    };

    // ---- nav ----
    const navDefs: [string, string][] = [
      ['Today', 'today'], ['People', 'people'], ['Inbox', 'inbox'], ['Dialer', 'dialer'], ['Tasks', 'tasks'], ['Calendar', 'calendar'],
      ['Deals', 'deals'], ['Contracts', 'contracts'], ['Dispo', 'dispo'], ['Buyers', 'buyers'], ['Reporting', 'reporting'], ['Coaching', 'coaching'],
    ];
    const activeKey = ({
      person: 'people', dispoProperty: 'dispo', buyer: 'buyers', tc: 'deals', dealSheet: 'deals', import: 'people',
      automations: 'tasks', plans: 'tasks', leaderboard: 'reporting',
    } as Record<string, string>)[s.screen] || s.screen;
    const navItems = navDefs.filter(([, key]) => canSee(role, key)).map(([label, key]) => ({
      label, key, on: activeKey === key, go: () => go(key),
      /** The Dialer item carries the Talkr mark. */
      talkrMark: key === 'dialer',
      color: activeKey === key ? '#18181b' : '#52525b',
      bg: activeKey === key ? '#f4f4f5' : 'transparent',
    }));
    // Lane's notes for this rep that nobody has read yet: the pulse on the
    // Lane button. Opening Lane reads them and puts the latest in its panel.
    const laneUnread = myNotifications.filter((n) => n.cat === 'Lane' && n.unread && !s.notifRead[n.id]);
    const openLaneFresh = (pid?: string) => {
      const ids = laneUnread.map((n) => n.id);
      const note = laneUnread.find((n) => n.body)?.body ?? null;
      // A fresh check-in is its own new chat, so it does not land in the
      // middle of a property's thread.
      if (note && !pid) newLaneChat(); else openLane(pid);
      if (ids.length) {
        set((st) => ({
          notifRead: mergeDismissed(st.notifRead, ids),
          laneThread: note && !st.laneThread.length ? [{ role: 'lane', text: note } as LaneTurn] : st.laneThread,
        }));
        if (canWrite && notificationDbIds(ids).length) void markNotificationsRead(ids);
        saveDismissedNotifs([...loadDismissedNotifs(), ...ids]);
      }
    };
    const navToolDefs = [
      {
        label: 'COMPR', dot: COMPR,
        color: '#52525b', bg: 'transparent',
        go: openComprHere,
      },
      {
        label: 'Lane', dot: LANE, badge: laneUnread.length,
        color: s.laneOpen ? '#18181b' : '#52525b', bg: s.laneOpen ? '#f4f4f5' : 'transparent',
        go: () => (s.laneOpen ? set({ laneOpen: false }) : openLaneFresh()),
      },
      // Genius is a page of its own: search any address, reopen past searches.
      ...(canSee(role, 'genius') ? [{
        label: 'Genius', dot: '#0A8560',
        color: s.screen === 'genius' ? '#18181b' : '#52525b', bg: s.screen === 'genius' ? '#f4f4f5' : 'transparent',
        go: () => go('genius'),
      }] : []),
      // Deal Machine is a screen, not a drawer: the program that drives the
      // scraper extension (migration 84) — its controls, settings, groups,
      // log, buyers lists and everything it found.
      ...(canSee(role, 'buyr') ? [{
        label: 'Buyr', dot: BUYR,
        color: s.screen === 'buyr' ? '#18181b' : '#52525b',
        bg: s.screen === 'buyr' ? '#f4f4f5' : 'transparent',
        go: () => go('buyr'),
      }] : []),
      ...(canSee(role, 'dealMachine') ? [{
        label: 'Deal Machine', dot: DEAL_MACHINE,
        color: activeKey === 'dealMachine' ? '#18181b' : '#52525b',
        bg: activeKey === 'dealMachine' ? '#f4f4f5' : 'transparent',
        go: () => go('dealMachine'),
      }] : []),
    ];
    // Picking a tool from the Tools menu closes it; inline, the close is a no-op.
    const navTools = navToolDefs.map((t) => ({ ...t, go: () => { set({ toolsMenuOpen: false }); t.go(); } }));
    const toolsActive = navToolDefs.some((t) => t.bg !== 'transparent');
    // Every entry opens the create dialog for that record type; an appointment
    // made from a record is with that record's seller.
    // Quick Add offers only what the role can read back afterwards.
    const quickAddKinds = ['Seller', 'Buyer', 'Property', 'Deal', 'Task', 'Appointment', 'Note', 'Vendor']
      .filter((label) => (label === 'Buyer' ? canSee(role, 'buyers') : label === 'Seller' || label === 'Property' ? canSee(role, 'people') : true));
    const quickAddItems = quickAddKinds.map((label, i) => ({
      label, key: 'Q ' + (i + 1),
      go: () => openAdd(label.toLowerCase() as AddKind, label === 'Appointment' && focusPid ? { personId: focusPid } : {}),
    }));
    const notifMuted = withFloorBellMutes(s.mutedCats, floorNotify);
    const unreadNotifs = visibleNotifs(myNotifications, s.notifRead, 'All', notifMuted).length;

    // ---- HOME ----
    // Whose work Home shows. Owners and admins can switch between their own,
    // the entire team's and any one rep's; everyone else sees their own, so a
    // rep is never shown a switcher that changes nothing. The demo has no
    // workspace to scope and keeps its sample figures.
    const homeCanScope = !!live && isAdmin(role);
    const homeRep: string | null = !homeCanScope || s.teamView === 'me' ? ME
      : s.teamView === 'team' ? null
        : D.team[s.teamView] ? s.teamView : ME;
    const homeScopeLabel = homeRep === null ? 'Entire Team' : homeRep === ME ? 'My Activity' : repName(homeRep);
    // A live workspace's tiles are Reporting's own figures (lib/reporting.ts)
    // for the scope above, so "Calls today" on Home is the Calls tab's figure
    // for Today and "Closings this month" the Overview's for MTD. Built only
    // while Home is open, and only on the client, where "today" is known.
    const liveRaw = live ? ((live.reporting as { raw?: ReportRaw } | undefined)?.raw ?? null) : null;
    const liveStats = liveRaw && now && s.screen === 'home' ? homeKpis(liveRaw, homeRep ?? undefined) : [];
    const sampleStats: [string, string, string, string][] = [
      ['New leads today', '7', '+2 vs avg', '#16a34a'],
      ['Unactioned leads', '2', 'oldest 3m 14s', '#dc2626'],
      ['Speed to lead', '2m 41s', '−38s', '#16a34a'],
      ['Calls today', '38', '3h 05m talk', '#71717a'],
      ['Talk time', '3h 05m', 'team 11h 20m', '#71717a'],
      ['Offers sent', '4', '$782K total', '#71717a'],
      ['Contracts signed', '1', 'Benton Ct', '#16a34a'],
      ['Closing this month', '5', '$104K fees', '#71717a'],
    ];
    const homeStats: Kpi[] = live ? liveStats : sampleStats.map(([k, v, d, dColor]) => ({ k, v, d, dColor }));

    // Dismissed by row id, never by title: live imports share "No name", so a
    // title key completed every nameless lead at once.
    const mkQ = (id: string, tag: string, color: string, title: string, sub: string, meta: string, open: () => void, pidQ?: string, taskId?: string) => ({
      id, tag, color, title, sub, meta, open,
      call: () => {
        const p = pidQ ? person(pidQ) : null;
        startCall(p ? { name: p.name, phone: p.phone, personId: p.id } : null);
      },
      // The docked quick text, on this seller, without leaving the list.
      text: () => set(pidQ ? { composerTab: 'Text', quickReach: { channel: 'text', personId: pidQ } } : { composerTab: 'Text' }),
      // A lead row has no task behind it, so there is nothing to complete or
      // snooze: both only hide it for this session, and say exactly that.
      complete: () => {
        set((st) => ({
          queueCleared: { ...st.queueCleared, [id]: true },
          ...(taskId ? { tasksDone: { ...st.tasksDone, [taskId]: true } } : {}),
        }));
        if (!taskId) return toast('Hidden until you reload');
        persistTask(taskId, true);
        toast('Marked complete');
      },
      snooze: () => {
        set((st) => ({ queueCleared: { ...st.queueCleared, [id]: true } }));
        if (!taskId) return toast('Hidden until you reload');
        // Due an hour from now. If the write fails the row comes back, since
        // nothing about the task changed.
        const due = new Date();
        due.setHours(due.getHours() + 1);
        persistTaskDue(taskId, due, 'Snoozed 1 hour', () => set((st) => {
          const next = { ...st.queueCleared };
          delete next[id];
          return { queueCleared: next };
        }));
      },
      snoozeLabel: taskId ? 'Snooze' : 'Hide for now',
    });
    const queueLabel = (p: Person) => {
      const n = p.name.trim();
      if (n && !/^no name$/i.test(n)) return n;
      return p.property.addr && p.property.addr !== '—' ? p.property.addr : (n || 'Untitled');
    };
    const sampleQueue = [
      mkQ('sq1', 'Hot', '#dc2626', 'Call Ronald Moore', '1803 Cypress Lane', 'Seller opened offer 3 times · last contact 42 minutes ago', () => openPerson('p2'), 'p2'),
      mkQ('sq2', 'Overdue', '#d97706', 'Follow up 1803 Cypress', 'Task overdue 2 hours', 'Assigned to Diego Ortiz · Offer Sent · $186,000', () => openPerson('p2'), 'p2'),
      mkQ('sq3', 'New lead', '#0A8560', 'John Smith', 'Facebook PPC', 'Lead age 3m 14s · 4410 Bluebonnet Trail, Fort Worth · unassigned', () => openPerson('p3'), 'p3'),
      mkQ('sq4', 'Dispo', '#ff7a45', 'Buyer requested walkthrough', 'Willow Street', 'Harbor Capital · tomorrow 2:30 PM · bringing GC', () => openDispo('p6', 'Walkthroughs'), 'p6'),
      mkQ('sq5', 'TC', '#1f7a4d', 'Buyer EMD not received', 'Pine Terrace', 'Closing in 5 days · Casey Park · Northvale Title', () => openTc('p8'), 'p8'),
      mkQ('sq6', 'Hot', '#dc2626', 'Kara Mitchell reviewed offer', '123 Oakview Drive', 'Opened 18 minutes ago · asked for a call this morning', () => openPerson('p1'), 'p1'),
    ];
    // A live workspace's queue is the scoped rep's overdue and due-today work
    // (this user's, unless an admin picked another rep or the entire team),
    // not the scripted six. Never-contacted leads count only once someone
    // owns them, so the team's unassigned import pile stays out. Ordered the
    // way the screen claims: urgency first.
    const taskOpen = (t: Task) => !(s.tasksDone[t.id] ?? t.done);
    // Read once: the lists asked tasks.some() per person, people x tasks on
    // every render (keystrokes included) across ~11k leads.
    const dueNowIds = new Set(tasks.filter((t) => taskOpen(t) && (t.bucket === 'overdue' || t.bucket === 'today')).map((t) => t.personId));
    const mine = (who: string | null) => (homeRep === null ? true : who === homeRep);
    const mineLead = (who: string | null) => (homeRep === null ? who !== null : who === homeRep);
    const taskLook = {
      hasPerson: (id: string) => !!person(id),
      sellerOfDeal: (dealId: string) => deals.find((d) => d.id === dealId)?.personId ?? null,
      hasBuyer: (id: string) => !!buyer(id),
    };
    const openTaskRecord = (t: Task) => {
      const rec = taskRecordOf(t, taskLook);
      if (!rec) return;
      if (rec.kind === 'buyer') return openBuyer(rec.id);
      if (!rec.id && rec.dealId) return go('dealSheet', { personId: '', dealSheetDealId: rec.dealId });
      if (t.note && (t.type === 'text' || t.type === 'email') && rec.id) {
        return go('person', {
          personId: rec.id,
          personTab: 'Activity',
          personDealId: rec.dealId ?? null,
          composerTab: t.type === 'text' ? 'Text' : 'Email',
          composerText: t.note,
        });
      }
      return openPersonDeal(rec.id, rec.dealId);
    };
    const liveQueue = [
      ...tasks.filter((t) => taskOpen(t) && t.bucket === 'overdue' && mine(t.assigned)).map((t) => {
        const rec = taskRecordOf(t, taskLook);
        const p = rec?.kind === 'person' && rec.id ? person(rec.id) : undefined;
        return mkQ('task:' + t.id, 'Overdue', '#d97706', t.title, p?.property.addr ?? '—',
          t.due + ' · ' + repName(t.assigned), () => openTaskRecord(t), p?.id, t.id);
      }),
      ...tasks.filter((t) => taskOpen(t) && t.bucket === 'today' && mine(t.assigned)).map((t) => {
        const rec = taskRecordOf(t, taskLook);
        const p = rec?.kind === 'person' && rec.id ? person(rec.id) : undefined;
        return mkQ('task:' + t.id, 'Today', '#0A8560', t.title, p?.property.addr ?? '—',
          t.due + ' · ' + repName(t.assigned), () => openTaskRecord(t), p?.id, t.id);
      }),
      ...people.filter((p) => p.lastCommTs === null
        && mineLead(p.assigned)
        && sellerStageGroup(p.stage) === 'lead'
        && !dueNowIds.has(p.id))
        .slice(0, 5).map((p) => mkQ(
          'lead:' + p.id, 'New lead', '#0A8560', queueLabel(p), p.property.addr,
          p.source + ' · never contacted', () => openPerson(p.id), p.id,
        )),
    ];
    const queue = (live ? liveQueue : sampleQueue).filter((q) => !s.queueCleared[q.id]);

    // The Inbox opens on its own hand-offs, the ones the bell and "Open in
    // Inbox" use (screens/inboxHandoff.ts): this text thread, this email
    // thread. `inboxConv` is the old prototype's and the Inbox never read it,
    // so a Home row opened an empty Inbox.
    const openInboxFor = (m: InboxItem, who: { phone?: string; email?: string }) => {
      const e164 = toE164(m.fromPhone || who.phone || '');
      const from = (m.fromEmail || who.email || '').trim();
      if (m.channel === 'SMS' && e164) requestInboxSms(e164);
      else if (m.channel === 'Email' && from.includes('@')) requestInboxThread(threadKeyFor({ inbound: true, from, to: [], subject: m.subject ?? '' }));
      go('inbox', { inboxConv: m.id });
    };
    const homeInbound = D.inbox.slice(0, 5).flatMap((m) => {
      const who = (m.personId ? person(m.personId) : undefined) ?? (m.buyerId ? buyer(m.buyerId) : undefined);
      if (!who) return [];
      return [{
        initials: initialsOf(who.name), name: who.name, channel: m.channel,
        preview: m.preview, time: m.time,
        // Without the inbox (TC), a message opens the seller it came from.
        open: () => (can.inbox ? openInboxFor(m, who) : m.personId ? openPerson(m.personId) : go('inbox')),
      }];
    });
    // Closings, soonest first. Amber within a week, red once the date has
    // passed without the deal closing; the rest stay quiet. (It used to colour
    // one sample date, 'Sept 6', on every workspace.)
    const dayMs = 86_400_000;
    const closeIn = (d: Deal) => {
      const iso = d.tracker?.scheduledClose;
      const t = iso ? Date.parse(iso.length === 10 ? iso + 'T12:00:00' : iso) : NaN;
      return Number.isFinite(t) && now ? Math.floor((t - now.getTime()) / dayMs) : null;
    };
    const homeClosings = pipelineDeals.filter((d) => d.close)
      .map((d) => ({ d, p: person(d.personId), days: closeIn(d) }))
      .filter((x): x is { d: Deal; p: Person; days: number | null } => !!x.p)
      .sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9))
      .slice(0, 5).map(({ d, p, days }) => {
      return {
        addr: p.property.addr, sub: p.property.city + ' · ' + repName(d.owner),
        fee: fmt(d.assignment), when: d.close,
        color: days === null ? '#52525b' : days < 0 ? '#b91c1c' : days <= 7 ? '#b45309' : '#52525b',
        open: () => openTc(p.id, d.id),
      };
    });
    // Dismissing an alert hides it for the session. These name sample records
    // by id, so a live workspace gets none rather than three alerts about
    // sellers it has never heard of. Real alerts belong to the automation layer.
    const aiAlerts = (live ? [] : [
      { id: 'al1', text: 'Kara Mitchell opened her offer 18 minutes ago and texted asking for a call. Taylor is free now.', cta: 'Call Kara', go: () => startCall({ name: 'Kara Mitchell', phone: '(210) 555-0136', personId: 'p1' }) },
      { id: 'al2', text: "3 buyers opened Willow Street but haven't offered. Blue Mesa viewed photos twice.", cta: 'Nudge buyers', go: () => openDispo('p6', 'Matches') },
      { id: 'al3', text: 'Lake Ridge offer expires Tuesday with no seller contact in 2 days.', cta: 'Open record', go: () => openPerson('p7') },
    ]).filter((a) => !s.dismissedAlerts[a.id]).map((a) => ({
      ...a,
      dismiss: () => set((st) => ({ dismissedAlerts: { ...st.dismissedAlerts, [a.id]: true } })),
    }));
    const atRisk = pipelineDeals.filter((d) => d.health !== 'good')
      .map((d) => ({ d, p: person(d.personId) }))
      .filter((x): x is { d: Deal; p: Person } => !!x.p)
      .slice(0, 4).map(({ d, p }) => {
      return {
        addr: p.property.addr,
        reason: live ? 'Stalled ' + d.daysInStage + ' days in stage'
          : d.health === 'risk' ? 'No contact 2 days · offer expiring' : 'Stalled ' + d.daysInStage + ' days in stage',
        stage: p.stage, color: stageColor(p.stage), open: () => openPerson(p.id),
      };
    });
    // Live: the workspace's own deals with a contract date, newest first.
    const recentContracts = live
      ? pipelineDeals.filter((d) => d.tracker?.contractDate && person(d.personId))
        .sort((a, b) => (b.tracker?.contractDate ?? '').localeCompare(a.tracker?.contractDate ?? ''))
        .slice(0, 5).map((d) => ({
          addr: person(d.personId)!.property.addr,
          sub: new Date((d.tracker?.contractDate ?? '').slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + repName(d.owner),
          price: fmt(d.contract), open: () => openPersonDeal(d.personId, d.id),
        }))
      : ([['p5', 'Aug 30 · Diego Ortiz'], ['p6', 'Aug 27 · Diego Ortiz'], ['p9', 'Aug 25 · Taylor Reed']] as [string, string][])
      .map(([id, sub]) => ({ id, sub, p: person(id), d: dealOf(id) }))
      .filter((x) => x.p && x.d)
      .map(({ id, sub, p, d }) => ({
        addr: p!.property.addr, sub, price: fmt(d!.contract), open: () => openPerson(id),
      }));
    // Scripted sample activity, naming sample people. A live workspace's feed
    // is its own activity rows, which the record timelines already render.
    const teamFeed = (live ? [] : [
      ['TR', 'Taylor', 'logged a 4m call with Kara Mitchell', '9:46'],
      ['ML', 'Morgan', 'launched campaign · Willow Street → 243 buyers', '9:40'],
      ['DO', 'Diego', 'sent offer $186,000 · Ronald Moore', '9:12'],
      ['CP', 'Casey', 'opened title · Benton Court', '8:55'],
      ['AC', 'Alex', 'scheduled walkthrough · Easton Ave', '8:31'],
      ['AN', 'Avery', 'added 12 buyers from PropStream import', '8:10'],
    ] as [string, string, string, string][]).map(([initials, who, text, time]) => ({ initials, who, text, time }));

    // ---- PEOPLE ----
    // ---- PEOPLE FILTERS --------------------------------------------------------
    // Toolbar filters compose with the active smart list and the search box.
    // 'Any' means off. Counts on every screen read the same filtered set.
    // ---- offer gaps (migration 70) ------------------------------------------
    // How close an offer came to the ask, rolled up to the person to call back.
    // The views own the arithmetic; what is decided here is only the basis and
    // the threshold the filters are set to, which the views cannot know.
    //
    // A deal reaches two people: the wholesaler who submitted it and, when we
    // have one, the seller. Both keys point at the same gap rows, so the same
    // filters read the same way on a vendor list and on a people list.
    const gapsByPerson = new Map<string, OfferGap[]>();
    for (const g of D.offerGaps) {
      // 'sub:<deal>' is a Submissions row (one deal); without it every gap filter emptied those lists.
      for (const key of [g.vendorId, g.sellerId, 'sub:' + g.dealId]) {
        if (!key) continue;
        const cur = gapsByPerson.get(key);
        if (cur) cur.push(g);
        else gapsByPerson.set(key, [g]);
      }
    }
    const hasGaps = gapsByPerson.size > 0;
    const GAP_BASES = ['Either', 'Actual offer', 'UW high'];
    /**
     * The gap this offer is judged on. 'Actual offer' measures the ask against
     * the number we sent, 'UW high' against our underwriting ceiling, 'Either'
     * against whichever was closer. A deal with no ceiling has no UW-high gap,
     * so it drops out of that basis rather than counting as a zero.
     */
    const gapUnder = (g: OfferGap, basis: string | undefined): number | null => gapOf(g, basis);
    type GapStat = { offers: number; closeCalls: number; closest: number | null; declined: number; won: number };
    const NO_GAPS: GapStat = { offers: 0, closeCalls: 0, closest: null, declined: 0, won: 0 };
    const gapStatOf = (id: string, f: PeopleFilters): GapStat => {
      const gaps = gapsByPerson.get(subKey(id));
      if (!gaps || gaps.length === 0) return NO_GAPS;
      const within = withinOf(f.gapWithin);
      let closeCalls = 0, declined = 0, won = 0;
      let closest: number | null = null;
      for (const g of gaps) {
        const d = gapUnder(g, f.gapBasis);
        if (d != null) {
          if (d <= within) closeCalls += 1;
          if (closest == null || d < closest) closest = d;
        }
        if (g.stage === 'Offer Declined') declined += 1;
        else if (g.stage === 'Closed' || g.stage === 'Under Contract - Buyer') won += 1;
      }
      return { offers: gaps.length, closeCalls, closest, declined, won };
    };
    /** '3+' → 3, 'Any' or unset → 0. */
    const atLeast = (v: string | undefined) => (v && v !== 'Any' ? Number(v.replace('+', '')) || 0 : 0);
    /** Wholesalers who have submitted a deal we offered on, for the Submitter filter. */
    const submitterOffers = new Map<string, number>();
    for (const g of D.offerGaps) if (g.company && g.company !== '—') submitterOffers.set(g.company, (submitterOffers.get(g.company) ?? 0) + 1);
    const submitters = Array.from(submitterOffers.keys()).sort((a, b) => a.localeCompare(b));
    const gapMatchOf = (f: PeopleFilters) => {
      const needClose = closeCallsNeeded(f);
      const needDeclined = atLeast(f.declined);
      const submitters = picksOf(f.submitter);
      if (!needClose && !needDeclined && !submitters.length) return () => true;
      return (id: string) => {
        if (submitters.length && !(gapsByPerson.get(subKey(id)) ?? []).some((g) => submitters.includes(g.company))) return false;
        if (!needClose && !needDeclined) return true;
        const st = gapStatOf(id, f);
        return st.closeCalls >= needClose && st.declined >= needDeclined;
      };
    };

    // List stacking: what a contact's deals add up to (lib/people-stack). A
    // submission row ('sub:<deal>') is one deal; its counts are its sender's.
    const dealsByPerson = new Map<string, Deal[]>();
    for (const d of deals) {
      if (!d.personId) continue;
      const list = dealsByPerson.get(d.personId);
      if (list) list.push(d); else dealsByPerson.set(d.personId, [d]);
    }
    const dealBySub = new Map(deals.map((d) => ['sub:' + d.id, d] as const));
    type Stack = { subs: number; props: number; stack: number; offers: number[]; arvs: number[]; offer: number | null; arv: number | null };
    const stackCache = new Map<string, Stack>();
    const stackOf = (p: Person): Stack => {
      const hit = stackCache.get(p.id);
      if (hit) return hit;
      const sub = dealBySub.get(subKey(p.id));
      const owner = sub ? person(sub.personId) : p;
      const theirs = dealsByPerson.get(sub ? sub.personId : p.id) ?? [];
      const mine = sub ? [sub] : theirs;
      const best = sub ?? dealOf(p.id);
      const offers = mine.map((d) => d.contract).filter((n): n is number => n != null && n > 0);
      const arvs = mine.map((d) => d.arv).filter((n): n is number => n != null && n > 0);
      const v: Stack = {
        subs: theirs.length,
        props: new Set([...theirs.map((d) => d.propertyId), owner?.property.propertyId].filter(Boolean)).size,
        stack: listStack(owner?.tags ?? p.tags, owner?.name ?? p.name, owner?.source ?? p.source),
        offers, arvs,
        offer: best?.contract ?? (offers.length ? Math.max(...offers) : null),
        arv: best?.arv ?? (arvs.length ? Math.max(...arvs) : null),
      };
      stackCache.set(p.id, v);
      return v;
    };
    const peopleMarkets = Array.from(new Set(people.map((p) => p.market).filter((m) => m && m !== '—'))).sort((a, b) => a.localeCompare(b));
    const historyKeyOf = (f: PeopleFilters) => ['seller', f.history, f.historyWhen ?? 'Ever', f.historyFrom ?? 'Any', f.historyTo ?? 'Any'].join('|');

    const PF_DEFS: { key: keyof PeopleFilters; label: string; options: string[]; multi?: boolean }[] = [
      // Multi: pick as many as you like (lib/multi-filter); a lead passes on any of them.
      { key: 'owner', label: 'Owner', options: ['Any', ...Object.values(D.team).map((r) => r.name), 'Unassigned'], multi: true },
      { key: 'stage', label: 'Stage', options: ['Any', ...sellerStages], multi: true },
      { key: 'source', label: 'Source', options: ['Any', ...Array.from(new Set(people.map((p) => p.source)))], multi: true },
      { key: 'tag', label: 'Tags', options: ['Any', ...Array.from(new Set(people.flatMap((p) => p.tags)))], multi: true },
      { key: 'date', label: 'Date', options: ['Any', 'Created today', 'Contacted today', 'No contact 7 days', 'Closing this month'], multi: true },
      { key: 'phone', label: 'Phone', options: [...PHONE_FILTERS], multi: true },
      { key: 'email', label: 'Email', options: [...EMAIL_FILTERS], multi: true },
      { key: 'compr', label: 'COMPR', options: ['Any', 'Not run', 'Run'], multi: true },
      { key: 'sort', label: 'Sort', options: ['Recent', 'Date added', 'Oldest added', 'Lead score', 'Name', 'Stage', 'Oldest',
        'ARV (high to low)', 'Offer (high to low)', 'Market (A to Z)', 'Most submissions', 'Most properties', 'Largest list stack'] },
    ];
    // The gap filters only exist once there are offered deals behind them, so a
    // workspace with no offers gets no controls that cannot do anything.
    if (hasGaps) PF_DEFS.push(
      { key: 'gapBasis', label: 'Gap basis', options: GAP_BASES },
      { key: 'gapWithin', label: 'Close is', options: Object.keys(GAP_WITHIN) },
      { key: 'closeCalls', label: 'Close calls', options: ['Any', '1+', '2+', '3+', '5+'] },
      { key: 'declined', label: 'Declined', options: ['Any', '1+', '3+', '5+'] },
      { key: 'submitter', label: 'Submitter', options: ['Any', ...submitters], multi: true },
    );
    /** A lead has been underwritten when its deal carries a COMPR report or an ARV. */
    const comprRan = (pid: string) => { const d = dealOf(pid); return !!(d?.underwritingUrl || d?.arv); };
    /** One Date pick. */
    const dateOk = (d: string, p: Person) => {
      if (d === 'Created today') return /Today/i.test(p.created);
      if (d === 'Contacted today') return p.lastCommTs != null && p.lastCommTs < 600;
      if (d === 'No contact 7 days') return p.lastCommTs == null || p.lastCommTs > 10000;
      if (d === 'Closing this month') return !!dealOf(p.id)?.close;
      return true;
    };
    const pfMatchOf = (f: PeopleFilters) => {
      const gapOk = gapMatchOf(f);
      const offerR = moneyRange(f.offer, f.offerMin, f.offerMax);
      const arvR = moneyRange(f.arv, f.arvMin, f.arvMax);
      const needSubs = atLeastOf(f.subs);
      const needProps = atLeastOf(f.props);
      const needStack = atLeastOf(f.stack);
      const historyOn = !!f.history && f.history !== 'Any' && live;
      const hist = historyOn ? historyHits[historyKeyOf(f)] : undefined;
      const owners = picksOf(f.owner);
      const dates = picksOf(f.date);
      const comprs = picksOf(f.compr);
      return (p: Person) => {
      // Each filter may hold several picks: a lead passes a filter on any one of them.
      if (owners.length && !owners.some((o) => (o === 'Unassigned' ? !p.assigned : repName(p.assigned) === o))) return false;
      if (!matchesPick(f.stage, p.stage)) return false;
      if (!matchesPick(f.source, p.source)) return false;
      if (!matchesAnyPick(f.tag, p.tags)) return false;
      if (dates.length && !dates.some((d) => dateOk(d, p))) return false;
      if (comprs.length && !comprs.includes(comprRan(p.id) ? 'Run' : 'Not run')) return false;
      if (!matchesContactFilters(p.phone, p.email, f.phone, f.email)) return false;
      if (!gapOk(p.id)) return false;
      if (!matchesPick(f.market, p.market)) return false;
      if (offerR || arvR || needSubs || needProps || needStack) {
        const st = stackOf(p);
        if (offerR && !anyInRange(st.offers, offerR)) return false;
        if (arvR && !anyInRange(st.arvs, arvR)) return false;
        if (st.subs < needSubs || st.props < needProps || st.stack < needStack) return false;
      }
      if (historyOn) {
        // Until the database answers, nothing matches rather than everything.
        if (!hist) return false;
        const sub = dealBySub.get(subKey(p.id));
        if (sub ? !hist.deals.has(dbId(sub.id)) : !hist.sellers.has(dbId(p.id))) return false;
      }
      return true;
      };
    };
    const pfMatch = pfMatchOf(s.pf);
    const addedMs = (p: Person) => Date.parse(p.createdAt || '') || 0;
    const pfSort = (a: Person, b: Person) => {
      switch (s.pf.sort) {
        case 'Date added': return addedMs(b) - addedMs(a);
        case 'Oldest added': return addedMs(a) - addedMs(b);
        // Unscored leads sort after every scored one, not as zeros.
        case 'Lead score': return (b.score ?? -1) - (a.score ?? -1);
        case 'Name': return a.name.localeCompare(b.name);
        case 'Stage': return sellerStages.indexOf(a.stage) - sellerStages.indexOf(b.stage);
        case 'Oldest': return (b.lastCommTs ?? 1e9) - (a.lastCommTs ?? 1e9);
        // No figure sorts after every figure, not as a zero.
        case 'ARV (high to low)': return (stackOf(b).arv ?? -1) - (stackOf(a).arv ?? -1);
        case 'Offer (high to low)': return (stackOf(b).offer ?? -1) - (stackOf(a).offer ?? -1);
        case 'Market (A to Z)': {
          const ma = a.market && a.market !== '—' ? a.market : null;
          const mb = b.market && b.market !== '—' ? b.market : null;
          return ma && mb ? ma.localeCompare(mb) : ma ? -1 : mb ? 1 : 0;
        }
        case 'Most submissions': return stackOf(b).subs - stackOf(a).subs;
        case 'Most properties': return stackOf(b).props - stackOf(a).props;
        case 'Largest list stack': return stackOf(b).stack - stackOf(a).stack;
        default: return (a.lastCommTs ?? 1e9) - (b.lastCommTs ?? 1e9);
      }
    };
    /** Controls that change how the filters read rather than narrowing the list. */
    const PF_MODIFIERS: (keyof PeopleFilters)[] = ['sort', 'gapBasis', 'gapWithin', 'historyWhen', 'historyFrom', 'historyTo', 'offerMin', 'offerMax', 'arvMin', 'arvMax'];
    const isModifier = (k: keyof PeopleFilters) => PF_MODIFIERS.includes(k);
    const activeFilterCount = (Object.keys(s.pf) as (keyof PeopleFilters)[])
      .filter((k) => !isModifier(k) && s.pf[k] !== 'Any' && s.pf[k] !== undefined).length;
    const peopleFilterMenus = PF_DEFS.map((d) => {
      const sortOn = d.key === 'sort' && s.pf.sort !== 'Recent';
      const on = sortOn || (!isModifier(d.key) && s.pf[d.key] !== 'Any');
      const multi = !!d.multi;
      return {
      key: d.key as string, label: d.label,
      value: multi ? picksLabel(s.pf[d.key]) : s.pf[d.key], on, multi,
      open: s.pfOpen === d.key,
      toggle: () => set({ pfOpen: s.pfOpen === d.key ? null : (d.key as string) }),
      // Submitter can run to hundreds of wholesalers, so it (and any other long
      // menu) opens with a type-to-filter box (components/ds/SearchSelect).
      searchable: d.key === 'submitter' || d.options.length > 10,
      options: d.options.map((o) => ({
        label: o, on: multi ? isPicked(s.pf[d.key], o) : s.pf[d.key] === o,
        meta: d.key === 'submitter' && o !== 'Any' ? `${submitterOffers.get(o) ?? 0} offer${submitterOffers.get(o) === 1 ? '' : 's'}` : undefined,
        // A multi menu stays open while picks go in and out; Any clears it and closes.
        go: multi
          ? () => set((st) => ({ pf: { ...st.pf, [d.key]: togglePick(st.pf[d.key], o) }, pfOpen: o === 'Any' ? null : st.pfOpen, gapOpen: null, peopleSel: {} }))
          : () => set((st) => ({ pf: { ...st.pf, [d.key]: o }, pfOpen: null, gapOpen: null, peopleSel: {} })),
      })),
      bg: on ? '#E7F8F1' : 'var(--c-btn-bg)',
      color: on ? '#0A8560' : '#27272a',
      border: on ? '#0A8560' : 'var(--c-btn-line)',
      };
    });
    /** A one-off menu in the same shape as the People filter menus (vendor Type / State). */
    const mkMenuPeople = (key: string, label: string, options: string[], value: string, pick: (v: string) => void, multi = false) => {
      const on = value !== 'Any';
      return {
        key, label, value: multi ? picksLabel(value) : value, on, multi,
        open: s.pfOpen === key,
        toggle: () => set({ pfOpen: s.pfOpen === key ? null : key }),
        searchable: options.length > 10,
        options: options.map((o) => ({
          label: o, on: multi ? isPicked(value, o) : value === o, meta: undefined as string | undefined,
          go: multi ? () => { pick(togglePick(value, o)); if (o === 'Any') set({ pfOpen: null }); } : () => { pick(o); set({ pfOpen: null }); },
        })),
        bg: on ? '#E7F8F1' : 'var(--c-btn-bg)', color: on ? '#0A8560' : '#27272a', border: on ? '#0A8560' : 'var(--c-btn-line)',
      };
    };
    const MORE_CLEAR: Partial<PeopleFilters> = {
      history: 'Any', historyWhen: 'Ever', historyFrom: 'Any', historyTo: 'Any',
      offer: 'Any', offerMin: 'Any', offerMax: 'Any', arv: 'Any', arvMin: 'Any', arvMax: 'Any',
      market: 'Any', subs: 'Any', props: 'Any', stack: 'Any',
    };
    const pfSet = (patch: Partial<PeopleFilters>) => set((st) => ({ pf: { ...st.pf, ...patch }, peopleSel: {} }));
    const historyFilterOn = live && !!s.pf.history && s.pf.history !== 'Any';
    /** The People "More filters" panel (app/components/people/MoreFilters.tsx). */
    const peopleMore = {
      open: s.pfMoreOpen,
      toggle: () => set((st) => ({ pfMoreOpen: !st.pfMoreOpen, pfOpen: null })),
      close: () => set({ pfMoreOpen: false }),
      active: (['history', 'offer', 'arv', 'market', 'subs', 'props', 'stack'] as const).filter((k) => (s.pf[k] ?? 'Any') !== 'Any').length,
      values: s.pf,
      set: pfSet,
      clear: () => pfSet(MORE_CLEAR),
      stages: sellerStages, markets: peopleMarkets,
      when: HISTORY_WHEN, money: MONEY_BUCKETS, subs: SUBMISSION_STEPS, props: PROPERTY_STEPS, stack: STACK_STEPS,
      historyLoading: historyFilterOn && !(peopleHistoryKey && historyHits[peopleHistoryKey]),
    };
    const clearFilters = () =>
      set({
        vendorType: 'Any', vendorState: 'Any', vendorSubs: 'Any',
        pf: {
          owner: 'Any', stage: 'Any', source: 'Any', tag: 'Any', date: 'Any', compr: 'Any',
          closeCalls: 'Any', declined: 'Any', submitter: 'Any', phone: 'Any', email: 'Any',
          sort: 'Recent', gapBasis: s.pf.gapBasis, gapWithin: s.pf.gapWithin, ...MORE_CLEAR,
        },
        pfOpen: null,
      });
    const hasActiveFilters = activeFilterCount > 0 || s.pf.sort !== 'Recent';
    const sortPeopleColumn = (key: string) => {
      const next = peopleColumnSort(s.pf.sort, key);
      if (!next) return;
      set((st) => ({ pf: { ...st.pf, sort: next }, pfOpen: null, peopleSel: {} }));
    };

    const isPodioUs = (p: Person) => /Podio stage:\s*US\b/i.test(p.notes ?? '');
    const listDefs: Record<string, (p: Person) => boolean> = {
      'My Leads': (p) => p.assigned === ME,
      'New Leads': (p) => (live ? sellerStageGroup(p.stage) === 'lead' : p.stage === 'New Lead'),
      'DM Prospects': (p) => isDmProspect(p.source, p.tags),
      'Hot Leads': (p) => leadTemp(p) === 'HOT',
      // A live seller's next-task line names only its earliest task and says
      // "Yesterday" for a day-late one, so live reads the tasks' due-date buckets.
      'Follow Up Today': (p) => /Today|Now|Overdue/.test(p.nextTask)
        || (!!live && dueNowIds.has(p.id)),
      'No Contact': (p) => p.lastCommTs == null,
      'Offers Out': (p) => (live ? sellerStageGroup(p.stage) === 'offer' : ['Offer Sent', 'Negotiation'].includes(p.stage)),
      Appointments: (p) => (live ? p.stage.startsWith('Appointment') : p.stage === 'Appointment'),
      'Long-Term Follow-Up': (p) => p.tags.includes('Long-term'),
      // Same rules as AI Autopilot's nightly reactivation (lib/reactivation.ts).
      'Dead Leads': (p) => (live ? isDeadLeadStage(p.stage) : p.stage === 'Lost'),
      Reactivation: (p) => (live ? isReactivationLead(p.stage, p.lastCommTs) : (p.lastCommTs ?? 0) > SMART_LIST_QUIET_MIN && p.stage !== 'Lost'),
      Unassigned: (p) => !p.assigned,
      'Recently Active': (p) => p.lastCommTs != null && p.lastCommTs < 200,
      // Podio Partnerships › Submissions views — order matches Podio's Team rail.
      'New Submissions': (p) => (PODIO_NEW_SUBMISSIONS as readonly string[]).includes(p.stage),
      'Total Submissions': (p) => (PODIO_SUBMISSION_STAGES as readonly string[]).includes(p.stage) || isPodioUs(p),
      'New Submission': (p) => p.stage === 'New Submission' && !isPodioUs(p),
      Underwriting: (p) => p.stage === 'Underwriting',
      'Underwrite Declined': (p) => p.stage === 'Underwrite Declined',
      'Underwriting - Need Info': (p) => p.stage === 'Underwriting - Need Info',
      'Underwriting Complete': (p) => p.stage === 'Underwriting Complete',
      'Offer Made': (p) => p.stage === 'Offer Made',
      'Pending Response': (p) => p.stage === 'Pending Response',
      'Offer Declined': (p) => p.stage === 'Offer Declined',
      'Offer Accepted': (p) => p.stage === 'Offer Accepted',
      'Under Contract - Seller': (p) => p.stage === 'Under Contract - Seller',
      'Auction.com': (p) => p.stage === 'Auction.com',
      US: (p) => isPodioUs(p),
    };
    // Operational lists first, then Podio submission views in Podio's order.
    const SMART_LIST_ORDER = [
      'My Leads', 'New Leads', 'DM Prospects', 'Hot Leads', 'Follow Up Today', 'No Contact',
      'Offers Out', 'Appointments', 'Long-Term Follow-Up', 'Dead Leads', 'Reactivation',
      'Unassigned', 'Recently Active',
      'New Submissions', 'New Submission', 'Underwriting',
      'Total Submissions', ...PODIO_TOTAL_SUBMISSIONS,
    ];
    // Only Sellers is people-shaped. Buyers routes to the buyer screen; the
    // vendor-backed lists render a vendor table; the rest have no data behind
    // them, so they are disabled rather than showing an empty list.
    const customDefs: Record<string, (p: Person) => boolean> = { Sellers: () => true };
    const VENDOR_LISTS: Record<string, string | null> = {
      Vendors: null, Lenders: 'Lender', 'Title Companies': 'Title Company', 'Photographers / Notaries': 'Photographer/Notary',
      Wholesalers: 'Wholesaler', Partners: 'Institutional seller',
    };
    // Wholesalers and institutional sellers are deal sources with lists of
    // their own, not service vendors, so the Vendors list leaves them out.
    const NOT_VENDORS = ['Wholesaler', 'Institutional seller'];
    const UNBACKED_LISTS: string[] = [];
    // The vendors an import just wrote, whatever their type.
    const importIdSet = new Set(s.lastImport?.ids ?? []);
    if (s.lastImport?.kind === 'vendors') VENDOR_LISTS[LAST_IMPORT] = null;
    const vendorsFor = (list: string) => {
      if (list === LAST_IMPORT) return vendors.filter((v) => importIdSet.has(v.id));
      const kind = VENDOR_LISTS[list];
      return kind ? vendors.filter((v) => v.kind === kind) : vendors.filter((v) => !NOT_VENDORS.includes(v.kind));
    };
    /** The vendor list that holds this contact. Vendors leaves out wholesalers and partners (Offerpad). */
    const vendorListOf = (vendorId: string, fallback = 'Vendors') => {
      const kind = vendors.find((v) => v.id === vendorId)?.kind;
      const list = kind ? Object.keys(VENDOR_LISTS).find((l) => l !== LAST_IMPORT && VENDOR_LISTS[l] === kind) : undefined;
      return list ?? (kind && NOT_VENDORS.includes(kind) ? fallback : 'Vendors');
    };
    const customCounts: Record<string, number> = {
      Sellers: people.length, Buyers: buyers.length,
      Vendors: vendors.length, Lenders: vendorsFor('Lenders').length,
      'Title Companies': vendorsFor('Title Companies').length,
      'Photographers / Notaries': vendorsFor('Photographers / Notaries').length,
      Agents: realtorCorpusTotal, Wholesalers: vendorsFor('Wholesalers').length, Partners: vendorsFor('Partners').length,
    };
    const mkList = (label: string, count: number) => ({
      label, count,
      go: () => set({ peopleList: label, peopleSel: {} }),
      bg: s.peopleList === label ? '#E7F8F1' : 'transparent',
      color: s.peopleList === label ? '#0A8560' : '#27272a',
      weight: s.peopleList === label ? 600 : 500,
      pin: s.pinnedSmartLists.includes(label) ? '#18181b' : '#e4e4e7',
      pinned: s.pinnedSmartLists.includes(label),
    });
    // Submissions are deals (one house each). Counting sellers hid the ~4,000
    // Podio rows behind the few hundred people who submitted them.
    const submissionLabels = new Set<string>(['New Submissions', 'Total Submissions', ...PODIO_TOTAL_SUBMISSIONS]);
    // Podio's own items when the sync has them: every count is Podio's, item for item.
    const podioSubs: PodioSubmission[] = (D as { podioSubmissions?: PodioSubmission[] }).podioSubmissions ?? [];
    // Podio is retired (Oct 2026): the team imports and moves submissions in
    // CLOZR. The lists are CLOZR's own deals, one row per house on its lead
    // stage, so an import or a stage move is the list. Podio's item ledger is
    // no longer what the lists count.
    const exactPodio = false;
    // Podio's stage, unless the house was moved in CLOZR (this session, or by a
    // person since Podio's last stage change): Podio never hears of those moves.
    const subStage = (i: PodioSubmission) => podioRowStage(i, i.dealId ? s.stageOverrides['sub:' + i.dealId] : null);
    // Sheet imports (iFinder and the rest) have no Podio item. They still count.
    const podioDealIds = new Set(podioSubs.flatMap((i) => (i.dealId ? [i.dealId] : [])));
    // A sheet submission moved this session (Underwriting Complete) is on its new
    // list right away, as a Podio item is; the saved stage only arrives on reload.
    const subDeals = deals.map((d) => {
      const moved = s.stageOverrides['sub:' + d.id];
      return moved && moved !== d.leadStage ? { ...d, leadStage: moved } : d;
    });
    const countFor = (label: string) => live && submissionLabels.has(label)
      ? (exactPodio
        ? podioSubs.filter((i) => podioItemInList(subStage(i), label)).length + nativeSubmissionDeals(subDeals, podioDealIds, label).length
        : subDeals.filter((d) => !d.archived && submissionListMatch(d.leadStage, label, d.stage)).length)
      : people.filter(listDefs[label] ?? (() => false)).filter(pfMatch).length;
    const smartLists = SMART_LIST_ORDER.filter((l, i, a) => a.indexOf(l) === i && listDefs[l]).map((l) => mkList(l, countFor(l)));
    // Podio-shaped rail: group headers + indented stage children (same order as Podio Team views).
    const submissionNav = [
      {
        kind: 'group' as const,
        ...mkList('New Submissions', countFor('New Submissions')),
        children: PODIO_NEW_SUBMISSIONS.map((label) => mkList(label, countFor(label))),
      },
      {
        kind: 'group' as const,
        ...mkList('Total Submissions', countFor('Total Submissions')),
        children: PODIO_TOTAL_SUBMISSIONS.map((label) => mkList(label, countFor(label))),
      },
    ];
    // Partnerships works submissions and vendors only: no seller smart lists.
    const operationalBase = !seesSellerLists(role) ? [] : smartLists.filter((l) => !['New Submissions', 'Total Submissions', ...PODIO_TOTAL_SUBMISSIONS].includes(l.label));
    const operationalOrder = layoutSmartLists(operationalBase.map((l) => l.label), s.smartListOrder, s.pinnedSmartLists);
    const operationalLists = operationalOrder.flatMap((label) => operationalBase.filter((l) => l.label === label));
    const persistSmartLayout = (order: string[], pinned: string[]) => {
      try { localStorage.setItem('clozr.smartListLayout', JSON.stringify({ order, pinned })); } catch { /* private mode */ }
    };
    const dropSmartList = (from: string, before: string) => {
      const displayed = operationalLists.map((l) => l.label);
      const next = applySmartListDrop(displayed, s.pinnedSmartLists, from, before);
      persistSmartLayout(next.order, next.pinned);
      set({ smartListOrder: next.order, pinnedSmartLists: next.pinned });
    };
    const pinSmartList = (label: string) => {
      const pinned = togglePinnedList(s.pinnedSmartLists, label);
      const order = operationalLists.map((l) => l.label);
      persistSmartLayout(order, pinned);
      set({ smartListOrder: order, pinnedSmartLists: pinned });
    };
    const CUSTOM_ORDER = ['Sellers', 'Agents', 'Wholesalers', 'Buyers', 'Vendors', 'Title Companies', 'Photographers / Notaries', 'Lenders', 'Partners']
      .filter((l) => peopleListOk(role, l));
    const customLists = CUSTOM_ORDER.map((l) => {
      const dead = UNBACKED_LISTS.includes(l);
      return {
        ...mkList(l, customCounts[l] ?? 0),
        disabled: dead,
        title: dead ? 'No ' + l.toLowerCase() + ' in the graph yet — add one from Quick Add to enable this list' : '',
        go: dead ? () => {} : l === 'Buyers' ? () => go('buyers') : l === 'Agents' ? () => { setRealtorOffset(0); go('buyers', { buyerList: 'realtors', buyerQ: '', buyerGeniusOnly: false }); } : () => set({ peopleList: l, peopleSel: {}, vendorType: 'Any', vendorState: 'Any', vendorSubs: 'Any' }),
        color: dead ? '#c4c4c8' : s.peopleList === l ? '#0A8560' : '#27272a',
      };
    });
    const canSeeList = (l: { access?: string[]; mine?: boolean }) => smartListVisible(l, ME);
    const savedListRows = s.savedLists.filter(canSeeList).map((l) => ({
      ...mkList(l.name, people.filter(pfMatchOf(l.filters)).length),
      id: l.id,
      accessLabel: !l.access?.length ? 'Everyone' : l.access.length === 1 && l.access[0] === ME ? 'Only you' : l.access.length === 1 ? '1 person' : l.access.length + ' people',
      go: () => openSavedList(l.id),
      // Only the one who saved it can delete it (saved_views RLS). The rail asks first.
      canRemove: l.mine !== false,
      remove: () => deleteSavedList(l.id),
    }));
    const hasSavedLists = s.savedLists.length > 0;
    const isSavedList = s.savedLists.some((l) => l.name === s.peopleList);
    const filterFn = isSavedList
      ? () => true
      : listDefs[s.peopleList] || customDefs[s.peopleList] || (() => true);
    const peopleSearch = parseSearch(s.peopleQ);
    const showingSubmissions = live && submissionLabels.has(s.peopleList);
    const submissionPerson = (d: Deal, from: 'podio' | 'sheet' = 'podio'): Person => {
      const seller = d.personId ? person(d.personId) : undefined;
      const addr = d.addr || seller?.property.addr || 'Submission';
      const home = seller?.property;
      // A sellers-table person keeps their own name, phone, and email. Vendors
      // attached as sellers fill only what that person does not already have.
      const who = submissionIdentity(seller, d.vendorSellers ?? [], addr);
      return {
        id: 'sub:' + d.id,
        name: who.name,
        stage: s.stageOverrides['sub:' + d.id] || d.leadStage || 'New Submission',
        score: null,
        assigned: d.owner || seller?.assigned || null,
        source: d.tracker?.leadSource || seller?.source || (from === 'podio' ? 'Podio' : 'Import'),
        phone: who.phone,
        email: who.email,
        lastComm: seller?.lastComm || '—',
        lastCommTs: seller?.lastCommTs ?? null,
        nextTask: '—',
        offer: d.contract != null ? fmt(d.contract) : null,
        created: (d.submittedAt || d.createdAt || '').slice(0, 10) || '—',
        createdAt: d.submittedAt || d.createdAt,
        tags: [from === 'podio' ? 'Podio submission' : 'Submission', ...who.vendorLabels.map((n) => 'Seller · ' + n)],
        market: seller?.market && seller.market !== '—' ? seller.market : personMarket(null, d.city || home?.city, home?.st),
        notes: null,
        motivation: '—', timeline: '—', condition: '—', occupancy: '—', mortgage: '—',
        asking: d.asking != null ? fmt(d.asking) : '—',
        desiredClose: '—', decisionMakers: '—',
        property: {
          addr, city: d.city || home?.city || '', st: d.st || home?.st || '', zip: d.zip || home?.zip || '',
          // The deal's own house, else the seller's: the map pins the submission, not where the seller lives.
          ...(d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : home?.lat != null && home?.lng != null && !d.addr ? { lat: home.lat, lng: home.lng } : {}),
          beds: home?.beds ?? 0, baths: home?.baths ?? 0, sqft: home?.sqft ?? 0, year: home?.year ?? 0,
          lot: home?.lot || '—', type: home?.type || '—', img: d.heroUrl || d.photos?.[0] || '', apn: home?.apn || '—',
        },
      };
    };
    // Search runs over every lead in the list (not just the drawn page) and
    // ranks name matches first; the list's sort orders within each rank.
    // "View imported": the leads and submissions the last import wrote, nothing else.
    const lastImportRows = s.peopleList === LAST_IMPORT && s.lastImport && s.lastImport.kind !== 'buyers' && s.lastImport.kind !== 'vendors'
      ? [...people.filter((p) => importIdSet.has(p.id)), ...deals.filter((d) => importIdSet.has('sub:' + d.id)).map((d) => submissionPerson(d))]
      : null;
    // One row per Podio item: Podio's stage on it, and a resubmission CLOZR keeps on
    // one deal shows once per submission ('sub:d12~4567'). Items with no CLOZR deal
    // (tests, no address, an ambiguous match) are counted and noted, not listed.
    const dealById = new Map(deals.map((d) => [d.id, d] as const));
    const podioListed = showingSubmissions && exactPodio ? podioSubs.filter((i) => podioItemInList(subStage(i), s.peopleList)) : [];
    const podioOutside = s.subPartner ? 0 : podioListed.filter((i) => !i.dealId || !dealById.has(i.dealId)).length;
    const podioArchived = s.subPartner ? 0 : podioListed.filter((i) => i.dealId && dealById.get(i.dealId)?.archived).length;
    const podioRows = (): Person[] => {
      const seen = new Set<string>();
      return podioListed.flatMap((i) => {
        const d = i.dealId ? dealById.get(i.dealId) : undefined;
        // A submission is archived from its deal; Podio still lists the item, CLOZR does not.
        if (!d || d.archived || (s.subPartner && d.personId !== s.subPartner.id)) return [];
        const base = submissionPerson(d);
        const id = seen.has(d.id) ? `${base.id}~${i.itemId}` : base.id;
        seen.add(d.id);
        return [{ ...base, id, stage: subStage(i) || base.stage, created: (i.createdOn || '').slice(0, 10) || base.created, createdAt: i.createdOn || base.createdAt }];
      });
    };
    const sheetRows = showingSubmissions && exactPodio
      ? nativeSubmissionDeals(subDeals, podioDealIds, s.peopleList)
        .filter((d) => !s.subPartner || d.personId === s.subPartner.id)
        .map((d) => submissionPerson(d, 'sheet'))
      : [];
    const peopleFiltered = searchRows((lastImportRows ?? (showingSubmissions
      ? (exactPodio ? [...podioRows(), ...sheetRows] : subDeals.filter((d) => !d.archived && submissionListMatch(d.leadStage, s.peopleList, d.stage) && (!s.subPartner || d.personId === s.subPartner.id)).map((d) => submissionPerson(d, 'sheet')))
      : people.filter((p) => !secretHidden(p.id, p.tags)).filter(filterFn)))
      .filter((p) => !showingSubmissions || !secretHidden(p.id, p.tags))
      .filter(pfMatch)
      .sort(pfSort), (p) => peopleSearchKeys.get(p.id) ?? personSearchKey(p), peopleSearch);
    // Columns are data-driven so the list can show only the fields you pick.
    // `kind` tells the table how to render the cell; 'name' is always shown.
    const PEOPLE_COLUMNS: { key: string; label: string; kind: string; locked?: boolean }[] = [
      { key: 'name', label: 'Name', kind: 'name', locked: true },
      { key: 'stage', label: 'Stage', kind: 'stage' },
      { key: 'property', label: 'Property', kind: 'property' },
      { key: 'phone', label: 'Phone', kind: 'contact' },
      { key: 'assigned', label: 'Assigned', kind: 'assigned' },
      { key: 'source', label: 'Source', kind: 'muted' },
      { key: 'lastComm', label: 'Last communication', kind: 'muted' },
      { key: 'nextTask', label: 'Next task', kind: 'text' },
      { key: 'score', label: 'Lead score', kind: 'score' },
      { key: 'offer', label: 'Offer', kind: 'strong' },
      { key: 'created', label: 'Date added', kind: 'muted' },
      // Off by default; the Columns menu and saved views turn them on.
      { key: 'email', label: 'Email', kind: 'contact' },
      { key: 'market', label: 'Market', kind: 'muted' },
      { key: 'city', label: 'City', kind: 'muted' },
      { key: 'zip', label: 'ZIP', kind: 'muted' },
      { key: 'asking', label: 'Asking', kind: 'strong' },
      { key: 'motivation', label: 'Motivation', kind: 'text' },
      { key: 'timeline', label: 'Timeline', kind: 'muted' },
      { key: 'condition', label: 'Condition', kind: 'muted' },
      { key: 'occupancy', label: 'Occupancy', kind: 'muted' },
      { key: 'tags', label: 'Tags', kind: 'muted' },
      // List stacking (lib/people-stack): ARV of their deal, deals sent, properties held, lists they are on.
      { key: 'arv', label: 'ARV', kind: 'strong' },
      { key: 'subs', label: 'Submissions', kind: 'muted' },
      { key: 'props', label: 'Properties', kind: 'muted' },
      { key: 'stack', label: 'List stack', kind: 'muted' },
    ];
    const DEFAULT_PEOPLE_COLS = ['name', 'stage', 'property', 'phone', 'assigned', 'source', 'lastComm', 'nextTask', 'score', 'offer', 'created'];
    // Saved against the smart list, so each list remembers its own field set.
    const visibleColKeys = s.peopleColsByList[s.peopleList] || DEFAULT_PEOPLE_COLS;
    // In the order the rep put them (Columns menu), the locked Name first.
    const peopleColumns = [
      ...PEOPLE_COLUMNS.filter((c) => c.locked),
      ...visibleColKeys.flatMap((k) => PEOPLE_COLUMNS.filter((c) => c.key === k && !c.locked)),
    ];
    const setCols = (keys: string[]) =>
      set((st) => ({ peopleColsByList: { ...st.peopleColsByList, [st.peopleList]: keys } }));
    const peopleColPicker = PEOPLE_COLUMNS.map((c) => {
      const on = !!c.locked || visibleColKeys.includes(c.key);
      return {
        key: c.key, label: c.label, on, locked: !!c.locked,
        toggle: () => {
          if (c.locked) return;
          setCols(on ? visibleColKeys.filter((k) => k !== c.key) : [...visibleColKeys, c.key]);
        },
        box: on ? '#18181b' : '#fff',
        boxBorder: on ? '#18181b' : '#d4d4d8',
        color: c.locked ? '#a1a1aa' : '#18181b',
      };
    });
    const peopleColsShown = peopleColumns.length;
    const peopleColsTotal = PEOPLE_COLUMNS.length;
    const peopleColsAllOn = peopleColsShown === peopleColsTotal;

    // ---- SAVED SMART LISTS -----------------------------------------------------
    // A saved list captures the current filter set and column choice under a name.
    // Reopening it reapplies both. `settings` is the seam the AI layer will use to
    // hang per-list options (nothing reads it yet).
    const savedListDefs = s.savedLists;
    const savedListNames = savedListDefs.map((l) => l.name);
    const suggestedListName = (() => {
      const base = 'Saved list';
      const n = savedListDefs.length + 1;
      const name = activeFilterCount
        ? PF_DEFS.filter((d) => d.key !== 'sort' && s.pf[d.key] !== 'Any')
            .map((d) => picksOf(s.pf[d.key]).join(', ')).join(' · ')
        : base + ' ' + n;
      return savedListNames.includes(name) ? name + ' ' + n : name;
    })();
    const saveSmartList = () => set({ smartListOpen: true });
    const closeSmartList = () => set({ smartListOpen: false });
    const commitSmartList = (name: string, access: string[]) => {
      const trimmed = name.trim();
      if (!trimmed) return toast('Name the list first');
      const unique = savedListNames.includes(trimmed) ? trimmed + ' ' + (savedListDefs.length + 1) : trimmed;
      const ids = Array.from(new Set(access.filter(Boolean)));
      const made = {
        id: nextId('sl'),
        name: unique,
        filters: { ...s.pf },
        cols: s.peopleColsByList[s.peopleList] || DEFAULT_PEOPLE_COLS,
        access: ids,
        mine: true,
      };
      set((prev) => ({
        savedLists: [...prev.savedLists, made],
        peopleList: unique,
        cursorList: unique,
        peopleCursor: 0,
        smartListOpen: false,
        colsOpen: false,
      }));
      // Kept in saved_views (lib/smart-lists.ts), so it is there after a reload
      // and on the teammates' screens it was opened to. The demo keeps it in
      // this browser. The session copy swaps its id for the saved row's.
      if (readOnly) return toast(READ_ONLY_MESSAGE);
      void insertSmartList(live ? workspaceId : null, live ? me : null, made, s.savedLists).then((id) => {
        if (!id) return toast(`"${unique}" is on your list for now, but it did not save.`, 'error');
        set((prev) => ({ savedLists: prev.savedLists.map((x) => (x.id === made.id ? { ...x, id } : x)) }));
        toast('Saved "' + unique + '"', 'success');
      });
    };
    const openSavedList = (id: string) => {
      const l = s.savedLists.find((x) => x.id === id);
      if (!l) return;
      set((st) => ({
        peopleList: l.name,
        pf: { ...l.filters },
        peopleColsByList: { ...st.peopleColsByList, [l.name]: l.cols },
        peopleSel: {},
      }));
    };
    const deleteSavedList = (id: string) => {
      const gone = s.savedLists.find((x) => x.id === id);
      if (!gone) return;
      if (readOnly) return toast(READ_ONLY_MESSAGE);
      set((st) => ({
        savedLists: st.savedLists.filter((x) => x.id !== id),
        peopleList: gone.name === st.peopleList ? 'My Leads' : st.peopleList,
      }));
      void deleteSmartList(live ? workspaceId : null, live ? me : null, id, s.savedLists).then((ok) => {
        if (ok) return toast('Deleted "' + gone.name + '"', 'success');
        set((st) => ({ savedLists: st.savedLists.some((x) => x.id === id) ? st.savedLists : [...st.savedLists, gone] }));
        toast('"' + gone.name + '" did not delete. It is back on the list.', 'error');
      });
    };

    // Vendor-backed lists render a vendor table instead of the people table.
    const isVendorList = Object.prototype.hasOwnProperty.call(VENDOR_LISTS, s.peopleList);
    const listLen = isVendorList ? 0 : peopleFiltered.length;
    const peopleCursor = s.cursorList === s.peopleList ? Math.min(s.peopleCursor, Math.max(0, listLen - 1)) : 0;
    const smartListNames = [...SMART_LIST_ORDER.filter((l, i, a) => a.indexOf(l) === i && listDefs[l]), ...s.savedLists.filter(canSeeList).map((l) => l.name)];
    const moveInList = (dir: 1 | -1) => {
      if (isVendorList || !listLen) return;
      set({ peopleCursor: stepIndex(peopleCursor, listLen, dir), cursorList: s.peopleList });
    };
    // On the open record, the same step opens that neighbor. The cursor follows
    // so coming back to the list highlights the person now on screen.
    // A submission opens its seller pinned to that house, so its row is 'sub:<deal>'.
    const openRow = openRowId(peopleFiltered.map((p) => p.id), s.personId, s.personDealId);
    const moveOpenRecord = (dir: 1 | -1) => {
      if (s.screen !== 'person' || isVendorList) return;
      const ids = peopleFiltered.map((p) => p.id);
      const nextId = adjacentOpenRow(ids, openRow, dir);
      if (!nextId) return;
      const idx = ids.indexOf(nextId);
      // Open it the way a click on the row does: a submission row opens its seller on that house.
      openListed(peopleFiltered[idx]);
      set({ peopleCursor: idx, cursorList: s.peopleList });
    };
    const moveSmartList = (dir: 1 | -1) => {
      const next = stepLabel(s.peopleList, smartListNames, dir);
      if (next === s.peopleList) return;
      const saved = s.savedLists.find((l) => l.name === next);
      set(saved
        ? { peopleList: next, pf: { ...saved.filters }, peopleSel: {}, peopleCursor: 0, cursorList: next }
        : { peopleList: next, peopleSel: {}, peopleCursor: 0, cursorList: next });
    };
    const shiftStage = (dir: 1 | -1) => {
      const onRecord = s.screen === 'person' && !!s.personId;
      // On the record, P is the house in view: a submission's stage is its deal's.
      const p = onRecord ? (P.id === s.personId ? P : undefined) : peopleFiltered[peopleCursor];
      if (!p || (!onRecord && isVendorList)) return toast('Pick a person on a smart list first');
      const next = adjacentStage(p.stage, dir, SELLER_STAGE_LABELS);
      if (!next) return toast(dir > 0 ? 'Already at the last stage' : 'Already at the first stage');
      if (onRecord) { void moveStage(next); return; }
      if (live && !canWrite) return toast(readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE);
      if (p.id.startsWith('sub:')) {
        set((x) => ({ stageOverrides: { ...x.stageOverrides, [subKey(p.id)]: next } }));
        persistSubmissionStage([subDealId(p.id)], next);
        toast((dir > 0 ? 'Next stage · ' : 'Back a stage · ') + next);
        return;
      }
      set((x) => ({ stageOverrides: { ...x.stageOverrides, [p.id]: next } }));
      persistStage(p.id, next);
      toast((dir > 0 ? 'Next stage · ' : 'Back a stage · ') + next);
    };
    const vendorGapMatch = gapMatchOf(s.pf);
    // Type and state narrow a vendor list. A contact serves a state when it
    // works there (migration 80) or lists it as a market, so a title company
    // in Charlotte that closes South Carolina shows under SC too.
    const vendorBase = isVendorList ? vendorsFor(s.peopleList) : [];
    // States a vendor works in: the state column, a state listed as a market,
    // or the state of a "City, ST" market. The menu shows names ("Texas");
    // the rows compare codes.
    const vendorStates = (v: Vendor): string[] => Array.from(new Set(
      [v.state || '', ...(v.markets ?? []).map((m) => m.split(',').pop() ?? '')].map((x) => placeStateCode(x) ?? '').filter(Boolean)));
    const servesState = (v: Vendor, st: string) => vendorStates(v).includes(st);
    const vendorTypeOptions = ['Any', ...Array.from(new Set(vendorBase.map((v) => v.kind))).sort()];
    const vendorStateOptions = ['Any', ...Array.from(new Set(vendorBase.flatMap(vendorStates))).map(stateNameOf).sort(), 'No location'];
    // Both take several picks (lib/multi-filter); a vendor passes on any of them.
    const vendorType = keepPicks(s.vendorType, vendorTypeOptions);
    const vendorTypes = picksOf(vendorType);
    // A saved view may still hold the code the menu used to show.
    const vendorState = joinPicks(picksOf(s.vendorState).map((st) => (vendorStateOptions.includes(st) ? st : stateNameOf(st))).filter((st) => vendorStateOptions.includes(st)));
    const vendorStatePicks = picksOf(vendorState);
    const vendorStateCodes = vendorStatePicks.map((st) => placeStateCode(st) ?? '').filter(Boolean);
    const locOf = (v: Vendor) => [v.city, v.state].filter(Boolean).join(', ');
    // A source's true count (migration 91): Offerpad has sent 884. Only a list
    // that holds a source with a submission gets the columns, the filter and
    // the sort; a title company list would be a wall of dashes.
    const vendorHasSubs = vendorBase.some((v) => (v.subs ?? 0) > 0);
    const vendorSubsMin = vendorHasSubs ? atLeastOf(s.vendorSubs) : 0;
    const VENDOR_SORTS: Record<string, (v: Vendor) => number> = {
      'Most submissions': (v) => v.subs ?? 0, 'Most offers': (v) => v.offered ?? 0,
      'Most accepted': (v) => v.accepted ?? 0, 'Most closed': (v) => v.closed ?? 0,
    };
    const vendorSort = vendorHasSubs && VENDOR_SORTS[s.vendorSort] ? s.vendorSort : 'Name';
    const vendorOrder = (a: Vendor, b: Vendor) => {
      const by = VENDOR_SORTS[vendorSort];
      return (by ? by(b) - by(a) : 0) || a.name.localeCompare(b.name);
    };
    const countCell = (n: number | undefined) => (n ? n.toLocaleString() : '—');
    const vendorRows = vendorBase
      .filter((v) => !vendorTypes.length || vendorTypes.includes(v.kind))
      .filter((v) => !vendorStatePicks.length
        || (vendorStatePicks.includes('No location') && !v.state && !(v.markets ?? []).length)
        || vendorStateCodes.some((code) => servesState(v, code)))
      .filter((v) => !peopleSearch || searchRank(searchKey([v.name, v.contact], [v.kind, v.market, v.city, v.state, v.office, v.email, ...(v.markets ?? [])], [v.phone]), peopleSearch) >= 0)
      .filter((v) => vendorGapMatch(v.id))
      .filter((v) => matchesContactFilters(v.phone, v.email, s.pf.phone, s.pf.email))
      .filter((v) => (v.subs ?? 0) >= vendorSubsMin)
      .sort(vendorOrder)
      .map((v) => {
        const g = gapStatOf(v.id, s.pf);
        return {
        id: v.id, name: v.name, kind: v.kind, contact: v.contact, phone: v.phone,
        email: v.email, market: locOf(v) || v.market, note: v.note,
        city: v.city || '', state: v.state || '', office: v.office || '', location: locOf(v),
        markets: (v.markets ?? []).join(', '), mainPoc: !!v.mainPoc,
        subsN: v.subs ?? 0, rank: VENDOR_SORTS[vendorSort]?.(v) ?? 0,
        subs: countCell(v.subs), offered: countCell(v.offered), accepted: countCell(v.accepted), closed: countCell(v.closed),
        subsLine: v.subs ? `${v.subs.toLocaleString()} ${v.subs === 1 ? 'submission' : 'submissions'} · ${(v.offered ?? 0).toLocaleString()} offered · ${(v.accepted ?? 0).toLocaleString()} accepted · ${(v.closed ?? 0).toLocaleString()} closed` : '',
        setMainPoc: () => void toggleMainPoc(v),
        editLocation: () => void editVendorLocation(v),
        stars: '★'.repeat(v.rating) + '☆'.repeat(Math.max(0, 5 - v.rating)),
        rated: v.rating > 0,
        scoreLine: isDealSource(v.kind) ? formatSourceScore(sourceScorecard((() => {
          const byName = (deals ?? []).filter((d) => {
            const src = (d.tracker?.leadSource || person(d.personId)?.source || '').toLowerCase();
            const name = v.name.toLowerCase();
            return !!src && (src === name || src.includes(name) || name.includes(src));
          });
          if (byName.length) {
            return byName.map((d) => flagsForStage(d.stage || d.leadStage || person(d.personId)?.stage || '', d.profit ?? 0, (d.contract ?? 0) > 0 || (d.assignment ?? 0) > 0));
          }
          return (gapsByPerson.get(v.id) ?? []).map((g) => flagsForStage(g.stage, 0, true));
        })())) : '',
        national: isDealSource(v.kind) && isNationalSource({ kind: v.kind, name: v.name, note: v.note }),
        emailFollowup: isDealSource(v.kind) && sourceGetsEmailFollowup({ kind: v.kind, name: v.name, note: v.note }),
        // Offer gaps (migration 70). A company with no offered deal shows a dash
        // rather than a zero, because none was ever measured.
        offers: g.offers ? String(g.offers) : '—',
        closeCalls: g.offers ? String(g.closeCalls) : '—',
        hasCloseCalls: g.closeCalls > 0,
        closestGap: g.closest == null ? '—' : fmt(g.closest),
        declined: g.declined ? String(g.declined) : '—',
        openGaps: g.offers ? () => set({ gapOpen: v.id }) : null,
        checked: !!s.peopleSel[v.id], rowBg: s.peopleSel[v.id] ? '#E7F8F1' : '#fff',
        toggle: () => set((st) => ({ peopleSel: { ...st.peopleSel, [v.id]: !st.peopleSel[v.id] } })),
        call: () => startCall({ name: v.contact === '—' ? v.name : v.contact, phone: v.phone }),
        };
      });
    const vendorCols = [
      'Company', 'Type', 'Contact', 'Phone', 'Email', 'Market',
      ...(vendorHasSubs ? ['Submissions', 'Offered', 'Accepted', 'Closed'] : []),
      ...(hasGaps ? ['Offers', 'Close calls', 'Closest gap', 'Declined'] : []),
      'Rating',
    ];
    const vendorCount = vendorRows.length;
    async function toggleMainPoc(v: Vendor) {
      if (!canWrite) return toast('Sign in to set the main contact.');
      const r = await setVendorMainPoc(dbId(v.id), !v.mainPoc);
      if (!r.ok) return toast(r.message ?? 'Could not save that.', 'error');
      toast(v.mainPoc ? 'No longer the main contact' : `${v.contact === '—' ? v.name : v.contact} is the main contact${v.state ? ' in ' + v.state : ''}`, 'success');
      reload?.();
    }
    async function editVendorLocation(v: Vendor) {
      if (!canWrite) return toast('Sign in to edit a vendor.');
      const cur = [v.city, v.state].filter(Boolean).join(', ');
      const next = window.prompt(`Where does ${v.contact === '—' ? v.name : v.contact} work? City, ST (e.g. San Antonio, TX)`, cur);
      if (next == null) return;
      const m = /^\s*(.*?)[,\s]+([A-Za-z]{2})\s*$/.exec(next);
      const r = await setVendorLocation(dbId(v.id), m ? m[1] : next.trim() || null, m ? m[2] : null);
      if (!r.ok) return toast(r.message ?? 'Could not save that.', 'error');
      toast('Location saved', 'success');
      reload?.();
    }
    // Grouped: title companies and the like by company, then location, main
    // contact first; photographers and notaries (one-person businesses) by
    // state, then town. A company is its email domain where it has one, so
    // "Title Partners" and "Title Partners & Associates" land together.
    const GENERIC_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|me|comcast|att|verizon|voyager)\./;
    const companyKey = (r: (typeof vendorRows)[number]) => {
      const dom = /@([\w.-]+)/.exec(r.email)?.[1]?.toLowerCase();
      return dom && !GENERIC_MAIL.test(dom) ? 'd:' + dom : 'n:' + r.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    };
    const byPlace = s.peopleList === 'Photographers / Notaries' || (vendorTypes.length === 1 && vendorTypes[0] === 'Photographer/Notary');
    const groupMap = new Map<string, (typeof vendorRows)[number][]>();
    for (const r of vendorRows) {
      const k = byPlace ? (r.state ? stateNameOf(r.state) : 'No location') : companyKey(r);
      groupMap.set(k, [...(groupMap.get(k) ?? []), r]);
    }
    const vendorGroups = Array.from(groupMap.entries()).map(([key, rows]) => {
      const names = rows.map((r) => r.name);
      const title = byPlace ? key : names.sort((a, b) => b.length - a.length)[0];
      const locMap = new Map<string, (typeof vendorRows)[number][]>();
      for (const r of rows) {
        const lk = byPlace ? r.city || 'Town not set' : r.location || 'No location';
        locMap.set(lk, [...(locMap.get(lk) ?? []), r]);
      }
      const locations = Array.from(locMap.entries())
        .sort(([a], [b]) => (a.startsWith('No ') || a.startsWith('Town not') ? 1 : b.startsWith('No ') || b.startsWith('Town not') ? -1 : a.localeCompare(b)))
        .map(([label, rs]) => ({ key: key + '|' + label, label, rows: [...rs].sort((a, b) => Number(b.mainPoc) - Number(a.mainPoc) || a.contact.localeCompare(b.contact)) }));
      const kinds = Array.from(new Set(rows.map((r) => r.kind)));
      const subsN = rows.reduce((n, r) => n + r.subsN, 0);
      return {
        key, title, rank: rows.reduce((n, r) => n + r.rank, 0),
        sub: byPlace
          ? `${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'} · ${locations.length} ${locations.length === 1 ? 'town' : 'towns'}`
          : `${kinds.join(' · ')} · ${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'}${locations.length > 1 ? ' · ' + locations.length + ' locations' : ''}${subsN ? ` · ${subsN.toLocaleString()} ${subsN === 1 ? 'submission' : 'submissions'}` : ''}`,
        // Worth flagging only where there is a choice to make.
        hasMain: rows.length < 2 || rows.some((r) => r.mainPoc),
        locations,
      };
    }).sort((a, b) => (a.key === 'No location' ? 1 : b.key === 'No location' ? -1 : (b.rank - a.rank) || a.title.localeCompare(b.title)));
    const vendorFilterMenus = [
      ...(vendorTypeOptions.length > 2 ? [mkMenuPeople('vtype', 'Type', vendorTypeOptions, vendorType, (v) => set({ vendorType: v, peopleSel: {} }), true)] : []),
      mkMenuPeople('vstate', 'State', vendorStateOptions, vendorState, (v) => set({ vendorState: v, peopleSel: {} }), true),
      ...(vendorHasSubs ? [
        mkMenuPeople('vsubs', 'Submissions', ['Any', '1+', '10+', '50+', '100+', '500+'], vendorSubsMin ? s.vendorSubs : 'Any', (v) => set({ vendorSubs: v, peopleSel: {} })),
        // Sort is an order, not a filter: it never lights up or counts as one.
        { ...mkMenuPeople('sort', 'Sort', ['Name', ...Object.keys(VENDOR_SORTS)], vendorSort, (v) => set({ vendorSort: v })), on: false, label: vendorSort === 'Name' ? 'Sort' : vendorSort,
          bg: 'var(--c-btn-bg)', color: '#27272a', border: 'var(--c-btn-line)' },
      ] : []),
    ];
    const vendorViewToggle = (['grouped', 'table'] as const).map((k) => ({
      label: k === 'grouped' ? (byPlace ? 'By location' : 'By company') : 'Table',
      on: s.vendorView === k,
      go: () => set({ vendorView: k }),
    }));

    /**
     * The offer-gap drill-down: one person's offered deals, closest first, each
     * marked when it came within the threshold on the chosen basis. It lists
     * every offer rather than only the close ones, so opening a company that
     * has never come close still explains why.
     */
    const gapDetail = (() => {
      const id = s.gapOpen;
      if (!id) return null;
      const gaps = gapsByPerson.get(subKey(id));
      if (!gaps || gaps.length === 0) return null;
      const basis = s.pf.gapBasis ?? 'Either';
      const within = withinOf(s.pf.gapWithin);
      const st = gapStatOf(id, s.pf);
      const who = id.startsWith('v')
        ? (vendors.find((v) => v.id === id)?.name ?? gaps[0].company)
        : (person(id)?.name ?? gaps[0].contact);
      const rows = gaps
        .map((g) => ({ g, d: gapUnder(g, basis) }))
        .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity))
        .map(({ g, d }) => ({
          dealId: g.dealId,
          address: g.address,
          stage: g.stage,
          ask: fmt(g.ask),
          offer: fmt(g.offer),
          high: g.high == null ? '—' : fmt(g.high),
          gap: d == null ? '—' : fmt(d),
          close: d != null && d <= within,
          // A sellers-table seller opens their record. A partner submission whose
          // seller is a vendor (or missing from the graph) still opens, on its deal sheet.
          open: () => {
            set({ gapOpen: null });
            if (g.sellerId && person(g.sellerId)) openPersonDeal(g.sellerId, g.dealId);
            else go('dealSheet', { personId: '', dealSheetDealId: g.dealId });
          },
        }));
      return {
        who,
        // Says out loud which number the gaps are measured against, because the
        // same deal reads very differently on the offer than on the ceiling.
        basis: basis === 'Actual offer' ? 'the offer we sent'
          : basis === 'UW high' ? 'our underwriting ceiling'
            : 'whichever was closer',
        sub: `${st.closeCalls} of ${st.offers} within ${within === Infinity ? 'any gap' : fmt(within)}`,
        rows,
        close: () => set({ gapOpen: null }),
      };
    })();

    const peopleRows = peopleFiltered.map((p, rowIndex) => {
      // Cells are built when a row is drawn, not for all 11,000 on every
      // render: the list only draws a page at a time (components/ds/useReveal).
      const values = (): Record<string, string | number> => ({
        name: p.name, stage: p.stage, property: p.property.addr, phone: p.phone,
        assigned: repName(p.assigned), source: p.source, lastComm: p.lastComm,
        nextTask: p.nextTask, score: p.score ?? '', offer: p.offer || '—', created: p.createdAt ? addedOn(p.createdAt) : p.created,
        email: p.email || '—', market: p.market || '—', city: p.property.city || '—', zip: p.property.zip || '—',
        asking: p.asking || '—', motivation: p.motivation || '—', timeline: p.timeline || '—',
        condition: p.condition || '—', occupancy: p.occupancy || '—', tags: p.tags.length ? p.tags.join(', ') : '—',
        ...(() => {
          const st = stackOf(p);
          return { arv: st.arv != null ? fmt(st.arv) : '—', subs: st.subs, props: st.props, stack: st.stack };
        })(),
      });
      const open = () => openListedAt(p, rowIndex);
      return {
        id: p.id, checked: !!s.peopleSel[p.id], focused: rowIndex === peopleCursor && !isVendorList,
        rowBg: s.peopleSel[p.id] ? '#E7F8F1' : rowIndex === peopleCursor && !isVendorList ? '#f4f4f5' : '#fff',
        toggle: () => set((st) => ({ peopleSel: { ...st.peopleSel, [p.id]: !st.peopleSel[p.id] } })),
        open,
        get cells() {
          const v = values();
          return peopleColumns.map((c) => ({
            key: c.key, kind: c.kind, v: v[c.key],
            isName: c.kind === 'name', isStage: c.kind === 'stage', isProperty: c.kind === 'property',
            // An unscored lead leaves the cell blank, or shows Talkr's temperature.
            isScore: c.kind === 'score' && p.score != null, isAssigned: c.kind === 'assigned',
            isTemp: c.kind === 'score' && p.score == null && !!leadTemp(p), temp: leadTemp(p), tempColor: tempColor(leadTemp(p)),
            isPlain: ['text', 'muted', 'strong'].includes(c.kind),
            isContact: c.kind === 'contact',
            color: c.kind === 'muted' ? '#52525b' : c.kind === 'strong' ? '#18181b' : '#27272a',
            weight: c.kind === 'strong' ? '500' : '400',
            initials: initialsOf(p.name),
            stageColor: stageColor(p.stage),
            cityLine: p.property.city + ', ' + p.property.st + ' ' + p.property.zip,
            scorePct: (p.score ?? 0) + '%', scoreColor: scoreColor(p.score),
            assignedColor: p.assigned ? '#27272a' : '#dc2626',
          }));
        },
      };
    });
    const selectionCount = Object.values(s.peopleSel).filter(Boolean).length;
    const selectedIds = Object.keys(s.peopleSel).filter((id) => s.peopleSel[id]);
    const blacklist = (kind: 'person' | 'buyer', ids: string[], reason = '') => {
      const clean = [...new Set(ids.filter(Boolean))];
      if (!clean.length) return;
      // The reason is its own row (lib/blacklist-reasons.ts) and fails open.
      void saveBlacklistReason(canWrite ? workspaceId : null, kind === 'person' ? 'seller' : 'buyer', clean, reason);
      set((st) => ({
        secretIds: [...new Set([...st.secretIds, ...clean])],
        peopleSel: {},
        ...(kind === 'person' && clean.includes(st.personId) ? { screen: 'people' } : {}),
        ...(kind === 'buyer' && clean.includes(st.buyerId) ? { screen: 'buyers' } : {}),
      }));
      const done = clean.length === 1 ? 'Blacklisted. The list is in Account.' : clean.length + ' blacklisted. The list is in Account.';
      if (!canWrite) return toast(done);
      const write = kind === 'person' ? tagSellers : tagBuyers;
      void write(clean, SECRET_BLACKLIST_TAG).then((r) => {
        if (!r.ok) {
          set((st) => ({ secretIds: st.secretIds.filter((id) => !clean.includes(id)) }));
          return toast(r.message || 'Could not save the blacklist.', 'error');
        }
        reload?.();
        toast(done, 'success');
      });
    };
    const restoreSecret = (id: string) => {
      const personHit = people.some((p) => p.id === id);
      set((st) => ({ secretIds: st.secretIds.filter((x) => x !== id) }));
      if (!canWrite) return toast('Restored to ' + (personHit ? 'People' : 'Buyers'));
      const write = personHit ? untagSellers : untagBuyers;
      void write([id], SECRET_BLACKLIST_TAG).then((r) => {
        if (!r.ok) return toast(r.message || 'Could not restore that.', 'error');
        reload?.();
        toast('Restored', 'success');
      });
    };
    const secretRows = [
      ...people.filter((p) => secretHidden(p.id, p.tags)).map((p) => ({
        id: p.id, kind: 'Person' as const, name: p.name,
        phone: p.phone === '—' ? '' : p.phone, email: p.email === '—' ? '' : p.email,
        detail: p.property?.addr && p.property.addr !== '—' ? p.property.addr : p.stage,
      })),
      ...buyers.filter((b) => secretHidden(b.id, b.tags)).map((b) => ({
        id: b.id, kind: 'Buyer' as const, name: b.name,
        phone: b.phone === '—' ? '' : b.phone, email: b.email === '—' ? '' : b.email,
        detail: b.company,
      })),
    ];
    // A vendor-backed list keeps its selection in the same map, as vendor ids
    // ('v12'); the rows, the bar and the composer below branch on isVendorList.
    const selectedVendors = isVendorList ? vendorRows.filter((r) => s.peopleSel[r.id]) : [];
    /**
     * People › Map: every row the filters left (not just the drawn page), with
     * where the house is: its geocoded point, else its town or ZIP for the map
     * to place (app/components/people/PeopleMap.tsx).
     */
    const peopleMap = {
      // A getter: only the map reads it, so the list view never builds 11,000 of these.
      get rows() {
        return isVendorList ? [] : peopleFiltered.map((p, i) => ({
        id: p.id, name: p.name, addr: p.property.addr, city: p.property.city, st: p.property.st, zip: p.property.zip,
        lat: p.property.lat ?? null, lng: p.property.lng ?? null,
        stage: p.stage, color: stageColor(p.stage), group: live ? sellerStageGroup(p.stage) : 'other',
        offer: p.offer, phone: p.phone, open: () => openListedAt(p, i),
        }));
      },
      selected: s.peopleSel,
      select: (ids: string[]) => set((st) => ({ peopleSel: { ...st.peopleSel, ...Object.fromEntries(ids.map((id) => [id, true])) } })),
      toggle: (id: string) => set((st) => ({ peopleSel: { ...st.peopleSel, [id]: !st.peopleSel[id] } })),
      clear: () => set({ peopleSel: {} }),
    };
    const selectable: { id: string }[] = isVendorList ? vendorRows : peopleFiltered;
    /** After a bulk write: re-read, clear the selection, say what happened. */
    const afterBulk = (r: { ok: boolean; message?: string }, msg: string) => {
      if (!r.ok) return toast(r.message || 'That did not save.', 'error');
      set({ peopleSel: {}, bulkMenu: null });
      reload?.();
      return toast(msg, 'success');
    };
    /** "Select [N]" on the bulk bar: the first N rows of the list, optionally only leads nobody owns yet. */
    const selectFirstPeople = (n: number, unassignedOnly = false) => {
      const ids = isVendorList ? firstN(vendorRows, n) : firstN(peopleFiltered, n, unassignedOnly ? (p) => !p.assigned : undefined);
      set({ peopleSel: Object.fromEntries(ids.map((id) => [id, true])), bulkMenu: s.bulkMenu === 'assign' ? 'assign' : null });
      if (ids.length < n) toast(`${ids.length.toLocaleString('en-US')} selected: that is all this list has${unassignedOnly ? ' without an owner' : ''}`, 'info');
    };
    /** The People Assign panel (app/components/bulk/AssignPanel.tsx): one teammate, or the selection split in blocks. */
    const peopleAssign = {
      open: s.bulkMenu === 'assign' && !isVendorList,
      team: Object.values(D.team).map((r) => ({ id: r.id, name: r.name, initials: r.initials, memberRole: r.memberRole })),
      // Blocks are cut in the order the list shows, so "the next 200" means what it says.
      selectedIds: inListOrder(selectable.map((p) => p.id), s.peopleSel),
      listCount: selectable.length,
      selectFirst: (n: number) => selectFirstPeople(n),
      assign: async (blocks: AssignBlock[]) => {
        const total = blocks.reduce((k, b) => k + b.ids.length, 0);
        const said = blocks.map((b) => `${b.ids.length.toLocaleString('en-US')} to ${b.userId ? repName(b.userId) : 'nobody'}`);
        if (!canWrite) { set({ peopleSel: {}, bulkMenu: null }); return toast(`${total} assigned (demo): ${said.join(' · ')}`); }
        for (let i = 0; i < blocks.length; i++) {
          // Submission rows ('sub:d12') are a partner's houses: the deal's owner, not the partner's.
          const subs = [...new Set(blocks[i].ids.filter((id) => id.startsWith('sub:')).map(subDealId))];
          const rest = blocks[i].ids.filter((id) => !id.startsWith('sub:'));
          const r0 = subs.length ? await assignDeals(subs, blocks[i].userId) : { ok: true as const };
          const r = r0.ok && rest.length ? await assignSellers(rest, blocks[i].userId) : r0;
          if (!r.ok) {
            reload?.();
            return toast(`${i ? said.slice(0, i).join(' · ') + ' saved, then ' : ''}${r.message || 'that did not save.'}`, 'error');
          }
        }
        afterBulk({ ok: true }, `${total.toLocaleString('en-US')} assigned: ${said.join(' · ')}`);
      },
      close: () => set({ bulkMenu: null }),
    };
    /** Bulk "Add to Call Queue" (Sellers and Buyers): anyone already on the rep's queue is skipped. */
    const addToCallQueue = async (kind: QueueKind, ids: string[]) => {
      const r = await cq.add(kind, ids.map(dbId));
      if (!r.ok) return toast(r.message || 'The call queue did not save.', 'error');
      const who = kind === 'seller' ? 'seller' : 'buyer';
      toast(r.added ? `${r.added} ${who}${r.added === 1 ? '' : 's'} added to your call queue` + (r.already ? ` · ${r.already} already on it` : '')
        : `${r.already === 1 ? 'Already' : 'All ' + r.already + ' already'} on your call queue`, r.added ? 'success' : 'info');
    };
    // A submission row is a deal. A sellers-table seller opens their record.
    // A deal whose seller is only a vendor (or has no person in the graph)
    // opens its deal sheet, with personId cleared so the previous record is
    // not borrowed. The sheet is what the team opens when there is no seller row.
    const openListed = (p: Person) => {
      if (!p.id.startsWith('sub:')) return openPerson(p.id);
      const dealId = subDealId(p.id);
      const d = deals.find((x) => x.id === dealId);
      if (d && submissionOpenTarget(d.personId, !!person(d.personId)) === 'person') {
        go('person', { personId: d.personId, personTab: 'Activity', personDealId: d.id });
        noteRecent('person:' + d.personId);
        return;
      }
      go('dealSheet', { personId: '', dealSheetDealId: dealId });
    };
    // A click on a row (table, card, map pin) puts the cursor on it first, the
    // way Enter does, so coming back to the list lands on that row, drawn and
    // scrolled into view, instead of wherever the arrows last were.
    const openListedAt = (p: Person, rowIndex: number) => {
      set({ peopleCursor: rowIndex, cursorList: s.peopleList });
      openListed(p);
    };
    const exportSelected = () => {
      const rows = selectedIds.map((id) => peopleFiltered.find((p) => p.id === id) || person(id)).filter((p): p is Person => !!p);
      const cols: [string, (p: Person) => string][] = [
        ['Name', (p) => p.name], ['Stage', (p) => p.stage], ['Phone', (p) => p.phone], ['Email', (p) => p.email],
        ['Address', (p) => p.property.addr], ['City', (p) => p.property.city], ['State', (p) => p.property.st], ['ZIP', (p) => p.property.zip],
        ['Assigned', (p) => repName(p.assigned)], ['Source', (p) => p.source], ['Asking', (p) => p.asking],
        ['Motivation', (p) => p.motivation], ['Tags', (p) => p.tags.join('; ')], ['Date added', (p) => p.createdAt ? p.createdAt.slice(0, 10) : p.created],
      ];
      const esc = (v: string) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const csv = [cols.map(([k]) => esc(k)).join(','), ...rows.map((p) => cols.map(([, f]) => esc(f(p))).join(','))].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `clozr-${s.peopleList.toLowerCase().replace(/\s+/g, '-')}-${rows.length}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(rows.length + ' exported');
    };
    // The pickers the bar opens: which stage, which plan. Assign has its own panel (peopleAssign).
    const bulkMenuOptions: { label: string; go: () => void }[] =
      s.bulkMenu === 'stage' ? sellerStages.map((st) => ({
        label: st,
        // Asks first: a stage moves every selected lead, and a contract stage
        // opens a deal on each one in the database, so that one asks for a
        // typed reason. Then one write per batch of ids, not one per lead.
        go: () => void (async () => {
          const ids = [...selectedIds];
          const subs = ids.filter((id) => id.startsWith('sub:'));
          const sellers = ids.filter((id) => !id.startsWith('sub:'));
          const n = ids.length;
          const who = `${n.toLocaleString('en-US')} ${n === 1 ? 'lead' : 'leads'}`;
          if (live && !canWrite) return toast(readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE);
          let reason: string | null = null;
          if (live && (opensDeal(st) || isDeadStage(st))) {
            const why = await confirmReason({
              title: `Move ${who} to ${st}?`,
              body: opensDeal(st)
                ? `This opens or moves a deal for each of the ${who}, and the TC and dispo pipelines fill with them. It can't be undone in one step.`
                : `They drop off the call lists. Say why, so whoever picks them up later knows.`,
              reasonLabel: 'Why they are moving', confirmLabel: `Move ${who}`, tone: 'danger',
            });
            if (why === null) return;
            reason = why;
          } else if (!(await confirm({ title: `Move ${who} to ${st}?`, body: 'Each one’s stage changes now.', confirmLabel: `Move ${who}` }))) return;
          set((x) => ({
            peopleSel: {}, bulkMenu: null,
            stageOverrides: { ...x.stageOverrides, ...Object.fromEntries([...subs.map((id) => [subKey(id), st]), ...sellers.map((id) => [id, st])]) },
          }));
          if (subs.length) persistSubmissionStage([...new Set(subs.map(subDealId))], st);
          if (!sellers.length) return toast(who + ' · ' + st);
          if (!canWrite || workspaceId === null) return toast(who + ' · ' + st + ' (demo)');
          toast(`Moving ${who} to ${st}…`);
          const r = await setStageMany(workspaceId, sellers, st, me, reason);
          // Only the sellers the database actually moved keep the new stage on
          // screen: a failed batch, or a row RLS hides or that was archived, goes back.
          const saved = new Set((r.movedIds ?? []).map((n) => 's' + n));
          set((x) => {
            const next = { ...x.stageOverrides };
            for (const id of sellers) if (!saved.has(id) && next[id] === st) delete next[id];
            return { stageOverrides: next };
          });
          reload?.();
          const moved = (r.moved ?? 0).toLocaleString('en-US');
          if (!r.ok) return toast(`${moved} of ${sellers.length.toLocaleString('en-US')} moved, then it stopped: ${r.message}`, 'error');
          if ((r.moved ?? 0) < sellers.length) return toast(`${moved} of ${sellers.length.toLocaleString('en-US')} moved to ${st}. The rest couldn’t be changed (archived or not yours to edit)`, 'error');
          toast(`${moved} moved to ${st}`, 'success');
        })(),
      }))
      : s.bulkMenu === 'plan' ? plansForRecord(plans, 'seller').map((pl) => ({
        label: pl.name,
        go: () => {
          const ids = [...selectedIds];
          set({ peopleSel: {}, bulkMenu: null });
          if (!canWrite) { ids.forEach((id) => enroll(pl.id, id)); return; }
          // Four enrolments at a time, one reload and one summary — not a toast per seller.
          toast('Enrolling ' + ids.length + ' in ' + pl.name + '…');
          void (async () => {
            let added = 0, already = 0, failed = 0, queued = 0;
            let firstError = '';
            const rs = await eachLimited(ids, 4, (id) => enrollInPlan(workspaceId, pl.id, id, me));
            for (const r of rs) {
              if (!r.ok) { failed++; firstError ||= r.message || ''; } else if (r.already) already++; else { added++; queued += r.queued ?? 0; }
            }
            reload?.();
            toast(`${added} enrolled in ${pl.name}` + (queued ? ` · ${queued} touches queued` : '') + (already ? ` · ${already} already on it` : '') + (failed ? ` · ${failed} failed: ${firstError}` : ''));
          })();
        },
      }))
      : [];
    const sellerMassActions = ['Assign', 'Change Stage', 'Add Tag', 'Remove Tag', 'Start Action Plan', 'Pause action plans', 'Stop action plans', 'Run COMPR', 'Text', 'Email', 'RVM', 'Add to Call Queue', 'Export', 'Archive']
      .map((label) => ({
        label,
        active: (label === 'Assign' && s.bulkMenu === 'assign') || (label === 'Change Stage' && s.bulkMenu === 'stage') || (label === 'Start Action Plan' && s.bulkMenu === 'plan'),
        go: () => {
          if (!selectedIds.length) return toast('Select someone first');
          if (label === 'Run COMPR') {
            // A partner's submissions (Mark Spain, Offerpad…) each underwrite their own
            // house: the run names that deal, under the partner contact it sits on.
            const subDeals = [...new Set(selectedIds.filter((id) => id.startsWith('sub:')).map(subKey))]
              .map((k) => dealBySub.get(k))
              .filter((d): d is Deal => !!d && !!d.personId && !!d.addr && d.addr !== '—' && !d.underwritingUrl && !d.arv);
            const leads = selectedIds.filter((id) => !id.startsWith('sub:') && !comprRan(id) && person(id)?.property.addr && person(id)?.property.addr !== '—');
            const todo: (number | { sellerId: number; dealId: number })[] = [
              ...leads.map(dbId),
              ...subDeals.map((d) => ({ sellerId: dbId(d.personId!), dealId: dbId(d.id) })),
            ];
            if (!canWrite || workspaceId === null) return toast('Sign in to run COMPR');
            if (!todo.length) return toast('Every selected lead already has a COMPR run (or no address)');
            const skipped = selectedIds.length - todo.length;
            const ws = workspaceId;
            void confirm({
              title: `Run COMPR on ${todo.length} propert${todo.length === 1 ? 'y' : 'ies'}?`,
              body: `${skipped > 0 ? `${skipped} already run or without an address are skipped. ` : ''}Each run is billed.`,
              confirmLabel: `Run ${todo.length}`,
            }).then((ok) => {
              if (!ok) return;
              set({ peopleSel: {} });
              toast(`COMPR queued for ${todo.length}`);
              void runComprMany(ws, todo, (n, total) => { if (n === total || n % 10 === 0) toast(`COMPR ${n}/${total}`); })
                .then((r) => { reload?.(); toast(`COMPR done · ${r.ok} run${r.failed ? ` · ${r.failed} failed: ${r.firstError}` : ''}`); });
            });
            return;
          }
          if (selectedIds.some((id) => id.startsWith('sub:'))) {
            if (label === 'Export') return exportSelected();
            if (label === 'Assign') return set({ bulkMenu: s.bulkMenu === 'assign' ? null : 'assign' });
            if (label === 'Change Stage') return set({ bulkMenu: s.bulkMenu === 'stage' ? null : 'stage' });
            return toast('Open a submission to work that property');
          }
          if (label === 'Assign') return set({ bulkMenu: s.bulkMenu === 'assign' ? null : 'assign' });
          if (label === 'Change Stage') return set({ bulkMenu: s.bulkMenu === 'stage' ? null : 'stage' });
          if (label === 'Add Tag') {
            const tag = window.prompt('Tag to add to ' + selectedIds.length + (selectedIds.length === 1 ? ' person' : ' people') + ':');
            if (!tag?.trim()) return;
            return canWrite ? void tagSellers(selectedIds, tag).then((res) => afterBulk(res, 'Tagged "' + tag.trim() + '"')) : toast('Tagged (demo)');
          }
          if (label === 'Remove Tag') {
            // Offer the tags the selection actually carries.
            const onSel = [...new Set(selectedIds.flatMap((id) => person(id)?.tags ?? []))];
            if (!onSel.length) return toast('None of the selected people have tags');
            const tag = window.prompt('Tag to remove from ' + selectedIds.length + (selectedIds.length === 1 ? ' person' : ' people') + '. On the selection: ' + onSel.join(', '), onSel.length === 1 ? onSel[0] : '');
            if (!tag?.trim()) return;
            return canWrite ? void untagSellers(selectedIds, tag).then((res) => afterBulk(res, 'Removed "' + tag.trim() + '"')) : toast('Removed (demo)');
          }
          if (label === 'Pause action plans' || label === 'Stop action plans') {
            const pause = label.startsWith('Pause');
            const lives = enrollments.filter((e) => e.personId && selectedIds.includes(e.personId) && (pause ? e.status === 'active' : e.status !== 'done') && /^en\d+$/.test(e.id));
            if (!lives.length) return toast(pause ? 'None of those people have a running action plan' : 'None of those people are on an action plan');
            const word = pause ? 'Pause' : 'Stop';
            void confirm({ title: `${word} the action plan on ${lives.length} ${lives.length === 1 ? 'person' : 'people'}?`, confirmLabel: `${word} plans`, tone: pause ? 'default' : 'danger' }).then((ok) => {
            if (!ok) return;
            if (!canWrite) return toast(`${word}ped (demo)`);
            void Promise.all(lives.map((e) => (pause ? pauseEnrollment(dbId(e.id), 'manual') : stopEnrollment(dbId(e.id))))).then((rs) => {
              const bad = rs.find((r) => !r.ok);
              if (bad && !rs.some((r) => r.ok)) return toast(bad.message || `Could not ${pause ? 'pause' : 'stop'} the plan.`, 'error');
              reload?.();
              const n = rs.filter((r) => r.ok).length;
              toast(`${pause ? 'Paused' : 'Stopped'} action plan on ${n}`, 'success');
            });
            });
            return;
          }
          if (label === 'Start Action Plan') {
            if (!plans.some((pl) => pl.active)) {
              // No plan to start: go to the builder, and remember the way back.
              go('plans', { planReturnTo: 'people' });
              return toast('No active plans yet — build one with + New plan or Draft with AI, then come back to enrol.');
            }
            return set({ bulkMenu: s.bulkMenu === 'plan' ? null : 'plan' });
          }
          if (label === 'Text' || label === 'Email' || label === 'RVM') {
            const first = person(selectedIds[0]);
            if (!first) return;
            // One person: open their record, where the thread is. Several: the
            // bulk composer (app/components/bulk/BulkCompose.tsx) — a CLOZR
            // template or a message written there, previewed with the first
            // recipient's own values, and everyone who would be skipped named
            // before anything sends. RVM always uses that composer, including
            // for one person, because the record has no ringless box.
            if (label !== 'RVM' && selectedIds.length === 1) {
              return go('person', { personId: first.id, personTab: 'Activity', composerTab: label === 'Text' ? 'Text' : 'Email' });
            }
            return set({ bulkSend: label === 'Text' ? 'sms' : label === 'Email' ? 'email' : 'rvm' });
          }
          if (label === 'Add to Call Queue') {
            set({ peopleSel: {} });
            return void addToCallQueue('seller', selectedIds);
          }
          if (label === 'Export') return exportSelected();
          if (label === 'Archive') {
            // The same in-app prompt as Shift+Delete: one Yes/No, their open
            // deals ticked to go along (they would otherwise stay on the Deals
            // board and Dispo with no seller to open). A submission row is a
            // deal and is archived from its record.
            const ids = selectedIds.filter((id) => !id.startsWith('sub:'));
            if (!ids.length) return toast('A submission is archived from its record, not from here');
            return askArchive('seller', ids);
          }
          toast(label + ' · ' + selectionCount + ' people');
        },
      }));
    // A vendor list (Wholesalers, Lenders, Title Companies, Partners, Vendors)
    // has no stage, plan, tag or COMPR run, so its bar is the reach-outs plus
    // export and archive. Text and Email log on the vendor (communications.vendor_id).
    const real = (v: string) => (v === '—' ? '' : v);
    const vendorMassActions = ['Text', 'Email', 'Call List', 'Export', 'Archive'].map((label) => ({
      label, active: false,
      go: () => {
        if (!selectedVendors.length) return toast('Select a vendor first');
        if (label === 'Text' || label === 'Email') return set({ bulkSend: label === 'Text' ? 'sms' : 'email' });
        if (label === 'Call List') {
          if (!selectedVendors.some((v) => real(v.phone))) return toast('None of the selected vendors has a phone number');
          // A session over the selection, so Next walks the rest of it instead
          // of the list stopping after the first call.
          return startRun('Vendor call list', selectedVendors.map((v) => ({ target: { name: v.contact === '—' ? v.name : v.contact, phone: real(v.phone) } })));
        }
        if (label === 'Export') {
          const esc = (v: string) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
          const cols: [string, (v: (typeof selectedVendors)[number]) => string][] = [
            ['Company', (v) => v.name], ['Type', (v) => v.kind], ['Contact', (v) => real(v.contact)], ['Phone', (v) => real(v.phone)],
            ['Email', (v) => real(v.email)], ['Market', (v) => v.market], ['Notes', (v) => v.note],
          ];
          const csv = [cols.map(([k]) => esc(k)).join(','), ...selectedVendors.map((v) => cols.map(([, f]) => esc(f(v))).join(','))].join('\n');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
          a.download = `clozr-${s.peopleList.toLowerCase().replace(/\s+/g, '-')}-${selectedVendors.length}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          return toast(selectedVendors.length + ' exported');
        }
        if (label === 'Archive') {
          if (readOnly) return toast('Read-only: nothing archived');
          return set({ archiveAsk: { kind: 'vendor', ids: selectedVendors.map((v) => v.id), names: selectedVendors.map((v) => v.name), deals: [], fromRecord: false } });
        }
      },
    }));
    const massActions = isVendorList ? vendorMassActions : sellerMassActions;

    // What the People list's bulk composer sends to: the selection, their own
    // merge values, and who is writing. Rendered by screens/People.tsx.
    const peopleBulk = {
      kind: (isVendorList ? 'vendor' : 'seller') as 'seller' | 'vendor',
      channel: s.bulkSend,
      close: () => set({ bulkSend: null }),
      workspaceId, canWrite, textCtx, toast, reload,
      // A vendor's first name is the contact's; the company rides along as {{company}}.
      people: isVendorList ? selectedVendors.map((v) => ({
        id: v.id, dbId: dbId(v.id), name: v.contact === '—' ? v.name : v.contact, phone: real(v.phone), email: real(v.email),
        fields: { company: v.name, market: v.market },
      })) : selectedIds.flatMap((id) => {
        const p = person(id);
        if (!p) return [];
        // "—" is how an empty cell reads in this view model; a send needs the blank.
        const real = (v: string) => (v === '—' ? '' : v);
        return [{
          id, dbId: dbId(id), name: p.name, phone: real(p.phone), email: real(p.email),
          dnc: hasDnc(p.tags), blacklisted: isBlacklisted(p),
          fields: { address: real(p.property.addr), city: real(p.property.city), state: real(p.property.st), zip: real(p.property.zip), asking_price: real(p.asking), offer: real(p.offer ?? '') },
        }];
      }),
    };

    // ---- PERSON ----
    const personFields = whatWeKnowFields(P, recDealOf(P.id));
    /**
     * "Contract": what the contracts table says about this house's purchase
     * agreement, not a guess from the stage. Live rows are the seller's deals'
     * contracts (RLS shows them to the roles that work them); the demo keeps
     * reading the stage.
     */
    const contractStatus = (() => {
      if (!live) return underContract(P.stage) ? 'Executed' : 'Not started';
      const dealIds = new Set(deals.filter((d) => d.personId === P.id).map((d) => dbId(d.id)));
      const raw = (D.reporting as { raw?: { contracts?: { deal_id: number | null; kind: string; status: string; sent_at: string | null; viewed_at: string | null; completed_at: string | null }[] } } | undefined)?.raw;
      const own = (raw?.contracts ?? []).filter((c) => c.deal_id != null && dealIds.has(c.deal_id));
      const purchase = own.filter((c) => !/assign/i.test(c.kind ?? ''));
      const rows = purchase.length ? purchase : own;
      if (rows.some((c) => c.completed_at || /complete|signed|executed/i.test(c.status ?? ''))) return 'Executed';
      if (rows.some((c) => c.viewed_at)) return 'Viewed by seller';
      if (rows.some((c) => c.sent_at)) return 'Sent to seller';
      return rows.length ? 'Drafted' : 'Not started';
    })();
    /**
     * After a seller field lands: the one place a record save refreshes the
     * screen, by re-reading this seller and their deals (refreshSeller, #303),
     * never a full workspace reload.
     */
    const sellerSaved = () => { refreshPerson(P0.id); };
    /**
     * Click-to-edit on the record (components/ds/InlineField): one field, saved
     * on blur or Enter. Resolves `{ ok: false, message }` when the save is
     * refused, so the field puts the old value back and shows why.
     */
    const saveSellerField = async (field: string, value: FieldValue): Promise<WriteResult> => {
      if (live && !canWrite) return { ok: false, message: readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE };
      if (!canWrite || workspaceId === null) { toast('Saved (demo)'); return { ok: true }; }
      const deal = recDealOf(P.id);
      const propertyId = P.property.propertyId ? Number(P.property.propertyId) : null;
      const r = await saveWhatWeKnow(workspaceId, dbId(P.id), propertyId, deal ? dbId(deal.id) : null, field, value);
      if (!r.ok) return r;
      // A plain seller column shows at once (patchLocal); the refresh then
      // re-reads the seller for everything else the save touched.
      const col = SELLER_VIEW_FIELD[field];
      if (col && patchLocal) {
        const text = value == null ? '' : String(value).trim();
        patchLocal('people', { id: P0.id, [col]: field === 'asking_price' ? (typeof value === 'number' ? fmt(value) : '—') : field === 'notes' ? text || null : text || '—' });
      }
      sellerSaved();
      return r;
    };
    const propFacts = ([
      ['Beds', P.property.beds], ['Baths', P.property.baths], ['Sqft', P.property.sqft.toLocaleString()],
      ['Year', P.property.year], ['Lot', P.property.lot], ['Type', P.property.type],
    ] as [string, string | number][]).map(([k, v]) => ({ k, v: v && v !== '0' ? v : '—' }));
    // 'TC' only appears once the deal has a transaction file open.
    const personTabNames = ['Activity', 'Communications', 'Notes', 'Emails', 'Texts', 'Calls',
      ...(D.transactions.some((t) => t.personId === P.id) ? ['TC'] : []), 'Files & Links', 'AI'];
    const personTabs = personTabNames.map((t) => ({
      label: t, active: s.personTab === t, go: () => set({ personTab: t }),
      color: s.personTab === t ? '#18181b' : '#71717a',
      border: s.personTab === t ? '#18181b' : 'transparent',
    }));
    const isCommsTab = s.personTab === 'Communications';
    const isTcTab = s.personTab === 'TC';
    // The deal's own deal_files: the same list the deal sheet and dispo show, so it syncs by being one table.
    const isFilesTab = s.personTab === 'Files & Links';
    const isFeedTab = !isCommsTab && !isTcTab && !isFilesTab;
    // A call note already shows under its call, so only the Notes tab lists it on its own.
    const typeFilters: Record<string, (t: { type: string; underCall?: boolean }) => boolean> = {
      Activity: (t) => !t.underCall,
      Notes: (t) => t.type === 'note' || t.type === 'tc',
      Emails: (t) => t.type === 'email',
      Texts: (t) => /sms/.test(t.type),
      Calls: (t) => t.type === 'call',
      AI: (t) => t.type === 'call' || t.type === 'compr',
    };
    const typeFilter = typeFilters[s.personTab] || typeFilters.Activity;
    const talkrIcon = (type: string): IconName | null =>
      /sms/.test(type) ? 'msg' : type === 'call' ? 'phone' : type === 'voicemail' ? 'voicemail' : type === 'email' ? 'mail' : null;
    const tlIcon: Record<string, [string, string]> = {
      call: ['#e6142e', 'Call'], sms_in: ['#e6142e', 'SMS in'], sms_out: ['#e6142e', 'SMS out'],
      offer: ['#d97706', 'Offer'], compr: [COMPR, 'COMPR'], stage: ['#71717a', 'Stage'],
      note: ['#71717a', 'Note'], email: ['#52525b', 'Email'], task: ['#71717a', 'Automation'], lead: ['#71717a', 'Lead'],
      tc: ['#1f7a4d', 'TC'],
    };
    // Anything written this session — a composer send, a Quick Add note — goes
    // on the front of the feed. Without this the Activity tab was a fixed
    // script: you could add a note and the record would look exactly as it did
    // before, which reads as the note having been dropped.
    const sessionTimeline = s.newComms
      .filter((c) => c.personId === P.id)
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        type: c.channel === 'sms' ? (c.dir === 'in' ? 'sms_in' : 'sms_out') : c.channel,
        user: c.user,
        who: c.party,
        time: c.time,
        title: c.channel === 'note' ? 'Note added' : c.channel === 'email' ? 'Email sent' : 'Text sent',
        body: c.preview,
        ai: undefined as TimelineEntry['ai'],
      }));
    // Stage history is the record of every move (who, from, to, when); once it
    // has loaded it stands in for the activity log's "Stage → X" rows, which
    // carried only the new stage.
    const stageTimeline = (key: string, entity: string) => (live && recordStages?.key === key
      ? recordStages.rows.map((e) => stageEventEntry(e, entity, repName, (iso) => relative(iso)))
      : null);
    const withStages = (rows: TimelineEntry[], stages: TimelineEntry[] | null) => (stages
      ? [...rows.filter((t) => t.type !== 'stage'), ...stages].sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0))
      : rows);
    // A submission's feed is that house only: its deal's activity, its own
    // stage moves, and messages tied to it. The partner's other houses (and the
    // contact's own stage rows) stay on the contact's full record.
    // The workspace feed plus the open record's own (loaded apart, older rows included), once each, newest first.
    const recTL = live && recordTimeline?.pid === P.id ? recordTimeline.rows : [];
    const TL = recTL.length
      ? (() => {
        const seen = new Set(D.timeline.map((t) => t.id));
        return [...D.timeline, ...recTL.filter((t) => !seen.has(t.id))].sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
      })()
      : D.timeline;
    const submissionTimeline = (d: Deal) => {
      const dealNo = dbId(d.id);
      const stages = live && recordStages?.key === 's:' + P.id
        ? recordStages.rows.filter((e) => e.entityType === 'deal' && e.entityId === dealNo).map((e) => stageEventEntry(e, P.id, repName, (iso) => relative(iso)))
        : null;
      const rows = TL.filter((t) => t.entity === d.id || (t.entity === P.id && t.dealId === d.id));
      return withStages(rows, stages);
    };
    const timelineItems = [
      ...sessionTimeline,
      // Live rows carry the record they belong to; the mock graph's timeline
      // is one scripted list shared by every person.
      ...(live ? (focusDeal ? submissionTimeline(focusDeal) : withStages(TL.filter((t) => t.entity === P.id), stageTimeline('s:' + P.id, P.id))) : P.id === 'p1' ? D.timeline : D.timeline.slice(4)),
    ].filter(typeFilter).map((t) => ({
      // A received email is from its sender: their name when the record knows it, else the address.
      id: t.id, who: t.user && D.team[t.user] ? D.team[t.user].name : 'email' in t && t.email?.inbound ? (t.email.fromName || t.email.from || t.who) : t.who,
      actor: t.user && D.team[t.user] ? D.team[t.user].name : 'System', time: t.time, title: t.title, body: t.body || '', hasBody: !!t.body,
      isCall: t.type === 'call', isSms: /sms/.test(t.type), ai: t.ai || null,
      callNote: 'callNote' in t && t.callNote ? t.callNote : null,
      email: 'email' in t && t.email ? t.email : null,
      ...(() => {
        const base = 'pinnedAt' in t && t.pinnedAt ? { at: t.pinnedAt, by: t.pinnedBy ?? null } : null;
        const pin = t.id in s.pins ? s.pins[t.id] : base;
        return {
          pinned: !!pin, pinnedBy: pin ? repName(pin.by) : '',
          togglePin: () => {
            set((st) => ({ pins: { ...st.pins, [t.id]: pin ? null : { at: new Date().toISOString(), by: ME } } }));
            // s.pins already shows it; a full re-read only to confirm it was 29 reads.
            if (canWrite) void pinTimelineEntry(t.id, !pin, me).then((r) => { if (!r.ok) toast(r.message || 'Could not pin that.', 'error'); });
          },
        };
      })(),
      // A stored communication ('ct123'): CallInsight loads its recording and transcript.
      commId: live && /^ct\d+$/.test(t.id) ? Number(t.id.slice(2)) : null,
      chan: (tlIcon[t.type] || tlIcon.note)[1], color: (tlIcon[t.type] || tlIcon.note)[0],
      initials: t.user ? (D.team[t.user] ? D.team[t.user].initials : 'AI') : initialsOf('email' in t && t.email?.fromName ? t.email.fromName : t.who),
      avatar: t.user && D.team[t.user]?.avatar ? D.team[t.user].avatar! : '',
      // A row Talkr carried has no rep to show, and a "T" says nothing about
      // what happened: the avatar cell shows the channel instead.
      icon: !t.user && /^talkr$/i.test(t.who) ? talkrIcon(t.type) : null,
      // …and the Talkr mark, so the row says who carried it, not just "Talkr" in grey.
      talkr: !t.user && /^talkr$/i.test(t.who),
      // A row CLOZR itself wrote (an automation, a system event) carries the CLOZR mark.
      clozr: (!t.user || t.user === 'system') && /^(clozr|system|automation|lead intake)$/i.test(t.who),
      objections: t.ai ? t.ai.objections.map((o) => ({ o })) : [],
    }));
    const reachPid = s.quickReach?.personId ?? P.id;
    const reachFeed = [
      ...s.newComms.filter((c) => c.personId === reachPid).slice().reverse().map((c) => ({
        id: c.id,
        type: c.channel === 'sms' ? (c.dir === 'in' ? 'sms_in' : 'sms_out') : c.channel,
        time: c.time,
        title: c.channel === 'note' ? 'Note added' : c.channel === 'email' ? 'Email sent' : 'Text sent',
        body: c.preview as string | undefined,
      })),
      ...(live ? D.timeline.filter((t) => t.entity === reachPid) : reachPid === 'p1' ? D.timeline : D.timeline.slice(4)),
    ].filter((t) => /sms|email/.test(t.type)).slice(0, 8).map((t) => ({
      id: t.id,
      channel: /sms/.test(t.type) ? 'text' as const : 'email' as const,
      out: t.type !== 'sms_in' && !('email' in t && (t as { email?: { inbound?: boolean } }).email?.inbound),
      time: t.time,
      body: reachBody(t).slice(0, 280),
      title: t.title,
    }));
    // One composer, three channels. Call is the header's, not a composer tab.
    const composerTabs = ['Text', 'Email', 'Note'].map((t) => ({
      label: t, pressed: s.composerTab === t,
      go: () => set({ composerTab: t }),
      color: s.composerTab === t ? '#18181b' : '#71717a',
      bg: s.composerTab === t ? '#fff' : 'transparent',
      shadow: s.composerTab === t ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
    }));
    // The Activity chips: one stream, filtered by channel. The chip state is
    // still `personTab`, so a hand-off that names a tab keeps working.
    const recordChips = ([['All', 'Activity'], ['Calls', 'Calls'], ['Texts', 'Texts'], ['Email', 'Emails'], ['Notes', 'Notes']] as const).map(([label, tab]) => ({
      label, tab, pressed: s.personTab === tab || (tab === 'Activity' && !(s.personTab in typeFilters)),
      go: () => set({ personTab: tab }),
    }));
    // Open tasks, plus any ticked this session so a completed one stays in
    // view, struck through, rather than disappearing on the tick.
    const taskIsDone = (t: Task) => s.tasksDone[t.id] ?? t.done;
    const recordTasks = tasks.filter((t) => t.personId === P.id && (!t.done || s.tasksDone[t.id] !== undefined));
    const nextOpenTask = recordTasks.find((t) => !taskIsDone(t)) ?? null;
    // The Tasks list sits right under Next action, so the task Next action is
    // already showing is left out of it rather than listed twice.
    const personTasks = recordTasks.filter((t) => t !== nextOpenTask).map((t) => ({
      title: t.title, due: t.due, done: taskIsDone(t),
      note: t.note ?? '', hasNote: !!t.note,
      toggle: () => {
        const next = !taskIsDone(t);
        set((st) => ({ tasksDone: { ...st.tasksDone, [t.id]: next } }));
        persistTask(t.id, next);
      },
    }));
    // One-tap adds under Next action: a task of the kind picked, already on this record.
    const personQuickAdds = (['Task', 'Call', 'Text', 'Email', 'Appointment'] as const).map((k) => ({
      label: k === 'Appointment' ? 'Appt' : k,
      go: () => (k === 'Appointment'
        ? openAdd('appointment', { personId: P.id })
        : openAdd('task', { personId: P.id, ...(k === 'Task' ? {} : { type: k === 'Text' ? 'Follow-up' : k, title: (k === 'Call' ? 'Call ' : k === 'Text' ? 'Text ' : 'Email ') + P.name }) })),
    }));
    // On a submission the stage is that house's (deals.lead_stage), not the partner's.
    // Under Contract - Seller opens the deal in the database (migrations 27 and
    // 181); once saved, the rep lands on its deal sheet, asked to fill in the
    // deal type and the Acquisition section. Blanks never hold the deal back.
    // Only while the rep is still on this record: a save that lands after they
    // moved on says so instead of pulling them back.
    const applyStage = (st: string) => {
      const pinned = focusDeal?.id ?? null;
      const toSheet = live && st === 'Under Contract - Seller'
        ? (dealId: string | null) => () => {
          const open = (id: string | null) => {
            const now = sRef.current;
            if (now.screen !== 'person' || now.personId !== P.id || (now.personDealId ?? null) !== pinned) {
              return toast('Deal created · ' + (P.property.addr || P.name) + ' · its deal sheet is on the record', 'success');
            }
            go('dealSheet', { personId: P.id, dealSheetDealId: id, dealSheetPrompt: true });
            toast('Deal created · fill in the deal sheet', 'success');
          };
          // A seller's own stage names no deal: read the one the database just opened.
          if (dealId || workspaceId == null) return open(dealId);
          void import('@/lib/deal-sheet').then(({ loadDealForSeller }) => loadDealForSeller(workspaceId, dbId(P.id), me))
            .then((r) => open(r.deal ? 'd' + r.deal.id : null), () => open(null));
        }
        : null;
      if (stageDeal) {
        set((x) => ({ stageOverrides: { ...x.stageOverrides, ['sub:' + stageDeal.id]: st } }));
        persistSubmissionStage([stageDeal.id], st, toSheet?.(stageDeal.id));
        toast((stageDeal.addr || 'Submission') + ' → ' + st);
        return;
      }
      set((x) => ({ stageOverrides: { ...x.stageOverrides, [P.id]: st } }));
      persistStage(P.id, st, toSheet?.(null));
      toast('Stage → ' + st);
    };
    /**
     * Every stage move on the record goes through here. A user who can only
     * read gets told so and nothing moves on screen (it used to move, toast,
     * and quietly not save). A dead or refund stage asks why first, and the
     * reason goes on the timeline.
     */
    const moveStage = async (st: string) => {
      if (st === P.stage) return;
      if (live && !canWrite) { toast(readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE); return; }
      if (live && isDeadStage(st)) {
        const why = await confirmReason({
          title: `Move ${P.name.split(' ')[0] || 'this lead'} to ${st}?`,
          body: 'Dead leads drop off the call lists. Say why, so whoever picks this up later knows.',
          reasonLabel: 'Why this lead is dead', confirmLabel: 'Move to ' + st, tone: 'danger',
        });
        if (why === null) return;
        if (workspaceId !== null) void logActivity(workspaceId, 'seller', dbId(P.id), 'stage', 'Moved to ' + st, 'Reason: ' + why, me).catch(() => {});
      }
      applyStage(st);
    };
    const stageOptions = sellerStages.map((st) => ({
      label: st,
      go: () => { void moveStage(st); },
      color: stageColor(st),
    }));
    const ownTimeline = live ? TL.filter((t) => t.entity === P.id) : P.id === 'p1' ? D.timeline : [];
    const stagePick = recommendStage({
      stage: P.stage,
      dealStage: recDealOf(P.id)?.stage ?? null,
      offerAmount: P.offer,
      activity: ownTimeline.map((t) => ({ type: t.type, title: t.title, body: t.body || t.ai?.summary || t.email?.body || '' })),
    });
    const DEMO_FOR_DEAL: Record<string, string> = {
      'Under Contract Seller': 'Under Contract', 'Ready To Market': 'Dispo', 'Buyer Under Contract': 'Assigned', 'In Escrow': 'Closing', Closed: 'Closed',
    };
    const aiStage = {
      stage: stagePick.stage,
      reason: stagePick.reason,
      chips: stagePick.chips,
      go: (label: string) => {
        if (isDealStage(label)) {
          const deal = recDealOf(P.id);
          const seller = live ? sellerStageForDeal(label) : DEMO_FOR_DEAL[label];
          if (live && !canWrite) return toast(readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE);
          // A live deal moves the way the board moves it: Ready To Market's
          // checklist and the Closed / Terminated confirms come first, and only
          // this deal moves. The seller follows in the database
          // (deals_stage_after); writing the seller here too would let
          // sellers_stage_after move their newest deal, which may be another house.
          if (live && deal) { void moveDealStage(deal, label); return; }
          if (deal && label !== deal.stage) persistDealStage(deal.id, label);
          if (seller) applyStage(seller);
          else toast(label);
          return;
        }
        void moveStage(label);
      },
    };
    // "Start dispo" hands the seller's deal to dispo. It used to write 'Dispo'
    // to the seller's stage on any record, which the database reads as Under
    // Contract - Seller: it opened a deal at the asking price on a lead, or
    // dragged a deal already with a buyer back to the start. It now moves the
    // DEAL, the way the Deals board does, and only off Under Contract Seller;
    // a deal already marketing or further along just opens. It shows once the
    // seller is under contract with a real deal to market (Contract Sent to
    // Seller has none yet), and only to a role that can open the dispo
    // property, since go() sends anyone else Home. The demo has no role and
    // keys deals on its sample stages, so there it only opens the property.
    const dispoDeal = live ? recDealOf(P.id) : undefined;
    const canStartDispo = canSee(role, 'dispoProperty') && (live
      ? sellerStageGroup(P.stage) === 'contract' && !!dispoDeal && (PIPELINE_STAGES as string[]).includes(dispoDeal.stage ?? '')
      : DEMO_CONTRACT_STAGES.includes(P.stage) && P.stage !== 'Closed');
    const startDispo = () => {
      if (!canStartDispo) return;
      // The same gated move as the board: the Ready To Market checklist, an override with a reason.
      // Dispo opens once the move went ahead (or was not needed), never behind a cancelled prompt.
      // A seat that can't move the deal still opens the property, as before.
      if (dispoDeal?.stage === 'Under Contract Seller' && canWrite) {
        void moveDealStage(dispoDeal, 'Ready To Market').then((moved) => { if (moved) openDispo(P.id, undefined, dispoDeal.id); });
        return;
      }
      openDispo(P.id, undefined, dispoDeal?.id);
    };

    // ---- COMPR ----
    const comprTabNames = ['Overview', 'Comps', 'Map', 'Property', 'Rehab', 'Photos', 'Market', 'Buy Boxes', 'Exits', 'Risk', 'Report'];
    const comprTabs = comprTabNames.map((t) => ({
      label: t, go: () => set({ comprTab: t }),
      color: s.comprTab === t ? '#18181b' : '#71717a',
      border: s.comprTab === t ? COMPR : 'transparent',
    }));
    const inc = (c: { id: string; inc: boolean }) => (s.compsInc[c.id] == null ? c.inc : s.compsInc[c.id]);
    const comps = D.comps.map((c) => ({
      ...c, included: inc(c), priceF: fmt(c.price), ppsfF: '$' + c.ppsf,
      sqftF: c.sqft.toLocaleString(), distF: c.dist + ' mi',
      condColor: c.cond === 'C2' ? '#5aa63c' : c.cond === 'C3' ? '#c79111' : '#db6b33',
      rowBg: inc(c) ? '#fff' : '#fafafa', textColor: inc(c) ? '#18181b' : '#a1a1aa',
      btnLabel: inc(c) ? 'Exclude' : 'Include', btnBg: inc(c) ? '#fff' : '#0A8560', btnColor: inc(c) ? '#18181b' : '#fff',
      pinBg: inc(c) ? '#18181b' : '#fff', pinBorder: inc(c) ? '#18181b' : '#a1a1aa',
      left: c.x + '%', top: c.y + '%',
      toggle: () => set((st) => ({ compsInc: { ...st.compsInc, [c.id]: !inc(c) } })),
    }));
    const usedComps = comps.filter((c) => c.included);
    /**
     * ARV, or null when nothing has underwritten this property.
     *
     * This used to fall back to a flat $318,000. On a real address with no
     * comps that produced a confident-looking valuation, and a MAO derived from
     * it — a number someone could send as an offer. An unknown ARV now reads as
     * unknown, all the way down through MAO and flip profit.
     */
    const arv: number | null = usedComps.length
      ? Math.round((usedComps.reduce((a, c) => a + c.ppsf, 0) / usedComps.length) * P.property.sqft / 100) * 100
      : recDealOf(P.id)?.arv ?? null;
    const underwritten = arv !== null;
    const rehabTotal = D.rehab.reduce((a, r) => a + r[s.rehabPreset], 0);
    // The Acme Homes rule: 70% of ARV, less rehab, less the assignment fee.
    const mao: number | null = arv === null ? null : Math.round(arv * 0.7 - rehabTotal - 22000);
    const generateOffer = (amount?: number | null) => {
      if (!canWrite) return toast('Offers generate on a signed-in workspace.');
      toast('Generating offer for ' + P.property.addr + '…');
      void generateOfferWrite(workspaceId, dbId(P.id), { amount: amount ?? null, textCtx }).then((r) => {
        if (!r.ok) return toast(r.message, 'error');
        refreshPerson(P.id);
        const by = r.provider === 'pandadoc' ? ' via PandaDoc' : '';
        // The server decides whether it went (Settings → Offers); a draft only
        // pinged the TC, so say that rather than promising the seller a link.
        if (r.offer.status === 'Draft') {
          return toast('Offer ' + offerMoney(r.amount) + ' created as a draft' + by + ' · the TC has been told it’s ready to send' + (r.note ? ' · ' + r.note : ''));
        }
        toast('Offer ' + offerMoney(r.amount) + ' generated' + by
          + (r.emailed ? ' · emailed to the seller' : r.provider === 'pandadoc' ? ' · copy the fields on Contracts into PandaDoc and send' : r.signers.length ? ' · signing link ready on the Contracts card' : '')
          + (r.texted ? (r.texted.error ? ' · text not sent: ' + r.texted.error : ' · texted to ' + r.texted.to) : '')
          + (r.note ? ' · ' + r.note : ''), 'success');
      });
    };
    const intel = D.propertyIntel.map(([k, v, tone]) => ({
      k, v, color: tone === 'good' ? '#16a34a' : tone === 'caution' ? '#d97706' : '#a1a1aa',
    }));
    const buyBoxMatches = [buyers[3], buyers[4], buyers[5], buyers[0]].filter(Boolean).map((b) => ({
      name: b.company, match: b.match, why: b.why.map((w) => ({ w })), issue: b.issue,
      open: () => openBuyer(b.id), color: b.match >= 90 ? '#16a34a' : '#d97706',
    }));
    const photos = ([
      [P.property.img, 'Exterior · front'], [D.IMG.kitchen, 'Kitchen'], [D.IMG.living, 'Living'],
      [D.IMG.bath, 'Bathroom'], [D.IMG.bed, 'Bedroom'], [D.IMG.k, 'Exterior · rear'],
    ] as [string | undefined, string][]).filter((x): x is [string, string] => !!x[0]).map(([src, cap]) => ({ src, srcSafe: src, cap }));
    const visionRows = ([
      ['Kitchen', 'dated', 4], ['Roof', 'likely replacement', 5], ['Flooring', 'medium', 3],
      ['Interior paint', 'full repaint', 4], ['Bathroom', 'moderate renovation', 3], ['HVAC', 'serviceable · 2014', 2],
    ] as [string, string, number][]).map(([k, v, score]) => ({ k, v, score }));
    const riskRows = ([
      ['Comp spread', 'Tight · ±3.4%', '#16a34a'], ['Data confidence', '92 / 100', '#16a34a'],
      ['Title', 'Tax lien indicator $2,310', '#d97706'], ['Rehab uncertainty', 'Roof age unverified · permit 2011', '#d97706'],
      ['Market', 'Sellers market · DOM 19', '#16a34a'], ['Exit liquidity', '4 institutional buy boxes match', '#16a34a'],
    ] as [string, string, string][]).map(([k, v, c]) => ({ k, v, color: c }));

    // ---- TALKR ----
    const chanCount = (ch: string) => D.communications.filter((c) => c.channel === ch).length;
    const liveFolders: [string, number][] = [
      ['Inbox', D.inbox.length], ['Missed Calls', 0], ['Voicemails', chanCount('voicemail')],
      ['SMS', chanCount('sms')], ['Assigned to Me', 0], ['Unread', 0],
      ['Call Queues', 0], ['Campaigns', 0], ['Numbers', 0],
      ['Recordings', D.communications.filter((c) => !!c.dur).length],
    ];
    const myTalkrId = phone.data.me?.id ?? null;
    const tHistory = phone.data.history;
    const isVoicemail = (h: (typeof tHistory)[number]) => h.direction === 'inbound' && h.has_recording && !h.user_name;
    const talkrLiveFolders: [string, number][] = [
      ['Inbox', phone.data.convs.length],
      ['Missed Calls', tHistory.filter((h) => h.direction === 'inbound' && (h.status === 'no_answer' || h.status === 'busy')).length],
      ['Voicemails', tHistory.filter(isVoicemail).length],
      ['SMS', phone.data.convs.length],
      ['Assigned to Me', phone.data.convs.filter((c) => c.assigned_user_id && c.assigned_user_id === myTalkrId).length],
      ['Unread', phone.data.unread],
      ['Call Queues', 0], ['Campaigns', 0],
      ['Numbers', phone.data.me?.org_numbers.length ?? 0],
      ['Recordings', tHistory.filter((h) => h.has_recording).length],
    ];
    const talkrFolders = ((talkrLive ? talkrLiveFolders : live ? liveFolders : [
      ['Inbox', 12], ['Missed Calls', 3], ['Voicemails', 2], ['SMS', 9], ['Assigned to Me', 6],
      ['Unread', 5], ['Call Queues', 2], ['Campaigns', 4], ['Numbers', 6], ['Recordings', 148],
    ]) as [string, number][]).map(([label, count]) => ({
      label, count, go: () => set({ talkrFolder: label }),
      bg: s.talkrFolder === label ? TALKR_TINT : 'transparent',
      color: s.talkrFolder === label ? TALKR_INK : '#27272a',
    }));
    const convOf = (m: (typeof D.inbox)[number]) => {
      const isBuyer = !m.personId;
      const who = ((m.personId ? person(m.personId) : m.buyerId ? buyer(m.buyerId) : null)
        ?? (isBuyer ? BLANK_BUYER : BLANK_PERSON)) as Person & Partial<(typeof D.buyers)[number]>;
      const whoStage = isBuyer ? (who.status as string) : (s.stageOverrides[who.id] || who.stage);
      return {
        id: m.id, name: who.name, initials: initialsOf(who.name), preview: m.preview, time: m.time,
        unread: m.unread, hasUnread: m.unread > 0, channel: m.channel, assigned: repName(m.assigned),
        property: isBuyer ? (who.company as string) : who.property.addr,
        stage: whoStage,
        stageColor: isBuyer ? '#ff7a45' : stageColor(whoStage),
        isBuyer, who, m,
      };
    };
    // Talkr's conversations, in the shape the screen already renders. The
    // party is the CRM seller whose phone matches, so the record link works;
    // a number the CRM has never seen still shows, by its number.
    const liveTalkrConvs = talkrLive
      ? phone.data.convs
          .filter((c) =>
            s.talkrFolder === 'Unread' ? c.unread_count > 0
              : s.talkrFolder === 'Assigned to Me' ? (c.assigned_user_id && c.assigned_user_id === myTalkrId)
                : true)
          .map((c) => {
            const match = people.find((p) => toE164(p.phone) === c.their_number) ?? null;
            const buyerHit = match ? null : (D.buyers.find((b) => toE164(b.phone) === c.their_number) ?? null);
            const name = c.contact_name ?? match?.name ?? buyerHit?.name ?? formatPhone(c.their_number);
            const who = (match ?? buyerHit ?? { ...BLANK_PERSON, id: '', name, phone: formatPhone(c.their_number) }) as Person & Partial<(typeof D.buyers)[number]>;
            const stage = match ? (s.stageOverrides[match.id] || match.stage) : buyerHit ? (buyerHit.status || 'Buyer') : (c.temperature ?? 'Lead');
            return {
              id: c.id, name, initials: initialsOf(name),
              preview: c.last_message ? (c.last_message.direction === 'outbound' ? 'You: ' : '') + (c.last_message.body || (c.last_message.media_count ? '📎 attachment' : '')) : '',
              time: relativeTime(c.last_message_at), unread: c.unread_count, hasUnread: c.unread_count > 0,
              channel: 'sms', assigned: c.assigned_user_name ?? '—',
              property: match?.property.addr ?? buyerHit?.company ?? formatPhone(c.their_number),
              stage, stageColor: match ? stageColor(stage) : buyerHit ? '#ff7a45' : TALKR_INK,
              isBuyer: !!buyerHit, who,
              m: { id: c.id, personId: match?.id ?? null, buyerId: buyerHit?.id ?? null, channel: 'sms', preview: c.last_message?.body ?? '', time: relativeTime(c.last_message_at), unread: c.unread_count, assigned: c.assigned_user_id } as InboxItem,
            };
          })
      : null;
    const talkrConvs = (liveTalkrConvs ?? D.inbox.map(convOf)).map((c) => ({
      ...c, active: s.talkrConv === c.id,
      bg: s.talkrConv === c.id ? '#f4f4f5' : '#fff',
      // Opening a thread reads it; landing on the newest one does not.
      go: () => { set({ talkrConv: c.id }); if (talkrLive && c.unread) phone.markRead(c.id); },
    }));
    const TC = talkrConvs.find((c) => c.id === s.talkrConv) || talkrConvs[0] || convOf(BLANK_INBOX);
    const talkrThread = (phone.data.msgs[TC.id] ?? []).map((m) => ({
      dir: m.direction === 'inbound' ? 'in' as const : 'out' as const,
      body: m.body || (m.media_urls.length ? `📎 ${m.media_urls.length} attachment${m.media_urls.length > 1 ? 's' : ''}` : ''),
      at: m.created_at,
      note: m.direction === 'outbound' && (m.status === 'failed' || m.status === 'undelivered') ? ' · not delivered' : '',
    }));
    const otherTexts = phoneTexts && phoneTexts.num === phone.data.convs.find((c) => c.id === TC.id)?.their_number ? phoneTexts.rows : [];
    // Older than today: the date too, since history from smrtPhone goes back months.
    const msgTime = (at: string) => {
      const d = new Date(at);
      return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ')
        + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    };
    const liveMsgs: [string, string, string][] = mergeThread(talkrThread, otherTexts)
      .map((m) => [m.dir, m.body, msgTime(m.at) + ('note' in m ? m.note : '')]);
    const msgs: [string, string, string][] = talkrLive ? liveMsgs : TC.id === 'i1'
      ? [
        ['in', 'Hi Taylor, I looked over the numbers again. Can you call me this morning? I want to talk through the timeline.', '9:31 AM'],
        ['out', 'Absolutely, Kara — I can call at 9:40. Does that work?', '9:33 AM'],
        ['in', 'Yes 👍', '9:34 AM'],
        ['sys', 'Outbound call · 4m 12s · recorded · AI summary attached', '9:42 AM'],
        ['out', 'Great talking. Revised offer coming before 2 PM as promised.', '9:48 AM'],
      ]
      : TC.id === 'i4'
        ? [
          ['in', 'Can we get in Willow tomorrow at 2:30? Bringing my GC.', 'Yesterday'],
          ['out', 'Confirmed 2:30 PM. Lockbox code coming in a separate text.', 'Yesterday'],
          ['sys', 'Walkthrough created · Fri Sept 5 · 2:30 PM', 'Yesterday'],
        ]
        : [['in', TC.preview, TC.time], ['out', "Thanks — I'll follow up shortly.", TC.time]];
    const withSent = (thread: [string, string, string][], key: string): [string, string, string][] => [
      ...thread,
      ...(s.sent[key] ?? []).map((m) => ['out', m.text, m.time] as [string, string, string]),
    ];
    const talkrMsgs = withSent(msgs, 'talkr:' + TC.id).map(([dir, text, time]) => ({
      text, time, isIn: dir === 'in', isOut: dir === 'out', isSys: dir === 'sys',
      align: dir === 'out' ? 'flex-end' : dir === 'sys' ? 'center' : 'flex-start',
      bg: dir === 'out' ? '#18181b' : dir === 'sys' ? '#fff' : '#f4f4f5',
      color: dir === 'out' ? '#fff' : dir === 'sys' ? '#71717a' : '#18181b',
      border: dir === 'sys' ? '#e4e4e7' : 'transparent',
    }));
    const callMin = Math.floor(s.callSec / 60);
    const callSecs = s.callSec % 60;
    const callClock = callMin + ':' + (callSecs < 10 ? '0' : '') + callSecs;
    const transcriptAll: [string, string][] = [
      ['Taylor', "Hi Kara, it's Taylor with Acme Homes — got your text. Is now still good?"],
      ['Kara', 'Yes, perfect. I went over the offer with my brother last night.'],
      ['Taylor', 'Great. What stood out to you both?'],
      ['Kara', 'Honestly the timeline. We need to be out before September 30th. The number was a bit lower than we hoped.'],
      ['Taylor', 'Understood. If we could guarantee your close date and cover moving costs, how would that compare to a higher number with uncertainty?'],
      ['Kara', 'That matters a lot. We had another investor say 235 but they wanted 60 days and an inspection.'],
      ['Taylor', 'Totally fair. Besides price, what would make one offer easier to move forward with today?'],
      ['Kara', 'Certainty. And not having to fix anything.'],
    ];
    const callTargetFirst = (s.callTarget?.name ?? 'Seller').split(' ')[0] || 'Seller';
    const myFirst = (phone.data.me?.display_name ?? 'You').split(' ')[0] || 'You';
    const liveLines = [
      ...phone.tx.lines.map((l) => ({ who: l.speaker === 'rep' ? myFirst : callTargetFirst, text: l.text, color: l.speaker === 'rep' ? '#71717a' : '#e6142e' })),
      ...(phone.tx.partial.seller ? [{ who: callTargetFirst, text: phone.tx.partial.seller + '…', color: '#e6142e' }] : []),
      ...(phone.tx.partial.rep ? [{ who: myFirst, text: phone.tx.partial.rep + '…', color: '#71717a' }] : []),
    ];
    const transcript = phoneEnabled
      ? liveLines
      : transcriptAll.slice(0, s.transcriptN).map(([who, text]) => ({
        who, text, color: who === 'Kara' ? '#e6142e' : '#71717a',
      }));
    // 'Live' (supervision) is dropped by the dialer for anyone who cannot monitor.
    const dialerTabs = ['Dial', 'Queue', 'Recent', 'Voicemail', 'RVM', 'Live'].map((t) => ({
      label: t, go: () => set({ dialerTab: t }),
      bg: s.dialerTab === t ? '#fff' : 'transparent',
      color: s.dialerTab === t ? '#18181b' : '#71717a',
      shadow: s.dialerTab === t ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
    }));
    const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => ({
      k, go: () => set((st) => ({ dialNumber: st.dialNumber + k })),
    }));
    // Claiming a new lead from the unassigned pool: the first rep to dial it.
    // Never awaited before the dial (iOS drops the mic gesture across a network
    // wait); a claim lost to a faster teammate says whose it is. The demo
    // claims in session state.
    const claimLead = (pid: string) => {
      const p = person(pid);
      if (!p || p.assigned || readOnly) return;
      if (!canWrite || workspaceId === null) {
        set((st) => {
          const base = st.newPeople.find((n) => n.id === pid) ?? D.people.find((x) => x.id === pid);
          return base ? { newPeople: [...st.newPeople.filter((n) => n.id !== pid), { ...base, assigned: ME }] } : {};
        });
        return;
      }
      void claimSeller(workspaceId, pid, me).then((r) => {
        if (!r.ok) return toast(`${p.name} was not claimed: ${r.message}`, 'error');
        if (!r.claimed) return toast(`${p.name} is ${repName(r.owner)}’s lead now. Your call still logs to the record.`);
        refreshPerson(pid);
      });
    };
    /** Someone else took this pool lead after the list was built. */
    const claimedByOther = (it: { target: CallTarget; claim?: boolean }) => {
      const p = it.claim && it.target.personId ? person(it.target.personId) : undefined;
      return !!p?.assigned && p.assigned !== ME;
    };
    /** Dial one Today row, claiming it when it came from the pool. */
    const dialRow = (target: CallTarget, claim?: boolean): boolean => {
      if (claimedByOther({ target, claim })) {
        toast(`${target.name} is ${repName(person(target.personId ?? '')?.assigned)}’s lead now.`);
        return false;
      }
      const placed = startCall(target);
      if (placed && claim && target.personId) claimLead(target.personId);
      return placed;
    };
    // With nobody queued by hand, the Queue tab is Today: the same rows in the
    // same order, so a session dials exactly the list Today shows. It used to
    // be the first five people with any open task, whoever owned them.
    const suggested = todayBase.rows.filter((r) => !r.done).map((r) => {
      const target: CallTarget = r.target;
      return {
        name: r.name, phone: r.target.phone, reason: r.reason, initials: initialsOf(r.name),
        target, queueItemId: undefined as string | undefined, claim: r.claim,
        go: () => dialRow(target, r.claim),
        remove: null as null | (() => void),
      };
    });
    // Who the rep put on their own queue (bulk "Add to Call Queue"), in the
    // order added. Calling someone takes them off; a record no longer loaded
    // (archived, deleted) is left out. Empty, the queue suggests as before.
    const queued = cq.items.flatMap((it) => {
      const rec = it.kind === 'seller' ? people.find((p) => dbId(p.id) === it.recordId) : buyers.find((b) => dbId(b.id) === it.recordId);
      if (!rec) return [];
      const ph = rec.phone === '—' ? '' : rec.phone;
      const target: CallTarget = it.kind === 'seller' ? { name: rec.name, phone: ph, personId: rec.id } : { name: rec.name, phone: ph, buyerId: rec.id };
      return [{
        name: rec.name, phone: ph || '—', initials: initialsOf(rec.name),
        reason: it.kind === 'seller' ? (rec as Person).nextTask || 'Seller' : 'Buyer',
        target, queueItemId: it.id as string | undefined, claim: false,
        // Only drop the row once the call is actually placed: startCall can refuse.
        go: () => { const placed = startCall(target); if (placed) void cq.remove(it.id); return placed; },
        remove: (() => void cq.remove(it.id)) as null | (() => void),
      }];
    });
    const callQueueManual = queued.length > 0;
    const callQueue = callQueueManual ? queued : suggested;
    /** The row a session rings next: a usable number, not do not call, not someone already reached. */
    const runNextOf = (run: QueueRun) => {
      const reached = new Set(run.reached);
      return run.list.slice(run.pos).find((it) => {
        const k = walkKey(it.target);
        return !(k && reached.has(k)) && !!toE164(it.target.phone) && !doNotCall(it.target);
      });
    };
    /** The session stops, finished or ended by the rep: the summary takes over (SessionFinished). */
    const finishRun = (run: QueueRun, how: 'finished' | 'ended') => {
      set({ queueRun: null, queueDone: { run, how, endedAt: nowMs() } });
      if (how === 'finished') toast(`${run.title} finished · ${run.dialed} dialed` + (run.skipped ? ` · ${run.skipped} skipped (no number, do not call or claimed)` : ''));
    };
    /**
     * Count the outcome of the call the session rang last, once. `who` (a
     * personKey) guards against an outcome logged for someone else.
     */
    const tallyRun = (run: QueueRun, key: OutcomeKey, who?: string | null): QueueRun => {
      if (run.at < 0 || run.talliedAt === run.at) return run;
      const k = personKey(run.list[run.at]!.target);
      if (who && who !== k) return run;
      return { ...run, tally: tallyOutcome(run.tally, key, k, s.callSec), talliedAt: run.at };
    };
    /**
     * Dial the next number in a running session, skipping anyone without a
     * usable number or marked do not call, and mark people done as the walk
     * leaves them: off the rep's own queue, or out of the suggestions. A
     * person with several numbers is rung on each in turn before the next
     * person, unless an outcome said they were reached. The session ends, and
     * says so, when nobody dialable is left.
     */
    const advanceRun = (run: QueueRun) => {
      if (callState !== 'idle') return toast('Finish the call on the line first.');
      let i = run.pos;
      let skipped = run.skipped;
      let firstWindow: number | null = null;
      const reached = new Set(run.reached);
      // A pool lead a teammate claimed since the session started is theirs to call.
      // Predictive also walks past any number outside 8am–8pm its time. Power
      // does not: the rep pressed Next, and that press is the decision.
      while (i < run.list.length) {
        const row = run.list[i]!;
        const key = walkKey(row.target);
        // Reached on an earlier number: the rest of theirs are not needed, and are not skips.
        if (key && reached.has(key)) { i++; continue; }
        if (!toE164(row.target.phone) || doNotCall(row.target) || claimedByOther(row)) {
          // A skip counts a person, however many numbers they have.
          if ((row.n ?? 1) === 1) skipped++;
          i++;
          continue;
        }
        if (run.mode === 'predictive' && !inWindow(zonedClock(new Date(), zoneForRvm(row.target.phone)), DEFAULT_RVM_WINDOW)) {
          if (firstWindow === null) firstWindow = i;
          i++;
          continue;
        }
        break;
      }
      const item = run.list[i];
      // The person rung last comes off the rep's own queue once the walk is
      // past their last number: the next row (or where predictive will pick
      // up) is someone else, or nobody.
      const prev = run.at >= 0 ? run.list[run.at] : undefined;
      const resume = item ?? (firstWindow !== null ? run.list[firstWindow] : undefined);
      if (prev?.queueItemId && (!resume || walkKey(resume.target) !== walkKey(prev.target))) void cq.remove(prev.queueItemId);
      if (!item) {
        if (firstWindow !== null) {
          const hold = 'Everyone left is outside 8am–8pm their time. Predictive waits for that window.';
          set({ queueRun: { ...run, pos: firstWindow, skipped, hold } });
          return toast(hold);
        }
        return finishRun({ ...run, skipped }, 'finished');
      }
      // Refused before anything rang (the phone still connecting): stay on
      // this number, so Next tries it again rather than losing it.
      if (!startCall(item.target, { session: true })) return set({ queueRun: { ...run, pos: i, skipped, hold: null } });
      // With more of their numbers to come (or still being read) they stay on
      // the queue until the walk moves past them.
      const key = walkKey(item.target);
      const more = run.loading || (!!key && run.list.slice(i + 1).some((r) => walkKey(r.target) === key));
      if (item.queueItemId && !more) void cq.remove(item.queueItemId);
      if (item.claim && item.target.personId) claimLead(item.target.personId);
      if (item.target.phoneId != null && workspaceId !== null && canWrite && !readOnly) {
        void noteDialled(workspaceId, item.target.personId ? 'seller' : 'buyer', item.target.phoneId);
      }
      const pid = item.target.personId;
      set((st) => ({
        queueRun: { ...run, pos: i + 1, at: i, dialed: run.dialed + 1, skipped, hold: null },
        queueCalled: !item.queueItemId && pid ? { ...st.queueCalled, [pid]: true } : st.queueCalled,
      }));
    };
    /** Stop trying this person's other numbers in the running session, and take them off the rep's own queue. */
    const passPerson = (key: string) => {
      const it = s.queueRun?.list.find((r) => r.queueItemId && walkKey(r.target) === key);
      if (it?.queueItemId) void cq.remove(it.queueItemId);
      set((st) => (st.queueRun && !st.queueRun.reached.includes(key) ? { queueRun: { ...st.queueRun, reached: [...st.queueRun.reached, key] } } : {}));
    };
    /**
     * Start a session over a CLOZR list. Talkr's power dialer walks only its
     * own campaigns, and CLOZR records are not Talkr leads, so a CLOZR list is
     * walked here instead: same Next, same one-session-at-a-time rule.
     *
     * `depth` is how many numbers each seller or buyer is tried on: the
     * record's own phone, then their other numbers (seller_phones,
     * buyer_phones), read once for the whole list.
     */
    const launchRun = (title: string, list: QueueRunItem[], mode: 'power' | 'predictive', depth: QueueDepth, confirm: boolean): Promise<boolean> => {
      // A click handler passed straight through once handed its event in as the mode.
      const m = mode === 'predictive' ? 'predictive' : 'power';
      const d: QueueDepth = workspaceId !== null && (depth === 2 || depth === 3 || depth === 'all') ? depth : 1;
      const ws = workspaceId;
      const sellerIds = [...new Set(list.flatMap((it) => (it.target.personId ? [dbId(it.target.personId)] : [])))];
      const buyerIds = [...new Set(list.flatMap((it) => (it.target.buyerId ? [dbId(it.target.buyerId)] : [])))];
      type NumbersOf = (row: QueueRunItem) => DialNumber[] | undefined;
      // One read per table for the whole list. A failed read leaves each person their own phone.
      const pending: Promise<NumbersOf> | null = d === 1 || ws === null || !(sellerIds.length + buyerIds.length) ? null
        : Promise.all([loadSellerPhones(ws, sellerIds), loadBuyerPhones(ws, buyerIds)]).then(([sp, bp]): NumbersOf => (row) => {
          const t = row.target;
          if (t.personId) return dialNumbers(t.phone, sp.get(dbId(t.personId)) ?? [], d);
          if (t.buyerId) return dialNumbers(t.phone, bp.get(dbId(t.buyerId)) ?? [], d);
          return undefined;
        }, (): NumbersOf => () => undefined);
      let numbers: NumbersOf | null = null;
      void pending?.then((f) => { numbers = f; });
      const base: QueueRun = {
        title, list, pos: 0, dialed: 0, skipped: 0, mode: m, dropped: 0, hold: null, depth: d, loading: !!pending, at: -1, reached: [],
        tally: emptyTally(), talliedAt: -1, origin: list, startedAt: nowMs(),
      };
      const go = () => {
        if (!pending) return advanceRun(base);
        const known: NumbersOf | null = numbers;
        if (known) return advanceRun({ ...base, list: spliceNumbers(list, 0, known), loading: false });
        // The first person cannot ring on their own phone: wait for everyone's
        // numbers, so nobody is walked past before theirs are known.
        const first = list[0]!;
        if (!toE164(first.target.phone) || doNotCall(first.target) || claimedByOther(first)) {
          return void pending.then((f) => advanceRun({ ...base, list: spliceNumbers(list, 0, f), loading: false }));
        }
        // The first call rings in this click (it keeps the mic gesture); the
        // other numbers join the list behind it as soon as they are read. The
        // list is this session's until they do, so a later session is never touched.
        advanceRun(base);
        void pending.then((f) => set((st) => (st.queueRun?.list === list && st.queueRun.loading
          ? { queueRun: { ...st.queueRun, list: spliceNumbers(st.queueRun.list, st.queueRun.pos, f), loading: false } }
          : {})));
      };
      // A new session replaces any saved one and the last summary.
      const launch = () => {
        set({ queueResume: null, queueDone: null });
        go();
        return true;
      };
      // The setup sheet has already shown the checklist. Without one on
      // screen, anything missing is shown first and the rep can start anyway;
      // ready starts in this same click, so the first call keeps its gesture.
      if (!confirm || !phoneEnabled) return Promise.resolve(launch());
      const ready = confirmDialerReady(m);
      if (ready === true) return Promise.resolve(launch());
      return ready.then((yes) => (yes ? launch() : false));
    };
    /** Who a session list holds, for the setup sheet: people, and how many the walk will skip. */
    const listFacts = (list: QueueRunItem[]): ListFacts => {
      const first = new Map<string, QueueRunItem>();
      for (const r of list) {
        const k = personKey(r.target);
        if (!first.has(k)) first.set(k, r);
      }
      let noNumber = 0, dnc = 0, claimed = 0;
      for (const r of first.values()) {
        if (!toE164(r.target.phone)) noNumber++;
        else if (doNotCall(r.target)) dnc++;
        else if (claimedByOther(r)) claimed++;
      }
      return { people: first.size, noNumber, dnc, claimed };
    };
    type RunList = { id: string; title: string; list: QueueRunItem[] };
    /**
     * Start a session. Every start (the queue, Today's power dial, a vendor
     * call list, the RVM tab, Run it again, Start a new session) opens the
     * setup sheet first (components/talkr/DialSessionSetup.tsx): mode, numbers
     * per lead, caller ID, the voicemail to drop and the readiness checklist.
     * A null mode or depth takes the rep's last choice; `more` puts other
     * lists in the sheet's list picker. Resolves true once the session runs.
     */
    const startRun = (title: string, list: QueueRunItem[], mode: 'power' | 'predictive' | null = null, depth: QueueDepth | null = null, more: RunList[] = []): Promise<boolean> => {
      if (phone.session.session) {
        toast('A Talkr campaign session is running. End it before starting another.');
        return Promise.resolve(false);
      }
      if (s.queueRun) {
        toast('A session is already running. End it before starting another.');
        return Promise.resolve(false);
      }
      const lists = [{ id: 'this', title, list }, ...more].filter((l) => l.list.length);
      if (!lists.length) {
        toast('Nobody on the list to call');
        return Promise.resolve(false);
      }
      // A click handler passed straight through hands its event in as the mode.
      const asked = mode === 'predictive' || mode === 'power' ? mode : null;
      const options: SetupListOption[] = lists.map((l) => ({ id: l.id, title: l.title, facts: listFacts(l.list), hasRecords: l.list.some((r) => !!walkKey(r.target)) }));
      const choice = requestSessionSetup({ kind: 'list', lists: options, listId: lists[0]!.id, mode: asked, depth });
      if (choice === false) {
        const prefs = readPrefs(workspaceId, me);
        return launchRun(lists[0]!.title, lists[0]!.list, asked ?? prefs.mode, depth ?? prefs.depth, true);
      }
      return choice.then((c) => {
        if (!c) return false;
        const l = lists.find((x) => x.id === c.listId) ?? lists[0]!;
        return launchRun(l.title, l.list, c.mode, c.depth, false);
      });
    };
    /** The person a session rings next, as the bar shows them between calls. */
    const upNextOf = (t: CallTarget) => {
      const p = t.personId ? person(t.personId) : undefined;
      if (p) return { name: p.name, kind: 'Seller', stage: p.stage, line: [p.property.addr, p.property.city].filter((x) => x && x !== '—').join(', ') };
      const b = t.buyerId ? buyer(t.buyerId) : undefined;
      if (b) return { name: b.name, kind: 'Buyer', stage: b.status, line: (b.company && b.company !== '—' ? b.company : b.markets.slice(0, 3).join(', ')) };
      return { name: t.name, kind: '', stage: '', line: '' };
    };
    // Where the walk is: the row rung last, and whether Next rings the same person again.
    const runAt = s.queueRun && s.queueRun.at >= 0 ? s.queueRun.list[s.queueRun.at] : undefined;
    const runAtKey = runAt ? walkKey(runAt.target) : null;
    const runUpNext = s.queueRun ? runNextOf(s.queueRun) : undefined;
    const runSameNext = !!runUpNext && !!runAtKey && walkKey(runUpNext.target) === runAtKey;
    const queueSession = s.queueRun && {
      title: s.queueRun.title,
      mode: s.queueRun.mode,
      dialed: s.queueRun.dialed,
      dropped: s.queueRun.dropped,
      skipped: s.queueRun.skipped,
      hold: s.queueRun.hold,
      /** People not started on yet, whichever number of the current one is being tried. */
      left: peopleLeft(s.queueRun.list, s.queueRun.pos, runAtKey ? [...s.queueRun.reached, runAtKey] : s.queueRun.reached),
      /** "Number 2 of 3" while a person with several numbers is being walked. */
      number: runAt && (runAt.of ?? 1) > 1
        ? { name: runAt.target.name, n: runAt.n ?? 1, of: runAt.of ?? 1, phone: formatPhone(toE164(runAt.target.phone) ?? runAt.target.phone) }
        : null,
      nextLabel: runSameNext && runUpNext ? `Call number ${runUpNext.n ?? 1} of ${runUpNext.of ?? 1}` : 'Next call',
      /** Move on to the next person without trying the rest of this one's numbers. */
      skipPerson: runSameNext && runAtKey ? () => passPerson(runAtKey) : null,
      next: () => (s.queueRun ? advanceRun(s.queueRun) : undefined),
      end: () => (s.queueRun ? finishRun(s.queueRun, 'ended') : undefined),
      /** Where the list stands: "23 of 140", reached, numbers left, depth (lib/dial-session.ts). */
      progress: sessionProgress(s.queueRun, s.queueRun.tally),
      tally: s.queueRun.tally,
      startedAt: s.queueRun.startedAt,
      /** Between calls: who Next rings, with what the CRM knows, so nobody is a surprise. */
      upNext: runUpNext && !runSameNext && callState === 'idle' ? upNextOf(runUpNext.target) : null,
      /**
       * A buyer's or an unknown number's wrap-up (Talkr dispositions, not the
       * seller outcomes), counted by what the disposition means. `talked`
       * with no disposition is a conversation the call summary covered.
       */
      logCall: (disposition: string | null, o: { noAnswer: boolean; talked: boolean }) => {
        const key = outcomeForDisposition(disposition) ?? (o.noAnswer ? 'noanswer' : o.talked ? 'followup' : null);
        if (key) set((st) => (st.queueRun ? { queueRun: tallyRun(st.queueRun, key) } : {}));
      },
    };
    // ---- the session after it stops, and the one saved for later ----
    /** "Start a new session": the setup sheet, with the lists a rep dials from in its picker. */
    const newSession = () => {
      const lists: RunList[] = [];
      const last = s.queueDone?.run;
      if (last) {
        const again = runAgainList(last.origin, last.tally, last.reached, 'not_reached');
        if (again.length) lists.push({ id: 'again', title: `${last.title} · not reached`, list: again });
      }
      if (callQueueManual) lists.push({ id: 'queue', title: 'Call queue', list: callQueue.map((q) => ({ target: q.target, queueItemId: q.queueItemId, claim: q.claim })) });
      lists.push({ id: 'today', title: 'Today', list: suggested.map((q) => ({ target: q.target, claim: q.claim })) });
      const [first, ...rest] = lists.filter((l) => l.list.length);
      if (!first) return void toast('Nobody on your call queue or Today to call');
      set({ queueDone: null });
      void startRun(first.title, first.list, null, null, rest);
    };
    const doneRun = s.queueDone?.run;
    const queueDone = s.queueDone && doneRun ? {
      title: doneRun.title,
      how: s.queueDone.how,
      mode: doneRun.mode,
      dialed: doneRun.dialed,
      dropped: doneRun.dropped,
      skipped: doneRun.skipped,
      progress: sessionProgress(doneRun, doneRun.tally),
      tally: doneRun.tally,
      startedAt: doneRun.startedAt,
      endedAt: s.queueDone.endedAt,
      /** How many "Run the same list again" would dial, by filter. */
      againCounts: runAgainCounts(doneRun.origin, doneRun.tally, doneRun.reached),
      left: peopleLeft(doneRun.list, doneRun.pos, doneRun.reached),
      runAgain: (filter: RunAgainFilter) => {
        const list = runAgainList(doneRun.origin, doneRun.tally, doneRun.reached, filter);
        if (!list.length) return void toast('Nobody on the list for that');
        set({ queueDone: null });
        void startRun(doneRun.title, list, doneRun.mode, doneRun.depth);
      },
      /** Ended early: back into the same session where it stopped. */
      keepGoing: s.queueDone.how === 'ended' && peopleLeft(doneRun.list, doneRun.pos, doneRun.reached) > 0 && !phone.session.session
        ? () => set({ queueDone: null, queueRun: { ...doneRun, hold: null, loading: false } })
        : null,
      newSession,
      close: () => set({ queueDone: null }),
    } : null;
    const savedRun = !s.queueRun ? s.queueResume : null;
    const queueResume = savedRun ? {
      title: savedRun.title,
      mode: savedRun.mode,
      label: resumeLabel(savedRun, new Date(savedRun.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()),
      progress: sessionProgress(savedRun, savedRun.tally),
      resume: () => {
        if (phone.session.session) return void toast('A Talkr campaign session is running. End it first.');
        set({
          queueResume: null, queueDone: null,
          queueRun: { ...savedRun, list: savedRun.list as QueueRunItem[], origin: savedRun.origin as QueueRunItem[], hold: null, loading: false, talliedAt: savedRun.at },
        });
        toast(`${savedRun.title} picked back up. Press Next call when you are ready.`);
      },
      discard: () => {
        try { localStorage.removeItem(runKey(workspaceId, me)); } catch { /* private mode */ }
        set({ queueResume: null });
      },
    } : null;
    /** The X on the queue: empties the rep's own queue. */
    const clearCallQueue = () => {
      if (!callQueueManual) return;
      if (!window.confirm(`Take all ${queued.length} off your call queue?`)) return;
      void cq.clear().then((r) => toast(r.ok ? 'Call queue cleared' : r.message || 'The call queue did not clear.', r.ok ? 'success' : 'error'));
    };
    // Call history and voicemail belong to Talkr; until it reports them, a live
    // workspace shows none rather than someone else's.
    const otherOf = (c: { direction: string; from_number: string; to_number: string }) => (c.direction === 'outbound' ? c.to_number : c.from_number);
    const recentCalls = phoneEnabled
      ? phone.data.recent.map((c) => ({
        name: c.contact_name ?? formatPhone(otherOf(c)),
        kind: `${c.direction === 'inbound' ? 'Inbound' : 'Outbound'} · ${c.duration_seconds ? fmtDuration(c.duration_seconds) : c.status.replace(/_/g, ' ')}`,
        time: relativeTime(c.created_at),
      }))
      : (live ? [] : [
      ['Kara Mitchell', 'Outbound · 4m 12s', 'Today 9:42'],
      ['Andrea Lopez', 'Inbound · 6m 40s', 'Today 8:18'],
      ['Chris Anderson · Harbor Capital', 'Outbound · 2m 05s', 'Yesterday'],
      ['Harold Kim', 'Missed', 'Yesterday'],
      ['Derek Ross', 'Outbound · 9m 31s', 'Aug 30'],
    ] as [string, string, string][]).map(([name, kind, time]) => ({ name, kind, time }));
    // Call back rings the number that left the voicemail, carrying the CLOZR
    // record behind it the way the inbox's call button does. It used to redial
    // the last call target, which is whoever the rep spoke to most recently.
    const callBackFrom = (name: string, from: string) => () =>
      startCall(dialerRecordFor(from)?.target ?? { name, phone: from });
    const voicemails = phoneEnabled
      ? tHistory.filter(isVoicemail).map((h) => ({
        id: h.id as string | null, hasRecording: !!h.has_recording,
        name: h.contact_name ?? formatPhone(h.from_number),
        text: `${h.duration_seconds ? fmtDuration(h.duration_seconds) : 'Voicemail'}${h.note ? ` · "${h.note}"` : ''}`,
        time: relativeTime(h.at),
        callBack: callBackFrom(h.contact_name ?? formatPhone(h.from_number), h.from_number),
      }))
      : (live ? [] : [
      ['Harold Kim', '(713) 555-0188', '0:48 · "Confirming Saturday at 10, call me back"', 'Yesterday'],
      ['Gary Whitfield', '(281) 555-0170', '0:22 · "Still thinking, call Tuesday"', 'Aug 31'],
    ] as [string, string, string, string][]).map(([name, from, text, time]) => ({ id: null as string | null, hasRecording: false, name, text, time, callBack: callBackFrom(name, from) }));
    const callTarget = s.callTarget || { name: '—', phone: s.dialNumber };
    // The CLOZR record behind a number, as the Talkr dialer's CallContext panel
    // shows it (app/components/talkr/CallContext.tsx `ClozrRecord`).
    const personRecord = (p: Person): ClozrRecord => ({
      kind: 'seller', name: p.name, stage: p.stage, phone: p.phone,
      address: [p.property.addr, p.property.city, p.property.st].filter(Boolean).join(', '),
      // Why now and the money, so the phone's context shows what the desk's Today does.
      facts: ([
        ['Why now', todayBase.rows.find((r) => r.pid === p.id && !r.done)?.why ?? ''],
        ['Asking', p.asking],
        ['Last offer', dealOf(p.id)?.contract != null ? fmt(dealOf(p.id)!.contract) : p.offer ?? ''],
        ['ARV', dealOf(p.id)?.arv != null ? fmt(dealOf(p.id)!.arv) : ''],
        ['MAO', dealOf(p.id)?.mao != null ? fmt(dealOf(p.id)!.mao) : ''],
        ['Deal stage', dealOf(p.id)?.stage && dealOf(p.id)!.stage !== p.stage ? dealOf(p.id)!.stage! : ''],
        ['Last touch', p.lastComm], ['Motivation', p.motivation], ['Timeline', p.timeline], ['Condition', p.condition], ['Next task', p.nextTask],
        ['Notes', (p.notes ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)],
      ] as [string, string][])
        .filter(([, v]) => v && v !== '—'),
      openTasks: tasks.filter((t) => t.personId === p.id && !t.done).map((t) => ({ title: t.title, due: t.due })),
      open: () => openPerson(p.id),
    });
    /** A deal as one line: its property, and its stage when it has one. */
    const dealLine = (dealId: string | undefined) => {
      const d = dealId ? deals.find((x) => x.id === dealId) : undefined;
      if (!d) return '';
      const p = d.personId ? person(d.personId) : undefined;
      const where = d.addr || p?.property.addr || p?.name || 'a deal';
      return d.stage ? `${where} (${d.stage})` : where;
    };
    // A buyer on the line: what they buy, and the deals between you, so a
    // dispo call has the numbers in front of the rep the way a seller call does.
    const buyerRecord = (b: Buyer): ClozrRecord => {
      const theirs = D.offers.filter((o) => o.buyerId === b.id);
      const latest = theirs[theirs.length - 1];
      const onDeal = deals.find((d) => d.buyerId === b.id && !d.archived);
      return {
        kind: 'buyer', name: b.name, stage: b.status, phone: b.phone, address: b.markets.join(', '),
        facts: ([
          ['Company', b.company], ['Buy box', b.buyBox.price], ['Property type', b.buyBox.type], ['Strategy', b.strategy],
          ['Rehab', b.rehabTol], ['Ceiling', b.ceiling],
          ['Latest offer', latest ? `${fmt(latest.offer)}${dealLine(latest.dealId) ? ` on ${dealLine(latest.dealId)}` : ''}` : ''],
          ['Offers', theirs.length ? String(theirs.length) : b.offers],
          ['On deal', onDeal ? dealLine(onDeal.id) : ''],
          ['Last purchase', b.lastPurchase], ['Last touch', b.lastActivity],
          ['Notes', b.issue || b.summary[0] || ''],
        ] as [string, string][]).filter(([, v]) => v && v !== '—' && v !== '0'),
        openTasks: [],
        open: () => openBuyer(b.id),
      };
    };
    const dialerRecordFor = (number: string): (ClozrRecord & { target: CallTarget }) | null => {
      const e = toE164(number);
      if (!e) return null;
      const p = people.find((x) => toE164(x.phone) === e);
      if (p) return { ...personRecord(p), target: { name: p.name, phone: p.phone, personId: p.id } };
      const b = buyers.find((x) => toE164(x.phone) === e);
      return b ? { ...buyerRecord(b), target: { name: b.name, phone: b.phone, buyerId: b.id } } : null;
    };
    const callPersonRec = s.callTarget?.personId ? person(s.callTarget.personId) : undefined;
    const callBuyerRec = s.callTarget?.buyerId ? buyer(s.callTarget.buyerId) : undefined;
    const callRecord = callPersonRec ? personRecord(callPersonRec) : callBuyerRec ? buyerRecord(callBuyerRec) : s.callTarget ? dialerRecordFor(s.callTarget.phone) : null;
    const sum = phone.summary;
    // What the call yielded, for the rep to correct before Accept writes it.
    // `key` names the summary field, which is how acceptWrap takes the edits
    // back; a field the call did not yield is empty (the field shows a dash).
    const wrapFields = (phoneEnabled
      ? (sum
        ? ([
          ['motivation', 'Motivation', sum.motivation ?? ''], ['timeline', 'Timeline', sum.timeline ?? ''],
          ['price_expectation', 'Price expectation', sum.price_expectation ?? ''], ['objection', 'Objection', sum.objection ?? ''],
          ['follow_up', 'Follow-up', sum.follow_up ?? ''], ['suggested_task', 'Suggested task', sum.suggested_task ?? ''],
        ] as [WrapKey, string, string][])
        : ([] as [WrapKey, string, string][]))
      // The sample fields are Kara's call; on anyone else they would be made up.
      : s.callTarget?.personId !== 'p1' ? ([] as [WrapKey, string, string][]) : ([
        ['motivation', 'Motivation', 'Relocating · needs Sept 30 close'], ['timeline', 'Timeline', 'Before Sept 30 (confirmed)'],
        ['price_expectation', 'Price expectation', '$235,000 (competing verbal)'], ['objection', 'Objection', 'Wants to compare another offer'],
        ['follow_up', 'Follow-up', 'Today 2:00 PM · revised offer'], ['suggested_task', 'Suggested task', 'Send revised offer w/ moving allowance'],
      ] as [WrapKey, string, string][])).map(([key, k, v]) => ({ key, k, v }));

    // ---- TODAY and the call outcome -------------------------------------------
    // Today's rows (todayBase) with the screen's state on top, and the one save
    // every seller call goes through: Today's rail, the desk wrap-up and the
    // phone's wrap-up all plan with lib/call-outcomes and save with saveOutcome.
    const todayAll = todayBase.rows;
    const todayOpen = todayAll.filter((r) => !r.done);
    const todayRowOf = (pid: string | null | undefined) => (pid ? todayAll.find((r) => r.pid === pid) : undefined);
    const picked = todayRowOf(s.todaySel);
    /** The seller Today shows: the one on the line, else the one armed to log, else the picked row, else the first not done. */
    const todayPid = callPid || s.logArmed || (picked && !picked.done ? picked.pid : null) || todayOpen[0]?.pid || null;
    const repZone = repZoneNow();
    const sendCtx = live ? textCtx : { repName: D.team[ME]?.name ?? '', company: workspaceName || 'Acme Homes' };
    const talkrList = !phoneEnabled ? null : talkrLive ? phone.data.dispositions : [];
    const known = (v: string | null | undefined) => !!v && v !== '—' && !/^(unknown|no contact yet)$/i.test(v.trim());
    /** The open overdue or today task that the outcome completes or moves, for a seller who is not on Today. */
    const dueTaskOf = (pid: string) => {
      const open = tasks.filter((t) => t.personId === pid && !(s.tasksDone[t.id] ?? t.done)).map((t) => ({ ...t, done: false }));
      const t = now ? dueTaskFor(tasksByPerson(open).get(pid), ME, now) : null;
      return t ? { id: t.id, title: t.title, type: t.type } : null;
    };

    /**
     * Save one outcome. Core writes (claim, stage, task, appointment, tags) run
     * together and any failure stops here: the call stays in wrap-up, nothing
     * is texted and the queue does not move, and the ledger lets a retry skip
     * what already landed. Then the call closes and the session moves on, and
     * the rest (note, activity, facts, text, COMPR) runs behind it, each
     * failure named in one error toast.
     */
    const saveOutcome = async (plan: OutcomePlan, mode: 'call' | 'log', opts: OutcomeSaveOpts): Promise<OutcomeLedger> => {
      const ledger: OutcomeLedger = { ok: { ...(opts.ledger?.ok ?? {}) }, failed: [], saved: false };
      const pid = plan.personId;
      const hadCall = mode === 'call';
      const callId = hadCall && phoneEnabled && sp.call && sp.call.id !== 'unknown' ? sp.call.id : null;
      const notes = opts.notes.trim();
      const row = todayRowOf(pid);
      const at = todayAll.findIndex((r) => r.pid === pid);
      const inGroup = row ? todayAll.filter((r) => r.group === row.group).findIndex((r) => r.pid === pid) : 0;
      const nextPid = (todayAll.slice(at + 1).find((r) => !r.done && r.pid !== pid) ?? todayOpen.find((r) => r.pid !== pid))?.pid ?? null;
      // The session goes on if there is someone left to dial. After the last
      // one it ends here, quietly, so the save's own toast is the one read.
      const run = s.queueRun;
      // Walking their numbers: a conversation (or do not call) is the last of
      // them; no answer, voicemail or a wrong number goes on to the next one.
      const walkEnds = hadCall && !!run && endsNumberWalk(plan.key);
      const walked = walkKey({ personId: pid })!;
      const moreInRun = !!run && !!runNextOf(walkEnds ? { ...run, reached: [...run.reached, walked] } : run);
      const talkrOn = !!phone.session.session && phone.session.session.state !== 'paused';
      const talkrMode = phone.session.campaign?.mode ?? phone.session.session?.mode;
      // The Save label promises the next call — honour it, in CLOZR's power
      // list and in a Talkr campaign, power mode included (advancesAfterSave).
      const continuing = hadCall && (moreInRun || (talkrOn && advancesAfterSave(talkrMode)));
      // Close the call and move on, in one tick: the notes draft empties with
      // the call, so the softphone does not file it a second time.
      const close = (msg: string, tone: ToastTone) => {
        opts.clearNotes?.();
        if (walkEnds) passPerson(walked);
        else if (hadCall && run && !moreInRun) {
          // The session's last call: whoever it was is off the rep's own queue now.
          const last = run.list[run.at];
          if (last?.queueItemId) void cq.remove(last.queueItemId);
        }
        set((st) => ({
          todayDone: row && !readOnly
            ? { ...st.todayDone, [pid]: { seq: Object.keys(st.todayDone).length + 1, label: plan.outcome.short, row, at: inGroup } }
            : st.todayDone,
          todaySel: row ? nextPid : st.todaySel,
          logArmed: null,
          advanceAfterSave: continuing,
          // The session counts the call (lib/dial-session.ts); after its last
          // one it stops here and the finished summary takes over.
          ...(hadCall && run && st.queueRun
            ? (moreInRun
              ? { queueRun: tallyRun(st.queueRun, plan.key, walked) }
              : { queueRun: null, queueDone: { run: tallyRun(st.queueRun, plan.key, walked), how: 'finished' as const, endedAt: nowMs() } })
            : {}),
          // Back on Today (or the screen the call came from) rather than a keypad.
          ...(!continuing && (st.isMobile || st.screen === 'today') ? { dialerOpen: false } : {}),
        }));
        if (hadCall) finishCall(msg, tone);
        else toast(msg, tone);
      };

      // View-as: an admin's preview places real calls but writes nothing.
      if (readOnly) {
        close(READ_ONLY_MESSAGE, 'info');
        return { ...ledger, saved: true };
      }

      // The demo: the same plan, played into session state.
      if (!canWrite || workspaceId === null) {
        // Not nextId: this runs in a click, and the ids need only be unique for the session.
        const sid = (prefix: string) => prefix + '_' + Math.random().toString(36).slice(2, 10);
        const day0 = new Date();
        day0.setHours(0, 0, 0, 0);
        const label = (iso: string) => {
          const d = new Date(iso);
          const days = Math.floor((d.getTime() - day0.getTime()) / 86_400_000);
          const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
            : days < 7 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return day + ' ' + time;
        };
        const bucket = (iso: string) => (Date.parse(iso) < day0.getTime() + 86_400_000 ? 'today' : 'upcoming');
        const mk = (title: string, type: string, dueAt: string): Task => ({
          id: sid('k'), title, personId: pid, type, due: label(dueAt), dueAt, assigned: ME, priority: 'Medium', done: false, bucket: bucket(dueAt),
        });
        const t = plan.task;
        const madeTasks = [
          ...(t?.reschedule ? [mk(t.reschedule.title, 'Call', t.reschedule.dueAt)] : []),
          ...(t?.create ? [mk(t.create.title, t.create.type, t.create.dueAt)] : []),
        ];
        const comm = (channel: string, preview: string): Communication => ({
          id: sid('c'), personId: pid, channel, dir: 'out', party: plan.name, user: ME, ts: 0, time: 'Just now', preview,
        });
        const comms = [...(notes ? [comm('note', notes)] : []), ...(plan.text?.on ? [comm('sms', plan.text.body)] : [])];
        const appt = plan.appointment;
        const apptId = sid('ap');
        set((st) => {
          const base = st.newPeople.find((n) => n.id === pid) ?? D.people.find((x) => x.id === pid);
          const edited = base && (plan.claim || plan.tags.length)
            ? { ...base, ...(plan.claim && !base.assigned ? { assigned: ME } : {}), tags: [...new Set([...(base.tags ?? []), ...plan.tags])] }
            : null;
          const done = { ...st.tasksDone };
          if (t?.complete) done[t.complete.id] = true;
          if (t?.reschedule) done[t.reschedule.id] = true;
          const when = appt ? label(appt.startsAt) : '';
          return {
            ...(plan.stage ? { stageOverrides: { ...st.stageOverrides, [pid]: plan.stage.to } } : {}),
            tasksDone: done,
            newTasks: [...st.newTasks, ...madeTasks],
            ...(appt ? { newAppointments: [...st.newAppointments, { id: apptId, day: when.replace(/ \d.*$/, ''), t: when.replace(/^\S+ /, ''), title: appt.title, kind: 'Appointment' }] } : {}),
            newComms: [...st.newComms, ...comms],
            ...(edited ? { newPeople: [...st.newPeople.filter((n) => n.id !== pid), edited] } : {}),
          };
        });
        close(outcomeToast(plan, { demo: true }), 'info');
        return { ...ledger, saved: true };
      }

      // ---- Phase A: the core writes, together.
      const wid = workspaceId;
      const sellerId = dbId(pid);
      let owner: string | null = null;
      type Step = { step: string; label: string; run: () => Promise<{ ok: boolean; message?: string }>; undo?: () => void };
      const steps: Step[] = [];
      if (plan.claim) {
        steps.push({
          step: 'claim', label: 'claim', run: async () => {
            const r = await claimSeller(wid, pid, me);
            if (r.ok && !r.claimed) owner = r.owner ?? null;
            return r;
          },
        });
      }
      // A record pinned to a real submission moves that house (deals.lead_stage),
      // as the stage picker does; otherwise the seller's own stage.
      const subDeal = opts.house?.subDealId ?? null;
      const stageKey = subDeal ? 'sub:' + subDeal : pid;
      if (plan.stage) {
        const to = plan.stage.to;
        if (!ledger.ok.stage) set((st) => ({ stageOverrides: { ...st.stageOverrides, [stageKey]: to } }));
        steps.push({
          step: 'stage', label: 'stage', run: () => (subDeal ? setSubmissionStage(wid, [subDeal], to, me) : setStageWrite(wid, pid, to, me)),
          undo: () => set((st) => {
            if (st.stageOverrides[stageKey] !== to) return {};
            const next = { ...st.stageOverrides };
            delete next[stageKey];
            return { stageOverrides: next };
          }),
        });
      }
      const t = plan.task;
      if (t?.complete) {
        const id = t.complete.id;
        if (!ledger.ok['task-done']) set((st) => ({ tasksDone: { ...st.tasksDone, [id]: true } }));
        steps.push({
          step: 'task-done', label: 'task completion', run: () => setTaskDone(id, true, me),
          undo: () => set((st) => {
            const next = { ...st.tasksDone };
            delete next[id];
            return { tasksDone: next };
          }),
        });
      }
      if (t?.reschedule) {
        const r = t.reschedule;
        steps.push({ step: 'task-move', label: 'follow-up time', run: () => setTaskDue(r.id, r.dueAt) });
      }
      if (t?.create) {
        const c = t.create;
        steps.push({ step: 'task-new', label: 'follow-up task', run: () => createTask(wid, { title: c.title, type: c.type, dueAt: c.dueAt, personId: pid }, me) });
      }
      if (plan.appointment) {
        const a = plan.appointment;
        steps.push({ step: 'appointment', label: 'appointment', run: () => createAppointment(wid, { title: a.title, type: 'Appointment', startsAt: a.startsAt, personId: pid }, me) });
      }
      for (const tag of plan.tags) steps.push({ step: 'tag:' + tag, label: `${tag} tag`, run: () => tagSellers([pid], tag) });
      if (plan.enroll) {
        const pl = plan.enroll;
        steps.push({ step: 'enroll', label: `${pl.name} drip`, run: () => enrollInPlan(wid, pl.id, pid, me) });
      }
      if (plan.wrongNumberId != null) {
        const numberId = plan.wrongNumberId;
        steps.push({ step: 'number-wrong', label: 'wrong number mark', run: () => markSellerPhone(wid, numberId, { is_wrong: true }) });
      }
      if (plan.wrongPrimary) {
        const own = person(pid)?.phone;
        steps.push({ step: 'primary-wrong', label: 'main number mark', run: () => markPrimaryWrong(wid, dbId(pid), own) });
      }
      // Talkr's disposition runs with the core, since a progressive Talkr
      // session moves on when it lands, but a refusal does not block the save.
      const talkr = plan.talkr;
      const talkrStep: Promise<string | null> = callId && talkr && !ledger.ok.talkr
        ? phone.disposition(plan.outcome.label, notes || undefined, { slug: talkr.slug, callId, ...(plan.followUpAt ? { follow_up_at: plan.followUpAt } : {}) })
          .then(() => null, (e: Error) => `Talkr disposition not logged (${e.message})`)
        : Promise.resolve(null);
      const results = await Promise.allSettled(steps.map((st): Promise<{ ok: boolean; message?: string }> => (ledger.ok[st.step] ? Promise.resolve({ ok: true }) : st.run())));
      results.forEach((r, i) => {
        const st = steps[i]!;
        if (r.status === 'fulfilled' && r.value.ok) {
          ledger.ok[st.step] = true;
          return;
        }
        st.undo?.();
        const message = r.status === 'fulfilled' ? r.value.message : (r.reason as Error | undefined)?.message;
        ledger.failed.push({ step: st.step, label: st.label, message: message || 'not saved' });
      });
      const talkrFailed = await talkrStep;
      if (!talkrFailed && callId && talkr) ledger.ok.talkr = true;
      if (ledger.failed.length) {
        const saved = steps.filter((st) => ledger.ok[st.step]).map((st) => st.label);
        toast(`${saved.length ? `Saved: ${saved.join(', ')}. ` : ''}Not saved: ${ledger.failed.map((f) => `${f.label} (${f.message})`).join(', ')}. Nothing was texted.`, 'error');
        return ledger;
      }
      // The stage is saved: the database now says what the override said.
      if (plan.stage) {
        const to = plan.stage.to;
        set((st) => {
          if (st.stageOverrides[stageKey] !== to) return {};
          const next = { ...st.stageOverrides };
          delete next[stageKey];
          return { stageOverrides: next };
        });
      }

      // ---- Phase B: close the call and move on.
      const text = plan.text?.on ? plan.text : null;
      close(outcomeToast(plan, { textQueued: !!text, owner: owner ? repName(owner) : null }), 'success');
      reload?.();
      // Offer accepted: the deal for the house on screen (the pinned deal, else
      // this seller's open deal on that property, else a new one at Prospect,
      // where a deal sits until the contract makes it Under Contract Seller)
      // and its sheet, to fill in and send the contract. Never another house.
      if (plan.openDeal) {
        const house = opts.house;
        const open = (dealId: string) => go('dealSheet', { personId: pid, dealSheetDealId: dealId, dealSheetPrompt: true });
        if (house?.dealId) open(house.dealId);
        else {
          void openDealOnProperty(wid, sellerId, house?.propertyId ?? null, me).then((r) => {
            if (!r.ok || r.id == null) return toast(`${plan.name}: the deal didn’t open (${r.message ?? 'use the Deal sheet button'})`, 'error');
            open('d' + r.id);
          });
        }
      }

      // ---- Phase C: everything else, behind the advance.
      void (async () => {
        const failed: string[] = talkrFailed ? [talkrFailed] : [];
        const jobs: Promise<unknown>[] = [];
        // One entry per call: the outcome and the note on the call's own row
        // (lib/call-outcome-write), or one note when there was no Talkr call.
        const c = callId && sp.call?.id === callId ? sp.call : null;
        jobs.push(writeCallOutcome({
          workspaceId: wid, talkrCallId: callId, sellerId, outcome: plan.outcome.label,
          // Declined / No offer: the reason picked is part of what the call says.
          note: [plan.reason ? `Reason: ${plan.reason}` : null, notes || null].filter(Boolean).join('. ') || null,
          call: c ? { direction: c.direction, fromPhone: c.from_number, toPhone: c.to_number, occurredAt: c.answered_at ?? c.created_at ?? new Date().toISOString() } : null,
        }).then((r) => { if (!r.ok) failed.push(`outcome not saved (${r.message})`); }));
        const summ = phone.summary;
        if (plan.outcome.conversation && summ) {
          const field = (key: WrapKey) => (opts.facts?.[key] ?? summ[key] ?? '').trim() || null;
          jobs.push(applyCallFacts(sellerId, { motivation: field('motivation'), asking_price: parseMoney(field('price_expectation')), timeline: field('timeline') })
            .then((r) => { if (!r.ok) failed.push(`call facts not saved (${r.message})`); }));
        }
        const rec = text ? recipientOf(pid) : null;
        if (text && rec) {
          jobs.push(textMany(wid, [rec], text.body, textCtx).then(
            (res) => { if (res[0]?.error) failed.push(`text not sent (${res[0].error})`); },
            (e: Error) => { failed.push(`text not sent (${e.message})`); },
          ));
        }
        if (plan.compr && Number.isFinite(sellerId)) {
          jobs.push(runCompr(wid, sellerId).then((r) => { if (!r.ok) failed.push(`COMPR not started (${r.message})`); }));
        }
        if (plan.dropFromQueue) {
          const it = cq.items.find((x) => x.kind === 'seller' && x.recordId === sellerId);
          if (it) jobs.push(cq.remove(it.id));
        }
        await Promise.allSettled(jobs);
        if (failed.length) {
          toast(`${plan.name}: ${failed.join(', ')}.`, 'error');
          if (row) {
            const short = failed.map((f) => f.replace(/ \(.*$/, ''));
            set((st) => (st.todayDone[pid] ? { todayDone: { ...st.todayDone, [pid]: { ...st.todayDone[pid]!, failed: short } } } : {}));
          }
        }
        reload?.();
      })();
      return { ...ledger, saved: true };
    };

    type PlanOpts = {
      chip?: string | null; textOn?: boolean | null; pickAt?: string | null; notes?: string; facts?: Partial<Record<WrapKey, string>>; now: Date;
      reason?: string | null; enroll?: { id: string; name: string } | null;
    };
    /** Everything the picker needs about one seller, with the plan and the save bound to them. */
    const outcomeFor = (p: Person, mode: 'call' | 'log' | 'idle', house: OutcomeHouse | null = null) => {
      const row = todayRowOf(p.id);
      const e164 = toE164(p.phone);
      const zone = (e164 && zoneForNumber(e164)) || repZone;
      const summ = phoneEnabled ? phone.summary : null;
      const claim = !!row?.claim && !p.assigned;
      // Rung on one of their other numbers (a session walking them, or the record's Phones row).
      const ct = s.callTarget;
      const otherNumber = mode === 'call' && ct?.personId === p.id && ct.phoneId != null ? { id: ct.phoneId, label: ct.phone } : null;
      // Rung on their own phone in a session that has more of their numbers to try: how many are left after it.
      const runRow = mode === 'call' && s.queueRun && s.queueRun.at >= 0 ? s.queueRun.list[s.queueRun.at] : undefined;
      const moreNumbers = !otherNumber && runRow?.target.personId === p.id && runRow.of ? Math.max(0, runRow.of - (runRow.n ?? 1)) : 0;
      return {
        key: mode === 'call' ? `call:${s.callSeq}:${p.id}` : `${mode}:${p.id}`,
        pid: p.id, name: p.name, first: p.name.trim().split(/\s+/)[0] || p.name, stage: p.stage, mode, claim,
        plan: (k: OutcomeKey, o: PlanOpts) => {
          const aiTask = (o.facts?.suggested_task ?? summ?.suggested_task ?? '').trim();
          const aiFollow = (o.facts?.follow_up ?? summ?.follow_up ?? '').trim();
          return planOutcome(k, {
            person: p, vocab: todayVocab, task: row?.task ?? dueTaskOf(p.id), claim,
            now: o.now, zone, repZone, chip: o.chip, pickAt: o.pickAt, textOn: o.textOn,
            ai: summ ? { task: aiTask || null, followUp: aiFollow || null, followUpAt: aiFollow ? parseDue(aiFollow, o.now) : null } : null,
            dispositions: talkrList, hasCall: mode === 'call', notes: o.notes, reason: o.reason, enroll: o.enroll,
            recipient: e164 ? recipientOf(p.id) : null, send: sendCtx, hasMao: dealOf(p.id)?.mao != null,
            otherNumber, moreNumbers,
          });
        },
        save: (plan: OutcomePlan, o: OutcomeSaveOpts) => saveOutcome(plan, mode === 'call' ? 'call' : 'log', { ...o, house }),
      };
    };
    // How the offer went belongs once there is an offer to talk about: the
    // record is underwriting or has an offer out, or an offer is logged.
    const offerStage = stageGroup(P.stage, todayVocab) === 'offer' || !!P.offer;
    const recordOutcomeTarget = s.screen === 'person' && P.id && P0 !== BLANK_PERSON && offerStage
      ? outcomeFor(P, callState !== 'idle' && callPid === P.id ? 'call' : 'log', {
        subDealId: stageDeal?.id ?? null,
        dealId: focusDeal?.id ?? null,
        propertyId: P.property.propertyId ? Number(P.property.propertyId) : null,
      }) : null;
    const callSeller = callPid ? person(callPid) : undefined;
    /** The seller on the line, for the wrap-up: null for a buyer or an unknown number. */
    const outcomeTarget = callState !== 'idle' && callSeller ? outcomeFor(callSeller, 'call') : null;

    const todayP = todayPid ? person(todayPid) : undefined;
    const todayRow = todayRowOf(todayPid);
    const todayMode: 'call' | 'log' | 'idle' = callState !== 'idle' ? 'call' : s.logArmed && s.logArmed === todayPid ? 'log' : 'idle';
    const todayTarget = todayP && (todayMode !== 'call' || todayP.id === callPid) ? outcomeFor(todayP, todayMode) : null;
    const runNext = runUpNext;
    const todayFirst = todayP ? todayP.name.trim().split(/\s+/)[0] : '';
    const bar = todayP ? stageBarIndex(todayP.stage, todayVocab) : -1;
    const dealHere = todayP ? dealOf(todayP.id) : undefined;
    const lastOffer = dealHere?.contract != null ? fmt(dealHere.contract) : todayP?.offer ?? null;
    const factsHere = todayP ? ([
      ['Motivation', todayP.motivation], ['Timeline', todayP.timeline], ['Condition', todayP.condition],
      ['Occupancy', todayP.occupancy], ['Mortgage', todayP.mortgage], ['Asking', todayP.asking], ['Decides', todayP.decisionMakers],
    ] as [string, string][]).map(([k, v]) => ({ k, v: known(v) ? v : 'Ask', ask: !known(v) })) : [];
    const doneLine = (d: NonNullable<TodayRow['done']>) => d.label + (d.failed?.length ? ', ' + d.failed.join(', ') : '');
    const today = {
      rows: todayAll.map((r, i) => {
        const onCall = callState !== 'idle' && r.pid === callPid;
        return {
          ...r,
          groupStart: i === 0 || todayAll[i - 1]!.group !== r.group,
          groupLabel: TODAY_GROUPS.find((g) => g.id === r.group)!.label,
          current: r.pid === todayPid,
          tagText: r.done ? 'Done' : onCall ? (callState === 'wrap' ? 'Wrap-up' : 'On call') : r.tag,
          tone: r.done || onCall ? 'mint' : r.tagTone,
          line: r.done ? 'Done: ' + doneLine(r.done) : r.aiWhy || r.reason,
          // A logged row opens Log without calling on that seller, so a wrong
          // outcome can be put right with the one it should have been.
          pick: () => {
            if (!r.done) set({ todaySel: r.pid, logArmed: null });
            else if (callState === 'idle') set({ todaySel: r.pid, logArmed: r.pid });
          },
        };
      }),
      left: todayOpen.length,
      total: todayAll.length,
      /** Every row has an outcome: the queue is worked. */
      allDone: todayAll.length > 0 && todayOpen.length === 0,
      more: todayBase.more,
      /** Footer under the list: who put it in this order. */
      sourceLabel: todayBase.source === 'ai' ? 'Ranked by Clozr AI' : 'From your tasks, leads and deals',
      openMore: () => go('people', { peopleList: 'New Leads' }),
      results: todayAll.filter((r) => r.done).map((r) => ({ pid: r.pid, name: r.name, label: doneLine(r.done!) })),
      lead: todayP ? {
        pid: todayP.id, name: todayP.name, first: todayFirst, stage: todayP.stage,
        address: [todayP.property.addr, todayP.property.city, [todayP.property.st, todayP.property.zip].filter(Boolean).join(' ')].filter((x) => known(x)).join(', '),
        phone: todayP.phone, e164: toE164(todayP.phone) ?? '',
        last: known(todayP.lastComm) ? todayP.lastComm : 'No contact yet',
        segs: STAGE_BAR.map((label, i) => ({ label, state: i < bar ? 'done' : i === bar ? 'current' : 'future' })),
        stageAria: 'Stage progress: ' + (bar >= 0 ? STAGE_BAR[bar] : todayP.stage),
        why: todayRow && !todayRow.done ? todayRow.why : null,
        facts: factsHere,
        askCount: factsHere.filter((f) => f.ask).length,
        money: ([['Last offer', lastOffer], ['MAO', dealHere?.mao != null ? fmt(dealHere.mao) : null], ['ARV', dealHere?.arv != null ? fmt(dealHere.arv) : null]] as [string, string | null][])
          .filter((x): x is [string, string] => !!x[1] && x[1] !== '—').map(([k, v]) => ({ k, v })),
        open: () => openPerson(todayP.id),
        // Keep a Today power run alive when the rep taps Call on a row — killing
        // the session here is what desynced the list from the dialer.
        call: () => {
          dialRow({ name: todayP.name, phone: todayP.phone, personId: todayP.id }, todayRow?.claim);
        },
        text: () => set({ composerTab: 'Text', quickReach: { channel: 'text', personId: todayP.id } }),
      } : null,
      target: todayTarget,
      /** Once an offer is out, the SOP's offer outcomes sit under the eight. */
      offerOutcomes: todayP && stageGroup(todayP.stage, todayVocab) === 'offer' ? 'also' as const : undefined,
      /** Keys and Enter act: the call on this seller is in wrap-up, or Log without calling armed it. */
      armed: !!todayTarget && (todayMode === 'log' || (todayMode === 'call' && callState === 'wrap')),
      /** On the call: an outcome can be picked ahead, but nothing saves until hang-up. */
      live: !!todayTarget && todayMode === 'call' && callState === 'live',
      counter: todayPid && todayAll.some((r) => r.pid === todayPid) ? `Call ${todayAll.findIndex((r) => r.pid === todayPid) + 1} of ${todayAll.length}` : '',
      saveLabel: todayMode === 'log' ? `Log for ${todayFirst}`
        // Their next number or the next person, whichever the outcome turns out to mean.
        : s.queueRun ? (runNext ? (runNext.target.personId && runNext.target.personId === callPid ? 'Save and call next' : `Save and call ${runNext.target.name.trim().split(/\s+/)[0]}`) : 'Save and finish')
          : phone.session.session && phone.session.session.state !== 'paused' && advancesAfterSave(phone.session.campaign?.mode ?? phone.session.session.mode)
            ? 'Save and call next' : 'Save',
      logWithoutCall: () => (todayPid ? set({ logArmed: todayPid }) : undefined),
      cancelLog: () => set({ logArmed: null }),
      /** Power dial from the row in view, down the list. */
      powerCount: Math.max(0, todayOpen.length - Math.max(0, todayOpen.findIndex((r) => r.pid === todayPid))),
      powerDial: () => {
        const from = Math.max(0, todayOpen.findIndex((r) => r.pid === todayPid));
        startRun('Today', todayOpen.slice(from).map((r) => ({ target: r.target, claim: r.claim })), 'power');
      },
      /** The phone's Power dial: the whole list, from the top. */
      powerDialAll: () => startRun('Today', todayOpen.map((r) => ({ target: r.target, claim: r.claim })), 'power'),
      callAgain: () => (callSeller ? dialRow({ name: callSeller.name, phone: callSeller.phone, personId: callSeller.id }) : undefined),
      /** The call that is up is with someone Today can wrap up (a seller), or there is none. */
      ownsCall: callState === 'idle' || !!outcomeTarget,
      /** "Clozr for today" (app/components/today/ClozrForToday): a live workspace reads its own; the sample shows its first rows. */
      focus: {
        workspaceId: live && workspaceId != null ? workspaceId : null,
        first: ((me && D.team[me]?.name) || '').trim().split(/\s+/)[0] ?? '',
        busy: s.aiBusy,
        demo: live ? null : todayOpen.slice(0, 5).map((r) => ({
          id: r.pid, kind: r.group, title: r.name, why: r.why, tag: r.tag, tone: r.tagTone, record: null, open: () => openPerson(r.pid),
        })),
        open: (rec: { kind: 'seller' | 'deal'; id: number }) => {
          if (rec.kind === 'seller') return openPerson(`s${rec.id}`);
          const d = D.deals.find((x) => dbId(x.id) === rec.id);
          if (d) openDispo(d.personId, undefined, d.id); else toast('That deal is not in inventory any more.');
        },
        // Answered in the Ask CLOZR panel, with the list on screen as context.
        ask: (q: string, focus: AskFocusItem[]) => { set({ aiOpen: true }); askAi(q, { focus }); },
      },
    };

    // ---- DEALS ----
    // Live: one column per deal stage, one card per deal (a seller with no
    // deal is not on the pipeline). Demo: the sample graph keys deals on the
    // seller's stage, so columns are the seller stages and cards are people.
    const ownerOf = (d: Deal | undefined, p: Person) => repName(d?.owner || p.assigned);
    const demoRooms = [D.IMG.kitchen, D.IMG.bath, D.IMG.living, D.IMG.bed].filter((u): u is string => !!u);
    const houseOf = (p: Person, d?: Deal) => {
      const line = [d?.addr || p.property.addr, d?.addr ? (d.city ?? '') : p.property.city, p.property.st, p.property.zip].filter((x) => x && x !== '—').join(', ');
      // The record's own photo is its best deal's hero (lib/crm mapPerson). On a
      // seller with several houses that is one house, so the others never borrow it.
      const recordPhotos = !d || (dealCountByPerson.get(p.id) ?? 0) <= 1;
      // The front of the house first: the deal's cover / COMPR hero, then its gallery, then what the record carries.
      const stored = collectPhotos([
        d?.photoUrl,
        ...(d?.photos ?? []),
        d?.heroUrl,
        ...(live && d ? s.drivePhotos[String(dbId(d.id))] ?? [] : []),
        ...(recordPhotos ? [p.property.img, ...(p.property.photos ?? [])] : []),
      ]);
      // The sample graph stores one exterior. The other rooms on that house are the slideshow.
      const photos = !live && (stored[0] || p.property.img)
        ? demoGallery(stored[0] || p.property.img, demoRooms, p.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0))
        : stored;
      const street = placesKey && (d?.addr || p.property.addr) !== '—' ? streetViewImage(line, placesKey) : '';
      return { photos, img: photos[0] || street, street, streetOnly: photos.length === 0 && !!street, dealDbId: live && d ? dbId(d.id) : null };
    };
    const dealFilters = (d: Deal | undefined, p: Person) =>
      (s.gf.dealOwner === 'Any' || ownerOf(d, p) === s.gf.dealOwner || d?.tracker?.acqAgent === s.gf.dealOwner || d?.tracker?.dispoAgent === s.gf.dealOwner)
      && (s.gf.dealMarket === 'Any' || p.market === s.gf.dealMarket)
      && (s.gf.dealStatus === 'Any' || (d?.tracker?.contractStatus || dealStageOf(d, p)) === s.gf.dealStatus);
    // Archived deals show only in the Archived view, and only there.
    const dealPasses = (d: Deal | undefined, p: Person) => dealFilters(d, p) && (s.dealsArchived ? !!d?.archived : !d?.archived);
    const SELLER_COL = 'Seller · ';
    /**
     * A column someone added to the board: a seller stage (every deal whose
     * seller is there, one card per seller) or a deal stage off the pipeline
     * (Terminated, Realtor Referral). Asked for by name, so archived deals
     * show here too, marked as archived.
     */
    const extraCards = (stg: string): { p: Person; d: Deal | undefined }[] => {
      if (stg.startsWith(SELLER_COL)) {
        const label = stg.slice(SELLER_COL.length);
        const bySeller = new Map<string, Deal>();
        for (const d of deals) {
          const p = person(d.personId);
          if (!p || p.stage !== label || !dealFilters(d, p)) continue;
          const had = bySeller.get(p.id);
          // The real deal over its Prospect placeholder, then the newest.
          if (!had || (had.stage === 'Prospect' && d.stage !== 'Prospect') || (had.stage === d.stage && (d.createdAt ?? '') > (had.createdAt ?? ''))) bySeller.set(p.id, d);
        }
        return [...bySeller.values()].map((d) => ({ p: person(d.personId)!, d }));
      }
      return deals.filter((d) => d.stage === stg).flatMap((d) => { const p = person(d.personId); return p && dealFilters(d, p) ? [{ p, d }] : []; });
    };
    const pipelineCards = (stg: string): { p: Person; d: Deal | undefined }[] => live
      ? ((D.STAGES as string[]).includes(stg)
        ? deals.filter((d) => d.stage === stg).flatMap((d) => { const p = person(d.personId); return p && dealPasses(d, p) ? [{ p, d }] : []; })
        : extraCards(stg))
      : people.filter((p) => p.stage === stg).map((p) => ({ p, d: dealOf(p.id) }));
    /** The stages a deal can be moved to from a picker: the pipeline, then the two that end it. */
    const dealStageChoices = [...new Set([...(D.STAGES as string[]), 'Terminated', 'Realtor Referral'])];
    /**
     * Move one deal to a stage from anywhere (a board drop, a stage picker):
     * the same save as a drag. A read-only seat says so and nothing moves.
     * The toast names the deal's own house, not the seller's.
     */
    /** Resolves true when the move went ahead, false when it was refused or cancelled. */
    const moveDealStage = (d: Deal | undefined, stg: string): Promise<boolean> => {
      if (!d || d.stage === stg) return Promise.resolve(false);
      const addr = d.addr || person(d.personId)?.property.addr || 'Deal';
      if (!canWrite) { toast('Read-only · ' + addr + ' stays at ' + d.stage); return Promise.resolve(false); }
      return (async () => {
        // Back to Prospect takes it off the pipeline and Dispo. The seller's own stage is left as
        // it is (deals_stage_after only moves the seller for stages that imply one), so say so.
        if (stg === 'Prospect') {
          const ok = await confirm({
            title: `Move ${addr} back to Prospect?`,
            body: `It comes off the pipeline and Dispo. The seller's stage stays ${person(d.personId)?.stage || 'as it is'}; change it on their record if the contract is over.`,
            confirmLabel: 'Move to Prospect',
          });
          if (!ok) return false;
        }
        // Closed and Terminated end the deal (and send its outcome to Compr): ask first.
        if (ENDING_STAGES.has(stg)) {
          const ok = await confirm({
            title: stg === 'Closed' ? `Mark ${addr} closed?` : `Terminate ${addr}?`,
            body: stg === 'Closed'
              ? 'It leaves the pipeline as a closed deal, and what it did goes to Compr.'
              : 'It comes off the board and Dispo, and the outcome goes to Compr. Undo by moving it back.',
            confirmLabel: stg === 'Closed' ? 'Mark closed' : 'Terminate deal',
            tone: stg === 'Terminated' ? 'danger' : 'default',
          });
          if (!ok) return false;
        }
        // Ready To Market publishes to buyers: the SOP's checklist first, an override needs a reason.
        let note: string | null = null;
        if (stg === 'Ready To Market' && live) {
          const facts = await import('@/lib/deal-sheet').then(({ readyToMarketFacts }) => readyToMarketFacts(dbId(d.id))).catch(() => null);
          const missing = readyToMarketChecks(facts ?? { photos: 0, access: false, titleVendor: false, executedContract: false }).filter((c) => !c.ok);
          if (missing.length) {
            const why = await confirmReason({
              title: `${addr} isn't ready to market`,
              body: (facts ? 'Still missing: ' : 'Could not check the file. Not confirmed: ') + missing.map((c) => c.label.toLowerCase()).join('; ') + '. Publishing sends it to buyers now.',
              reasonLabel: 'Why publish it anyway',
              confirmLabel: 'Publish anyway',
              tone: 'danger',
            });
            if (!why) return false;
            note = 'Published without ' + missing.map((c) => c.label.toLowerCase()).join(', ') + '. Reason: ' + why;
          }
        }
        persistDealStage(d.id, stg, note);
        toast(addr + ' moved to ' + stg);
        return true;
      })();
    };
    /** What a card's search box matches: the same fields the table's search does. */
    const cardSearch = (p: Person, d: Deal | undefined) => [d?.addr || p.property.addr, d?.addr ? d.city ?? '' : p.property.city, p.name, d?.tracker?.acqAgent, d?.tracker?.dispoAgent, d?.tracker?.leadSource, d?.structure || d?.tracker?.transactionType].join(' ').toLowerCase();
    /** One board card. Built only for cards on screen: the Prospect column pages through its thousands. */
    const dealCard = (stg: string, p: Person, d: Deal | undefined) => {
      const ownerId = d?.owner || p.assigned;
      const house = houseOf(p, d);
      return {
        id: p.id, dealId: d?.id ?? '', archived: !!d?.archived, addr: d?.addr || p.property.addr, city: d?.addr ? d.city ?? '' : p.property.city, seller: p.name,
        img: house.img, street: house.street, photos: house.photos, streetOnly: house.streetOnly, dealDbId: house.dealDbId,
        rep: repName(ownerId), repInit: repInit(ownerId),
        price: d?.contract ? fmt(d.contract) : (p.offer || '—'),
        // The same fields the table's search box matches (agents, lead source), so one search means one thing.
        dealType: d ? (d.structure || dealTypeLabel(d.tracker?.transactionType)) : '',
        search: cardSearch(p, d),
        arv: d?.arv ? fmt(d.arv) : '—', profit: d?.profit ? fmt(d.profit) : '—',
        // Raw figures for the board's running total (Deals.tsx sums what is on screen).
        feeRaw: d?.profit ?? 0, contractRaw: d?.contract ?? 0, inPipeline: !PIPELINE_DONE.has(stg) && (D.STAGES as string[]).includes(stg),
        amended: amendedLabel(d),
        days: (d?.daysInStage ?? 0) + 'd', next: p.nextTask, health: healthColor(d?.health || 'good'),
        optionSeller: d?.optionEndsOn ?? null, optionBuyer: d?.buyerOptionEndsOn ?? null,
        // The close bar on every card (lib/close-date.ts): scheduled and actual close.
        closeBadge: d ? closeBadge({ scheduled: d.tracker?.scheduledClose, closedOn: d.tracker?.closedOn, stage: stg }) : null,
        closeSort: closeSortKey(d?.tracker?.scheduledClose),
        // A Friday close on a live deal: the SOP says Monday to Thursday.
        fridayClose: !!d && !PIPELINE_DONE.has(stg) && isFridayIso(d.tracker?.scheduledClose),
        // The card's own stage picker: the same move as a drag, by click or keyboard.
        setStage: live && d && !d.archived ? (next: string) => { void moveDealStage(d, next); } : null,
        addedAt: d?.createdAt || '', added: d?.createdAt ? addedOn(d.createdAt) : '—',
        // A live deal from contract onward with no title company on its team.
        noTitle: live && !!d && d.hasTitle === false && /under contract|escrow|ready to market/i.test(stg),
        phone: p.phone || '', email: p.email || '',
        open: () => openPersonDeal(p.id, d?.id),
        openSheet: (e?: { stopPropagation?: () => void }) => {
          if (e && e.stopPropagation) e.stopPropagation();
          go('dealSheet', { personId: p.id, dealSheetDealId: d?.id ?? null });
        },
        openTc: (e?: { stopPropagation?: () => void }) => {
          if (e && e.stopPropagation) e.stopPropagation();
          openTc(p.id, d?.id);
        },
        dragStart: (e: React.DragEvent) => {
          set({ dragging: live && d ? d.id : p.id });
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        },
        // A drag dropped outside every column (or cancelled with Esc) never reaches drop.
        dragEnd: () => set({ dragging: null }),
        dragId: live && d ? d.id : p.id,
      };
    };
    const PROSPECT = 'Prospect';
    // Live: Prospect first (a lead's deal sheet, thousands of them, paged), then the pipeline, then any added columns.
    const dealsCols = lazy(() => [...(live ? [PROSPECT] : []), ...(D.STAGES as string[]), ...(live ? s.dealExtraStages : [])].map((stg) => {
      const pairs = stg === PROSPECT
        ? deals.filter((d) => d.stage === PROSPECT).flatMap((d) => { const p = person(d.personId); return p && dealPasses(d, p) ? [{ p, d }] : []; })
          .sort((a, b) => (b.d.createdAt ?? '').localeCompare(a.d.createdAt ?? ''))
        : pipelineCards(stg);
      const paged = stg === PROSPECT;
      const cards = paged ? [] : pairs.map(({ p, d }) => dealCard(stg, p, d));
      // Search, then build only the page asked for.
      // Search keys built once per load, not on every keystroke.
      const keys = paged ? pairs.map(({ p, d }) => cardSearch(p, d)) : [];
      const page = paged ? (needle: string, limit: number) => {
        const hits = needle ? pairs.filter((_, i) => keys[i].includes(needle)) : pairs;
        return { total: hits.length, cards: hits.slice(0, limit).map(({ p, d }) => dealCard(stg, p, d)) };
      } : undefined;
      const totalRaw = pairs.reduce((a, { d }) => a + (d?.contract || 0), 0);
      const sellerCol = stg.startsWith(SELLER_COL) ? stg.slice(SELLER_COL.length) : null;
      return {
        stage: stg, count: pairs.length, color: sellerCol ? sellerStageColor(sellerCol) : stageColor(stg), cards, page,
        total: totalRaw ? kFmt(totalRaw) : '',
        over: (e: React.DragEvent) => e.preventDefault(),
        drop: (e: React.DragEvent) => {
          e.preventDefault();
          const id = s.dragging;
          if (!id) return;
          if (live) {
            const d = deals.find((x) => x.id === id);
            set({ dragging: null });
            if (sellerCol) {
              // Into a seller-stage column: the seller moves to that stage (the database follows with the deal).
              if (!d || person(d.personId)?.stage === sellerCol) return;
              const addr = d.addr || person(d.personId)?.property.addr || 'Seller';
              if (!canWrite) return toast('Read-only · ' + addr + ' stays where it is');
              persistStage(d.personId, sellerCol);
              toast(addr + ' → ' + sellerCol);
              return;
            }
            void moveDealStage(d, stg);
            return;
          }
          set((st) => ({ stageOverrides: { ...st.stageOverrides, [id]: stg }, dragging: null }));
          persistStage(id, stg);
          toast((person(id)?.property.addr ?? 'Deal') + ' → ' + stg);
        },
      };
    }));
    // Live: every real deal (a Prospect is a lead's underwriting holder, not a
    // contract). Demo: the sample people that carry a deal.
    const dealRows = lazy(() => {
    const dealPairs: { p: Person; d: Deal }[] = live
      ? deals.filter((d) => d.stage !== 'Prospect').flatMap((d) => { const p = person(d.personId); return p ? [{ p, d }] : []; })
      : people.flatMap((p) => { const d = dealOf(p.id); return d?.arv ? [{ p, d }] : []; });
    const day = (iso: string | null | undefined) => (iso ? TRACKER_DAY.format(new Date(iso.slice(0, 10) + 'T12:00:00')) : '—');
    const money0 = (n: number | null | undefined) => (n == null ? '—' : fmt(n));
    return dealPairs
      .filter(({ p, d }) => dealPasses(d, p))
      .sort((x, y) => (y.d.tracker?.contractDate ?? '').localeCompare(x.d.tracker?.contractDate ?? '') || ((y.d.tracker?.no ?? 0) - (x.d.tracker?.no ?? 0)))
      .map(({ p, d }) => {
      const T = d.tracker;
      // Contract status is the stage; tracker text is only a fallback for old rows.
      const status = dealStageOf(d, p) || T?.contractStatus || '';
      const sheet = trackerSheet({
        contractDate: T?.contractDate, scheduledClose: T?.scheduledClose, closedOn: T?.closedOn,
        sellerPrice: T ? T.sellerPrice : d.contract, priceDrop: T?.priceDrop, marketedPrice: T?.marketedPrice,
        dispoPrice: T?.dispoPrice, dispoFee: T?.dispoFee, transactionType: d.structure || T?.transactionType, contractStatus: status,
      });
      const house = houseOf(p, d);
      return {
        dealId: d.id, archived: !!d.archived, archivedReason: d.archivedReason ?? null,
        addr: d.addr || p.property.addr, seller: p.name, stage: dealStageOf(d, p), stageColor: stageColor(dealStageOf(d, p)),
        // The row's stage picker: the same save as a drag on the board, which a phone and the table cannot do.
        setStage: live && !d.archived ? (stg: string) => { void moveDealStage(d, stg); } : null,
        addedAt: d.createdAt || '', added: d.createdAt ? addedOn(d.createdAt) : '—', contractAt: T?.contractDate || '',
        img: house.img, street: house.street, photos: house.photos, streetOnly: house.streetOnly, dealDbId: house.dealDbId,
        dealType: d.structure || dealTypeLabel(T?.transactionType),
        search: [d.addr || p.property.addr, d.addr ? d.city : p.property.city, p.name, T?.acqAgent, T?.dispoAgent, T?.leadSource, T?.no, d.structure || T?.transactionType].join(' ').toLowerCase(),
        amended: amendedLabel(d),
        // The Deal Tracker's Deals tab, column for column (DEAL_COL_LABELS).
        cells: [
          T?.no != null ? 'Property ' + T.no : '—', day(T?.contractDate), day(T?.scheduledClose), sheet.daysToClose == null ? '—' : String(sheet.daysToClose),
          d.addr || p.property.addr, money0(T ? T.sellerPrice : d.contract), money0(T?.priceDrop), money0(T?.marketedPrice), money0(T?.marketedFee),
          money0(T?.dispoPrice), money0(T?.dispoUpsell), money0(T?.dispoFee),
          T?.acqAgent || ownerOf(d, p), T?.dispoAgent || '—', (d.structure || dealTypeLabel(T?.transactionType)) || '—', day(T?.closedOn),
          T?.leadManager || '—', T?.coordinator || '—', status, T?.leadSource || p.source || '—',
          // Beyond the tracker: off by default, on from the Columns menu.
          p.name, p.phone || '—', p.email || '—', (d.addr ? d.city : p.property.city) || '—', money0(d.arv), d.daysInStage + 'd',
          optionReadouts(d.optionEndsOn, null)[0]?.label ?? '—',
          optionReadouts(null, d.buyerOptionEndsOn)[0]?.label ?? '—',
          d.createdAt ? addedOn(d.createdAt) : '—',
          sheet.closingMonth ?? '—', sheet.schedMo ?? '—', money0(sheet.bookedSpread), sheet.closeMo ?? '—', sheet.writtenMo ?? '—', sheet.weekSort ? day(sheet.weekSort) : '—',
        ],
        optionSeller: d.optionEndsOn ?? null, optionBuyer: d.buyerOptionEndsOn ?? null,
        owner: repName(d.owner || p.assigned), source: p.source,
        contract: d.contract ? fmt(d.contract) : '—', arv: fmt(d.arv),
        assignment: d.assignment ? fmt(d.assignment) : '—', profit: d.profit ? fmt(d.profit) : '—',
        feeRaw: d.profit ?? 0, contractRaw: d.contract ?? 0, inPipeline: !PIPELINE_DONE.has(dealStageOf(d, p)),
        close: d.close || '—', days: d.daysInStage, health: d.health, healthColor: healthColor(d.health),
        closeBadge: closeBadge({ scheduled: d.tracker?.scheduledClose, closedOn: d.tracker?.closedOn, stage: dealStageOf(d, p) }),
        closeSort: closeSortKey(d.tracker?.scheduledClose),
        open: () => openPersonDeal(p.id, d.id),
        // The deal's seller as a bulk RVM recipient (Deals → RVM sellers), the drop filed on this deal.
        rvmSeller: live ? {
          id: p.id, dbId: dbId(p.id), name: p.name, phone: p.phone === '—' ? '' : p.phone,
          dnc: hasDnc(p.tags), blacklisted: isBlacklisted(p), dealId: dbId(d.id),
          fields: { address: d.addr || p.property.addr, city: (d.addr ? d.city : p.property.city) || '', state: p.property.st || '', zip: p.property.zip || '' },
        } : null,
        // A deal with a transaction file gets a one-click route into its TC
        // section, for a role that can open TC.
        hasTc: can.tc,
        openTc: (e?: { stopPropagation?: () => void }) => {
          if (e && e.stopPropagation) e.stopPropagation();
          openTc(p.id, d.id);
        },
        openSheet: (e?: { stopPropagation?: () => void }) => {
          if (e && e.stopPropagation) e.stopPropagation();
          go('dealSheet', { personId: p.id, dealSheetDealId: d.id });
        },
      };
    });
    });
    // Only the files still being worked: a closed or terminated deal's file is history.
    const tcOpenFiles = openTcFiles(D.transactions, (id) => dealById.get(id));
    const tcOpenCount = tcOpenFiles.length;
    // The board's stage order, with every deal in that stage. Empty stages
    // drop out so up and down land on a file, not a blank column.
    // Live, a column holds deals, not sellers: a wholesaler with three files in
    // three stages is three stops, and the position names the deal on screen.
    const tcColumns = (D.STAGES as string[]).map((stg) => ({
      stage: stg,
      ids: [...new Set(live
        ? deals.filter((d) => d.stage === stg && d.personId && !d.archived).map((d) => d.id)
        : people.filter((p) => p.stage === stg && dealOf(p.id)).map((p) => p.id))],
    }));
    /**
     * "go tc" with no file open, and the TC screen's empty state: the first
     * file furthest along (In Escrow, then Buyer Under Contract…), where the
     * arrows then walk every file. With nothing under contract, Deals says so.
     */
    const openTcList = () => {
      const order = live ? ['In Escrow', 'Buyer Under Contract', 'Ready To Market', 'Under Contract Seller'] : [...tcColumns.map((c) => c.stage)].reverse();
      for (const stage of order) {
        const id = tcColumns.find((c) => c.stage === stage)?.ids[0];
        if (!id) continue;
        if (!live) return openTc(id);
        const d = dealById.get(id);
        if (d?.personId) return openTc(d.personId, d.id);
      }
      toast('No deal is under contract yet. The closing files open from here once one is');
      go('deals');
    };
    const tcCurrent = live ? (TD.id ?? '') : TP.id;
    const tcHere = tcPlace(tcColumns, tcCurrent);
    const dealsViews = (['pipeline', 'table'] as const).map((v) => ({
      label: v === 'pipeline' ? 'Pipeline' : 'Table', go: () => set({ dealsView: v }),
      bg: s.dealsView === v ? '#fff' : 'transparent',
      color: s.dealsView === v ? '#18181b' : '#71717a',
      shadow: s.dealsView === v ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
    }));

    // ---- DISPO ----
    // Inventory is every deal in an active stage (Under Contract Seller,
    // Ready To Market, Buyer Under Contract, In Escrow), one row per deal.
    // A seller with two contracts used to collapse to one row, and that row
    // showed the seller's other address, so a house under contract on Deals
    // (Meadow Lane on a contact who also owns something else) never appeared
    // here. The demo follows the seller stage the Deals board just wrote,
    // instead of a fixed list of four sample houses.
    const dealMatches = (dealId: string) => D.matches.filter((m) => m.dealId === dealId);
    const onDispo = (d: Deal) => {
      const p = person(d.personId);
      // Closed, Terminated and Memo Filed / Legal drop off every Dispo list and count; so does an archived deal.
      if (d.archived) return false;
      if (live) return onDispoBoard(d.stage || '', p?.stage, d.leadStage, d.tracker?.contractStatus);
      return !!p && underContract(p.stage, false) && !offDispo(p.stage);
    };
    const dispoStage = (d: Deal) => (live ? d.stage || '' : person(d.personId)?.stage || '');
    const readyStage = (stg: string) => (live ? stg === 'Ready To Market' : stg === 'Dispo');
    const assignStage = (stg: string) => (live ? stg === 'Buyer Under Contract' || stg === 'In Escrow' : stg === 'Assigned' || stg === 'Closing');
    const dispoPool = (live ? deals : people.flatMap((p) => { const d = dealOf(p.id); return d ? [d] : []; })).filter(onDispo);
    const chipOf = (d: Deal, chip: string) => {
      const stg = dispoStage(d);
      if (chip === 'Ready to Market') return readyStage(stg);
      if (chip === 'Assignments') return assignStage(stg);
      if (chip === 'At Risk') return d.health !== 'good' || optionAtRisk(d.optionEndsOn, d.buyerOptionEndsOn);
      if (chip === 'Buyer Responses') return dealMatches(d.id).some((m) => m.replied);
      if (chip === 'Offers') return D.offers.some((o) => o.dealId === d.id);
      if (chip === 'Walkthroughs') return D.walkthroughs.some((w) => w.personId === d.personId);
      return true;
    };
    const poolDeals = new Set<string | null | undefined>(dispoPool.map((d) => d.id));
    const poolPeople = new Set<string | null | undefined>(dispoPool.map((d) => d.personId));
    const dispoCounts: [string, number][] = [
      ['Active Inventory', dispoPool.length],
      ['Ready to Market', dispoPool.filter((d) => readyStage(dispoStage(d))).length],
      ['Buyer Responses', live ? D.matches.filter((m) => m.replied && poolDeals.has(m.dealId)).length : dispoPool.filter((d) => chipOf(d, 'Buyer Responses')).length],
      ['Offers', live ? D.offers.filter((o) => o.buyerId && poolDeals.has(o.dealId)).length : dispoPool.filter((d) => chipOf(d, 'Offers')).length],
      ['Walkthroughs', live ? D.walkthroughs.filter((w) => poolPeople.has(w.personId)).length : dispoPool.filter((d) => chipOf(d, 'Walkthroughs')).length],
      ['Assignments', dispoPool.filter((d) => assignStage(dispoStage(d))).length],
      ['At Risk', dispoPool.filter((d) => d.health !== 'good' || optionAtRisk(d.optionEndsOn, d.buyerOptionEndsOn)).length],
    ];
    const dispoFilters = dispoCounts.map(([label, count]) => ({
      label, count, go: () => set({ dispoFilter: label }),
      bg: s.dispoFilter === label ? '#E7F8F1' : 'transparent',
      color: s.dispoFilter === label ? '#0A8560' : '#27272a',
    }));
    const inventory = dispoPool
      .filter((d) => chipOf(d, s.dispoFilter))
      .filter((d) => {
        const p = person(d.personId);
        if (!p) return false;
        if (s.gf.dispoMarket !== 'Any' && p.market !== s.gf.dispoMarket) return false;
        if (s.gf.dispoRep !== 'Any' && repName(d.owner || p.assigned) !== s.gf.dispoRep) return false;
        return true;
      })
      .map((d, i) => {
      const p = person(d.personId)!;
      // Dispo's spread is the fee between the seller contract and the buyer
      // price, not the buyer's margin: ARV minus contract minus rehab went
      // negative on every inventory deal without an ARV (10 of 13 live ones).
      const marketed = d.tracker?.marketedPrice;
      const spread = d.assignment ?? (marketed != null && d.contract != null ? marketed - d.contract : null);
      const ms = live ? dealMatches(d.id) : [];
      const stg = dealStageOf(d, p);
      const demoN = i % 4;
      // SOP step 9: unsold after 6 days on market goes to the MLS. A sold
      // deal (a buyer on it, past Ready To Market) is never flagged.
      const timing = marketTiming(live ? d.facts?.marketingStarted ?? null : ['2026-10-03', '2026-10-07', null, '2026-09-28'][demoN], { sold: !!d.buyerId || !/ready to market|under contract seller/i.test(stg) });
      return {
        dom: timing.dom, mlsDue: timing.mlsDue,
        addr: d.addr || p.property.addr, city: d.addr ? (d.city || p.property.city) : p.property.city, market: p.market,
        contract: fmt(d.contract), arv: fmt(d.arv), spread: spread == null ? '—' : fmt(spread),
        spreadPct: spread == null || !d.contract ? '' : Math.round((spread / d.contract) * 100) + '% of contract',
        matches: live ? ms.length : [243, 118, 96, 0][demoN],
        campaign: live ? (ms.some((m) => m.sent) ? `Sent · ${ms.filter((m) => m.sent).length} buyers` : ms.length ? 'Matched · not sent' : '—') : ['Live · 3 channels', 'Live · SMS', 'Draft', '—'][demoN],
        // This deal's offers, not every offer in the workspace.
        offers: live ? D.offers.filter((o) => o.dealId === d.id).length : [4, 2, 0, 0][demoN],
        best: live ? (D.offers.some((o) => o.dealId === d.id) ? fmt(Math.max(...D.offers.filter((o) => o.dealId === d.id).map((o) => o.offer))) : '—') : ['$241,000', '$222,500', '—', '—'][demoN],
        daysLeft: live
          ? (optionReadouts(d.optionEndsOn, d.buyerOptionEndsOn).map((r) => `${r.side === 'seller' ? 'Seller' : 'Buyer'} ${r.days < 0 ? 'expired' : r.days === 0 ? 'today' : r.days + 'd'}`).join(' · ') || '—')
          : ([18, 14, 8, '—'] as (number | string)[])[demoN],
        optionSeller: d.optionEndsOn ?? null, optionBuyer: d.buyerOptionEndsOn ?? null,
        rep: repName(d.owner || p.assigned),
        status: stg,
        statusColor: stageColor(stg),
        open: () => openDispo(p.id, undefined, d.id),
        genius: () => openGenius(p.id, d.id),
      };
    });
    const dispoTabNames = ['Overview', 'Matches', 'Genius', 'Marketing', 'Activity', 'Communications', 'Offers', 'Walkthroughs', 'Files', 'Assignment'];
    const dispoTabs = dispoTabNames.map((t) => ({
      label: t, go: () => set({ dispoTab: t }),
      color: s.dispoTab === t ? '#18181b' : '#71717a',
      border: s.dispoTab === t ? '#18181b' : 'transparent',
    }));
    const dispoHead = ([
      ['Contract', fmt(dd.contract)], ['ARV', fmt(dd.arv)], ['Rehab', fmt(dd.rehab)],
      ['Target assignment', fmt((DD as Partial<Deal>).targetAssignment ?? dd.assignment)],
      ...((DD as Partial<Deal>).amended ? [['Last amended', amendedLabel(DD as Deal)]] : []),
      // The minimum and the countdown are sample figures; a live deal shows its close date.
      ...(live ? [['Closing', (DD as { close?: string | null }).close || '—']] : [['Minimum assignment', '$15,000'], ['Closing', '18 days']]),
    ] as [string, string][]).map(([k, v]) => ({ k, v }));
    const mq = s.matchQ.toLowerCase();
    const ddId = (DD as { id?: string }).id ?? '';
    // Live: the buyers the database scored for this deal, best first. Demo:
    // every sample buyer by its sample match number.
    const scored = live
      ? dealMatches(ddId).flatMap((m) => { const b = buyer(m.buyerId); return b ? [{ b, m }] : []; })
      : buyers.map((b) => ({ b, m: null as null | { score: number; reasons: string[]; status: string } }));
    const matches = scored
      .filter(({ b }) => !mq || (b.company + ' ' + b.name + ' ' + b.markets.join(' ')).toLowerCase().includes(mq))
      .map(({ b, m }) => ({ b, score: m ? m.score : b.match, why: m ? m.reasons : b.why, mstatus: m?.status ?? '' }))
      .sort((a, b) => b.score - a.score)
      .filter(({ b, score, mstatus }) => MATCH_CHIPS.every((c) => !s.matchFilterOn[c.label] || c.pass({ score, status: b.status, mstatus })))
      .map(({ b, score, why, mstatus }) => ({
        id: b.id, company: b.company, name: b.name, initials: b.initials, match: score,
        matchColor: score >= 90 ? '#0A8560' : score >= 80 ? '#b45309' : '#71717a',
        markets: b.markets.join(' · '), ceiling: b.ceiling, type: b.buyBox.type, rehabTol: b.rehabTol,
        strategy: b.strategy, lastPurchase: b.lastPurchase, lastActivity: b.lastActivity,
        engagement: b.responseKnown === false ? '—' : b.engagement + '%', engPct: b.responseKnown === false ? '0%' : b.engagement + '%',
        engColor: responseTone(b.responseKnown === false ? null : b.engagement, !!b.tireKicker).stroke, offers: b.offers, pref: b.pref,
        vip: b.status, vipColor: buyerStatusTone(b.status).fg,
        why: why.map((w) => ({ w })), issue: mstatus === 'not_interested' ? 'Passed on this deal' : b.issue,
        open: () => openBuyer(b.id),
        call: () => startCall({ name: b.name + ' · ' + b.company, phone: b.phone, buyerId: b.id }),
        text: () => openReach('text', { name: b.name, phone: b.phone, email: b.email, buyerId: dbId(b.id), audience: 'buyer' }),
        email: () => openReach('email', { name: b.name, phone: b.phone, email: b.email, buyerId: dbId(b.id), audience: 'buyer' }),
        phone: b.phone === '—' ? '' : b.phone,
        dbId: dbId(b.id),
        dnc: hasDnc(b.tags) || !!b.blacklisted || b.status === 'Blacklisted',
        inactive: b.status === 'Inactive',
        add: () => {
          if (!live || !ddId) return toast('Campaigns run on a signed-in workspace.');
          prefillCampaign(dbId(ddId), [dbId(b.id)]);
          toast((b.company || b.name) + ' added to the campaign builder');
        },
      }));
    const runMatching = () => {
      if (!canWrite || !ddId) return toast('Matching runs on a signed-in workspace.');
      void matchDealWrite(dbId(ddId)).then((r) => {
        if (!r.ok) return toast(r.message || 'Could not run matching.', 'error');
        reload?.();
        toast(`${r.count ?? 0} buyer${r.count === 1 ? '' : 's'} matched`, 'success');
      });
    };
    const matchFilters = MATCH_CHIPS.map((c) => ({
      label: c.label, on: !!s.matchFilterOn[c.label],
      go: () => set((st) => ({ matchFilterOn: { ...st.matchFilterOn, [c.label]: !st.matchFilterOn[c.label] } })),
    }));
    // Live: this deal's own match rows and offers. The demo keeps its sample funnel.
    const ddMatches = live ? dealMatches(ddId) : [];
    const dealOffers = (live ? D.offers.filter((o) => o.dealId === ddId) : D.offers).filter((o) => buyer(o.buyerId));
    const campaignMetricsRaw: [string, number][] = live
      ? [
        ['Matched', ddMatches.length], ['Sent', ddMatches.filter((m) => m.sent).length],
        ['Viewed', ddMatches.filter((m) => m.viewed).length], ['Replied', ddMatches.filter((m) => m.replied).length],
        ['Offers', dealOffers.length],
      ]
      : [
        ['Sent', 243], ['Delivered', 236], ['Opened', 148], ['Clicked', 67],
        ['Replied', 21], ['Interested', 14], ['Walkthrough', 3], ['Offer', 4],
      ];
    const campaignMetrics = campaignMetricsRaw.map(([k, v]) => ({
      k, v, pct: campaignMetricsRaw[0][1] ? Math.round((v / campaignMetricsRaw[0][1]) * 100) + '%' : '—',
    }));
    const engagementFeed = live
      ? ddMatches.flatMap((m) => {
        const who = buyer(m.buyerId)?.company ?? 'A buyer';
        return ([[m.replied, who + ' replied'], [m.viewed, who + ' viewed the deal'], [m.sent, 'Sent to ' + who]] as [string | null, string][])
          .filter((e): e is [string, string] => !!e[0]);
      }).map(([t, text]) => ({ t, text }))
      : D.engagementFeed.map(([t, text]) => ({ t, text }));
    // The picked offer. Live, until someone picks one here, it is the offer
    // this deal already accepted, so the desk opens on what the database says.
    const pickedOffer = !live || (s.acceptedOffer && dealOffers.some((o) => o.id === s.acceptedOffer))
      ? s.acceptedOffer
      : dealOffers.find((o) => /accept/i.test(o.terms))?.id ?? null;
    const offerRows = dealOffers.map((o) => {
      const b = buyer(o.buyerId) ?? BLANK_BUYER;
      const assignment = o.offer - (dd.contract || 0);
      return {
        id: o.id, buyer: b.company, contact: b.name, initials: b.initials,
        // Net assumed $2,500 of closing costs and EMD was always zero on a live row; neither is known.
        offer: fmt(o.offer), assignment: fmt(assignment), net: live ? '—' : fmt(assignment - 2500), emd: o.emd ? fmt(o.emd) : '—',
        inspection: o.inspection, closing: o.closing, financing: o.financing, pof: o.pof,
        pofColor: o.pof === 'Verified' ? '#0A8560' : o.pof === '—' ? '#71717a' : '#b45309', terms: o.terms, confidence: o.confidence,
        confColor: o.confidence >= 85 ? '#0A8560' : o.confidence >= 70 ? '#b45309' : '#b91c1c',
        flags: o.flags.map((f) => ({
          f,
          color: ({
            'Highest offer': '#16a34a', 'Best net': '#15803d',
            'Fastest close': '#d97706', 'Strongest terms': '#18181b',
          } as Record<string, string>)[f],
        })),
        hasFlags: o.flags.length > 0, selected: pickedOffer === o.id,
        rowBg: pickedOffer === o.id ? '#E7F8F1' : '#fff',
        select: () => set({ acceptedOffer: o.id }),
        open: () => openBuyer(b.id),
      };
    });
    const acceptedOffer = offerRows.find((o) => o.selected) || null;
    // Who can make an offer or book a walkthrough from the dispo screen: the
    // buyers matched to this deal and any who already offered on it. A deal
    // nobody has been matched to yet falls back to every buyer.
    const dealBuyerList = [...scored.map(({ b }) => b), ...dealOffers.flatMap((o) => { const b = buyer(o.buyerId); return b ? [b] : []; })];
    const dispoBuyerChoices = lazy(() => Array.from(new Map((dealBuyerList.length ? dealBuyerList : buyers).map((b) => [b.id, b])).values())
      .map((b) => ({ id: b.id, label: b.company && b.company !== b.name ? `${b.company} · ${b.name}` : b.name || b.company })));
    // The Offer desk (components/dispo/OfferDesk) logs, approves, accepts and
    // marks sold itself; it needs each buyer's name and whether they are
    // vetted and VIP, by database id, and the same choices with database ids.
    const dispoDeskBuyerChoices = lazy(() => dispoBuyerChoices().map((c) => ({ id: String(dbId(c.id)), label: c.label })));
    const deskBuyerOf = (id: number) => {
      const b = buyer('b' + id);
      return b ? { name: b.name, company: b.company, verified: !!b.vetted || b.status === 'Vetted' || b.status === 'VIP', vip: !!b.vip || b.status === 'VIP' } : null;
    };
    /**
     * A walkthrough booked from the dispo screen: an appointment of kind
     * Walkthrough naming this deal's seller and the buyer, which is what the
     * Walkthroughs tab reads back. `day` is a date input (YYYY-MM-DD) and
     * `time` a time input (HH:MM, 24h).
     */
    const scheduleWalkthrough = async (f: { buyerId: string; day: string; time: string }): Promise<boolean> => {
      if (!canWrite) { toast(readOnly ? READ_ONLY_MESSAGE : 'Scheduling walkthroughs runs on a signed-in workspace.'); return false; }
      const [y, mo, d] = f.day.split('-').map(Number);
      if (!f.buyerId || !y || !mo || !d) { toast('Pick a buyer and a day.'); return false; }
      const b = buyer(f.buyerId);
      // The appointment writer reads free text: a spelled-out day (so it stays
      // the local date, not UTC midnight) and a 12-hour time.
      const [hh, mm] = (f.time || '09:00').split(':').map(Number);
      const r = await saveAdd(workspaceId, 'appointment', {
        title: `Walkthrough · ${b?.company || b?.name || 'Buyer'} · ${DP.property.addr}`,
        day: new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: `${(hh % 12) || 12}:${String(mm || 0).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`,
        type: 'Walkthrough', personId: DP.id, buyerId: f.buyerId, propertyId: (DD as Partial<Deal>).propertyId ?? '',
      }, me);
      if (!r.ok) { toast(r.message || 'Could not schedule the walkthrough.'); return false; }
      reload?.();
      toast('Walkthrough scheduled · it is on the calendar');
      return true;
    };
    const walkRows = D.walkthroughs
      .map((w) => ({ w, b: buyer(w.buyerId), p: person(w.personId) }))
      .filter((x): x is { w: (typeof D.walkthroughs)[number]; b: Buyer; p: Person } => !!x.b && !!x.p)
      .map(({ w, b, p }) => {
      return {
        buyer: b.company, contact: b.name, addr: p.property.addr, date: w.date, time: w.time, status: w.status,
        color: ({ Requested: '#b45309', Confirmed: '#0A8560', Scheduled: '#0A8560', Completed: '#71717a', 'No Show': '#b91c1c' } as Record<string, string>)[w.status],
        confirm: () => toast(live ? 'Confirming a walkthrough is not connected yet — nothing was sent.' : b.company + ' confirmed'),
      };
    });
    // The sample feed is the demo's; a live deal shows nothing rather than invented events.
    const dispoActivity = ((live ? [] : [
      ['10:40 AM', 'Northline Homes submitted $241,000 offer', 'Offer'],
      ['10:02 AM', 'Harbor Capital submitted $238,500 offer', 'Offer'],
      ['9:47 AM', 'Harbor Capital requested walkthrough · Fri 2:30 PM', 'Walkthrough'],
      ['9:40 AM', 'Morgan Lane launched campaign · 243 buyers · SMS + Email + Portal', 'Campaign'],
      ['Yesterday', 'Avery Nguyen uploaded 19 photos · auto-sorted into 8 groups', 'Media'],
      ['Aug 27', 'Purchase contract executed · $214,000 · Diego Ortiz', 'Contract'],
    ]) as [string, string, string][]).map(([t, text, kind]) => ({ t, text, kind }));

    // ---- BUYERS ----
    const { marketGaz, NO_STATE, unplacedBuyers, stateOptions, stateCodeOf, cityOptions, buyerPipelineMenu, buyerRows } = buyerView;
    // Free-agent realtors are not in `buyers` (that load times out). This page
    // is the Realtors list: search already happened on the server.
    const realtorTableRows = realtorPage.rows.map((b) => {
      const places = resolveMarkets(b.markets, marketGaz);
      const entity = entityKind(b.name, b.company, b.entityType);
      return {
        id: b.id, company: b.company, name: b.name, initials: b.initials, status: b.status, stage: '',
        // Corpus rows: nobody owns a realtor until they are worked.
        assigned: null as string | null, owner: '',
        statusColor: buyerStatusTone(b.status).fg,
        markets: (places.some((p) => p.state) ? places.map((p) => p.label) : b.markets).join(', '),
        marketList: b.markets, places,
        placeLabels: places.map((p) => p.label),
        entity: ENTITY_LABELS[entity],
        isLlc: entity === 'llc',
        type: b.type, price: b.buyBox.price, exit: b.buyBox.exit,
        engagement: b.engagement, responseKnown: b.responseKnown !== false,
        tireKicker: b.tireKicker ?? isTireKicker({ sent: b.sent ?? null, responsePct: b.engagement, offers: b.activity?.offers ?? 0, purchases: b.activity?.purchases ?? 0 }),
        get engColor() { return responseTone(this.responseKnown ? this.engagement : null, this.tireKicker).text; },
        lastPurchase: b.lastPurchase, lastActivity: b.lastActivity, lastActivityAt: b.lastActivityAt ?? null, pref: b.pref,
        genius: (b.tags ?? []).includes('genius'),
        prospectList: b.prospectList ?? null,
        source: b.source ?? null,
        phone: b.phone && b.phone !== '—' ? b.phone : '', email: b.email && b.email !== '—' ? b.email : '',
        added: b.createdAt ? addedOn(b.createdAt) : '—', addedAt: b.createdAt || '',
        tags: visibleTags(b.tags ?? []).join(', '), buyerType: b.buyerType || '', offers: b.offers || '',
        strategy: b.strategy || '', ceiling: b.ceiling || '', doNot: b.doNot || '', dealMatch: 0,
        search: buyerSearchKey(b, places.map((p) => p.label)),
        open: () => openBuyer(b.id),
      };
    });
    // The Buyers screen's visible rows after list chip, Genius, and search — what
    // left/right and Enter walk. Same set the open buyer record arrows use.
    const buyerListNames = buyerListIds();
    const buyerList = s.buyerList === LAST_IMPORT ? LAST_IMPORT : effectiveBuyerList(s.buyerList);
    const buyerListLabel = (id: string) => (id === LAST_IMPORT && s.lastImport
      ? `${s.lastImport.label} · ${s.lastImport.ids.length.toLocaleString('en-US')} imported`
      : (buyerListLabelOf(id) ?? id));
    // Every buyer in memory is searched, not just the drawn page. Realtors
    // were already searched on the server, so their page is taken as is.
    // Ranked once per (deferred) query in buyerSearchView, not per render.
    const buyerSearch = buyerSearchView.search;
    const buyerRanks = new Map<string, number>();
    const buyerMatches = (b: (typeof buyerRows)[number]) => {
      if (!buyerSearch) return true;
      const r = buyerSearchView.ranks.get(b.id);
      if (r === undefined) return false;
      buyerRanks.set(b.id, r);
      return true;
    };
    const onRealtors = live && buyerList === 'realtors';
    const buyerImportIds = new Set(buyerList === LAST_IMPORT && s.lastImport?.kind === 'buyers' ? s.lastImport.ids : []);
    const buyerNavRows = onRealtors ? realtorTableRows : buyerRows.filter((b) =>
      (buyerList === LAST_IMPORT ? buyerImportIds.has(b.id) : inBuyerList(buyerList, b))
      && (!s.buyerGeniusOnly || b.genius)
      && buyerMatches(b));
    const buyerNavLen = buyerNavRows.length;
    const buyerCursor = s.buyerCursorList === buyerList ? Math.min(s.buyerCursor, Math.max(0, buyerNavLen - 1)) : 0;
    const moveBuyerInList = (dir: 1 | -1) => {
      if (!buyerNavLen) return;
      set({ buyerCursor: stepIndex(buyerCursor, buyerNavLen, dir), buyerCursorList: buyerList });
    };
    // The Buyers screen sorts its rows itself (by score, among others), so the
    // record walks the order it last drew rather than this unsorted one.
    const buyerOrderIds = () => inDrawnOrder(buyerNavRows.map((b) => b.id), recall<string[]>('buyers.order', []));
    const moveOpenBuyer = (dir: 1 | -1) => {
      if (s.screen !== 'buyer') return;
      const ids = buyerOrderIds();
      const nextId = adjacentRecordId(ids, s.buyerId, dir);
      if (!nextId || nextId === s.buyerId) return;
      const idx = ids.indexOf(nextId);
      go('buyer', {
        buyerId: nextId,
        buyerCursor: idx < 0 ? 0 : idx,
        buyerCursorList: buyerList,
      });
      noteRecent('buyer:' + nextId);
    };
    const moveBuyerList = (dir: 1 | -1) => {
      const next = stepLabel(buyerList, buyerListNames, dir);
      if (next === buyerList) return;
      // Recompute the next list's rows so opening a record lands on someone in it.
      const nextRows = next === 'realtors' ? realtorTableRows : buyerRows.filter((b) =>
        inBuyerList(next, b)
        && (!s.buyerGeniusOnly || b.genius)
        && buyerMatches(b));
      if (next === 'realtors') setRealtorOffset(0);
      const enteringRealtors = next === 'realtors' ? { buyerQ: '', buyerGeniusOnly: false } : {};
      if (s.screen === 'buyer' && nextRows.length) {
        go('buyer', {
          buyerList: next, buyerCursor: 0, buyerCursorList: next, buyerId: nextRows[0].id, ...enteringRealtors,
        });
        noteRecent('buyer:' + nextRows[0].id);
        toast(buyerListLabel(next));
        return;
      }
      set({ buyerList: next, buyerCursor: 0, buyerCursorList: next, ...enteringRealtors });
      toast(buyerListLabel(next));
    };
    const setBuyerList = (id: string) => {
      if (id === 'realtors') setRealtorOffset(0);
      set({
        buyerList: id, buyerCursor: 0, buyerCursorList: id,
        ...(id === 'realtors' ? { buyerQ: '', buyerGeniusOnly: false } : {}),
      });
    };
    // What the Buyers bulk bar (components/BuyerBulkBar.tsx) acts on: the
    // buyers by id, the deals worth marketing and the plans to enroll in.
    const buyerBulk = {
      canWrite, workspaceId, me, textCtx, toast, reload,
      // The realtor page is not in the buyer index (the corpus never loads
      // whole), so a realtor ticked on the list would have been sent nothing.
      // Spread only when a realtor page is loaded: copying the 11,000-buyer
      // index into a fresh object was a cost on every render.
      buyers: realtorPage.rows.length ? {
        ...Object.fromEntries(realtorPage.rows.map((b) => [b.id, {
          dbId: dbId(b.id), name: b.name, company: b.company, phone: b.phone === '—' ? '' : b.phone, email: b.email === '—' ? '' : b.email,
          pref: b.pref, inactive: b.status === 'Inactive', blacklisted: !!b.blacklisted || b.status === 'Blacklisted',
          protected: isProtectedBuyer({ vip: b.vip || b.status === 'VIP', buyerType: b.buyerType, entityType: b.entityType, type: b.type }),
        }])),
        ...buyerIndex.bulk,
      } as typeof buyerIndex.bulk : buyerIndex.bulk,
      deals: dispoPool.flatMap((d) => {
        const p = person(d.personId);
        const stage = d.stage || dealStageOf(d, p);
        if (!p || !['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract'].includes(stage)) return [];
        const price = d.tracker?.marketedPrice || (d.contract && d.assignment ? d.contract + d.assignment : d.contract);
        const addr = d.addr || p.property.addr;
        return [{
          id: dbId(d.id), label: addr + ' · ' + stage,
          // Dispo merge fields ({{full_address}}, {{arv}}, {{comps_link}} …) — lib/message-templates DISPO_FIELDS.
          fields: dispoFields(d, p, addr, price),
        }];
      }),
      plans: plansForRecord(plans, 'buyer').map((pl) => ({ id: pl.id, name: pl.name })),
      /** Every plan saved in the Builder, for "Add to action plan": buyer plans first, paused ones marked. */
      allPlans: plans.map((pl) => ({ id: pl.id, name: pl.name, active: pl.active, audience: pl.audience ?? '', steps: pl.steps.length })),
      /** "Add to call queue": these buyers onto the rep's queue, skipping any already there. */
      addToCallQueue: (buyerIds: string[]) => addToCallQueue('buyer', buyerIds),
      /** The Assign panel (app/components/bulk/AssignPanel.tsx): teammates, with their workspace role for "All dispositions". */
      team: Object.values(D.team).map((r) => ({ id: r.id, name: r.name, initials: r.initials, memberRole: r.memberRole })),
      /** Write each block (migration 128); says who got how many, or where it stopped. */
      assign: async (blocks: AssignBlock[]): Promise<boolean> => {
        const total = blocks.reduce((k, b) => k + b.ids.length, 0);
        const said = blocks.map((b) => `${b.ids.length.toLocaleString('en-US')} to ${b.userId ? repName(b.userId) : 'nobody'}`);
        if (!canWrite) { toast(`${total} assigned (demo): ${said.join(' · ')}`); return true; }
        for (let i = 0; i < blocks.length; i++) {
          const r = await assignBuyers(blocks[i].ids, blocks[i].userId);
          if (!r.ok) {
            reload?.();
            toast(`${i ? said.slice(0, i).join(' · ') + ' saved, then ' : ''}${r.message || 'that did not save.'}`, 'error');
            return false;
          }
        }
        reload?.();
        toast(`${total.toLocaleString('en-US')} assigned: ${said.join(' · ')}`, 'success');
        return true;
      },
      /** "Build campaign": these buyers into the deal's campaign builder (components/DispoCampaign.tsx). */
      openCampaign: (dealDbId: number, buyerDbIds: number[]) => {
        const d = dispoPool.find((x) => dbId(x.id) === dealDbId);
        if (!d) return toast('That deal is not in active inventory.');
        prefillCampaign(dealDbId, buyerDbIds);
        openDispo(d.personId, 'Marketing', d.id);
      },
      /** Enroll selected buyers in a plan (no deal required). */
      enrollInPlan: (planId: string, buyerIds: string[]) => {
        if (!canWrite) {
          for (const id of buyerIds) {
            setS((prev) => {
              const already = [...D.enrollments, ...prev.newEnrollments]
                .some((e) => e.buyerId === id && e.planId === planId && e.status !== 'done');
              if (already) return prev;
              return {
                ...prev,
                newEnrollments: [...prev.newEnrollments, { id: nextId('en'), personId: '', buyerId: id, planId, step: 1, status: 'active', note: '' }],
              };
            });
          }
          return toast(`${buyerIds.length} enrolled (demo)`);
        }
        if (workspaceId === null) return toast('Sign in to enroll buyers.');
        void (async () => {
          let enrolled = 0; let already = 0; let queued = 0;
          for (const id of buyerIds) {
            const b = buyers.find((x) => x.id === id);
            const r = await enrollBuyerInPlan(workspaceId, planId, id, me, { name: b?.name ?? '', company: b?.company ?? '' });
            if (!r.ok) return toast(r.message || 'Could not enroll.', 'error');
            if (r.already) already++; else { enrolled++; queued += r.queued ?? 0; }
          }
          reload?.();
          toast(`${enrolled} enrolled${queued ? ` · ${queued} touches queued` : ''}${already ? ` · ${already} already on the plan` : ''}`, 'success');
        })();
      },
      /** Pause the running action plan on each selected buyer. Queued steps wait until someone plays it again. */
      pauseFromPlan: (buyerIds: string[]) => {
        const lives = enrollments.filter((e) => e.buyerId && buyerIds.includes(e.buyerId) && e.status === 'active' && /^en\d+$/.test(e.id));
        if (!lives.length) return toast('None of those buyers have a running action plan');
        if (!canWrite) return toast('Action plans paused (demo)');
        void Promise.all(lives.map((e) => pauseEnrollment(dbId(e.id), 'manual'))).then((rs) => {
          const bad = rs.find((r) => !r.ok);
          if (bad && !rs.some((r) => r.ok)) return toast(bad.message || 'Could not pause the plan.', 'error');
          reload?.();
          toast(`Paused action plan on ${rs.filter((r) => r.ok).length} buyer${rs.filter((r) => r.ok).length === 1 ? '' : 's'}`, 'success');
        });
      },
      /** Stop the active action plan on each selected buyer. */
      removeFromPlan: (buyerIds: string[]) => {
        if (!canWrite) {
          setS((prev) => ({
            ...prev,
            newEnrollments: prev.newEnrollments.filter((e) => !e.buyerId || !buyerIds.includes(e.buyerId)),
            toast: 'Action plan stopped', toastSeq: prev.toastSeq + 1,
          }));
          return;
        }
        const lives = enrollments.filter((e) => e.buyerId && buyerIds.includes(e.buyerId) && e.status !== 'done' && /^en\d+$/.test(e.id));
        if (!lives.length) return toast('None of those buyers are on an action plan');
        void Promise.all(lives.map((e) => stopEnrollment(dbId(e.id)))).then((rs) => {
          const bad = rs.find((r) => !r.ok);
          if (bad) return toast(bad.message || 'Could not stop the plan.', 'error');
          reload?.();
          toast(`Stopped action plan on ${lives.length} buyer${lives.length === 1 ? '' : 's'}`, 'success');
        });
      },
    };
    const bb = B.buyBox;
    const buyBoxRows = ([
      ['Price', bb.price], ['Year', bb.year], ['Sqft', bb.sqft], ['Beds', bb.beds], ['Bathrooms', bb.baths],
      ['Property type', bb.type], ['Rehab', bb.rehab], ['Exit', bb.exit], ['Min cap', bb.minCap],
      ['Max cash out', bb.maxCashOut], ['Min cash flow', bb.minCashFlow],
    ] as [string, string][]).map(([k, v]) => ({ k, v }));
    const buyerAvoid = bb.avoid.map((a) => ({ a }));
    const ba = B.activity;
    // Live, the counts come from this buyer's own history (loadBuyerTimeline,
    // up to 500 rows each), not the workspace's newest 500 messages, and
    // walkthroughs from their appointments. Clicks are not tracked per buyer,
    // so a live record leaves the tile out rather than show a 0 that is not one.
    const ownRows = live && buyerRecordTimeline?.bid === B.id ? buyerRecordTimeline.rows : null;
    const countOf = (types: string[]) => (ownRows ? ownRows.filter((r) => types.includes(r.type)).length : null);
    const capped = (n: number) => (n >= 500 ? '500+' : n);
    const buyerActivity = ([
      ['Calls', countOf(['call', 'voicemail']) ?? ba.calls], ['Texts', countOf(['sms_in', 'sms_out']) ?? ba.texts], ['Emails', countOf(['email']) ?? ba.emails],
      ['Properties viewed', ba.viewed],
      ...(live ? [] : [['Links clicked', ba.clicks]]),
      ['Offers submitted', ba.offers],
      ['Walkthroughs', live ? D.walkthroughs.filter((w) => w.buyerId === B.id).length : ba.walkthroughs],
      ['Purchases', ba.purchases], ['Declines', ba.declines],
    ] as [string, number][]).map(([k, v]) => ({ k, v: capped(v) }));
    const buyerSummary = B.summary.map((t) => ({ t }));
    const stars = [1, 2, 3, 4, 5].map((i) => ({ on: i <= B.stars, color: i <= B.stars ? '#ff7a45' : '#e4e4e7' }));
    // Same shape as the people record's activity: a channel, a title, the body,
    // and on a call the recording (CallInsight) or the sample AI summary.
    const buyerChan = (type: string): [string, string] => {
      const map: Record<string, [string, string]> = {
        call: ['#e6142e', 'Call'], sms_in: ['#e6142e', 'SMS in'], sms_out: ['#e6142e', 'SMS out'], sms: ['#e6142e', 'SMS out'],
        offer: ['#d97706', 'Offer'], compr: ['#0A8560', 'COMPR'], stage: ['#71717a', 'Stage'],
        note: ['#71717a', 'Note'], email: ['#52525b', 'Email'], task: ['#71717a', 'Automation'],
        portal: ['#4f46e5', 'Portal'], purchase: ['#15803d', 'Purchase'], ai_agent: ['#0f766e', 'AI agent'],
      };
      return map[type] || ['#71717a', type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Note'];
    };
    type BuyerEvent = {
      id: string; chan: string; color: string; title: string; body: string; time: string; who: string;
      isCall: boolean; commId: number | null; email: TimelineEntry['email'] | null;
      ai: { summary: string; objections: string[]; next: string } | null;
    };
    const buyerFrom = (t: TimelineEntry): BuyerEvent => {
      const [color, chan] = buyerChan(t.type);
      return {
        id: t.id, chan, color, title: t.title, body: t.body || '', time: t.time, who: t.who,
        isCall: t.type === 'call',
        // Any stored message: a call loads its recording, an email its HTML.
        commId: /^ct\d+$/.test(t.id) ? Number(t.id.slice(2)) : null,
        email: t.email ?? null, ai: t.ai ?? null,
      };
    };
    const buyerSent: BuyerEvent[] = (s.sent['buyer:' + B.id] ?? []).slice().reverse().map((m, i) => ({
      id: 'sent-' + i, chan: 'SMS out', color: '#e6142e', title: 'Text sent', body: m.text, time: m.time, who: 'You',
      isCall: false, commId: null, email: null, ai: null,
    }));
    const buyerDemo: BuyerEvent[] = [
      { id: 'bd1', chan: 'Offer', color: '#d97706', title: 'Submitted $238,500', body: 'Willow Street · cash, 14-day close.', time: '10:02 AM', who: B.name, isCall: false, commId: null, email: null, ai: null },
      { id: 'bd2', chan: 'Portal', color: '#4f46e5', title: 'Opened COMPR report', body: 'Willow Street · 12 photos viewed.', time: '9:44 AM', who: B.name, isCall: false, commId: null, email: null, ai: null },
      { id: 'bd3', chan: 'Email', color: '#52525b', title: 'Campaign opened', body: '', time: '9:41 AM', who: B.name, isCall: false, commId: null, email: { subject: 'Willow Street — new deal', from: 'deals@clozr.app', fromName: 'CLOZR', to: [B.email], inbound: false, body: 'Willow Street is live. 3 bed, light rehab, assignment on the sheet.' }, ai: null },
      { id: 'bd4', chan: 'SMS in', color: '#e6142e', title: 'Text received', body: 'Can we get in Willow tomorrow at 2:30? Bringing my GC.', time: 'Yesterday', who: B.name, isCall: false, commId: null, email: null, ai: null },
      ...(B.activity.purchases > 0 ? [{ id: 'bd5', chan: 'Purchase', color: '#15803d', title: 'Closed 4481 Elm St', body: '$262,000 · assignment $19,500.', time: 'Jul 14', who: B.name, isCall: false, commId: null, email: null, ai: null }] : []),
      { id: 'bd6', chan: 'Call', color: '#e6142e', title: 'Buy box review with Morgan', body: '12 minutes. Walked the price ceiling and the rehab rule.', time: 'Jul 2', who: 'Morgan', isCall: true, commId: null, email: null, ai: { summary: 'Buyer wants light rehab under $300K in Dallas and asked to walk Willow with their GC. They have not closed a deal with us yet.', objections: ['Rehab scope looks heavier than light', 'Wants a same-week walkthrough'], next: 'Send the walkthrough window and a tighter rehab scope before they go quiet.' } },
    ];
    /** The buyer's own load (loadBuyerTimeline) with anything newer from the workspace load, newest first. */
    const buyerFeed = (bid: string): TimelineEntry[] => {
      const ws = D.timeline.filter((t) => t.entity === bid);
      const own = buyerRecordTimeline?.bid === bid ? buyerRecordTimeline.rows : [];
      if (!own.length) return ws;
      const seen = new Set(ws.map((t) => t.id));
      return [...ws, ...own.filter((t) => !seen.has(t.id))].sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
    };
    const buyerTimeline: BuyerEvent[] = [
      ...buyerSent,
      ...(live ? withStages(buyerFeed(B.id), stageTimeline('b:' + B.id, B.id)).map(buyerFrom) : buyerDemo),
    ];
    // The record shows the placed name ("San Antonio, TX") where we could place
    // it, and the raw string where we could not, so a market that needs fixing
    // is visible on the buyer rather than only in the filters.
    const buyerMarkets = resolveMarkets(B.markets, marketGaz).map((p) => ({ m: p.label, placed: !!p.state }));
    const buyerOfferRows = (live
      ? D.offers.filter((o) => o.buyerId === B.id)
      : D.offers.filter((o) => o.buyerId === B.id).slice(0, 8)
    ).map((o) => {
      const d = deals.find((x) => x.id === o.dealId);
      const p = d ? person(d.personId) : undefined;
      const accepted = /accept/i.test(o.terms);
      return {
        id: o.id,
        amount: fmt(o.offer),
        addr: (d as Deal | undefined)?.addr || p?.property.addr || 'Deal',
        status: o.terms || 'Submitted',
        color: accepted ? '#16a34a' : /declin|lost|dead/i.test(o.terms) ? '#b91c1c' : '#71717a',
        when: o.closing,
        open: d ? () => openDispo(d.personId, undefined, d.id) : undefined,
      };
    });
    const buyerOwned = deals.filter((d) => d.buyerId === B.id);
    const buyerPick = buyerOwned.find((d) => d.stage && !PIPELINE_DONE.has(d.stage) && d.personId) ?? buyerOwned.find((d) => d.personId);
    const buyerWalk = D.walkthroughs.find((w) => w.buyerId === B.id);
    const buyerDealLink = buyerPick?.personId
      ? { personId: buyerPick.personId, dealId: buyerPick.id }
      : buyerWalk ? { personId: buyerWalk.personId, dealId: null as string | null } : null;
    const buyerPurchaseRows = (live ? deals : []).filter((d) => (d as Deal).buyerId === B.id).map((d) => {
      const p = person(d.personId);
      const closed = /closed/i.test(d.stage || '');
      return {
        id: d.id,
        addr: d.addr || p?.property.addr || 'Deal',
        price: fmt(d.contract),
        stage: d.stage || '—',
        color: closed ? '#16a34a' : '#71717a',
        when: d.close || d.tracker?.closedOn || '',
        open: () => (closed ? openTc(d.personId, d.id) : openDispo(d.personId, undefined, d.id)),
      };
    });
    const buyerNoteRows = D.timeline
      .filter((t) => t.entity === B.id && t.type === 'note' && String(t.id).startsWith('a'))
      .map((t) => ({ id: t.id, text: t.body ? `${t.title} · ${t.body}` : t.title, when: t.time }));
    // Deals a buyer can be attached to: the ones that were ever in the
    // pipeline (under contract or past it, archived and terminated kept, since
    // a purchase can be history). Partner submissions that never left Prospect
    // are four thousand rows nobody buys.
    const buyerDealChoices = (live ? deals : [])
      .filter((d) => (!!d.stage && d.stage !== 'Prospect') || !!d.tracker?.contractDate || !!d.tracker?.closedOn)
      .map((d) => {
        const p = person(d.personId);
        const when = d.tracker?.closedOn || d.tracker?.contractDate || d.createdAt || '';
        const at = Date.parse(when) || 0;
        return {
          id: String(dbId(d.id)),
          label: [
            [d.addr || p?.property.addr || `Deal ${d.id}`, d.addr ? d.city : p?.property.city].filter(Boolean).join(', '),
            d.stage + (d.archived ? ' (archived)' : ''),
            p?.name && p.name !== 'No name' ? p.name : '',
            at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
          ].filter(Boolean).join(' · '),
          at,
        };
      });
    const purchaseOrMatch = buyerPurchaseRows[0] ?? null;
    const matchDeal = live
      ? D.matches.filter((m) => m.buyerId === B.id).map((m) => deals.find((d) => d.id === m.dealId)).find(Boolean)
      : undefined;
    const contractDeal = purchaseOrMatch
      ? deals.find((d) => d.id === purchaseOrMatch.id)
      : matchDeal;
    const buyerContractDealId = contractDeal ? dbId(contractDeal.id) : null;
    const buyerContractSellerId = contractDeal?.personId ? dbId(contractDeal.personId) : null;
    const buyerContractSeller = contractDeal
      ? (() => { const p = person(contractDeal.personId); return p ? { name: p.name, email: p.email === '—' ? null : p.email, phone: p.phone === '—' ? null : p.phone } : null; })()
      : null;
    const addBuyerToCampaign = (dealDbId: number, buyerDbId: number) => {
      const d = deals.find((x) => dbId(x.id) === dealDbId);
      if (!d) return toast('That deal is not on this workspace.');
      prefillCampaign(dealDbId, [buyerDbId]);
      openDispo(d.personId, 'Marketing', d.id);
    };
    const openBuyerCampaign = (dealDbId: number) => {
      const d = deals.find((x) => dbId(x.id) === dealDbId);
      if (!d) return toast('That campaign\'s deal is gone.');
      openDispo(d.personId, 'Marketing', d.id);
    };
    // "Open deals sent": live, the deals this buyer was matched to and how far each went.
    const buyerDeals = live
      ? D.matches.filter((m) => m.buyerId === B.id).flatMap((m) => {
        const d = deals.find((x) => x.id === m.dealId);
        const p = d ? person(d.personId) : undefined;
        if (!p) return [];
        const offer = D.offers.find((o) => o.dealId === m.dealId && o.buyerId === B.id);
        return [{
          addr: p.property.addr,
          status: offer ? 'Offered ' + fmt(offer.offer) : m.replied ? 'Replied ' + m.replied : m.viewed ? 'Viewed ' + m.viewed : m.sent ? 'Sent ' + m.sent : 'Match ' + m.score,
          color: offer ? '#16a34a' : '#71717a',
        }];
      })
      : [
        { addr: 'Willow Street', status: 'Offered $238,500', color: '#16a34a' },
        { addr: 'Easton Avenue', status: 'Viewed 2×', color: '#71717a' },
        { addr: '123 Oakview Drive', status: 'Match ' + B.match + ' · pre-market', color: '#0A8560' },
      ];

    // ---- TC ----
    // The sample list's ticks are per file like the checklist's: keyed by the
    // open file's transaction id (its tcId when it has no transaction).
    const tcSampleKey = tcTxOf()?.id ?? TP.id;
    const tcSampleDone = s.tcDone[tcSampleKey] ?? {};
    const tcDoneOf = (i: number, it: { done: boolean }) => (tcSampleDone[i] == null ? it.done : tcSampleDone[i]);
    const tcItems = D.tcItems.map((it, i) => {
      const done = tcDoneOf(i, it);
      return {
        k: it.k, owner: it.owner, date: it.date, done, blocker: it.blocker || '',
        blockerColor: it.blocker === 'critical' ? '#dc2626' : it.blocker === 'warning' ? '#d97706' : 'transparent',
        toggle: () => set((st) => ({ tcDone: { ...st.tcDone, [tcSampleKey]: { ...st.tcDone[tcSampleKey], [i]: !tcDoneOf(i, it) } } })),
        bg: done ? '#16a34a' : '#fff', border: done ? '#16a34a' : '#c7c7cc',
        textColor: done ? '#71717a' : '#18181b', deco: done ? 'line-through' : 'none',
      };
    });
    const tcDoneCount = tcItems.filter((t) => t.done).length;
    const tcPct = tcItems.length ? Math.round((tcDoneCount / tcItems.length) * 100) : 0;
    // Live: what the SOP says stands in the way on this file (lib/deal-close tcFileBlockers).
    const tcBlockFile = live ? tcTxOf() : null;
    const tcLiveBlockers = live && tcBlockFile ? tcFileBlockers({
      closingIso: (TD as Partial<Deal>).tracker?.scheduledClose ?? tcBlockFile.closingIso, contractIso: tcBlockFile.d0Iso,
      state: tcBlockFile.state, titleSet: (TD as Partial<Deal>).hasTitle === true || tcBlockFile.titleCo !== '—',
      contractSla: tcBlockFile.contractSla, tcReview: s.tcGates[tcBlockFile.id]?.review ?? tcBlockFile.tcReview,
      signoff: s.tcGates[tcBlockFile.id]?.signoff ?? tcBlockFile.signoff,
      wholesaler: !!(TD as Partial<Deal>).vendorSellers?.length, price: (TD as Partial<Deal>).contract ?? null,
      closed: PIPELINE_DONE.has((TD as Partial<Deal>).stage ?? ''),
    }) : [];
    const tcBlockers = [...tcLiveBlockers, ...(live ? [] : D.tcBlockers)].map((b) => ({
      ...b, color: b.level === 'CRITICAL' ? '#dc2626' : b.level === 'NOTE' ? '#52525b' : '#d97706',
      bg: b.level === 'CRITICAL' ? '#fee2e2' : b.level === 'NOTE' ? '#f4f4f5' : '#fef3c7',
    }));
    const tcRoleColor: Record<string, string> = {
      Title: typeTone('Title').fg, TC: '#1f7a4d', Lane: 'var(--c-lane)', Buyer: typeTone('Buyer').fg, Dispo: typeTone('Buyer').fg,
      Seller: typeTone('Seller').fg, Acquisitions: typeTone('Seller').fg,
    };
    // Live: everything said and done on the file in one feed — the seller's
    // calls, texts and email, the end buyer's, TC notes and what Lane heard —
    // with a filter, rather than TC notes here and the rest on three records.
    const tcBuyerEntity = (() => { const d = dealOf(TP.id); return d?.buyerId ? 'b' + dbId(d.buyerId) : null; })();
    const tcKindOf = (type: string) => (type === 'tc' ? 'TC & Lane' : type === 'call' || type === 'voicemail' ? 'Calls' : type === 'sms' || type === 'text' ? 'Texts' : type === 'email' ? 'Email' : 'Other');
    // A row about another of the seller's deals stays on that deal's file.
    const tcFeedAll = live ? D.timeline.filter((t) => (t.entity === TP.id || (!!tcBuyerEntity && t.entity === tcBuyerEntity)) && (!t.dealId || !TD.id || t.dealId === TD.id)) : [];
    const tcFeedFilters = (['All', 'TC & Lane', 'Calls', 'Texts', 'Email'] as const).map((k) => ({
      label: k, on: s.tcFeedFilter === k,
      count: k === 'All' ? tcFeedAll.length : tcFeedAll.filter((t) => tcKindOf(t.type) === k).length,
      go: () => set({ tcFeedFilter: k }),
    }));
    const tcFeed = (live
      ? tcFeedAll.filter((t) => s.tcFeedFilter === 'All' || tcKindOf(t.type) === s.tcFeedFilter).slice(0, 40).map((t) => ({
        who: t.user && D.team[t.user] ? D.team[t.user].name : t.who,
        role: t.type === 'tc' ? (t.who === 'Lane' ? 'Lane' : 'TC') : t.entity === tcBuyerEntity ? 'Buyer' : tcKindOf(t.type) === 'Other' ? 'Seller' : 'Seller · ' + tcKindOf(t.type).replace(/s$/, ''),
        // An email's body can be the whole HTML message and the thread under it: show the words of this one.
        text: [t.title, tcKindOf(t.type) === 'Email' || looksHtml(t.body || '') ? emailGist(t.body).slice(0, 600) : t.body].filter(Boolean).join(' — '),
        time: t.time,
      }))
      : D.tcFeed
    ).map((f) => ({
      ...f, initials: initialsOf(f.who.split(' ·')[0]),
      roleColor: tcRoleColor[f.role.split(' ·')[0]] || '#71717a',
    }));
    // Live: the parties the transaction file and the deal tracker actually name.
    const TPX = tcTxOf();
    // The file's own ids, for the cards that read the database themselves
    // (Lane heard, deal team, files) — one file, not three different lookups.
    const tcFile = live && workspaceId != null && TPX ? {
      txId: TPX.dbId ?? null,
      dealId: TPX.dealId ? dbId(TPX.dealId) : (dealOf(TP.id)?.id ? dbId(dealOf(TP.id)!.id) : null),
      sellerId: dbId(TP.id), workspaceId, me, canWrite,
    } : null;
    // The file's open work, tickable here: the checklist and the tasks live side by side.
    const tcTasks = tasks.filter((t) => t.personId === TP.id && (!t.done || s.tasksDone[t.id] !== undefined)).map((t) => {
      const done = s.tasksDone[t.id] ?? t.done;
      return {
        id: t.id, title: t.title, due: t.due, done,
        toggle: () => { set((st) => ({ tasksDone: { ...st.tasksDone, [t.id]: !done } })); persistTask(t.id, !done); },
      };
    });
    const addTcTask = () => openAdd('task', { personId: TP.id, type: 'TC' });
    const tpTracker = (TD as Partial<Deal>).tracker;
    const tcParties = (live
      ? [
        ['Seller', TP.name],
        ...(seeBuyers ? [['Buyer', TPX?.buyerName || '—'] as [string, string]] : []),
        ['Title', [TPX?.titleCo, TPX?.titleContact].filter((x) => x && x !== '—').join(' · ') || '—'],
        ['Acquisitions', tpTracker?.acqAgent || repName(TP.assigned)],
        ['Dispo', tpTracker?.dispoAgent || '—'], ['TC', tpTracker?.coordinator || teamTc(D.team)?.name || '—'],
      ]
      : [
        ['Seller', TP.name],
        ...(seeBuyers ? [['Buyer', 'Harbor Capital · Chris Anderson'] as [string, string]] : []),
        ['Title', 'Northvale Title · Maria Delgado'], ['Acquisitions', repName(TP.assigned)],
        ['Dispo', 'Morgan Lane'], ['TC', 'Casey Park'],
      ] as [string, string][]).map(([k, v]) => ({ k, v }));

    // ---- QUICK ADD -------------------------------------------------------------
    // One spec-driven dialog for every record type, so the form and the create
    // logic can't drift apart. `wide` spans both columns; `req` gates submit.
    type AddField = {
      key: string; label: string; ph: string;
      wide?: boolean; req?: boolean; opts?: string[];
      /** A street address: gets Google autocomplete (in the page with a Places key, else through COMPR). */
      addr?: boolean;
      /** What a select shows for each value, when the values are ids (teammates, vendors). */
      labels?: Record<string, string>;
    };
    // Who a new record goes to. A TC adding a lead ties it to an acquisitions
    // rep and to herself as TC; everyone else picks an owner (themselves by default).
    const amTc = role === 'tc';
    const teamRows = Object.values(D.team).filter((r) => r.id);
    const rank = (r: { memberRole?: string }) => (r.memberRole === 'acquisitions' ? 0 : r.memberRole === 'owner' || r.memberRole === 'admin' ? 1 : 2);
    const acqFirst = [...teamRows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const teamLabels: Record<string, string> = Object.fromEntries(teamRows.map((r) => [r.id, r.name + (r.memberRole ? ' · ' + (r.memberRole === 'tc' ? 'TC' : r.memberRole) : '')]));
    const assignField = (what: string): AddField => ({
      key: 'assignTo', label: amTc && what === 'lead' ? 'Acquisitions rep' : 'Assign to',
      ph: amTc && what === 'lead' ? 'Pick the acquisitions rep' : 'Me', req: amTc && what === 'lead',
      opts: [...acqFirst.map((r) => r.id), 'none'], labels: { ...teamLabels, none: 'Nobody yet' },
    });
    const tcField: AddField = {
      key: 'tc', label: 'TC', ph: amTc ? 'Me' : 'No TC yet',
      opts: [...teamRows].sort((a, b) => (a.memberRole === 'tc' ? 0 : 1) - (b.memberRole === 'tc' ? 0 : 1) || a.name.localeCompare(b.name)).map((r) => r.id),
      labels: teamLabels,
    };
    const vendorLabels: Record<string, string> = Object.fromEntries(vendors.map((v) => [String(dbId(v.id)), v.name + (v.kind ? ' · ' + v.kind : '')]));
    const vendorField: AddField = { key: 'vendorId', label: 'Sent by vendor', ph: 'None (search Offerpad, a wholesaler…)', wide: true, opts: Object.keys(vendorLabels), labels: vendorLabels };
    // The day picker used to list the sample calendar's days; a real workspace
    // has none until something is scheduled, which left the field empty.
    const nextFortnight = now ? Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      return i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
        : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }) : [];
    const ADD_SPECS: Record<AddKind, { title: string; sub: string; submit: string; fields: AddField[] }> = {
      seller: {
        title: 'New lead',
        sub: 'The seller and their property, together. The address is what every other source matches on.',
        submit: 'Add lead',
        fields: [
          { key: 'name', label: 'Seller name', ph: 'Full name', wide: true, req: true },
          { key: 'phone', label: 'Phone', ph: 'Phone' },
          { key: 'email', label: 'Email', ph: 'name@email.com' },
          { key: 'addr', label: 'Property address', ph: 'Street address', wide: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'zip', label: 'ZIP', ph: 'ZIP' },
          { key: 'asking', label: 'Asking', ph: '$' },
          { key: 'motivation', label: 'Motivation', ph: 'Relocating, tired landlord…' },
          { key: 'source', label: 'Source', ph: 'Cold call', opts: ['Cold call', 'Direct Mail', 'Facebook PPC', 'Referral', 'Driving for Dollars', 'Website', 'Manual'] },
          assignField('lead'),
          tcField,
          { key: 'compr', label: 'Run COMPR automatically', ph: 'On', opts: ['On', 'Off'] },
        ],
      },
      address: s.addForm.editing ? {
        title: 'Edit the property address',
        sub: 'For ' + P.name + '. Moves them, and their open deals, to the new address; the old property stays for anyone else on it.',
        submit: 'Save address',
        fields: [
          { key: 'addr', label: 'Street address', ph: 'Street address', wide: true, req: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'zip', label: 'ZIP', ph: 'ZIP' },
        ],
      } : {
        title: 'Set the property address',
        sub: 'For ' + P.name + '. The address is what Deal Machine, Talkr and imports match on.',
        submit: 'Save address',
        fields: [
          { key: 'addr', label: 'Street address', ph: 'Street address', wide: true, req: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'zip', label: 'ZIP', ph: 'ZIP' },
        ],
      },
      coseller: {
        title: 'Add a seller to ' + P.property.addr,
        sub: 'Co-owners, heirs and spouses join the same property record.',
        submit: 'Add seller',
        fields: [
          { key: 'name', label: 'Seller name', ph: 'Full name', wide: true, req: true },
          { key: 'phone', label: 'Phone', ph: 'Phone' },
          { key: 'email', label: 'Email', ph: 'name@email.com' },
          { key: 'role', label: 'Relationship', ph: 'Co-heir, spouse, executor…', wide: true },
        ],
      },
      property: {
        title: 'New property',
        sub: 'Search the address, then tie it to a seller already in CLOZR, to a vendor that sent it, or type a new seller.',
        submit: 'Create property',
        fields: [
          { key: 'addr', label: 'Street address', ph: 'Street address', wide: true, req: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'zip', label: 'ZIP', ph: 'ZIP' },
          { key: 'beds', label: 'Beds', ph: '3' },
          { key: 'baths', label: 'Baths', ph: '2' },
          { key: 'sqft', label: 'Sqft', ph: '1,500' },
          { key: 'year', label: 'Year', ph: '1990' },
          { key: 'personId', label: 'Existing seller', ph: 'None (search sellers)', wide: true, opts: people.map((p) => p.id) },
          vendorField,
          { key: 'name', label: 'Or a new seller', ph: 'Full name', wide: true },
          { key: 'phone', label: 'Phone', ph: 'Phone' },
          { key: 'email', label: 'Email', ph: 'name@email.com' },
          assignField('property'),
          { key: 'compr', label: 'Run COMPR automatically', ph: 'On', opts: ['On', 'Off'] },
        ],
      },
      buyer: {
        title: 'New buyer',
        sub: 'Lands in Buyers and starts matching against dispo inventory.',
        submit: 'Create buyer',
        fields: [
          { key: 'name', label: 'Buyer name', ph: 'Full name', wide: true, req: true },
          { key: 'company', label: 'Company', ph: 'Company' },
          { key: 'type', label: 'Type', ph: 'Institutional · Rental' },
          { key: 'phone', label: 'Phone', ph: '(214) 555-0201', req: true },
          { key: 'email', label: 'Email', ph: 'name@company.com', req: true },
          { key: 'markets', label: 'Markets', ph: 'Markets, comma separated' },
          { key: 'price', label: 'Price range', ph: 'Min – max' },
          assignField('buyer'),
        ],
      },
      deal: {
        title: 'New deal',
        sub: 'Attaches to an existing seller and moves them into the pipeline.',
        submit: 'Create deal',
        fields: [
          { key: 'personId', label: 'Seller', ph: 'Pick a seller', wide: true, req: true, opts: people.map((p) => p.id) },
          { key: 'addr', label: 'Property address', ph: 'The seller’s address when left blank', wide: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'zip', label: 'ZIP', ph: 'ZIP' },
          vendorField,
          { key: 'stage', label: 'Stage', ph: live ? 'Under Contract Seller' : 'Under Contract', opts: D.STAGES as string[] },
          assignField('deal'),
          tcField,
          { key: 'close', label: 'Close date', ph: 'Close date' },
          { key: 'contract', label: 'Contract price', ph: '$' },
          { key: 'arv', label: 'ARV', ph: '$' },
          { key: 'rehab', label: 'Rehab', ph: '$' },
          { key: 'assignment', label: 'Assignment fee', ph: '$' },
          { key: 'compr', label: 'Run COMPR automatically', ph: 'On', opts: ['On', 'Off'] },
        ],
      },
      task: {
        title: 'New task',
        sub: 'Shows on Tasks and on the seller record it belongs to.',
        submit: 'Create task',
        fields: [
          { key: 'title', label: 'Task', ph: 'Call seller — discuss revised offer', wide: true, req: true },
          { key: 'personId', label: 'Seller', ph: 'Pick a seller', wide: true, opts: people.map((p) => p.id) },
          { key: 'type', label: 'Type', ph: 'Call', opts: ['Call', 'Follow-up', 'Email', 'Dispo', 'TC', 'Appointment'] },
          { key: 'priority', label: 'Priority', ph: 'Medium', opts: ['Urgent', 'High', 'Medium', 'Low'] },
          { key: 'due', label: 'Due', ph: 'Today 1:30 PM', wide: true },
        ],
      },
      appointment: {
        title: 'New appointment',
        sub: 'Lands on the calendar, and on the seller record it is with.',
        submit: 'Set appointment',
        fields: [
          { key: 'title', label: 'Title', ph: 'What it is', wide: true, req: true },
          { key: 'personId', label: 'Seller', ph: 'Pick a seller', wide: true, opts: people.map((p) => p.id) },
          { key: 'day', label: 'Day', ph: 'Today', opts: nextFortnight },
          { key: 'time', label: 'Time', ph: '10:00 AM' },
          { key: 'type', label: 'Type', ph: 'Appointment', opts: ['Appointment', 'Walkthrough', 'Closing', 'Call', 'Inspection'] },
        ],
      },
      note: {
        title: 'New note',
        sub: 'Appears on the seller record timeline.',
        submit: 'Add note',
        fields: [
          { key: 'personId', label: 'Seller', ph: 'Pick a seller', wide: true, opts: people.map((p) => p.id) },
          { key: 'body', label: 'Note', ph: 'What happened, what matters, what is next…', wide: true, req: true },
        ],
      },
      vendor: {
        title: 'New vendor',
        sub: 'Title companies, contractors, lenders and the rest of the rolodex.',
        submit: 'Create vendor',
        fields: [
          { key: 'name', label: 'Company', ph: 'Company', wide: true, req: true },
          { key: 'kind', label: 'Type', ph: 'Title Company', opts: ['Title Company', 'Contractor', 'Lender', 'Insurance', 'Survey', 'Notary', 'Photography', 'Attorney', 'Wholesaler', 'Institutional seller', 'Realtor'] },
          { key: 'market', label: 'Market', ph: 'DFW', opts: ['DFW', 'Houston', 'San Antonio', 'Austin', 'All'] },
          { key: 'addr', label: 'Office address', ph: 'Street address', wide: true, addr: true },
          { key: 'city', label: 'City', ph: 'City' },
          { key: 'st', label: 'State', ph: 'TX' },
          { key: 'contact', label: 'Contact', ph: 'Full name' },
          { key: 'phone', label: 'Phone', ph: 'Phone' },
          { key: 'email', label: 'Email', ph: 'name@company.com', wide: true },
          { key: 'note', label: 'Note', ph: 'What they are good at…', wide: true },
        ],
      },
    };
    const addSpec = s.addOpen ? ADD_SPECS[s.addOpen] : null;
    // A seller picker renders as a select of ids; label them by name and address.
    const personLabel = (id: string) => {
      const p = person(id);
      return p ? p.name + ' · ' + p.property.addr : id;
    };
    const addFields = addSpec
      ? addSpec.fields.map((fd) => ({
          addr: !!fd.addr,
          key: fd.key, label: fd.label, ph: fd.ph, wide: !!fd.wide, req: !!fd.req,
          value: s.addForm[fd.key] || '',
          isSelect: !!fd.opts,
          options: (fd.opts || []).map((o) => ({
            v: o, label: fd.key === 'personId' ? personLabel(o) : fd.labels?.[o] ?? o,
          })),
          set: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setAddField(fd.key, e.target.value),
          mention: s.addOpen === 'note' && fd.key === 'body', setValue: (v: string) => setAddField(fd.key, v),
        }))
      : [];
    // A buyer's phone and email also have to look real; the line under the form says which.
    const addProblem = s.addOpen === 'buyer' && (s.addForm.phone || '').trim() && (s.addForm.email || '').trim()
      ? buyerContactProblem(s.addForm) : null;
    const addCanSubmit = !!addSpec && !addProblem && !s.addBusy && !s.addAsk && addSpec.fields.every((fd) => !fd.req || !!(s.addForm[fd.key] || '').trim());

    // ---- MOBILE ---------------------------------------------------------------
    // Phone chrome: a five-slot bottom tab bar for the screens people live in,
    // and a More sheet for the rest. Drawers go full-screen instead of docking
    // to a 420px rail.
    const TAB_ICONS: Record<string, string> = {
      home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
      people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87',
      deals: 'M3 3v18h18 M7 15l4-4 3 3 5-6',
      tasks: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
      inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
      today: 'M16.13 12a4.13 4.13 0 1 1-8.26 0 4.13 4.13 0 0 1 8.26 0z M12 2.25V4.5 M12 19.5v2.25 M2.25 12H4.5 M19.5 12h2.25 M5.1 5.1l1.65 1.65 M17.25 17.25l1.65 1.65 M5.1 18.9l1.65-1.65 M17.25 6.75l1.65-1.65',
    };
    // The first slot is where the role lands: Today for acquisitions.
    const mobileTabs = ([
      [landing === 'today' ? 'Today' : 'Home', landing === 'today' ? 'today' : 'home'], ['People', 'people'], ['Deals', 'deals'], ['Tasks', 'tasks'], ['Inbox', 'inbox'],
    ] as [string, string][]).filter(([, key]) => canSee(role, key)).map(([label, key]) => ({
      label, key, icon: TAB_ICONS[key],
      active: activeKey === key,
      go: () => go(key),
      color: activeKey === key ? 'var(--c-accent)' : '#71717a',
      weight: activeKey === key ? '600' : '500',
    }));
    // ---- PHONE (the full-screen phone, phones only) -------------------------
    // One host (components/talkr/PhoneScreen.tsx) replaces the slide-out, the
    // dialer screen's phone layout and the incoming banner on a phone. It is
    // up while a call rings in, or while the dialer is open and not tucked
    // behind its pill. None of this runs on a desk: every action below keeps
    // its desk meaning when isMobile is false.
    const openPhone = (tab?: 'Dial' | 'Queue' | 'Recent' | 'Voicemail' | 'Live') =>
      set({ dialerOpen: true, phoneMin: false, moreOpen: false, ...(tab ? { dialerTab: tab } : {}) });
    /** Done when idle (the phone closes), Minimise during a call or wrap-up (the call carries on behind the pill). */
    const minimisePhone = () =>
      set(callState !== 'idle' ? { phoneMin: true } : { dialerOpen: false, phoneMin: false });
    // Everything that isn't a tab, plus the tools, reachable from More.
    const moreItems = ([
      ...(landing === 'today' ? [['Home', 'home']] : [['Today', 'today']]) as [string, string][],
      ['Calendar', 'calendar'], ['Contracts', 'contracts'], ['Dispo', 'dispo'], ['Buyers', 'buyers'], ['Reporting', 'reporting'], ['Coaching', 'coaching'],
      ['Action plans', 'plans'], ['Automations', 'automations'], ['Leaderboard', 'leaderboard'],
      ['COMPR', 'compr'], ['Genius', 'genius'], ['Buyr', 'buyr'], ['Deal Machine', 'dealMachine'], ['Live database', 'liveLists'], ['Import', 'import'],
      ['Settings', 'settings'], ['Account', 'account'],
    // COMPR is on every record for every role (the desktop Tools menu shows it
    // to everyone), so it is not a screen canSee knows about.
    ] as [string, string][]).filter(([, key]) => key === 'compr' || canSee(role, key)).map(([label, key]) => ({
      label, key,
      active: key !== 'compr' && activeKey === key,
      // COMPR is not a screen of its own — it is the underwriting workspace on
      // a seller record, which is how the desktop nav opens it. Routed through
      // go('compr') the phone landed on a screen nothing renders, so the More
      // sheet showed a blank page.
      go: key === 'compr'
        ? openComprHere
        : () => { set({ moreOpen: false }); go(key, key === 'import' ? { importKind: 'sellers' } : undefined); },
    })).concat(canSee(role, 'dialer') ? [{
      // The phone, from anywhere: the FAB hides on screens that own the corner.
      label: 'Phone', key: 'phone', active: false,
      go: () => openPhone('Dial'),
    }] : []).concat([{
      // The header drops the help icon on the phone, so Ask CLOZR lives here.
      label: 'Ask CLOZR', key: 'askClozr', active: false,
      go: () => set({ moreOpen: false, aiOpen: true }),
    }, {
      label: 'Lane · TC AI', key: 'lane', active: s.laneOpen,
      go: () => openLane(),
    }]);
    const isMobile = s.isMobile;
    const moreOpen = s.moreOpen;

    // Compact card rows for the phone, replacing the wide tables.
    const mobilePeopleCards = peopleFiltered.map((p, rowIndex) => ({
      id: p.id, name: p.name, initials: initialsOf(p.name),
      stage: p.stage, stageColor: stageColor(p.stage),
      addr: p.property.addr, cityLine: p.property.city + ', ' + p.property.st,
      score: p.score, scoreColor: scoreColor(p.score), hasScore: p.score != null,
      temp: p.score == null ? leadTemp(p) : '', tempColor: tempColor(leadTemp(p)),
      next: p.nextTask, last: p.lastComm, added: p.createdAt ? addedOn(p.createdAt) : p.created,
      assigned: repName(p.assigned),
      focused: rowIndex === peopleCursor,
      open: () => openListedAt(p, rowIndex),
      hasPhone: !!p.phone && p.phone !== '—',
      call: (e?: { stopPropagation?: () => void }) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const sellerId = p.id.startsWith('sub:') ? (deals.find((d) => subKey(p.id) === 'sub:' + d.id)?.personId || null) : p.id;
        if (p.phone && p.phone !== '—') startCall({ name: p.name, phone: p.phone, personId: sellerId });
        else toast(`No phone for ${p.name} yet`);
      },
    }));
    const mobileDealCards = lazy(() => dealRows().map((d) => ({
      addr: d.addr, seller: d.seller, search: d.search, stage: d.stage, stageColor: d.stageColor, dealType: d.dealType,
      setStage: d.setStage,
      dealId: d.dealId, archived: d.archived,
      img: d.img, street: d.street, photos: d.photos, dealDbId: d.dealDbId,
      contract: d.contract, profit: d.profit, close: d.close, closeBadge: d.closeBadge, added: d.added, addedAt: d.addedAt, contractAt: d.contractAt, cells: d.cells,
      optionSeller: d.optionSeller, optionBuyer: d.optionBuyer,
      feeRaw: d.feeRaw, contractRaw: d.contractRaw, inPipeline: d.inPipeline,
      health: d.health, healthColor: d.healthColor,
      hasTc: d.hasTc, openTc: d.openTc, openSheet: d.openSheet, open: d.open,
    })));

    // ---- COMMUNICATIONS (record timelines) ------------------------------------
    // One chronological stream per record, mixing every channel. A record's
    // stream is everything tied to that seller plus anything tied to a buyer
    // talking about that seller's property — the graph is already connected, so
    // this is a filter, not a join table.
    const CHAN_META: Record<string, { label: string; color: string; icon: string }> = {
      call: { label: 'Call', color: '#e6142e', icon: 'call' },
      sms: { label: 'SMS', color: '#e6142e', icon: 'sms' },
      email: { label: 'Email', color: '#52525b', icon: 'email' },
      voicemail: { label: 'Voicemail', color: '#d97706', icon: 'voicemail' },
      // Notes are written by a rep rather than exchanged with anyone, but they
      // belong in the same stream — without an entry here they fell through to
      // the email fallback below and a typed note showed up labelled "Email".
      note: { label: 'Note', color: '#71717a', icon: 'note' },
    };
    const commsChannels = ['All', 'Calls', 'SMS', 'Email', 'Voicemail', 'Notes'];
    const commsChannelMatch: Record<string, (c: Communication) => boolean> = {
      All: () => true,
      Calls: (c) => c.channel === 'call',
      SMS: (c) => c.channel === 'sms',
      Email: (c) => c.channel === 'email',
      Voicemail: (c) => c.channel === 'voicemail',
      Notes: (c) => c.channel === 'note',
    };
    /** Everything relevant to one seller record, newest first. */
    const commsFor = (pid: string) => {
      const own = comms.filter((c) => c.personId === pid);
      const extra = recordComms?.pid === pid ? recordComms.rows.filter((r) => !own.some((c) => c.id === r.id)) : [];
      return [...own, ...extra].sort((a, b) => a.ts - b.ts);
    };
    const shapeComm = (c: Communication) => {
      const meta = CHAN_META[c.channel] || CHAN_META.email;
      const inbound = c.dir === 'in';
      return {
        id: c.id, channel: meta.label, channelKey: c.channel, color: meta.color,
        inbound, dirLabel: inbound ? 'Inbound' : 'Outbound',
        dirColor: inbound ? '#e6142e' : '#71717a',
        party: c.party, time: c.time, preview: c.preview, dur: c.dur || '',
        hasDur: !!c.dur,
        rep: c.user ? repName(c.user) : null,
        hasRep: !!c.user,
        initials: c.user && D.team[c.user] ? D.team[c.user].initials : initialsOf(c.party),
        isBuyer: !!c.buyerId,
      };
    };
    const personCommsAll = commsFor(P.id);
    const personComms = personCommsAll
      .filter(commsChannelMatch[s.commsChannel] || commsChannelMatch.All)
      .map(shapeComm);
    const commsFilters = commsChannels.map((c) => ({
      label: c,
      count: personCommsAll.filter(commsChannelMatch[c] || commsChannelMatch.All).length,
      go: () => set({ commsChannel: c }),
      bg: s.commsChannel === c ? '#fff' : 'transparent',
      color: s.commsChannel === c ? '#18181b' : '#71717a',
      shadow: s.commsChannel === c ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
    }));
    const personCommsCount = personCommsAll.length;
    const hasPersonComms = personComms.length > 0;
    const personCommsLast = personCommsAll.length ? personCommsAll[0].time : '—';
    // Dispo property record uses the same stream, unfiltered.
    const dispoComms = commsFor(DP.id).map(shapeComm);
    const hasDispoComms = dispoComms.length > 0;
    const dispoCommsCount = dispoComms.length;

    // ---- SELLERS ON THIS PROPERTY ---------------------------------------------
    // People are linked to a property by address, so a co-heir or spouse added
    // to a record shows up here and everywhere else that reads the graph.
    const sellersOnProperty = [
      ...people
        .filter((p) => p.property.addr === P.property.addr)
        .map((p) => ({
          id: p.id, name: p.name, initials: initialsOf(p.name),
          role: p.id === P.id ? 'Primary' : (p.source === 'Added on record' ? 'Co-seller' : 'Seller'),
          phone: p.phone, isCurrent: p.id === P.id,
          go: () => openPerson(p.id),
          bg: p.id === P.id ? '#fafafa' : '#fff',
        })),
      // Vendors attached as sellers on this deal. They are not people rows, so
      // the address match above never finds them. Opening one lands on their vendor contact.
      ...((focusDeal ?? recDealOf(P.id))?.vendorSellers ?? []).map((v) => ({
        id: v.id, name: v.company && v.company !== v.name ? `${v.name} · ${v.company}` : v.name,
        initials: initialsOf(v.name),
        role: 'Vendor',
        phone: v.phone, isCurrent: false,
        go: () => go('people', { peopleList: vendorListOf(v.id), peopleQ: v.name || v.company, peopleSel: {} }),
        bg: '#fff',
      })),
    ];
    const sellerCount = sellersOnProperty.length;

    // ---- TRANSACTION COORDINATION (in the deal record) ------------------------
    // Opened on one submission: that house's file or none, never another
    // deal's. Otherwise the record's deal's file, else any of the seller's.
    const recTxDeal = recDealOf(P.id);
    const TX = focusDeal
      ? D.transactions.find((t) => t.dealId === focusDeal.id) || null
      : (recTxDeal ? D.transactions.find((t) => t.dealId === recTxDeal.id) : undefined) || D.transactions.find((t) => t.personId === P.id) || null;
    const hasTx = !!TX;
    // This file's session overrides, keyed by its transaction id (see tcDone).
    // Without a file there is nothing to tick or stamp, so '' is never written.
    const txKey = TX ? TX.id : '';
    const txDone = s.tcDone[txKey] ?? {};
    const txHud = s.tcHud[txKey] ?? {};
    const txGates = s.tcGates[txKey] ?? {};
    const setTxDone = (id: string, v: boolean) => set((st) => ({ tcDone: { ...st.tcDone, [txKey]: { ...st.tcDone[txKey], [id]: v } } }));
    const SEV: Record<string, { color: string; bg: string; label: string }> = {
      critical: { color: '#dc2626', bg: '#fef2f2', label: 'Critical' },
      warning: { color: '#d97706', bg: '#fffbeb', label: 'Needs cure' },
      cleared: { color: '#16a34a', bg: '#f0fdf4', label: 'Cleared' },
      info: { color: '#52525b', bg: '#fafafa', label: 'Info' },
    };
    const DUE: Record<string, { color: string; bg: string; label: string }> = {
      met: { color: '#16a34a', bg: '#f0fdf4', label: 'Met' },
      due: { color: '#d97706', bg: '#fffbeb', label: 'Near' },
      overdue: { color: '#dc2626', bg: '#fef2f2', label: 'Overdue' },
      open: { color: '#71717a', bg: '#fafafa', label: 'Open' },
    };
    const DOC: Record<string, { color: string; bg: string }> = {
      Received: { color: '#16a34a', bg: '#f0fdf4' },
      Outstanding: { color: '#d97706', bg: '#fffbeb' },
      Ordered: { color: '#0A8560', bg: '#E7F8F1' },
      Sent: { color: '#0A8560', bg: '#E7F8F1' },
    };
    const tone = (m: Record<string, { color: string; bg: string }>, k: string, fb: string) => m[k] || m[fb];

    // Never null: the TC tab is only reachable when TX exists, but keeping this
    // total means the screens read it without null guards on every field.
    const txCommitment = {
      status: TX ? TX.commitment.status : 'No file',
      received: (TX && TX.commitment.received) || 'Not issued',
      effective: (TX && TX.commitment.effective) || '—',
      titleCo: TX ? TX.titleCo : '—', contact: TX ? TX.titleContact : '—',
      phone: TX ? TX.titlePhone : '—', email: TX ? TX.titleEmail : '—',
      escrow: TX ? TX.escrow : '—', opened: TX ? TX.opened : '—', closing: TX ? TX.closing : '—',
      color: TX && TX.commitment.status === 'Cleared' ? '#16a34a' : TX && TX.commitment.status === 'Received' ? '#d97706' : '#71717a',
      bg: TX && TX.commitment.status === 'Cleared' ? '#f0fdf4' : TX && TX.commitment.status === 'Received' ? '#fffbeb' : '#fafafa',
    };
    const txExceptions = TX
      ? TX.commitment.exceptions.map((e) => {
          const t = tone(SEV, e.severity, 'info');
          return {
            id: e.id, ref: e.ref, kind: e.kind, text: e.text, owner: e.owner, due: e.due, status: e.status,
            color: t.color, bg: t.bg, label: SEV[e.severity]?.label || e.severity,
            cleared: e.severity === 'cleared',
          };
        })
      : [];
    const txOpenExceptions = txExceptions.filter((e) => !e.cleared).length;
    const emdStamp = txGates.emdReceived;
    const markEmdReceived = () => {
      if (!TX) return;
      const when = (now || new Date()).toISOString();
      const label = (now || new Date()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      set((st) => ({ tcGates: { ...st.tcGates, [txKey]: { ...st.tcGates[txKey], emdReceived: label } } }));
      if (TX?.dbId && canWrite) {
        void updateTcFile(TX.dbId, { emd_received_at: when }, me).then((r) => {
          if (!r.ok) return toast(r.message ?? 'Could not mark EMD received.', 'error');
          reload?.();
          toast('EMD marked received', 'success');
        });
      } else toast('EMD marked received (demo)');
    };
    const txEarnest = TX
      ? TX.earnest.map((e) => {
          const ok = e.status === 'Received' || !!emdStamp;
          const late = !ok && e.status === 'Overdue';
          return {
            id: e.id, party: e.party, amount: e.amount, holder: e.holder, due: e.due,
            received: emdStamp || e.received || '—', status: ok ? 'Received' : e.status,
            color: ok ? '#16a34a' : late ? '#dc2626' : '#d97706',
            bg: ok ? '#f0fdf4' : late ? '#fef2f2' : '#fffbeb',
            canMark: !ok, mark: markEmdReceived,
          };
        })
      : [];
    const emdCanMark = !!TX && !txEarnest.some((e) => e.status === 'Received') && !emdStamp;
    const txDeadlines = TX
      ? TX.deadlines.map((d) => {
          const t = tone(DUE, d.status, 'open');
          return {
            id: d.id, k: d.k, date: d.date, owner: d.owner, note: d.note, hasNote: !!d.note,
            color: t.color, bg: t.bg, label: DUE[d.status]?.label || d.status,
            met: d.status === 'met',
          };
        })
      : [];
    const txDocuments = TX
      ? TX.documents.map((d) => {
          const t = tone(DOC, d.status, 'Outstanding');
          return { id: d.id, k: d.k, owner: d.owner, status: d.status, due: d.due, color: t.color, bg: t.bg };
        })
      : [];
    const txDocsOutstanding = txDocuments.filter((d) => d.status !== 'Received').length;
    const txNextActions = TX
      ? TX.nextActions.map((n) => {
          const t = tone(SEV, n.severity, 'info');
          return {
            id: n.id, who: n.who, role: n.role, what: n.what, due: n.due,
            color: t.color, bg: t.bg, initials: initialsOf(n.who),
            overdue: /overdue/i.test(n.due),
          };
        })
      : [];
    const txCritical = txNextActions.filter((n) => n.color === '#dc2626').length;
    // The record's TC tab reads the same Lane updates the TC screen does.
    const personTcFile = live && workspaceId != null && TX?.dbId ? { txId: TX.dbId, workspaceId, me, canWrite } : null;

    // ---- TC CHECKLIST (Acme Homes contract-to-close) ---------------------------
    // The printed checklist, driven off the deal type. Ticks live in state so the
    // TC can work the list; the seed `done` map is the starting position.
    const CL = TX ? D.tcChecklists[TX.dealType] : null;
    const taskDone = (id: string) => (txDone[id] != null ? txDone[id] : !!(TX && TX.done[id]));
    const allTasks = CL ? CL.phases.flatMap((ph) => ph.tasks) : [];
    const tcClDoneCount = allTasks.filter((t) => taskDone(t.id)).length;
    const tcClTotal = allTasks.length;
    const tcClPct = tcClTotal ? Math.round((tcClDoneCount / tcClTotal) * 100) : 0;
    const tcClLabel = CL ? CL.label : '—';
    const tcClFlow = CL ? CL.flow : '';
    const tcClTarget = CL ? CL.target : '';
    const tcClD0 = CL ? CL.d0 : '';
    const tcChecklistPhases = CL
      ? CL.phases.map((ph) => {
          const tasks = ph.tasks.map((t) => {
            const done = taskDone(t.id);
            return {
              id: t.id, t: t.t, note: t.note, hasNote: !!t.note, day: t.day, owner: t.owner,
              critical: t.critical, done,
              toggle: () => {
                const next = !taskDone(t.id);
                setTxDone(t.id, next);
                // View as is read-only: the tick shows on screen and is never saved.
                if (TX?.dbId && canWrite) void setTcTick(TX.dbId, 'checklist', t.id, next, me).then((r) => { if (!r.ok) toast(r.message ?? 'Could not save the tick.', 'error'); });
              },
              box: done ? '#18181b' : '#fff',
              boxBorder: done ? '#18181b' : t.critical ? '#ff7a45' : '#d4d4d8',
              textColor: done ? '#a1a1aa' : '#18181b',
              deco: done ? 'line-through' : 'none',
              dayColor: done ? '#a1a1aa' : t.critical ? '#ff7a45' : '#71717a',
            };
          });
          const n = tasks.filter((t) => t.done).length;
          return { k: ph.k, sub: ph.sub, hasSub: !!ph.sub, tasks, done: n, total: tasks.length, complete: n === tasks.length };
        })
      : [];
    // Live TC screen uses this file's checklist, not the demo item list.
    const tcScreenItems = live && CL
      ? allTasks.map((t) => {
          const done = taskDone(t.id);
          return {
            k: t.t, owner: t.owner, date: t.day, done,
            blocker: t.critical ? 'critical' : '',
            blockerColor: t.critical ? '#dc2626' : 'transparent',
            toggle: () => {
              const next = !taskDone(t.id);
              setTxDone(t.id, next);
              if (TX?.dbId && canWrite) void setTcTick(TX.dbId, 'checklist', t.id, next, me).then((r) => { if (!r.ok) toast(r.message ?? 'Could not save the tick.', 'error'); });
            },
            bg: done ? '#16a34a' : '#fff', border: done ? '#16a34a' : '#c7c7cc',
            textColor: done ? '#71717a' : '#18181b', deco: done ? 'line-through' : 'none',
          };
        })
      : tcItems;
    const tcScreenDone = tcScreenItems.filter((t) => t.done).length;
    const tcScreenPct = tcScreenItems.length ? Math.round((tcScreenDone / tcScreenItems.length) * 100) : 0;
    // Milestone rail: a milestone is reached once every task due on or before it is ticked.
    const MILE_ORDER: Record<string, string[]> = {
      D0: [], D3: ['D1', 'D2', 'D3'], D7: ['D1', 'D2', 'D3', 'D4–10', 'D4', 'D7'],
      D10: ['D1', 'D2', 'D3', 'D4–10', 'D4', 'D7', 'D10', 'varies', '+1', '+2'],
      D14: [],
    };
    const tcMilestones = CL
      ? CL.milestones.map((m, i) => {
          const scope = MILE_ORDER[m.k] || [];
          const inScope = allTasks.filter((t) => scope.includes(t.day));
          const reached = m.k === 'D0' ? true : inScope.length > 0 && inScope.every((t) => taskDone(t.id));
          return {
            k: m.k, t: m.t, sub: m.sub, reached, first: i === 0,
            color: reached ? '#16a34a' : '#a1a1aa',
            bg: reached ? '#16a34a' : '#e4e4e7',
            labelColor: reached ? '#18181b' : '#71717a',
          };
        })
      : [];
    const hudDoneFor = (id: string) => (txHud[id] != null ? txHud[id] : !!(TX && TX.hudDone[id]));
    const tcHudLines = CL
      ? CL.hud.map((h) => {
          const done = hudDoneFor(h.id);
          return {
            id: h.id, k: h.k, done,
            toggle: () => {
              const next = !hudDoneFor(h.id);
              set((st) => ({ tcHud: { ...st.tcHud, [txKey]: { ...st.tcHud[txKey], [h.id]: next } } }));
              if (TX?.dbId && canWrite) void setTcTick(TX.dbId, 'hud', h.id, next, me).then((r) => { if (!r.ok) toast(r.message ?? 'Could not save the tick.', 'error'); });
            },
            box: done ? '#18181b' : '#fff',
            boxBorder: done ? '#18181b' : '#d4d4d8',
            textColor: done ? '#a1a1aa' : '#18181b',
          };
        })
      : [];
    const tcHudDone = tcHudLines.filter((h) => h.done).length;
    const tcHudTotal = tcHudLines.length;
    const tcHudClear = tcHudTotal > 0 && tcHudDone === tcHudTotal;
    const gateStamp = (who: string) => who + ' · ' + (now || new Date()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const persistGate = (field: 'review' | 'signoff', value: string) => {
      if (!TX) return;
      const prev = s.tcGates[txKey]?.[field];
      set((st) => ({ tcGates: { ...st.tcGates, [txKey]: { ...st.tcGates[txKey], [field]: value } } }));
      if (TX.dbId && canWrite) {
        void setTcGate(TX.dbId, field === 'review' ? 'tc_review' : 'signoff', value, me).then((r) => {
          // A funding gate that did not save must not keep showing as given.
          if (!r.ok) {
            set((st) => ({ tcGates: { ...st.tcGates, [txKey]: { ...st.tcGates[txKey], [field]: prev } } }));
            return toast(r.message ?? 'Could not save the gate.', 'error');
          }
          reload?.();
          toast(field === 'review' ? 'TC review saved' : 'Owner sign-off saved', 'success');
        });
      } else toast(field === 'review' ? 'Marked reviewed (demo)' : 'Sign-off recorded (demo)');
    };
    const tcReview = txGates.review ?? (TX && TX.tcReview) ?? 'Not reviewed';
    const tcSignoff = txGates.signoff ?? (TX && TX.signoff) ?? 'Awaiting sign-off';
    const tcSignoffClear = !!(txGates.signoff ?? (TX && TX.signoff));
    const markTcReview = () => persistGate('review', gateStamp(repName(ME) === 'Unassigned' ? 'TC' : repName(ME)));
    // Funding waits on this stamp, so giving it is an owner's or admin's call,
    // and it names whoever gave it. A real workspace needs the role; the demo
    // has no role and saves nothing, so it shows the button like everything else.
    const canSignoff = isAdmin(role) || (!live && !role);
    const markTcSignoff = () => {
      if (!canSignoff) return toast('Only an owner or admin can sign off');
      persistGate('signoff', gateStamp(repName(ME) === 'Unassigned' ? 'Owner' : repName(ME)));
    };

    // ---- LANE'S DAILY DRIVE ---------------------------------------------------
    // Where the file stands today, from the checklist ticks as they are on
    // screen (state overrides included), so a tick moves the marker at once.
    const driveRaw = TX
      ? laneDrive({ ...TX, done: { ...TX.done, ...Object.fromEntries(Object.entries(txDone).filter(([id]) => allTasks.some((t) => t.id === id))) }, hudDone: { ...TX.hudDone, ...txHud }, signoff: txGates.signoff ?? TX.signoff, tcReview: txGates.review ?? TX.tcReview }, CL, new Date(), teamTc(D.team)?.name ?? 'TC')
      : null;
    const driveTone = driveRaw?.status === 'red' ? { color: '#dc2626', bg: '#fef2f2' } : driveRaw?.status === 'yellow' ? { color: '#d97706', bg: '#fffbeb' } : { color: '#16a34a', bg: '#f0fdf4' };
    const tcDrive = TX && driveRaw ? {
      ...driveRaw,
      statusLabel: driveRaw.status.toUpperCase(),
      ...driveTone,
      track: TX.dealType === 'novation' ? 'Novation' : 'Assignment',
      nextLabel: driveRaw.nextMilestone ? `${driveRaw.nextMilestone.k} ${driveRaw.nextMilestone.label} · in ${driveRaw.nextMilestone.inDays} day${driveRaw.nextMilestone.inDays === 1 ? '' : 's'}` : 'No milestone ahead',
      triggers: driveRaw.triggers.map((t) => ({ ...t, color: t.level === 'red' ? '#dc2626' : '#d97706', bg: t.level === 'red' ? '#fef2f2' : '#fffbeb' })),
      hasTriggers: driveRaw.triggers.length > 0,
      hasOverdue: driveRaw.overdue.length > 0,
      hasDueToday: driveRaw.dueToday.length > 0,
      hasSlas: driveRaw.slas.length > 0,
      askSweep: () => { openLane(TP.id); runLane(LANE_PROMPTS[0].question, TP.id); },
      askPost: () => { openLane(TP.id); runLane(LANE_PROMPTS[3].question, TP.id); },
    } : null;
    const tcD0 = TX ? TX.d0 : '—';
    const tcCtcTarget = TX ? TX.ctcTarget : '—';

    // ---- LANE (TC assistant) --------------------------------------------------
    // Drawer + drafts. askLane() hits the lane edge function when signed in.
    // The chat's property is the one Lane filed it under (or the record it was
    // opened from) — never whatever happens to be on screen.
    const laneChat = s.laneChatId != null ? s.laneChats.find((c) => c.id === s.laneChatId) ?? null : null;
    const lanePerson = s.lanePersonId ? people.find((x) => x.id === s.lanePersonId) ?? null : null;
    const laneTx = lanePerson ? D.transactions.find((t) => t.personId === lanePerson.id) ?? null : null;
    const laneAddr = laneChat?.address || lanePerson?.property.addr || '';
    const laneReading = {
      filed: !!laneAddr,
      addr: laneAddr || 'Not filed under a property yet',
      title: laneChat?.title || laneAddr || 'New chat',
      line: laneAddr
        ? [laneTx ? `commitment ${laneTx.commitment.status}` : 'no TC file loaded', laneTx ? `closing ${laneTx.closing}` : null].filter(Boolean).join(' · ')
        : 'Ask about any address, seller, buyer or vendor — Lane finds the record and files this chat under the property.',
      canOpen: !!lanePerson,
      open: () => { if (lanePerson) openPerson(lanePerson.id); },
    };
    const logLaneDraft = (d: LaneDraft) => {
      const body = [d.subject, d.body].filter(Boolean).join('\n\n');
      const pid = s.lanePersonId;
      if (!canWrite || workspaceId === null) return toast('Draft ready — copy it. Logging to the file is signed-in only.');
      if (!pid) return toast('Lane has not filed this chat under a property yet — copy the draft, or ask about the property first.');
      void createCommunication(workspaceId, {
        sellerId: dbId(pid), channel: 'note', direction: 'outbound', body,
        subject: 'TC · Lane draft · ' + d.channel + ' · ' + d.to,
      }).then((r) => {
        if (!r.ok) return toast(r.message || 'Could not put that draft on the file.', 'error');
        refreshPerson(pid);
        toast('Draft logged on the file', 'success');
      });
    };
    // No property yet: the task or appointment is made without a record.
    const lanePid = s.lanePersonId ?? '';
    const sendLaneDraft = (d: LaneDraft) => {
      // The address or number, when Lane's "to" carries one; else the TC types it.
      const email = /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i.exec(d.to)?.[0] ?? null;
      const phone = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/.exec(d.to)?.[0] ?? null;
      const name = d.to.split('·')[0].replace(/<[^>]*>/g, '').trim() || d.to;
      openReach(d.channel === 'sms' ? 'text' : 'email', {
        name, email, phone, subject: d.subject ?? undefined, body: d.body,
        editableTo: d.channel === 'sms' ? !phone : !email, sellerId: lanePid ? dbId(lanePid) || null : null,
      });
    };
    const laneWhen = (due: string) => {
      const d = new Date(due.length <= 10 ? due + 'T09:00:00' : due);
      return Number.isNaN(d.getTime()) ? due : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(due.length > 10 ? { hour: 'numeric', minute: '2-digit' } : {}) });
    };
    const laneAct = (a: LaneAction) => {
      if (!canWrite || workspaceId === null) return toast('Tasks and calendar items need a signed-in workspace');
      const at = new Date(a.due.length <= 10 ? a.due + 'T09:00:00' : a.due);
      const iso = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
      const run = a.kind === 'calendar'
        ? createAppointment(workspaceId, { title: a.title, type: 'Appointment', startsAt: iso, personId: lanePid }, me)
        : createTask(workspaceId, { title: a.title, type: 'TC', priority: 'High', dueAt: iso, personId: lanePid }, me);
      void run.then((r) => {
        if (!r.ok) return toast(r.message || 'That did not save.', 'error');
        reload?.();
        toast(a.kind === 'calendar' ? '📅 On the calendar: ' + a.title : '✅ Task set: ' + a.title, 'success');
      });
    };
    const laneThread = s.laneThread.map((t, i) => ({
      id: i, isTc: t.role === 'tc', isLane: t.role === 'lane',
      text: t.text,
      // A ref that names a section of the file is a button; a playbook
      // citation has nowhere to go, so it stays the chip it always was.
      refs: (t.refs || []).map((r) => ({ r: r.label, canGo: r.target !== 'none', go: () => openLaneRef(r.target) })),
      hasRefs: !!(t.refs && t.refs.length),
      drafts: (t.drafts || []).map((d, di) => ({
        id: di, to: d.to, channel: d.channel, subject: d.subject, body: d.body, hasSubject: !!d.subject,
        copy: () => copyText('Draft', [d.subject, d.body].filter(Boolean).join('\n\n')),
        log: () => logLaneDraft(d),
        // Opens the docked text or email box with Lane's draft in it, so it
        // goes out from the TC's own number or mailbox after a read.
        canSend: d.channel === 'email' || d.channel === 'sms',
        send: () => sendLaneDraft(d),
      })),
      hasDrafts: !!(t.drafts && t.drafts.length),
      actions: (t.actions || []).map((a, ai) => ({
        id: ai, kind: a.kind, title: a.title, when: laneWhen(a.due),
        label: a.kind === 'calendar' ? 'Add to calendar' : 'Make task',
        go: () => laneAct(a),
      })),
      hasActions: !!(t.actions && t.actions.length),
      // The records Lane opened for this answer: a tap opens them.
      cards: (t.cards || []).filter((c: LaneCard) => c.kind === 'seller' || c.kind === 'buyer').map((c: LaneCard, ci: number) => ({
        id: ci, title: c.title, subtitle: c.subtitle, kind: c.kind,
        go: () => (c.kind === 'buyer' ? openBuyer('b' + c.id) : openPerson('s' + c.id)),
      })),
      hasCards: !!(t.cards && t.cards.some((c) => c.kind === 'seller' || c.kind === 'buyer')),
    }));
    // Openers: about the property once the chat has one, about the pipeline before.
    const lanePrompts = (laneAddr ? LANE_PROMPTS : LANE_START).map((p) => ({
      label: p.label, question: p.question,
      go: () => runLane(p.question),
    }));
    const laneHasThread = s.laneThread.length > 0;
    const laneEmpty = s.laneThread.length === 0;
    const laneAgo = (iso: string) => {
      const m = now ? Math.round((now.getTime() - Date.parse(iso)) / 60000) : NaN;
      if (!Number.isFinite(m) || m < 1) return 'just now';
      if (m < 60) return `${m}m ago`;
      if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    const laneChatRows = s.laneChats.map((c) => ({
      id: c.id, title: c.title, filed: !!c.address, sub: c.address && c.address !== c.title ? c.address : c.address ? 'Property chat' : 'Not filed under a property',
      when: laneAgo(c.updatedAt), active: c.id === s.laneChatId,
      go: () => openLaneChat(c.id),
      remove: (e: React.MouseEvent) => { e.stopPropagation(); removeLaneChat(c.id, c.title); },
    }));

    // ---- GENERIC FILTER MENUS --------------------------------------------------
    // One helper drives every "X ▾" dropdown outside People, so they all behave
    // the same: pick a value, the list narrows, the chip shows the selection.
    const mkMenu = (
      key: string, label: string, options: string[], value: string,
      onPick: (v: string) => void,
    ) => ({
      key, label, value, on: value !== 'Any',
      open: s.pfOpen === key,
      toggle: () => set({ pfOpen: s.pfOpen === key ? null : key }),
      options: options.map((o) => ({
        label: o, on: value === o,
        go: () => { onPick(o); set({ pfOpen: null }); },
      })),
      bg: value !== 'Any' ? '#E7F8F1' : 'var(--c-btn-bg)',
      color: value !== 'Any' ? '#0A8560' : '#27272a',
      border: value !== 'Any' ? '#0A8560' : 'var(--c-btn-line)',
    });
    /** mkMenu for several picks (lib/multi-filter): stays open while picks go in and out; Any clears and closes. */
    const mkMultiMenu = (
      key: string, label: string, options: string[], value: string,
      onPick: (v: string) => void,
    ) => ({
      ...mkMenu(key, label, options, value, onPick),
      value: picksLabel(value), multi: true,
      options: options.map((o) => ({
        label: o, on: isPicked(value, o),
        go: () => { onPick(togglePick(value, o)); if (o === 'Any') set({ pfOpen: null }); },
      })),
    });
    const REP_NAMES = Object.values(D.team).map((r) => r.name);
    // One entry per place: "Charlotte, NC", never a spelled-out state name.
    const MARKETS = ['Any', ...Array.from(new Set(people.map((p) => p.market).filter((m) => m && m !== '—')))
      .sort((a, b) => marketLabel(a).localeCompare(marketLabel(b)))];
    const setF = (k: keyof typeof s.gf, v: string) => set((st) => ({ gf: { ...st.gf, [k]: v } }));

    // Deals
    const dealMenus = [
      mkMenu('dealOwner', 'Agent', ['Any', ...Array.from(new Set([...REP_NAMES, ...deals.flatMap((d) => [d.tracker?.acqAgent, d.tracker?.dispoAgent]).filter((x): x is string => !!x)])).sort()], s.gf.dealOwner, (v) => setF('dealOwner', v)),
      mkMenu('dealMarket', 'Market', MARKETS, s.gf.dealMarket, (v) => setF('dealMarket', v)),
      mkMenu('dealStatus', 'Status', ['Any', ...Array.from(new Set(deals.filter((d) => d.stage !== 'Prospect').map((d) => d.tracker?.contractStatus || d.stage || '').filter(Boolean))).sort()], s.gf.dealStatus, (v) => setF('dealStatus', v)),
    ];
    // Dispo
    const dispoMenus = [
      mkMenu('dispoMarket', 'Market', MARKETS, s.gf.dispoMarket, (v) => setF('dispoMarket', v)),
      mkMenu('dispoRep', 'Dispo rep', ['Any', ...REP_NAMES], s.gf.dispoRep, (v) => setF('dispoRep', v)),
    ];
    // Buyers
    // Realtors are paged on the server, so their options come from the corpus facets.
    const realtorStateOptions = [...new Set(realtorMarkets.map((m) => m.state))].map((c) => STATE_NAMES[c] ?? c).sort();
    const realtorState = picksOf(s.gf.buyerState)[0] ?? 'Any';
    const realtorCity = picksOf(s.gf.buyerCity)[0] ?? 'Any';
    const realtorPickedState = realtorState === 'Any' ? null : stateCodeOf(realtorState);
    const realtorCityOptions = [...new Set(realtorMarkets
      .filter((m) => !realtorPickedState || m.state === realtorPickedState)
      .map((m) => (realtorPickedState ? m.city : `${m.city}, ${m.state}`)))].sort((a, b) => a.localeCompare(b));
    const buyerMenus = [
      // A deal already on the pipeline: the list becomes the buyers matched to it, best score first.
      ...(onRealtors ? [] : [mkMenu('buyerDeal', 'Deal', ['Any', ...buyerPipelineMenu.map((d) => d.label)], s.gf.buyerDeal ?? 'Any', (v) => setF('buyerDeal', v))]),
      // Realtors are searched on the server one state and city at a time, so there they stay single picks.
      (onRealtors ? mkMenu : mkMultiMenu)('buyerState', 'State', onRealtors ? ['Any', ...realtorStateOptions] : ['Any', ...stateOptions, ...(unplacedBuyers ? [NO_STATE] : [])], onRealtors ? realtorState : s.gf.buyerState,
        // Changing state drops the city with it: a city belongs to its state.
        (v) => { setRealtorOffset(0); set((st) => ({ gf: { ...st.gf, buyerState: v, buyerCity: 'Any' } })); }),
      (onRealtors ? mkMenu : mkMultiMenu)('buyerCity', 'City', ['Any', ...(onRealtors ? realtorCityOptions : cityOptions)], onRealtors ? realtorCity : s.gf.buyerCity, (v) => { setRealtorOffset(0); setF('buyerCity', v); }),
      mkMultiMenu('buyerEntity', 'Entity', ['Any', ENTITY_LABELS.llc, ENTITY_LABELS.entity, ENTITY_LABELS.individual, ENTITY_LABELS.unclear], s.gf.buyerEntity, (v) => setF('buyerEntity', v)),
      mkMultiMenu('buyerType', 'Type', ['Any', ...Array.from(new Set(buyers.map((b) => b.type)))], s.gf.buyerType, (v) => setF('buyerType', v)),
      mkMultiMenu('buyerStatus', 'Status', ['Any', ...Array.from(new Set(buyers.map((b) => b.status)))], s.gf.buyerStatus, (v) => setF('buyerStatus', v)),
      mkMultiMenu('buyerStage', 'Stage', ['Any', ...BUYER_STAGES], s.gf.buyerStage, (v) => setF('buyerStage', v)),
      // Realtors are corpus rows nobody owns yet; everywhere else, who the buyer is assigned to (migration 128).
      ...(onRealtors ? [] : [mkMultiMenu('buyerOwner', 'Owner', ['Any', ...REP_NAMES, 'Unassigned'], s.gf.buyerOwner ?? 'Any', (v) => setF('buyerOwner', v))]),
      // Everyone who was ever at a stage, wherever they are now (migration 125).
      mkMenu('buyerHistory', 'Ever was', ['Any', ...BUYER_STAGES], s.gf.buyerHistory ?? 'Any', (v) => setF('buyerHistory', v)),
      ...(s.gf.buyerHistory && s.gf.buyerHistory !== 'Any'
        ? [mkMenu('buyerHistoryWhen', 'When', ['Any', ...HISTORY_WHEN.filter((w) => w !== 'Ever' && w !== 'Custom')], s.gf.buyerHistoryWhen ?? 'Any', (v) => setF('buyerHistoryWhen', v))]
        : []),
      mkMultiMenu('buyerPhone', 'Phone', [...PHONE_FILTERS], s.gf.buyerPhone, (v) => setF('buyerPhone', v)),
      mkMultiMenu('buyerEmail', 'Email', [...EMAIL_FILTERS], s.gf.buyerEmail, (v) => setF('buyerEmail', v)),
    ];
    // Tasks
    const taskMenus = [
      mkMenu('taskType', 'Type', ['Any', ...Array.from(new Set(tasks.map((t) => t.type)))], s.gf.taskType, (v) => setF('taskType', v)),
      mkMenu('taskAssigned', 'Assigned', ['Any', ...REP_NAMES, 'Unassigned'], s.gf.taskAssigned, (v) => setF('taskAssigned', v)),
    ];
    const clearGf = () => set({ gf: { dealOwner: 'Any', dealMarket: 'Any', dealStatus: 'Any', dispoMarket: 'Any', dispoRep: 'Any', buyerState: 'Any', buyerCity: 'Any', buyerEntity: 'Any', buyerType: 'Any', buyerStatus: 'Any', buyerStage: 'Any', buyerPhone: 'Any', buyerEmail: 'Any', buyerOwner: 'Any', buyerHistory: 'Any', buyerHistoryWhen: 'Any', buyerHistoryFrom: 'Any', buyerHistoryTo: 'Any', buyerDeal: 'Any', taskType: 'Any', taskAssigned: 'Any' }, pfOpen: null });

    // ---- ACTION PLANS ----------------------------------------------------------
    // Plans live in the graph; edits copy a seed plan into session state and
    // write there, so the seed data stays the baseline. Enrolling a seller shows
    // on their record and in the plan's own enrolled count.
    const PLAN_CHANNELS = ['sms', 'call', 'email', 'task'];
    const CHAN_TONE: Record<string, { label: string; color: string; bg: string }> = {
      sms: { label: 'SMS', color: '#e6142e', bg: '#ffe9ec' },
      call: { label: 'Call', color: '#e6142e', bg: '#ffe9ec' },
      email: { label: 'Email', color: '#52525b', bg: '#f4f4f5' },
      task: { label: 'Task', color: '#d97706', bg: '#fffbeb' },
    };
    const planOf = (id: string) => plans.find((pl) => pl.id === id) || plans[0] || BLANK_PLAN;
    const enrolledIn = (planId: string) => enrollments.filter((e) => e.planId === planId);
    /** Writes a plan into session state, cloning a seed plan on first edit. */
    const upsertPlan = (plan: ActionPlan) =>
      set((st) => ({
        newPlans: st.newPlans.some((pl) => pl.id === plan.id)
          ? st.newPlans.map((pl) => (pl.id === plan.id ? plan : pl))
          : [...st.newPlans, plan],
      }));
    const editStep = (stepId: string, patch: Partial<PlanStep>) => {
      const pl = planOf(s.planId);
      upsertPlan({ ...pl, steps: pl.steps.map((st) => (st.id === stepId ? { ...st, ...patch } : st)) });
    };
    const PL = planOf(s.planId);
    const planRows = plans.map((pl) => {
      const n = enrolledIn(pl.id).length;
      return {
        id: pl.id, name: pl.name, trigger: pl.trigger, description: pl.description,
        steps: pl.steps.length, enrolled: n, active: pl.active,
        current: pl.id === s.planId,
        go: () => set({ planId: pl.id }),
        toggle: (e?: { stopPropagation?: () => void }) => {
          if (e && e.stopPropagation) e.stopPropagation();
          upsertPlan({ ...pl, active: !pl.active });
          toast(pl.name + (pl.active ? ' paused' : ' activated'));
        },
        bg: pl.id === s.planId ? '#E7F8F1' : '#fff',
        border: pl.id === s.planId ? '#0A8560' : '#e4e4e7',
        statusColor: pl.active ? '#16a34a' : '#a1a1aa',
        statusLabel: pl.active ? 'Active' : 'Paused',
      };
    });
    const planSteps = PL.steps.map((st, i) => {
      const tone = CHAN_TONE[st.channel] || CHAN_TONE.task;
      return {
        id: st.id, n: i + 1, channel: st.channel, delay: st.delay, title: st.title, content: st.content,
        label: tone.label, color: tone.color, bg: tone.bg,
        generated: st.generated,
        setChannel: (e: React.ChangeEvent<HTMLSelectElement>) => editStep(st.id, { channel: e.target.value }),
        setDelay: (e: React.ChangeEvent<HTMLInputElement>) => editStep(st.id, { delay: e.target.value }),
        setTitle: (e: React.ChangeEvent<HTMLInputElement>) => editStep(st.id, { title: e.target.value }),
        setContent: (e: React.ChangeEvent<HTMLTextAreaElement>) => editStep(st.id, { content: e.target.value }),
        remove: () => {
          upsertPlan({ ...PL, steps: PL.steps.filter((x) => x.id !== st.id) });
          toast('Step removed');
        },
        moveUp: i === 0 ? null : () => {
          const arr = [...PL.steps];
          [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          upsertPlan({ ...PL, steps: arr });
        },
        canMoveUp: i > 0,
      };
    });
    const planChannelOptions = PLAN_CHANNELS.map((c) => ({ v: c, label: CHAN_TONE[c].label }));
    const addPlanStep = () => {
      const id = nextId('st');
      upsertPlan({
        ...PL,
        steps: [...PL.steps, { id, channel: 'sms', delay: 'Day 1', title: 'New step', content: '', generated: false }],
      });
      toast('Step added');
    };
    const newPlan = () => {
      const id = nextId('ap');
      const pl: ActionPlan = {
        id, name: 'Untitled plan', trigger: 'Manual enrollment', active: false,
        description: '', steps: [{ id: id + 's1', channel: 'sms', delay: 'Immediately', title: 'First touch', content: '', generated: false }],
      };
      set((st) => ({ newPlans: [...st.newPlans, pl], planId: id, screen: 'plans' }));
      toast(canWrite ? 'New plan — edit it, then Save' : 'Plan created');
    };
    /**
     * Write the plan in view to the database. Edits stay in session state
     * while you type (instant), and this commits them; after the write the
     * workspace is re-read so the plan carries its real id.
     */
    const savePlanNow = () => {
      if (!canWrite) return toast('Saved (demo)');
      void savePlanWrite(workspaceId, {
        id: PL.id, name: PL.name, trigger: PL.trigger, active: PL.active,
        steps: PL.steps.map((st) => ({ channel: st.channel, delay: st.delay, title: st.title, content: st.content })),
      }, me).then((r) => {
        if (!r.ok) return toast(r.message || 'Could not save the plan.', 'error');
        // Drop the session copy so the re-read is what shows.
        set((st) => ({ newPlans: st.newPlans.filter((pl) => pl.id !== PL.id), planId: 'ap' + r.id }));
        reload?.();
        toast('Plan saved', 'success');
      });
    };
    const deletePlanNow = async () => {
      if (!(await confirm({ title: `Delete “${PL.name}”?`, body: 'Anyone enrolled comes off it.', confirmLabel: 'Delete plan', tone: 'danger' }))) return;
      if (!canWrite || !/^ap\d+$/.test(PL.id)) {
        set((st) => ({ newPlans: st.newPlans.filter((pl) => pl.id !== PL.id), planId: '' }));
        return toast('Plan removed');
      }
      void deletePlanWrite(PL.id).then((r) => {
        if (!r.ok) return toast(r.message || 'Could not delete the plan.', 'error');
        set({ planId: '' });
        reload?.();
        toast('Plan deleted', 'success');
      });
    };
    /** Replace the plan in view with what Claude drafted; nothing is saved until Save. */
    const applyDraft = (d: { name: string; trigger: string; description: string; steps: { channel: string; delay: string; title: string; content: string }[] }) => {
      const base = nextId('ap');
      upsertPlan({
        ...PL, name: d.name, trigger: d.trigger, description: d.description,
        steps: d.steps.map((st, i) => ({ id: base + 's' + i, channel: st.channel, delay: st.delay, title: st.title, content: st.content, generated: true })),
      });
    };
    const draftPlanWithAi = () => {
      const goal = window.prompt('What should this sequence do?', 'Follow up a direct-mail lead who has not answered — 5 touches over 2 weeks');
      if (!goal?.trim()) return;
      if (!canWrite) return toast('AI drafting needs a signed-in workspace');
      set({ planDrafting: true });
      void draftPlan(workspaceId, { mode: 'goal', goal: goal.trim(), trigger: PL.trigger }).then((r) => {
        set({ planDrafting: false });
        if (!r.ok) return toast(r.message, 'error');
        applyDraft(r.plan);
        toast('Drafted — read it through, then Save');
      });
    };
    /**
     * The "AI action plan" for one seller: Claude reads every call, text,
     * email and note on the record and writes a sequence for that person.
     * It is created, saved and the seller enrolled in one go.
     */
    const aiPlanForLead = () => {
      if (!canWrite) return toast('AI plans need a signed-in workspace');
      set({ planDrafting: true });
      void draftPlan(workspaceId, { mode: 'lead', sellerId: dbId(P.id) }).then(async (r) => {
        if (!r.ok) { set({ planDrafting: false }); return toast(r.message, 'error'); }
        const saved = await savePlanWrite(workspaceId, {
          id: null, name: r.plan.name, trigger: r.plan.trigger, active: true,
          steps: r.plan.steps.map((st) => ({ channel: st.channel, delay: st.delay, title: st.title, content: st.content })),
        }, me);
        if (!saved.ok || !saved.id) { set({ planDrafting: false }); return toast(saved.message || 'Could not save the plan.', 'error'); }
        const en = await enrollInPlan(workspaceId, 'ap' + saved.id, P.id, me);
        set({ planDrafting: false });
        if (!en.ok) return toast(en.message || 'Plan saved, but enrolment failed.', 'error');
        reload?.();
        toast(P.name.split(' ')[0] + ' enrolled in "' + r.plan.name + '"'
          + (en.queued ? ' · ' + en.queued + ' touches queued' : ''), 'success');
      });
    };
    const setPlanName = (e: React.ChangeEvent<HTMLInputElement>) => upsertPlan({ ...PL, name: e.target.value });
    const setPlanTrigger = (e: React.ChangeEvent<HTMLInputElement>) => upsertPlan({ ...PL, trigger: e.target.value });

    // Enrollment
    const enrollmentFor = (pid: string) => enrollments.find((e) => e.personId === pid && e.status !== 'done');
    const enroll = (planId: string, personId: string) => {
      if (canWrite) {
        void enrollInPlan(workspaceId, planId, personId, me).then((r) => {
          if (!r.ok) return toast(r.message || 'Could not enroll.', 'error');
          if (r.already) return toast('Already on that plan');
          reload?.();
          // The plan's steps are now dated work, so say so — an enrolment that
          // reports nothing is what made the old one look like it did nothing.
          if (r.queued) toast(r.queued + (r.queued === 1 ? ' touch queued' : ' touches queued') + ' on the calendar', 'success');
        });
      }
      setS((prev) => {
        const already = [...D.enrollments, ...prev.newEnrollments]
          .some((e) => e.personId === personId && e.planId === planId && e.status !== 'done');
        if (already) return { ...prev, toast: 'Already enrolled', toastSeq: prev.toastSeq + 1 };
        const p = [...D.people, ...prev.newPeople].find((x) => x.id === personId);
        return {
          ...prev,
          newEnrollments: [...prev.newEnrollments,
            { id: nextId('en'), personId, planId, step: 1, status: 'active', note: '' }],
          toast: (p ? p.name : 'Seller') + ' enrolled',
          toastSeq: prev.toastSeq + 1,
        };
      });
    };
    const holdPlan = (personId: string, pause: boolean) => {
      const cur = enrollments.find((e) => e.personId === personId && e.status !== 'done');
      const live = cur && /^en\d+$/.test(cur.id) ? cur : null;
      if (canWrite && live) {
        const run = pause ? pauseEnrollment(dbId(live.id), 'manual') : resumeEnrollment(dbId(live.id));
        void run.then((r) => (r.ok ? reload?.() : toast(r.message || (pause ? 'Could not pause the plan.' : 'Could not play the plan.'), 'error')));
      }
      if (!cur) return;
      setS((prev) => ({
        ...prev,
        newEnrollments: [
          ...prev.newEnrollments.filter((e) => !(e.personId === personId && (e.planId === '' || e.planId === cur.planId))),
          { ...cur, status: pause ? 'paused' : 'active', note: pause ? 'Paused' : '' },
        ],
        toast: pause ? 'Action plan paused' : 'Action plan playing',
        toastSeq: prev.toastSeq + 1,
      }));
    };
    const unenroll = (personId: string) => {
      // Stop it in the database too; before this the stop only lived in this tab.
      const live = enrollments.find((e) => e.personId === personId && e.status !== 'done' && /^en\d+$/.test(e.id));
      if (canWrite && live) {
        void stopEnrollment(dbId(live.id)).then((r) => (r.ok ? reload?.() : toast(r.message || 'Could not stop the plan.', 'error')));
      }
      setS((prev) => ({
        ...prev,
        // Drop a session enrollment outright; mask a seed one by marking it done.
        newEnrollments: prev.newEnrollments
          .filter((e) => e.personId !== personId)
          .concat(D.enrollments.some((e) => e.personId === personId)
            ? [{ id: 'en_off_' + personId, personId, planId: '', step: 0, status: 'done', note: 'Stopped' }]
            : []),
        toast: 'Action plan stopped', toastSeq: prev.toastSeq + 1,
      }));
    };
    const unenrollBuyer = (buyerId: string) => {
      const live = enrollments.find((e) => e.buyerId === buyerId && e.status !== 'done' && /^en\d+$/.test(e.id));
      if (canWrite && live) {
        void stopEnrollment(dbId(live.id)).then((r) => (r.ok ? reload?.() : toast(r.message || 'Could not stop the plan.', 'error')));
      }
      setS((prev) => ({
        ...prev,
        newEnrollments: prev.newEnrollments
          .filter((e) => e.buyerId !== buyerId)
          .concat(D.enrollments.some((e) => e.buyerId === buyerId)
            ? [{ id: 'en_off_' + buyerId, personId: '', buyerId, planId: '', step: 0, status: 'done', note: 'Stopped' }]
            : []),
        toast: 'Action plan stopped', toastSeq: prev.toastSeq + 1,
      }));
    };
    const enrollBuyer = (planId: string, buyerId: string) => {
      if (canWrite) {
        if (workspaceId === null) return toast('Sign in to enroll buyers.');
        const b = buyers.find((x) => x.id === buyerId);
        void enrollBuyerInPlan(workspaceId, planId, buyerId, me, { name: b?.name ?? '', company: b?.company ?? '' }).then((r) => {
          if (!r.ok) return toast(r.message || 'Could not enroll.', 'error');
          if (r.already) return toast('Already on that plan');
          reload?.();
          if (r.queued) toast(r.queued + (r.queued === 1 ? ' touch queued' : ' touches queued') + ' on the calendar', 'success');
          else toast((b?.name || 'Buyer') + ' enrolled', 'success');
        });
      }
      setS((prev) => {
        const already = [...D.enrollments, ...prev.newEnrollments]
          .some((e) => e.buyerId === buyerId && e.planId === planId && e.status !== 'done');
        if (already) return { ...prev, toast: 'Already enrolled', toastSeq: prev.toastSeq + 1 };
        const b = [...D.buyers, ...prev.newBuyers].find((x) => x.id === buyerId);
        return {
          ...prev,
          newEnrollments: [...prev.newEnrollments,
            { id: nextId('en'), personId: '', buyerId, planId, step: 1, status: 'active', note: '' }],
          toast: (b ? b.name : 'Buyer') + ' enrolled',
          toastSeq: prev.toastSeq + 1,
        };
      });
    };
    const planEnrolled = enrolledIn(PL.id).map((e) => {
      const p = person(e.personId);
      return {
        id: e.id, name: p ? p.name : e.personId, addr: p ? p.property.addr : '',
        step: e.step, total: PL.steps.length, status: e.status,
        pct: Math.round((e.step / Math.max(1, PL.steps.length)) * 100) + '%',
        color: e.status === 'active' ? '#16a34a' : '#d97706',
        go: () => (p ? openPerson(p.id) : undefined),
        stop: () => unenroll(e.personId),
      };
    });
    const planEnrolledCount = planEnrolled.length;
    // Enrol from the plan screen: any seller not already on this plan.
    /** Buyers already on the Buyers list. The deal sheet's Buyer field reads this, not a second query. */
    const sheetBuyers = lazy(() => buyers
      .filter((b) => !secretHidden(b.id, b.tags))
      .map((b) => ({ id: b.id, name: b.name, company: b.company, prospectList: b.prospectList ?? null, createdAt: b.createdAt ?? null })));
    const planCandidates = lazy(() => {
      const onPlan = new Set(enrolledIn(PL.id).map((e) => e.personId));
      return people.filter((p) => !onPlan.has(p.id)).map((p) => ({ id: p.id, label: p.name + ' · ' + p.property.addr }));
    });
    const enrollPick = (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) enroll(PL.id, e.target.value);
    };

    // The seller record's action-plan card, now backed by real enrollment.
    const myEnrollment = enrollmentFor(P.id);
    const myPlan = myEnrollment ? plans.find((pl) => pl.id === myEnrollment.planId) : null;
    const personPlan = myPlan && myEnrollment
      ? {
          name: myPlan.name, step: myEnrollment.step, total: myPlan.steps.length,
          pct: Math.round((myEnrollment.step / Math.max(1, myPlan.steps.length)) * 100) + '%',
          next: myPlan.steps[Math.min(myEnrollment.step, myPlan.steps.length - 1)],
          nextLabel: 'Next: ' + (myPlan.steps[Math.min(myEnrollment.step, myPlan.steps.length - 1)]?.title || '—'),
          paused: myEnrollment.status === 'paused',
          statusNote: myEnrollment.note || (myEnrollment.status === 'paused' ? 'Paused' : 'Playing'),
          open: () => go('plans', { planId: myPlan.id, planReturnTo: 'person' }),
          pause: () => holdPlan(P.id, true),
          resume: () => holdPlan(P.id, false),
          stop: () => unenroll(P.id),
        }
      : null;
    const hasPersonPlan = !!personPlan;
    const planPickerOptions = plansForRecord(plans, 'seller').map((pl) => ({ v: pl.id, label: pl.name }));
    const buyerPlanPickerOptions = plansForRecord(plans, 'buyer').map((pl) => ({ v: pl.id, label: pl.name }));
    const vendorPlanPickerOptions = plansForRecord(plans, 'vendor').map((pl) => ({ v: pl.id, label: pl.name }));
    const startPlanFor = (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) enroll(e.target.value, P.id);
    };
    const myBuyerEnrollment = enrollments.find((e) => e.buyerId === B.id && e.status !== 'done') ?? null;
    const myBuyerPlan = myBuyerEnrollment ? plans.find((pl) => pl.id === myBuyerEnrollment.planId) : null;
    const buyerPlan = myBuyerPlan && myBuyerEnrollment
      ? {
          name: myBuyerPlan.name, step: myBuyerEnrollment.step, total: myBuyerPlan.steps.length,
          pct: Math.round((myBuyerEnrollment.step / Math.max(1, myBuyerPlan.steps.length)) * 100) + '%',
          nextLabel: 'Next: ' + (myBuyerPlan.steps[Math.min(myBuyerEnrollment.step, myBuyerPlan.steps.length - 1)]?.title || '—'),
          statusNote: myBuyerEnrollment.note || (myBuyerEnrollment.status === 'paused' ? 'Paused' : 'Running'),
          open: () => go('plans', { planId: myBuyerPlan.id, planReturnTo: 'buyer' }),
          stop: () => unenrollBuyer(B.id),
        }
      : null;
    const hasBuyerPlan = !!buyerPlan;
    const startBuyerPlanFor = (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) enrollBuyer(e.target.value, B.id);
    };

    // ---- SWEEP: remaining controls --------------------------------------------
    // Call dispositions log the call and close the wrap-up, same as the wrap
    // buttons already did.
    const dispositions = ['Interested', 'Appointment set', 'Callback', 'Not interested']
      .map((label) => ({
        label,
        go: () => {
          if (!phoneEnabled) return finishCall('Call logged · ' + label);
          // The chip logs the disposition on Talkr; the call itself keeps going
          // until End call, and the wrap-up card still follows.
          void phone.disposition(label).then((used) => toast(used ? 'Disposition · ' + used : 'Noted · ' + label + ' (no matching Talkr disposition)'));
        },
      }));
    // Notification category filter.
    const notifCatFilter = ['All', 'Mention', 'Call', 'SMS', 'Seller', 'Buyer', 'Dispo', 'Offer', 'Task', 'TC', 'System'].map((c) => ({
      c, on: s.notifCat === c,
      go: () => set({ notifCat: c }),
      bg: s.notifCat === c ? '#18181b' : '#fff',
      color: s.notifCat === c ? '#fff' : '#52525b',
    }));
    // Buyer record tabs.
    const buyerTabs = ['Activity', 'Offers', 'Purchases', 'Campaigns', 'Contracts', 'Notes'].map((t) => ({
      label: t, active: s.buyerTab === t,
      go: () => set({ buyerTab: t }),
      color: s.buyerTab === t ? '#18181b' : '#71717a',
      border: s.buyerTab === t ? '#18181b' : 'transparent',
    }));
    // Export the current table as CSV. Runs entirely in the browser — this app
    // is a static export, so there is no server to generate a file.
    const exportCsv = (name: string, header: string[], rows: (string | number)[][]) => {
      const esc = (v: string | number) => '"' + String(v).replace(/"/g, '""') + '"';
      const csv = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      toast('Exported ' + name);
    };
    const exportPeople = () => exportCsv('people.csv',
      peopleColumns.map((c) => c.label),
      peopleRows.map((r) => r.cells.map((c) => String(c.v))));
    const exportReport = () => exportCsv(`reporting-${reportTab.toLowerCase().replace(/\s+/g, '-')}-${s.reportRange.toLowerCase().replace(/\s+/g, '-')}.csv`,
      [reportTab, s.reportRange, ''], reportCsv(reportBlocks()));
    const copyText = (label: string, text: string) => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => toast(label + ' copied'), () => toast('Copy blocked by the browser'));
      } else toast('Clipboard unavailable');
    };
    const copyReportLink = () => copyText('Report link', 'https://clozr.link/r/' + P.id);
    const copySellerPitch = () => copyText('Seller pitch',
      P.name + ' — ' + P.property.addr + '. ARV ' + fmt(recDealOf(P.id)?.arv)
      + ', rehab ' + fmt(recDealOf(P.id)?.rehab) + '. Offer ' + (P.offer || 'TBD') + '.');
    // Add a tag to the seller on the record.
    const addTag = () => {
      const t = (typeof window !== 'undefined' ? window.prompt('New tag') : '') || '';
      if (!t.trim()) return;
      if (canWrite) {
        // Before this the tag only lived in this tab and was gone on reload.
        return void tagSellers([P.id], t).then((r) => { if (!r.ok) return toast(r.message || 'Tag did not save.', 'error'); refreshPerson(P.id); toast('Tag added · ' + t.trim(), 'success'); });
      }
      setS((prev) => {
        const base = [...D.people, ...prev.newPeople].find((x) => x.id === prev.personId);
        if (!base) return prev;
        const updated: Person = { ...base, tags: [...base.tags, t.trim()] };
        return {
          ...prev,
          newPeople: prev.newPeople.some((x) => x.id === base.id)
            ? prev.newPeople.map((x) => (x.id === base.id ? updated : x))
            : [...prev.newPeople, updated],
          toast: 'Tag added · ' + t.trim(), toastSeq: prev.toastSeq + 1,
        };
      });
    };

    // ---- INBOX ----
    const inboxChannels = ['All', 'SMS', 'Email', 'Calls', 'Voicemail'].map((c) => ({
      label: c, go: () => set({ inboxChannel: c }),
      bg: s.inboxChannel === c ? '#fff' : 'transparent',
      color: s.inboxChannel === c ? '#18181b' : '#71717a',
      shadow: s.inboxChannel === c ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
    }));
    const inboxFilters = ['Mine', 'Team', 'Unread', 'Assigned', 'Unassigned'].map((f) => ({
      label: f, go: () => set({ inboxFilter: f }),
      bg: s.inboxFilter === f ? '#E7F8F1' : 'transparent',
      color: s.inboxFilter === f ? '#0A8560' : '#52525b',
    }));
    const chMap: Record<string, string> = { SMS: 'sms', Email: 'email', Calls: 'call', Voicemail: 'voicemail' };
    const inboxConvs = D.inbox
      .filter((m) => s.inboxChannel === 'All' || m.channel === chMap[s.inboxChannel])
      .filter((m) => (s.inboxFilter === 'Unread' ? m.unread > 0 : s.inboxFilter === 'Unassigned' ? !m.assigned : true))
      .map((m) => ({
        ...convOf(m), active: s.inboxConv === m.id,
        bg: s.inboxConv === m.id ? '#f4f4f5' : '#fff',
        go: () => set({ inboxConv: m.id }),
      }));
    const IC = inboxConvs.find((c) => c.id === s.inboxConv)
      || convOf(D.inbox.find((m) => m.id === s.inboxConv) || D.inbox[0] || BLANK_INBOX);
    const icMsgs: [string, string, string][] = IC.id === 'i1'
      ? msgs
      : [['in', IC.preview, IC.time], ['out', "Thanks — on it. I'll follow up shortly.", IC.time]];
    const inboxMsgs = withSent(icMsgs, 'inbox:' + IC.id).map(([dir, text, time]) => ({
      text, time, isSys: dir === 'sys',
      align: dir === 'out' ? 'flex-end' : 'flex-start',
      bg: dir === 'out' ? '#18181b' : dir === 'sys' ? 'transparent' : '#f4f4f5',
      color: dir === 'out' ? '#fff' : dir === 'sys' ? '#71717a' : '#18181b',
    }));
    const icBuyer = IC.who as unknown as (typeof D.buyers)[number];
    const icPerson = IC.who as Person;
    const inboxContext: [string, string][] = IC.isBuyer
      ? [
        ['Company', icBuyer.company], ['Status', icBuyer.status], ['Markets', icBuyer.markets.join(', ')],
        ['Buy box', icBuyer.buyBox.price + ' · ' + icBuyer.buyBox.type], ['Engagement', icBuyer.engagement + ' / 100'],
      ]
      : [
        ['Property', icPerson.property.addr + ', ' + icPerson.property.city], ['Stage', IC.stage],
        ['Assigned', IC.assigned], ['Score', icPerson.score != null ? icPerson.score + ' · ' + (icPerson.score >= 85 ? 'HOT' : 'WARM') : leadTemp(icPerson) || '—'],
        ['Next task', icPerson.nextTask], ['Offer', icPerson.offer || '—'],
      ];
    const inboxCtx = inboxContext.map(([k, v]) => ({ k, v }));
    const openInboxRecord = () => (IC.isBuyer ? openBuyer(IC.who.id) : openPerson(IC.who.id));

    // ---- TASKS ----
    // Which tasks each view lists and counts (lib/task-views): Today leads with
    // the overdue ones, and the counts are of open tasks, as the lists are.
    const isDone = (t: (typeof tasks)[number]) => (s.tasksDone[t.id] ?? (t.bucket === 'completed' || t.done)) === true;
    const tasksViews = TASK_VIEWS.map((label) => ({
      label, count: tasks.filter((t) => inTaskView(label, t, isDone(t), ME)).length, go: () => set({ tasksView: label }),
      on: s.tasksView === label,
      bg: s.tasksView === label ? '#E7F8F1' : 'transparent',
      color: s.tasksView === label ? '#0A8560' : '#27272a',
    }));
    // Snooze moves the due date to tomorrow at 9 AM local, and leaves the tick
    // alone: it used to write tasksDone[id] = false, which re-opened a task
    // that was already done while moving nothing.
    const snoozeTask = (id: string) => {
      const due = new Date();
      due.setDate(due.getDate() + 1);
      due.setHours(9, 0, 0, 0);
      persistTaskDue(id, due, 'Snoozed to tomorrow 9 AM');
    };
    // A done task leaves every list but Completed; one just ticked stays long
    // enough to fade out (taskLeaving), so the tick reads as "gone", not "stuck".
    const viewed = tasks.filter((t) => inTaskView(s.tasksView, t, isDone(t) && (s.tasksView === 'Completed' || !s.taskLeaving[t.id]), ME));
    const taskLookRows = {
      hasPerson: (id: string) => !!person(id),
      sellerOfDeal: (dealId: string) => deals.find((d) => d.id === dealId)?.personId ?? null,
      hasBuyer: (id: string) => !!buyer(id),
    };
    const openTaskFromList = (t: Task) => {
      const rec = taskRecordOf(t, taskLookRows);
      if (!rec) {
        toast('This task has no seller on it.', 'info');
        return;
      }
      if (rec.kind === 'buyer') return openBuyer(rec.id);
      if (!rec.id && rec.dealId) return go('dealSheet', { personId: '', dealSheetDealId: rec.dealId });
      if (t.note && (t.type === 'text' || t.type === 'email') && rec.id) {
        return go('person', {
          personId: rec.id,
          personTab: 'Activity',
          personDealId: rec.dealId ?? null,
          composerTab: t.type === 'text' ? 'Text' : 'Email',
          composerText: t.note,
        });
      }
      return openPersonDeal(rec.id, rec.dealId);
    };
    const taskRows = (s.tasksView === 'Today' ? overdueFirst(viewed) : viewed)
      .filter((t) => s.gf.taskType === 'Any' || t.type === s.gf.taskType)
      .filter((t) => s.gf.taskAssigned === 'Any'
        || (s.gf.taskAssigned === 'Unassigned' ? !t.assigned : repName(t.assigned) === s.gf.taskAssigned))
      .map((t) => {
      const rec = taskRecordOf(t, taskLookRows);
      const p = rec?.kind === 'person' && rec.id ? (person(rec.id) ?? BLANK_PERSON) : BLANK_PERSON;
      const buyerRow = rec?.kind === 'buyer' ? buyer(rec.id) : undefined;
      const done = isDone(t);
      return {
        leaving: !!s.taskLeaving[t.id] && s.tasksView !== 'Completed',
        focused: s.taskFocus === t.id,
        id: t.id, title: t.title,
        person: buyerRow?.name || p.name, addr: buyerRow ? '—' : p.property.addr, type: t.type, due: done ? t.due : dueLabel(t.due, t.bucket),
        dueColor: !done && t.bucket === 'overdue' ? '#dc2626' : /Overdue/.test(t.due) ? '#dc2626' : /Now|Today/.test(t.due) ? '#18181b' : '#71717a',
        assigned: repName(t.assigned), assignedColor: t.assigned ? '#27272a' : '#dc2626',
        priority: t.priority,
        prColor: t.priority === 'Urgent' ? '#dc2626' : t.priority === 'High' ? '#d97706' : t.priority === 'Medium' ? '#0A8560' : '#71717a',
        done, deco: done ? 'line-through' : 'none', textColor: done ? '#a1a1aa' : '#18181b',
        note: t.note ?? '', hasNote: !!t.note,
        toggle: () => {
          set((st) => ({ tasksDone: { ...st.tasksDone, [t.id]: !done }, taskLeaving: !done ? { ...st.taskLeaving, [t.id]: true } : st.taskLeaving }));
          persistTask(t.id, !done);
          if (!done) {
            setTimeout(() => set((st) => { const l = { ...st.taskLeaving }; delete l[t.id]; return { taskLeaving: l }; }), 520);
            // The row is gone in half a second, so a mis-tick needs a way back:
            // Undo re-opens the task, on screen and in the database. A failed
            // write's error toast replaces this one.
            toast('Task done: ' + t.title, 'info', {
              label: 'Undo',
              run: () => {
                set((st) => { const l = { ...st.taskLeaving }; delete l[t.id]; return { tasksDone: { ...st.tasksDone, [t.id]: false }, taskLeaving: l }; });
                persistTask(t.id, false);
              },
            });
          }
        },
        // Opens the seller (or deal / buyer) the task is on — never a blank
        // "Pick a seller" screen. A plan step still lands with its message in
        // the composer when there is one.
        open: () => openTaskFromList(t),
        call: () => (p.id ? startCall({ name: p.name, phone: p.phone, personId: p.id }) : undefined),
        snooze: () => snoozeTask(t.id),
      };
    });

    // ---- CALENDAR ----
    const calDays = D.calendar.map((d) => ({
      day: d.day, today: d.day === 'Thu 4',
      items: d.items.map((it) => ({
        ...it,
        color: ({
          Team: '#71717a', Dispo: '#ff7a45', Call: '#e6142e',
          TC: '#1f7a4d', Appointment: '#16a34a', Offer: '#d97706',
        } as Record<string, string>)[it.kind],
      })),
    }));

    // ---- REPORTING ----
    // Profitability carries commissions and the bank feed: owner/admin only
    // (the demo, with no role, shows it). A hidden tab left selected falls back.
    const reportAdmin = isAdmin(role);
    const reportTab = REPORT_TABS.includes(s.reportTab) && (reportAdmin || s.reportTab !== 'Profitability') ? s.reportTab : 'Overview';
    const reportTabs = REPORT_TABS.filter((t) => reportAdmin || t !== 'Profitability').map((t) => ({
      label: t, go: () => set({ reportTab: t }),
      color: reportTab === t ? '#18181b' : '#71717a',
      border: reportTab === t ? '#18181b' : 'transparent',
    }));
    const reportRanges = REPORT_RANGES.map((r) => ({
      label: r, go: () => set({ reportRange: r }),
      bg: s.reportRange === r ? '#18181b' : '#fff',
      color: s.reportRange === r ? '#fff' : '#27272a',
    }));
    // The rows behind every tab: the workspace's own, or the sample graph laid
    // over recent weeks on /demo. Only built while Reporting is open.
    const reportRaw: ReportRaw | null = s.screen !== 'reporting' && s.screen !== 'leaderboard' ? null
      : live ? ((live.reporting as { raw?: ReportRaw } | undefined)?.raw ?? null)
        : sampleReportRaw(MOCK as unknown as Parameters<typeof sampleReportRaw>[0]);
    const floorRaw: ReportRaw | null = live ? ((live.reporting as { raw?: ReportRaw } | undefined)?.raw ?? null) : null;
    const floorMail = (D.timeline ?? []).flatMap((e) => {
      if (!e.email) return [];
      const who = e.entity ? person(e.entity) : undefined;
      const ownerId = who?.assigned ?? null;
      return [{
        id: e.id,
        subject: e.email.subject,
        body: (e.email.body || e.body || '').slice(0, 800),
        who: e.who,
        ownerId,
        ownerName: ownerId ? (D.team[ownerId]?.name ?? '') : '',
      }];
    }).slice(0, 120);
    // The builder tab draws itself (components/reporting/custom); nothing to compute here.
    const reportBlocks = () => (reportRaw && reportTab !== CUSTOM_TAB ? buildReport(reportTab, s.reportRange, reportRaw, { admin: reportAdmin }) : []);
    const reportRangeBounds = rangeOf(s.reportRange);

    // ---- NOTIFICATIONS ----
    // Marking one read, or all of them, drops it from the bell. A real note
    // gets read_at; a missed call or text is remembered for this member on the
    // server (migration 189), so it stays gone on every device, and in this
    // browser, which is all there is until 189 is applied.
    const dismissNotifIds = (ids: string[]) => {
      const fresh = ids.filter((id) => !sRef.current.notifRead[id]);
      if (!fresh.length) return;
      set((st) => ({ notifRead: mergeDismissed(st.notifRead, fresh) }));
      const db = notificationDbIds(fresh);
      if (canWrite && db.length) void markNotificationsRead(fresh);
      if (canWrite && workspaceId !== null && me) void saveBellDismissals(workspaceId, me, fresh);
      saveDismissedNotifs([...loadDismissedNotifs(), ...fresh]);
    };
    // A text thread or call read in the Inbox: that number's texts and missed
    // calls leave the bell too (and stay gone elsewhere, through the above).
    const bellReadNumber = (num: string) => {
      const tail = phoneTail(num);
      if (tail.length < 10) return;
      const numbersOf = (n: Notification) => [
        n.phone, n.link.phone, n.link.screen === 'inboxSms' ? n.link.id : null,
        n.link.screen === 'person' ? person(n.link.id)?.phone : n.link.screen === 'buyer' ? buyer(n.link.id)?.phone : null,
      ];
      dismissNotifIds(myNotifications
        .filter((n) => (n.id.startsWith('bell-') || n.link.screen === 'inboxSms' || /sms|call|voicemail/i.test(n.cat))
          && numbersOf(n).some((v) => phoneTail(v) === tail))
        .map((n) => n.id));
    };
    // Mute quiets one kind of alert for an hour (muteCat): the bell says what
    // is muted, until when, with an Unmute.
    const notifMutes = Object.entries(s.mutedUntil).filter(([cat]) => s.mutedCats[cat]).map(([cat, until]) => ({
      cat, label: mutedLabel(cat), until: new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      unmute: () => unmuteCat(cat),
    }));
    const notifs = visibleNotifs(myNotifications, s.notifRead, s.notifCat, notifMuted).map((n) => {
      const markRead = () => dismissNotifIds([n.id]);
      return {
        ...n, isUnread: n.unread && !s.notifRead[n.id],
        bg: n.unread && !s.notifRead[n.id] ? '#fff' : '#fafafa',
        catColor: ({
          Seller: typeTone('Seller').fg, Buyer: typeTone('Buyer').fg, Dispo: '#ff7a45', Offer: '#16a34a',
          Task: '#d97706', TC: '#1f7a4d', System: '#71717a', Mention: '#0A8560',
          Call: '#e6142e', SMS: '#2563eb',
          Badge: '#c4a35a', Leaderboard: '#0e7a57', Wheel: '#b45309', Contract: '#12946a', Lane: LANE,
        } as Record<string, string>)[n.cat],
        // Nothing to open (an import summary, an email open): no button.
        actionLabel: n.link.screen === 'leaderboard' || ['Badge', 'Leaderboard', 'Wheel', 'Contract'].includes(n.cat) ? 'Leaderboard'
          : n.link.screen === 'inboxSms' ? 'Open in Inbox' : n.link.screen === 'lane' ? 'Open Lane'
          : n.link.screen === 'settings' ? 'Open numbers' : n.link.screen === 'contracts' ? 'Open Contracts'
          : n.link.tab === 'Texts' ? 'Open texts' : n.link.tab === 'Calls' ? 'Open calls' : n.link.tab === 'Notes' ? 'Open note'
          : n.link.screen === 'home' ? '' : 'Open record',
        // The exact spot it is about (lib/notif-target): the record on its tab,
        // pinned to the deal, the text thread, the numbers in Settings.
        open: () => {
          markRead();
          const l = n.link;
          const gap = sectionGapList.find((g) => g.id === n.id);
          if (gap) go('dealSheet', { personId: gap.personId, dealSheetDealId: gap.dealId });
          else if (l.screen === 'leaderboard' || ['Badge', 'Leaderboard', 'Wheel', 'Contract'].includes(n.cat)) go('leaderboard');
          else if (l.screen === 'person') {
            go('person', { personId: l.id, personTab: l.tab || 'Activity', personDealId: l.dealId ?? null });
            noteRecent('person:' + l.id);
          } else if (l.screen === 'buyer') {
            openBuyer(l.id);
            set({ buyerTab: l.tab || 'Activity' });
          } else if (l.screen === 'dispoProperty') openDispo(l.id, undefined, l.dealId);
          else if (l.screen === 'tc') openTc(l.id, l.dealId);
          else if (l.screen === 'inboxSms') { requestInboxSms(l.id); go('inbox'); }
          else if (l.screen === 'settings') { requestSettingsTab({ main: 'talkr', tab: 'numbers' }); go('settings'); }
          else if (l.screen === 'contracts') {
            if (canSee(role, 'contracts')) go('contracts');
            else set({ notifOpen: false, contractsOpen: true });
          } else if (l.screen === 'lane') {
            openLane(l.id || undefined);
            const note = n.body;
            if (note) set((st) => ({ laneThread: st.laneThread.length ? st.laneThread : [{ role: 'lane', text: note } as LaneTurn] }));
          }
        },
        read: markRead,
        mute: () => muteCat(n.cat),
      };
    });
    const notifCats = ['Call', 'SMS', 'Seller', 'Buyer', 'Dispo', 'Offer', 'Task', 'TC', 'System'].map((c) => ({ c }));
    // The side pop-ups: the first few unread deal sheet reminders; the rest wait in the bell.
    const gapUnread = sectionGapList.filter((g) => !s.notifRead[g.id] && !s.mutedCats[GAP_BELL_CAT[g.cat]]);
    const sectionGapPops = gapUnread.slice(0, 3).map((g) => ({
      id: g.id, cat: g.cat, text: g.text,
      open: () => { dismissNotifIds([g.id]); go('dealSheet', { personId: g.personId, dealSheetDealId: g.dealId }); },
      dismiss: () => dismissNotifIds([g.id]),
    }));
    const sectionGapMore = Math.max(0, gapUnread.length - sectionGapPops.length);

    // ---- SEARCH: the ⌘K command bar ----
    // The bar builds its rows itself (command-rows.ts, pure) from this plain
    // copy of the records, so a keystroke re-renders the bar and not the whole
    // app. Built only while the bar is open. What a row does comes back as
    // data through `runCommand`; the two hand-offs to the seller record
    // (openRecordComposer, openOfferSheet) the bar calls on the view-model.
    const cmdData: CmdData | null = s.searchOpen ? {
      role, can, screen: s.screen, focus: focusPid,
      focusBuyer: s.screen === 'buyer' && B.id ? B.id : null,
      recentIds: s.recentIds,
      people: people.map((p) => ({
        id: p.id, name: p.name, phone: p.phone, email: p.email, addr: p.property.addr, stage: p.stage, dot: stageColor(p.stage),
        lastComm: p.lastComm, nextTask: p.nextTask, assigned: repName(p.assigned), assignedId: p.assigned || '',
        find: [p.name, p.phone, p.phone.replace(/\D/g, ''), p.email, p.property.addr, p.property.city, p.property.st, p.property.zip, p.property.apn, p.source, ...p.tags].join(' '),
      })),
      buyers: !canSee(role, 'buyers') ? [] : buyers.map((b) => ({
        id: b.id, name: b.name, company: b.company, phone: b.phone, status: b.status,
        find: [b.company, b.name, b.phone, b.phone.replace(/\D/g, ''), b.email, b.buyerType ?? '', ...b.markets, ...(b.tags ?? [])].join(' '),
      })),
      // Every deal and submission, each by its own property's address, opening
      // pinned to that deal. A contact's best contracted deal keeps the seller's
      // stage, as before; the rest show the deal's (a submission, its lead stage).
      deals: deals.filter((d) => !d.archived).flatMap((d) => {
        const p = person(d.personId);
        const addr = d.addr || p?.property.addr || '';
        if (!addr || addr === '—') return [];
        const best = !!p && !!d.contract && dealOf(p.id) === d;
        const stage = best ? p.stage : (d.stage === 'Prospect' ? d.leadStage : d.stage) || p?.stage || '';
        return [{
          id: p ? p.id : '', dealId: d.id, addr, contract: d.contract ? fmt(d.contract) : '', stage, close: d.close || '', dot: stageColor(stage),
          who: p?.name ?? '', ownAddr: !!p && addr === p.property.addr,
          find: [addr, d.city ?? (p && addr === p.property.addr ? p.property.city : ''), d.zip ?? '', stage, p?.name ?? ''].join(' '),
        }];
      }),
      tasks: tasks.filter((t) => !t.done && !s.tasksDone[t.id]).map((t) => ({ id: t.id, title: t.title, due: t.due, who: repName(t.assigned), personId: t.personId, dealId: t.dealId ?? null, buyerId: t.buyerId ?? null })),
      vendors: !canSee(role, 'people') ? [] : vendors.map((v) => ({
        id: v.id, name: v.name, kind: v.kind,
        find: [v.name, v.contact, v.phone, v.phone.replace(/\D/g, ''), v.email, v.kind, v.market, v.city ?? ''].join(' '),
      })),
      reps: Object.values(D.team).map((r) => ({ id: r.id, name: r.name })),
      stages: sellerStages.map((st) => ({ label: st, dot: stageColor(st) })),
      peopleQ: s.peopleQ, now,
    } : null;
    const runCommand = (a: CmdAction) => {
      // A second list or a completed verb stays inside the bar; the bar hands
      // the composer and the offer sheet to the record itself.
      if (a.t === 'step' || a.t === 'type' || a.t === 'compose' || a.t === 'offer') return;
      set({ searchOpen: false, searchQ: '' });
      const name = person('id' in a ? a.id : 'pid' in a ? a.pid ?? '' : '')?.name ?? 'That seller';
      switch (a.t) {
        case 'open': return a.rec === 'buyer' ? openBuyer(a.id) : openPerson(a.id);
        case 'deal':
          // A deal with no seller on it is its deal sheet.
          if (!a.id) return a.dealId ? go('dealSheet', { personId: '', dealSheetDealId: a.dealId }) : undefined;
          // Where the role works the deal: the closing file, the dispo desk, else the record, pinned to that deal.
          if (a.where === 'tc') { openTc(a.id, a.dealId); if (canSee(role, 'tc')) noteRecent('person:' + a.id); return; }
          return a.where === 'dispo' ? openDispo(a.id, undefined, a.dealId) : openPersonDeal(a.id, a.dealId);
        case 'vendor':
          // The way the deal team opens one: their list in People, searched to them.
          return go('people', { peopleList: vendorListOf(a.id), peopleQ: a.name, peopleSel: {} });
        case 'task': {
          // Tasks on the list the task is due in, with nothing filtering it out.
          const t = tasks.find((x) => x.id === a.id);
          const view = t?.bucket === 'overdue' ? 'Overdue' : t?.bucket === 'today' ? 'Today' : t?.bucket === 'upcoming' ? 'Upcoming' : 'Team';
          return go('tasks', { tasksView: view, taskFocus: a.id, gf: { ...s.gf, taskType: 'Any', taskAssigned: 'Any' } });
        }
        case 'thread':
          // Inbox cannot open one named thread, so the texts are the record's, with the Texts filter on.
          go('person', { personId: a.id, personTab: 'Texts' });
          return noteRecent('person:' + a.id);
        case 'call':
          startCall({ name: a.name, phone: a.phone, personId: a.personId ?? null, buyerId: a.buyerId ?? null });
          return;
        case 'underwrite': {
          const who = person(a.pid);
          if (who) openComprDeal(who, a.pid === P.id ? comprDeal : dealOf(a.pid));
          if (!(s.screen === 'person' && a.pid === s.personId)) go('person', { personId: a.pid, personTab: 'Activity' });
          return noteRecent('person:' + a.pid);
        }
        case 'add': return openAdd(a.kind, a.seed);
        case 'assign': {
          const who = a.rep ? repName(a.rep) : null;
          if (!canWrite) return toast((who ? name + ' assigned to ' + who : name + ' unassigned') + ' (demo)');
          void assignSellers([a.pid], a.rep).then((r) => {
            if (!r.ok) return toast(r.message || 'That did not save.', 'error');
            refreshPerson(a.pid);
            toast(who ? name + ' assigned to ' + who : name + ' unassigned', 'success');
          });
          return;
        }
        case 'stage':
          set((x) => ({ stageOverrides: { ...x.stageOverrides, [a.pid]: a.stage } }));
          persistStage(a.pid, a.stage);
          return toast(name + ' → ' + a.stage);
        case 'filter':
          // The People list's own search box shows it, and clears it.
          return s.screen === 'people' ? set({ peopleQ: a.q }) : go('people', { peopleQ: a.q });
        case 'go': return a.screen === 'tc' && !s.tcId ? openTcList() : go(a.screen);
        case 'lane': return openLane(a.pid ?? undefined);
      }
    };

    // ---- ASK CLOZR ----
    // The demo examples name sample people and properties, so a live workspace
    // gets openers written against whatever is actually in it instead.
    const aiExamples = (live ? [
      'What should I focus on today?',
      'List my action plans.',
      "Which sellers haven't been contacted in a week?",
      'What is closing in the next two weeks?',
      'Where is my pipeline sitting right now?',
      'Which deals have been stuck in the same stage the longest?',
      'What is overdue on my plate?',
      'Find cash buyers who can go to $250K.',
    ] : [
      'Who should Taylor call right now?',
      "Show me sellers that opened an offer but haven't been contacted today.",
      'Which contracts are at risk?',
      'Find buyers for Oakview.',
      'Why did COMPR reject this comp?',
      'Which acquisition rep has the best conversion rate this month?',
      'Draft a follow-up text for Ronald.',
      "Which buyers opened Willow Street but haven't made an offer?",
    ]).map((qq) => ({ q: qq, go: () => askAi(qq) }));

    // ---- LEADERBOARD (TV) ----
    const lb = leaderboardVals(reportRaw, !!live, s, { go, toast, set }, { badgesOpen: !!s.lbBadgesOpen, board, crmOk });

    const stageQuick = (() => {
      if (live) return [];
      const i = D.STAGES.indexOf(P.stage as Stage);
      return D.STAGES.slice(i + 1, i + 3).flatMap((st) => {
        const o = stageOptions.find((x) => x.label === st);
        return o ? [o] : [];
      });
    })();

    // The call ringing in: Talkr's, or on the demo the staged one (?ring=1).
    const incomingV = sp.incoming
      ? {
        from: formatPhone(sp.incoming.from),
        /** The caller as E.164, for the record lookup. */
        e164: sp.incoming.from,
        name: people.find((p) => toE164(p.phone) === sp.incoming!.from)?.name ?? formatPhone(sp.incoming.from),
        accept: () => {
          const match = people.find((p) => toE164(p.phone) === sp.incoming!.from);
          // Answered out of wrap-up: the new call takes the screen, so the
          // last one keeps its notes (filed by the adapter) but not an
          // outcome. Say so rather than letting it vanish.
          if (callState === 'wrap') toast('Your last call’s notes are saved, but it has no outcome set.');
          set((prev) => ({
            dialerOpen: true, phoneMin: false, dialerTab: 'Dial', callState: 'live', callSec: 0, callSeq: prev.callSeq + 1,
            callTarget: { name: match?.name ?? formatPhone(sp.incoming!.from), phone: formatPhone(sp.incoming!.from), personId: match?.id ?? null },
          }));
          sp.acceptIncoming();
        },
        decline: () => sp.rejectIncoming(),
      }
      : s.demoIncoming
        ? {
          from: formatPhone(s.demoIncoming.from),
          e164: s.demoIncoming.from,
          name: s.demoIncoming.name,
          accept: () => {
            const d = s.demoIncoming!;
            if (callState === 'wrap') toast('Your last call’s notes are saved, but it has no outcome set.');
            // The demo's scripted call, started the way the keypad starts it, on the caller.
            set((prev) => ({
              demoIncoming: null, dialerOpen: true, phoneMin: false, dialerTab: 'Dial', callState: 'live', callSec: 0, transcriptN: 1,
              callSeq: prev.callSeq + 1,
              callTarget: { name: d.name, phone: formatPhone(d.from), personId: null },
              dialNumber: formatPhone(d.from),
            }));
          },
          decline: () => set({ demoIncoming: null }),
        }
        : null;
    /**
     * Every Back link (components/ds/BackLink): where this screen was opened
     * from (`navFrom`, carried in the address), else the screen's own
     * fallback. When the history entry before this one is that place it steps
     * back (lib/nav-hash backAction), so in-app Back and browser Back agree;
     * otherwise it replaces this entry instead of pushing a loop.
     */
    const backFor = (fallback: string): BackTarget & { to: NavRef } => {
      const raw = parseFrom(s.navFrom);
      const here = navRefOf(s);
      const from = raw && RECORD_BACK_SCREENS.includes(raw.screen) && canSee(role, raw.screen) && !sameRef(raw, here) ? raw : null;
      const fb: NavRef = { screen: canSee(role, fallback) ? fallback : landing, id: null };
      const to = from ?? fb;
      const label = to.screen === 'person' && to.id ? person(to.id)?.name || 'Seller record'
        : to.screen === 'buyer' && to.id ? (buyer(to.id)?.name || buyer(to.id)?.company || 'Buyer record')
          : to.screen === 'dispoProperty' && to.id ? person(to.id)?.property.addr || 'Dispo property'
            : SCREEN_LABELS[to.screen] ?? 'Back';
      return {
        label,
        to,
        go: () => { window.dispatchEvent(new CustomEvent(BACK_EVENT, { detail: { from, fallback: fb } })); },
      };
    };
    /**
     * A seller record's back link: where it was opened from, else People for
     * the roles that work leads, else Deals for dispositions and TC, who reach
     * a record from a deal and cannot open People. `fromList` is People, where
     * the link names the smart list.
     */
    const recordBackTo = backFor(can.people ? 'people' : 'deals');
    const recordBack = { ...recordBackTo, fromList: recordBackTo.to.screen === 'people' };
    // Shift+Delete on People, Ctrl+A on Buyers (lib/people-keys), the bulk
    // bar and the record's Archive: ask first, then archive. Sellers take
    // their open deals along unless unticked.
    const askArchive = (kind: 'seller' | 'buyer', ids: string[], fromRecord = false) => {
      const uniq = Array.from(new Set(ids)).filter(Boolean);
      if (!uniq.length) return toast(kind === 'seller' ? 'Pick a person first' : 'Pick a buyer first');
      if (readOnly) return toast('Read-only: nothing archived');
      if (!canWrite && live) return toast('You can view this workspace but not archive in it', 'error');
      const names = uniq.map((id) => {
        if (kind === 'seller') return person(id)?.name || 'this person';
        const b = buyer(id);
        return b?.company || b?.name || 'this buyer';
      });
      const theirDeals = kind === 'seller'
        ? deals.filter((d) => uniq.includes(d.personId) && !d.archived && d.stage !== 'Prospect' && d.stage !== 'Closed')
          .map((d) => ({ id: d.id, addr: d.addr || 'deal' }))
        : [];
      set({ archiveAsk: { kind, ids: uniq, names, deals: theirDeals, fromRecord } });
    };
    const answerArchive = (yes: boolean, alsoDeals = true) => {
      const ask = s.archiveAsk;
      set({ archiveAsk: null });
      if (!ask || !yes) return;
      const n = ask.ids.length;
      const noun = { seller: 'people', buyer: 'buyers', deal: 'deals', vendor: 'vendors' }[ask.kind];
      const who = n === 1 ? ask.names[0] : `${n.toLocaleString('en-US')} ${noun}`;
      const dealsToo = ask.kind === 'seller' && alsoDeals && ask.deals.length > 0;
      // On a deal, the box is "also archive the seller".
      const sellerToo = ask.kind === 'deal' && alsoDeals && !!ask.seller;
      // On a record, Yes moves on to the next row in the list. The open record
      // is its row on the list (a submission is 'sub:<deal>', not the seller),
      // and it opens the way a click does. A record that is not on the list
      // goes back where it was opened from, the list's cursor kept, rather
      // than to whichever lead happens to be first.
      const moveOn = () => {
        if (!ask.fromRecord) return;
        if (ask.kind === 'seller' || ask.kind === 'deal') {
          const gone = (id: string) => (ask.kind === 'deal'
            ? ask.ids.some((d) => submissionRowKey(id) === 'sub:' + d) || (sellerToo && id === ask.seller?.id)
            : ask.ids.includes(id));
          const at = openRow ? peopleFiltered.findIndex((p) => p.id === openRow) : -1;
          if (at < 0) return recordBack.go();
          const after = peopleFiltered.findIndex((p, i) => i > at && !gone(p.id));
          let before = -1;
          for (let i = at - 1; i >= 0 && before < 0; i--) if (!gone(peopleFiltered[i].id)) before = i;
          const pick = after >= 0 ? after : before;
          if (pick < 0) return go('people', { peopleCursor: 0, cursorList: s.peopleList });
          openListed(peopleFiltered[pick]);
          // Its index once the archived rows have left the list.
          set({ peopleCursor: peopleFiltered.slice(0, pick).filter((p) => !gone(p.id)).length, cursorList: s.peopleList });
        } else {
          const order = buyerOrderIds();
          const ids = order.filter((id) => !ask.ids.includes(id));
          const at = Math.max(0, order.indexOf(s.buyerId));
          const next = ids[Math.min(at, ids.length - 1)];
          if (next) go('buyer', { buyerId: next, buyerCursor: Math.min(at, ids.length - 1), buyerCursorList: s.buyerList });
          else go('buyers', { buyerList: s.buyerList });
        }
      };
      if (readOnly) return toast('Read-only: nothing archived');
      if (!canWrite) { moveOn(); return toast(`Archived ${who} (demo)`); }
      if (ask.kind === 'deal' || ask.kind === 'vendor') {
        void (async () => {
          const r = ask.kind === 'deal' ? await archiveDeals(ask.ids.map(dbId), true, 'Archived') : await archiveVendors(ask.ids);
          if (!r.ok) return toast(r.message || 'Nothing was archived.', 'error');
          // The toast says what happened to the seller, not what was asked.
          const r2 = sellerToo && ask.seller ? await archiveSellers([ask.seller.id]) : null;
          if (ask.kind === 'vendor') set((st) => ({ peopleSel: Object.fromEntries(Object.entries(st.peopleSel).filter(([id]) => !ask.ids.includes(id))), bulkMenu: null }));
          moveOn();
          reload?.();
          if (r2 && !r2.ok) return toast(`Archived ${who}, but not its seller ${ask.seller?.name}: ${r2.message || 'that did not save.'}`, 'error');
          toast(`Archived ${who}${r2 ? ' and its seller' : ''}`, 'success');
        })();
        return;
      }
      void (async () => {
        const r = ask.kind === 'seller' ? await archiveSellers(ask.ids) : await archiveBuyers(ask.ids);
        if (!r.ok) return toast(r.message || 'Nothing was archived.', 'error');
        if (dealsToo) {
          const r2 = await archiveDeals(ask.deals.map((d) => dbId(d.id)), true, 'Seller archived');
          if (!r2.ok) { reload?.(); return toast(`${who} archived, but their deals were not: ${r2.message || 'that did not save.'}`, 'error'); }
        }
        if (ask.kind === 'seller') set((st) => ({ peopleSel: Object.fromEntries(Object.entries(st.peopleSel).filter(([id]) => !ask.ids.includes(id))) }));
        else setRealtorPage((pg) => ({ ...pg, rows: pg.rows.filter((b) => !ask.ids.includes(b.id)) }));
        moveOn();
        reload?.();
        toast(`Archived ${who}${dealsToo ? ` and ${ask.deals.length === 1 ? 'their deal' : `${ask.deals.length} deals`}` : ''}`, 'success');
      })();
    };
    const phoneUp = s.isMobile && (!!incomingV || (s.dialerOpen && !s.phoneMin));
    const phoneCallMin = s.isMobile && s.phoneMin && s.dialerOpen && callState !== 'idle' && !incomingV;

    return {
      ready: true,
      // Self-contained screens (the plan builder, the calendar) reach a
      // workspace re-read and record click-through here; the toast is `showToast`.
      reload, openPerson,
      // Release 4's hand-off between the command bar and the seller record:
      // "text kara" opens her record with the Text composer focused, and
      // "send offer" opens it with the Make offer sheet up.
      composerFocusSeq: s.composerFocusSeq, offerSheetOpen: s.offerSheetOpen, recentIds: s.recentIds,
      openRecordComposer: (pid: string, channel: 'Text' | 'Email' | 'Note') => {
        go('person', {
          personId: pid, personTab: 'Activity', composerTab: channel, composerFocusSeq: s.composerFocusSeq + 1,
          quickReach: channel === 'Email' ? { channel: 'email', personId: pid } : channel === 'Text' ? { channel: 'text', personId: pid } : null,
        });
        noteRecent('person:' + pid);
      },
      openOfferSheet: (pid: string) => { go('person', { personId: pid, personTab: 'Activity', offerSheetOpen: true }); noteRecent('person:' + pid); },
      closeOfferSheet: () => set({ offerSheetOpen: false }),
      chromeDisplay: s.tvMode && s.screen === 'leaderboard' ? 'none' : 'flex',
      showAi: showAiCards,
      navItems, navTools, toolsActive, toolsMenuOpen: s.toolsMenuOpen, laneUnread: laneUnread.length,
      toggleToolsMenu: () => set({ toolsMenuOpen: !s.toolsMenuOpen, accountMenuOpen: false, teamMenuOpen: false }),
      closeToolsMenu: () => set({ toolsMenuOpen: false }),
      quickAddItems, quickAddOpen: s.quickAddOpen, unreadNotifs,
      // The switcher's label is the scope Home is actually showing, and it
      // only exists for someone allowed to change it (see homeRep).
      teamView: homeScopeLabel, canScopeHome: homeCanScope,
      teamMenuOpen: homeCanScope && s.teamMenuOpen, accountMenuOpen: s.accountMenuOpen,
      teamOptions: ([['me', 'My Activity'], ['team', 'Entire Team'],
        ...Object.entries(D.team).filter(([id]) => id !== ME).map(([id, r]) => [id, r.name])] as [string, string][])
        .map(([key, label]) => ({ label, go: () => set({ teamView: key, teamMenuOpen: false }) })),
      homeQueueTitle: homeRep === null ? 'Team priority queue' : homeRep === ME ? 'My priority queue' : repName(homeRep).split(' ')[0] + "'s priority queue",
      /** Which screens this role can open; a button to one it cannot is hidden. */
      can,
      recordBack,
      /** Any screen's Back link: `<BackLink to={V.backFor('people')} />` (components/ds/BackLink). */
      backFor,
      // The logo and "go home" open where this role lands (Today for acquisitions).
      goHome: () => go(landing), goInbox: () => go('inbox'), goDeals: () => go('deals'),
      goToday: () => go('today'), landing,
      goPeople: () => go('people'), goBuyers: () => go('buyers', { buyerList: 'buyers' }), goBuyerProspects: () => go('buyers', { buyerList: 'buyer-prospect' }), goBuyr: () => go('buyr'), goGenius: () => go('genius'), goDispo: () => go('dispo'),
      goTasks: () => go('tasks'), goAutomations: () => go('automations'),
      openSearch: () => set({ searchOpen: true, searchQ: '', quickAddOpen: false }),
      closeSearch: () => set({ searchOpen: false }),
      toggleQuickAdd: () => set({ quickAddOpen: !s.quickAddOpen }),
      toggleNotif: () => set({ notifOpen: !s.notifOpen }),
      toggleTeamMenu: () => set({ teamMenuOpen: !s.teamMenuOpen }),
      toggleAccountMenu: () => set({ accountMenuOpen: !s.accountMenuOpen, teamMenuOpen: false }),
      closeAccountMenu: () => set({ accountMenuOpen: false }),
      goAccount: () => { set({ accountMenuOpen: false, moreOpen: false }); go('account'); },
      goSettings: () => { set({ accountMenuOpen: false, moreOpen: false }); go('settings'); },
      openDialer: () => set({ dialerOpen: true, phoneMin: false }),
      /** The dialer, on one of its tabs (the readiness checklist sends "Record voicemail" to RVM). */
      openDialerTab: (tab: 'Dial' | 'Queue' | 'Recent' | 'Voicemail' | 'RVM' | 'Live') => set({ dialerOpen: true, phoneMin: false, moreOpen: false, dialerTab: tab }),
      /** Home's Start call queue: the dialer, and on a phone its Queue tab. */
      openCallQueue: () => (s.isMobile ? openPhone('Queue') : set({ dialerOpen: true, phoneMin: false, dialerTab: 'Queue' })),
      closeDialer: () => set({ dialerOpen: false }),
      // The launcher. On a phone it opens the full-screen phone, or tucks it away.
      toggleDialer: () => (s.isMobile ? (phoneUp ? minimisePhone() : openPhone()) : set({ dialerOpen: !s.dialerOpen })),
      phoneUp, phoneCallMin, openPhone, minimisePhone, closePhone: minimisePhone,
      toggleAi: () => set({ aiOpen: !s.aiOpen, laneOpen: false }),

      isHome: s.screen === 'home', isPeople: s.screen === 'people', isPerson: s.screen === 'person',
      isToday: s.screen === 'today',
      // Today: the list, the seller in view, the rail's picker, and the one outcome save.
      today, outcomeTarget,
      /** Today is the dialer on a desk: the slide-out stands down there unless the call is one Today cannot wrap up. */
      todayHidesDialer: s.screen === 'today' && !s.isMobile && today.ownsCall,
      isDeals: s.screen === 'deals', isDispo: s.screen === 'dispo', isContracts: s.screen === 'contracts',
      contractsOpen: s.contractsOpen,
      openContracts: () => set({ contractsOpen: true }),
      closeContracts: () => set({ contractsOpen: false }),
      /**
       * Who a contract can be for: every seller with their deal, and every buyer. Built when asked, not every render.
       * The record in view offers the house it is pinned to; a seller on several open houses lists them, for the picker to ask which.
       */
      contractDirectory: () => {
        const openHouses = new Map<string, Deal[]>();
        for (const d of deals) {
          if (d.archived || !d.personId || !/^\D*\d+$/.test(d.id) || ['Closed', 'Terminated', 'Realtor Referral'].includes(d.stage ?? '')) continue;
          openHouses.set(d.personId, [...(openHouses.get(d.personId) ?? []), d]);
        }
        return {
        sellers: people.filter((p) => /^\D*\d+$/.test(p.id)).map((p) => {
          const d = (focusDeal && p.id === P.id ? focusDeal : undefined) || dealOf(p.id);
          const open = openHouses.get(p.id) ?? [];
          return {
            id: dbId(p.id), name: p.name, email: p.email || '', phone: p.phone || '', addr: d?.addr || p.property.addr, dealId: d?.id && /^\D*\d+$/.test(d.id) ? dbId(d.id) : null,
            houses: open.length > 1 ? open.map((x) => ({
              dealId: dbId(x.id), addr: [x.addr || p.property.addr, x.city].filter(Boolean).join(', '),
              stage: x.stage === 'Prospect' ? (x.leadStage || 'Submission') : x.stage,
            })) : [],
          };
        }),
        buyers: !canSee(role, 'buyers') ? [] : buyers.filter((b) => /^\D*\d+$/.test(b.id)).map((b) => ({
          id: dbId(b.id), name: b.name, company: b.company, email: b.email && b.email !== '—' ? b.email : '', phone: b.phone && b.phone !== '—' ? b.phone : '',
        })),
        };
      },
      isDispoProperty: s.screen === 'dispoProperty', isBuyers: s.screen === 'buyers', isBuyer: s.screen === 'buyer',
      isTc: s.screen === 'tc',
      /** Where this file sits in its stage, for the arrow controls. */
      tcNav: tcHere,
      /** The TC file's back link: the screen it was opened from, with its record, else Deals. */
      tcBackLink: backFor('deals'),
      openTcList,
      stepTc: (dir: 'deal' | 'stage', delta: -1 | 1) => {
        const next = nextTcId(tcColumns, tcCurrent, dir, delta);
        if (!next || next === tcCurrent) return;
        if (!live) return openTc(next);
        const d = dealById.get(next);
        if (d?.personId) openTc(d.personId, d.id);
      },
      isInbox: s.screen === 'inbox', isDialer: s.screen === 'dialer', isTasks: s.screen === 'tasks',
      isCalendar: s.screen === 'calendar', isReporting: s.screen === 'reporting', isAutomations: s.screen === 'automations',
      isDealMachine: s.screen === 'dealMachine',
      isGenius: s.screen === 'genius',
      isBuyr: s.screen === 'buyr',
      // The Podio-style deal sheet for the seller currently in view.
      isDealSheet: s.screen === 'dealSheet',
      /** Opened by moving the deal to Under Contract - Seller: ask for the deal type and Acquisition until Finished. */
      dealSheetPrompt: s.screen === 'dealSheet' && !!s.dealSheetPrompt,
      endDealSheetPrompt: () => set({ dealSheetPrompt: false }),
      isImport: s.screen === 'import',
      /** False when a record screen has nothing chosen (live never picks one for you); the shell asks for a pick. */
      recordPicked: { person: !!P.id, dispo: !!DP.id, tc: !!TP.id, buyer: !!B.id },
      /** The open seller is still on its way in (a merge into an archived duplicate): say so, not "Pick a seller". */
      recordLoading: !!s.recordLoading && s.recordLoading === s.personId,
      // Called straight from onClick too, so anything that is not a kind means sellers.
      openImport: (kind?: unknown) => go('import', { importKind: kind === 'buyers' || kind === 'vendors' || kind === 'submissions' ? kind : 'sellers' }),
      importKind: s.importKind,
      /** What People's Import button brings in from the list on screen: a partner list or a submissions list takes a vendor's submissions. */
      peopleImportKind: (showingSubmissions || s.peopleList === 'Partners' || s.peopleList === 'Wholesalers' ? 'submissions' : isVendorList ? 'vendors' : 'sellers') as 'submissions' | 'vendors' | 'sellers',
      goVendorList: () => go('people', { peopleList: 'Vendors' }),
      /** After an import: the list of exactly what it wrote ('s12', 'sub:d40', 'b3', 'v8'). */
      openImported: (kind: NonNullable<ClozrState['lastImport']>['kind'], label: string, ids: string[]) => {
        const lastImport = { kind, label, ids };
        if (kind === 'buyers') go('buyers', { buyerList: LAST_IMPORT, buyerQ: '', buyerGeniusOnly: false, lastImport });
        else go('people', { peopleList: LAST_IMPORT, peopleSel: {}, peopleQ: '', vendorType: 'Any', vendorState: 'Any', vendorSubs: 'Any', lastImport });
      },
      lastImportLabel: s.lastImport ? `${s.lastImport.label} · ${s.lastImport.ids.length.toLocaleString('en-US')} imported` : null,
      // The record's own house: the submission it is pinned to, else the deal
      // its cards show. Left unnamed, the sheet loaded the seller's best-ranked
      // deal, which for a partner on many houses is another house.
      openDealSheet: (personId?: string) => go('dealSheet', personId
        ? { personId, dealSheetDealId: dealOf(personId)?.id ?? null }
        : { dealSheetDealId: recDealOf(P.id)?.id ?? null }),
      /** A deal by its database id (Deal Machine's Results list): the seller's record with that deal's sheet open. */
      openLandedDeal: (dealId: number, sellerId: number | null) => go('dealSheet', { personId: sellerId != null ? 's' + sellerId : '', dealSheetDealId: 'd' + dealId }),
      // The deal sheet's seller link. Opened from that seller's record, it steps
      // back to it (the same entry, with its own Back still going to where the
      // record came from, e.g. Today) instead of stacking record → sheet → record.
      openThisPerson: () => {
        const back = s.screen === 'dealSheet' ? backFor('deals') : null;
        if (back && back.to.screen === 'person' && back.to.id === P.id) return back.go();
        openPersonDeal(P.id, s.screen === 'dealSheet' ? s.dealSheetDealId : null);
      },
      openPersonDeal,
      /** The record the deal sheet edits: the seller in view and their address. */
      dealSheetFor: (() => {
        const sheetDeal = s.dealSheetDealId ? deals.find((d) => d.id === s.dealSheetDealId) : undefined;
        // A submission with no seller must not borrow the person who was open before it.
        const linked = sheetDeal?.personId ? person(sheetDeal.personId) : undefined;
        const sheetPerson = linked || (sheetDeal ? undefined : P);
        const vendorName = sheetDeal?.vendorSellers?.[0]?.name;
        const named = sheetPerson?.name && sheetPerson.name !== '—' && sheetPerson.name !== 'No name'
          ? sheetPerson.name
          : (vendorName || sheetDeal?.addr || sheetPerson?.name || P.name);
        return {
          personId: sheetDeal ? (sheetDeal.personId && person(sheetDeal.personId) ? sheetDeal.personId : '') : P.id,
          addr: sheetDeal?.addr || P.property.addr,
          name: named,
          // A deal named but not loaded (a link to it) is read by its id, not swapped for the seller's best.
          dealId: sheetDeal ? dbId(sheetDeal.id) : s.dealSheetDealId ? dbId(s.dealSheetDealId) : null,
          vendorSellers: sheetDeal?.vendorSellers ?? [],
        };
      })(),
      get sheetBuyers() { return sheetBuyers(); },
      // Every deal on this contact — a partner's submissions each on their own property.
      personDeals: live ? deals.filter((d) => d.personId === P.id)
        .sort((a, b) => dealRank({ id: b.id, stage: b.stage, contract_date: b.tracker?.contractDate, submitted_at: b.submittedAt }) - dealRank({ id: a.id, stage: a.stage, contract_date: a.tracker?.contractDate, submitted_at: a.submittedAt }))
        .map((d) => ({
          id: d.id, addr: d.addr || P.property.addr, city: d.city || '',
          stage: d.stage === 'Prospect' ? (d.leadStage || 'Submission') : (d.tracker?.contractStatus || d.stage || ''),
          stageColor: stageColor(d.stage === 'Prospect' ? (d.leadStage || '') : (d.stage || '')),
          offer: d.contract != null ? fmt(d.contract) : d.asking != null ? 'Ask ' + fmt(d.asking) : '—',
          arv: d.arv != null ? fmt(d.arv) : '—', fee: d.profit ? fmt(d.profit) : '—',
          when: (d.tracker?.contractDate || d.submittedAt || '').slice(0, 10),
          open: () => go('dealSheet', { personId: P.id, dealSheetDealId: d.id }),
        })) : [],

      // The Supabase-backed record lists live outside the mock graph; page.tsx
      // mounts them into the shell's main area when this screen is active.
      screen: s.screen,
      screenLabel: SCREEN_LABELS[s.screen] ?? 'This screen',
      isLiveLists: s.screen === 'liveLists',
      goLiveLists: (section?: string) => go('liveLists', section ? { liveSection: section } : undefined),
      liveSection: s.liveSection,
      setLiveSection: (section: string) => set({ liveSection: section }),

      // home
      homeStats, queue, queueCount: queue.length, homeInbound, homeClosings, closingsTotal: pipelineDeals.filter((d) => d.close).length,
      aiAlerts, atRisk, recentContracts, teamFeed,

      // people
      smartLists, operationalLists, submissionNav, customLists, peopleList: s.peopleList,
      dropSmartList, pinSmartList,
      recordListPos: (() => {
        const at = peopleFiltered.findIndex((p) => p.id === openRow);
        return at >= 0 ? `${at + 1} of ${peopleFiltered.length}` : '';
      })(),
      peopleCount: peopleFiltered.length, peopleQ: s.peopleQ,
      listNoun: showingSubmissions ? 'submissions' : 'people',
      /** Podio items on this list with no CLOZR deal to show: counted in Podio's number, not listed. */
      podioOnlyNote: [
        podioOutside ? `· ${podioOutside} in Podio only (test entries, no address, or matching more than one house)` : '',
        podioArchived ? `· ${podioArchived} archived in CLOZR` : '',
      ].filter(Boolean).join(' '),
      subPartnerChip: showingSubmissions && s.subPartner
        ? { label: s.subPartner.name + '’s submissions', clear: () => set({ subPartner: null, peopleSel: {} }), open: () => openPerson(s.subPartner!.id) }
        : null,
      // toolbar filters (#7)
      // Vendor lists show their own Type / State menus and the offer-gap ones; the seller filters do not apply to a vendor.
      peopleFilterMenus: isVendorList
        ? [...vendorFilterMenus, ...peopleFilterMenus.filter((m) => ['gapBasis', 'gapWithin', 'closeCalls', 'declined', 'submitter', 'phone', 'email'].includes(m.key))]
        : peopleFilterMenus,
      activeFilterCount: isVendorList ? vendorFilterMenus.filter((m) => m.on).length : activeFilterCount,
      hasActiveFilters: isVendorList ? vendorFilterMenus.some((m) => m.on) : hasActiveFilters,
      clearFilters, peopleMore, vendorGroups, vendorViewToggle, vendorGrouped: isVendorList && s.vendorView === 'grouped',
      vendorGroupsByPlace: byPlace, vendorShowType: isVendorList && new Set(vendorRows.map((r) => r.kind)).size > 1,
      closeFilterMenus: () => set({ pfOpen: null }),
      pfOpen: s.pfOpen,
      // saved smart lists
      savedListRows, hasSavedLists,
      // vendor-backed lists
      isVendorList, vendorRows, vendorCols, vendorCount, vendorHasSubs, hasGaps, gapDetail, peopleMap,
      setPeopleQuery: (q: string) => set({ peopleQ: q }),
      peopleColumns, peopleColPicker, peopleColsShown, peopleColsTotal, peopleColsAllOn,
      colsOpen: s.colsOpen,
      toggleCols: () => set({ colsOpen: !s.colsOpen }),
      closeCols: () => set({ colsOpen: false }),
      resetCols: () => setCols(DEFAULT_PEOPLE_COLS),
      // Saved views (components/ViewControls.tsx): what the People table shows, and how to put it back.
      peopleColDefs: PEOPLE_COLUMNS, peopleColDefaults: DEFAULT_PEOPLE_COLS,
      peopleColKeys: peopleColumns.map((c) => c.key), setPeopleCols: setCols,
      peopleSortColumn: peopleSortColumn(s.pf.sort), sortPeopleColumn,
      peoplePf: s.pf,
      applyPeopleView: (v: { list?: string; filters?: Partial<PeopleFilters>; cols?: string[] } | null) => set((st) => {
        if (!v) return { peopleList: 'My Leads', pf: { ...INITIAL.pf }, peopleColsByList: { ...st.peopleColsByList, 'My Leads': DEFAULT_PEOPLE_COLS }, peopleSel: {}, pfOpen: null };
        const list = v.list || st.peopleList;
        return {
          peopleList: list,
          pf: { ...INITIAL.pf, ...(v.filters ?? {}) },
          peopleColsByList: { ...st.peopleColsByList, [list]: v.cols && v.cols.length ? v.cols : DEFAULT_PEOPLE_COLS },
          peopleSel: {}, pfOpen: null,
        };
      }),
      saveSmartList, closeSmartList, commitSmartList, smartListOpen: s.smartListOpen,
      suggestedListName,
      smartListTeam: Object.values(D.team).map((r) => ({ id: r.id, name: r.name, me: r.id === ME })),
      peopleCursor, moveInList, moveOpenRecord, moveSmartList, shiftStage,
      /** Enter on the People list: open the row the arrows are on. */
      openPeopleCursor: () => { const p = peopleFiltered[peopleCursor]; if (p && !isVendorList) openListed(p); },
      /** Ctrl+A on the People list: check every row in it, the way select-all works in any table. */
      selectAllPeople: () => {
        if (!selectable.length) return;
        set({ peopleSel: Object.fromEntries(selectable.map((p) => [p.id, true])) });
      },
      /** A list People can be put back on after a reload: it still exists and this role may open it (lib/people-memory). */
      peopleListKnown: (l: string) => {
        const saved = s.savedLists.some((x) => x.name === l);
        return peopleListOk(role, l, saved) && (saved || !!listDefs[l] || !!customDefs[l] || Object.prototype.hasOwnProperty.call(VENDOR_LISTS, l)
          || submissionLabels.has(l) || (PODIO_NEW_SUBMISSIONS as readonly string[]).includes(l));
      },
      /** Shift+Delete on the People list: the checked rows, else the row the arrows are on. Submission rows are deals, not people. */
      archivePeopleKey: () => {
        if (isVendorList) return;
        const picked = inListOrder(peopleFiltered.map((p) => p.id), s.peopleSel);
        const ids = (picked.length ? picked : [peopleFiltered[peopleCursor]?.id ?? '']).filter((id) => id && !id.startsWith('sub:'));
        if (!ids.length && (picked.length || peopleFiltered[peopleCursor])) return toast('A submission is archived from its deal, not from here');
        askArchive('seller', ids);
      },
      buyerList, buyerListLabel: buyerListLabel(buyerList), buyerListNames,
      /** The record's breadcrumb: back to the list the rep was on (a prospect list, the last import), not always the main one. */
      backToBuyers: () => backFor('buyers').go(),
      setBuyerList, buyerCursor, moveBuyerInList, moveOpenBuyer, moveBuyerList,
      buyerQ: s.buyerQ, setBuyerQ: (q: string) => { setRealtorOffset(0); set({ buyerQ: q, buyerCursor: 0, buyerCursorList: s.buyerList }); },
      realtorCorpusTotal, realtorMatchTotal: realtorPage.total, realtorOffset, realtorPageSize: REALTOR_PAGE, realtorMarkets,
      realtorLoading: realtorPage.loading,
      realtorPrev: () => setRealtorOffset((n) => Math.max(0, n - REALTOR_PAGE)),
      realtorNext: () => setRealtorOffset((n) => n + REALTOR_PAGE),
      buyerGeniusOnly: s.buyerGeniusOnly, setBuyerGeniusOnly: (on: boolean) => set({ buyerGeniusOnly: on, buyerCursor: 0, buyerCursorList: s.buyerList }),
      buyerNavRows,
      /** How well each buyer matched the search (lib/list-search), lower first; null with no search. */
      buyerSearchRanks: buyerSearch && !onRealtors ? buyerRanks : null,
      peopleRows, hasSelection: selectionCount > 0, selectionCount, massActions, peopleBulk,
      blacklistSelection: {
        count: isVendorList ? 0 : selectedIds.length,
        names: selectedIds.map((id) => person(id)?.name || 'Someone'),
        go: (reason?: string) => blacklist('person', selectedIds, reason),
      },
      blacklistPerson: (reason?: string) => blacklist('person', [P.id], reason),
      secretList: { rows: secretRows, restore: restoreSecret },
      clearSelection: () => set({ peopleSel: {} }),
      allSelected: selectable.length > 0 && selectable.every((p) => s.peopleSel[p.id]),
      toggleAll: () => {
        const all = selectable.every((p) => s.peopleSel[p.id]);
        const sel: Record<string, boolean> = {};
        if (!all) selectable.forEach((p) => { sel[p.id] = true; });
        set({ peopleSel: sel });
      },

      // person
      P: {
        id: P.id, name: P.name, initials: initialsOf(P.name), stage: P.stage, stageColor: stageColor(P.stage),
        /** The asking price: the submission's own on a deal record, else the seller's. */
        asking: P.asking,
        // No score and no Talkr temperature shows a dash, not "0 COLD".
        score: P.score ?? (leadTemp(P) ? '' : '—'), scoreLabel: leadTemp(P),
        scoreColor: P.score != null ? scoreColor(P.score) : leadTemp(P) ? tempColor(leadTemp(P)) : '#a1a1aa',
        scoreLine: [P.score ?? '', leadTemp(P)].filter((x) => x !== '').join(' '),
        assigned: repName(P.assigned), assignedInit: repInit(P.assigned),
        assignedId: P.assigned || '',
        assignOptions: Object.values(D.team).map((r) => ({ id: r.id, name: r.name })),
        assignTo: (userId: string) => (canWrite
          ? void (focusDeal ? assignDeals([focusDeal.id], userId || null) : assignSellers([P.id], userId || null)).then((r) => { if (!r.ok) return toast(r.message || 'That did not save.', 'error'); sellerSaved(); toast(userId ? 'Assigned to ' + repName(userId) : 'Unassigned', 'success'); })
          : toast('Assigned (demo)')),
        // Click the name on the record to change it (InlineField): a refusal comes back to the field.
        rename: async (name: string): Promise<WriteResult> => {
          const next = name.replace(/\s+/g, ' ').trim();
          if (!next) return { ok: false, message: 'A seller needs a name' };
          if (next === P.name) return { ok: true };
          if (live && !canWrite) return { ok: false, message: readOnly ? READ_ONLY_MESSAGE : READ_ONLY_LIVE };
          if (!canWrite || workspaceId === null) { toast('Renamed (demo)'); return { ok: true }; }
          const r = await updateSellerDetails(workspaceId, dbId(P.id), 'name', next);
          if (r.ok) { patchLocal?.('people', { id: P0.id, name: next }); sellerSaved(); }
          return r;
        },
        underwriter: P.underwriter ? repName(P.underwriter) : '', underwriterInit: P.underwriter ? repInit(P.underwriter) : '',
        underwriterId: P.underwriter || '',
        underwriterTo: (userId: string) => (canWrite
          ? void (focusDeal ? setDealUnderwriter([focusDeal.id], userId || null) : setSellerUnderwriter([P.id], userId || null)).then((r) => { if (!r.ok) return toast(r.message || 'That did not save.', 'error'); if (focusDeal) reload?.(); else sellerSaved(); toast(userId ? 'Underwriter: ' + repName(userId) : 'No underwriter', 'success'); })
          : toast('Underwriter set (demo)')),
        source: P.source, phone: P.phone, email: P.email,
        dealType: (() => { const d = recDealOf(P.id); return d ? (d.structure || dealTypeLabel(d.tracker?.transactionType)) : ''; })(),
        tags: visibleTags(P.tags).map((t) => ({
          t,
          remove: () => {
            if (!canWrite) return toast('Removed (demo)');
            void untagSellers([P.id], t).then((r) => { if (!r.ok) return toast(r.message || 'That did not save.', 'error'); refreshPerson(P.id); toast('Removed · ' + t, 'success'); });
          },
        })),
        addr: P.property.addr, cityLine: P.property.city + ', ' + P.property.st + ' ' + P.property.zip,
        /** Where a skip trace looks the owner up: the property, when it has a street and ZIP. */
        traceAddress: P.property.addr && P.property.addr !== '—' && /^\d{5}/.test(P.property.zip || '') ? { address: P.property.addr, city: P.property.city, state: P.property.st, zip: P.property.zip.slice(0, 5) } : null,
        img: P.property.img, apn: P.property.apn,
        imgSafe: houseOf(P, (focusDeal || photoDealOf(P))).img,
        streetSafe: houseOf(P, (focusDeal || photoDealOf(P))).street,
        photos: houseOf(P, (focusDeal || photoDealOf(P))).photos,
        streetOnly: houseOf(P, (focusDeal || photoDealOf(P))).streetOnly,
        dealDbId: houseOf(P, (focusDeal || photoDealOf(P))).dealDbId,
        lookups: propertyLinks(P.property.addr + ', ' + P.property.city + ', ' + P.property.st + ' ' + P.property.zip)
          .map((l) => ({ label: l.label, go: () => openPopup(l.url, 'clozr-' + l.label) })),
        offer: P.offer || 'No offer yet', offerStatus: live ? (P.offer ? 'On the deal' : 'Log one from the underwriting') : P.offer ? 'Sent · viewed 3×' : 'Build from COMPR',
        contract: contractStatus,
        nextTask: P.nextTask, market: P.market,
      },
      /** The workspace's members, for RepPicker. */
      team: D.team,
      /** Why this record reads as text: a live workspace this user can't write to. Null when they can edit. */
      recordReadOnly: live && !canWrite ? 'Read-only: you can’t edit this record' : null,
      /** After a save made outside useClozr (ContactField): refresh the record. */
      sellerSaved,
      stageQuick,
      // Live: the grouped picker (lib/stages leadStagePicks): every stage,
      // legacy duplicates offered only where a record already has one.
      // Demo keeps the quick buttons.
      stageSelect: live ? {
        value: P.stage,
        groups: leadStagePicks(P.stage).filter((g) => g.stages.length).map((g) => ({ label: g.group, options: g.stages })),
        set: (label: string) => { const o = stageOptions.find((x) => x.label === label); if (o) o.go(); },
      } : null,
      /**
       * The underwriter's one-press stage chips: on a real submission, or for
       * whoever underwrites this lead. Everyone else uses the stage picker.
       */
      showUnderwriterChips: !live || !!stageDeal || (!!P.underwriter && P.underwriter === ME),
      /**
       * The record's outcome bar (SOP step 5): Offer accepted, Declined, No
       * offer, planned and saved exactly as Today's picker does. On the call
       * with this seller it is the call's outcome; otherwise it logs one.
       */
      recordOutcome: recordOutcomeTarget,
      /** Save acts once the call with this seller is over (or there is none); during it an outcome can be picked ahead. */
      recordOutcomeArmed: !!recordOutcomeTarget && (recordOutcomeTarget.mode !== 'call' || callState === 'wrap'),
      /** Drip plans a Declined can start: the active seller plans. */
      outcomeDrips: plansForRecord(plans, 'seller').filter((pl) => pl.active).map((pl) => ({ id: pl.id, name: pl.name })),
      personFields, propFacts, personTabs, isCommsTab, isTcTab, isFilesTab, isFeedTab, composerTabs, composerTab: s.composerTab,
      // An email thread is one card: the newest message, the rest folded behind it.
      timelineItems: foldEmailThreads(timelineItems.filter((t) => s.recordUser === 'Any' || t.actor === s.recordUser)),
      reachFeed,
      pinnedItems: timelineItems.filter((t) => t.pinned).map((t) => ({ ...t, earlier: [] as typeof timelineItems })),
      pinsOpen: s.pinsOpen, togglePins: () => set((st) => ({ pinsOpen: !st.pinsOpen })),
      mentionTeam: Object.values(D.team).filter((r) => r.id !== ME).map((r) => ({ id: r.id, name: r.name })),
      setComposerText: (v: string) => set({ composerText: v }),
      timelineUserMenu: mkMenu('recordUser', 'User',
        ['Any', ...Array.from(new Set(timelineItems.map((t) => t.actor))).filter((a) => a !== 'System'), 'System'],
        s.recordUser, (v) => set({ recordUser: v })),
      composerPlaceholder: s.composerTab === 'Note'
        ? 'Add a note about ' + P.name.split(' ')[0] + '…'
        : s.composerTab === 'Email' ? 'Email ' + P.name.split(' ')[0] + '…' : 'Send ' + P.name.split(' ')[0] + ' a message…',
      composerText: s.composerText,
      setComposer: (e: React.ChangeEvent<HTMLTextAreaElement>) => set({ composerText: e.target.value }),
      // `opts.subject`: the record composer's Subject line for an email. Called
      // straight from onClick too, so anything that is not { subject } is ignored.
      // The docked quick box (QuickReach) hands over its own `body`, `personId`
      // and `channel`: it sends to the person it was opened on, on its own
      // channel, never the record in view, and the record composer never sends
      // the quick box's text. Both used to share one draft and the quick box's
      // person, so a box left open on Ann sent Bob's record composer to Ann.
      // Resolves true once the send or save has landed.
      send: (opts?: unknown): Promise<boolean> => {
        const o = (opts && typeof opts === 'object' ? opts : {}) as { subject?: unknown; body?: unknown; personId?: unknown; channel?: unknown };
        const subjectIn = typeof o.subject === 'string' ? o.subject.trim() : '';
        const quickPid = typeof o.body === 'string' && typeof o.personId === 'string' ? o.personId : null;
        const body = (quickPid ? o.body as string : s.composerText).trim();
        const fail = (msg: string, tone?: ToastTone) => { toast(msg, tone); return Promise.resolve(false); };
        if (!body) return fail('Type a message first');
        const tab = quickPid ? (o.channel === 'email' ? 'Email' : 'Text') : s.composerTab;
        const target = quickPid ? (person(quickPid) ?? (P.id === quickPid ? P : null)) : P;
        if (!target) return fail('That record is not loaded any more. Close the box and open it again from the record.', 'error');
        // An email needs an address to go to. Checked before anything reaches
        // the timeline, so a seller without one gets no row saying it went.
        const emailTo = target.email.includes('@') ? target.email : '';
        if (tab === 'Email' && !emailTo) return fail('Add an email address for ' + target.name + ' first.');
        // A View-as preview sends and saves nothing, so nothing goes on the
        // timeline either and the draft stays in the box.
        if (readOnly) return fail(READ_ONLY_MESSAGE);
        // Record it on the timeline. This used to clear the box and toast, so
        // whatever you typed was gone the moment you sent it — and Quick Add →
        // Note, which writes the same kind of row, made the omission look like
        // a bug rather than a decision. It was.
        const nc: Communication = {
          id: 'c_' + nextId('r').slice(2),
          personId: target.id,
          channel: tab === 'Note' ? 'note' : tab === 'Email' ? 'email' : 'sms',
          dir: 'out',
          party: target.name,
          user: ME,
          ts: 0,
          time: 'Just now',
          preview: body,
        };
        // The record composer empties at once, ready for the next message; the
        // quick box keeps its text until the send lands, and closes itself then.
        set((prev) => (quickPid ? { newComms: [...prev.newComms, nc] } : { composerText: '', newComms: [...prev.newComms, nc] }));
        if (!canWrite) {
          toast(tab === 'Note' ? 'Note added to ' + target.name : tab + ' sent to ' + target.name + ' (demo)');
          return Promise.resolve(true);
        }
        // The timeline showed it the moment Send was pressed; a send or save
        // that fails takes it back, and puts what was typed back in the
        // record's box (and its draft, lib/compose-drafts) instead of losing
        // it. The quick box never emptied, so it has nothing to put back.
        const dropEntry = () => {
          set((prev) => ({ newComms: prev.newComms.filter((c) => c.id !== nc.id) }));
          if (quickPid) return;
          restoreDraft('record:' + target.id, body);
          set((prev) => (prev.personId === target.id ? { composerText: withRestored(prev.composerText, body) } : {}));
        };
        const failed = (msg: string) => { dropEntry(); toast(msg, 'error'); return false; };
        // A text and an email leave the building; a note does not. Only the
        // answer from whatever carried it (Talkr for a text, the rep's own
        // Gmail for an email) decides what the toast says — this used to
        // announce "Text sent" and "Email sent" whether or not anything was.
        if (tab === 'Text') {
          toast('Sending to ' + target.name.split(' ')[0] + '…');
          return textMany(workspaceId, [recipientOf(target.id)].filter((r) => r !== null), body, textCtx)
            .then((rs) => {
              const none = rs.every((x) => x.status === 'failed' || x.status === 'skipped');
              if (none) dropEntry();
              refreshPerson(target.id);
              toast(sendSummary(rs), none ? 'error' : 'success');
              return !none;
            }, (e: unknown) => failed(e instanceof Error ? e.message : 'Could not send that text.'));
        }
        if (tab === 'Email') {
          // The Inbox composer's send (lib/google.ts), filed on this seller.
          // google-sync writes the communications row for a sent email itself,
          // so logging one here as well would put it on the record twice.
          toast('Sending to ' + target.name.split(' ')[0] + '…');
          const street = target.property.addr && target.property.addr !== '—' ? target.property.addr : '';
          return sendEmail(workspaceId, { to: emailTo, subject: subjectIn || street || 'Following up', body_text: body, seller_id: dbId(target.id) })
            .then((r) => {
              if (!r.ok || !r.data.connected || !r.data.ok) {
                return failed(!r.ok ? r.message : !r.data.connected ? 'Connect Gmail in Settings to send email.' : r.data.message ?? 'Gmail refused that send.');
              }
              refreshPerson(target.id);
              toast('Email sent to ' + target.name + (r.data.tracked ? ' · read receipt on' : ''), 'success');
              return true;
            }, (e: unknown) => failed(e instanceof Error ? e.message : 'Could not send that email.'));
        }
        // A note: "Note added" once the row is saved, not before.
        return createCommunication(workspaceId, {
          sellerId: dbId(target.id), channel: nc.channel,
          // Written on a submission: it belongs to that house, so its feed shows it.
          ...(focusDeal && target.id === P.id ? { dealId: dbId(focusDeal.id) } : {}),
          direction: 'outbound', body,
        }).then((r) => {
          if (!r.ok) return failed(r.message || 'Could not save that message.');
          refreshPerson(target.id);
          toast('Note added to ' + target.name, 'success');
          return true;
        }, (e: unknown) => failed(e instanceof Error ? e.message : 'Could not save that note.'));
      },
      aiRewriteAvailable: !live,
      saveSellerField,
      // A scripted rewrite about a sample seller's close date; not something to put in a real text.
      aiRewrite: () => (live ? toast('AI rewrite is not connected on this workspace yet.') : set({
        composerText: 'Hi ' + P.name.split(' ')[0] + ', following up on our call — I can guarantee your Sept 30 close date '
          + 'and cover moving costs. Revised written offer is on its way before 2 PM. Any questions in the meantime, text me here.',
      })),
      personTasks, personQuickAdds, stageOptions, aiStage,
      // Open in COMPR: the deal's report in the COMPR window beside CLOZR
      // (lib/compr-window.ts), underwritten first when COMPR has never run it.
      openCompr: () => openComprDeal(P, comprDeal),
      /** COMPR has a report for the house this record opens in COMPR. */
      comprLinked: !!comprLeadIdOfDeal(comprDeal),
      /** Run COMPR here when it has never run this house (comprLinked false). */
      runCompr: () => runComprOnRecord(P, comprDeal),
      comprRunning: s.comprRunning.includes(P.id) || (!!comprDeal && comprRunInFlight(comprDeal.id)),
      /** That report was graded without most of the record's photos: how many it has, how many the record has. */
      comprPhotoGap: comprDeal ? s.comprPhotoGaps[comprDeal.id] ?? null : null,
      rerunComprPhotos: () => refreshComprPhotos(P, comprDeal),
      /**
       * The COMPR window's messages and the pulls that catch the deal up
       * (the effects after this view model call them).
       */
      comprBridge: {
        onMessage: (e: MessageEvent) => {
          // CLOZR's own waiting page in the COMPR window, asking whether its
          // run landed. A page that reloaded mid-run lost the promise that
          // would have moved the window on, so the window asks the page it
          // has now; this page answers once the deal links to a report.
          const wait = e.data as { source?: unknown; type?: unknown; dealId?: unknown } | null;
          if (e.origin === window.location.origin && wait?.source === 'clozr-wait' && wait.type === 'waiting' && typeof wait.dealId === 'string') {
            const dealId = wait.dealId;
            if (comprRunInFlight(dealId) || !claimComprPull('wait:' + dealId, 4_000)) return;
            const d = deals.find((x) => x.id === dealId);
            const go = (lead: string) => {
              if (e.source) adoptComprWindow(e.source as Window);
              showComprReport(lead, { dealId, addr: d?.addr || '' });
            };
            const known = comprLeadIdOfDeal(d);
            if (known) { go(known); return; }
            const id = dbId(dealId);
            if (Number.isFinite(id)) void comprLeadOfDealNow(id).then((lead) => { if (lead) { go(lead); refreshDealOf(dealId); } });
            return;
          }
          const m = parseComprMessage(e);
          if (!m) return;
          comprWindowSpoke(e);
          if (m.type !== 'report') return;
          const r = m.report;
          if (r.status === 'running' || (r.arv == null && r.mao == null)) return;
          const target = comprReportDealId({ leadId: r.leadId, address: r.address }, deals, comprLeadIdOfDeal, comprWindowDeal());
          if (target) applyComprToDeal(target, r);
        },
        /** The rep came back to CLOZR: bring over what was saved in the COMPR window meanwhile. */
        pullBack: () => {
          const w = comprWindowDeal();
          if (w) pullComprDeal(w.dealId);
        },
        pull: pullComprDeal,
        /**
         * A record with a COMPR report, opened: its deal. A house being
         * underwritten takes the numbers COMPR has saved; any other only
         * checks the report has the record's photos.
         */
        pullOnOpen: live && canWrite && comprDeal && comprLeadIdOfDeal(comprDeal) ? comprDeal.id : null,
        pullCheckOnly: !UNDERWRITING_STAGES.has(P.stage),
      },
      /** The record is one of a partner's submissions (opened from a submission row); null on a plain record. */
      submissionFocus: focusDeal ? {
        addr: [focusDeal.addr || 'This property', focusDeal.city].filter(Boolean).join(', '),
        partner: P0.name,
        others: deals.filter((d) => d.personId === P0.id && d.id !== focusDeal.id).length,
        // Every submission from this partner as the People list (one row per house), not the partner's own record.
        showAll: () => go('people', { peopleList: 'Total Submissions', subPartner: { id: P0.id, name: P0.name }, peopleQ: '', personDealId: null, peopleSel: {} }),
        openDealSheet: () => go('dealSheet', { personId: P0.id, dealSheetDealId: focusDeal.id }),
      } : null,
      quickReach: s.quickReach,
      reachPerson: (() => {
        const id = s.quickReach?.personId;
        const r = id ? people.find((p) => p.id === id) : null;
        const src = r || P;
        return { id: src.id, name: src.name, email: src.email, phone: src.phone, addr: src.property.addr };
      })(),
      // The quick box has its own channel; the record composer's tab stays where the rep left it.
      openQuickReach: (ch: 'text' | 'email', personId?: string) => set({
        quickReach: { channel: ch, personId: personId ?? P.id },
      }),
      closeQuickReach: () => set({ quickReach: null }),
      photoShow: s.photoShow,
      openPhotoShow: (title: string, photos: string[], dealDbId?: number | null, startIndex = 0) => {
        const list = collectPhotos(photos);
        if (!list.length && !dealDbId) return;
        const id = Date.now();
        const index = list.length ? Math.max(0, Math.min(startIndex, list.length - 1)) : 0;
        set({ photoShow: { id, title, photos: list, index } });
        if (!dealDbId) return;
        void loadDealAlbum(dealDbId).then((canon) => {
          const merged = collectPhotos([...canon, ...list]);
          if (!merged.length) return;
          // Stay on the photo that was tapped when the full set loads in.
          set((st) => (st.photoShow && st.photoShow.id === id
            ? { photoShow: { ...st.photoShow, photos: merged, index: photoIndexOf(merged, st.photoShow.photos[st.photoShow.index]) } }
            : {}));
        });
      },
      closePhotoShow: () => set({ photoShow: null }),
      stepPhotoShow: (delta: number) => set((st) => {
        if (!st.photoShow?.photos.length) return {};
        const n = st.photoShow.photos.length;
        const index = ((st.photoShow.index + delta) % n + n) % n;
        return { photoShow: { ...st.photoShow, index } };
      }),
      callPerson: () => startCall({ name: P.name, phone: P.phone, personId: P.id }),
      /** One of the seller's other numbers (seller_phones), from the record's Phones row. */
      callPersonAt: (number: string, phoneId: number) => {
        const placed = startCall({ name: P.name, phone: number, personId: P.id, phoneId });
        if (placed && workspaceId !== null && canWrite && !readOnly) void noteDialled(workspaceId, 'seller', phoneId);
        return placed;
      },
      textPerson: () => set({ composerTab: 'Text' }),
      // Next action: the record's earliest open task — what it is, when, and
      // whose. With none, the card offers to schedule one instead of pretending
      // Complete and Reschedule mean something.
      nextTaskLabel: nextOpenTask ? nextOpenTask.title : 'No task scheduled',
      nextTaskDue: nextOpenTask ? nextOpenTask.due : '',
      nextTaskOverdue: !!nextOpenTask && nextOpenTask.bucket === 'overdue',
      nextTaskAssignee: nextOpenTask
        ? (nextOpenTask.assigned && D.team[nextOpenTask.assigned] ? D.team[nextOpenTask.assigned].name : P.assigned || 'Unassigned')
        : P.assigned || 'Unassigned',
      hasNextTask: !!nextOpenTask,
      scheduleNext: () => openAdd('task', { personId: P.id, due: 'Tomorrow 9am' }),
      completeNext: () => {
        if (!nextOpenTask) return;
        set((st) => ({ tasksDone: { ...st.tasksDone, [nextOpenTask.id]: true } }));
        persistTask(nextOpenTask.id, true);
        toast('Completed · ' + nextOpenTask.title);
      },
      // A plan's Compr report step: one click mints the link, sends it the way
      // the step says, and completes the task.
      nextIsComprReport: nextOpenTask?.type === 'compr_report',
      sendNextReport: () => {
        if (!nextOpenTask) return;
        if (!canWrite) return toast('Reports send on a signed-in workspace.');
        const task = nextOpenTask;
        toast('Getting the Compr report link…');
        void sendComprReport(workspaceId, dbId(P.id), { taskId: dbId(task.id), ctx: textCtx }).then((r) => {
          toast(r.message, r.ok ? 'success' : 'error');
          if (!r.ok) return;
          set((st) => ({ tasksDone: { ...st.tasksDone, [task.id]: true } }));
          persistTask(task.id, true);
          reload?.();
        });
      },
      sendComprReport: (audience: 'seller' | 'buyer') => {
        if (!canWrite) return toast('Reports send on a signed-in workspace.');
        toast('Getting the Compr ' + audience + ' report link…');
        void sendComprReport(workspaceId, dbId(P.id), { audience, ctx: textCtx }).then((r) => { toast(r.message, r.ok ? 'success' : 'error'); if (r.ok) refreshPerson(P.id); });
      },
      // when: 'later' (+3h), 'tomorrow' (9 AM), 'nextweek' (Monday 9 AM), or an ISO time.
      rescheduleNext: (when: string) => {
        if (!nextOpenTask) return;
        const d = new Date();
        if (when === 'later') d.setHours(d.getHours() + 3, 0, 0, 0);
        else if (when === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
        else if (when === 'nextweek') { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); }
        else { const t = new Date(when); if (Number.isNaN(t.getTime())) return toast('Pick a date and time.'); d.setTime(t.getTime()); }
        const label = d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const task = nextOpenTask;
        if (!canWrite) {
          set((st) => ({ newTasks: st.newTasks.map((t) => (t.id === task.id ? { ...t, due: label } : t)) }));
          return toast('Moved to ' + label + ' · ' + task.title);
        }
        void setTaskDue(task.id, d.toISOString()).then((r) => {
          if (!r.ok) return toast(r.message || 'Could not reschedule.', 'error');
          toast('Moved to ' + label + ' · ' + task.title, 'success');
          reload?.();
        });
      },
      startDispo, canStartDispo,
      buildOffer: () => openComprDeal(P, comprDeal),
      // ---- The rebuilt record (release 4) ----
      personTab: s.personTab, setPersonTab: (t: string) => set({ personTab: t }),
      recordChips,
      /** "SMS · 42 minutes ago": the last call, text or email either way. */
      lastTouch: P.lastComm,
      /** The deal has a TC file (a transactions row); More › Closing file shows it. */
      hasTcFile: !!TX,
      openClosingFile: () => openTc(P.id, TX?.dealId || recDealOf(P.id)?.id || null),
      // The offer card. Live reads the low and high off the deal: high =
      // COMPR's offer (MAO), low = high − $20k, and either one a person types
      // is theirs, so a COMPR edit moves the MAO and whatever still follows
      // it, never a typed side (lib/offer-band.ts). Clearing a field hands it
      // back. The demo has no COMPR run, so it shows the workspace's 70% rule.
      saveOfferBand: (which: 'low' | 'high', amount: number | null): boolean | Promise<boolean> => {
        if (readOnly) { toast(READ_ONLY_MESSAGE); return false; }
        if (!live || !canWrite || workspaceId === null) { toast('Offer amounts save on a signed-in workspace.'); return false; }
        const deal = recDealOf(P.id);
        if (!deal) { toast('No deal on this record yet.'); return false; }
        return saveOfferBandWrite(workspaceId, dbId(deal.id), which, amount, me).then((r) => {
          if (!r.ok || !r.band) { toast(r.message || 'Could not save that offer.', 'error'); return false; }
          patchDeal(deal.id, { wholesale: r.band.low, institutional: r.band.high, lowSet: r.band.lowSet, highSet: r.band.highSet });
          refreshDealOf(deal.id);
          return true;
        });
      },
      offerCard: (() => {
        const d = live ? recDealOf(P.id) : undefined;
        const m = live ? d?.mao ?? null : mao;
        const band = live
          ? offerBand({ mao: m, low: d?.wholesale, high: d?.institutional, lowSet: d?.lowSet, highSet: d?.highSet })
          : offerBand({ mao: m });
        const low = band.low;
        const high = band.high;
        const comprUrl = d?.underwritingUrl || null;
        return {
          mao: band.mao, maoLabel: fmt(band.mao), arvLabel: fmt(live ? d?.arv ?? null : arv), rehabLabel: fmt(live ? d?.rehab ?? null : rehabTotal),
          low, lowLabel: fmt(low), high, highLabel: fmt(high),
          /** A person typed this side; COMPR leaves it alone. */
          lowSet: band.lowSet, highSet: band.highSet,
          basis: live ? 'Max offer (MAO), from COMPR · high = offer, low = offer − $20k' : 'Max offer (MAO), 70% rule',
          sent: P.offer || null,
          status: P.offer ? (live ? 'On the deal' : 'Sent · viewed 3×') : 'No offer yet',
          contract: contractStatus,
          comprUrl,
          // Every offer and counter on this contact (or the open submission), read by the card itself.
          history: live && workspaceId != null ? { workspaceId, sellerId: dbId(P.id), dealId: d ? dbId(d.id) : null, canWrite: canWrite && !readOnly } : null,
        };
      })(),
      offerSend, offerTcName: teamTc(D.team)?.name ?? null,
      /**
       * Make offer (the sheet, the O key, the command bar): the offer is logged
       * and its price goes on the record at once. No letter, no draft, nobody
       * pinged; the database puts it on the deal, lines it on the timeline and
       * moves the record to Offer Made (offers_after_write).
       */
      sendOfferFromSheet: async (amount: number): Promise<boolean> => {
        if (readOnly) { toast(READ_ONLY_MESSAGE); return false; }
        if (live && !canWrite) { toast('Offers save on a signed-in workspace.'); return false; }
        const pid = P.id;
        const shown = offerMoney(amount);
        set((st) => ({ offerPatches: { ...st.offerPatches, [pid]: shown } }));
        const prev = offerPatchTimers.get(pid);
        if (prev) window.clearTimeout(prev);
        offerPatchTimers.set(pid, window.setTimeout(() => {
          offerPatchTimers.delete(pid);
          set((st) => {
            if (!(pid in st.offerPatches)) return {};
            const rest = { ...st.offerPatches };
            delete rest[pid];
            return { offerPatches: rest };
          });
        }, 30_000));
        if (!canWrite || workspaceId === null) {
          toast('Offer ' + shown + ' logged (demo)');
          return true;
        }
        toast('Offer ' + shown + ' logged on ' + P.property.addr, 'success');
        const onDeal = recDealOf(pid);
        void logOfferWrite(workspaceId, { sellerId: dbId(pid), dealId: onDeal ? dbId(onDeal.id) : null, amount, basis: 'Logged on the record' })
          .then((r) => {
            if (!r.ok) return toast('The offer did not save: ' + r.message, 'error');
            refreshPerson(pid);
          });
        return true;
      },

      // compr
      noop: () => {},
      heroStatus: underwritten
        ? { tone: 'good' as const, text: 'Underwritten' }
        : { tone: 'caution' as const, text: 'Not underwritten' },
      heroRing: [{ v: fmt(arv), k: 'ARV' }, { v: fmt(rehabTotal), k: 'Rehab' }, { v: '$22,000', k: 'Assignment' }],
      compCols: ['Address', 'Distance', 'Sale date', 'Sold price', '$/SF', 'Sqft', 'Beds', 'Baths', 'Year', 'Stories', 'Cond.', 'Subdivision', ''],
      comprTabs, comprTab: s.comprTab,
      isComprTab: Object.fromEntries(comprTabNames.map((t) => [t.replace(' ', ''), s.comprTab === t])) as Record<string, boolean>,
      comps, arv: fmt(arv),
      arvLow: arv === null ? '—' : fmt(arv - 13000),
      arvHigh: arv === null ? '—' : fmt(arv + 8000),
      underwritten,
      // "run 2h ago" from the latest COMPR activity on this record; the mock
      // graph keeps its scripted stamp.
      comprRanLabel: live
        ? (() => { const t = D.timeline.find((x) => x.type === 'compr' && x.entity === P.id); return t ? 'run ' + t.time.toLowerCase() : 'not run yet'; })()
        : 'run yesterday 3:58 PM',
      intel, buyBoxMatches, photos,
      visionRun: s.visionRun,
      runVision: () => { set({ visionRun: true }); toast('Compr Vision analyzed 6 photos'); },
      visionRows, riskRows, subjectSqft: P.property.sqft.toLocaleString(),
      usedCount: usedComps.length, rejectedCount: comps.length - usedComps.length,
      // An offer needs a number. Without an ARV there isn't one, and moving the
      // stage on an offer that was never priced is worse than refusing.
      canSendOffer: mao !== null,
      sendOffer: () => {
        if (mao === null) return toast('Underwrite the property first — there is no ARV to price an offer from.');
        if (canWrite) return generateOffer(mao);
        set((st) => ({ stageOverrides: { ...st.stageOverrides, [P.id]: 'Offer Sent' } }));
        persistStage(P.id, 'Offer Sent');
        return toast('Offer $' + mao.toLocaleString() + ' sent to ' + P.name);
      },
      // Generate offer: the number from the underwriting (or the one given),
      // the offers row (the database writes the deal and moves the seller to
      // Offer Made) and the offer letter with its signing link.
      generateOffer,
      generateOfferTitle: offerSend
        ? 'Prices it from the underwriting, fills the Acme Homes letter and sends the seller a signing link'
        : 'Prices it from the underwriting, creates the offer as a draft and tells the TC it’s ready to send',
      hasOffer: !!P.offer,

      // talkr
      startCallFromTalkr: () => startCall({
        name: TC.name, phone: (TC.who as Person).phone, personId: TC.isBuyer ? null : TC.who.id,
      }),
      openTalkrRecord: () => (!TC.who.id ? toast('No CRM record for this number yet') : TC.isBuyer ? openBuyer(TC.who.id) : openPerson(TC.who.id)),
      sendTalkr: () => {
        if (!talkrLive) return sendToThread('talkr:' + TC.id, 'SMS sent to ' + TC.name);
        const text = s.composerText.trim();
        if (!text) return toast('Type a message first');
        // The thread carries only a conversation id; the CRM record behind it is the one to check.
        if (isBlacklisted(TC.who as Contactable | undefined)) return toast(BLACKLIST_MESSAGE, 'error');
        void phone.sendSms({ conversation_id: TC.id, body: text }).then((ok) => {
          if (ok) set({ composerText: '' });
          toast(ok ? 'SMS sent to ' + TC.name : phone.data.error ?? 'Could not send', ok ? 'success' : 'error');
        });
      },
      // One label per entry in a deal row's `cells`, in the same order. The
      // Deals screen turns them into keyed fields for the Columns menu.
      dealCols: [...DEAL_COL_LABELS],
      tcOpenCount,
      // The open file closing soonest.
      openTcFiles: () => {
        const t = tcOpenFiles[0];
        if (t) openTc(t.personId, t.dealId || null);
        else toast(D.transactions.length ? 'No open transaction files' : 'No transaction files yet');
      },
      isTable: s.dealsView === 'table',
      inventoryCols: ['Property', 'Market', 'Contract', 'ARV', 'Spread', 'On market', 'Buyer matches', 'Campaign', 'Offers', 'Best offer', 'Option', 'Dispo rep', 'Status'],
      talkrFolders, talkrFolder: s.talkrFolder, talkrConvs, TC, talkrMsgs,
      callState, isIdle: callState === 'idle', isLive: callState === 'live', isWrap: callState === 'wrap',
      callClock, transcript, dialerOpen: s.dialerOpen, dialerTabs, dialerTab: s.dialerTab,
      isDial: s.dialerTab === 'Dial', isQueue: s.dialerTab === 'Queue',
      isRecent: s.dialerTab === 'Recent', isVoicemail: s.dialerTab === 'Voicemail',
      dialNumber: s.dialNumber,
      setDial: (e: React.ChangeEvent<HTMLInputElement>) => set({ dialNumber: e.target.value }),
      // The Inbox screen is Talkr's own messages page (components/talkr). It
      // needs to know whether Talkr recognises this rep, and a way to ring a
      // number through the floating dialer.
      talkrAuthed: talkrLive,
      // A number from the Talkr dialer or the inbox: the call carries the CLOZR
      // record behind it, so the context panel and wrap-up land on that record.
      dialE164: (e164: string) => startCall(dialerRecordFor(e164)?.target ?? { name: formatPhone(e164), phone: e164 }),
      // A phone number shown in a list (People, Deals, Buyers). It used to be a
      // plain tel: link, which on a desktop rang through whatever the OS had
      // — no do-not-call check, and nothing logged. This is click-to-call.
      callPhone: (number: string) => startCall(dialerRecordFor(number)?.target ?? { name: number, phone: number }),
      dialerRecordFor, callRecord,
      talkrPhone: phone, phoneEnabled,
      // A phone has no dialer screen to go to: the full-screen phone is it.
      goDialer: () => (s.isMobile ? openPhone('Dial') : go('dialer', { dialerOpen: false })),
      // A call note belongs to the seller on the line, never to whichever seller was opened last.
      addCallNote: () => openAdd('note', callPid ? { personId: callPid } : {}),
      // What was typed in Call notes lands on the record when the call is over,
      // on the call itself (lib/call-outcome-write): the call's row carries the
      // outcome and the note, once. With no Talkr call it is one note.
      saveCallNote: (text: string, target: CallTarget | null, opts?: { callId?: string | null; outcome?: string | null }) => {
        const body = text.trim();
        if ((!body && !opts?.outcome) || !canWrite || workspaceId === null || !target) return;
        const t = target.personId || target.buyerId ? target : dialerRecordFor(target.phone)?.target;
        if (!t?.personId && !t?.buyerId) return;
        const c = sp.call && sp.call.id === opts?.callId ? sp.call : null;
        void writeCallOutcome({
          workspaceId, talkrCallId: opts?.callId ?? null,
          sellerId: t.personId ? dbId(t.personId) : null, buyerId: t.buyerId ? dbId(t.buyerId) : null, dealId: t.dealId ? dbId(t.dealId) : null,
          outcome: opts?.outcome ?? null, note: body || null,
          call: c ? { direction: c.direction, fromPhone: c.from_number, toPhone: c.to_number, occurredAt: c.answered_at ?? c.created_at ?? new Date().toISOString() } : null,
        }).then((r) => {
          if (!r.ok) return toast('Call note not saved: ' + r.message, 'error');
          refreshPerson(t.personId);
          if (body) toast('Call note saved to ' + t.name, 'success');
        });
      },
      // The CLOZR record behind a Talkr thread's number: a seller wins over a buyer.
      talkrRecordFor: (() => {
        type Rec = { kind: 'seller' | 'buyer'; name: string; address: string; stage: string; open: () => void };
        // Built on first lookup, not on every render: it walks every contact.
        let idx: Map<string, Rec> | null = null;
        const build = () => {
          const m = new Map<string, Rec>();
          for (const b of buyers) {
            const e = toE164(b.phone);
            if (e) m.set(e, { kind: 'buyer', name: b.name, address: '', stage: b.status, open: () => openBuyer(b.id) });
          }
          for (const p of people) {
            const e = toE164(p.phone);
            const address = [p.property.addr, p.property.city, p.property.st].filter(Boolean).join(', ');
            if (e) m.set(e, { kind: 'seller', name: p.name, address, stage: p.stage, open: () => openPerson(p.id) });
          }
          return m;
        };
        return (e164: string): Rec | null => (idx ??= build()).get(e164) ?? null;
      })(),
      // The same, by E.164 or email, with the database id and the merge-field
      // values the inbox composers and templates fill in. A seller wins over a buyer.
      recordForContact: (() => {
        type Rec = { kind: 'seller' | 'buyer'; id: number; name: string; address: string; stage: string; open: () => void; recipient: Recipient };
        // Built on first lookup, not on every render: it walks every contact.
        let idx: Map<string, Rec> | null = null;
        const byId = new Map<string, Rec>();
        const build = () => {
          const m = new Map<string, Rec>();
          const put = (keys: string[], r: Rec) => { byId.set(r.kind + ':' + r.id, r); for (const k of keys) if (k) m.set(k, r); };
          for (const b of buyers) {
            put([toE164(b.phone) ?? '', (b.email ?? '').trim().toLowerCase()], {
              kind: 'buyer', id: dbId(b.id), name: b.name, address: '', stage: b.status, open: () => openBuyer(b.id),
              recipient: { sellerId: null, buyerId: dbId(b.id), name: b.name, phone: b.phone || null, email: b.email },
            });
          }
          for (const p of people) {
            const d = dealOf(p.id);
            const tx = D.transactions.find((t) => t.personId === p.id);
            put([toE164(p.phone) ?? '', (p.email ?? '').trim().toLowerCase()], {
              kind: 'seller', id: dbId(p.id), name: p.name, stage: p.stage, open: () => openPerson(p.id),
              address: [p.property.addr, p.property.city, p.property.st].filter(Boolean).join(', '),
              recipient: {
                sellerId: dbId(p.id), name: p.name, phone: p.phone || null, email: p.email,
                address: p.property.addr, city: p.property.city, state: p.property.st, zip: p.property.zip,
                askingPrice: p.asking, offer: d?.contract ? fmt(d.contract) : p.offer ?? '', closeDate: d?.close ?? tx?.closing ?? '',
                titleCompany: tx?.titleCo ?? '', beds: p.property.beds ? String(p.property.beds) : '', baths: p.property.baths ? String(p.property.baths) : '',
                photoUrl: p.property.img,
              },
            });
          }
          return m;
        };
        // A record's other phones and addresses (lib/contact-alternates): asked
        // for on a miss, so a seller texting from their second phone is named.
        return (key: string): Rec | null => {
          const k = key.includes('@') ? key.trim().toLowerCase() : key;
          const hit = (idx ??= build()).get(k);
          if (hit) return hit;
          const alt = alternates.found.get(k);
          if (alt === undefined) { alternates.ask(k); return null; }
          return alt ? byId.get(alt.kind + ':' + alt.id) ?? null : null;
        };
      })(),
      /**
       * A deal by its database id, as the inbox labels an email the Gmail
       * sync filed under it: the property's street, opening the seller record
       * the deal lives on. Null for a deal this workspace load does not hold.
       */
      ...(() => {
        const idx = new Map<number, { id: number; label: string; stage: string | null; sellerId: number | null; who: string | null; open: () => void }>();
        for (const d of deals) {
          // An archived deal (a duplicate, a dead file) is no folder and no place to file mail.
          if (d.archived) continue;
          const p = d.personId ? person(d.personId) : undefined;
          // The deal's own property: a wholesaler on thirty submissions is the "seller" of all of them.
          const label = d.addr || p?.property.addr || p?.name || 'Deal';
          const sellerId = d.personId && /^\D*\d+$/.test(d.personId) ? dbId(d.personId) : null;
          idx.set(dbId(d.id), { id: dbId(d.id), label, stage: d.stage ?? null, sellerId, who: p?.name ?? null, open: () => (d.personId ? openPersonDeal(d.personId, d.id) : undefined) });
        }
        // The Email tab's deal folders read the whole list; everything else looks one up.
        return { dealForId: (id: number) => idx.get(id) ?? null, mailDeals: Array.from(idx.values()) };
      })(),
      keypad, callQueue, callQueueManual, clearCallQueue, recentCalls, voicemails, callTarget,
      startCall: () => startCall(s.dialNumber ? { name: s.dialNumber, phone: s.dialNumber } : null),
      endCall,
      // `values` is what the rep left in the wrap-up's fields, keyed as
      // wrapFields keys them. Those are what get written, not the raw summary,
      // so a motivation or price the rep corrected is the one saved; a field
      // they emptied is not written. A key left out falls back to the summary.
      acceptWrap: (values: Partial<Record<WrapKey, string>>) => {
        if (!phoneEnabled) return finishCall('CRM fields updated · task created · follow-up 2:00 PM');
        const summ = phone.summary;
        if (!summ) return finishCall('Call logged');
        const field = (key: WrapKey) => (values[key] ?? summ[key] ?? '').trim() || null;
        const motivation = field('motivation'), price = field('price_expectation');
        const followUp = field('follow_up'), task = field('suggested_task');
        // A power-dialer call opens with no record on it (onCallOpened), so find
        // the seller by the number, as saveCallNote does, and write to it just
        // as a click-to-call from the record would.
        const ct = s.callTarget;
        const target = ct && !ct.personId && !ct.buyerId ? dialerRecordFor(ct.phone)?.target ?? ct : ct;
        const sellerId = target?.personId && /^\D*\d+$/.test(target.personId) ? dbId(target.personId) : null;
        void (async () => {
          const done: string[] = [];
          // canWrite: an admin's "View as" places real calls but saves nothing,
          // since anything written would be stamped with the teammate's id.
          if (canWrite && workspaceId && sellerId && Number.isFinite(sellerId)) {
            // The summary, timeline and objection are already on the call
            // (its AI notes, filed at hang-up); only the fields move here.
            const r = await applyCallFacts(sellerId, { motivation, asking_price: parseMoney(price) });
            if (r.ok) done.push('CRM fields updated');
            if (task) {
              const t = await createTask(workspaceId, { title: task, type: 'Call', due: followUp ?? 'today', personId: target!.personId! }, me);
              if (t.ok) done.push('task created');
            }
            reload?.();
          } else if (canWrite && task && workspaceId) {
            const t = await createTask(workspaceId, { title: `${task} — ${target?.name ?? 'call'}`, type: 'Call', due: followUp ?? 'today' }, me);
            if (t.ok) done.push('task created');
            reload?.();
          }
          finishCall(done.length ? done.join(' · ') : 'Call logged');
        })();
      },
      dismissWrap: () => finishCall('Call logged'),
      wrapFields,
      toggleMute: () => (phoneEnabled ? sp.toggleMute() : set({ muted: !s.muted })),
      toggleHold: () => (phoneEnabled ? void sp.toggleHold() : set({ hold: !s.hold })),
      muted, hold,
      muteBg: muted ? '#18181b' : '#fff', muteColor: muted ? '#fff' : '#18181b',
      holdBg: hold ? '#18181b' : '#fff', holdColor: hold ? '#fff' : '#18181b',
      rec: s.rec, ai: s.ai,
      recLocked: phoneEnabled,
      toggleRec: () => (phoneEnabled ? toast('Talkr records every call, dual-channel, with consent handled by the carrier flow') : set({ rec: !s.rec })),
      toggleAiRec: () => set({ ai: !s.ai }),
      recBg: s.rec ? '#0A8560' : '#e4e4e7', aiBg: s.ai ? '#0A8560' : '#e4e4e7',
      recX: s.rec ? '14px' : '2px', aiX: s.ai ? '14px' : '2px',
      callTargetLine: callTarget.phone,
      callerIds: ['(210) 555-0100 · San Antonio', '(214) 555-0100 · Dallas', '(713) 555-0100 · Houston'],
      callerIdLabel: phoneEnabled
        ? (phone.data.status === 'ok'
          ? `caller ID ${phone.callerId.label}${phone.callerId.city ? ' · ' + phone.callerId.city : ''}`
          : phone.data.status === 'loading' ? 'connecting to Talkr…'
            : phone.data.status === 'unlinked' ? 'not linked to Talkr yet'
              : phone.data.status === 'unreachable' ? 'Talkr unreachable' : 'Talkr error')
        : 'caller ID (210) 555-0100 · San Antonio',
      callerIdOpen: s.callerIdOpen,
      toggleCallerId: () => (phoneEnabled && phone.callerIdOptions.length ? set({ callerIdOpen: !s.callerIdOpen }) : undefined),
      callerIdOptions: [
        ...phone.callerIdOptions.map((o) => ({
          label: o.label + (o.city ? ' · ' + o.city : '') + (o.isDefault ? ' · default' : o.mine ? ' · mine' : '') + (o.blocked ? ' · ' + o.blocked : ''),
          active: phone.callerId.mode === 'dedicated' && o.id === phone.callerId.id,
          go: () => {
            set({ callerIdOpen: false });
            if (o.blocked) {
              toast('That caller ID is not a live Telnyx line. Pick a different caller ID.');
              return;
            }
            void phone.setCallerId(o.id);
          },
        })),
        ...((phone.callerIdOptions.filter((o) => !o.blocked).length > 1 || phone.callerId.mode === 'local_presence') ? [{
          label: 'Local presence · match the seller’s area code',
          active: phone.callerId.mode === 'local_presence',
          go: () => { set({ callerIdOpen: false }); void phone.setCallerId('local_presence'); },
        }] : []),
      ],
      talkrStatus: phoneEnabled ? phone.data.status : 'demo',
      talkrError: phone.data.error ?? sp.deviceError ?? sp.controlError,
      liveStatusLine: phoneEnabled
        ? (sp.phase === 'in_call' ? `Live · ${callClock} · recording` : sp.phase === 'ringing' ? 'Ringing…' : sp.phase === 'connecting' ? 'Connecting…' : `Live · ${callClock}`)
        : `Live · ${callClock} · recording`,
      listeningLabel: !phoneEnabled ? '● listening'
        : !s.ai ? 'transcription off'
          : phone.tx.status === 'listening' ? '● listening'
            : phone.tx.status === 'armed' ? 'waiting for a conversation'
            : phone.tx.status === 'error' ? (phone.tx.error ?? 'transcript unavailable')
              : sp.phase === 'in_call' ? '● connecting' : 'waiting for answer',
      suggestedResponse: !phoneEnabled
        ? '"Totally fair. Besides price, what would make one offer easier for you to move forward with today?"'
        : phone.intel ? `"${phone.intel.suggested_response}"` : (s.ai ? (phone.intelBusy ? 'Listening…' : 'Suggestions appear after the seller’s first few sentences.') : 'Turn on AI transcription to get suggestions.'),
      nextBestQuestion: !phoneEnabled
        ? '"If we cover moving costs and guarantee Sept 30, is the $235K the only gap?"'
        : phone.intel ? `"${phone.intel.next_best_question}"` : '—',
      aiCoaching: !phoneEnabled
        ? 'Talk ratio 38 / 62 — good. Seller repeated "certainty" twice: anchor the close date before discussing price. Don\'t mention the $181K MAO on this call.'
        : phone.intel ? `${phone.intel.talk_ratio ? `Talk ratio ${phone.intel.talk_ratio.rep} / ${phone.intel.talk_ratio.seller}. ` : ''}${phone.intel.coaching}` : '—',
      summaryText: !phoneEnabled
        ? 'Seller values speed and certainty over maximum price. Has a competing verbal at $235K with a 60-day close and inspection. Needs moving costs covered; must be out before Sept 30.'
        : phone.summary ? phone.summary.summary
          : phone.summaryStatus === 'no_answer' ? (sp.ringOut?.message ?? 'Nobody picked up — the call ended on the greeting, so there is nothing to transcribe or summarise.')
            : phone.summaryStatus === 'working' ? 'Summarising the call…'
              : phone.summaryStatus === 'unavailable' ? (s.ai ? 'No transcript was captured for this call.' : 'AI transcription was off for this call, so there is no summary. Talkr’s recording will still be transcribed if that is configured.')
                : '—',
      sentimentLabel: !phoneEnabled ? 'Positive' : phone.summary?.sentiment ? phone.summary.sentiment.replace(/^./, (c) => c.toUpperCase()) : '—',
      sentimentColor: !phoneEnabled ? '#15803d'
        : phone.summary?.sentiment === 'positive' ? '#15803d' : phone.summary?.sentiment === 'negative' ? '#dc2626' : '#71717a',
      talkRatioLabel: !phoneEnabled ? '38 / 62' : phone.summary?.talk_ratio ? `${phone.summary.talk_ratio.rep} / ${phone.summary.talk_ratio.seller}` : '—',
      wrapStatusLine: !phoneEnabled ? `${callClock} · recorded · transcribed`
        : phone.summaryStatus === 'no_answer' ? `${callClock} · no answer`
          : `${callClock} · recorded${phone.summaryStatus === 'ready' ? ' · transcribed' : phone.summaryStatus === 'working' ? ' · transcribing…' : ''}`,
      hasWrapFields: !phoneEnabled || !!phone.summary,
      canAccept: !phoneEnabled || !!phone.summary,
      /**
       * Nobody picked up. The card drops the parts that only make sense for a
       * conversation — the sentiment and talk-ratio row, the CRM fields drawn
       * from what was said, the button that accepts them — and leaves the rep
       * with the one thing there is to do, which is close it and dial on.
       */
      wrapNoAnswer: phoneEnabled && phone.summaryStatus === 'no_answer',
      // in-call controls that need a carrier
      canControl: phoneEnabled && sp.phase === 'in_call',
      keypadOpen,
      toggleKeypad: () => set({ keypadOpen: !keypadOpen, transferOpen: null }),
      dtmf: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => ({ k, go: () => sp.sendDigits(k) })),
      transferOpen,
      openTransfer: (kind: 'transfer' | 'conference') => set({ transferOpen: transferOpen === kind ? null : kind, keypadOpen: false, transferTo: '' }),
      transferTo: s.transferTo,
      setTransferTo: (e: React.ChangeEvent<HTMLInputElement>) => set({ transferTo: e.target.value }),
      transferTargets: phone.data.team.filter((m) => m.id !== phone.data.me?.id).map((m) => ({
        id: m.id, name: m.display_name, presence: m.presence ?? 'offline',
        go: () => {
          const kind = s.transferOpen;
          set({ transferOpen: null });
          if (kind === 'conference') void sp.addParticipant({ user_id: m.id }).then(() => toast(m.display_name + ' is being added'));
          else void sp.transfer({ mode: 'warm', user_id: m.id }).then(() => toast('Warm transfer to ' + m.display_name + ' — complete it once they pick up'));
        },
      })),
      transferToNumber: () => {
        const to = toE164(s.transferTo);
        if (!to) return toast('Enter a number');
        const kind = s.transferOpen;
        set({ transferOpen: null, transferTo: '' });
        if (kind === 'conference') void sp.addParticipant({ to_number: to }).then(() => toast('Dialing ' + formatPhone(to) + ' into the call'));
        else void sp.transfer({ mode: 'warm', to_number: to }).then(() => toast('Warm transfer to ' + formatPhone(to)));
      },
      completeTransfer: () => void sp.completeTransfer().then(() => toast('Transfer complete')),
      participantsLine: sp.participants.filter((p) => p.state !== 'left' && p.role !== 'agent').length > 1
        ? `${sp.participants.filter((p) => p.state !== 'left' && p.role !== 'agent').length} on the line`
        : '',
      incoming: incomingV,
      softphoneReady: !phoneEnabled || sp.deviceState === 'ready',
      softphoneLabel: !phoneEnabled ? '' : sp.deviceState === 'ready' ? 'Softphone ready' : sp.deviceState === 'connecting' ? 'Connecting softphone…' : sp.deviceState === 'error' ? (sp.deviceError ?? 'Softphone error') : 'Softphone off',
      enableSoftphone: () => void sp.initDevice({ claim: true }),

      // deals
      get dealsCols() { return dealsCols(); },
      get dealRows() { return dealRows(); },
      /** Deals → RVM sellers: what the bulk composer needs besides the rows (every role that sees Deals, TCs included). */
      dealsRvm: { workspaceId, canWrite, textCtx, toast, reload },
      dealsViews, isPipeline: s.dealsView === 'pipeline',
      /** "Open in Inbox" on an email in a record's activity: the Inbox, on that thread. */
      /** A vendor on a deal team (title rep, lender…): their company's list in People, searched to them. */
      openVendorContact: (v: { id: number; name: string; role: string }) => go('people', {
        peopleList: v.role === 'title' ? 'Title Companies' : v.role === 'lender' ? 'Lenders' : v.role === 'photographer' ? 'Photographers / Notaries' : v.role === 'wholesaler' ? 'Wholesalers' : vendorListOf('v' + v.id),
        peopleQ: v.name,
      }),
      openEmailInInbox: (e: { inbound: boolean; from: string; to: string[]; subject: string }) => { requestInboxThread(threadKeyFor(e)); go('inbox'); },
      archiveDeal: (dealId: string) => archiveDealFlow(dealId, true),
      /** The same, from screens that hold the database id (deal sheet, Dispo). */
      archiveDealDb: (id: number | null | undefined, archive = true) => { const d = id == null ? null : deals.find((x) => dbId(x.id) === id); if (d) archiveDealFlow(d.id, archive); },
      dealArchivedDb: (id: number | null | undefined) => (id == null ? false : !!deals.find((x) => dbId(x.id) === id)?.archived),
      unarchiveDeal: (dealId: string) => archiveDealFlow(dealId, false),
      dealsArchived: s.dealsArchived,
      // Archived deals include Terminated ones, which have no board column: the archive is a list.
      dealExtraStages: s.dealExtraStages,
      setDealExtraStages: (list: string[]) => set({ dealExtraStages: list }),
      /** Everything the board can show beyond the pipeline: off-pipeline deal stages, then every seller stage. */
      dealExtraOptions: ['Terminated', 'Realtor Referral', ...SELLER_STAGES.map((x) => SELLER_COL + x.label)],
      dealStageChoices,
      /** A deal's stage by database id, with a move still saving shown (the deal sheet's stage picker). */
      dealStageOfDb: (id: number) => deals.find((d) => d.id === 'd' + id)?.stage ?? null,
      setDealStageDb: (id: number, stg: string) => { void moveDealStage(deals.find((d) => d.id === 'd' + id), stg); },
      setDealsArchived: (on: boolean) => set(on ? { dealsArchived: true, dealsView: 'table' } : { dealsArchived: false }),
      archivedDealCount: deals.filter((d) => d.archived && d.stage !== 'Prospect').length,
      dealDragging: s.dragging != null,
      dealDragId: s.dragging,
      /** The column the dragged card starts in; a drop there changes nothing. */
      dealDragFrom: s.dragging == null ? null
        : live ? (deals.find((d) => d.id === s.dragging)?.stage ?? null)
        : (people.find((p) => p.id === s.dragging)?.stage ?? null),
      // "Under contract · projected": open contracts only — closed and terminated deals are not pipeline.
      dealsTotal: kFmt(pipelineDeals.filter((d) => !PIPELINE_DONE.has(d.stage ?? '')).reduce((a, d) => a + (d.contract || 0), 0)),
      dealsProfit: kFmt(pipelineDeals.filter((d) => !PIPELINE_DONE.has(d.stage ?? '')).reduce((a, d) => a + (d.profit || 0), 0)),

      // dispo
      goOffersTab: () => set({ dispoTab: 'Offers' }),
      goMatchesTab: () => set({ dispoTab: 'Matches' }),
      goMarketingTab: () => set({ dispoTab: 'Marketing', campaignStep: 2 }),
      topMatches: matches.slice(0, 3),
      walkRowsHere: walkRows.filter((w) => w.addr === DP.property.addr),
      dispoContract: fmt(dd.contract),
      noAccepted: !acceptedOffer,
      offerCols: ['', 'Buyer', 'Offer', 'Assignment', 'Net', 'EMD', 'Inspection', 'Closing', 'Financing', 'Proof of funds', 'Terms', 'Confidence', ''],
      dispoFilters, dispoFilter: s.dispoFilter, inventory, dispoTabs, dispoTab: s.dispoTab,
      isDispoTab: Object.fromEntries(dispoTabNames.map((t) => [t, s.dispoTab === t])) as Record<string, boolean>,
      DP: (() => {
        const house = houseOf(DP, pinnedDeal || dealOf(DP.id));
        return {
        addr: DP.property.addr, cityLine: DP.property.city + ', ' + DP.property.st + ' ' + DP.property.zip,
        seller: DP.name,
        img: house.img,
        imgSafe: house.img,
        streetSafe: house.street,
        photos: house.photos,
        dealDbId: house.dealDbId,
        facts: DP.property.beds + ' bd · ' + DP.property.baths + ' ba · ' + DP.property.sqft.toLocaleString() + ' sf · ' + DP.property.year,
        rep: repName((DD as { owner?: string | null }).owner),
        // Live: the deal's real stage, not a label the screen assumed.
        status: live ? dealStageOf(DD as Deal, DP) || '—' : s.acceptedOffer ? 'ASSIGNED' : 'MARKETING',
        statusColor: live ? stageColor(dealStageOf(DD as Deal, DP)) : s.acceptedOffer ? '#0A8560' : '#c2410c',
        open: () => openPersonDeal(DP.id, ddId || null),
        };
      })(),
      dispoHead, matches, matchCount: matches.length, matchQ: s.matchQ, runMatching,
      setMatchQ: (e: React.ChangeEvent<HTMLInputElement>) => set({ matchQ: e.target.value }),
      matchFilters,
      campaignMetrics, engagementFeed, offerRows, acceptedOffer,
      get dispoBuyerChoices() { return dispoBuyerChoices(); },
      get dispoDeskBuyerChoices() { return dispoDeskBuyerChoices(); },
      deskBuyerOf, scheduleWalkthrough,
      /** Owners and admins approve an offer under the ask (the database checks it too, migration 235). */
      canApproveOffers: !live || isAdmin(role),
      hasAccepted: !!acceptedOffer,
      // Dispositions can assign a deal but cannot open TC, so for them the
      // write still happens and the toast says who has the file now, instead
      // of following it to a screen go() will not open.
      assignLabel: can.tc ? 'Assign & open TC' : 'Assign to TC',
      /**
       * Assign & open TC, for a deal the Offer desk already marked sold: it
       * puts *this* deal (deals.stage, deal_stages) at Buyer Under Contract,
       * never the seller's lead stage, so a seller with several deals moves
       * only the one that sold. Then TC takes the file.
       */
      generateAssignment: () => {
        const tcName = teamTc(D.team)?.name;
        const handedOff = (tcName ? tcName + ' takes it from here in TC' : 'TC takes it from here') + ' and sends the assignment';
        if (!canWrite || !ddId) {
          if (!can.tc) return toast('Deal at Buyer Under Contract · ' + handedOff + ' (demo)');
          toast('Deal moved to TC (demo)');
          setTimeout(() => openTc(DP.id, ddId || null), 600);
          return;
        }
        void (async () => {
          // TC takes a sold deal: the buyer and the price are on it (Mark Sold).
          const { loadDispoDeal } = await import('@/lib/dispo-sop');
          const row = await loadDispoDeal(dbId(ddId));
          if (!row) return toast('Could not read this deal. Reload and try again.', 'error');
          // Never backwards: a deal already in escrow, closed or terminated keeps its stage.
          const early = ['Prospect', 'Under Contract Seller', 'Ready To Market'].includes(String(row.stage));
          // Moving a deal to Buyer Under Contract needs Mark Sold, which records
          // the price, tells acquisitions and logs the sale. A deal already past
          // it (sold before Mark Sold existed, or moved on the board) just opens
          // in TC: Mark Sold could never be done for it without an offer row.
          if (early && !row.sold_at) {
            set({ dispoTab: 'Offers' });
            return toast('Mark it sold on the Offer desk first: TC needs the buyer and the price.');
          }
          const r = early ? await setDealStageWrite(workspaceId as number, ddId, 'Buyer Under Contract', me) : { ok: true as const, message: undefined };
          if (!r.ok) return toast('The deal did not move to Buyer Under Contract: ' + (r.message || 'try again.'), 'error');
          if (early) set((st) => ({ dealStageOverrides: { ...st.dealStageOverrides, [ddId]: { stage: 'Buyer Under Contract' } } }));
          reload?.();
          const at = early ? 'Deal at Buyer Under Contract' : 'Deal at ' + String(row.stage);
          if (!can.tc) return toast(at + ' · ' + handedOff, 'success');
          toast(at + ' · generate the assignment from the TC file', 'success');
          openTc(DP.id, ddId);
        })();
      },
      canSeeLeaderboard: canSee(role, 'leaderboard'),
      walkRows, dispoActivity, openTcFromDispo: () => openTc(DP.id, ddId || null),

      // buyers
      buyerCount: buyerRows.length,
      buyerCols: ['Buyer', 'Status', 'Markets', 'Type', 'Price range', 'Exit', 'Engagement', 'Last purchase', 'Last activity', 'Prefers'],
      taskCols: ['Task', 'Person', 'Property', 'Type', 'Due', 'Assigned', 'Priority', ''],
      callInbox: () => startCall({
        name: IC.name, phone: (IC.who as Person).phone, personId: IC.isBuyer ? null : IC.who.id,
      }),
      sendInbox: () => sendToThread('inbox:' + IC.id, 'Reply sent to ' + IC.name),
      /**
       * A buyer field saved in place (components/buyer/BuyerProfileFields):
       * the lists show the new name, VIP, vetted and markets with no re-read.
       */
      patchBuyerLocal: (id: number, r: { name?: unknown; company?: unknown; vip?: unknown; vetted_at?: unknown; markets?: unknown; status?: unknown; blacklisted_at?: unknown }) => {
        if (!patchLocal) return reload?.();
        const name = String(r.name ?? '');
        // A status the list worked out from more than these fields (a holding
        // prospect list, blacklisted, inactive) stays as the list has it.
        const cur = buyer('b' + id)?.status ?? '';
        const status = /^(Prospect|Blacklisted|Inactive)$/.test(cur) ? cur : r.vip ? 'VIP' : r.vetted_at ? 'Vetted' : 'Follow-up';
        patchLocal('buyers', {
          id: 'b' + id, name, company: (r.company as string | null) || name, vip: !!r.vip, vetted: !!r.vetted_at, status,
          ...(Array.isArray(r.markets) ? { markets: r.markets as string[] } : {}),
        });
      },
      buyerRows, buyerBulk,
      blacklistBuyers: (ids: string[], reason?: string) => blacklist('buyer', ids, reason),
      blacklistBuyer: (reason?: string) => blacklist('buyer', [B.id], reason),
      B: {
        name: B.name, company: B.company, initials: B.initials, status: B.status, stage: B.stage ?? '',
        statusColor: buyerStatusTone(B.status).fg,
        type: B.type, phone: B.phone, email: B.email, pref: B.pref, doNot: B.doNot,
        engagement: B.engagement, engPct: B.engagement + '%', lastPurchase: B.lastPurchase,
        responseKnown: B.responseKnown !== false, sent: B.sent ?? null,
        tireKicker: B.tireKicker ?? isTireKicker({ sent: B.sent ?? null, responsePct: B.engagement, offers: B.activity?.offers ?? 0, purchases: B.activity?.purchases ?? 0 }),
        lastActivity: B.lastActivity, offers: B.offers, match: B.match,
        dbId: live && B.id ? dbId(B.id) : null,
        /** Who the buyer is assigned to (buyers.assigned_to), as the seller record's Assigned to. */
        assignedId: B.assigned ?? '',
        assignOptions: Object.values(D.team).map((r) => ({ id: r.id, name: r.name })),
        assignTo: (userId: string) => {
          if (!live || !canWrite || readOnly) return toast('Assigning a buyer needs a signed-in workspace you can edit.');
          void assignBuyers([dbId(B.id).toString()], userId || null).then((r) => {
            if (!r.ok) return toast(r.message || 'That did not save.', 'error');
            reload?.();
            toast(userId ? 'Assigned to ' + repName(userId) : 'Unassigned', 'success');
          });
        },
      },
      buyBoxRows, buyerAvoid, buyerActivity, buyerSummary, stars, buyerTimeline: foldEmailThreads(buyerTimeline), buyerMarkets, buyerDeals,
      buyerOfferRows, buyerPurchaseRows, buyerNoteRows, buyerDealChoices,
      buyerContractDealId, buyerContractSellerId, buyerContractSeller,
      addBuyerToCampaign, openBuyerCampaign,
      callBuyer: () => startCall({ name: B.name + ' · ' + B.company, phone: B.phone, buyerId: B.id }),
      /** One of the buyer's other numbers (buyer_phones), from the record's Phones row. */
      callBuyerAt: (number: string, phoneId: number) => {
        const placed = startCall({ name: B.name + ' · ' + B.company, phone: number, buyerId: B.id, phoneId });
        if (placed && workspaceId !== null && canWrite && !readOnly) void noteDialled(workspaceId, 'buyer', phoneId);
        return placed;
      },
      openBuyerDealSheet: () => {
        if (!buyerDealLink) return toast('No deal on this buyer yet.');
        // A walkthrough names no deal: clear the one the last sheet was on, so it opens this seller's.
        go('dealSheet', { personId: buyerDealLink.personId, dealSheetDealId: buyerDealLink.dealId ?? null });
      },
      openBuyerTc: () => {
        if (!buyerDealLink) return toast('No transaction file on this buyer yet.');
        openTc(buyerDealLink.personId, buyerDealLink.dealId);
      },
      // Text stays on this buyer and uses the bar at the bottom. Email opens
      // a compose addressed to this buyer's email, filed on the buyer only.
      textBuyer: () => set({ buyerCompose: null }),
      emailBuyer: () => set({ buyerCompose: 'email' }),
      buyerCompose: s.buyerCompose,
      closeBuyerCompose: () => set({ buyerCompose: null }),
      sendBuyerEmail: (subject: string, body: string) => {
        const text = body.trim();
        const sub = subject.trim() || 'Following up';
        if (!text) return toast('Type a message first');
        const email = B.email.includes('@') ? B.email : '';
        if (!email) return toast(B.name + ' has no email on file');
        if (!canWrite || workspaceId === null) return toast('Email to ' + B.name + ' (demo)');
        set({ buyerCompose: null });
        toast('Sending to ' + B.name.split(' ')[0] + '…');
        void sendEmail(workspaceId, { to: email, subject: sub, body_text: text, buyer_id: dbId(B.id), seller_id: null })
          .then((r) => {
            if (!r.ok || !r.data.connected || !r.data.ok) {
              return toast(!r.ok ? r.message : !r.data.connected ? 'Connect Gmail in Settings to send email.' : r.data.message ?? 'Gmail refused that send.', 'error');
            }
            reload?.();
            toast('Email sent to ' + B.name, 'success');
          });
      },

      // tc
      TP: {
        // The deal's house, not the seller's own address: a wholesaler's
        // submissions are all on one seller whose address is somewhere else.
        addr: (TD as Partial<Deal>).addr || TP.property.addr,
        cityLine: (TD as Partial<Deal>).addr
          ? [(TD as Partial<Deal>).city, [(TD as Partial<Deal>).st, (TD as Partial<Deal>).zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
          : TP.property.city + ', ' + TP.property.st + ' ' + TP.property.zip,
        seller: TP.name, img: (TD as Partial<Deal>).addr ? (TD as Partial<Deal>).heroUrl || (TD as Partial<Deal>).photos?.[0] || '' : TP.property.img, contract: fmt(td.contract),
        // Live: the deal's own numbers. The demo's $2,500 buyer fee, close date,
        // countdown and title company are sample figures.
        assignment: live ? fmt(td.assignment) : fmt((td.assignment || 0) + 2500),
        buyerPrice: live ? (td.contract != null && td.assignment != null ? fmt(td.contract + td.assignment) : '—') : fmt((td.contract || 0) + (td.assignment || 0) + 2500),
        close: live ? td.close || TPX?.closing || '—' : td.close || 'Sept 22',
        daysLeft: live
          ? (TPX?.closingIso && now ? Math.ceil((Date.parse(TPX.closingIso.slice(0, 10) + 'T12:00:00') - now.getTime()) / 86400000) + ' days' : '—')
          : (TP.id === 'p8' ? 1 : TP.id === 'p10' ? 2 : 18) + ' days',
        title: live ? TPX?.titleCo || '—' : 'Northvale Title',
        buyer: seeBuyers ? (live ? TPX?.buyerName || '—' : 'Harbor Capital') : '—',
        open: () => openPersonDeal(TP.id, TD.id),
        openTcTab: () => go('person', { personId: TP.id, personTab: 'TC', personDealId: TD.id ?? null }),
        /** The seller's database id on a live workspace, for the Deal team card. */
        sellerDbId: live && TP.id ? dbId(TP.id) : null,
      },
      // record communications (#5)
      personComms, hasPersonComms, personCommsCount, personCommsLast, commsFilters,
      dispoComms, hasDispoComms, dispoCommsCount,
      // sellers on the property + create affordances (#1)
      sellersOnProperty, sellerCount,
      addOpen: s.addOpen, addFields, addCanSubmit, addProblem, closeAdd, submitAdd,
      /** Why the last save failed (the form is still as typed), and Clear for a form with something typed in it. */
      addError: s.addError, clearAdd, addCanClear: !!s.addOpen && !s.addBusy && hasTyped(s.addSeed, s.addForm),
      /** The dialog's open question (components: app/clozr/AddAsk.tsx), what it is checking, and the answer. */
      addAsk: s.addAsk, addBusy: s.addBusy, resolveAddAsk,
      archiveAsk: s.archiveAsk, askArchive, answerArchive,
      /** Ctrl+A on an open seller or buyer record: that record, then on to the next one. */
      // On a submission the record is that house: archive its deal, never the
      // partner contact (Offerpad) and every other house they sent.
      archiveOpenRecord: (kind: 'seller' | 'buyer') => (kind === 'seller' && focusDeal
        ? archiveDealFlow(focusDeal.id, true, true)
        : askArchive(kind, [(kind === 'seller' ? s.personId : s.buyerId) ?? ''], true)),
      /** Open the record a duplicate question is about, leaving the form. */
      openAddAskRecord: () => {
        const a = s.addAsk;
        if (a?.kind !== 'dupe') return;
        // Going to the record already here: the form typed for a second one is done with.
        set((prev) => ({ addOpen: null, addForm: {}, addAsk: null, addBusy: null, addError: null, addDrafts: prev.addOpen ? dropDraft(prev.addDrafts, prev.addOpen) : prev.addDrafts }));
        if (a.dupe.kind === 'seller') openPerson('s' + a.dupe.id); else openBuyer('b' + a.dupe.id);
      },
      placesKey,
      /** A Places result fills the street, city, state and ZIP fields together. */
      fillAddAddress: (p: { addr: string; city: string; st: string; zip: string }) =>
        set((st) => ({ addForm: { ...st.addForm, addr: p.addr, city: p.city, st: p.st, zip: p.zip } })),
      addTitle: addSpec ? addSpec.title : '',
      addSubtitle: addSpec ? addSpec.sub : '',
      addSubmitLabel: addSpec ? addSpec.submit : '',
      addSeller: () => openAdd('coseller', {
        hostId: P.id,
        hostPropertyId: P.property.propertyId ?? '',
        hostAddress: P.property.addr,
      }),
      addProperty: () => openAdd('property'),
      /** A seller created without an address gets one attached here. */
      setAddress: () => openAdd('address', { personId: P.id }),
      hasAddress: P.property.addr !== '—' && P.property.addr !== '',
      /**
       * Edit the seller's address, prefilled with the one on file. Saving
       * re-points them (and their open deals) at the new address's property —
       * the old row is never edited in place (crm-write setSellerAddress).
       */
      editAddress: () => {
        const pr = P.property;
        const has = pr.addr !== '—' && pr.addr !== '';
        const clean = (v: string) => (v && v !== '—' ? v : '');
        openAdd('address', has ? {
          personId: P.id, editing: '1',
          addr: clean(pr.addr), city: clean(pr.city), st: clean(pr.st), zip: clean(pr.zip),
          was: [clean(pr.addr), clean(pr.city), [clean(pr.st), clean(pr.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        } : { personId: P.id });
      },
      /** Whether the address can be changed from here: the sample graph, or a workspace this person can write to. */
      // When this came in: a submission's submitted date, else when the contact was added.
      recordDate: (() => {
        const iso = focusDeal ? (focusDeal.submittedAt ?? focusDeal.createdAt) : P.createdAt;
        const t = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(t) ? (focusDeal ? 'Submitted ' : 'Added ') + new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
      })(),
      canEditAddress: !live || canWrite,
      // Acme Homes contract-to-close checklist
      tcChecklistPhases, tcClDoneCount, tcClTotal, tcClPct, tcClPctS: tcClPct + '%',
      tcClLabel, tcClFlow, tcClTarget, tcClD0, tcMilestones,
      tcHudLines, tcHudDone, tcHudTotal, tcHudClear, tcReview, tcSignoff, tcSignoffClear, tcDrive,
      tcD0, tcCtcTarget,
      // transaction coordination in the deal record (#3)
      hasTx, txCommitment, txExceptions, txOpenExceptions, txEarnest, txDeadlines,
      txDocuments, txDocsOutstanding, txNextActions, txCritical,
      // Lane — drawer, drafts, and the file it is actually reading
      laneOpen: s.laneOpen, laneQ: s.laneQ, laneBusy: s.laneBusy,
      laneThread, laneHasThread, laneEmpty, lanePrompts, laneReading,
      laneList: s.laneList, laneChatRows, laneHasChats: s.laneChats.length > 0,
      laneShowList: () => {
        set({ laneList: true });
        if (workspaceId !== null) void listLaneChats(workspaceId).then((chats) => set({ laneChats: chats }));
      },
      laneHideList: () => set({ laneList: false }),
      laneNewChat: () => newLaneChat(),
      toggleLane: () => set({ laneOpen: !s.laneOpen }),
      openLane: (pid?: string) => openLane(pid),
      laneTc: () => openLane(TP.id),
      geniusHere: () => openGenius(DP.id, pinnedDeal?.id ?? (DD as { id?: string }).id ?? null),
      closeLane: () => set({ laneOpen: false }),
      setLaneQ: (e: React.ChangeEvent<HTMLInputElement>) => set({ laneQ: e.target.value }),
      askLane: () => runLane(s.laneQ),
      laneKey: (e: React.KeyboardEvent) => { if (e.key === 'Enter') runLane(s.laneQ); },
      // action plans
      planRows, planSteps, planChannelOptions, addPlanStep, newPlan,
      savePlanNow, deletePlanNow, draftPlanWithAi, aiPlanForLead, planDrafting: s.planDrafting,
      planCanSave: PL.id !== '' && PL.name.trim() !== '',
      // Where "Start action plan" came from, for the way back.
      planReturnTo: s.planReturnTo,
      /** The plans screen's Back link: where it was opened from, else the screen "Start action plan" named. */
      planBack: backFor(s.planReturnTo === 'buyer' ? 'buyers' : s.planReturnTo === 'person' ? 'people' : s.planReturnTo || 'people'),
      bulkMenu: s.bulkMenu, bulkMenuOptions, closeBulkMenu: () => set({ bulkMenu: null }),
      peopleAssign, selectFirstPeople,
      setPlanName, setPlanTrigger, planName: PL.name, planTrigger: PL.trigger,
      planActive: PL.active, planStepCount: PL.steps.length,
      planEnrolled, planEnrolledCount, enrollPick,
      get planCandidates() { return planCandidates(); },
      personPlan, hasPersonPlan, planPickerOptions, buyerPlanPickerOptions, vendorPlanPickerOptions, startPlanFor,
      buyerPlan, hasBuyerPlan, startBuyerPlanFor,
      isPlans: s.screen === 'plans',
      goPlans: () => go('plans'),
      isMobile, moreOpen, mobileTabs, moreItems, mobilePeopleCards,
      get mobileDealCards() { return mobileDealCards(); },
      // Phone list picker: smart lists + the vendor-backed custom lists as chips.
      mobileLists: [...smartLists, ...customLists.filter((l) => !l.disabled)].map((l) => ({
        label: l.label, count: l.count, go: l.go,
        on: l.label === s.peopleList,
        bg: l.label === s.peopleList ? '#18181b' : '#fff',
        color: l.label === s.peopleList ? '#fff' : '#27272a',
        border: l.label === s.peopleList ? '#18181b' : '#e4e4e7',
      })),
      toggleMore: () => set({ moreOpen: !s.moreOpen }),
      closeMore: () => set({ moreOpen: false }),
      dealMenus, dispoMenus, buyerMenus, taskMenus, clearGf,
      // Saved views read and restore the toolbar filters and the Deals layout.
      gf: s.gf,
      setGf: (patch: Partial<ClozrState['gf']>) => {
        // The realtor page is server-paged: a new state or city starts again at page one.
        if ('buyerState' in patch || 'buyerCity' in patch) setRealtorOffset(0);
        set((st) => ({ gf: { ...st.gf, ...patch } }));
      },
      dealsView: s.dealsView,
      setDealsView: (v: 'pipeline' | 'table') => set({ dealsView: v }),
      dispositions, notifCatFilter, buyerTabs,
      regenerateCopy: () => toast('Marketing copy regenerated'),
      playRecording: () => toast('No recording stored for this call'),
      sendDealToBuyer: () => { go('dispo'); toast('Pick a property to send ' + B.name); },
      // A TC note is about this deal, not every deal on the seller (a wholesaler
      // carries dozens): it carries deal_id, and the text stays in the box until it saves.
      sendTcMsg: () => {
        const body = s.composerText.trim();
        if (!body) return toast('Type a note first');
        if (workspaceId === null && !live) { set({ composerText: '' }); return toast('Sample data: the note is not saved'); }
        if (!canWrite || workspaceId === null) return toast('Read-only · notes are not saved from this seat');
        const tcDealDb = TD.id ? dbId(TD.id) : null;
        // One save at a time: Enter twice, or Enter then the button, posts once.
        if (tcNoteBusy.current) return;
        tcNoteBusy.current = true;
        void createCommunication(workspaceId, {
          sellerId: dbId(TP.id), dealId: tcDealDb, channel: 'note', direction: 'outbound', body,
          subject: 'TC',
        }).then((r) => {
          tcNoteBusy.current = false;
          if (!r.ok) return toast(r.message || 'Could not save that note.', 'error');
          set((st) => (st.composerText.trim() === body ? { composerText: '' } : {}));
          refreshPerson(TP.id);
          toast('Noted on the file', 'success');
        }).catch(() => { tcNoteBusy.current = false; toast('Could not save that note.', 'error'); });
      },
      markEmdReceived, emdCanMark, markTcReview, markTcSignoff, canSignoff,
      composeEmail: () => set({ personTab: 'Activity', composerTab: 'Email' }),
      // Property data, the map and the comps are COMPR's report: it opens beside the record.
      openPropertyData: () => openComprDeal(P, comprDeal),
      openMap: () => openComprDeal(P, comprDeal),
      openPhotos: () => {
        const deal = focusDeal || photoDealOf(P);
        const house = houseOf(P, deal);
        const list = collectPhotos([...(house.photos ?? []), ...(deal?.sourcePhotos ?? [])]);
        if (list.length) {
          const id = ++photoShowSeq;
          set({ photoShow: { id, title: P.property.addr, photos: list, index: 0 } });
          if (house.dealDbId) {
            void loadDealAlbum(house.dealDbId).then((canon) => {
              const merged = collectPhotos([...canon, ...list]);
              if (!merged.length) return;
              // Stay on the photo in view; the rep may have stepped on while it loaded.
              set((st) => (st.photoShow && st.photoShow.id === id ? { photoShow: { ...st.photoShow, photos: merged, index: photoIndexOf(merged, st.photoShow.photos[st.photoShow.index]) } } : {}));
            });
          }
          return;
        }
        openComprDeal(P, comprDeal);
      },
      openComps: () => openComprDeal(P, comprDeal),
      rerunCompr: () => {
        if (!canWrite) return toast('COMPR re-run queued for ' + P.property.addr + ' (demo)');
        toast('Running COMPR on ' + P.property.addr + '…');
        void runCompr(workspaceId, dbId(P.id), focusDeal ? dbId(focusDeal.id) : null).then((r) => {
          if (!r.ok) return toast(r.message, 'error');
          (focusDeal ? refreshDealOf(focusDeal.id, true) : refreshPerson(P.id));
          const $ = (n: number | null) => (n === null ? '—' : '$' + n.toLocaleString());
          toast(
            (r.status === 'not_qualified' ? 'COMPR: not qualified · ' : 'COMPR: ')
            + 'ARV ' + $(r.arv) + ' · rehab ' + $(r.rehab) + ' · MAO ' + $(r.mao)
            + (r.wholesale !== null && r.wholesale !== r.mao ? ' (wholesale ' + $(r.wholesale) + ')' : '')
            + (r.redFlags.length ? ' · ' + r.redFlags.length + ' red flag' + (r.redFlags.length === 1 ? '' : 's') : '')
            + (r.autoOffer ? ' · offer ' + $(r.autoOffer.amount) + ' generated' : ''),
          );
        });
      },
      attachToDispo: () => { go('dispoProperty', { dispoId: P.id, dispoTab: 'Files' }); toast('Report attached to the dispo packet'); },
      preMarket: () => go('dispoProperty', { dispoId: P.id, dispoTab: 'Marketing' }),
      // Both the seller record and Talkr have a Template button. The seller
      // record Composer mounts TemplatePicker itself; this stub remains for
      // Talkr's thread composer when no picker is mounted yet.
      useTemplate: () => set({
        composerText: s.screen === 'talkr'
          ? 'Hi ' + TC.name.split(' ')[0] + ', following up — do you have 5 minutes today?'
          : 'Hi ' + P.name.split(' ')[0] + ', following up on ' + P.property.addr + '. Do you have 5 minutes today?',
      }),
      /** Workspace id the people-record Template picker loads CLOZR templates with. */
      templatesWorkspaceId: workspaceId,
      /** The RVM tab's Pool health card: owners and admins on a live workspace. */
      rvmPoolAdmin: !!live && isAdmin(role),
      /** The signed-in member, so the incoming card can say "your RVM blast". */
      callbackUserId: me ?? null,
      /** Open a record by its database id (a callback credited to a drop on a secondary number). */
      openSellerById: (id: number) => openPerson('s' + id),
      openBuyerById: (id: number) => openBuyer('b' + id),
      assignInbox: () => toast('Assigned to ' + repName(ME)),
      markInboxRead: () => set((st) => ({ notifRead: { ...st.notifRead, [st.inboxConv]: true } })),
      aiReplyInbox: () => set({ composerText: 'Thanks for getting back to me — I can work around your timeline. When is a good time to talk today?' }),
      // One string, rendered on the card and inserted by the button under it.
      // They were two different sentences before, so "Use reply" pasted
      // something other than the reply you were looking at.
      inboxSuggestion: INBOX_SUGGESTION,
      useInboxReply: () => { set({ composerText: INBOX_SUGGESTION }); toast('Reply loaded into the composer'); },
      buyerTab: s.buyerTab,
      buyerTabLabel: s.buyerTab.toLowerCase(),
      setBuyerMsg: (e: React.ChangeEvent<HTMLInputElement>) => set({ composerText: e.target.value }),
      sendBuyerMsg: () => {
        const body = s.composerText.trim();
        if (!body) return toast('Type a message first');
        if (!canWrite) return sendToThread('buyer:' + B.id, 'Sent to ' + B.name + ' (demo)');
        const phone = B.phone && B.phone !== '—' ? B.phone : '';
        if (!phone) return toast(B.name + ' has no phone on file');
        set({ composerText: '' });
        toast('Sending to ' + B.name.split(' ')[0] + '…');
        void textMany(workspaceId, [{ sellerId: null, buyerId: dbId(B.id), name: B.name, phone }], body, textCtx)
          .then((rs) => { reload?.(); toast(sendSummary(rs), rs.some((x) => !x.error) ? 'success' : 'error'); });
      },
      /** "Send a deal" on the buyer record: this buyer into one active deal's campaign builder. */
      sendDealOptions: buyerBulk.deals.map((d) => ({ id: d.id, label: d.label, go: () => buyerBulk.openCampaign(d.id, [dbId(B.id)]) })),
      showKeypad: () => set({ dialerTab: 'Dial' }),
      callBack: () => (s.callTarget ? startCall(s.callTarget) : toast('No number to call back')),
      exportPeople, exportReport, copyReportLink, copySellerPitch, addTag,
      isBuyerTab: Object.fromEntries(['Activity','Offers','Purchases','Campaigns','Notes'].map((t) => [t, s.buyerTab === t])) as Record<string, boolean>,
      addBuyer: () => (live ? set({ profileOpen: { buyerId: null } }) : openAdd('buyer')),
      editBuyerProfile: () => (live ? set({ profileOpen: { buyerId: dbId(B.id) } }) : toast('Buy box editing runs on a signed-in workspace.')),
      buyerProfile: s.profileOpen,
      closeBuyerProfile: () => set({ profileOpen: null }),
      // Tasks has no record of its own, so its + Task starts blank; from a
      // record it is that record's task.
      addTask: () => openAdd('task', focusPid ? { personId: focusPid } : {}),
      addAppointment: () => openAdd('appointment', focusPid ? { personId: focusPid } : {}),
      addNote: () => openAdd('note', { personId: P.id }),
      addVendor: () => openAdd('vendor'),
      addDeal: () => openAdd('deal', { personId: P.id }),
      calView: s.calView,
      setCalWeek: () => set({ calView: 'Week' }),
      setCalMonth: () => set({ calView: 'Month' }),
      tcItems: tcScreenItems, tcDoneCount: tcScreenDone, tcTotal: tcScreenItems.length, tcPct: tcScreenPct + '%', tcPctN: tcScreenPct,
      tcBlockers, tcFeed, tcFeedFilters, tcParties, tcFile, tcTasks, addTcTask, personTcFile,
      tcRing: 'conic-gradient(#16a34a ' + tcScreenPct * 3.6 + 'deg, #e4e4e7 0)',

      // inbox
      inboxChannels, inboxFilters, inboxConvs, IC, inboxMsgs, inboxCtx, openInboxRecord,
      inboxCount: inboxConvs.length,

      // tasks
      tasksViews, tasksView: s.tasksView, taskRows, taskCount: taskRows.length,

      // calendar
      calDays,

      // reporting
      reportTabs, reportTab, reportRanges, reportRange: s.reportRange,
      reportBlocks: reportBlocks(), reportRaw, reportAdmin, reportRangeBounds, reportHasData: !!reportRaw,

      // automations

      // notifications
      notifOpen: s.notifOpen, notifs, notifCats, sectionGapPops, sectionGapMore,
      dismissSectionGaps: () => dismissNotifIds(gapUnread.map((g) => g.id)),
      markAllRead: () => dismissNotifIds(
        visibleNotifs(myNotifications, sRef.current.notifRead, 'All', notifMuted).map((n) => n.id),
      ),
      dismissNotifs: dismissNotifIds,
      bellReadNumber, notifMutes,

      // the ⌘K command bar (CommandBar.tsx builds its rows from cmdData)
      openBuyerRecord: openBuyer,
      searchOpen: s.searchOpen, searchQ: s.searchQ, cmdData, runCommand,

      // ask clozr
      aiOpen: s.aiOpen, aiQ: s.aiQ,
      setAiQ: (e: React.ChangeEvent<HTMLInputElement>) => set({ aiQ: e.target.value }),
      askAi: () => askAi(s.aiQ),
      aiExamples, aiAnswer: s.aiAnswer, hasAiAnswer: !!s.aiAnswer, noAiAnswer: !s.aiAnswer, aiBusy: s.aiBusy,
      aiKey: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') askAi(s.aiQ); },

      // leaderboard (TV) — recreated from an earlier TV dashboard
      // (redesign/LeaderboardHome + utils/gamification). State derives live from CRM entities.
      floorRaw, floorMail, floorResetRev, floorMe: me, floorWorkspaceId: workspaceId,
      floorAdmin: isAdmin(role),
      floorAdminIds: Object.values(D.team).filter((r) => r.role === 'owner' || r.role === 'admin').map((r) => r.id),
      ...lb,
      // The FAB also stands down while the phone is up or its pill is showing.
      // Today owns the corner too: the rail's Save on a desk, the action bar on a phone.
      hideFab: lb.hideFab || (s.isMobile && (phoneUp || phoneCallMin)) || s.screen === 'today',

      // misc
      leaderCols: ['#', 'Rep', 'Calls', 'Talk time', 'Contacts', 'Offers', 'Contracts', 'Revenue', 'Conversion'],
      dialerWidth: callState === 'live' ? '820px' : '380px',
      unreadTalkr: phone.data.unread,
      dialerBtnBg: callState === 'live' ? '#991b1b' : '#e6142e',
      callInitials: initialsOf(callTarget.name || 'C'),
      // One session, over whatever the Queue tab is showing, in that order.
      // Null mode and depth: the setup sheet starts from the rep's last choice.
      startQueue: (mode: 'power' | 'predictive' | null = null, depth: QueueDepth | null = null) => startRun(callQueueManual ? 'Call queue' : 'Today', callQueue.map((q) => ({ target: q.target, queueItemId: q.queueItemId, claim: q.claim })), mode, depth),
      /** Resolves true once the session is running (the rep can cancel the setup sheet). */
      startCallList: (title: string, targets: CallTarget[], mode: 'power' | 'predictive' = 'predictive') => startRun(title, targets.map((target) => ({ target })), mode),
      queueSession,
      /** The finished (or ended) session's summary, until Done. */
      queueDone,
      /** A session saved in this browser to pick back up, when none is running. */
      queueResume,
      newDialSession: newSession,
      liveIntel: (phoneEnabled
        ? ([
          ['Motivation', phone.intel?.motivation ?? '—'], ['Timeline', phone.intel?.timeline ?? '—'],
          ['Price expectation', phone.intel?.price_expectation ?? '—'], ['Objection', phone.intel?.objection ?? '—'],
          ...(phone.intel?.condition ? [['Condition', phone.intel.condition]] : []),
        ] as [string, string][])
        : ([
          ['Motivation', 'Inherited property · relocating'], ['Timeline', '30 days · before Sept 30'],
          ['Price expectation', '$235,000'], ['Objection', 'Wants to compare another offer'],
        ] as [string, string][])).map(([k, v]) => ({ k, v })),
      stop: (e: React.MouseEvent) => e.stopPropagation(),
      // Enter / Space on a card list row, which is a div carrying role="button".
      cardKey: (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.currentTarget.click();
      },
      // `toast` is the message the shell renders; `showToast` fires a new one.
      toast: s.toast, hasToast: !!s.toast, showToast: toast, toastTone,
      /** The toast's button, if it has one: pressing it runs the action and takes the toast down. */
      toastAction: s.toastAction && s.toastAction.seq === s.toastSeq
        ? { label: s.toastAction.label, run: () => { set({ toast: null }); s.toastAction?.run(); } } : null,

      // Home's date and greeting were fixed strings from the design prototype,
      // so every signed-in user was greeted as Sam on a Thursday in
      // September. `me` is the only name we actually know.
      todayLabel: now ? now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '',
      greeting: !now ? 'Welcome back'
        : now.getHours() < 12 ? 'Good morning'
          : now.getHours() < 18 ? 'Good afternoon' : 'Good evening',
      meName: (me && D.team[me]?.name) || (live ? '' : 'Sam'),
      /** Clozr AI's one line on the day, under the greeting; '' until it has ranked Today. */
      todayAiGreeting: todayBase.greeting,

      /**
       * True when this is a real workspace that has no records at all — the
       * first hour of using CLOZR. Home says what will fill it rather than
       * showing eight zeroes and leaving you to guess.
       */
      workspaceEmpty: !!live && people.length === 0 && buyers.length === 0 && D.communications.length === 0,

      // Counts the screens used to carry as literals in their markup, which is
      // how a signed-in workspace ended up showing someone else's numbers.
      callQueueCount: callQueue.length,
      workspaceName: workspaceName || 'Acme Homes',
      // The calendar's range was a fixed week in September.
      calRange: (() => {
        if (!now) return '';
        const start = new Date(now);
        start.setDate(now.getDate() - now.getDay());
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return f(start) + ' – ' + (start.getMonth() === end.getMonth() ? String(end.getDate()) : f(end));
      })(),
      dispoSubtitle: (() => {
        const n = inventory.length;
        const reps = Array.from(new Set(inventory.map((i) => i.rep).filter((r) => r && r !== 'Unassigned')));
        return n + (n === 1 ? ' property' : ' properties') + (reps.length ? ' · ' + reps.join(', ') : '');
      })(),
      buyerTotal: buyers.length.toLocaleString('en-US'),
      dispoMonthFees: fmt(pipelineDeals.filter((d) => !!d.close).reduce((a, d) => a + (d.assignment || 0), 0)),
      dispoMonthCount: pipelineDeals.filter((d) => !!d.close).length,

      // Facts the empty states read. `isLiveData` is true only for a real
      // workspace, so the demo never claims to be one. (`isLive`, above, is a
      // call that is currently connected — different thing, older name.)
      isLiveData: !!live,
      // Database ids for the cards that talk to the server directly
      // (contracts, Genius Mode). Null on the sample graph.
      liveIds: live ? {
        workspaceId: workspaceId as number,
        sellerId: P.id ? dbId(P.id) : null,
        /** The buyer record in view, for replies filed on it. */
        buyerId: s.screen === 'buyer' && s.buyerId ? dbId(s.buyerId) : null,
        dealId: recDealOf(P.id)?.id ? dbId(recDealOf(P.id)!.id) : null,
        dispoDealId: ddId ? dbId(ddId) : null,
        userId: me,
        canWrite,
      } : null,
      /** The dispo property's campaign builder: the deal as merge fields and who is sending. Null on the sample graph. */
      dispoCampaign: live && ddId ? {
        dealFields: dispoFields(DD as Deal, DP, (DD as Deal).addr || DP.property.addr,
          (DD as Deal).tracker?.marketedPrice || ((DD as Deal).contract && (DD as Deal).assignment ? (DD as Deal).contract! + (DD as Deal).assignment! : (DD as Deal).contract)),
        textCtx,
        demo: null,
        /** Names for the results' buyers, by database id. */
        buyer: (id: number) => { const b = buyers.find((x) => dbId(x.id) === id); return b ? { name: b.name, company: b.company || null, phone: b.phone || null } : null; },
        openBuyer: (id: number) => openBuyer('b' + id),
      } : !live && ddId ? {
        // The demo: the same merge fields from the sample deal, sent as its
        // dispo rep, over sample buyers and one past campaign. Nothing saves.
        dealFields: dispoFields({ ...(DD as Deal), photoUrl: (DD as Deal).photoUrl || DP.property.img }, DP, (DD as Deal).addr || DP.property.addr,
          (DD as Deal).tracker?.marketedPrice || ((DD as Deal).contract && (DD as Deal).assignment ? (DD as Deal).contract! + (DD as Deal).assignment! : (DD as Deal).contract)),
        textCtx: { repName: ((DD as Deal).owner && D.team[(DD as Deal).owner as keyof typeof D.team]?.name) || 'Morgan Lane', company: 'Acme Homes' },
        demo: demoFor(ddId, (DD as Deal).addr || DP.property.addr, listingUrl),
        buyer: undefined,
        openBuyer: (id: number) => (buyers.some((b) => b.id === 'b' + id) ? openBuyer('b' + id) : toast('That sample buyer has no record in the demo.')),
      } : null,
      /** Call anyone on a deal team through the phone. */
      callParty: (name: string, phone: string) => startCall({ name, phone }),
      /** What Genius Mode hands back to the app: dial, queue, open a buyer, go to the campaign or the Genius tab. */
      /**
       * The AI agent picker for buyers chosen in Genius or a deal's campaign
       * builder: the same panel as the Buyers list (pick the agent, the
       * channels, what to do), so the agent is never chosen behind the rep's back.
       */
      agentPick: s.agentPick && live && workspaceId != null ? (() => {
        const selectedIds = s.agentPick.map((id) => 'b' + id);
        const known = buyerBulk.buyers as Record<string, BulkRecord | undefined>;
        const records: Record<string, BulkRecord> = Object.fromEntries(selectedIds.map((k) => [k, known[k] ?? {
          dbId: Number(k.slice(1)), name: 'Buyer ' + k.slice(1), phone: '', email: '', blacklisted: false,
        }]));
        return { workspaceId, canWrite, selectedIds, records, say: (m: string) => toast(m) };
      })() : null,
      closeAgentPick: () => set({ agentPick: null }),
      agentPickDone: (msg: string) => { set({ agentPick: null }); toast(msg, 'success'); reload?.(); },
      genius: {
        call: (name: string, phone: string) => startCall({ name, phone }),
        queue: async (buyerIds: number[]) => {
          if (!buyerIds.length) return;
          if (!live) return toast(`${buyerIds.length} buyer${buyerIds.length === 1 ? '' : 's'} added to your call queue (demo)`, 'info');
          const r = await cq.add('buyer', buyerIds);
          toast(!r.ok ? r.message || 'The call queue did not save.'
            : r.added ? `${r.added} buyer${r.added === 1 ? '' : 's'} added to your call queue` + (r.already ? ` · ${r.already} already on it` : '')
            : 'Already on your call queue', !r.ok ? 'error' : r.added ? 'success' : 'info');
        },
        /** The buyer AI agent for these records: the picker opens (which agent, which channels, what to do). */
        startAgent: async (buyerIds: number[]) => {
          if (!buyerIds.length) return;
          if (!live || workspaceId == null) return toast(`AI agent started for ${buyerIds.length} buyer${buyerIds.length === 1 ? '' : 's'} (demo)`, 'info');
          set({ agentPick: Array.from(new Set(buyerIds)) });
        },
        openBuyer: (id: number) => openBuyer('b' + id),
        /**
         * "Send deal via campaign": the selection pre-ticked in the deal's campaign
         * builder, the same hand-off as the Matches tab's "Add to campaign", then
         * its Marketing tab. From a deal's Genius tab that is this deal; from the
         * Genius page, the deal the search was run from.
         */
        campaign: (buyerIds: number[], dealDbId: number) => {
          const d = live ? deals.find((x) => dbId(x.id) === dealDbId) : undefined;
          if (!d) return toast(live ? 'That deal is not on this workspace.' : 'Campaigns run on a signed-in workspace.');
          prefillCampaign(dealDbId, buyerIds);
          openDispo(d.personId, 'Marketing', d.id);
          // Two owners can land on one buyer (a shared phone), and the builder ticks each buyer once.
          const n = new Set(buyerIds).size;
          toast(`${n} buyer${n === 1 ? '' : 's'} ready for the campaign`);
        },
        /** Tick these buyers on the deal's marketing list. Stays on the search. */
        addToMarketing: (buyerIds: number[], dealDbId: number) => {
          const d = live ? deals.find((x) => dbId(x.id) === dealDbId) : undefined;
          if (!d) return toast(live ? 'That deal is not on this workspace.' : 'Marketing lists run on a signed-in workspace.');
          prefillCampaign(dealDbId, buyerIds);
          const n = new Set(buyerIds).size;
          toast(`${n} buyer${n === 1 ? '' : 's'} added to the marketing list`);
        },
        tab: () => set({ dispoTab: 'Genius' }),
      },
      crmOk,
      crmPartial,
      reloadCrm: reload ?? (() => {}),
      /** After a save on one deal (the deal sheet): re-read that deal and its seller, not the workspace. */
      refreshDealCrm: (dealDbId: number) => refreshDealOf(dealDbId),
      /** After a save on one seller's record: re-read that seller and their deals. */
      refreshSellerCrm: (sellerDbId: number) => refreshPerson('s' + sellerDbId),
      /** Every photo on these deals, for a gallery that opens (the workspace load has one cover each). */
      loadDealGallery: (dealDbIds: number[]) => { void loadGallery?.(dealDbIds); },
    };
  }, [s, confirm, confirmReason, graph, buyerView, buyerSearchView, secretHidden, myNotifications, sectionGapList, phoneTexts, buyerIndex, peopleSearchKeys, showAiCards, askAi, endCall, finishCall, go, openBuyer, openDispo, openPerson, openTc, set, startCall, toast, toastTone, toastAction, muteCat, unmuteCat, copyText, openAdd, closeAdd, clearAdd, setAddField, submitAdd, resolveAddAsk, runLane, openLane, openLaneRef, openLaneChat, newLaneChat, removeLaneChat, openGenius, nextId, sendToThread, D, ME, rep, repName, repInit, live, crmOk, reload, refreshPerson, refreshDealOf, loadGallery, persistStage, persistDealStage, persistTask, persistTaskDue, canWrite, workspaceId, me, workspaceName, now, role, placesKey, phone, phoneEnabled, sp, talkrLive, callState, muted, hold, keypadOpen, transferOpen, recordComms, recordTimeline, buyerRecordTimeline, recordStages, historyHits, peopleHistoryKey, buyerHistoryKey, cq, offerSend, readOnly, crmPartial, doNotCall, can, landing, todayBase, todayVocab, noteRecent, realtorPage, realtorPin, realtorCorpusTotal, realtorMarkets, floorNotify, alternates, patchLocal]);
  // onCallOpened (above the view-model) finds the person by the view-model's phone lookup.
  useEffect(() => { dialerRecordForRef.current = V.dialerRecordFor; }, [V.dialerRecordFor]);

  // The Q-then-number chord reads the Quick Add rows through a ref (see the
  // keydown handler), refreshed whenever the rows are rebuilt.
  useEffect(() => { quickAddRef.current = V.quickAddItems.map((q) => q.go); }, [V]);

  // People comes back the way this user left it (lib/people-memory.ts): the
  // list, its filters and sort, and the search. Read once the workspace, the
  // role and the saved smart lists are in, so a list that is gone or that the
  // role cannot open is never put back. Written on every change after that.
  const peopleMemoryFor = useRef<string | null>(null);
  useEffect(() => {
    const who = me ?? 'demo';
    if (!ready || !smartListsReady || peopleMemoryFor.current === who) return;
    peopleMemoryFor.current = who;
    // This tab's own view first (sessionStorage, so two tabs can sit on
    // different lists), else the user's last view anywhere (localStorage).
    let tab: string | null = null;
    try { tab = sessionStorage.getItem(PEOPLE_VIEW_KEY + ':' + who); } catch { /* private mode */ }
    const m = readPeopleMemory(tab, V.peopleListKnown, Object.keys(INITIAL.pf))
      ?? readPeopleMemory(loadPeopleMemoryRaw(me), V.peopleListKnown, Object.keys(INITIAL.pf));
    // An owner or admin works the whole book, not the handful assigned to
    // them: My Leads (the default, and what an untouched view was saved as)
    // opened the owner's People on 2 of 13,000 sellers. They open on every seller.
    const wholeBook = !!live && isAdmin(role);
    const list = m?.list === 'My Leads' && wholeBook ? 'Sellers' : m?.list ?? (wholeBook ? 'Sellers' : null);
    if (!list) return;
    queueMicrotask(() => setS((st) => ({ ...st, peopleList: list, cursorList: list, peopleCursor: 0, pf: { ...INITIAL.pf, ...((m?.pf ?? {}) as Partial<PeopleFilters>) }, peopleQ: m?.q ?? '' })));
  }, [ready, smartListsReady, me, V, live, role]);
  useEffect(() => {
    if (peopleMemoryFor.current !== (me ?? 'demo')) return;
    const view = { list: s.peopleList, pf: { ...s.pf }, q: s.peopleQ };
    writePeopleMemory(me, view);
    try { sessionStorage.setItem(PEOPLE_VIEW_KEY + ':' + (me ?? 'demo'), JSON.stringify(view)); } catch { /* private mode */ }
  }, [s.peopleList, s.pf, s.peopleQ, me]);

  // A record opened with no photos: if its deal links a Google Drive folder,
  // read it now rather than waiting for the cron (drive-photos). The set
  // shows at once; the next workspace load has it as the deal's rows and hero.
  const driveTried = useRef(new Set<number>());
  // A workspace switch drops every open record, queue and thread. The shell
  // unmounts while the new workspace loads; this is the state that stays
  // mounted above that and would otherwise keep the previous workspace's ids.
  useEffect(() => onWorkspaceReset(() => {
    setS((prev) => ({
      ...INITIAL,
      isMobile: prev.isMobile,
      smartListOrder: prev.smartListOrder,
      pinnedSmartLists: prev.pinnedSmartLists,
    }));
    setRecordComms(null);
    setRecordTimeline(null);
    setRealtorPin(null);
    setRealtorOffset(0);
    setRealtorCorpusTotal(0);
    setRealtorPage({ rows: [], total: 0, loading: false });
    setRealtorMarkets([]);
    setRecordStages(null);
    setHistoryHits({});
    setPhoneTexts(null);
    setTodayAi(null);
    driveTried.current = new Set();
    restoredRef.current = true;
    urlKeyRef.current = null;
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* private mode */ }
  }), []);
  const recordPhotoDeal = canWrite && !V.P.photos.length ? V.P.dealDbId : null;
  useEffect(() => {
    if (recordPhotoDeal == null || workspaceId === null) return;
    const t = window.setTimeout(() => {
      if (driveTried.current.has(recordPhotoDeal)) return;
      driveTried.current.add(recordPhotoDeal);
      void pullDrivePhotos(workspaceId, recordPhotoDeal).then((r) => {
        if (r.ok && r.urls.length) set((st) => ({ drivePhotos: { ...st.drivePhotos, [String(recordPhotoDeal)]: r.urls } }));
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [recordPhotoDeal, workspaceId, set]);

  // The COMPR window (lib/compr-window.ts) posts each report it paints and
  // each edit it saves: they land on their deal as they arrive. Coming back
  // to CLOZR pulls what that window saved meanwhile, in case a message was
  // missed (a COMPR without the bridge, or a window opened some other way).
  const comprBridgeRef = useRef(V.comprBridge);
  useEffect(() => { comprBridgeRef.current = V.comprBridge; }, [V]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => comprBridgeRef.current.onMessage(e);
    const onBack = () => { if (document.visibilityState === 'visible') comprBridgeRef.current.pullBack(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, []);
  // A record with a COMPR report, opened: a house being underwritten takes
  // what COMPR has saved for it now (an AM may have worked it in COMPR on its
  // own); any other only learns whether the report is missing the record's
  // photos. At most every two minutes per deal.
  const comprPullDeal = V.comprBridge.pullOnOpen;
  const comprPullCheck = V.comprBridge.pullCheckOnly;
  useEffect(() => {
    if (!comprPullDeal) return;
    const t = window.setTimeout(() => comprBridgeRef.current.pull(comprPullDeal, 120_000, comprPullCheck), 400);
    return () => window.clearTimeout(t);
  }, [comprPullDeal, comprPullCheck]);

  // An outcome saved in a running session dials the next call, but only once
  // the phone is idle: advanceRun refuses while its render still sees the call
  // (the same reason the phone's "Save & next call" waits). So the save sets a
  // flag, and this moves on, through the latest view-model, when idle arrives.
  const advanceRef = useRef<(() => void) | null>(null);
  const talkrMode = phone.session.campaign?.mode ?? phone.session.session?.mode ?? '';
  useEffect(() => {
    const onDrop = () => {
      set((st) => {
        const mode = st.queueRun?.mode ?? talkrMode;
        return {
          advanceAfterSave: afterVmDrop(mode).advance || st.advanceAfterSave,
          queueRun: st.queueRun ? {
            ...st.queueRun,
            dropped: st.queueRun.dropped + 1,
            tally: st.queueRun.at >= 0 ? tallyDrop(st.queueRun.tally, personKey(st.queueRun.list[st.queueRun.at]!.target)) : st.queueRun.tally,
          } : st.queueRun,
        };
      });
    };
    window.addEventListener(VM_DROPPED_EVENT, onDrop);
    return () => window.removeEventListener(VM_DROPPED_EVENT, onDrop);
  }, [set, talkrMode]);
  // A running CLOZR session is kept in this browser, per workspace and rep,
  // so a reload or coming back later offers it back (lib/dial-session.ts).
  // Browser storage, not a table: the session is one rep's walk through a
  // snapshot of a list on one device; call_queue_items (migration 79) is the
  // rep's hand-built queue, not a session, and the calls themselves are
  // logged on the records either way.
  const savedRunKey = runKey(workspaceId, me);
  const hadRun = useRef(false);
  useEffect(() => {
    const r = s.queueRun;
    try {
      if (r) {
        hadRun.current = true;
        const keep: SavedRun = {
          v: 1, title: r.title, mode: r.mode, depth: r.depth, list: r.list, origin: r.origin, pos: r.pos, at: r.at, reached: r.reached,
          dialed: r.dialed, skipped: r.skipped, dropped: r.dropped, tally: r.tally, startedAt: r.startedAt, savedAt: Date.now(),
        };
        localStorage.setItem(savedRunKey, JSON.stringify(keep));
      } else if (hadRun.current) {
        // Finished or ended: nothing to resume.
        hadRun.current = false;
        localStorage.removeItem(savedRunKey);
      }
    } catch { /* private mode, or storage full */ }
  }, [s.queueRun, savedRunKey]);
  // On load (and on a workspace switch) a saved session is offered, never restarted by itself.
  const resumeChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || resumeChecked.current === savedRunKey) return;
    const t = window.setTimeout(() => {
      resumeChecked.current = savedRunKey;
      let saved: SavedRun | null = null;
      try { saved = parseSavedRun(localStorage.getItem(savedRunKey), Date.now()); } catch { /* private mode */ }
      set((st) => (st.queueRun ? {} : { queueResume: saved }));
    }, 0);
    return () => window.clearTimeout(t);
  }, [ready, savedRunKey, set]);
  const talkrSession = phone.session;
  useEffect(() => {
    advanceRef.current = talkrSession.session ? () => void talkrSession.next() : V.queueSession ? V.queueSession.next : null;
  }, [V, talkrSession]);
  useEffect(() => {
    if (callState !== 'idle' || !s.advanceAfterSave) return;
    const t = window.setTimeout(() => {
      set({ advanceAfterSave: false });
      advanceRef.current?.();
    }, 0);
    return () => window.clearTimeout(t);
  }, [callState, s.advanceAfterSave, set]);

  // The extension's "Open in CLOZR": bring up the seller or buyer on that number.
  // Until the workspace has loaded the index is the sample data, so wait for it.
  useEffect(() => onExtensionOpenRecord((e164) => {
    if (!live) return false;
    const rec = V.recordForContact(e164);
    if (rec) rec.open();
    else toast(`No CLOZR record for ${formatPhone(e164)}`);
    return true;
  }), [V, live, toast]);

  return V;
}

// ---- leaderboard ------------------------------------------------------------

type LbDeps = {
  go: (screen: string, extra?: Partial<ClozrState>) => void;
  toast: (msg: string) => void;
  set: (patch: Partial<ClozrState> | ((prev: ClozrState) => Partial<ClozrState>)) => void;
};

export type BoardSettings = { tz?: string; exclude?: string[]; goals?: Partial<Goals> } | undefined;

function leaderboardVals(
  raw: ReportRaw | null, isLive: boolean, s: ClozrState, { go, toast, set }: LbDeps, ui: { badgesOpen: boolean; board?: BoardSettings; crmOk: boolean },
) {
  const period = s.lbPeriod || 'last-30-days';
  const sort = s.lbSort || 'points';
  const scope = s.lbScope || 'all';
  const q = (s.lbQ || '').toLowerCase();

  // One engine for every board (lib/leaderboard.ts): the same rows Reporting
  // reads, ranked on the same rules the office TV draws from /leaderboard.
  const empty = { members: [], sellers: [], deals: [], comms: [], offers: [] };
  const boardRaw = applyLeaderboardResets(raw ?? empty, getLeaderboardResets());
  // The workspace's own zone, goals and exclusions, as the TV feed (functions/leaderboard) reads them.
  const tz = ui.board?.tz || DEFAULT_TZ;
  const opts = { tz, goals: ui.board?.goals, exclude: ui.board?.exclude ?? [] };
  const payload = buildLeaderboard(boardRaw, period, opts);
  const week = buildLeaderboard(boardRaw, 'this-week', opts);
  const reps = payload.salesPeople;
  const ctx = buildBadgeContext(reps);

  const metric = (r: SalesPerson) => (sort === 'points' ? calculatePoints(r) : sort === 'contracts' ? getContracts(r) : sort === 'conversations' ? getConversations(r) : getCalls(r));
  const fmtM = (v: number) => (sort === 'points' ? v.toLocaleString('en-US') : String(v));
  const badgeView = (r: SalesPerson) => badgesFor(r, ctx).slice(0, 3).map((b) => ({ id: b.id, title: b.name + ' — ' + b.hint, img: b.image }));
  const avatarOf = (r: SalesPerson) => boardFace(r.name, r.avatar);

  const visible = reps
    .filter((r) => scope === 'all' || (scope === 'disposition') === (r.role === 'disposition'))
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .map((r) => ({ r, v: metric(r) }))
    .sort((a, b) => b.v - a.v || b.r.revenue - a.r.revenue || a.r.name.localeCompare(b.r.name));
  const leader = Math.max(1, visible[0] ? visible[0].v : 1);
  const openRep = () => go('reporting', { reportTab: 'Team' });

  const podium = visible.slice(0, 3);
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  const lbPodium = order.map((e) => {
    const rank = visible.indexOf(e) + 1;
    const first = rank === 1;
    return {
      rank, name: e.r.name, avatar: avatarOf(e.r), score: fmtM(e.v), isFirst: first, notFirst: !first,
      // The podium is sized for a wall display; on a phone every slot shrinks
      // so the three reps fit across the screen instead of bleeding off it.
      slotW: s.isMobile ? (first ? '104px' : '92px') : first ? '200px' : '170px',
      size: s.isMobile ? (first ? '68px' : '54px') : first ? '116px' : '86px',
      pip: s.isMobile ? '22px' : first ? '30px' : '26px',
      pipFs: s.isMobile ? '11px' : first ? '14px' : '12px',
      nameFs: s.isMobile ? (first ? '13px' : '12px') : first ? '18px' : '15px',
      nameW: first ? 800 : 700,
      scoreFs: s.isMobile ? (first ? '24px' : '19px') : first ? '38px' : '28px',
      shadow: first ? '0 8px 28px rgba(28,29,31,.18)' : '0 4px 16px rgba(28,29,31,.14)',
      badges: badgeView(e.r), open: openRep,
      sub: `${getContracts(e.r)} contracts · ${getConversations(e.r)} convos · ${getCalls(e.r)} calls`,
    };
  });
  const lbRest = visible.slice(3).map((e, i) => ({
    rank: i + 4, name: e.r.name, avatar: avatarOf(e.r), score: fmtM(e.v),
    pct: Math.min(100, Math.round((e.v / leader) * 100)) + '%',
    badges: badgeView(e.r), open: openRep,
    sub: `${getContracts(e.r)} contracts · ${getConversations(e.r)} convos · ${getCalls(e.r)} calls`,
  }));

  // Team totals count each deal once (a deal with an acquisitions owner and a
  // dispo rep is one contract, not two), the same as the executive summary.
  const yearContracts = buildLeaderboard(boardRaw, 'this-year', opts).executiveSummary.totalDealsUnderContract;
  // The prize card is the monthly prize an admin sets in Settings → Floor show
  // (the wheel's gold slice), so the two never disagree. Every contract this
  // month is one spin at it.
  const monthContracts = buildLeaderboard(boardRaw, 'this-month', opts).executiveSummary.totalDealsUnderContract;
  const prize = getMonthlyPrize();
  const lbPrize = prize ? {
    name: prize.set ? prize.name : 'No prize set yet',
    set: prize.set,
    detail: prize.detail,
    month: new Date().toLocaleDateString('en-US', { month: 'long', timeZone: tz }),
    spins: monthContracts,
  } : null;

  // Head-to-head: the two reps just off the podium as it is drawn (same sort,
  // scope and search), on contracts this week; the top two when fewer than
  // five are on the board. Clicking it opens the week side by side.
  const pairFrom = visible.length >= 5 ? visible.slice(3, 5) : visible.slice(0, 2);
  const [hA, hB] = pairFrom.map((e) => e.r);
  const lbH2hNote = visible.length >= 5 ? 'Contracts this week (Mon–Sun) · the two reps just off the podium' : 'Contracts this week (Mon–Sun) · the top two on the board';
  const weekOf = (r: SalesPerson) => week.salesPeople.find((x) => x.id === r.id) ?? null;
  const weekContracts = (r: SalesPerson) => { const w = weekOf(r); return w ? getContracts(w) : 0; };
  const topH = Math.max(1, hA ? weekContracts(hA) : 0, hB ? weekContracts(hB) : 0);
  const lbH2h = (hA && hB && hA.id !== hB.id ? [hA, hB] : []).map((r, i) => {
    const other = i === 0 ? hB : hA;
    const mine = weekContracts(r), theirs = weekContracts(other);
    const leading = i === 0 ? mine >= theirs : mine > theirs;
    return { first: r.name.split(' ')[0], avatar: avatarOf(r), score: mine, pct: Math.round((mine / topH) * 100) + '%', fill: leading ? '#12946a' : '#c4c1b7' };
  });
  // The week's numbers for both, row by row, for the open card.
  const lbH2hRows = hA && hB && hA.id !== hB.id ? ([
    ['Contracts', getContracts], ['Conversations', getConversations], ['Calls', getCalls], ['Points', calculatePoints],
  ] as [string, (p: SalesPerson) => number][]).map(([k, f]) => {
    const a = weekOf(hA), b = weekOf(hB);
    const va = a ? f(a) : 0, vb = b ? f(b) : 0;
    return { k, a: va.toLocaleString('en-US'), b: vb.toLocaleString('en-US'), aLead: va > vb, bLead: vb > va };
  }) : [];
  // The week ends Sunday night in the board's zone, not the viewer's.
  const lbH2hDaysLeft = (() => {
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date());
    const d = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    const left = d === 0 ? 0 : 7 - d;
    return left <= 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`;
  })();

  const lbTitles = resolveTitles(reps).map(({ title, holder, valueLabel }) => ({
    name: title.name, desc: title.description, img: title.image, icon: title.icon,
    holder: holder ? holder.name.split(' ')[0] : 'Vacant',
    avatar: holder ? avatarOf(holder) : '',
    valueLabel: holder ? holder.name + ' · ' + valueLabel : '—',
  }));

  // The badge gallery: every badge, who holds it right now.
  const lbBadgeGallery = BADGES.map((b) => {
    const holders = reps.filter((r) => badgesFor(r, ctx, true).some((x) => x.id === b.id));
    return { id: b.id, name: b.name, hint: b.hint, tier: b.tier, img: b.image, approximation: b.approximation ?? '', holders: holders.map((h) => ({ name: h.name, avatar: avatarOf(h) })), held: holders.length > 0 };
  });

  const now = new Date();
  let hh = now.getHours();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const lbClock = hh + ':' + String(now.getMinutes()).padStart(2, '0') + ' ' + ampm;

  const menu = s.lbMenu || {};
  const opt = (list: readonly (readonly [string, string])[], cur: string, key: keyof ClozrState) => list.map(([value, label]) => ({
    label,
    go: () => set({ [key]: value, lbMenu: {} } as Partial<ClozrState>),
    bg: value === cur ? '#e3f0e9' : 'transparent',
    color: value === cur ? '#0e7a57' : '#1c1d1f',
  }));

  const x = payload.executiveSummary;
  const teamContracts = x.totalDealsUnderContract;
  const lbSyncLabel = !isLive ? 'Sample data · the live board reads CLOZR records and Talkr calls'
    : `Live from CLOZR · deals, offers, Talkr calls & texts · ${reps.length} rep${reps.length === 1 ? '' : 's'}`;

  return {
    isLeaderboard: s.screen === 'leaderboard',
    isCoaching: s.screen === 'coaching',
    isAccount: s.screen === 'account',
    isSettings: s.screen === 'settings',
    // Screens that own their bottom-right corner. The inbox puts a composer
    // there at every size, so the floating dialer covers Send; the rest only
    // collide once a phone stacks everything into one column.
    hideFab:
      s.screen === 'inbox' ||
      s.screen === 'dialer' ||
      s.screen === 'account' ||
      s.screen === 'settings' ||
      (s.isMobile &&
        (s.screen === 'leaderboard' || s.screen === 'plans' || s.screen === 'automations')),
    goLeaderboard: () => go('leaderboard'),
    goReporting: () => go('reporting'),
    lbQ: s.lbQ || '',
    setLbQ: (e: React.ChangeEvent<HTMLInputElement>) => set({ lbQ: e.target.value }),
    lbClock,
    lbPeriodLabel: (LB_PERIODS.find((p) => p[0] === period) || LB_PERIODS[7])[1],
    lbSortLabel: LB_SORTS.find((x) => x[0] === sort)![1],
    lbScopeLabel: LB_SCOPES.find((x) => x[0] === scope)![1],
    lbPeriods: opt(LB_PERIODS, period, 'lbPeriod'),
    lbSorts: opt(LB_SORTS, sort, 'lbSort'),
    lbScopes: opt(LB_SCOPES, scope, 'lbScope'),
    lbMenu: { period: !!menu.period, sort: !!menu.sort, scope: !!menu.scope },
    lbToggle: {
      period: () => set({ lbMenu: { period: !menu.period } }),
      sort: () => set({ lbMenu: { sort: !menu.sort } }),
      scope: () => set({ lbMenu: { scope: !menu.scope } }),
    },
    lbPodium, lbRest, lbRestEmpty: lbRest.length === 0, lbPrize,
    lbTeamContracts: teamContracts, lbYearContracts: yearContracts, lbH2h, lbH2hDaysLeft, lbH2hNote, lbH2hRows, lbTitles,
    lbH2hOpen: !!s.lbH2hOpen,
    toggleH2h: () => set({ lbH2hOpen: !s.lbH2hOpen }),
    // A board read on a failed load would rank on missing rows; say so.
    lbReadFailed: !ui.crmOk,
    lbSyncLabel, lbNotes: [
      ...payload.notes,
      ...(Object.keys(getLeaderboardResets()).length ? ['Some reps were zeroed after a bulk import. Activity before that reset is left off this board.'] : []),
    ],
    lbEmpty: reps.length === 0,
    // The executive strip: the same totals the TV's summary view shows.
    lbKpis: [
      ['Calls', x.totalCalls.toLocaleString()], ['Texts', x.totalSMS.toLocaleString()], ['Appointments', x.totalAppointments.toLocaleString()],
      ['Offers', x.totalOffersMade.toLocaleString()], ['Contracts', x.totalDealsUnderContract.toLocaleString()], ['Closings', x.totalClosings.toLocaleString()],
      ['Revenue', '$' + Math.round(x.totalRevenue).toLocaleString()], ['Pipeline now', '$' + Math.round(x.totalPipelineVolume).toLocaleString()],
    ].map(([k, v]) => ({ k, v })),
    lbPointsOpen: !!s.lbPointsOpen,
    togglePoints: () => set({ lbPointsOpen: !s.lbPointsOpen, lbBadgesOpen: false }),
    lbBadgesOpen: ui.badgesOpen,
    toggleBadges: () => set({ lbBadgesOpen: !ui.badgesOpen, lbPointsOpen: false }),
    lbBadgeGallery,
    lbPointsRows: ([
      ['Closing', 'Deal closed and funded', 500],
      ['Appointment', 'Appointment set with a seller', 250],
      ['Contract', 'Deal signed under contract', 200],
      ['Conversation', 'Qualified two-way conversation (a call of 2+ minutes)', 100],
      ['Offer Made', 'Written or verbal offer delivered', 50],
      ['Call', 'Call attempt, in or out', 10],
      ['Text', 'Outbound SMS sent', 2],
      ['Email', 'Outbound email sent', 1],
    ] as [string, string, number][]).map(([label, detail, value]) => ({
      label, detail, value: value.toLocaleString(),
    })),
    tvLabel: s.tvMode ? 'Exit TV mode' : 'TV mode (hides CLOZR chrome)',
    toggleTv: () => {
      set({ tvMode: !s.tvMode });
      toast(s.tvMode ? 'App chrome restored' : 'TV mode · press F11 for fullscreen');
    },
    tvBg: s.tvMode ? '#e3f0e9' : '#fdfcfa',
    tvBorder: s.tvMode ? '#12946a' : '#ddd9ce',
    tvColor: s.tvMode ? '#0e7a57' : '#6f7377',
  };
}
