// The seller record's stage bar, Likely next, the Make offer copy and the
// shortcut guard. Run with:  npx tsx tools/record-stage.test.ts
import { STAGE_STEPS, likelyNext, nextOfferBand, offerCopy, parseMoney, recommendStage, shortcutAllowed, stageBar } from '../app/components/record/record-logic';
import { SELLER_STAGE_LABELS } from '../lib/stages';
import { CLOZR_DATA } from '../lib/clozr-data';

let failed = 0;
let passed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (pass) passed++; else failed++;
};
const DEMO = CLOZR_DATA.STAGES as unknown as string[];

// ---- the five steps ---------------------------------------------------------
eq('five steps', [...STAGE_STEPS], ['Lead', 'Working', 'Offer', 'Contract', 'Closed']);
// Live list: every on-path group lands on its own step.
const live: [string, number | null][] = [
  ['New Submission', 0], ['Lead - No Contact', 0], ['Contacted - Follow Up Needed', 1], ['Appointment Set', 1],
  ['Nurture - Long Term (3+ Months)', 1], ['Underwriting', 2], ['Offer Made', 2], ['Offer Accepted', 2],
  ['Contract Sent to Seller', 3], ['Under Contract - Seller', 3], ['Memo Filed / Legal', 3], ['Closed', 4],
];
for (const [s, i] of live) eq(`live ${s} → step ${i}`, stageBar(s).index, i);
// Demo list.
const demo: [string, number][] = [
  ['New Lead', 0], ['Contacted', 1], ['Qualified', 1], ['Appointment', 1], ['Offer Sent', 2], ['Negotiation', 2],
  ['Under Contract', 3], ['Dispo', 3], ['Assigned', 3], ['Closing', 3], ['Closed', 4],
];
for (const [s, i] of demo) eq(`demo ${s} → step ${i}`, stageBar(s).index, i);
// Off the path: dead, refund, referral, other, the demo's Lost and anything unknown.
for (const s of ['Ghosted', 'Terminated', 'Refund - Listed', 'Referred to Realtor', 'Wholesaler', 'Lost', 'Something new']) {
  const b = stageBar(s);
  eq(`off path ${s}`, [b.index, b.offPath, b.label, b.steps.every((x) => x.state === 'todo')], [null, true, 'Off the path · ' + s, true]);
}
// Step states read done / current / todo.
eq('Offer Made states', stageBar('Offer Made').steps.map((x) => x.state), ['done', 'done', 'current', 'todo', 'todo']);
eq('Closed states', stageBar('Closed').steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'current']);
eq('Qualified label', stageBar('Qualified').label, 'Working');

// ---- Likely next: underwrite → offer → deal. Memo is never a step. ----------
eq('no activity yet → Underwriting', likelyNext('Qualified', DEMO), ['Underwriting']);
eq('demo Closing → next deal stage', likelyNext('Closing', DEMO), ['Closed']);
eq('demo Closed → nothing', likelyNext('Closed', DEMO), []);
eq('demo Lost → nothing', likelyNext('Lost', DEMO), []);
eq('offer out → accepted or declined', likelyNext('Offer Made', SELLER_STAGE_LABELS), ['Offer Accepted', 'Offer Declined']);
eq('accepted → first deal stage', likelyNext('Offer Accepted', SELLER_STAGE_LABELS), ['Under Contract Seller']);
eq('memo is not a next stage', likelyNext('Memo Filed / Legal', SELLER_STAGE_LABELS), ['Ready To Market']);
eq('memo never appears', likelyNext('Under Contract - Seller', SELLER_STAGE_LABELS).includes('Memo Filed / Legal'), false);
eq('live Closed → nothing', likelyNext('Closed', SELLER_STAGE_LABELS), []);
eq('live Ghosted → nothing', likelyNext('Ghosted', SELLER_STAGE_LABELS), []);
eq('compr report → underwrite complete', recommendStage({
  stage: 'Qualified', activity: [{ type: 'compr', title: 'Underwriting report generated', body: 'ARV $318,000' }],
}).stage, 'Underwriting Complete');
eq('offer talk leans yes', recommendStage({
  stage: 'Qualified',
  activity: [
    { type: 'compr', title: 'Underwriting report generated' },
    { type: 'offer', title: 'Offer viewed by seller' },
    { type: 'email', body: 'we are both comfortable with the price' },
  ],
}).stage, 'Offer Accepted');
eq('under contract follows the deal', recommendStage({ stage: 'Under Contract - Seller', dealStage: 'Ready To Market', activity: [] }).stage, 'Buyer Under Contract');
// Read entry by entry: a phrase deep in one long email among many still counts,
// and a no in one entry reads as a no.
const filler = Array.from({ length: 200 }, (_, i) => ({ type: 'email', body: '<div>' + 'x'.repeat(2000) + i + '</div>' }));
eq('a yes deep in a long feed', recommendStage({
  stage: 'Offer Made', activity: [...filler, { type: 'email', body: '<p>We’ll take it. Send the paperwork.</p>' }],
}).stage, 'Offer Accepted');
eq('a no deep in a long feed', recommendStage({
  stage: 'Offer Made', activity: [...filler, { type: 'sms_in', body: 'Not interested, thanks' }],
}).stage, 'Offer Declined');
eq('no underwrite in a long feed', recommendStage({ stage: 'Contacted', activity: filler }).stage, 'Underwriting');

// ---- the offer sheet's promises ---------------------------------------------
const logs = offerCopy({ live: true });
eq('log: action', logs.action, 'Log offer');
eq('log: price on the deal', logs.when.some((w) => /goes on the deal as its offer price/.test(w)), true);
eq('log: moves to Offer Made', logs.when.some((w) => /moves to Offer Made/.test(w)), true);
eq('log: never drafts or sends', logs.when.some((w) => /Nothing is sent and no letter is drafted/.test(w)), true);
eq('log: no TC, no task', logs.when.some((w) => /TC|task|Casey/i.test(w)), false);
eq('demo says nothing is saved', offerCopy({ live: false }).when.at(-1), 'This is the demo: nothing is saved.');

// ---- money and the shortcut guard ----------------------------------------------
eq('money $231,500', parseMoney('$231,500'), 231500);
eq('money blank', parseMoney(''), null);
eq('money zero', parseMoney('0'), null);
eq('band types a new low', nextOfferBand(180000, '$190,000'), 190000);
eq('band unchanged', nextOfferBand(180000, '180,000'), 'keep');
eq('band clears', nextOfferBand(180000, ''), null);
eq('band blank stays blank', nextOfferBand(null, '—'), 'keep');
eq('band rejects junk', nextOfferBand(180000, 'abc'), 'keep');
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...extra });
eq('c on the page', shortcutAllowed(key('c'), { tagName: 'BODY' }), true);
eq('c in an input', shortcutAllowed(key('c'), { tagName: 'INPUT' }), false);
eq('c in a textarea', shortcutAllowed(key('c'), { tagName: 'TEXTAREA' }), false);
eq('c in a select', shortcutAllowed(key('c'), { tagName: 'SELECT' }), false);
eq('c in contenteditable', shortcutAllowed(key('c'), { tagName: 'SPAN', isContentEditable: true }), false);
eq('c on the COMPR iframe', shortcutAllowed(key('c'), { tagName: 'IFRAME' }), false);
eq('⌘C', shortcutAllowed(key('c', { metaKey: true }), { tagName: 'BODY' }), false);
eq('IME composing', shortcutAllowed(key('c', { isComposing: true }), { tagName: 'BODY' }), false);
eq('IME keyCode 229', shortcutAllowed(key('Process', { keyCode: 229 }), { tagName: 'BODY' }), false);
eq('auto-repeat', shortcutAllowed(key('c', { repeat: true }), { tagName: 'BODY' }), false);
eq('already handled', shortcutAllowed(key('c', { defaultPrevented: true }), { tagName: 'BODY' }), false);
eq('c on Save note in the composer', shortcutAllowed(key('c'), { tagName: 'BUTTON', closest: (sel: string) => (sel.includes('record-composer') ? {} : null) }), false);
eq('c on a button elsewhere on the record', shortcutAllowed(key('c'), { tagName: 'BUTTON', closest: () => null }), true);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} record-stage checks passed`);
process.exit(failed ? 1 : 0);
