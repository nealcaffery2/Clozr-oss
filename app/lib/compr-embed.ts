// COMPR beside CLOZR: the deal's report, and what COMPR tells us about it.
//
// Open in COMPR puts the real thecompr.com report in a window of its own
// (lib/compr-window.ts): the rep's own Compr sign-in, the photos, the sliders.
// COMPR knows CLOZR opened it (?clozr=<this origin>) and posts each report it
// paints, and each edit it saves, back to window.opener as plain objects
// tagged by `source` (the bridge comment in Compr's public/app.html has the
// list). CLOZR writes them onto the deal as they land. COMPR answers only the
// origin named in the URL, and CLOZR reads only COMPR's own origins.

// A link pasted as markdown ([report](https://…/r/app-1787687900523)) or with a
// trailing bracket kept "](https:" in the id.
const LEAD_IN_URL = /\/r\/([^/?#)\]\s"'<>]+)/;
// A share link puts the address in front of the lead id; the API only knows the id.
const LEAD_AT_END = /-(clozr-w\d+-[ds]\d+-\d{4}-\d{2}-\d{2}|app-\d{10,}|podio-\d+-[a-z0-9]+)$/;

/** A COMPR lead id without the address slug its share link puts in front. */
function comprLeadId(raw: string): string {
  return LEAD_AT_END.exec(raw)?.[1] ?? raw;
}

/** The COMPR lead id in a report link (/r/<lead id>), or null. */
function comprLeadIdInUrl(link: string | null | undefined): string | null {
  const raw = LEAD_IN_URL.exec(link ?? '')?.[1];
  return raw ? comprLeadId(decodeURIComponent(raw)) : null;
}

/** The Compr deployment to frame. A workspace can point at a staging copy in Settings → Integrations. */
export const COMPR_DEFAULT_URL = 'https://thecompr.com';

let override: string | null = null;

export function setComprUrl(url: string | null | undefined): void {
  const trimmed = (url ?? '').trim().replace(/\/$/, '');
  override = trimmed || null;
}

export function comprUrl(): string {
  return override ?? (process.env.NEXT_PUBLIC_COMPR_URL || COMPR_DEFAULT_URL).replace(/\/$/, '');
}

export function comprOrigin(): string {
  try { return new URL(comprUrl()).origin; } catch { return COMPR_DEFAULT_URL; }
}

/** COMPR's own origins: the one configured, and thecompr.com / thecompr.ai, which serve the same app. */
export function isComprOrigin(origin: string): boolean {
  return origin === comprOrigin() || origin === 'https://thecompr.com' || origin === 'https://thecompr.ai';
}

/**
 * `/r/<lead id>` out of a Compr report link, or nothing. A share link with the
 * address in front gives the lead id alone, which is what Compr's app opens.
 */
export function comprLeadIdFromUrl(url: string | null | undefined): string | null {
  return comprLeadIdInUrl(url);
}

const COMPR_PHOTO_LEAD = /thecompr\.(?:com|ai)\/api\/photo\?(?:[^#]*&)?lead_id=([^&#]+)/i;

/**
 * The COMPR report a deal points at: its report link (underwriting_url), a
 * Podio submission's "Ai Compr Tool" link (compr_report_url), else the lead
 * behind a COMPR photo on the deal. Null when the deal has never been run.
 */
export function comprLeadIdOfDeal(d: {
  underwritingUrl?: string | null; comprReportUrl?: string | null; heroUrl?: string | null; photos?: string[] | null;
} | null | undefined): string | null {
  if (!d) return null;
  for (const u of [d.underwritingUrl, d.comprReportUrl]) {
    const id = comprLeadIdFromUrl(u);
    if (id) return id;
  }
  for (const u of [d.heroUrl, ...(d.photos ?? [])]) {
    const m = COMPR_PHOTO_LEAD.exec(u ?? '');
    if (m) return comprLeadId(decodeURIComponent(m[1]));
  }
  return null;
}

/** What Compr says about a report it painted. */
export type ComprReport = {
  leadId: string | null;
  /** `running` while the engine is still on it, otherwise Compr's lead status (`underwritten`, `flagged`, …). */
  status: string;
  address: string;
  arv: number | null; arvLow: number | null; arvHigh: number | null;
  rehab: number | null; condition: string | null;
  mao: number | null; wholesale: number | null; institutional: number | null;
  confidence: number | null; compCount: number | null;
  beds?: number | null; baths?: number | null;
  redFlags: { category?: string; severity?: string; description?: string }[];
  /** Absolute link to the report at Compr. */
  reportUrl: string | null;
  /** The rep moved a slider (ARV, rehab, a comp) on the open report and Compr saved it; not a fresh run. */
  adjusted: boolean;
};

export type ComprEvent =
  | { type: 'ready'; signedIn: boolean }
  | { type: 'auth'; signedIn: boolean; email: string | null }
  | { type: 'view'; view: string }
  | { type: 'missing'; leadId: string | null; status: number | null }
  | { type: 'report'; report: ComprReport };

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A message from the COMPR window, typed, or nothing when it is not Compr's. */
export function parseComprMessage(e: MessageEvent): ComprEvent | null {
  if (!isComprOrigin(e.origin)) return null;
  const m = e.data as Raw | null;
  if (!m || m.source !== 'compr' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': return { type: 'ready', signedIn: !!m.signedIn };
    case 'auth': return { type: 'auth', signedIn: !!m.signedIn, email: str(m.email) };
    case 'view': return { type: 'view', view: str(m.view) ?? 'search' };
    case 'report_missing': return { type: 'missing', leadId: str(m.lead_id), status: num(m.status) };
    case 'report': {
      const path = str(m.report_path);
      // True COMPR and the Clozr embed both post; prefer presented_offer so
      // Clozr edition MAO matches the report the rep sees outside the frame.
      const mao = num(m.presented_offer) ?? num(m.mao);
      const subject = (m.subject && typeof m.subject === 'object') ? m.subject as Raw : null;
      return {
        type: 'report',
        report: {
          leadId: str(m.lead_id), status: str(m.status) ?? 'underwritten', address: str(m.address) ?? '',
          arv: num(m.arv), arvLow: num(m.arv_low), arvHigh: num(m.arv_high),
          rehab: num(m.rehab), condition: str(m.condition),
          mao, wholesale: num(m.wholesale), institutional: num(m.institutional),
          confidence: num(m.confidence), compCount: num(m.comp_count),
          beds: num(m.beds) ?? num(subject?.beds) ?? num(subject?.bedrooms),
          baths: num(m.baths) ?? num(subject?.baths) ?? num(subject?.bathrooms),
          redFlags: Array.isArray(m.red_flags) ? (m.red_flags as ComprReport['redFlags']) : [],
          reportUrl: path ? comprUrl() + path : null,
          adjusted: m.reason === 'adjusted',
        },
      };
    }
    default: return null;
  }
}
