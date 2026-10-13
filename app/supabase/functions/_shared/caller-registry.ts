/**
 * Free Caller Registry + the Telnyx registrations that have to move when a
 * line is bought: 10DLC profile assignment, Number Reputation, spam
 * remediation, and Branded Calling.
 *
 * Free Caller Registry (freecallerregistry.com) has no API. First Orion, Hiya
 * and TNS email a verification code to the business address. That address is
 * an AgentMail inbox, so the code can be read here instead of by a person
 * watching a mailbox. Adding the number itself is a form; when FIRECRAWL_API_KEY
 * is set, caller-registry hands Firecrawl one prompt per new batch.
 *
 * Telnyx does have APIs. None of them are free to start (an enterprise, a
 * signed LOA, accepted terms), so this module only builds the next call when
 * the previous gate is already open. It does not invent a legal name or an EIN.
 *
 * Kept free of I/O. HTTP lives in supabase/functions/caller-registry.
 */

export type Problem = { field: string; problem: string };

/** What a workspace has typed once. ten_dlc.entity supplies the legal facts. */
export type RegistryFacts = {
  /** AgentMail inbox that receives Free Caller Registry mail. */
  agentmail_inbox_id?: string | null;
  /** The address registered on freecallerregistry.com. Defaults to the brand email. */
  fcr_email?: string | null;
  display_name?: string | null;
  /** 1–10 call reasons for the Display Identity Record. Pre-approved ones vet faster. */
  call_reasons?: string[] | null;
  authorizer_name?: string | null;
  authorizer_email?: string | null;
  /** Required on every branded-calling number add. A Telnyx Documents id. */
  loa_document_id?: string | null;
  /** Set true only after a person has accepted Telnyx's terms in the portal or via the agree endpoints. */
  terms_accepted?: boolean | null;
  /** Create the enterprise and the DIR. Number enrollment still runs without this once those exist. */
  auto_file?: boolean | null;
  call_purpose?: string | null;
  contact_first?: string | null;
  contact_last?: string | null;
  contact_title?: string | null;
  jurisdiction?: string | null;
  /** Telnyx organization_legal_type: llc, corporation, partnership, sole_proprietorship, … */
  legal_type?: string | null;
  industry?: string | null;
  employees?: string | null;
  logo_url?: string | null;
};

export type LegalFacts = {
  legal_name?: string | null;
  display_name?: string | null;
  ein?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
};

export type LineSnapshot = {
  phone_e164: string;
  spam_risk?: string | null;
  ten_dlc_assigned?: boolean | null;
};

export type LineState = {
  phone_e164: string;
  reputation_enrolled: boolean;
  branded_attached: boolean;
  fcr_status: string;
  remediation_open: boolean;
};

export type Gates = {
  reputation_approved: boolean;
  dir_verified: boolean;
  loa_document_id: string | null;
  messaging_profile_id: string | null;
  campaign_approved: boolean;
};

export type LinePlan = {
  phone_e164: string;
  enroll_reputation: boolean;
  attach_branded: boolean;
  remediate: boolean;
  assign_messaging_profile: boolean;
  queue_fcr: boolean;
};

const FCR_HOSTS = ['freecallerregistry.com', 'firstorion.com', 'hiya.com', 'tnsi.com', 'tns.com'];

export function isFcrSender(from: string): boolean {
  const f = from.toLowerCase();
  return FCR_HOSTS.some((h) => f.includes(h)) || f.includes('free caller registry') || f.includes('caller registry');
}

/** A verification code, or a confirm link on a registry host. Nothing else is fetched. */
export function extractFcrMail(input: { from: string; subject?: string | null; text?: string | null }): { code: string | null; url: string | null } | null {
  if (!isFcrSender(input.from) && !isFcrSender(input.subject ?? '')) return null;
  const blob = `${input.subject ?? ''}\n${input.text ?? ''}`;
  const code = blob.match(/(?:verification\s+code|your\s+code|code\s+is|enter\s+code)[:\s-]*([0-9]{4,8})/i)?.[1]
    ?? blob.match(/\b([0-9]{6})\b/)?.[1]
    ?? null;
  const urls = blob.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const url = urls
    .map((u) => u.replace(/[).,]+$/, ''))
    .find((u) => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, '');
        return FCR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      } catch {
        return false;
      }
    }) ?? null;
  if (!code && !url) return { code: null, url: null };
  return { code, url };
}

export function displayName(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} &'.,-]/gu, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 35);
}

/** What still has to be typed before Telnyx will accept an enterprise. */
export function enterpriseGaps(legal: LegalFacts, reg: RegistryFacts): Problem[] {
  const out: Problem[] = [];
  const need = (field: string, value: string | null | undefined, problem: string) => {
    if (!value?.trim()) out.push({ field, problem });
  };
  need('legal_name', legal.legal_name, 'The legal name has to match the IRS letter.');
  need('ein', legal.ein, 'The EIN is required on the Telnyx enterprise.');
  need('website', legal.website, 'Telnyx requires a website.');
  need('street', legal.street, 'A street address is required.');
  need('city', legal.city, 'A city is required.');
  need('state', legal.state, 'A state is required.');
  need('postal_code', legal.postal_code, 'A postal code is required.');
  need('email', legal.email, 'A contact email is required.');
  need('phone', legal.phone, 'A contact phone is required.');
  need('contact_first', reg.contact_first, 'Telnyx wants the contact’s first name (Settings → Workspace → Company & 10DLC).');
  need('contact_last', reg.contact_last, 'Telnyx wants the contact’s last name (Settings → Workspace → Company & 10DLC).');
  return out;
}

/** Telnyx POST /v2/enterprises organization_legal_type. */
const LEGAL_TYPE: Record<string, string> = {
  PRIVATE_PROFIT: 'llc',
  PUBLIC_PROFIT: 'corporation',
  NON_PROFIT: 'nonprofit',
  GOVERNMENT: 'other',
  SOLE_PROPRIETOR: 'other',
};

/**
 * Telnyx industry values use spaces (`real estate`), not underscores or TCR
 * vertical codes (`REAL_ESTATE`). Accept any of those shapes and land on a
 * value the create-enterprise enum will take.
 */
export const INDUSTRIES = [
  'accounting', 'finance', 'billing', 'collections', 'business', 'charity', 'nonprofit',
  'communications', 'telecom', 'customer service', 'support', 'delivery', 'shipping', 'logistics',
  'education', 'financial', 'banking', 'government', 'public', 'healthcare', 'health', 'pharmacy',
  'medical', 'insurance', 'legal', 'law', 'notifications', 'scheduling', 'real estate', 'property',
  'retail', 'ecommerce', 'sales', 'marketing', 'software', 'technology', 'tech', 'media', 'surveys',
  'market research', 'travel', 'hospitality', 'hotel',
] as const;

const INDUSTRY_SET = new Set<string>(INDUSTRIES);

/** 10DLC / TCR vertical → closest Telnyx industry. */
const INDUSTRY_FROM_VERTICAL: Record<string, string> = {
  REAL_ESTATE: 'real estate',
  PROFESSIONAL: 'business',
  FINANCIAL: 'financial',
  INSURANCE: 'insurance',
  CONSTRUCTION: 'business',
  RETAIL: 'retail',
  TECHNOLOGY: 'technology',
  HEALTHCARE: 'healthcare',
  NGO: 'nonprofit',
  EDUCATION: 'education',
  HOSPITALITY: 'hospitality',
  LEGAL: 'legal',
};

export function normalizeIndustry(raw?: string | null, vertical?: string | null): string {
  const clean = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const fromReg = raw?.trim() ? clean(raw) : '';
  if (fromReg && INDUSTRY_SET.has(fromReg)) return fromReg;
  const fromVert = vertical?.trim() ? INDUSTRY_FROM_VERTICAL[vertical.trim().toUpperCase()] : undefined;
  if (fromVert) return fromVert;
  if (fromReg) {
    // Last resort: spaced form may still be accepted after underscore→space.
    return fromReg;
  }
  return 'real estate';
}

export function authorizerName(reg: RegistryFacts): string {
  const named = reg.authorizer_name?.trim();
  if (named) return named;
  return [reg.contact_first, reg.contact_last].map((p) => p?.trim()).filter(Boolean).join(' ');
}

export function enterprisePayload(
  legal: LegalFacts,
  reg: RegistryFacts,
  entityType?: string | null,
  vertical?: string | null,
): Record<string, unknown> {
  const phone = legal.phone?.trim() || '';
  const email = legal.email?.trim() || '';
  const contact = {
    first_name: reg.contact_first?.trim(),
    last_name: reg.contact_last?.trim(),
    email,
    phone_number: phone,
  };
  return {
    legal_name: legal.legal_name?.trim(),
    doing_business_as: (reg.display_name || legal.display_name || legal.legal_name || '').trim(),
    organization_type: 'commercial',
    organization_legal_type: reg.legal_type?.trim() || LEGAL_TYPE[entityType ?? ''] || 'llc',
    country_code: (legal.country || 'US').trim(),
    jurisdiction_of_incorporation: reg.jurisdiction?.trim() || legal.state?.trim(),
    website: legal.website?.trim(),
    fein: legal.ein?.trim(),
    industry: normalizeIndustry(reg.industry, vertical),
    number_of_employees: reg.employees?.trim() || '1-10',
    // job_title belongs on the organization contact only. Telnyx refuses the
    // whole enterprise when the billing contact carries it ("Field 'job_title'
    // is not allowed in this request").
    organization_contact: { ...contact, job_title: reg.contact_title?.trim() || 'Owner' },
    billing_contact: contact,
    organization_physical_address: {
      country: (legal.country || 'US').trim(),
      administrative_area: legal.state?.trim(),
      city: legal.city?.trim(),
      postal_code: legal.postal_code?.trim(),
      street_address: legal.street?.trim(),
    },
    billing_address: {
      country: (legal.country || 'US').trim(),
      administrative_area: legal.state?.trim(),
      city: legal.city?.trim(),
      postal_code: legal.postal_code?.trim(),
      street_address: legal.street?.trim(),
    },
  };
}

export function dirGaps(reg: RegistryFacts, legal: LegalFacts): Problem[] {
  const out: Problem[] = [];
  const name = displayName(reg.display_name || legal.display_name || legal.legal_name || '');
  if (!name) out.push({ field: 'display_name', problem: 'Branded calling needs a display name, 35 characters or fewer.' });
  if (!authorizerName(reg)) out.push({ field: 'authorizer_name', problem: 'Name the person authorizing the display identity.' });
  if (!reg.authorizer_email?.trim() && !legal.email?.trim()) out.push({ field: 'authorizer_email', problem: 'An authorizer email is required.' });
  const reasons = (reg.call_reasons ?? []).map((r) => r.trim()).filter(Boolean);
  if (!reasons.length) out.push({ field: 'call_reasons', problem: 'Add 1–10 call reasons, copied from Telnyx’s pre-approved list when you can.' });
  if (reasons.length > 10) out.push({ field: 'call_reasons', problem: 'Telnyx accepts at most 10 call reasons.' });
  return out;
}

export function dirPayload(reg: RegistryFacts, legal: LegalFacts): Record<string, unknown> {
  const reasons = (reg.call_reasons ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 10);
  const body: Record<string, unknown> = {
    display_name: displayName(reg.display_name || legal.display_name || legal.legal_name || ''),
    authorizer_name: authorizerName(reg),
    authorizer_email: (reg.authorizer_email || legal.email || '').trim(),
    certify_brand_is_accurate: true,
    certify_no_shaft_content: true,
    certify_ip_ownership: true,
    call_reasons: reasons,
  };
  const logo = reg.logo_url?.trim();
  if (logo) body.logo_url = logo;
  return body;
}

export function planLine(line: LineSnapshot, state: LineState | null, gates: Gates): LinePlan {
  const known = state ?? {
    phone_e164: line.phone_e164,
    reputation_enrolled: false,
    branded_attached: false,
    fcr_status: 'queued',
    remediation_open: false,
  };
  const risk = (line.spam_risk ?? '').toLowerCase();
  const flagged = risk === 'medium' || risk === 'high';
  const fcrDone = ['submitted', 'code_ready', 'verified', 'registered'].includes(known.fcr_status);
  return {
    phone_e164: line.phone_e164,
    enroll_reputation: gates.reputation_approved && !known.reputation_enrolled,
    attach_branded: gates.dir_verified && Boolean(gates.loa_document_id) && !known.branded_attached,
    remediate: gates.reputation_approved && known.reputation_enrolled && flagged && !known.remediation_open,
    assign_messaging_profile: Boolean(gates.messaging_profile_id) && gates.campaign_approved && line.ten_dlc_assigned === false,
    queue_fcr: !fcrDone,
  };
}

/** One Firecrawl prompt for a batch of numbers that are not on Free Caller Registry yet. */
export function fcrAgentPrompt(input: { business: string; email: string; phones: string[]; code: string | null }): string {
  const code = input.code
    ? `If the site asks for the email verification code, enter ${input.code}.`
    : 'If the site asks for an email verification code, stop and say NEEDS_CODE. Do not invent one.';
  return [
    `Open https://freecallerregistry.com/fcr and register these US calling numbers for ${input.business}.`,
    `Use the business email ${input.email}. ${code}`,
    `Numbers, one per line: ${input.phones.join(', ')}.`,
    'Submit only if the form accepts them. Report each number as submitted or the exact error. Do not create a second business if one is already signed in for this email.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// RVM pool parity (migration 195). A pool line gets everything a main line
// gets: the Free Caller Registry, Number Reputation, remediation, branded
// calling, 10DLC and a CNAM listing, whether or not Talkr holds the number.
// ---------------------------------------------------------------------------

/** CNAM is 15 characters of letters, digits and spaces; a name that does not fit is cut at a word. */
export function cnamFrom(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 15) return clean;
  const cut = clean.slice(0, 15);
  const sp = cut.lastIndexOf(' ');
  return (sp > 6 ? cut.slice(0, sp) : cut).trim();
}

export type RegistryInput = { phone_e164: string; spam_risk?: string | null; ten_dlc_assigned?: boolean | null; talkr_number_id?: string | null; pool?: string | null };

/**
 * The lines one advance plans for: what Talkr's reputation summary returned,
 * the numbers the caller named, and every line in the RVM pool that is not
 * retired. Before this a pool line Talkr did not list (one bought on the
 * carrier directly) was only ever queued for the registry, never enrolled in
 * reputation, branded calling or 10DLC. `health` is number_health's 10DLC
 * flag for lines Talkr's summary leaves out. US numbers only, one row each.
 */
export function registryLines(
  snapshots: readonly { id?: string | null; phone_e164?: string | null; spam?: { spam_risk?: string | null } | null; spam_risk?: string | null; ten_dlc?: { assigned?: boolean | null } | null }[],
  hinted: readonly string[],
  lines: readonly { phone_e164: string; pool?: string | null; retired_at?: string | null; spam_risk?: string | null }[],
  health: Readonly<Record<string, { ten_dlc_assigned?: boolean | null }>> = {},
): RegistryInput[] {
  const out = new Map<string, RegistryInput>();
  for (const n of snapshots) {
    const phone = String(n.phone_e164 ?? '');
    if (!phone.startsWith('+1') || out.has(phone)) continue;
    out.set(phone, { phone_e164: phone, spam_risk: n.spam?.spam_risk ?? n.spam_risk ?? null, ten_dlc_assigned: n.ten_dlc?.assigned ?? null, talkr_number_id: n.id ?? null });
  }
  const known = new Map(lines.map((l) => [l.phone_e164, l]));
  const extra = [...hinted, ...lines.filter((l) => l.pool === 'rvm' && !l.retired_at).map((l) => l.phone_e164)];
  for (const phone of extra) {
    if (!phone.startsWith('+1') || out.has(phone)) continue;
    const l = known.get(phone);
    out.set(phone, { phone_e164: phone, spam_risk: l?.spam_risk ?? null, ten_dlc_assigned: health[phone]?.ten_dlc_assigned ?? null, pool: l?.pool ?? null });
  }
  for (const [phone, row] of out) if (!row.pool) row.pool = known.get(phone)?.pool ?? null;
  return [...out.values()];
}

/**
 * Lines a finished Firecrawl job filed: the ones it was handed (status
 * `submitting`). It used to mark the still-queued lines instead, and wrote
 * `submitted`, which the fcr_status check refused until migration 195, so
 * every line stayed queued or submitting.
 */
export function fcrFiled(lines: readonly { phone_e164: string; fcr_status?: string | null }[]): string[] {
  return lines.filter((l) => l.fcr_status === 'submitting').map((l) => l.phone_e164);
}

export type ReputationRow = { phone_e164: string; spam_risk: string | null; spam_category: string | null; checked_at: string | null };

/** Telnyx `GET /enterprises/{id}/reputation/numbers` rows: the latest spam verdict per number. Null data means not checked yet. */
export function reputationRows(json: unknown): ReputationRow[] {
  const rows = ((json as { data?: unknown[] } | null)?.data ?? []) as { phone_number?: string; reputation_data?: { spam_risk?: string | null; spam_category?: string | null; last_refreshed_at?: string | null } | null }[];
  return rows.flatMap((r) => {
    const phone = String(r.phone_number ?? '');
    if (!/^\+1\d{10}$/.test(phone) || !r.reputation_data) return [];
    return [{
      phone_e164: phone,
      spam_risk: r.reputation_data.spam_risk ? String(r.reputation_data.spam_risk).toLowerCase() : null,
      spam_category: r.reputation_data.spam_category ?? null,
      checked_at: r.reputation_data.last_refreshed_at ?? null,
    }];
  });
}

/**
 * Pool lines that need a CNAM listing set on the carrier: Talkr sets it on
 * the numbers it holds (number-guard), so this is the pool lines Talkr does
 * not, that have none listed yet.
 */
export function cnamTargets(lines: readonly { phone_e164: string; pool?: string | null; retired_at?: string | null; talkr_number_id?: string | null; cnam_listed?: boolean | null }[]): string[] {
  return lines.filter((l) => l.pool === 'rvm' && !l.retired_at && !l.talkr_number_id && !l.cnam_listed && l.phone_e164.startsWith('+1')).map((l) => l.phone_e164);
}
