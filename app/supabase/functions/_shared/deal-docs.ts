// What a transaction document is, from its file name and the email it came on.
//
// Pure and dependency-free: the Gmail sync (google.ts) labels an attachment
// as it files it on the deal, Lane's listener reads the label, and the Files
// card in the browser (lib/deal-files.ts) shows the same label and offers the
// same list when someone sets one by hand. One rule, three readers.

export type DocType =
  | 'title_commitment' | 'closing_disclosure' | 'settlement_statement' | 'purchase_agreement' | 'assignment'
  | 'addendum' | 'emd_receipt' | 'wire_instructions' | 'payoff' | 'survey' | 'inspection' | 'appraisal'
  | 'hoa' | 'tax_cert' | 'id_docs' | 'memorandum' | 'poa' | 'invoice' | 'photos' | 'other';

export const DOC_LABEL: Record<DocType, string> = {
  title_commitment: 'Title commitment', closing_disclosure: 'Closing disclosure', settlement_statement: 'Settlement statement / HUD',
  purchase_agreement: 'Purchase agreement', assignment: 'Assignment', addendum: 'Addendum', emd_receipt: 'EMD receipt',
  wire_instructions: 'Wire instructions', payoff: 'Payoff', survey: 'Survey', inspection: 'Inspection', appraisal: 'Appraisal',
  hoa: 'HOA', tax_cert: 'Tax certificate', id_docs: 'ID / entity docs', memorandum: 'Memorandum', poa: 'Power of attorney',
  invoice: 'Invoice', photos: 'Photos', other: 'Other',
};

/** The picker order on the Files card: what a TC reaches for most, first. */
export const DOC_TYPES: DocType[] = [
  'title_commitment', 'purchase_agreement', 'assignment', 'addendum', 'emd_receipt', 'closing_disclosure',
  'settlement_statement', 'wire_instructions', 'payoff', 'memorandum', 'poa', 'survey', 'inspection', 'appraisal',
  'hoa', 'tax_cert', 'id_docs', 'invoice', 'photos', 'other',
];

// First match wins, so the specific ones sit above the general ones
// ("title commitment" before "title", "closing disclosure" before "closing").
const RULES: [DocType, RegExp][] = [
  ['title_commitment', /\b(title\s*commit|commitment\s*(for|of)\s*title|prelim(inary)?\s*(title|report|commit)|schedule\s*b|title\s*(report|binder))/i],
  ['closing_disclosure', /\b(closing\s*disclosure|\bcd\b(?!\s*rom))/i],
  ['settlement_statement', /\b(settlement\s*statement|hud-?1?\b|alta\s*(settlement|ss)|closing\s*statement|buyer'?s?\s*statement|seller'?s?\s*statement)/i],
  ['wire_instructions', /\bwir(e|ing)\s*(instruction|info)/i],
  ['emd_receipt', /\b(emd|earnest\s*money)\b.*\b(receipt|confirm|received)|\b(receipt|confirm)\b.*\b(emd|earnest)/i],
  ['payoff', /\bpay-?off\b/i],
  // Wholesale shorthand: the A-B contract is the seller's purchase agreement, the B-C the assignment to the end buyer.
  ['assignment', /\bassignment\s*(of\s*)?(contract|agreement)?|\bassign(ed)?\s*contract|\bb\s*-?\s*c\s*contract|\bb\s*to\s*c\b/i],
  ['purchase_agreement', /\ba\s*-?\s*b\s*contract|\ba\s*to\s*b\b/i],
  ['addendum', /\b(addend(um|a)|amendment)\b/i],
  ['memorandum', /\bmemorandum\b|\bmemo\s*of\s*(contract|option|agreement)/i],
  ['poa', /\b(power\s*of\s*attorney|\bpoa\b)/i],
  ['purchase_agreement', /\b(purchase\s*(and\s*sale\s*)?agreement|\bpsa\b|sales?\s*contract|real\s*estate\s*contract|executed\s*contract|trec|one\s*to\s*four)/i],
  ['survey', /\bsurvey\b|\bt[\s-]?47\b/i],
  ['inspection', /\binspection\b/i],
  ['appraisal', /\bapprais/i],
  ['hoa', /\b(hoa|resale\s*cert|estoppel)\b/i],
  ['tax_cert', /\btax\s*(cert|statement|bill)/i],
  ['id_docs', /\b(driver'?s?\s*licen[cs]e|\bdl\b|photo\s*id|articles\s*of\s*(organization|incorporation)|operating\s*agreement|ein\b|w-?9)\b/i],
  ['invoice', /\binvoice\b/i],
  // Last: a file just called a contract is the purchase agreement.
  ['purchase_agreement', /\bcontract\b/i],
];

/** A document's type from its name, then from the subject of the email it came on. */
export function classifyDoc(fileName: string, subject = '', contentType = ''): DocType {
  const name = fileName.replace(/[_\-.]+/g, ' ');
  for (const [type, re] of RULES) if (re.test(name)) return type;
  if (/^image\//.test(contentType) || /\.(jpe?g|png|heic|webp)$/i.test(fileName)) return 'photos';
  for (const [type, re] of RULES) if (re.test(subject)) return type;
  return 'other';
}

/** Attachments that are never a deal document: signatures, calendar invites, signed-mail blobs. */
export function isJunkAttachment(fileName: string, contentType: string, bytes: number, inline: boolean): boolean {
  if (/\.(ics|vcf|p7s|p7m|asc|sig)$/i.test(fileName) || /pkcs7|calendar|vcard/i.test(contentType)) return true;
  // Logos and signature images ride along on every email a title office sends.
  if (/^image\//i.test(contentType) && (inline || bytes < 60_000)) return true;
  if (/^(image\d*|logo|outlook|signature)[\w-]*\.(png|jpe?g|gif)$/i.test(fileName)) return true;
  return bytes <= 0;
}

/**
 * The stage a contract on the deal moves it to, forward only: the seller's
 * purchase agreement puts a Prospect under contract, the assignment to the end
 * buyer puts it buyer-under-contract. Our own email of a purchase agreement to
 * the seller is the contract going out for signature, which moves nothing.
 *
 * An assignment only moves a deal that has its buyer on it and is already
 * under contract with the seller. A file named "Purchase Assignment" goes out
 * to buyers to sign and comes back from deals that fell through, so on its own
 * it put houses with no buyer at Buyer Under Contract (1317 E 3rd St, 405
 * Birchwood Ave, 8523 N Juniper St three times), each moved back by hand.
 */
export function stageFromDoc(stage: string | null, type: DocType, toSeller: boolean, hasBuyer = false): string | null {
  const cur = stage ?? 'Prospect';
  if (type === 'purchase_agreement' && !toSeller && cur === 'Prospect') return 'Under Contract Seller';
  if (type === 'assignment' && hasBuyer && ['Under Contract Seller', 'Ready To Market'].includes(cur)) return 'Buyer Under Contract';
  return null;
}
