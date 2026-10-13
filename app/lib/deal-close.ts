// The contract-to-close rules from the Acme Homes TC SOP, as plain functions.
//
// One copy for every screen that sets a close date (the deal sheet, a new
// deal, the TC file, the board) and for the TC file's blockers, so "no
// Friday closings" or "contract out in 10 minutes" means the same thing on
// each. Nothing here reads the database.

/** 'YYYY-MM-DD' for a moment, in the browser's own time zone (not UTC: 8pm in Dallas is still today). */
export function localIsoDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `iso` plus `n` calendar days, as 'YYYY-MM-DD'. Counted at noon so a daylight-saving change never moves the day. */
export function plusIsoDays(iso: string, n: number): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localIsoDay(d);
}

/** `iso` plus `n` business days (Monday to Friday; holidays are not known here). */
export function plusBusinessDays(iso: string, n: number): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return localIsoDay(d);
}

/** True when a 'YYYY-MM-DD' date falls on a Friday. Blank or unreadable is false. */
export function isFridayIso(iso: string | null | undefined): boolean {
  const t = (iso ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(t + 'T12:00:00');
  return !Number.isNaN(d.getTime()) && d.getDay() === 5;
}

/** The warning a Friday close date carries, or null for any other day. */
export function fridayCloseWarning(iso: string | null | undefined): string | null {
  if (!isFridayIso(iso)) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return `${label} is a Friday. Acme Homes closes Monday to Thursday: a Friday wire can sit over the weekend.`;
}

/** The override prompt for a Friday close, for confirmReason(). */
export function fridayOverrideAsk(iso: string) {
  return {
    title: 'Close on a Friday?',
    body: (fridayCloseWarning(iso) ?? '') + ' If it has to be Friday, buyer and seller sign Thursday, the buyer wires Thursday and title confirms the wire.',
    reasonLabel: 'Why this deal has to close on a Friday',
    confirmLabel: 'Keep Friday',
    tone: 'danger' as const,
  };
}

/** The activity line an override leaves on the deal. */
export const fridayOverrideNote = (iso: string, reason: string, where: string) =>
  `Friday close ${iso} kept (${where}). Reason: ${reason}`;

/** The SOP's cap from a deal being created to its contract going out. */
export const CONTRACT_SLA_MINUTES = 10;

export type ContractSla = { minutes: number | null; late: boolean; waiting: boolean; label: string };

/**
 * Deal created → contract sent, against the 10-minute rule. `sentAt` null is
 * a contract not sent yet: late once 10 minutes have passed since `createdAt`.
 */
export function contractSla(createdAt: string | null | undefined, sentAt: string | null | undefined, now: Date = new Date()): ContractSla | null {
  const c = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(c)) return null;
  const s = sentAt ? Date.parse(sentAt) : NaN;
  const end = Number.isFinite(s) ? s : now.getTime();
  const minutes = Math.max(0, Math.round((end - c) / 60_000));
  const late = minutes > CONTRACT_SLA_MINUTES;
  const waiting = !Number.isFinite(s);
  const span = minutes < 120 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  const label = waiting
    ? (late ? `Contract not sent, ${span} since the deal was created (cap ${CONTRACT_SLA_MINUTES} min)` : `Contract due out within ${CONTRACT_SLA_MINUTES - minutes} min`)
    : (late ? `Contract went out ${span} after the deal was created (cap ${CONTRACT_SLA_MINUTES} min)` : `Contract went out in ${span}`);
  return { minutes, late, waiting, label };
}

export type TitleRoute =
  | { kind: 'vendor'; company: string; contact: string; why: string }
  | { kind: 'decide'; who: string; why: string };

/**
 * Who opens title, by the property's state. This is an example routing table:
 * edit TITLE_ROUTING to match your own title companies. A state in `byState`
 * goes to that company; a state in `decide` is flagged for the TC to pick and
 * nothing is preselected; everywhere else goes to `fallback`.
 */
export const TITLE_ROUTING: {
  byState: Record<string, { company: string; contact: string; stateName: string }>;
  decide: { states: string[]; who: string };
  fallback: { company: string; contact: string };
} = {
  byState: { TX: { company: 'Northvale Title', contact: 'Dana Fields', stateName: 'TEXAS' } },
  decide: { states: ['NY', 'OR', 'NEW YORK', 'OREGON'], who: 'TC' },
  fallback: { company: 'Summit Title', contact: 'Pat Morgan' },
};

export function titleRoute(state: string | null | undefined): TitleRoute {
  const st = (state ?? '').trim().toUpperCase();
  const hit = Object.entries(TITLE_ROUTING.byState).find(([code, r]) => st === code || st === r.stateName);
  if (hit) {
    const [code, r] = hit;
    return { kind: 'vendor', company: r.company, contact: r.contact, why: `${code} files go to ${r.company}` };
  }
  if (TITLE_ROUTING.decide.states.includes(st)) return { kind: 'decide', who: TITLE_ROUTING.decide.who, why: `${st.length === 2 ? st : st[0] + st.slice(1).toLowerCase()} title is the ${TITLE_ROUTING.decide.who}'s call` };
  const fb = TITLE_ROUTING.fallback;
  return { kind: 'vendor', company: fb.company, contact: fb.contact, why: st ? `No route for ${st}: ${fb.company}` : `No state on the property: ${fb.company} by default` };
}

export type ReadyCheck = { key: 'photo' | 'access' | 'title' | 'contract'; label: string; ok: boolean };

/** What Ready To Market needs before a deal is published to buyers. */
export function readyToMarketChecks(f: { photos: number; access: boolean; titleVendor: boolean; executedContract: boolean }): ReadyCheck[] {
  return [
    { key: 'photo', label: 'At least one photo', ok: f.photos > 0 },
    { key: 'access', label: 'Access or lockbox set', ok: f.access },
    { key: 'title', label: 'Title company on the deal', ok: f.titleVendor },
    { key: 'contract', label: 'Executed seller contract', ok: f.executedContract },
  ];
}

/** Stages that end a deal: moving there asks first. */
export const ENDING_STAGES = new Set(['Closed', 'Terminated']);

/** Wholesaler deal terms (SOP): close in 21 days, EMD 1% or the underlying amount, 1–3 inspections in 5 business days. */
export const WHOLESALER_CLOSE_DAYS = 21;
export const WHOLESALER_INSPECTION_BUSINESS_DAYS = 5;

export type WholesalerTerms = { closeBy: string | null; inspectBy: string | null; emdOnePct: number | null };

export function wholesalerTerms(contractIso: string | null | undefined, price: number | null | undefined): WholesalerTerms {
  const d0 = contractIso && /^\d{4}-\d{2}-\d{2}/.test(contractIso) ? contractIso.slice(0, 10) : null;
  return {
    closeBy: d0 ? plusIsoDays(d0, WHOLESALER_CLOSE_DAYS) : null,
    inspectBy: d0 ? plusBusinessDays(d0, WHOLESALER_INSPECTION_BUSINESS_DAYS) : null,
    emdOnePct: price != null && Number.isFinite(price) && price > 0 ? Math.round(price * 0.01) : null,
  };
}

/** Schedule C (title commitment requirements) status, the TC's traffic light. */
export type ScheduleCStatus = 'green' | 'yellow' | 'red';
export type ScheduleCItem = { id: string; text: string; status: ScheduleCStatus };

/** Reads transactions.schedule_c (migration 239), tolerating anything else stored there. */
export function readScheduleC(raw: unknown): ScheduleCItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    const status = o.status === 'green' || o.status === 'yellow' || o.status === 'red' ? o.status : 'yellow';
    const id = typeof o.id === 'string' && o.id ? o.id : '';
    return text && id ? [{ id, text, status }] : [];
  });
}

/** The worst light across Schedule C, or null when none are listed. */
export function scheduleCOverall(items: ScheduleCItem[]): ScheduleCStatus | null {
  if (!items.length) return null;
  if (items.some((i) => i.status === 'red')) return 'red';
  if (items.some((i) => i.status === 'yellow')) return 'yellow';
  return 'green';
}

export type TcBlocker = { level: 'CRITICAL' | 'WARNING' | 'NOTE'; text: string; who: string };

/**
 * What stands in the way on a TC file, from the SOP: a Friday closing, a
 * contract that went out late or not at all, a title company not picked (or
 * picked for a state where the TC decides), the prelim settlement statement
 * waiting on sign-off, and the wholesaler terms.
 */
export function tcFileBlockers(f: {
  closingIso?: string | null; contractIso?: string | null; state?: string | null; titleSet: boolean;
  contractSla?: ContractSla | null; tcReview?: string | null; signoff?: string | null;
  wholesaler?: boolean; price?: number | null; closed?: boolean;
}): TcBlocker[] {
  const out: TcBlocker[] = [];
  if (f.closed) return out;
  if (isFridayIso(f.closingIso)) {
    out.push({ level: 'CRITICAL', text: `Closing on a Friday (${f.closingIso!.slice(0, 10)})`, who: 'Move it to Monday through Thursday, or keep it with a reason on the deal sheet. Wires and signatures in Thursday.' });
  }
  if (f.contractSla?.late) out.push({ level: f.contractSla.waiting ? 'CRITICAL' : 'WARNING', text: f.contractSla.label, who: 'Acquisitions · SOP cap is 10 minutes' });
  const route = titleRoute(f.state);
  if (route.kind === 'decide') {
    out.push({ level: f.titleSet ? 'NOTE' : 'WARNING', text: f.titleSet ? `${route.why}: confirm the title company with them` : `${route.why}: no title company until they pick one`, who: route.who });
  } else if (!f.titleSet) {
    out.push({ level: 'WARNING', text: `No title company yet: ${route.company} (${route.contact})`, who: route.why });
  }
  if (f.tcReview && !f.signoff) out.push({ level: 'WARNING', text: 'Prelim settlement statement waiting on sign-off', who: 'An owner or admin signs off on the TC file. No wires until then.' });
  if (f.wholesaler) {
    const t = wholesalerTerms(f.contractIso, f.price);
    if (t.closeBy && f.closingIso && f.closingIso.slice(0, 10) > t.closeBy) {
      out.push({ level: 'WARNING', text: `Close date is past the 21-day wholesaler window (${t.closeBy})`, who: 'Wholesaler deal' });
    }
    out.push({
      level: 'NOTE',
      text: `Wholesaler terms: close by ${t.closeBy ?? 'contract + 21 days'}, EMD 1%${t.emdOnePct != null ? ` ($${t.emdOnePct.toLocaleString('en-US')})` : ''} or the underlying amount, 1 to 3 inspections by ${t.inspectBy ?? 'contract + 5 business days'}`,
      who: 'Wholesaler deal',
    });
  }
  return out;
}
