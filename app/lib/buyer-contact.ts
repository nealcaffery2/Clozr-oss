// A buyer added by hand needs both a phone and an email: blasts go out by
// text and by email, and a buyer reachable on only one channel misses half of
// them. Pure checks, shared by every "add a buyer" form and createBuyer.
// Run the tests: npx tsx tools/buyer-contact.test.ts

/** name@domain.tld — light on purpose: an @, something before it, a dotted domain after. */
export function isValidEmail(raw: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test((raw ?? '').trim());
}

/** A US number: ten digits, formatting and a leading 1 allowed. */
export function isValidUsPhone(raw: string | null | undefined): boolean {
  const t = (raw ?? '').trim();
  if (/[a-z]/i.test(t)) return false;
  const d = t.replace(/\D/g, '');
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
}

/**
 * What is wrong with a buyer's phone and email, as one line for under the form,
 * or null when they pass. `requireBoth` is for a new buyer; an existing one
 * (legacy imports often carry only one) needs just one of the two, and
 * whatever is filled in still has to look right.
 */
export function buyerContactProblem(
  c: { phone?: string | null; email?: string | null }, requireBoth = true,
): string | null {
  const phone = (c.phone ?? '').trim(), email = (c.email ?? '').trim();
  if (requireBoth && !phone && !email) return 'Add the buyer\'s phone number and email.';
  if (requireBoth && !phone) return 'Add the buyer\'s phone number.';
  if (requireBoth && !email) return 'Add the buyer\'s email.';
  if (!phone && !email) return 'Add a phone number or an email.';
  if (phone && !isValidUsPhone(phone)) return 'Phone needs 10 digits, like (214) 555-0201.';
  if (email && !isValidEmail(email)) return 'Email needs to look like name@company.com.';
  return null;
}
