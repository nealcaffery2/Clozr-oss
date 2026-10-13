/**
 * Lane's knowledge: a generic transaction-coordinator playbook and
 * contract-to-close checklists, condensed to what an answer cites.
 *
 * This is a starting example. Replace it with your own team's playbook:
 * your title companies, lenders, escalation chain and state rules. Section
 * numbers are cited as refs ("Playbook §5"), so keep them stable once your
 * team relies on them. Nothing else in the function knows the content.
 */

export const PLAYBOOK = `
# Lane · TC playbook (example)
Single metric: on-time closes, no extensions. Lane reports to the workspace TC. Escalation: your operations lead (money, HUD/CD sign-off), your attorney (legal, POA, probate, state rules), your dispositions lead (buyer-side issues).

## §1 Principles
Close on time. When a blocker threatens the close date: name the blocker, find a legal and lender-acceptable substitute, say who approves the pivot, and draft the message now. Suggest and draft; the TC decides. Be specific about who to contact and why. No wires before the HUD/CD is signed off at T-2.

## §2 Daily cadence and day markers
Morning: sweep every open file by close date; note the day marker (D0, D3, D7, D10, T-5, T-3, T-2, T-1, CLOSE) and the next milestone. Midday: act on every flag, call any vendor silent for 24 hours. End of day: log progress and name tomorrow's first action. Milestones: D1 file open, D3 file complete, D7 title commitment, D10 clear to close, T-5 payoff confirmed, T-3 signings scheduled, T-2 HUD/CD review, T-1 wire instructions verified by phone.

## §3 Order on D1
Title order and contract to title, EMD instructions, seller payoff request if there is a mortgage, HOA estoppel if there is an HOA, attorney engagement in attorney states, probate counsel if heirs are involved.

## §4 Vendor clocks
At 24 hours of silence, draft the follow-up. At 48 hours, escalate. Title commitment: call on D6 if it is not in hand. Payoff, HOA and lien releases: status check on day 3, call direct on day 5.

## §5 Extension-prevention triggers
Yellow (act today): title commitment missing at D6, payoff missing at T-5, buyer EMD not wired within 48 hours of assignment, buyer's lender silent 24 hours. Red (escalate now): title commitment missing at D8, CTC missed at D10, HUD/CD not signed off at T-2, wire instructions not verified at T-1, any fraud signal.

## §6 HUD/CD review at T-2 (funding gate)
Walk every line: price matches the contract, payoff matches the latest letter, seller net, assignment or novation fee on its own line, title fees match the quote, EMD credited, prorations, no unexplained fees. Send the CD and review to your operations lead; wire only after their sign-off.

## §7 Novation day-1 checks
Confirm the property state allows the structure; some states restrict wholesaling or novation without a license, so check with your attorney. Verify the novation agreement and POA are signed and notarized per state rules, and record the memorandum by D3.

## §8 Status post format
[Address] | [Track] | [Day marker] | [GREEN/YELLOW/RED]
- Title: status and contact
- Buyer: financing and EMD
- Today: one action and its owner
- Next: the next day-marker checkpoint
`.trim();

export const CHECKLISTS = `
# TC checklists (example). D0 = signed contract received. T-x = days before close. No funding until the HUD/CD review at T-2 is signed off.

## Wholesale assignment: CTC by D10, close by D14
D1 verify the signed contract · D1 open title and send the contract · D1 seller intro call · D1 send the contract to dispositions · D2 EMD to title, receipt in writing · D3 confirm title has the full file · D7 title commitment in hand and reviewed · buyer assignment signed, buyer EMD verified · D10 clear to close · T-5 payoff confirmed · T-3 signings scheduled · T-2 HUD/CD review and sign-off · T-1 wire instructions verified by phone · CLOSE funded, final CD saved · +3 seller thank-you and buyer follow-up.

## Novation: file open by D3, title commitment by D7
D1 state check with your attorney · D1 novation agreement and POA verified · D1 open title with a company that has closed novations · D3 memorandum recorded · D4 listing live · D7 title commitment reviewed · retail contract to title · T-7 buyer's lender CTC confirmed · T-2 HUD/CD review and sign-off · T-1 wire verified · CLOSE funded · +3 file POA originals.
`.trim();
