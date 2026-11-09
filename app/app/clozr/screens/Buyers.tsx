// The buyer list — the dispo side's address book and the thing a rep scans
// before a deal goes out.
//
// The desktop table used to give every one of ten columns the same weight, so
// nothing led and nothing could be skimmed. It reads as a list of people now:
// the buyer and who they are on the left, then their box, then how warm they
// are as a meter rather than a bare number. The phone keeps the stacked card,
// which was already the right shape for the same facts.
'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { ContractsButton } from '@/components/ContractsHub';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { useReveal } from '@/components/ds/useReveal';
import { useDebouncedText } from '@/components/ds/useDebouncedText';
import { Empty, EmptyRow } from '@/components/ds/Empty';
import type { ClozrView } from '@/app/clozr/view';
import { BlacklistButton } from '@/components/BlacklistButton';
import { openReach } from '@/app/components/record/reach';
import { Mark, TireChip } from '@/components/ds/mark';
import { BuyerBulkBar } from '@/components/BuyerBulkBar';
import { BuyerAutomations } from '@/components/BuyerAutomations';
import { ComboPopover } from '@/components/FilterCombo';
import { useBuyerScores } from '@/app/clozr/useBuyerScores';
import { responseTone } from '@/lib/heat';
import { isTireKicker } from '@/lib/tire-kicker';
import { type BuyerAiScore } from '@/lib/buyer-ai-score';
import { dbId } from '@/lib/crm';
import { ColumnPicker, SortMenu, ViewMenu, sameList, type ColumnDef } from '@/components/ViewControls';
import { cmpSort, toggleSort, type SortDir } from '@/lib/list-sort';
import { Chevron, CZ, MenuCheck, trayBtn } from '@/components/ds/chrome';
import { RailRow, RailToggle, useRailOpen, type RailItem } from '@/components/ds/ListRail';
import { Ring, tier } from '@/components/kit/parts';
import { ListMapSwitch, useListOrMap } from '@/components/ListMap';
import { BuyerMap } from '@/app/components/buyer/BuyerMap';
import type { RealtorPick } from '@/lib/crm';
import { cleanColumns, useSavedViews } from '@/lib/saved-views';
import { remember, useRemembered } from '@/lib/screen-memory';
import { buyerStatusTone } from '@/lib/people-colors';
import { COMPR_ALL_LIST, COMPR_CONTACTED_LIST, COMPR_IN_PLAN_LIST, COMPR_INTERESTED_LIST, COMPR_NOT_CONTACTED_LIST, COMPR_NOT_INTERESTED_LIST, COMPR_PAID_LIST, COMPR_TRIAL_LIST, buyerListLabelOf, inBuyerList } from '@/lib/buyer-list-profile';
import { COMPR_PLAN_FILTERS, comprBillingFlag, comprPlanBucket, comprStatusLabel, paidLabel, planLabel, useComprSignups, type ComprSignup } from '@/lib/compr-signups';
import { ComprSuggested } from '@/app/components/buyer/ComprStubs';
import { ComprAutomations } from '@/app/components/buyer/ComprStubs';
import { isPicked, picksLabel, picksOf, togglePick } from '@/lib/multi-filter';
import { NOT_ON_A_PLAN, ON_A_PLAN, runningMatch, useRunningPlans } from '@/lib/running-plans';
import { PaymentLinkDialog, TRIAL_ICON, TrialLinkButton, type PayPerson } from '@/app/components/buyer/ComprStubs';
import { TRIAL_DEFAULT_DAYS, alreadyPaid } from '@/lib/compr-payment-link';
import { ExtendTrialButton, ExtendTrialDialog, P_CAL } from '@/app/components/buyer/ComprStubs';
import { canExtendTrial, withTrialEnd } from '@/lib/compr-extend-trial';
import { NewSmartListDialog, PlusIcon, SavedRailRow, useBuyerSmartLists, useRemoveSmartList, type BuyerSmartList } from '@/app/components/buyer/BuyerSmartLists';
import { buyersNavAction, isArchiveChord, isOpenKey, isTypingTarget, listNavBlocked } from '@/lib/people-keys';
import { PickLabel } from '@/components/ds/PickBox';
import { ActiveFilters, FilterRail, FilterRailShow, FilterSheet, chipsFromMenus, useFilterRailOpen, type FilterGroup } from '@/app/components/filters/FilterRail';
import { DateRangeFields } from '@/app/components/filters/RangeFilters';
import { ScreenHeader } from '@/components/ds/Screen';

/** Every field the buyers table can show. Buyer is always on. */
const BUYER_FIELDS: ColumnDef[] = [
  { key: 'buyer', label: 'Buyer', locked: true },
  { key: 'status', label: 'Status' },
  { key: 'stage', label: 'Stage' },
  { key: 'markets', label: 'Markets' },
  { key: 'type', label: 'Type' },
  { key: 'price', label: 'Price range' },
  { key: 'exit', label: 'Exit' },
  { key: 'engagement', label: 'Response' },
  { key: 'lastPurchase', label: 'Last purchase' },
  { key: 'lastActivity', label: 'Last activity' },
  { key: 'added', label: 'Date added' },
  { key: 'entity', label: 'Entity' },
  { key: 'pref', label: 'Prefers' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'tags', label: 'Tags' },
  { key: 'buyerType', label: 'Buyer type' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'ceiling', label: 'Ceiling' },
  { key: 'offers', label: 'Offers' },
  { key: 'doNot', label: 'Do not contact' },
  { key: 'owner', label: 'Owner' },
];
const BUYER_KEYS = BUYER_FIELDS.map((f) => f.key);
const BUYER_DEFAULT = ['buyer', 'stage', 'status', 'markets', 'entity', 'type', 'price', 'exit', 'engagement', 'lastPurchase', 'lastActivity', 'added', 'pref'];

/**
 * A Compr workspace's Buyers holds Compr customers (lib/buyer-list-profile).
 * Every view opens on the first seven; the rest come from compr-trial-sync
 * (`buyers.compr_signup`) or the record itself and can be added.
 */
const COMPR_FIELDS: ColumnDef[] = [
  { key: 'buyer', label: 'Name', locked: true },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'markets', label: 'Market' },
  { key: 'lastActivity', label: 'Last activity' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'actionPlan', label: 'Action plan' },
  { key: 'plan', label: 'Plan' },
  { key: 'signedUp', label: 'Signed up' },
  { key: 'runs', label: 'Underwrites' },
  { key: 'paid', label: 'Paid' },
  { key: 'company', label: 'Company' },
  { key: 'tags', label: 'Tags' },
  { key: 'added', label: 'Date added' },
  { key: 'owner', label: 'Owner' },
];
const COMPR_KEYS = COMPR_FIELDS.map((f) => f.key);
const COMPR_DEFAULT = ['buyer', 'phone', 'email', 'markets', 'lastActivity', 'type', 'status', 'actionPlan', 'runs', 'paid'];
const COMPR_SORT_OPTIONS = [
  { id: 'lastActivity:desc', label: 'Last activity' },
  { id: 'signedUp:desc', label: 'Signed up, newest' },
  { id: 'runs:desc', label: 'Most underwrites' },
  { id: 'paid:desc', label: 'Paid, most' },
  { id: 'buyer:asc', label: 'Name' },
  { id: 'status:asc', label: 'Status' },
  { id: 'added:desc', label: 'Date added, newest' },
];
const BUYER_SORT_OPTIONS = [
  { id: 'added:desc', label: 'Date added, newest' },
  { id: 'added:asc', label: 'Date added, oldest' },
  { id: 'buyer:asc', label: 'Buyer name' },
  { id: 'status:asc', label: 'Status' },
  { id: 'stage:asc', label: 'Stage' },
  { id: 'engagement:desc', label: 'Response' },
  { id: 'score:desc', label: 'Buyer score' },
  { id: 'dealMatch:desc', label: 'Best match for deal' },
  { id: 'lastActivity:desc', label: 'Last activity' },
];
const BUYER_DEFAULT_SORT = { key: 'added', dir: 'desc' as SortDir };

function buyerSortValue(b: BuyerRow, key: string, ai?: BuyerAiScore, signup?: ComprSignup, compr?: boolean): string | number {
  if (key === 'added') return b.addedAt || '';
  if (key === 'lastActivity') return b.lastActivityAt || '';
  if (key === 'signedUp') return signup?.signed_up_at ?? '';
  if (key === 'runs' && signup) return signup.runs;
  if (key === 'paid' && signup) return signup.paid_cents ?? -1;
  if (key === 'status' && signup) return comprStatusLabel(signup);
  if (key === 'status' && compr) return b.stage;
  if (key === 'buyer') return b.company || b.name;
  if (key === 'engagement') return responseOf(b, ai).pct ?? -1;
  if (key === 'score') return ai?.score ?? b.engagement;
  if (key === 'dealMatch') return b.dealMatch ?? 0;
  const v = (b as unknown as Record<string, unknown>)[key];
  return v == null ? '' : typeof v === 'number' ? v : String(v);
}
/** What each Compr bucket holds, for its rail tooltip and empty state. */
const COMPR_LIST_TITLES: Record<string, string> = {
  [COMPR_NOT_CONTACTED_LIST]: 'Never texted, emailed or called, and not on an action plan. Start here.',
  [COMPR_IN_PLAN_LIST]: 'An action plan is running for them now. They leave it when it ends or they answer.',
  [COMPR_CONTACTED_LIST]: 'Reached by text, email or call, not on a plan now, and no answer either way yet.',
  [COMPR_INTERESTED_LIST]: 'Asked for a demo, a call, info or the price, or you moved them here.',
  [COMPR_NOT_INTERESTED_LIST]: 'Said no, STOP or wrong number. Off every plan, and no plan will take them.',
  [COMPR_TRIAL_LIST]: 'Every Compr free trial user, synced from Compr every 15 minutes',
  [COMPR_PAID_LIST]: 'Everyone on a paid Compr plan, synced from Compr every 15 minutes',
};

const NO_BUYER_FILTERS = { buyerState: 'Any', buyerCity: 'Any', buyerEntity: 'Any', buyerType: 'Any', buyerStatus: 'Any', buyerPhone: 'Any', buyerEmail: 'Any', buyerOwner: 'Any', buyerDeal: 'Any', buyerPlan: 'Any', buyerTag: 'Any', buyerRunning: 'Any' };

/**
 * What a saved Buyers view keeps (lib/saved-views.ts). `profile` marks a view
 * saved on the Compr columns; on a Compr workspace any other view opens on
 * the Compr defaults, so every view there shows the Compr fields.
 */
type BuyersConfig = { cols: string[]; filters: typeof NO_BUYER_FILTERS; geniusOnly: boolean; profile?: 'compr' };

/** The filter rail's sections for Buyers (Compr workspaces add Plan and Action plan). */
const BUYER_FILTER_GROUPS: FilterGroup[] = [
  { title: 'Deal', keys: ['buyerDeal'] },
  { title: 'Compr', keys: ['buyerPlan', 'buyerRunning'] },
  { title: 'Buyer', keys: ['buyerStatus', 'buyerStage', 'buyerType', 'buyerEntity', 'buyerTag'] },
  { title: 'Assigned', keys: ['buyerOwner'] },
  { title: 'Location', keys: ['buyerState', 'buyerCity'] },
  { title: 'Stage history', keys: ['buyerHistory', 'buyerHistoryWhen'] },
  { title: 'Contact info', keys: ['buyerPhone', 'buyerEmail'] },
];

/** Filters with long option lists get a type-ahead box. */
const SEARCHABLE = new Set(['buyerState', 'buyerCity']);

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const FAINT = 'var(--subtle, #a1a1aa)';
const LINE = 'var(--divider, #e4e4e7)';
const HAIR = 'var(--divider-2, #f0f0f1)';
/** The buyer side is Genius purple (tokens.css --c-genius). */
const GREEN = '#0A8560';
/** A ghost control that can be switched on: Genius only, Automations, Refresh scores. */
const toggleStyle = (on: boolean): React.CSSProperties => ({
  height: '32px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${on ? GREEN : 'var(--c-btn-line)'}`,
  background: on ? 'var(--c-genius-soft, #f0faf5)' : 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: on ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)',
  fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
});

/** One label-over-value cell in the phone card's fact grid. */
function Fact({ label, value, color, strong }: { label: string; value: React.ReactNode; color?: string; strong?: boolean }) {
  return (
    <span style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: '11px', fontWeight: 500, color: MUTED }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '12.5px', fontWeight: strong ? 600 : 500, color: color || 'var(--ink-2, #27272a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value || '—'}
      </span>
    </span>
  );
}

/** Status as a filled chip, colour-coded (lib/people-colors): one glance tells VIP from Inactive. */
function StatusChip({ label }: { label: string; color?: string }) {
  const t = buyerStatusTone(label);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', height: '22px', padding: '0 8px', borderRadius: '6px',
      fontSize: '11px', fontWeight: 600,
      color: t.fg, background: t.bg, border: `1px solid ${t.line}`,
      whiteSpace: 'nowrap',
    }}>
      <Mark label={label} size={12} />
      {label}
    </span>
  );
}

/** Response rate as a meter, green to yellow to red (lib/heat.ts responseTone). Unknown reads as a dash, never 0%. */
function Engagement({ score, color, title }: { score: number | null; color: string; title?: string }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
      <span style={{ width: '44px', height: '4px', borderRadius: '999px', background: HAIR, overflow: 'hidden', flex: 'none' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: color, borderRadius: '999px' }} />
      </span>
      <span style={{ fontWeight: 650, color: score == null ? MUTED : color, fontVariantNumeric: 'tabular-nums' }}>{score == null ? '—' : `${score}%`}</span>
    </span>
  );
}

/**
 * Response rate: the buyer-score function's count of every text, email, call
 * and deal send the team made and how many the buyer answered (the AI read
 * when it ran). The list row carries the stored figure; a score fetched this
 * visit wins. The tire kicker flag comes from the same counts.
 */
function responseOf(b: BuyerRow, ai?: BuyerAiScore): { pct: number | null; color: string; label: string; tireKicker: boolean; title: string } {
  const fresh = ai && ai.responseRate != null && ai.touches > 0;
  const pct = fresh ? ai!.responseRate! : b.responseKnown ? b.engagement : null;
  const tireKicker = fresh
    ? isTireKicker({ sent: ai!.touches, responsePct: ai!.responseRate!, offers: ai!.offers, purchases: ai!.closed })
    : !!b.tireKicker;
  const tone = responseTone(pct, tireKicker);
  const counts = fresh ? `Answered ${ai!.answered} of ${ai!.touches} touches` : pct != null ? `${pct}% of touches answered` : 'Nothing sent to this buyer yet';
  return { pct, color: tone.stroke, label: tone.label, tireKicker, title: `${tone.label}. ${counts}.${ai?.reason ? ` ${ai.reason}` : ''}` };
}

/**
 * The buyer score as the ring Genius results use, number in the middle and
 * the temperature under it, with its reason on hover (and to screen readers).
 * A buyer not scored from full history yet shows the reply ratio in the same
 * colours, captioned "Replies" so it never passes for the full score.
 */
function ScoreRing({ b, ai, size = 34 }: { b: BuyerRow; ai?: BuyerAiScore; size?: number }) {
  const n = ai ? ai.score : b.engagement;
  // Not scored from full history yet: the ring is the reply rate, so it reads
  // on the response scale (green to red) with the tire kicker flag.
  const t = ai ? tier(n) : (() => { const r = responseTone(b.responseKnown === false ? null : n, !!b.tireKicker); return { label: 'Replies', color: r.stroke, text: r.text }; })();
  const reason = ai ? `${ai.reason}${ai.source === 'rule' ? ' (reply-based, AI unavailable)' : ''}` : 'Reply ratio only. Not scored from full history yet.';
  return (
    <span title={reason} aria-label={`Buyer score ${n} of 100, ${t.label}. ${reason}`} style={{ flex: 'none', display: 'inline-flex' }}>
      <Ring value={n} color={t.color} text={t.text} size={size} label={t.label} />
    </span>
  );
}

/** Up to two markets as chips, the rest as a count. */
function Markets({ list, fallback }: { list?: string[]; fallback: string }) {
  if (!list || !list.length) return <span style={{ color: FAINT }}>{fallback || '—'}</span>;
  const shown = list.slice(0, 2);
  const rest = list.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'nowrap' }}>
      {shown.map((m) => (
        <span key={m} style={{ fontSize: '11px', color: 'var(--ink-3, #3f3f46)', background: 'var(--surface-2, #f4f4f5)', border: `1px solid ${HAIR}`, borderRadius: '6px', padding: '2px 6px', whiteSpace: 'nowrap', maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m}</span>
      ))}
      {rest > 0 ? <span style={{ fontSize: '11px', color: FAINT, whiteSpace: 'nowrap' }}>+{rest}</span> : null}
    </span>
  );
}

const cell: React.CSSProperties = { padding: '0 14px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', color: 'var(--muted, #52525b)' };

type BuyerRow = ClozrView['buyerRows'][number];

/** How a buyer prospect was found. Real buyers on the main list stay unlabeled. */
function foundHow(b: BuyerRow): string | null {
  if (b.prospectList !== 'buyer-prospect') return null;
  const tags = b.tags.toLowerCase();
  if (tags.includes('fb-comment')) return 'Facebook';
  if (tags.includes('buyr') || b.source === 'buyr') return 'Discovered';
  if (tags.includes('investorbase') || b.source === 'investorbase') return 'InvestorBase';
  if (b.genius || tags.includes('genius') || b.source === 'genius') return 'Discovered';
  return null;
}

/** A Compr signup's state as a badge: a billing problem red with its icon, trial in the accent tint, a used trial amber, paid ink. */
function ComprStatusChip({ s }: { s: ComprSignup }) {
  const label = comprStatusLabel(s);
  const flag = comprBillingFlag(s);
  const tone = flag ? { fg: 'var(--tx-red, #b91c1c)', bg: 'var(--tint-red, #fef2f2)', line: 'var(--tint-red-2, #fecaca)' }
    : s.trial === 'active' || s.trial === 'stripe' ? { fg: 'var(--tx-mint-deep, #08694c)', bg: 'var(--c-action-soft, #e7f5ef)', line: 'var(--c-action-line, #a7dcc5)' }
      : s.trial === 'used' ? { fg: 'var(--tx-amber, #b45309)', bg: 'var(--tint-amber, #fffbeb)', line: 'var(--tint-amber-2, #fde68a)' }
        : { fg: 'var(--ink, #18181b)', bg: 'var(--surface-2, #f4f4f5)', line: 'var(--divider, #e4e4e7)' };
  return (
    <span title={flag ? `${flag}: call them from their record` : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', height: '22px', padding: '0 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, color: tone.fg, background: tone.bg, border: `1px solid ${tone.line}`, whiteSpace: 'nowrap' }}>
      {flag ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ) : null}
      {label}
    </span>
  );
}

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** The Compr-only cells, by field key; null for a key the default cell draws. */
function ComprCell({ k, b, s, running }: { k: string; b: BuyerRow; s?: ComprSignup; running?: string[] }): React.ReactElement | null {
  const dash = <span style={{ color: FAINT }} aria-label="None">–</span>;
  switch (k) {
    case 'buyer': {
      const other = b.company && b.company !== b.name ? b.company : '';
      return (
        <td style={{ ...cell, height: '48px' }}>
          <span className="t-name" style={{ display: 'block', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={b.name}>{b.name}</span>
          {other ? <span style={{ display: 'block', maxWidth: '260px', fontSize: '11px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis' }} title={other}>{other}</span> : null}
        </td>
      );
    }
    // Compr customers show their Compr plan status; everyone else their stage (migration 417), not the dispo label.
    case 'status': return <td style={cell}>{s ? <ComprStatusChip s={s} /> : <StatusChip label={b.stage} />}</td>;
    case 'actionPlan': return <td style={cell}>{running?.length ? <span title={running.join(', ')} style={{ display: 'block', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{running.join(', ')}</span> : <span style={{ color: FAINT }}>Not on a plan</span>}</td>;
    case 'plan': return <td style={cell}>{s ? planLabel(s.tier) : dash}</td>;
    case 'signedUp': return <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{s ? shortDate(s.signed_up_at) || dash : dash}</td>;
    case 'runs': return <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{s ? s.runs.toLocaleString('en-US') : dash}</td>;
    case 'paid': return <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{s && s.paid_cents != null ? (s.paid_cents ? paidLabel(s.paid_cents) : '$0') : dash}</td>;
    case 'company': return <td style={cell}>{b.company && b.company !== b.name ? b.company : dash}</td>;
    default: return null;
  }
}

/** One table cell, by field key. */
function BuyerCell({ k, b, onCall, ai, compr, signup, running }: { k: string; b: BuyerRow; onCall: (phone: string) => void; ai?: BuyerAiScore; compr?: boolean; signup?: ComprSignup; running?: string[] }) {
  const comprCell = compr ? ComprCell({ k, b, s: signup, running }) : null;
  if (comprCell) return comprCell;
  switch (k) {
    case 'buyer':
      return (
        <td style={{...cell, height: '58px'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
            <ScoreRing b={b} ai={ai} />
            <span style={{minWidth: 0}}>
              <span style={{display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '260px'}}>
                <span className="t-name" style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{b.company}</span>
                {foundHow(b) ? <span style={{ flex: 'none', fontSize: '11px', fontWeight: 600, color: 'var(--ink-3, #3f3f46)', background: 'var(--surface-2, #f4f4f5)', borderRadius: '6px', padding: '1px 6px' }}>{foundHow(b)}</span> : null}
              </span>
              <span style={{display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '260px', fontSize: '11px', color: MUTED}}>
                <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0}}>{b.name}</span>
                {ai?.source === 'ai' ? <span style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--tx-mint-deep, #08694c)', background: 'var(--c-action-soft, #e7f5ef)', borderRadius: 6, padding: '0 4px' }}>AI</span> : null}
              </span>
            </span>
          </div>
        </td>
      );
    case 'status': return <td style={cell}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><StatusChip label={b.status} color={b.statusColor} />{responseOf(b, ai).tireKicker ? <TireChip /> : null}</span></td>;
    case 'markets': return <td style={cell}><Markets list={b.placeLabels} fallback={b.markets} /></td>;
    case 'entity':
      return <td style={cell}><span style={{color: b.isLlc ? INK : FAINT, fontWeight: b.isLlc ? 600 : 400}}>{b.entity}</span></td>;
    case 'price': return <td style={{...cell, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums'}}>{b.price}</td>;
    case 'engagement': { const r = responseOf(b, ai); return <td style={cell}><Engagement score={r.pct} color={r.color} title={r.title} /></td>; }
    case 'phone':
      return <td style={cell} onClick={(e) => e.stopPropagation()}>{b.phone ? <a className="clozr-contact" href={'tel:' + b.phone} onClick={(e) => { e.preventDefault(); onCall(b.phone); }} style={{fontVariantNumeric: 'tabular-nums'}}>{b.phone}</a> : <span style={{color: FAINT}}>—</span>}</td>;
    case 'email':
      return <td style={cell} onClick={(e) => e.stopPropagation()}>{b.email ? <a className="clozr-contact" href={'mailto:' + b.email} onClick={(e) => { e.preventDefault(); openReach('email', { name: b.name, email: b.email, phone: b.phone, audience: 'buyer' }); }}>{b.email}</a> : <span style={{color: FAINT}}>—</span>}</td>;
    default: {
      const v = (b as unknown as Record<string, unknown>)[k];
      return <td style={cell}>{v == null || v === '' ? <span style={{color: FAINT}}>—</span> : String(v)}</td>;
    }
  }
}

/**
 * One buyer in the table. Memoized on the row object (useClozr rebuilds
 * those only when the list, the filters or the data change) and on stable
 * handlers, so a keystroke elsewhere in the shell no longer redraws the page.
 */
const BuyerTableRow = React.memo(function BuyerTableRow({ b, index, focused, selected, shown, compr, canPay, ai, signup, running, onOpen, onToggle, callPhone, onExtend, onPay }: {
  b: BuyerRow; index: number; focused: boolean; selected: boolean; shown: ColumnDef[]; compr: boolean; canPay: boolean;
  ai?: BuyerAiScore; signup?: ComprSignup; running?: string[];
  onOpen: (index: number, b: BuyerRow) => void; onToggle: (id: string) => void; callPhone: (phone: string) => void;
  onExtend: (id: string) => void; onPay: (ids: string[], trial: number | null) => void;
}) {
  return (
    <tr className="dc2" data-buyer-focus={focused || undefined} onClick={() => onOpen(index, b)} style={{cursor: "pointer", background: selected || focused ? "var(--c-genius-soft, #f0faf5)" : undefined, outline: focused ? `2px solid ${GREEN}` : undefined, outlineOffset: focused ? '-2px' : undefined}}>
      <td onClick={(e) => e.stopPropagation()} style={{padding: "0 14px", borderBottom: `1px solid ${HAIR}`}}>
        <input type="checkbox" aria-label={'Select ' + b.company} checked={selected} onChange={() => onToggle(b.id)} style={{width: "14px", height: "14px", accentColor: GREEN, cursor: "pointer"}} />
      </td>
      {shown.map((f) => <BuyerCell key={f.key} k={f.key} b={b} onCall={callPhone} ai={ai} compr={compr} signup={signup} running={running} />)}
      {canPay ? (
        <td onClick={(e) => e.stopPropagation()} style={{padding: "0 8px", borderBottom: `1px solid ${HAIR}`, width: "80px", textAlign: "right", whiteSpace: "nowrap"}}>
          {canExtendTrial(signup) ? (
            <button type="button" className="dc2" aria-label={`Extend ${b.name}'s Compr trial`} title="Extend the Compr trial" onClick={() => onExtend(b.id)}
              style={{width: "32px", height: "32px", display: "inline-grid", placeItems: "center", borderRadius: "8px", border: 0, background: "none", color: MUTED, cursor: "pointer"}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P_CAL} /></svg>
            </button>
          ) : alreadyPaid(signup?.tier) ? null : (
            <>
              <button type="button" className="dc2" aria-label={`Send ${b.name} a trial link`} title="Send a Compr link with a 7-day free trial" onClick={() => onPay([b.id], TRIAL_DEFAULT_DAYS)}
                style={{width: "32px", height: "32px", display: "inline-grid", placeItems: "center", borderRadius: "8px", border: 0, background: "none", color: MUTED, cursor: "pointer"}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TRIAL_ICON} /></svg>
              </button>
              <button type="button" className="dc2" aria-label={`Send ${b.name} a payment link`} title="Send a Compr payment link" onClick={() => onPay([b.id], null)}
                style={{width: "32px", height: "32px", display: "inline-grid", placeItems: "center", borderRadius: "8px", border: 0, background: "none", color: MUTED, cursor: "pointer"}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM2 10h20" /></svg>
              </button>
            </>
          )}
        </td>
      ) : null}
    </tr>
  );
});

export function Buyers({ V }: { V: ClozrView }) {
  const [sel, setSel] = React.useState<Record<string, boolean>>({});
  const [mode, setMode] = useListOrMap('clozr.buyers.view');
  // Realtors lassoed on the map, by market: they are not rows the list holds.
  const [realtorPicks, setRealtorPicks] = React.useState<Record<string, RealtorPick[]>>({});
  const [automations, setAutomations] = React.useState(false);
  // Buyer ids (row ids) the payment link dialog is open for.
  const [paying, setPaying] = React.useState<string[] | null>(null);
  // Free trial days the dialog opens on: "Trial link" presets 7, every other entry none.
  const [payTrial, setPayTrial] = React.useState<number | null>(null);
  const openPay = useCallback((ids: string[], trial: number | null = null) => { setPayTrial(trial); setPaying(ids); }, []);
  const toggleSel = useCallback((id: string) => setSel((x) => ({ ...x, [id]: !x[id] })), []);
  // The rows get stable handlers (the view-model's are new functions on every rebuild), so BuyerTableRow's memo holds.
  const vRef = useRef(V);
  useEffect(() => { vRef.current = V; });
  const openRow = useCallback((index: number, b: BuyerRow) => { vRef.current.setBuyerCursor(index); b.open(); }, []);
  const callPhone = useCallback((phone: string) => vRef.current.callPhone(phone), []);
  // The row id the Extend trial dialog is open for, and trial ends moved this
  // session, shown until the next sync carries them.
  const [extending, setExtending] = React.useState<string | null>(null);
  const [trialEnds, setTrialEnds] = React.useState<Record<number, string>>({});
  // A Compr workspace's Buyers holds Compr customers: its own columns, sort
  // and lists (lib/buyer-list-profile, migration 249).
  const compr = V.buyerListProfile === 'compr';
  // On Compr, Suggested and the filter rail stay shut until a rep opens them.
  const [suggestedOpen, setSuggestedOpen] = useRemembered<boolean>('buyers.suggested.compr', false);
  const [railOpen, toggleRail] = useRailOpen('buyers');
  const [filtersOpen, toggleFilters] = useFilterRailOpen(compr ? 'buyers.compr' : 'buyers', !compr);
  const FIELDS = compr ? COMPR_FIELDS : BUYER_FIELDS;
  const KEYS = compr ? COMPR_KEYS : BUYER_KEYS;
  const DEFAULT_COLS = compr ? COMPR_DEFAULT : BUYER_DEFAULT;
  // Kept for the session (lib/screen-memory), like the search in V: the list
  // unmounts while a buyer is open and should come back as it was left.
  const [buyerCols, setBuyerCols] = useRemembered<string[]>('buyers.cols', BUYER_DEFAULT);
  const [comprCols, setComprCols] = useRemembered<string[]>('buyers.cols.compr', COMPR_DEFAULT);
  const cols = compr ? comprCols : buyerCols;
  const setCols = compr ? setComprCols : setBuyerCols;
  const [buyerSort, setBuyerSort] = useRemembered('buyers.sort', BUYER_DEFAULT_SORT);
  const [comprSort, setComprSort] = useRemembered('buyers.sort.compr', { key: 'lastActivity', dir: 'desc' as SortDir });
  const sort = compr ? comprSort : buyerSort;
  const setSort = compr ? setComprSort : setBuyerSort;
  const geniusOnly = V.buyerGeniusOnly;
  const q = V.buyerQ;
  const [qText, setQText] = useDebouncedText(q, (v) => { V.setBuyerQ(v); setSel({}); });
  const list = V.buyerList;
  // Realtors, or Compr's realtor-tag list: a server page with its own pager.
  const paged = list === 'realtors' || !!V.realtorPaged;
  // Smart lists the team saved on Buyers (app/components/buyer/BuyerSmartLists).
  const me = V.liveIds?.userId ?? null;
  const smart = useBuyerSmartLists(V.liveIds?.workspaceId ?? null, me);
  const [openSavedId, setOpenSavedId] = useRemembered<string | null>('buyers.smartList', null);
  const [newListOpen, setNewListOpen] = React.useState(false);
  const askRemove = useRemoveSmartList(smart, (l) => { if (openSavedId === l.id) setOpenSavedId(null); }, V.showToast);
  /** A view's columns. On Compr, a view saved before the Compr columns opens on them anyway. */
  const colsOf = (c: { cols?: unknown; profile?: string } | null | undefined): string[] => {
    if (compr) return c?.profile === 'compr' ? cleanColumns(c.cols, COMPR_KEYS, COMPR_DEFAULT) : COMPR_DEFAULT;
    return c ? cleanColumns(c.cols, BUYER_KEYS, BUYER_DEFAULT) : BUYER_DEFAULT;
  };
  const apply = (c: BuyersConfig | null) => {
    setCols(colsOf(c));
    V.setBuyerGeniusOnly(!!c?.geniusOnly);
    V.setGf({ ...NO_BUYER_FILTERS, ...(c?.filters ?? {}) });
    setOpenSavedId(null);
    setSel({});
  };
  const sv = useSavedViews<BuyersConfig>('buyers', V.liveIds?.workspaceId ?? null, V.liveIds?.userId ?? null, apply, { oncePerSession: true });
  const current: BuyersConfig = { cols, geniusOnly, filters: { buyerState: V.gf.buyerState, buyerCity: V.gf.buyerCity, buyerEntity: V.gf.buyerEntity, buyerType: V.gf.buyerType, buyerStatus: V.gf.buyerStatus, buyerPhone: V.gf.buyerPhone, buyerEmail: V.gf.buyerEmail, buyerOwner: V.gf.buyerOwner ?? 'Any', buyerDeal: V.gf.buyerDeal ?? 'Any', buyerPlan: V.gf.buyerPlan ?? 'Any', buyerTag: V.gf.buyerTag ?? 'Any', buyerRunning: V.gf.buyerRunning ?? 'Any' }, ...(compr ? { profile: 'compr' as const } : {}) };
  const base: BuyersConfig = sv.active?.config ?? { cols: DEFAULT_COLS, geniusOnly: false, filters: NO_BUYER_FILTERS };
  const dirty = !sameList(cols, colsOf(base)) || geniusOnly !== !!base.geniusOnly
    || (Object.keys(NO_BUYER_FILTERS) as (keyof typeof NO_BUYER_FILTERS)[]).some((k) => current.filters[k] !== (base.filters?.[k] ?? 'Any'));
  const shown = useMemo(() => cols.map((k) => FIELDS.find((f) => f.key === k)).filter((f): f is ColumnDef => !!f), [cols, FIELDS]);
  const navRows = V.buyerNavRows || [];
  // Score what is on screen first; realtors are a 127k corpus and are scored only on Refresh.
  // Compr customers are not cash buyers, so they carry no buyer score.
  const autoIds = paged || compr ? [] : navRows.slice(0, 25).map((b) => dbId(b.id));
  const ai = useBuyerScores(V.liveIds?.workspaceId ?? null, autoIds, V.showToast);
  const aiOf = (b: BuyerRow) => ai.scores.get(dbId(b.id));
  const signups = useComprSignups(V.liveIds?.workspaceId ?? null, compr);
  const signupOf = (b: BuyerRow) => {
    const s = signups.get(dbId(b.id));
    const moved = trialEnds[dbId(b.id)];
    return s && moved ? withTrialEnd(s, moved) : s;
  };
  // Sorted once per list, sort or score change, not on every render: at
  // 11,000 buyers a sort on each keystroke elsewhere in the shell was felt.
  const scores = ai.scores;
  // While searching, the best matches (name or company is, or starts with,
  // the query) lead and the chosen sort orders within each tier.
  const ranks = V.buyerSearchRanks;
  // Compr's Plan filter reads the synced signups, so it runs here rather than in useClozr.
  const planPicks = compr ? picksOf(V.gf.buyerPlan) : [];
  // Who is on a running action plan or campaign: the Action plan column and filter.
  const running = useRunningPlans(V.liveIds?.workspaceId ?? null, compr);
  const runningPicks = compr ? picksOf(V.gf.buyerRunning) : [];
  const rows = useMemo(() => {
    const inPlan = (b: BuyerRow) => (!planPicks.length || planPicks.includes(comprPlanBucket(signups.get(dbId(b.id))))) && runningMatch(runningPicks, running.get(dbId(b.id)));
    const keyed = (V.buyerNavRows || []).filter(inPlan).map((b) => ({ b, r: ranks?.get(b.id) ?? 0, v: buyerSortValue(b, sort.key, scores.get(dbId(b.id)), signups.get(dbId(b.id)), compr) }));
    const byDeal = V.gf.buyerDeal && V.gf.buyerDeal !== 'Any';
    keyed.sort((x, y) => (byDeal ? (y.b.dealMatch ?? 0) - (x.b.dealMatch ?? 0) : 0) || x.r - y.r || cmpSort(x.v, y.v, sort.dir));
    return keyed.map((x) => x.b);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- planPicks is a fresh array each render; its value is V.gf.buyerPlan
  }, [V.buyerNavRows, V.gf.buyerDeal, V.gf.buyerPlan, V.gf.buyerRunning, running, compr, ranks, sort.key, sort.dir, scores, signups]);
  // The open buyer's arrows walk this same order (useClozr moveOpenBuyer), so
  // the record steps to the row below it here, and the highlight lands on it.
  useEffect(() => { remember('buyers.order', rows.map((b) => b.id)); }, [rows]);
  // Draw a page of rows and add the next as the scroll nears the end.
  const { shown: revealed, more, sentinel, showMore } = useReveal(rows.length, `${list}|${q}|${geniusOnly}|${sort.key}:${sort.dir}|${JSON.stringify(V.gf)}`, V.buyerCursor);
  const visible = rows.length > revealed ? rows.slice(0, revealed) : rows;
  const moreNote = more ? `Showing ${revealed.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} · scroll for more` : '';
  const sortMenu = (
    <SortMenu
      options={compr ? COMPR_SORT_OPTIONS : BUYER_SORT_OPTIONS}
      value={`${sort.key}:${sort.dir}`}
      resetId={compr ? 'lastActivity:desc' : 'added:desc'}
      pill={V.isMobile}
      onChange={(id) => {
        const [key, dir] = id.split(':');
        setSort({ key, dir: dir === 'asc' ? 'asc' : 'desc' });
      }}
    />
  );
  // One saved list is open while its base list is: picking another list closes it.
  const baseOf = (l: BuyerSmartList) => (l.base && V.buyerListNames.includes(l.base) ? l.base : V.buyerListNames[0]);
  const openSaved = smart.lists.find((l) => l.id === openSavedId && baseOf(l) === list) ?? null;
  const openSavedList = (l: BuyerSmartList) => {
    const filters: Record<string, string> = { ...NO_BUYER_FILTERS };
    for (const k of Object.keys(NO_BUYER_FILTERS)) if (typeof l.filters[k] === 'string') filters[k] = l.filters[k];
    V.setBuyerList(baseOf(l));
    V.setGf(filters as typeof NO_BUYER_FILTERS);
    V.setBuyerGeniusOnly(l.filters.geniusOnly === '1');
    if (l.cols.length) setCols(cleanColumns(l.cols, KEYS, DEFAULT_COLS));
    setOpenSavedId(l.id);
    setSel({});
  };
  const listTitle = openSaved ? openSaved.name : V.buyerListLabel;
  // The checked rows for Ctrl+A, read when the key lands (they are worked out further down).
  const selRef = useRef<string[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const blocked = listNavBlocked({
        typing: isTypingTarget(t),
        dialogOrMenu: !!document.querySelector('[role="dialog"], [role="menu"]'),
        searchOpen: V.searchOpen,
        colsOpen: V.colsOpen,
        filterOpen: !!V.pfOpen,
      });
      if (isArchiveChord(e, blocked)) {
        e.preventDefault();
        const chosen = selRef.current;
        V.askArchive('buyer', chosen.length ? chosen : [rows[V.buyerCursor]?.id ?? '']);
        return;
      }
      const action = buyersNavAction(e, blocked);
      if (!action) {
        if (isOpenKey(e, blocked) && !(t && t.closest('button, a, [role="button"], input, select, textarea'))) {
          const row = rows[V.buyerCursor];
          if (row) { e.preventDefault(); row.open(); }
        }
        return;
      }
      e.preventDefault();
      if (action.type === 'list') V.moveBuyerList(action.dir);
      else V.moveBuyerInList(action.dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [V, rows]);
  useEffect(() => {
    document.querySelector('[data-buyer-focus="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [V.buyerCursor, V.buyerList]);
  // The lists a buyer can sit on, as smart lists: the same rail People has.
  // The phone keeps the pill strip, since it has no room for a rail.
  const RAIL_DOT: Record<string, string> = {
    buyers: '#0A8560', 'compr-customer-prospect': 'var(--c-compr)', 'buyer-prospect': '#b45309',
    'capital-raise-prospect': '#2563eb', realtors: '#0d9488',
    [COMPR_NOT_CONTACTED_LIST]: 'var(--subtle, #a1a1aa)', [COMPR_IN_PLAN_LIST]: '#2563eb', [COMPR_CONTACTED_LIST]: '#0d9488',
    [COMPR_INTERESTED_LIST]: '#0A8560', [COMPR_NOT_INTERESTED_LIST]: 'var(--tx-red, #b91c1c)',
    [COMPR_TRIAL_LIST]: 'var(--c-compr)', [COMPR_PAID_LIST]: 'var(--ink, #18181b)', [COMPR_ALL_LIST]: '#b45309',
  };
  const profile = V.buyerListProfile;
  const listItems: RailItem[] = V.buyerListNames.map((id) => {
    const listed = (V.buyerRows || []).filter((b) => inBuyerList(id, b, profile)).length;
    return {
      id, label: buyerListLabelOf(id, profile) ?? id, on: list === id && !openSaved, dot: RAIL_DOT[id] ?? 'var(--subtle, #a1a1aa)',
      count: id === 'realtors' ? (V.realtorCorpusTotal || listed) : listed,
      title: COMPR_LIST_TITLES[id],
      go: () => { V.setBuyerList(id); setOpenSavedId(null); clearSel(); },
    };
  });
  // A saved list counts only while it is open: its filters are not the ones on now.
  const savedItems = smart.lists.map((l) => ({
    l,
    item: {
      id: 'saved:' + l.id, label: l.name, on: openSaved?.id === l.id, dot: RAIL_DOT[baseOf(l)] ?? 'var(--subtle, #a1a1aa)',
      count: openSaved?.id === l.id ? rows.length : null,
      title: l.mine === false ? `${l.name}, shared by a teammate` : l.name,
      go: () => openSavedList(l),
    } satisfies RailItem,
  }));
  const pill = (on: boolean): React.CSSProperties => ({ flex: 'none', height: '32px', padding: '0 10px', borderRadius: '999px', border: `1px solid ${on ? GREEN : 'var(--c-btn-line)'}`, background: on ? 'var(--c-genius-soft, #f0faf5)' : 'var(--c-btn-bg)', color: on ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontSize: '12px', fontWeight: on ? 650 : 500, cursor: 'pointer', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' });
  const listSwitcher = (
    <span style={{ display: 'inline-flex', gap: '6px', flex: 'none' }}>
      {[...listItems, ...savedItems.map((x) => x.item)].map((item) => (
        <button key={item.id} type="button" className="dc2" onClick={item.go} aria-pressed={item.on} style={pill(item.on)}>
          {item.label}{item.count == null ? '' : ` ${item.count.toLocaleString('en-US')}`}
        </button>
      ))}
      {compr ? null : <button type="button" className="dc2" onClick={() => setNewListOpen(true)} style={{ ...pill(false), display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
        <PlusIcon />
        New list
      </button>}
      {openSaved && openSaved.mine !== false ? (
        <button type="button" className="dc2" onClick={() => void askRemove(openSaved)} style={{ ...pill(false), color: 'var(--tx-red, #b91c1c)' }}>
          Delete list
        </button>
      ) : null}
    </span>
  );
  // Only what is on screen counts as selected, so a filter change cannot act on hidden rows.
  // Realtors picked on the map are the exception: the map is where they were picked.
  const picked = useMemo(() => {
    const m: Record<string, RealtorPick> = {};
    if (list === 'realtors') for (const rs of Object.values(realtorPicks)) for (const r of rs) m['b' + r.dbId] = r;
    return m;
  }, [realtorPicks, list]);
  const listed = rows.filter((b) => sel[b.id]).map((b) => b.id);
  const selectedIds = Object.keys(picked).length ? Array.from(new Set([...listed, ...Object.keys(picked)])) : listed;
  useEffect(() => { selRef.current = selectedIds; });
  const bulk = useMemo(() => (Object.keys(picked).length ? { ...V.buyerBulk, buyers: { ...V.buyerBulk.buyers, ...picked } } : V.buyerBulk), [V.buyerBulk, picked]);
  const clearSel = () => { setSel({}); setRealtorPicks({}); };
  const realValue = (v: string | null | undefined) => (v && v.trim() && v.trim() !== '—' ? v.trim() : null);
  const payPeople = (ids: string[]): PayPerson[] => ids.flatMap((id) => {
    const b = rows.find((r) => r.id === id);
    return b ? [{ id: dbId(b.id), name: b.name, email: realValue(b.email)?.includes('@') ? realValue(b.email) : null, phone: realValue(b.phone), tier: signupOf(b)?.tier ?? null }] : [];
  });
  const canPay = compr && !!V.isLiveData && !!V.liveIds?.canWrite;
  // Compr: paying customers, trials and past-due accounts, so a rep can leave customers off a call list.
  const planValue = V.gf.buyerPlan ?? 'Any';
  const planMenu = {
    key: 'buyerPlan', label: 'Plan', multi: true, on: compr && planValue !== 'Any', value: picksLabel(planValue),
    options: ['Any', ...COMPR_PLAN_FILTERS].map((o) => ({
      label: o, on: isPicked(planValue, o), go: () => { V.setGf({ buyerPlan: togglePick(planValue, o) }); setSel({}); },
    })),
  };
  const runningValue = V.gf.buyerRunning ?? 'Any';
  const runningNames = useMemo(() => [...new Set([...running.values()].flat())].sort(), [running]);
  const runningMenu = {
    key: 'buyerRunning', label: 'Action plan', multi: true, on: compr && runningValue !== 'Any', value: picksLabel(runningValue),
    options: ['Any', NOT_ON_A_PLAN, ON_A_PLAN, ...runningNames].map((o) => ({
      label: o, on: isPicked(runningValue, o), go: () => { V.setGf({ buyerRunning: togglePick(runningValue, o) }); setSel({}); },
    })),
  };
  const buyerFilterMenus = compr ? [planMenu, runningMenu, ...(V.buyerMenus || [])] : (V.buyerMenus || []);
  // Each menu's own "Any" is its reset, so realtors' server-side state and city clear the same way.
  const buyerDateOn = (V.gf.buyerAdded ?? 'Any') !== 'Any';
  const resetBuyerFilters = () => {
    for (const m of buyerFilterMenus) if (m.on) m.options.find((o) => o.label === 'Any')?.go();
    V.setGf({ buyerAdded: 'Any', buyerAddedFrom: 'Any', buyerAddedTo: 'Any' });
    setSel({});
  };
  // Every filter, always on screen in the rail beside the table; a sheet on a phone.
  const buyerFilterExtras = [{
    title: 'Dates',
    node: <DateRangeFields when={V.gf.buyerAdded} from={V.gf.buyerAddedFrom} to={V.gf.buyerAddedTo}
      onChange={(patch) => V.setGf({ buyerAdded: patch.when, ...(patch.from != null ? { buyerAddedFrom: patch.from } : {}), ...(patch.to != null ? { buyerAddedTo: patch.to } : {}) })} />,
  }];
  const buyerChips = [
    ...chipsFromMenus(buyerFilterMenus),
    ...(buyerDateOn ? [{ key: 'buyerAdded', label: 'Added', value: String(V.gf.buyerAdded), clear: () => V.setGf({ buyerAdded: 'Any', buyerAddedFrom: 'Any', buyerAddedTo: 'Any' }) }] : []),
  ];
  const buyerFilters = (
    <FilterSheet pill menus={buyerFilterMenus} groups={BUYER_FILTER_GROUPS} extras={buyerFilterExtras} active={buyerChips.length}
      onClearAll={resetBuyerFilters} storageKey="buyers"
      showLabel={`Show ${rows.length.toLocaleString('en-US')} ${paged ? 'realtors' : compr ? 'contacts' : 'buyers'}`} />
  );
  const viewSwitch = <ListMapSwitch value={mode} onChange={setMode} pill={V.isMobile} />;
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  // Refresh re-scores the selection, or the first 25 on screen when nothing is selected.
  // Realtors picked on the map are not scored: a lasso can take thousands, and each score is an AI read.
  const rescoreIds = (listed.length ? listed : rows.slice(0, 25).map((b) => b.id)).map(dbId);
  const rescoreLabel = ai.progress ? `Scoring ${ai.progress.done} of ${ai.progress.total}…` : listed.length ? `Refresh ${listed.length} score${listed.length === 1 ? '' : 's'}` : 'Refresh scores';
  const rescoreTitle = 'Re-read texts, emails, calls, offers and closings and score again with AI';
  const toggleAll = () => setSel(allSelected ? {} : Object.fromEntries(rows.map((b) => [b.id, true])));
  // A new smart list keeps the list, filters and columns on screen now.
  const baseLabel = buyerListLabelOf(list, profile) ?? V.buyerListLabel;
  const filterWords = buyerFilterMenus.filter((m) => m.on).map((m) => ({ label: m.label, value: String(m.value ?? '') }));
  const keeps = [baseLabel, ...filterWords.map((f) => `${f.label}: ${f.value}`), ...(geniusOnly ? ['Discovered only'] : [])].join(' · ')
    + `, and the ${cols.length} columns on screen`;
  const suggestedName = (filterWords.length ? filterWords.map((f) => f.value).join(', ') : `${baseLabel} ${smart.lists.length + 1}`).slice(0, 80);
  const saveList = async (name: string, shared: boolean) => {
    const made = await smart.create({ name, filters: { ...current.filters, geniusOnly: geniusOnly ? '1' : '' }, cols, access: shared || !me ? [] : [me], base: list });
    if (!made) return false;
    setOpenSavedId(made.id);
    setNewListOpen(false);
    V.showToast(`Saved "${made.name}"`, 'success');
    return true;
  };
  const emptyTitle = paged && V.realtorLoading ? 'Loading realtors…'
    : q.trim() ? `No ${compr ? 'contacts' : 'buyers'} match “${q.trim()}”`
      : openSaved ? `No one matches ${openSaved.name}`
        : geniusOnly ? 'No discovered buyers'
          : !V.crmOk ? ''
            : list === COMPR_TRIAL_LIST ? 'No Compr trial users yet'
              : list === COMPR_PAID_LIST ? 'No paying Compr customers yet'
              : list === COMPR_ALL_LIST ? 'No contacts yet'
              : compr ? `No one in ${listTitle} right now`
                : list === 'buyers' ? 'No buyers yet' : list === 'realtors' ? 'No realtors in this workspace' : `No one in ${listTitle} yet`;
  const emptyHint = paged ? 'Search name, phone, email, company, or market. The list pages through the imported agents.'
    : q.trim() ? 'Search looks at name, company, phone, email, type, status, markets and tags.'
      : openSaved ? 'Its filters match nobody right now. Reset the filters, or delete the list from the rail.'
        : list === COMPR_TRIAL_LIST ? 'Every new Compr free trial signup lands here within 15 minutes, with their plan, market and last activity.'
          : list === COMPR_PAID_LIST ? 'Every paying Compr customer lands here within 15 minutes, with what they have paid and every address they ran.'
          : compr && list !== COMPR_ALL_LIST ? COMPR_LIST_TITLES[list] ?? ''
          : compr ? 'Import Compr customers or add one by hand.'
            : list === 'buyers' ? 'Vetted buyers live here. Imported finds and Facebook comments wait in Buyer Prospects until you vet them.' : 'Imported finds and Facebook group comments file here. Vet someone to move them onto Buyers.';
  const addLabel = compr ? 'Contact' : 'Buyer';
  return (
    <section data-screen-label="Buyers" style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "row"}}>
      {!V.isMobile && railOpen ? (
        <aside className="cz-rail" aria-label="Buyer lists">
          <div className="cz-rail-head">
            <span className="cz-rail-title">Smart lists</span>
            <RailToggle open onToggle={toggleRail} />
          </div>
          {listItems.map((item) => <RailRow key={item.id} item={item} />)}
          {/* Compr too: the stage buckets above, then the team's lists by tag (one per avatar). */}
          <>
          <div className="cz-rail-group">
            <span className="cz-rail-title">Saved lists</span>
            <button type="button" className="dc2 cz-rail-toggle" onClick={() => setNewListOpen(true)} aria-label="New smart list from the filters on now" title="New smart list from the filters on now">
              <PlusIcon />
            </button>
          </div>
          {savedItems.map(({ l, item }) => <SavedRailRow key={item.id} item={item} list={l} onRemove={(x) => void askRemove(x)} />)}
          {!savedItems.length ? <p style={{ margin: '2px 8px 0', fontSize: '11.5px', color: MUTED, lineHeight: 1.5 }}>Set the filters you want, then save them here as a list.</p> : null}
          </>
          <div className="cz-rail-note">
            {compr
              ? 'Everyone sits on one list, and moves on their own: a text, email or call makes them Contacted, a reply that says no makes them Not interested and takes them off every plan, and Compr fills Free trial and Paid users every 15 minutes.'
              : 'Prospects wait here until you vet them; a vetted buyer moves onto Buyers.'}
          </div>
        </aside>
      ) : null}
      {!V.isMobile && filtersOpen ? (
        <FilterRail menus={buyerFilterMenus} groups={BUYER_FILTER_GROUPS} extras={buyerFilterExtras} active={buyerChips.length}
          onClearAll={resetBuyerFilters} onHide={toggleFilters} storageKey="buyers" />
      ) : null}
      <NewSmartListDialog open={newListOpen} suggested={suggestedName} keeps={keeps} onSave={saveList} onClose={() => setNewListOpen(false)} />
      <div style={{flex: "1", minWidth: "0", display: "flex", flexDirection: "column"}}>
      {(V.isMobile) ? (
        <>
        {/* The desktop head puts eight controls on one row. On a phone that
            wrapped into three stacked rows and ate half the screen, so the
            phone gets a title line, a full-width search, and a single
            sideways-scrolling control strip. */}
        <div style={{flex: "none", background: "var(--surface, #fff)", borderBottom: `1px solid ${LINE}`, padding: "10px 0 10px 16px"}}>
          <div style={{display: "flex", alignItems: "baseline", gap: "8px", paddingRight: "16px", minWidth: "0"}}>
            <h1 className="ds-title" style={{flex: "none"}}>
              {listTitle}
            </h1>
            <span style={{fontSize: "12.5px", color: MUTED, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
              {paged ? `${rows.length} of ${V.realtorMatchTotal.toLocaleString('en-US')}` : `${rows.length} showing · ${V.buyerTotal} in database`}
            </span>
          </div>
          <input type="search" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Search name, company, market…" aria-label={compr ? 'Search contacts' : 'Search buyers'} style={{height: "38px", width: "calc(100% - 12px)", marginTop: "9px", borderRadius: "9px", border: `1px solid ${LINE}`, padding: "0 11px", fontSize: "16px", background: "var(--canvas, #fafafa)", color: INK, minWidth: "0"}} />
          <div data-tabs data-tray style={{display: "flex", gap: "6px", overflowX: "auto", marginTop: "9px", paddingRight: "12px", paddingBottom: "2px"}}>
            {viewSwitch}
            {listSwitcher}
            <button className="clozr-genius-btn" onClick={V.addBuyer} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: "1px solid var(--c-genius)", background: "var(--c-genius)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap"}}>
              + {addLabel}
            </button>
            <ViewMenu sv={sv} current={current} dirty={dirty} onApply={apply} onToast={V.showToast} pill align="left" />
            {sortMenu}
            {buyerFilters}
            <ContractsButton V={V} pill />
            {V.can.import ? (
            <button className="dc2" onClick={() => V.openImport('buyers')} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: INK, fontSize: "12.5px", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap"}}>
              Import
            </button>
            ) : null}
            {compr ? null : <>
            <button className="dc2" onClick={() => { V.setBuyerGeniusOnly(!geniusOnly); setSel({}); }} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: `1px solid ${geniusOnly ? GREEN : 'var(--c-btn-line)'}`, background: geniusOnly ? 'var(--c-genius-soft, #f0faf5)' : 'var(--c-btn-bg)', color: geniusOnly ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontSize: "12.5px", fontWeight: geniusOnly ? "600" : "500", cursor: "pointer", whiteSpace: "nowrap"}}>
              Discovered
            </button>
            <button className="dc2" disabled={!!ai.progress || !rows.length} onClick={() => ai.refresh(rescoreIds)} title={rescoreTitle} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: "1px solid var(--c-btn-line)", background: "var(--c-btn-bg)", color: INK, fontSize: "12.5px", fontWeight: "500", cursor: "pointer", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums"}}>
              {rescoreLabel}
            </button>
            </>}
            {compr ? (
            <button className="dc2" onClick={() => setSuggestedOpen(!suggestedOpen)} aria-pressed={suggestedOpen} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: `1px solid ${suggestedOpen ? GREEN : 'var(--c-btn-line)'}`, background: suggestedOpen ? 'var(--c-genius-soft, #f0faf5)' : 'var(--c-btn-bg)', color: suggestedOpen ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontSize: "12.5px", fontWeight: suggestedOpen ? "600" : "500", cursor: "pointer", whiteSpace: "nowrap"}}>
              Suggested
            </button>
            ) : null}
            <button className="dc2" onClick={() => setAutomations(!automations)} style={{flex: "none", height: "34px", padding: "0 13px", borderRadius: "999px", border: `1px solid ${automations ? GREEN : 'var(--c-btn-line)'}`, background: automations ? 'var(--c-genius-soft, #f0faf5)' : 'var(--c-btn-bg)', color: automations ? 'var(--tx-mint-deep, #08694c)' : 'var(--ink-2, #27272a)', fontSize: "12.5px", fontWeight: automations ? "600" : "500", cursor: "pointer", whiteSpace: "nowrap"}}>
              Automations
            </button>
            {(V.buyerMenus || []).map((f, f__i) => (
              <React.Fragment key={f__i}>
              <div style={{position: "relative", flex: "none"}}>
                <button className="dc2 cz-menu-trigger" onClick={f.toggle} style={{height: "32px", padding: "0 12px", borderRadius: "16px", border: 0, background: f.on ? CZ.mintSoft : CZ.tray, fontSize: "12.5px", cursor: "pointer", color: f.on ? CZ.mint : CZ.ink, fontWeight: f.on ? "600" : "500", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px", fontFamily: "var(--font-sans)"}}>
                  {f.on ? f.value : f.label}
                  <Chevron size={11} color={f.on ? CZ.mint : CZ.faint} />
                </button>
                {/* The control strip scrolls sideways and would clip an anchored popover, so the phone gets a fixed one. */}
                {f.open && SEARCHABLE.has(f.key) ? (
                  <ComboPopover touch multi={'multi' in f && !!f.multi} label={f.label} options={f.options} onClose={V.closeFilterMenus} style={{position: "fixed", top: "150px", left: "12px", right: "12px", maxHeight: "min(420px, 60vh)", background: "var(--c-menu-bg)", border: `1px solid ${LINE}`, borderRadius: "12px", boxShadow: "0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)"}} />
                ) : (f.open) ? (
                  <>
                  <div onClick={V.closeFilterMenus} style={{position: "fixed", inset: "0", zIndex: "44"}}></div>
                  <div ref={keepInView} style={{position: "absolute", top: "40px", left: "0", minWidth: "190px", maxWidth: "calc(100vw - 28px)", maxHeight: "min(340px, 46vh)", overflow: "auto", background: "var(--c-menu-bg)", border: `1px solid ${LINE}`, borderRadius: "12px", boxShadow: "0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)", zIndex: "45", padding: "4px"}}>
                    {(f.options || []).map((o, o__i) => (
                      <React.Fragment key={o__i}>
                      <button type="button" className={"dc2 cz-menu-item" + (o.on ? " is-on" : "")} onClick={o.go}>
                        <PickLabel multi={'multi' in f && !!f.multi} on={o.on} label={o.label} />
                        <MenuCheck on={!!o.on && !('multi' in f && f.multi && o.label !== 'Any')} />
                      </button>
                      </React.Fragment>
                    ))}
                  </div>
                  </>
                ) : null}
              </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        </>
      ) : null}
      {/* Two rows, like People: the list, its count and the actions that make
          something on one; everything that narrows or arranges the table on
          the next, left-aligned. One wrapping row used to scatter fourteen
          controls across two ragged lines. */}
      {V.isMobile ? null : <ScreenHeader style={{position: "relative", zIndex: 3}}
        before={!railOpen ? <RailToggle open={false} onToggle={toggleRail} /> : null}
        title={listTitle}
        meta={paged ? `${rows.length.toLocaleString('en-US')} of ${V.realtorMatchTotal.toLocaleString('en-US')}` : `${rows.length.toLocaleString('en-US')} showing · ${V.buyerTotal} in database`}
        actions={<>
        <label style={{display: "flex", alignItems: "center", gap: "8px", height: "32px", padding: "0 10px", border: `1px solid ${LINE}`, borderRadius: "8px", background: "var(--canvas, #fafafa)", width: "min(300px, 28vw)", minWidth: "160px"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input type="search" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Search name, company, phone, market, tag" aria-label={compr ? 'Search contacts' : 'Search buyers'} style={{border: "0", background: "none", outline: "0", fontSize: "13px", width: "100%", minWidth: 0, color: INK}} />
        </label>
        <ContractsButton V={V} />
        {V.can.import ? (
        <button className="cz-btn" onClick={() => V.openImport('buyers')} title="Bulk import buyers from a CSV or a paste">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          Import
        </button>
        ) : null}
        <button className="clozr-genius-btn" onClick={V.addBuyer} style={{height: "32px", padding: "0 12px", borderRadius: "8px", border: "1px solid var(--c-genius)", background: "var(--c-genius)", color: "#fff", fontSize: "12.5px", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "6px"}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          {addLabel}
        </button>
        </>}>
      <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
        {viewSwitch}
        <ViewMenu sv={sv} current={current} dirty={dirty} onApply={apply} onToast={V.showToast} />
        <ColumnPicker all={FIELDS} value={cols} onChange={setCols} defaults={DEFAULT_COLS} title={compr ? 'Fields in the contacts table' : 'Fields in the buyers table'} />
        {sortMenu}
        {!filtersOpen ? (
          <>
            <span aria-hidden style={{width: "1px", height: "20px", background: LINE, margin: "0 2px"}}></span>
            <FilterRailShow active={buyerChips.length} onShow={toggleFilters} />
          </>
        ) : null}
        {/* The rail has its own New button; with the rail folded away, this is the way in. */}
        {!railOpen && !compr ? (
          <button className="dc2" onClick={() => setNewListOpen(true)} title="Save the list and filters on now as a smart list" style={{...toggleStyle(false), display: "inline-flex", alignItems: "center", gap: "5px"}}>
            <PlusIcon />
            Save as list
          </button>
        ) : null}
        {compr ? null : (
          <button className="dc2" onClick={() => { V.setBuyerGeniusOnly(!geniusOnly); setSel({}); }} aria-pressed={geniusOnly} title="Buyers from discovery imports" style={toggleStyle(geniusOnly)}>
            Discovered only
          </button>
        )}
        <div style={{flex: "1"}}></div>
        {compr ? null : <>
        <button className="dc2" disabled={!!ai.progress || !rows.length} onClick={() => ai.refresh(rescoreIds)} title={rescoreTitle} style={{...toggleStyle(false), cursor: ai.progress ? "progress" : "pointer", fontVariantNumeric: "tabular-nums"}}>
          {rescoreLabel}
        </button>
        </>}
        {compr ? (
          <button className="dc2" onClick={() => setSuggestedOpen(!suggestedOpen)} aria-pressed={suggestedOpen} title="Campaigns for Compr users who need one: payment issues, upsell, activate, revive" style={toggleStyle(suggestedOpen)}>
            Suggested
          </button>
        ) : null}
        <button className="dc2" onClick={() => setAutomations(!automations)} aria-pressed={automations} title={compr ? 'What runs on its own for Compr contacts: lifecycle email and text, billing call tasks, cold prospects' : 'Tag buyers from trigger events'} style={toggleStyle(automations)}>
          Automations
        </button>
      </div>
      {buyerChips.length ? (
        <div style={{display: "flex", alignItems: "center", gap: "8px", paddingTop: "8px", flexWrap: "wrap"}}>
          <ActiveFilters chips={buyerChips} onClearAll={resetBuyerFilters} />
        </div>
      ) : null}
      </ScreenHeader>}
      {compr && suggestedOpen && mode !== 'map' ? (
        <div style={{ flex: 'none', maxHeight: V.isMobile ? '62vh' : '48vh', overflowY: 'auto' }}>
          <ComprSuggested workspaceId={V.liveIds?.workspaceId ?? null} userId={V.liveIds?.userId ?? null} userName={V.meName || ''}
            canWrite={!!V.liveIds?.canWrite} compact={V.isMobile} onToast={V.showToast} onClose={() => setSuggestedOpen(false)}
            onOpenBuyer={V.openBuyerById} onOpenPlan={(id) => V.openPlan(id, 'buyers')} />
        </div>
      ) : null}
      {automations && compr ? (
        <div style={{ flex: 'none', maxHeight: V.isMobile ? '62vh' : '48vh', overflowY: 'auto' }}>
          <ComprAutomations workspaceId={V.liveIds?.workspaceId ?? null} onClose={() => setAutomations(false)}
            onSuggested={mode !== 'map' ? () => { setAutomations(false); setSuggestedOpen(true); } : undefined} />
        </div>
      ) : automations ? <BuyerAutomations workspaceId={V.liveIds?.workspaceId ?? null} canWrite={!!V.liveIds?.canWrite} onToast={V.showToast} onChanged={V.reloadCrm} onClose={() => setAutomations(false)} /> : null}
      {selectedIds.length ? <BuyerBulkBar bulk={bulk} selectedIds={selectedIds} onClear={clearSel} compact={V.isMobile} compr={compr}
        onGoCampaigns={V.goCampaigns}
        onPaymentLink={canPay ? () => openPay(selectedIds) : undefined}
        list={rows} onSelect={(ids) => setSel(Object.fromEntries(ids.map((id) => [id, true])))} /> : null}
      {mode === 'map' ? (
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <BuyerMap V={V} list={list} rows={rows} height="100%" sel={sel} setSel={setSel} picks={realtorPicks} setPicks={setRealtorPicks} aiOf={aiOf} onList={() => setMode('list')} />
          </div>
        </div>
      ) : (V.isMobile) ? (
        <>
        {/* The table is 1100px wide by design. On a phone that put everything
            from MARKETS rightwards off the screen, so the phone gets a card
            carrying the same facts stacked. */}
        <div style={{flex: "1", overflow: "auto", background: "var(--canvas, #fafafa)", padding: "10px 12px calc(96px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: "8px"}}>
          {visible.map((b, b__i) => {
            const focused = b__i === V.buyerCursor;
            return (
            <React.Fragment key={b.id}>
            <div data-buyer-focus={focused || undefined} onClick={() => { V.setBuyerCursor(b__i); b.open(); }} onDoubleClick={b.open} style={{background: sel[b.id] || focused ? "var(--c-genius-soft, #f0faf5)" : "var(--surface, #fff)", border: `1px solid ${sel[b.id] || focused ? GREEN : LINE}`, borderRadius: "12px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px", cursor: "pointer", minWidth: "0", outline: focused ? `2px solid ${GREEN}` : undefined, outlineOffset: focused ? '-2px' : undefined, flexShrink: 0, contentVisibility: "auto", containIntrinsicHeight: "auto 224px"}}>
              <div style={{display: "flex", alignItems: "center", gap: "10px", minWidth: "0"}}>
                <input type="checkbox" aria-label={'Select ' + b.company} checked={!!sel[b.id]} onClick={(e) => e.stopPropagation()} onChange={() => setSel((x) => ({ ...x, [b.id]: !x[b.id] }))} style={{width: "18px", height: "18px", flex: "none", accentColor: GREEN, cursor: "pointer"}} />
                {compr ? null : <ScoreRing b={b} ai={aiOf(b)} size={38} />}
                <span style={{flex: "1", minWidth: "0"}}>
                  <span style={{display: "block", fontWeight: "600", fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {compr ? b.name : b.company}
                  </span>
                  <span style={{display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: MUTED, minWidth: 0}}>
                    <span style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0}}>{compr ? (b.company !== b.name ? b.company : b.type) : b.name}{!compr && foundHow(b) ? ` · ${foundHow(b)}` : ''}</span>
                    {aiOf(b)?.source === 'ai' ? <span style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--tx-mint-deep, #08694c)', background: 'var(--c-action-soft, #e7f5ef)', borderRadius: 6, padding: '0 4px' }}>AI</span> : null}
                  </span>
                </span>
                <span style={{flex: "none"}}>
                  {compr && signupOf(b) ? <ComprStatusChip s={signupOf(b)!} /> : <StatusChip label={b.status} color={b.statusColor} />}
                  {!compr && responseOf(b, aiOf(b)).tireKicker ? <TireChip /> : null}
                </span>
              </div>
              {compr ? (
              <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 10px", minWidth: "0", paddingTop: "1px"}}>
                <Fact label="Phone" value={b.phone} />
                <Fact label="Email" value={b.email} />
                <Fact label="Market" value={b.markets} />
                <Fact label="Type" value={b.type} />
                <Fact label="Last activity" value={b.lastActivity} />
                <Fact label="Plan" value={signupOf(b) ? `${planLabel(signupOf(b)!.tier)}, since ${shortDate(signupOf(b)!.signed_up_at)}` : ''} />
                {signupOf(b)?.trial === 'stripe' && signupOf(b)?.trial_ends_at ? <Fact label="Trial ends" value={shortDate(signupOf(b)!.trial_ends_at)} /> : null}
              </div>
              ) : (
              <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 10px", minWidth: "0", paddingTop: "1px"}}>
                <Fact label="Markets" value={b.markets} />
                <Fact label="Entity" value={b.entity} />
                <Fact label="Type" value={b.type} />
                <Fact label="Price" value={b.price} />
                <Fact label="Exit" value={b.exit} />
                <Fact label="Response" value={<Engagement score={responseOf(b, aiOf(b)).pct} color={responseOf(b, aiOf(b)).color} title={responseOf(b, aiOf(b)).title} />} />
                <Fact label="Last activity" value={b.lastActivity} />
                <Fact label="Date added" value={b.added} />
              </div>
              )}
              {canPay && canExtendTrial(signupOf(b)) ? (
                <div onClick={(e) => e.stopPropagation()} style={{display: "flex", paddingTop: "2px"}}>
                  <ExtendTrialButton onClick={() => setExtending(b.id)} />
                </div>
              ) : canPay && signupOf(b) && !alreadyPaid(signupOf(b)!.tier) ? (
                <div onClick={(e) => e.stopPropagation()} style={{display: "flex", paddingTop: "2px"}}>
                  <TrialLinkButton onClick={() => openPay([b.id], TRIAL_DEFAULT_DAYS)} />
                </div>
              ) : null}
            </div>
            </React.Fragment>
            );
          })}
          {more ? (
            <button type="button" ref={sentinel} onClick={showMore} className="dc2" style={{flex: "none", height: "40px", borderRadius: "10px", border: `1px dashed ${LINE}`, background: "var(--surface, #fff)", color: MUTED, fontSize: "12.5px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
              {moreNote}
            </button>
          ) : null}
          {rows.length === 0 ? (
            <Empty
              title={emptyTitle}
              hint={emptyHint}
              failed={!V.crmOk}
              onRetry={V.reloadCrm}
              action={paged ? undefined : V.addBuyer}
              actionLabel={compr ? 'Add a contact' : 'Add a buyer'}
            />
          ) : null}
        </div>
        </>
      ) : (
      <div className="clozr-scroll-well" style={{flex: "1", overflow: "auto", background: "var(--surface, #fff)"}}>
        <table style={{width: "100%", borderCollapse: "separate", borderSpacing: "0", fontSize: "12.5px", minWidth: `${Math.max(720, shown.length * 112)}px`}}>
          <thead>
            <tr>
              <th style={{position: "sticky", top: "0", zIndex: 1, background: "var(--c-thead)", borderBottom: `1px solid ${LINE}`, padding: "0 14px", height: "38px", width: "40px"}}>
                <input type="checkbox" aria-label="Select all buyers" onChange={toggleAll} checked={allSelected} style={{width: "14px", height: "14px", accentColor: GREEN, cursor: "pointer"}} />
              </th>
              {shown.map((c) => {
                const active = sort.key === c.key;
                return (
                <th key={c.key} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: `1px solid ${LINE}`, padding: "0 14px", height: "38px", textAlign: "left", fontSize: "12px", fontWeight: active ? "600" : "500", color: active ? GREEN : MUTED, whiteSpace: "nowrap"}}>
                  <button type="button" onClick={() => setSort((cur) => toggleSort(cur, c.key, c.key === 'added' || c.key === 'engagement' ? 'desc' : 'asc'))} style={{background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", fontWeight: "inherit"}}>
                    {c.label}{active ? (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden style={{marginLeft: 3, verticalAlign: "-2px"}} /> : <ArrowDown size={12} aria-hidden style={{marginLeft: 3, verticalAlign: "-2px"}} />) : null}
                  </button>
                </th>
                );
              })}
              {canPay ? <th style={{position: "sticky", top: "0", background: "var(--c-thead)", borderBottom: `1px solid ${LINE}`, padding: "0 10px", height: "38px", width: "80px"}}><span style={{position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)"}}>Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((b, b__i) => (
              <BuyerTableRow key={b.id} b={b} index={b__i} focused={b__i === V.buyerCursor} selected={!!sel[b.id]} shown={shown} compr={compr} canPay={canPay}
                ai={aiOf(b)} signup={signupOf(b)} running={compr ? running.get(dbId(b.id)) : undefined} onOpen={openRow} onToggle={toggleSel} callPhone={callPhone} onExtend={setExtending} onPay={openPay} />
            ))}
              {more ? (
                <tr ref={sentinel}>
                  <td colSpan={shown.length + 1 + (canPay ? 1 : 0)} style={{padding: "0"}}>
                    <button type="button" onClick={showMore} className="dc2" style={{width: "100%", height: "40px", border: 0, background: "var(--canvas, #fafafa)", color: MUTED, fontSize: "12px", cursor: "pointer", fontVariantNumeric: "tabular-nums"}}>
                      {moreNote}
                    </button>
                  </td>
                </tr>
              ) : null}
              {rows.length === 0 ? (
                <EmptyRow
                  colSpan={shown.length + 1 + (canPay ? 1 : 0)}
                  title={emptyTitle}
                  hint={emptyHint}
                  failed={!V.crmOk}
                  onRetry={V.reloadCrm}
                  action={paged ? undefined : V.addBuyer}
                  actionLabel={compr ? 'Add a contact' : 'Add a buyer'}
                />
              ) : null}
          </tbody>
        </table>
      </div>
      )}
      <div style={{ flex: 'none', display: mode === 'map' && V.isMobile ? 'none' : 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 16px', borderTop: `1px solid ${LINE}`, background: 'var(--surface, #fff)' }}>
        {paged && mode !== 'map' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: MUTED }}>
            <button type="button" className="dc2" disabled={V.realtorOffset <= 0 || V.realtorLoading} onClick={V.realtorPrev} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: INK, fontSize: '12px', cursor: V.realtorOffset <= 0 ? 'default' : 'pointer', opacity: V.realtorOffset <= 0 ? 0.45 : 1 }}>Previous</button>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{V.realtorMatchTotal ? `${(V.realtorOffset + 1).toLocaleString('en-US')}–${Math.min(V.realtorOffset + rows.length, V.realtorMatchTotal).toLocaleString('en-US')} of ${V.realtorMatchTotal.toLocaleString('en-US')}` : '—'}</span>
            <button type="button" className="dc2" disabled={V.realtorLoading || V.realtorOffset + V.realtorPageSize >= V.realtorMatchTotal} onClick={V.realtorNext} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: INK, fontSize: '12px', cursor: V.realtorOffset + V.realtorPageSize >= V.realtorMatchTotal ? 'default' : 'pointer', opacity: V.realtorOffset + V.realtorPageSize >= V.realtorMatchTotal ? 0.45 : 1 }}>Next</button>
          </span>
        ) : <span />}
        <BlacklistButton
          count={selectedIds.length}
          names={rows.filter((b) => selectedIds.includes(b.id)).map((b) => b.name)}
          onConfirm={(reason) => { V.blacklistBuyers(selectedIds, reason); clearSel(); }}
        />
      </div>
      </div>
      {paying ? (
        <PaymentLinkDialog workspaceId={V.liveIds?.workspaceId ?? null} people={payPeople(paying)} isMobile={!!V.isMobile} onSent={V.reloadCrm} initialTrial={payTrial}
          onClose={() => { if (paying.length > 1) clearSel(); setPaying(null); }} />
      ) : null}
      {extending ? (() => {
        const b = rows.find((r) => r.id === extending);
        const s = b ? signupOf(b) : undefined;
        return b && s ? (
          <ExtendTrialDialog workspaceId={V.liveIds?.workspaceId ?? null} buyerId={dbId(b.id)} name={b.name} trialEndsAt={s.trial_ends_at} isMobile={!!V.isMobile}
            onClose={() => setExtending(null)}
            onExtended={(end) => { setTrialEnds((m) => ({ ...m, [dbId(b.id)]: end })); V.reloadCrm(); }} />
        ) : null;
      })() : null}
    </section>
  );
}
