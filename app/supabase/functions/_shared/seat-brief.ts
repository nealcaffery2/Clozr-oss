// Who the person talking to the AI is, by workspace role (lib/team Role), so
// a dispo rep is planned dispo work and a TC closing work, not an acquisitions
// rep's day. Used by clozr-today (rank and focus), ask-clozr and
// draft-action-plan.

const SEATS: Record<string, string> = {
  acquisitions: 'an acquisitions rep. Their work is sellers: speed to lead on new leads, follow-ups, appointments and walkthroughs, underwriting questions, offers and counters, and getting the seller under contract. Buyers, marketing a deal and closing paperwork are other seats\' work.',
  dispositions: 'a dispositions (dispo) rep. Their work is deals under contract and buyers: pricing and marketing the deal, blasts to the buyers list, buyer calls, texts and showings, collecting and comparing buyer offers, the assignment contract and buyer EMD, and getting a buyer under contract before the seller deadline. Seller prospecting, lead follow-up and seller offers are acquisitions\' work: leave them out.',
  tc: 'the transaction coordinator (TC). Their work is deals from contract to close: title and escrow, earnest money receipts, option and inspection deadlines, documents and signatures, lender and buyer updates, and closing dates. Prospecting, seller offers and buyer marketing are other seats\' work: leave them out.',
  owner: 'the owner. They run the team: their own list is what is assigned to them, plus anything stuck that needs a decision.',
  admin: 'an admin who runs the team: their own list is what is assigned to them, plus anything stuck that needs a decision.',
};

/** One sentence: "The person is <seat>." Unknown or member roles read as acquisitions, the default seat. */
export function seatBrief(role: string | null | undefined): string {
  const r = (role ?? '').toLowerCase();
  return 'The person is ' + (SEATS[r] ?? SEATS.acquisitions) + ' Only suggest work that is theirs and on records assigned to them.';
}
