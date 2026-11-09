// lib/deal-memory.ts: conflict and missing-item rules, cleaning, staleness.
// Run with:  npx tsx tools/deal-memory.test.ts
import {
  claimsFrom, cleanDealMemory, demoDealMemory, displayTerm, eventState, fallbackDealMemory, inputFingerprint, isStale,
  issueCounts, mergeIssues, missingItems, normStructure, rowToDealMemory, sortIssues, sourceLabel, termConflicts,
  type DealInput, type DealIssue,
} from '../lib/deal-memory';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const base = (over: Partial<DealInput> = {}): DealInput => ({
  dealId: 7, address: '4873 Orchard Dr', stage: 'Buyer Under Contract', now: '2026-10-21T15:00:00Z',
  deal: { offer_amount: 168000, assignment_fee: 5000, transaction_type: 'Assignment', contract_date: '2026-10-02', close_date: '2026-10-30', buyer_id: 3 },
  titleCompany: 'Example Title', tc: null,
  docs: [
    { ref: 'doc:c1', name: 'Purchase agreement', type: 'purchase_agreement', at: '2026-10-02', signed: true },
    { ref: 'doc:c2', name: 'Assignment', type: 'assignment', at: '2026-10-10', signed: true },
  ],
  extractions: [
    { docRef: 'doc:c1', docType: 'purchase_agreement', key: 'purchase_price', value: '$168,000.00', page: 1, confidence: 0.95 },
    { docRef: 'doc:c2', docType: 'assignment', key: 'assignment_fee', value: '$7,500.00', page: 2, confidence: 0.9 },
    { docRef: 'doc:c2', docType: 'assignment', key: 'purchase_price', value: '$175,500', page: 2, confidence: 0.9 },
  ],
  messages: [
    { ref: 'msg:1', kind: 'email', at: '2026-10-12T14:05:00Z', who: 'Dana at Example Title', subject: 'Title opened', text: 'Since this one is a double close we need the funding letter.' },
  ],
  activity: [],
  parties: [{ ref: 'party:1', role: 'title', name: 'Dana White', company: 'Example Title', email: 'dana@exampletitle.com', phone: null }],
  ...over,
});

// ---- structure words ----
check('double close', normStructure('Double Close') === 'double_close');
check('double closing in a sentence', normStructure('we are double closing this') === 'double_close');
check('assignment', normStructure('Assignment') === 'assignment' && normStructure('assignment') === 'assignment');
check('novation', normStructure('Novation') === 'novation');
check('nothing', normStructure('') === null && normStructure('cash') === null);

// ---- the TC's question: double close vs assignment, $7,500 vs $5,000 ----
const input = base();
const claims = claimsFrom(input);
check('deal field claim', claims.some((c) => c.key === 'assignment_fee' && c.ref === 'field:assignment_fee'));
check('PDF claim with its page', claims.some((c) => c.key === 'assignment_fee' && c.ref === 'doc:c2' && c.page === 2));
check('the assignment price is the end buyer price', claims.some((c) => c.key === 'buyer_price' && c.ref === 'doc:c2'));
check('email says double close', claims.some((c) => c.key === 'structure' && c.ref === 'msg:1'));
const conflicts = termConflicts(claims);
const fee = conflicts.find((i) => i.topic === 'assignment_fee');
const structure = conflicts.find((i) => i.topic === 'structure');
check('fee conflict found', !!fee, conflicts);
check('fee conflict names both numbers and the page', !!fee && /\$7,500/.test(fee.text) && /\$5,000/.test(fee.text) && /page 2/.test(fee.text), fee?.text);
check('fee conflict cites the PDF page', !!fee && fee.sources.some((s) => s.ref === 'doc:c2' && s.page === 2));
check('structure conflict found', !!structure && /double close/.test(structure.text) && /assignment/.test(structure.text), structure?.text);
check('structure conflict cites the email', !!structure && structure.sources.some((s) => s.ref === 'msg:1'));
check('no conflict on agreeing purchase price', !conflicts.some((i) => i.topic === 'purchase_price'));
check('conflict text has no slop', conflicts.every((i) => slopFindings(i.text).length === 0), conflicts.map((i) => slopFindings(i.text)));

// Same value written two ways is not a conflict.
const same = termConflicts(claimsFrom(base({ extractions: [{ docRef: 'doc:c2', docType: 'assignment', key: 'assignment_fee', value: '$5,000.00', page: 2, confidence: 1 }], messages: [] })));
check('$5,000.00 and 5000 agree', !same.some((i) => i.topic === 'assignment_fee'), same);

// Fee said in a text.
const texted = claimsFrom(base({ messages: [{ ref: 'msg:2', kind: 'sms', at: '2026-10-11T20:00:00Z', who: 'Marcus', subject: null, text: 'ok the assignment fee is $7.5k, wiring Monday' }] }));
check('fee in a text', texted.some((c) => c.ref === 'msg:2' && c.key === 'assignment_fee' && Number(c.value) === 7500), texted.filter((c) => c.ref === 'msg:2'));

// ---- missing items ----
const missing = missingItems(input, claims);
check('no EMD receipt is flagged', missing.some((i) => i.topic === 'emd_receipt'), missing);
check('EMD 19 days after signing is high', missing.find((i) => i.topic === 'emd_receipt')?.severity === 'high');
check('purchase agreement on file is not flagged', !missing.some((i) => i.topic === 'purchase_agreement'));
check('assignment on file is not flagged', !missing.some((i) => i.topic === 'assignment_contract'));
const emdIn = missingItems(base({ tc: { ref: 'tc:1', row: { emd_received_at: '2026-10-06T00:00:00Z' } } }));
check('EMD received on the TC file clears it', !emdIn.some((i) => i.topic === 'emd_receipt'));
const noAssign = missingItems(base({ docs: [{ ref: 'doc:c1', name: 'PSA', type: 'purchase_agreement', at: null, signed: true }] }));
check('buyer with no assignment is flagged', noAssign.some((i) => i.topic === 'assignment_contract'));
const late = missingItems(base({ deal: { ...base().deal, close_date: '2026-10-15' } }));
check('passed closing date is flagged', late.some((i) => i.topic === 'closing_date' && i.severity === 'high'));
const prospect = missingItems(base({ stage: 'Prospect', deal: {}, docs: [] }));
check('a prospect owes nothing', prospect.length === 0, prospect);
const closed = missingItems(base({ stage: 'Closed' }));
check('a closed deal owes nothing', closed.length === 0);

// ---- order and merge ----
const mk = (kind: DealIssue['kind'], topic: string, severity: DealIssue['severity']): DealIssue => ({ kind, topic, severity, text: topic, sources: [] });
const sorted = sortIssues([mk('missing', 'a', 'high'), mk('conflict', 'b', 'low'), mk('conflict', 'c', 'high')]);
check('conflicts first, then severity', sorted.map((i) => i.topic).join() === 'c,b,a');
const merged = mergeIssues([mk('conflict', 'structure', 'high')], [mk('conflict', 'structure', 'high'), mk('missing', 'emd_receipt', 'medium')]);
check('merge drops a rule on a topic the model raised', merged.length === 2 && merged.filter((i) => i.topic === 'structure').length === 1);

// ---- cleaning model output ----
const cleaned = cleanDealMemory({
  brief: 'Under contract — closing Oct 30.',
  issues: [{ kind: 'conflict', topic: 'Assignment Fee', severity: 'high', text: 'Fee differs.', sources: [{ ref: 'doc:c2', quote: 'x', page: 2 }, { ref: 'made:up', quote: null, page: null }] }],
  terms: [{ key: 'assignment_fee', value: '$7,500', confidence: 3, sources: [] }, { key: 'bogus', value: 'x', confidence: 1, sources: [] }, { key: 'assignment_fee', value: 'dup', confidence: 1, sources: [] }],
  timeline: [{ date: 'October 30, 2026', label: 'Closing', done: false, sources: [] }, { date: '2026-10-02', label: 'Signed', done: true, sources: [] }],
  parties: [{ name: 'Dana', role: 'title', company: null, email: null, phone: null }, { name: '', role: 'x', company: null, email: null, phone: null }],
}, { 'doc:c2': { kind: 'contract', label: 'Assignment', at: null } });
check('em dash removed', !cleaned.brief.includes('—'), cleaned.brief);
check('unknown source dropped', cleaned.issues[0].sources.length === 1 && cleaned.issues[0].sources[0].ref === 'doc:c2');
check('topic normalised', cleaned.issues[0].topic === 'assignment_fee');
check('bad and duplicate terms dropped, confidence clamped', cleaned.terms.length === 1 && cleaned.terms[0].confidence === 1);
check('timeline dates read and sorted', cleaned.timeline[0].date === '2026-10-02' && cleaned.timeline[1].date === '2026-10-30', cleaned.timeline);
check('nameless party dropped', cleaned.parties.length === 1);

// ---- staleness, fingerprint, events ----
check('newer input is stale', isStale({ updated_at: '2026-10-20T10:00:00Z' }, '2026-10-20T11:00:00Z'));
check('older input is not stale', !isStale({ updated_at: '2026-10-20T10:00:00Z' }, '2026-10-20T09:00:00Z'));
check('no memory is not stale', !isStale(null, '2026-10-20T09:00:00Z'));
check('no input is not stale', !isStale({ updated_at: '2026-10-20T10:00:00Z' }, null));
check('fingerprint is stable', inputFingerprint([1, 'a', null]) === inputFingerprint([1, 'a', null]));
check('fingerprint changes with input', inputFingerprint([1, 'a']) !== inputFingerprint([1, 'b']));
check('event done', eventState({ date: '2026-10-01', done: true }, '2026-10-21T00:00:00Z') === 'done');
check('event overdue', eventState({ date: '2026-10-01', done: false }, '2026-10-21T00:00:00Z') === 'overdue');
check('event upcoming', eventState({ date: '2026-10-30', done: false }, '2026-10-21T00:00:00Z') === 'upcoming');

// ---- display ----
check('money display', displayTerm('assignment_fee', '7500') === '$7,500');
check('date display', displayTerm('closing_date', '2026-10-30') === 'Oct 30, 2026', displayTerm('closing_date', '2026-10-30'));
check('counts label', issueCounts({ issues: [mk('conflict', 'a', 'high'), mk('conflict', 'b', 'high'), mk('missing', 'c', 'low')] }).label === '2 conflicts, 1 missing');
check('clear label', issueCounts({ issues: [] }).label === 'No conflicts found');

// ---- fallback and demo ----
const fb = fallbackDealMemory(input);
check('fallback has a brief', fb.brief.length > 20, fb.brief);
check('fallback carries the rule conflicts', fb.issues.some((i) => i.topic === 'assignment_fee') && fb.issues[0].kind === 'conflict');
check('fallback terms', fb.terms.some((t) => t.key === 'purchase_price' && t.value === '$168,000'));
check('fallback brief has no slop', slopFindings(fb.brief).length === 0, slopFindings(fb.brief));
const demo = demoDealMemory({ dealId: 9001, address: '4873 Orchard Dr' });
check('demo leads with the structure conflict', demo.issues[0].kind === 'conflict' && demo.issues[0].topic === 'structure');
check('demo has the $7,500 vs $5,000 conflict', demo.issues.some((i) => /\$7,500/.test(i.text) && /\$5,000/.test(i.text)));
check('demo cites resolve', demo.issues.every((i) => i.sources.every((s) => s.ref in demo.sources)));
check('demo text has no slop', [demo.brief, ...demo.issues.map((i) => i.text)].every((t) => slopFindings(t).length === 0),
  [demo.brief, ...demo.issues.map((i) => i.text)].map((t) => slopFindings(t)));
check('source label with page', sourceLabel({ ref: 'doc:c2', quote: null, page: 2 }, demo.sources) === 'Assignment of contract, p. 2');
check('source label for an email', /^Email · Oct 12$/.test(sourceLabel({ ref: 'msg:1', quote: null, page: null }, demo.sources)));
const row = rowToDealMemory({ workspace_id: 1, deal_id: 7, body: demo, sources: demo.sources, updated_at: '2026-10-20T00:00:00Z', model: 'x' });
check('row round trip', !!row && row.issues.length === demo.issues.length && row.terms.length === demo.terms.length);
check('junk row is null', rowToDealMemory(null) === null && rowToDealMemory({}) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
