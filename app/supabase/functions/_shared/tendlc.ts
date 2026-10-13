/**
 * 10DLC brand and campaign registration: the facts, the rules and the payloads.
 *
 * Filing is three calls — brand, campaign, then assign a messaging profile —
 * and none of them need the portal. What they do need is a set of facts that
 * only a human can supply correctly (legal name, EIN, the consent story) and
 * that TCR rejects for a fee if they are wrong. So everything checkable is
 * checked here, before a cent is spent:
 *
 *   validateEntity   — the brand fields, against TCR's own formats
 *   validateCampaign — the campaign fields, against what gets campaigns pulled
 *   brandPayload     — CLOZR's settings shape → Telnyx's brand body
 *   campaignPayload  — CLOZR's settings shape → Telnyx's campaignBuilder body
 *
 * Kept free of I/O so `deno run _shared/tendlc.test.ts` covers the rules.
 * The HTTP lives in supabase/functions/ten-dlc-register.
 *
 * Facts live on workspaces.settings->'ten_dlc' (see docs/10dlc-automation.md).
 */

// ---------------------------------------------------------------- the facts

export type EntityFacts = {
  /** Exactly as printed on the IRS EIN letter — TCR matches it character for character. */
  legal_name: string;
  /** The DBA people see. Falls back to legal_name. */
  display_name?: string | null;
  ein: string;
  entity_type: string;
  vertical: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country?: string | null;
  email: string;
  phone: string;
  website: string;
};

export type CampaignFacts = {
  usecase: string;
  description: string;
  /** How people opted in, in enough detail that a reviewer can go and look. */
  message_flow: string;
  /** 2–5 real messages. Sample 1 is the first touch and carries the opt-out. */
  samples: string[];
  help_message: string;
  /** LOW_VOLUME and MIXED are declared as 2–5 of SUB_USE_CASES. */
  sub_usecases?: string[] | null;
  /** The page a reviewer opens for the mobile-data sentence. */
  privacy_policy_url?: string | null;
  terms_url?: string | null;
  /** The confirmation texted back after someone opts in. */
  optin_message?: string | null;
  optout_message?: string | null;
  embedded_link_sample?: string | null;
  optin_keywords?: string | null;
  optout_keywords?: string | null;
  help_keywords?: string | null;
  embedded_link?: boolean | null;
  embedded_phone?: boolean | null;
  age_gated?: boolean | null;
  direct_lending?: boolean | null;
};

export type TenDlcFacts = {
  entity?: Partial<EntityFacts> | null;
  campaign?: Partial<CampaignFacts> | null;
  /** The Telnyx messaging profile whose numbers join the campaign. */
  messaging_profile_id?: string | null;
};

/** A problem a human has to fix, named by the field so the UI can point at it. */
export type Problem = { field: string; problem: string };

// ---------------------------------------------------------------- vocabulary

export const ENTITY_TYPES = ['PRIVATE_PROFIT', 'PUBLIC_PROFIT', 'NON_PROFIT', 'GOVERNMENT', 'SOLE_PROPRIETOR'] as const;

/** TCR's verticals. Only the ones a CLOZR workspace plausibly is. */
export const VERTICALS = [
  'REAL_ESTATE', 'PROFESSIONAL', 'FINANCIAL', 'INSURANCE', 'CONSTRUCTION',
  'RETAIL', 'TECHNOLOGY', 'HEALTHCARE', 'NGO', 'EDUCATION', 'HOSPITALITY', 'LEGAL',
] as const;

/**
 * The use cases worth offering. LOW_VOLUME is the right answer for almost
 * every workspace here: a handful of lines, a couple of hundred texts a day,
 * the cheapest submission fee and the lightest review. MIXED is for a
 * workspace that outgrows five numbers or the low-volume daily cap.
 */
export const USE_CASES = ['LOW_VOLUME', 'MIXED', 'CUSTOMER_CARE', 'MARKETING', 'ACCOUNT_NOTIFICATION'] as const;

/** The use cases TCR files as a bundle of sub use cases. */
export const BUNDLED_USE_CASES = ['LOW_VOLUME', 'MIXED'] as const;
export const SUB_USE_CASES = [
  'CUSTOMER_CARE', 'MARKETING', 'ACCOUNT_NOTIFICATION', 'DELIVERY_NOTIFICATION',
  'FRAUD_ALERT', 'SECURITY_ALERT', 'TWO_FACTOR_AUTHENTICATION', 'POLLING_VOTING', 'PUBLIC_SERVICE_ANNOUNCEMENT',
] as const;
export const DEFAULT_SUB_USE_CASES = ['CUSTOMER_CARE', 'MARKETING'];

// Telnyx: "Multiple keywords are comma separated without space."
export const DEFAULT_OPTOUT_KEYWORDS = 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT';
export const DEFAULT_HELP_KEYWORDS = 'HELP,INFO';
export const DEFAULT_OPTIN_KEYWORDS = 'START,UNSTOP';

export const keywords = (raw: string) => raw.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean).join(',');

// ---------------------------------------------------------------- normalizing

/** TCR takes `XX-XXXXXXX` or nine bare digits; anything else is a rejection. */
export function normalizeEin(raw: string): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length !== 9) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

export function normalizePhone(raw: string): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(raw ?? '') ? raw : null;
}

const has = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

// ---------------------------------------------------------------- the brand

export function validateEntity(e: Partial<EntityFacts> | null | undefined): Problem[] {
  const p: Problem[] = [];
  const f = e ?? {};

  if (!has(f.legal_name)) p.push({ field: 'legal_name', problem: 'The legal company name is required, exactly as it appears on the IRS EIN letter.' });
  else if (f.legal_name.trim().length < 2) p.push({ field: 'legal_name', problem: 'That is too short to be a legal company name.' });

  if (!has(f.ein)) p.push({ field: 'ein', problem: 'The EIN is required.' });
  else if (!normalizeEin(f.ein)) p.push({ field: 'ein', problem: 'An EIN is nine digits, written XX-XXXXXXX.' });

  if (!has(f.entity_type)) p.push({ field: 'entity_type', problem: 'Pick an entity type. An LLC files as PRIVATE_PROFIT.' });
  else if (!ENTITY_TYPES.includes(f.entity_type as typeof ENTITY_TYPES[number])) p.push({ field: 'entity_type', problem: `Not a TCR entity type. One of: ${ENTITY_TYPES.join(', ')}.` });

  if (!has(f.vertical)) p.push({ field: 'vertical', problem: 'Pick an industry vertical.' });
  else if (!VERTICALS.includes(f.vertical as typeof VERTICALS[number])) p.push({ field: 'vertical', problem: `Not a vertical we file. One of: ${VERTICALS.join(', ')}.` });

  for (const [k, label] of [['street', 'street address'], ['city', 'city'], ['postal_code', 'postal code']] as const) {
    if (!has(f[k])) p.push({ field: k, problem: `The ${label} on file with the IRS for this EIN is required.` });
  }
  if (!has(f.state)) p.push({ field: 'state', problem: 'The state is required.' });
  else if (!/^[A-Za-z]{2}$/.test(f.state.trim())) p.push({ field: 'state', problem: 'Use the two-letter state code.' });
  if (has(f.postal_code) && !/^\d{5}(-\d{4})?$/.test(f.postal_code.trim())) p.push({ field: 'postal_code', problem: 'Use a five-digit ZIP, or ZIP+4.' });

  if (!has(f.email)) p.push({ field: 'email', problem: 'A support email is required, and it has to receive mail — reviewers test it.' });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) p.push({ field: 'email', problem: 'That is not an email address.' });

  if (!has(f.phone)) p.push({ field: 'phone', problem: 'A support phone number is required.' });
  else if (!normalizePhone(f.phone)) p.push({ field: 'phone', problem: 'Use a real phone number, in E.164 (+12105551234).' });

  if (!has(f.website)) p.push({ field: 'website', problem: 'A public website is required — the reviewer opens it looking for your privacy policy and opt-in form.' });
  else if (!/^https:\/\/[^\s.]+\.[^\s]{2,}$/.test(f.website.trim())) p.push({ field: 'website', problem: 'The website must be a public https:// URL.' });

  return p;
}

export function brandPayload(e: EntityFacts, webhookUrl?: string | null): Record<string, unknown> {
  return {
    entityType: e.entity_type,
    companyName: e.legal_name.trim(),
    displayName: (e.display_name ?? '').trim() || e.legal_name.trim(),
    ein: normalizeEin(e.ein)?.replace('-', ''),
    einIssuingCountry: (e.country ?? 'US').trim().toUpperCase(),
    phone: normalizePhone(e.phone),
    street: e.street.trim(),
    city: e.city.trim(),
    state: e.state.trim().toUpperCase(),
    postalCode: e.postal_code.trim(),
    country: (e.country ?? 'US').trim().toUpperCase(),
    email: e.email.trim(),
    website: e.website.trim(),
    vertical: e.vertical,
    ...(webhookUrl ? { webhookURL: webhookUrl } : {}),
  };
}

// ------------------------------------------------------------- the campaign

/** Link shorteners get campaigns rejected: the reviewer cannot see where they go. */
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|buff\.ly|is\.gd|rebrand\.ly|cutt\.ly)\b/i;

export function validateCampaign(c: Partial<CampaignFacts> | null | undefined, brandName?: string | null): Problem[] {
  const p: Problem[] = [];
  const f = c ?? {};

  if (!has(f.usecase)) p.push({ field: 'usecase', problem: 'Pick a use case. LOW_VOLUME fits a few lines and a few hundred texts a day.' });
  else if (!USE_CASES.includes(f.usecase as typeof USE_CASES[number])) p.push({ field: 'usecase', problem: `Not a use case we file. One of: ${USE_CASES.join(', ')}.` });

  if (!has(f.description)) p.push({ field: 'description', problem: 'Describe what you text about, in two to four sentences.' });
  else if (f.description.trim().length < 40) p.push({ field: 'description', problem: 'Too short — reviewers reject one-liners. Two to four sentences.' });
  else if (f.description.length > 4096) p.push({ field: 'description', problem: 'Too long; keep it under 4096 characters.' });

  if (!has(f.message_flow)) p.push({ field: 'message_flow', problem: 'Describe how people opt in — where the form is, what the checkbox says, what you store.' });
  else if (f.message_flow.trim().length < 40) p.push({ field: 'message_flow', problem: 'Too short. A reviewer has to be able to go and find your opt-in and see the same words.' });

  const samples = (f.samples ?? []).map((s) => (s ?? '').trim()).filter(Boolean);
  if (samples.length < 2) p.push({ field: 'samples', problem: 'At least two real sample messages are required; five is better.' });
  if (samples.length > 5) p.push({ field: 'samples', problem: 'At most five samples.' });
  samples.forEach((s, i) => {
    if (s.length < 20) p.push({ field: `samples.${i}`, problem: 'Too short to be a real message.' });
    if (s.length > 1024) p.push({ field: `samples.${i}`, problem: 'Over 1024 characters.' });
    if (SHORTENERS.test(s)) p.push({ field: `samples.${i}`, problem: 'Link shorteners get campaigns rejected — use a link on your own domain.' });
  });
  // Sample 1 is the first touch. If it does not say how to stop, the samples do
  // not match what CLOZR actually sends, which is what gets a campaign pulled.
  if (samples.length && !/\bSTOP\b/i.test(samples[0])) {
    p.push({ field: 'samples.0', problem: 'The first sample has to show the opt-out line, because the first text carries it.' });
  }

  if (!has(f.help_message)) p.push({ field: 'help_message', problem: 'A HELP reply is required.' });
  else {
    if (f.help_message.length > 320) p.push({ field: 'help_message', problem: 'Keep the HELP reply under 320 characters.' });
    if (brandName && !f.help_message.toLowerCase().includes(brandName.trim().toLowerCase().split(/\s+/)[0] ?? '')) {
      p.push({ field: 'help_message', problem: 'The HELP reply has to name the business, so the reader knows who is texting.' });
    }
    if (!/\bSTOP\b/i.test(f.help_message)) p.push({ field: 'help_message', problem: 'The HELP reply has to say how to stop.' });
  }

  const optout = (f.optout_keywords ?? DEFAULT_OPTOUT_KEYWORDS).toUpperCase();
  if (!/\bSTOP\b/.test(optout)) p.push({ field: 'optout_keywords', problem: 'STOP must be one of the opt-out keywords.' });
  const help = (f.help_keywords ?? DEFAULT_HELP_KEYWORDS).toUpperCase();
  if (!/\bHELP\b/.test(help)) p.push({ field: 'help_keywords', problem: 'HELP must be one of the help keywords.' });

  if (BUNDLED_USE_CASES.includes(f.usecase as typeof BUNDLED_USE_CASES[number])) {
    const subs = f.sub_usecases ?? [];
    if (subs.length < 2 || subs.length > 5) p.push({ field: 'sub_usecases', problem: `${f.usecase} is filed as two to five sub use cases — pick what you actually text about.` });
    const bad = subs.filter((s) => !SUB_USE_CASES.includes(s as typeof SUB_USE_CASES[number]));
    if (bad.length) p.push({ field: 'sub_usecases', problem: `Not a sub use case TCR knows: ${bad.join(', ')}.` });
  }

  const https = /^https:\/\/[^\s.]+\.[^\s]{2,}$/;
  if (!has(f.privacy_policy_url)) p.push({ field: 'privacy_policy_url', problem: 'Link the privacy policy. Reviewers open it looking for the sentence that mobile numbers are never shared for marketing.' });
  else if (!https.test(f.privacy_policy_url.trim())) p.push({ field: 'privacy_policy_url', problem: 'The privacy policy must be a public https:// URL.' });
  if (has(f.terms_url) && !https.test(f.terms_url.trim())) p.push({ field: 'terms_url', problem: 'The terms link must be a public https:// URL.' });

  if (!has(f.optin_message)) p.push({ field: 'optin_message', problem: 'Write the confirmation texted after someone opts in. It names the business and says how to stop.' });
  else if (!/\bSTOP\b/i.test(f.optin_message)) p.push({ field: 'optin_message', problem: 'The opt-in confirmation has to say how to stop.' });

  if (f.embedded_link && !has(f.embedded_link_sample)) p.push({ field: 'embedded_link_sample', problem: 'Texts carry links, so give one real example link on your own domain.' });
  else if (has(f.embedded_link_sample) && SHORTENERS.test(f.embedded_link_sample)) p.push({ field: 'embedded_link_sample', problem: 'Link shorteners get campaigns rejected — use a link on your own domain.' });

  return p;
}

/** The body for GET /10dlc/campaignBuilder/brand/{id}/usecase/{usecase}: are the sub use cases the right count for this brand? */
export function qualifies(q: { minSubUsecases?: number | null; maxSubUsecases?: number | null } | null | undefined, subs: number): string | null {
  const min = Number(q?.minSubUsecases ?? 0);
  const max = Number(q?.maxSubUsecases ?? 0);
  if (min && subs < min) return `This use case needs at least ${min} sub use cases for your brand.`;
  if (max && subs > max) return `This use case takes at most ${max} sub use cases for your brand.`;
  return null;
}

export function campaignPayload(brandId: string, c: CampaignFacts, webhookUrl?: string | null): Record<string, unknown> {
  const samples = (c.samples ?? []).map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 5);
  const numbered: Record<string, string> = {};
  samples.forEach((s, i) => { numbered[`sample${i + 1}`] = s; });
  return {
    brandId,
    usecase: c.usecase,
    description: c.description.trim(),
    messageFlow: c.message_flow.trim(),
    ...numbered,
    helpMessage: c.help_message.trim(),
    optinKeywords: keywords(c.optin_keywords || DEFAULT_OPTIN_KEYWORDS),
    optoutKeywords: keywords(c.optout_keywords || DEFAULT_OPTOUT_KEYWORDS),
    helpKeywords: keywords(c.help_keywords || DEFAULT_HELP_KEYWORDS),
    ...(BUNDLED_USE_CASES.includes(c.usecase as typeof BUNDLED_USE_CASES[number]) ? { subUsecases: c.sub_usecases ?? [] } : {}),
    ...(c.optin_message?.trim() ? { optinMessage: c.optin_message.trim() } : {}),
    ...(c.optout_message?.trim() ? { optoutMessage: c.optout_message.trim() } : {}),
    ...(c.privacy_policy_url?.trim() ? { privacyPolicyLink: c.privacy_policy_url.trim() } : {}),
    ...(c.terms_url?.trim() ? { termsAndConditionsLink: c.terms_url.trim() } : {}),
    ...(c.embedded_link && c.embedded_link_sample?.trim() ? { embeddedLinkSample: c.embedded_link_sample.trim() } : {}),
    termsAndConditions: true,
    embeddedLink: !!c.embedded_link,
    embeddedPhone: !!c.embedded_phone,
    ageGated: !!c.age_gated,
    directLending: !!c.direct_lending,
    numberPool: false,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    ...(webhookUrl ? { webhookURL: webhookUrl } : {}),
  };
}

// ---------------------------------------------------------------- statuses

/** TCR brand states that mean "filed and good". */
export function brandOk(status: string | null | undefined): boolean {
  return ['VERIFIED', 'VETTED_VERIFIED', 'OK', 'ACTIVE'].includes(String(status ?? '').toUpperCase());
}

/** Campaign states that mean carriers will deliver. */
export function campaignOk(status: string | null | undefined): boolean {
  return ['ACTIVE', 'APPROVED', 'REGISTERED', 'MNO_PROVISIONED'].includes(String(status ?? '').toUpperCase());
}

/**
 * Telnyx refusing a filing because the account cannot pay the registry fee
 * ("Your account must have at least $6.00 to perform this operation"). That is
 * not a carrier rejection: nothing was filed, nothing about the facts is
 * wrong, and the same filing goes through once the balance is topped up.
 */
export function needsFunds(error: string | null | undefined): boolean {
  return /must have at least \$|insufficient (funds|balance)|account balance|add funds|payment required/i.test(String(error ?? ''));
}

/** What a funding refusal is saved as; the UI and the digest key off the prefix. */
/**
 * What to do with one number so it sends on this campaign. Telnyx's
 * assign-by-profile is a one-time task over the numbers on the profile at that
 * moment, so a line bought or handed to a teammate later has to be attached on
 * its own. A number is on one campaign at a time: on another one it is moved
 * (PUT), on none it is added (POST), and on this one it is left alone unless
 * the last try failed.
 */
export function attachPlan(
  current: { campaignId?: string | null; telnyxCampaignId?: string | null; assignmentStatus?: string | null } | null | undefined,
  campaignId: string,
): 'skip' | 'create' | 'replace' {
  const on = current?.telnyxCampaignId || current?.campaignId || null;
  if (!on) return 'create';
  if (on !== campaignId) return 'replace';
  return /FAILED/i.test(String(current?.assignmentStatus ?? '')) ? 'replace' : 'skip';
}

export const FUNDS_PREFIX = 'funds:';
export function fundsMessage(error: string | null | undefined): string {
  const fee = String(error ?? '').match(/\$\s?(\d+(?:\.\d{2})?)/)?.[1];
  return `${FUNDS_PREFIX} Telnyx needs at least $${fee ?? '6.00'} on the account to pay the 10DLC registry fee. Add funds at portal.telnyx.com → Billing; CLOZR finishes the filing on its own at the next morning check, or press Continue filing once the funds are in.`;
}

/** A state nobody can fix by waiting — it needs a human and usually a new filing. */
export function terminal(status: string | null | undefined): boolean {
  return [
    'FAILED', 'REJECTED', 'EXPIRED', 'SUSPENDED', 'UNVERIFIED', 'REGISTRATION_FAILED',
    'TCR_FAILED', 'TELNYX_FAILED', 'MNO_REJECTED', 'TCR_SUSPENDED', 'TCR_EXPIRED', 'MNO_PROVISIONING_FAILED',
  ].includes(String(status ?? '').toUpperCase());
}

/**
 * One line a human can act on, out of a webhook's `reasons[]`. Telnyx names the
 * offending fields, which is the difference between "your brand failed" and
 * "your EIN has the wrong number of digits".
 */
export function explainReasons(reasons: unknown): string {
  if (!Array.isArray(reasons) || !reasons.length) return '';
  return reasons
    .map((r) => {
      const o = (r ?? {}) as { fields?: unknown; description?: unknown };
      const fields = Array.isArray(o.fields) ? o.fields.filter((f) => typeof f === 'string').join(', ') : '';
      const desc = typeof o.description === 'string' ? o.description : '';
      return fields ? `${fields}: ${desc}` : desc;
    })
    .filter(Boolean)
    .join(' · ');
}
