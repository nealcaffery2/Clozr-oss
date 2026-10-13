// The Podio live sync's pure half: reading a live item the way the Excel
// snapshot was read, matching it to the record the snapshot wrote, and the
// field and stage rules. Also the Jotform edit rule and the card's summary.
//
// Pure functions, no network. Run with:  npx tsx tools/podio-sync.test.ts

import { buildPlan, type Row } from '../lib/podio-excel';
import {
  appliedSnapshot, durationSeconds, itemRow, partnerOfSourceId, pickPipelineDeal, pickSubmissionDeal, pipelineStage, podioIso, podioTime, readAcquisition,
  leadAddress, readComm, readSubmission, sellerStageOf, sinceFrom, stageMove, submissionPrefix, submissionSourceId, syncPatch, historyLines, commentText,
  podioOptionFor, pushDecision, podioMoney, valuesPush,
  addressVariants, cursorAfterPage, duplicateArchiveNote, historyCallCap, matchRoster, mergePodioBlock, MAPPING_VERSION, pickAnySourceDeal, pickZipTwin,
  podioBlock, PODIO_BLOCK_END, PODIO_BLOCK_START, resumeOffset, sameProperty, stopSyncPage, tokenWarnings, unchangedSince,
} from '../supabase/functions/_shared/podio-sync';
import { addressKey, parseAddress } from '../supabase/functions/_shared/podio-keys';
import { jotIso, needsApply } from '../supabase/functions/_shared/jotform-sync';
import { syncProgress, syncSummary } from '../lib/podio';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

// ---- a Podio Submissions item, in the API's shapes ---------------------------
let fid = 0;
const text = (label: string, value: string) => ({ field_id: ++fid, external_id: label.toLowerCase().replace(/\W+/g, '-'), type: 'text', label, values: [{ value }] });
const money = (label: string, value: string) => ({ field_id: ++fid, external_id: 'm' + fid, type: 'money', label, values: [{ value, currency: 'USD' }] });
const cat = (label: string, t: string) => ({ field_id: ++fid, external_id: 'c' + fid, type: 'category', label, values: [{ value: { id: 1, text: t } }] });
const phone = (label: string, type: string, value: string) => ({ field_id: ++fid, external_id: 'p' + fid, type: 'phone', label, values: [{ type, value }] });
const email = (label: string, type: string, value: string) => ({ field_id: ++fid, external_id: 'e' + fid, type: 'email', label, values: [{ type, value }] });
const loc = (label: string, value: string, parts: Record<string, string> = {}) => ({ field_id: ++fid, external_id: 'l' + fid, type: 'location', label, values: [{ value, formatted: value, ...parts }] });

const item = {
  item_id: 9001, created_on: '2026-08-02 14:03:11', last_event_on: '2026-10-01 09:30:00', link: 'https://podio.com/x/items/9001',
  created_by: { name: 'Morgan Lane' },
  fields: [
    text('Entity Name', 'Mark Spain - NC'),
    loc('Property Address', '425 Lakeshore Avenue, High Point, NC 27263', { street_number: '425', street_address: 'Lakeshore Avenue', city: 'High Point', state: 'NC', postal_code: '27263' }),
    text('First Name', 'Dana'), text('Last Name', 'Kline'),
    phone('Phone', 'mobile', '(336) 555-0142'), email('Email', 'work', 'Dana@MarkSpain.com'),
    cat('Stage', 'Underwriting  Complete'),
    money('What price are you asking? (Your contract price including your fee)', '160.0000'),
    money('ARV in your opinion', '245000.0000'), money('Offer Price', '150000.0000'), money('UW Suggested High Offer', '155000.0000'), money('UW Suggested Low Offer', '140000.0000'),
    money('EMD', '1000.0000'), text('Occupied?', 'Vacant'), text('Bedrooms', '3'),
  ],
};

const r = itemRow(item);
check('money field → "<label> - amount" like the export', r['Offer Price - amount'] === '150000.0000', r['Offer Price - amount']);
check('phone field → "Phone - Mobile"', r['Phone - Mobile'] === '(336) 555-0142');
check('email field → "Email - Work"', r['Email - Work'] === 'Dana@MarkSpain.com');
check('category → its text', r['Stage'] === 'Underwriting  Complete');
check('Created on is ISO without zone, like openpyxl', r['Created on'] === '2026-08-02T14:03:11', r['Created on']);

const s = readSubmission(item);
check('partner key folds "Mark Spain - NC"', s.partner_key === 'markspain', s.partner_key);
check('double-spaced Podio stage maps (submissionStage)', s.stage === 'Underwriting Complete', s.stage);
check('asking typed in thousands → $160,000', s.cols.asking_price === 160000, s.cols.asking_price);
check('offer, MAO, EMD read', s.cols.offer_amount === 150000 && s.cols.mao === 155000 && s.cols.earnest_money === 1000);
check('low / high offer read into the offer band', s.cols.wholesale_offer === 140000 && s.cols.institutional_offer === 155000, [s.cols.wholesale_offer, s.cols.institutional_offer]);
check('contact phone in E.164, email lowercased', s.phone === '+13365550142' && s.email === 'dana@markspain.com', [s.phone, s.email]);
check('person kept when two real words', s.person === 'Dana Kline');
check('last_event_on → ISO', s.last_event_on === '2026-10-01T09:30:00Z');
check('facts read with the Excel import\'s bounds', s.facts.beds === 3);

// The same submission as an Excel row: the snapshot's source_id starts with the prefix the sync looks up.
const row: Row = {
  'Entity Name': 'Mark Spain - NC', 'Property Address': '425 Lakeshore Avenue, High Point, NC 27263', 'First Name': 'Dana', 'Last Name': 'Kline',
  'Phone - Mobile': '(336) 555-0142', 'Email - Work': 'dana@markspain.com', Stage: 'Underwriting Complete', 'Created on': '2026-08-02T14:03:11',
};
const plan = buildPlan({ submissions: [row], dealStage: [], activeDeals: [] });
const sid = plan.leads[0]?.source_id ?? '';
check('live item finds the Excel import\'s source_id by prefix', s.address_keys.some((k) => sid.startsWith(submissionPrefix(k, s.partner_key))), { sid, keys: s.address_keys });
check('a new submission gets the Excel shape', submissionSourceId(s) === sid, [submissionSourceId(s), sid]);
check('partner read back out of a source_id', partnerOfSourceId(sid) === 'markspain' && partnerOfSourceId('submission:1 A ST|78254|-|2026') === null);

const street = readSubmission({ ...item, fields: item.fields.map((f) => (f.label === 'Property Address' ? loc('Property Address', '425 Lakeshore Ave., High Point, North Carolina, 27263') : f)) });
check('"Avenue" / "Ave." / state name all key the same', street.address_keys[0] === s.address_keys[0], [street.address_keys, s.address_keys]);

const blankStage = readSubmission({ ...item, fields: item.fields.filter((f) => f.label !== 'Stage') });
check('blank Podio stage maps to New Submission (Excel rule)', blankStage.stage === 'New Submission' && blankStage.podio_stage === '');
const oddStage = readSubmission({ ...item, fields: item.fields.map((f) => (f.label === 'Stage' ? cat('Stage', 'Waiting on Seller Docs') : f)) });
check('unknown Podio stage → null (unmapped)', oddStage.stage === null && oddStage.podio_stage === 'Waiting on Seller Docs');

const testSub = readSubmission({ ...item, fields: item.fields.map((f) => (f.label === 'Entity Name' ? text('Entity Name', 'Test LLC') : f)) });
check('a test submission is flagged (Excel skipped them)', testSub.test && !s.test);

// ---- matching -----------------------------------------------------------------
const K = s.address_keys[0];
const cand = (id: number, partner: string | null, extra: Record<string, unknown> = {}) => ({ id, source_id: `submission:${K}|${partner ?? '-'}|2026-0${id % 9}-01T00:00:00`, ...extra });
const m1 = pickSubmissionDeal([cand(1, 'offerpad'), cand(2, 'markspain')], s);
check('same address, same partner → that deal', !!m1 && 'id' in m1 && m1.id === 2, m1);
const m2 = pickSubmissionDeal([cand(1, 'offerpad')], s);
check('same address, other partner only → new lead (Excel kept them apart)', m2 === null, m2);
const m3 = pickSubmissionDeal([cand(1, 'offerpad'), cand(3, 'chrisminter', { seller_phone_key: '+13365550142' })], s);
check('partner key differs but the contact\'s phone matches → that deal', !!m3 && 'id' in m3 && m3.id === 3, m3);
const noPartner = { ...s, partner_key: null };
const m4 = pickSubmissionDeal([cand(4, 'offerpad')], noPartner);
check('no partner on the item, one deal on the address → it', !!m4 && 'id' in m4 && m4.id === 4);
const m5 = pickSubmissionDeal([cand(4, 'offerpad'), cand(5, 'markspain')], noPartner);
check('no partner, several deals, no contact → ambiguous (nothing written)', !!m5 && 'ambiguous' in m5, m5);
check('nothing on the address → new', pickSubmissionDeal([], s) === null);

const p1 = pickPipelineDeal([
  { id: 10, source_id: `submission:${K}|offerpad|2026-01-01`, stage: 'Prospect', submitted_at: '2026-01-01' },
  { id: 11, source_id: `submission:${K}|markspain|2026-02-01`, stage: 'Under Contract Seller', submitted_at: '2026-02-01' },
], null);
check('Deals item → the deal already on the pipeline', !!p1 && 'id' in p1 && p1.id === 11, p1);
const p2 = pickPipelineDeal([
  { id: 10, source_id: `submission:${K}|offerpad|2026-03-01`, stage: 'Prospect', submitted_at: '2026-03-01' },
  { id: 12, source_id: `submission:${K}|markspain|2026-02-01`, stage: 'Prospect', submitted_at: '2026-02-01' },
], 'markspain');
check('all Prospect → the wholesaler\'s submission', !!p2 && 'id' in p2 && p2.id === 12, p2);
const p3 = pickPipelineDeal([
  { id: 10, source_id: `submission:${K}|offerpad|2026-03-01`, stage: 'Prospect', submitted_at: '2026-03-01' },
  { id: 12, source_id: `submission:${K}|ifinder|2026-02-01`, stage: 'Prospect', submitted_at: '2026-02-01' },
], 'markspain');
check('no wholesaler match → the newest', !!p3 && 'id' in p3 && p3.id === 10, p3);

// ---- the field rule ----------------------------------------------------------------
const cur = { offer_amount: 150000, arv: null, rehab: 30000, motivation: 'Tired landlord', notes: 'kept' };
check('first link fills empties only', JSON.stringify(syncPatch(cur, { offer_amount: 140000, arv: 245000, rehab: null }, null)) === JSON.stringify({ arv: 245000 }));
check('an empty Podio value never blanks', Object.keys(syncPatch(cur, { motivation: '', rehab: null }, { motivation: 'x' })).length === 0);
check('changed in Podio since last applied → overwrite', syncPatch(cur, { offer_amount: 140000 }, { offer_amount: 150000 }).offer_amount === 140000);
check('a CLOZR edit stands while Podio is unchanged', Object.keys(syncPatch({ offer_amount: 152000 }, { offer_amount: 150000 }, { offer_amount: 150000 })).length === 0);
check('numbers compare as numbers ("150000.00" = 150000)', Object.keys(syncPatch({ offer_amount: '150000.00' }, { offer_amount: 150000 }, null)).length === 0);
check('snapshot keeps old keys, drops empties, stamps the field-map version', JSON.stringify(appliedSnapshot({ a: 1, b: 2 }, { b: 3, c: null, d: '' })) === JSON.stringify({ a: 1, b: 3, __v: 2 }));

// ---- the stage rule ----------------------------------------------------------------
check('new mapped stage → set', stageMove({ label: 'Offer Accepted', mapped: 'Offer Accepted', current: 'Offer Made' }).kind === 'set');
check('unmapped label → logged, stage untouched', JSON.stringify(stageMove({ label: 'Waiting', mapped: null, current: 'Offer Made' })) === JSON.stringify({ kind: 'unmapped', label: 'Waiting' }));
check('same as CLOZR → keep', stageMove({ label: 'Offer Made', mapped: 'Offer Made', current: 'Offer Made' }).kind === 'keep');
const again = stageMove({ label: 'Offer Made', mapped: 'Offer Made', current: 'Offer Accepted', lastApplied: 'Offer Made' });
check('CLOZR moved on, Podio unchanged → keep', again.kind === 'keep' && again.why === 'unchanged in Podio', again);
const human = stageMove({ label: 'Offer Declined', mapped: 'Offer Declined', current: 'Offer Accepted', lastApplied: 'Offer Made', movedInClozrSince: true });
check('a person moved it in CLOZR after Podio\'s change → keep', human.kind === 'keep' && human.why === 'moved in CLOZR since');
check('blank Podio stage never moves an existing record', stageMove({ label: '', mapped: 'New Submission', current: 'Offer Made' }).kind === 'keep');
check('Deals labels: "UC - Buyer" → Buyer Under Contract, "Marketing" → Ready To Market', pipelineStage('UC - Buyer') === 'Buyer Under Contract' && pipelineStage('Marketing') === 'Ready To Market');
check('Deals label CLOZR lacks → null', pipelineStage('On Hold') === null);

// ---- time windows ------------------------------------------------------------------
check('Podio time format', podioTime(new Date('2026-10-03T12:34:56.789Z')) === '2026-10-03 12:34:56');
check('window starts ten minutes before the last pass', sinceFrom('2026-10-03T12:00:00.000Z') === '2026-10-03 11:50:00');
check('no last pass → everything (backfill)', sinceFrom(null) === null);
check('podioIso', podioIso('2026-10-03 12:00:00') === '2026-10-03T12:00:00Z' && podioIso(null) === null);

// ---- Jotform edits -----------------------------------------------------------------
check('Jotform time → ISO', jotIso('2026-10-02 08:15:00') === '2026-10-02T08:15:00Z' && jotIso('') === undefined && jotIso(null) === undefined);
check('unseen submission → apply', needsApply({ updated_at: null }, undefined));
check('seen, never edited → skip', !needsApply({ updated_at: null }, { source_updated_at: null }));
check('seen, edited, no updated_at recorded → apply once', needsApply({ updated_at: '2026-10-02 08:15:00' }, { source_updated_at: null }));
check('edited after what was applied → apply', needsApply({ updated_at: '2026-10-02 08:15:00' }, { source_updated_at: '2026-10-01T08:15:00Z' }));
check('already applied this edit → skip', !needsApply({ updated_at: '2026-10-02 08:15:00' }, { source_updated_at: '2026-10-02T08:15:00Z' }));

// ---- the Settings card's lines -----------------------------------------------------
const counts = { seen: 212, unchanged: 190, created: 3, updated: 14, stage_moves: 1, unmapped: 2, ambiguous: 0, skipped: 0, failed: 0 };
check('run summary', syncSummary({ counts }) === '212 read · 3 new · 14 updated · 1 stage move · 2 with a stage CLOZR does not have', syncSummary({ counts }));
check('progress line', JSON.stringify(syncProgress({ submissions: { done: 300, of: 3700, full: true }, deals: null })) === JSON.stringify(['Submissions: first pass, 300 of 3,700']));

// ---- Acme Homes › Acquisitions and Communications ------------------------------
const acq = readAcquisition({
  item_id: 9001, created_on: '2025-03-04 15:00:00', last_event_on: '2026-10-01 12:00:00', link: 'https://podio.com/x/9001',
  fields: [
    text('Seller Name', 'Maria Lopez'),
    { field_id: ++fid, external_id: 'seller-phone', type: 'phone', label: 'Seller Phone', values: [{ type: 'mobile', value: '(210) 555-0101' }, { type: 'work', value: '210.555.0102' }] },
    email('Seller Email', 'home', 'Maria@Example.com'), loc('Property Location', '425 Lakeshore Ave, High Point, NC 27263'),
    cat('Lead Stage', 'offer made'), money("Seller's Asking Price", '185000'), text('Seller Notes', 'Wants to move by spring'),
    text('Bedrooms', '3'), text('YEAR BUILD', '1978'),
  ],
});
check('acquisition: name, phones, email', acq.name === 'Maria Lopez' && acq.phones.join() === '+12105550101,+12105550102' && acq.emails.join() === 'maria@example.com', acq);
check('acquisition: address and stage label', acq.address?.line1 === '425 Lakeshore Ave' && acq.podio_stage === 'offer made' && acq.address_keys.length > 0);
check('acquisition: columns and facts', acq.cols.asking_price === 185000 && acq.cols.notes === 'Wants to move by spring' && acq.facts.beds === 3 && acq.facts.year_built === 1978, acq.cols);
const la = leadAddress('44111 Ohio 3232 W 110th St');
check('lead address: zip and state in front', la?.line1 === '3232 W 110th St' && la.state === 'OH' && la.zip === '44111', la);
check('lead address: state code in front', leadAddress('OH 6340 Larkspur Drive')?.line1 === '6340 Larkspur Drive' && leadAddress('OH 6340 Larkspur Drive')?.state === 'OH');
const lb = leadAddress('76112 Texas 5528 Fernley St, Fort Worth, TX 76112, USA');
check('lead address: prefix then a full address', lb?.line1 === '5528 Fernley St' && lb.city === 'Fort Worth' && lb.state === 'TX', lb);
check('lead address: a plain address untouched', leadAddress('123 Main St, Dayton, OH 45402')?.line1 === '123 Main St');
check('acquisition: "Property Address" label', readAcquisition({ item_id: 3, fields: [text('Property Address', 'TX 3250 Hollis Avenue')] }).address?.line1 === '3250 Hollis Avenue');
check('acquisition: an address is not a name', readAcquisition({ item_id: 1, fields: [text('Seller Name', '12 Oak St')] }).name === null);
check('seller stage: same vocabulary, forgiving case', sellerStageOf('offer made', ['Lead', 'Offer Made']) === 'Offer Made' && sellerStageOf('Hot', ['Lead']) === null);

const LBL = ['Dead', 'Dead - Wrong Info', 'Offer Made - Retail', 'Asking Retail / Not Motivated', 'Nurture - Long Term (3+ Months)', 'Contacted - Follow Up Needed'];
check('seller stage: punctuation forgiven', sellerStageOf('Offer Made-Retail', LBL) === 'Offer Made - Retail' && sellerStageOf('Asking Retail/ not motivated', LBL) === 'Asking Retail / Not Motivated');
check('seller stage: old Podio spellings', sellerStageOf('REFUND-WRONG INFO/OTHER', LBL) === 'Dead - Wrong Info' && sellerStageOf('Nurture - Long Term (3M +)', LBL) === 'Nurture - Long Term (3+ Months)' && sellerStageOf('Contacted - FU NEEDED', LBL) === 'Contacted - Follow Up Needed' && sellerStageOf('Trash', LBL) === 'Dead');
check('duration "25 Seconds"', durationSeconds('25 Seconds') === 25);
check('duration "1 Minute 5 Seconds"', durationSeconds('1 Minute 5 Seconds') === 65);
check('duration "2:05" and "125"', durationSeconds('2:05') === 125 && durationSeconds('125') === 125 && durationSeconds('') === null);

const comm = readComm({
  item_id: 43316, created_on: '2026-10-03 03:45:00',
  fields: [
    { field_id: ++fid, external_id: 'contact', type: 'app', label: 'Contact', values: [{ value: { item_id: 9001, title: 'Maria Lopez' } }] },
    text('Call ID', 'da3529b1'), phone('smrtPhone Number', 'main', '+12105550182'), phone('Contact Number', 'main', '+19715550185'),
    cat('Type', 'Incoming Text'), text('Text Message', 'Sorry, on the road all afternoon'), text('Call Owner', 'Jamie Brooks'),
    { field_id: ++fid, external_id: 'created', type: 'date', label: 'Created Date', values: [{ start: '2026-10-02 22:45:00', start_utc: '2026-10-03 03:45:00' }] },
  ],
});
check('comm: inbound text, their number is from', comm?.row.channel === 'sms' && comm.row.direction === 'inbound' && comm.row.from_phone === '+19715550185' && comm.row.to_phone === '+12105550182', comm?.row);
check('comm: body, UTC time, contact link, owner', comm?.row.body === 'Sorry, on the road all afternoon' && comm.row.occurred_at === '2026-10-03T03:45:00Z' && comm.contact_item_ids[0] === 9001 && comm.owner === 'Jamie Brooks');
const call = readComm({ item_id: 1, created_on: '2026-10-02 19:04:00', fields: [phone('smrtPhone Number', 'main', '+18175550184'), phone('Contact Number', 'main', '+15205550183'), cat('Type', 'Outgoing Call'), text('Outbound Status', 'Busy / No Answer'), text('Duration', '45 Seconds')] });
check('comm: outbound call, status and duration', call?.row.channel === 'call' && call.row.to_phone === '+15205550183' && call.row.status === 'busy_no_answer' && call.row.duration_s === 45, call?.row);
check('comm: no type → skipped', readComm({ item_id: 2, fields: [phone('Contact Number', 'main', '+15205550183')] }) === null);

// ---- history: a revision diff → timeline lines ---------------------------------
const diff = [
  { field_id: 7, type: 'category', label: 'Stage', from: [{ value: { text: 'Underwriting' } }], to: [{ value: { text: 'Offer Made' } }] },
  { field_id: 8, type: 'money', label: 'Offer Price', from: [], to: [{ value: '145000.0000', currency: 'USD' }] },
  { field_id: 9, type: 'text', label: 'Notes', from: [], to: [{ value: 'called' }] },
  { field_id: 10, type: 'money', label: 'Asking Price', from: [], to: [{ value: '200000', currency: 'USD' }] },
  { field_id: 11, type: 'category', label: 'Dead', from: [], to: [{ value: { text: 'Yes' } }] },
  { field_id: 12, type: 'category', label: 'Lead Stage', from: [{ value: { text: 'Lead' } }], to: [] },
  { field_id: 13, type: 'number', label: 'Counter Offer', from: [], to: [{ value: '150000' }] },
];
const lines = historyLines(diff, (l) => (l === 'Offer Made' ? 'Offer Made' : null));
check('history: stage, offer, dead, counter; notes, asking and a cleared stage left out',
  JSON.stringify(lines.map((l) => [l.kind, l.title])) === JSON.stringify([['stage', 'Stage → Offer Made'], ['offer', 'Offer Price $145,000'], ['stage', 'Dead: Yes'], ['offer', 'Counter Offer $150,000']]), lines);
check('history: unmapped stage keeps Podio label', historyLines([{ field_id: 1, type: 'category', label: 'Status', to: [{ value: { text: 'Ghosted' } }] }])[0]?.title === 'Stage → Ghosted');
check('history: comment html stripped', commentText({ value: '<p>Sent offer&nbsp;<b>$140k</b></p>' }) === 'Sent offer $140k');

// ---- write-back: a stage a person set in CLOZR goes to the Podio item
const OPTS = [
  { id: 1, text: 'New Submission' }, { id: 2, text: 'Underwrite Declined' }, { id: 3, text: 'Offer Declined' },
  { id: 4, text: 'Offer  made', status: 'deleted' }, { id: 5, text: 'Offer Made' }, { id: 6, text: 'Underwriting - Need Info' },
];
check('option: same words, case and spacing ignored', podioOptionFor('offer declined', OPTS)?.id === 3);
check('option: active one over a retired duplicate', podioOptionFor('Offer Made', OPTS)?.id === 5);
check('option: none for a CLOZR-only stage', podioOptionFor('Dead - Wrong Info', OPTS) === null);
const greenAcre = { to: 'Offer Declined', options: OPTS, podioNow: 'Underwrite Declined', podioAtMove: 'Underwrite Declined', itemLastEvent: '2026-10-02T14:16:15Z', movedAt: '2026-10-05T14:59:38Z' };
const put = pushDecision(greenAcre);
check('push: 1001 Green Acre goes to Offer Declined in Podio', put.kind === 'put' && put.option.id === 3, put);
check('push: Podio already agrees → nothing written', pushDecision({ ...greenAcre, podioNow: 'offer declined' }).kind === 'done');
check('push: Podio changed the stage after the move → Podio wins',
  JSON.stringify(pushDecision({ ...greenAcre, podioNow: 'Offer Made', itemLastEvent: '2026-10-05T15:30:00Z' })) === JSON.stringify({ kind: 'skip', why: 'changed in Podio since' }));
check('push: Podio edited after the move but stage untouched → CLOZR\'s goes over', pushDecision({ ...greenAcre, itemLastEvent: '2026-10-05T15:30:00Z' }).kind === 'put');
check('push: Podio changed before the move (ledger behind) → CLOZR\'s, the later change', pushDecision({ ...greenAcre, podioNow: 'Offer Made' }).kind === 'put');
check('push: a stage Podio has no option for is skipped', JSON.stringify(pushDecision({ ...greenAcre, to: 'Dead' })) === JSON.stringify({ kind: 'skip', why: 'no such stage in Podio' }));
check('push: blank in Podio still takes the move', pushDecision({ ...greenAcre, podioNow: '', podioAtMove: null }).kind === 'put');

// ---- offer amounts CLOZR → Podio ------------------------------------------------
check('money: read by label off the item', podioMoney(item, 'UW Suggested Low Offer') === 140000 && podioMoney(item, 'offer price') === 150000);
check('money: a field the item lacks is null', podioMoney(item, 'Accepted Offer') === null);
const band = { podioNow: { wholesale_offer: 140000, institutional_offer: 155000, offer_amount: 150000 }, applied: { wholesale_offer: 140000, institutional_offer: 155000, offer_amount: 150000 },
  itemLastEvent: '2026-10-01T09:30:00Z', movedAt: '2026-10-05T15:00:00Z' };
const vp = valuesPush({ ...band, want: { wholesale_offer: 138000, offer_amount: '152000' } });
check('values: the low and the offer made go to Podio', JSON.stringify(vp.put) === JSON.stringify({ wholesale_offer: 138000, offer_amount: 152000 }) && !vp.skipped.length, vp);
check('values: Podio already agrees → nothing written', JSON.stringify(valuesPush({ ...band, want: { institutional_offer: 155000 } })) === JSON.stringify({ put: {}, already: ['institutional_offer'], skipped: [] }));
check('values: a blank in CLOZR never blanks Podio', valuesPush({ ...band, want: { wholesale_offer: null } }).skipped[0] === 'wholesale_offer');
const later = valuesPush({ ...band, podioNow: { ...band.podioNow, wholesale_offer: 145000 }, itemLastEvent: '2026-10-05T16:00:00Z', want: { wholesale_offer: 138000, institutional_offer: 160000 } });
check('values: Podio changed the low after → Podio\'s kept, the high still goes', later.skipped.join() === 'wholesale_offer' && later.put.institutional_offer === 160000, later);
check('values: Podio edited before the change (ledger behind) → CLOZR\'s, the later change',
  valuesPush({ ...band, podioNow: { ...band.podioNow, wholesale_offer: 145000 }, want: { wholesale_offer: 138000 } }).put.wholesale_offer === 138000);
check('values: blank in Podio takes CLOZR\'s', valuesPush({ ...band, podioNow: {}, applied: {}, itemLastEvent: '2026-10-05T16:00:00Z', want: { institutional_offer: 160000 } }).put.institutional_offer === 160000);

// ---- cross-source dedupe (a Jotform deal is the submission, not a second one)
const jot = pickAnySourceDeal([
  { id: 5052, source_id: 'jotform:abc', lead_stage: null, submitted_at: '2026-10-05T14:00:00Z', seller_email: 'dana@markspain.com', archived_at: null },
], s);
check('Jotform twin on the same property is linked, not a new deal', !!jot && 'id' in jot && jot.id === 5052 && jot.by === 'address (any source)', jot);
const jotStage = stageMove({ label: s.podio_stage, mapped: s.stage, current: null });
check('a linked Jotform deal with no lead_stage takes the Podio stage', jotStage.kind === 'set' && jotStage.to === 'Underwriting Complete', jotStage);
const staged = pickAnySourceDeal([
  { id: 1, source_id: 'jotform:a', lead_stage: null, submitted_at: '2026-10-05T15:00:00Z' },
  { id: 2, source_id: 'easystreet:b', lead_stage: 'Offer Made', submitted_at: '2026-10-04T15:00:00Z' },
], s);
check('several live deals → the one that already has a submission stage', !!staged && 'id' in staged && staged.id === 2, staged);
const tied = pickAnySourceDeal([
  { id: 8, source_id: 'jotform:a', lead_stage: null, submitted_at: '2026-10-05T15:00:00Z' },
  { id: 9, source_id: 'import:b', lead_stage: null, submitted_at: '2026-10-05T15:00:00Z' },
], { partner_key: null, phone: null, email: null });
check('two live deals, nothing to choose by → ambiguous, nothing written', !!tied && 'ambiguous' in tied && tied.ambiguous.length === 2, tied);

const south = parseAddress('405 S Birchwood Ave, Durham, NC 27701');
const plain = parseAddress('405 Birchwood Ave, Durham, NC 27701');
check('Podio "405 S Birchwood Ave" is the property "405 Birchwood Ave"', sameProperty(south, plain), [addressKey(south!), addressKey(plain!)]);
const variants = addressVariants('405 S Birchwood Ave, Durham, NC 27701');
check('every address variant includes the directional-stripped line', variants.some((v) => addressKey(v) === addressKey(plain!)), variants.map((v) => v.line1));

check('only an archived duplicate → not recreated',
  duplicateArchiveNote([{ archived_at: '2026-10-06T00:00:00Z', archived_reason: 'Duplicate of jotform ingest (Podio sync)' }]) === 'Only an archived duplicate on this property: not recreated.');
check('a live deal beside an archived duplicate is still linkable',
  duplicateArchiveNote([{ archived_at: '2026-10-06T00:00:00Z', archived_reason: 'Duplicate of jotform ingest' }, { archived_at: null, archived_reason: null }]) === null);

const created = '2026-10-05T14:00:00.000Z';
const zipTwin = pickZipTwin([
  { id: 5052, source_id: 'jotform:abc', created_at: '2026-10-05T14:03:00.000Z', zip: '27701', seller_email: 'dana@markspain.com', archived_at: null },
], { created, phone: '+13365550142', email: 'dana@markspain.com', partner_key: 'markspain' }, '27701');
check('no street: a live deal within ±2h on the same zip and contact is the twin', !!zipTwin && 'id' in zipTwin && zipTwin.id === 5052 && zipTwin.by === 'zip + contact', zipTwin);
check('no street: outside the two hours is not a twin', pickZipTwin([
  { id: 1, source_id: 'jotform:abc', created_at: '2026-10-05T18:00:00.000Z', zip: '27701', seller_email: 'dana@markspain.com' },
], { created, phone: null, email: 'dana@markspain.com', partner_key: null }, '27701') === null);

// ---- mapping version: an old ledger row is applied again -------------------------
const event = '2026-10-01T09:30:00Z';
check('field-map version is 2', MAPPING_VERSION === 2);
check('ledger stamped with an older __v is re-applied even if Podio is unchanged', !unchangedSince({ last_event_on: event, applied: { __v: 1, offer_amount: 150000 } }, event));
check('a ledger row with no version is re-applied', !unchangedSince({ last_event_on: event, applied: { offer_amount: 150000 } }, event));
check('the current version, Podio unchanged → skip', unchangedSince({ last_event_on: event, applied: { __v: 2 } }, event));
check('Podio edited after the apply → re-apply', !unchangedSince({ last_event_on: event, applied: { __v: 2 } }, '2026-10-02T09:30:00Z'));

// ---- the Podio notes block --------------------------------------------------------
const contact = (label: string, name: string, mail: string) => ({ field_id: ++fid, external_id: label.toLowerCase().replace(/\W+/g, '-'), type: 'contact', label, values: [{ value: { name, mail: [mail] } }] });
const rich = {
  ...item,
  fields: [
    ...item.fields,
    text('Notes', 'Call after 5'), cat('Listed on MLS?', 'Yes'), text('Garage Info', 'detached'),
    text('Ai Buyer Match', 'x'.repeat(1600)), text('Ai Compr Tool', 'https://thecompr.com/r/abc123'),
    text('Property Type', 'SFR'), text('Photos', 'https://photos.example/album'),
    contact('Who is underwriting/dispo?', 'Morgan Lane', 'morgan@yourcompany.com'),
    contact('Acquisitions', 'Alex Lee', 'alex@yourcompany.com'),
    cat('Funds Sent To', 'Open Door'),
  ],
};
const block = podioBlock(rich);
check('podio block is marker-delimited and carries the unmapped fields',
  block.startsWith(PODIO_BLOCK_START) && block.endsWith(PODIO_BLOCK_END) && block.includes('Listed on MLS: Yes') && block.includes('Submission notes: Call after 5') && block.includes('Garage: detached') && block.includes('AI buyer match: '), block.slice(0, 80));
check('buyer match truncates at 1,500', (block.match(/AI buyer match: (x+)/)?.[1].length ?? 0) === 1500);
const read = readSubmission(rich);
check('compr report, property type, photos and garage read',
  read.cols.compr_report_url === 'https://thecompr.com/r/abc123' && read.cols.underwriting_url === 'https://thecompr.com/r/abc123' && read.facts.property_type === 'Single Family' && read.photos_url === 'https://photos.example/album' && read.photo_urls.length === 1 && read.cols.garage_spaces == null, read.cols);
check('every Photos link is kept, not only the first', readSubmission({ ...item, fields: [...item.fields, text('Photos', 'https://drive.google.com/drive/folders/abc https://www.zillow.com/homedetails/1')] }).photo_urls.join('|') === 'https://drive.google.com/drive/folders/abc|https://www.zillow.com/homedetails/1');
check('a numeric garage is a column, not a block line', readSubmission({ ...item, fields: [...item.fields, text('Garage Info', '2 car')] }).cols.garage_spaces === 2 && !podioBlock({ ...item, fields: [...item.fields, text('Garage Info', '2 car')] }).includes('Garage:'));
const round = mergePodioBlock('My note stays.', block);
const againBlock = podioBlock({ ...rich, fields: rich.fields.map((f) => (f.label === 'Notes' ? text('Notes', 'Updated') : f)) });
const rewritten = mergePodioBlock(round, againBlock);
check('merge keeps the user\'s text and rewrites the block once', rewritten.startsWith('My note stays.') && rewritten.includes('Submission notes: Updated') && !rewritten.includes('Call after 5') && (rewritten.match(/--- Podio fields/g) ?? []).length === 1, rewritten);
check('an empty block removes the section and leaves the user\'s text', mergePodioBlock(round, '') === 'My note stays.');

// ---- roster -----------------------------------------------------------------------
const roster = [
  { user_id: 'u-morgan', full_name: 'Morgan Lane', email: 'morgan@yourcompany.com' },
  { user_id: 'u-alex', full_name: 'Alex Lee', email: 'alex@yourcompany.com' },
  { user_id: 'u-morgan-2', full_name: 'Morgan Lane', email: 'morgan2@example.com' },
];
check('underwriter matches the roster by email', matchRoster(roster, read.underwriters[0]) === 'u-morgan', read.underwriters);
check('acquisitions matches the roster by name when the email is absent', matchRoster(roster, { name: 'Alex Lee', email: null }) === 'u-alex');
check('two members with the same name and no email is no match', matchRoster(roster, { name: 'Morgan Lane', email: null }) === null);

// ---- staying inside the edge CPU budget ------------------------------------------
check('stop after 150 applied items', stopSyncPage({ applied: 150, calls: 1, callCap: 80, now: 0, deadline: 10_000 }));
check('keep going under the item cap', !stopSyncPage({ applied: 149, calls: 1, callCap: 80, now: 0, deadline: 10_000 }));
check('stop when the Podio call budget is nearly spent', stopSyncPage({ applied: 0, calls: 78, callCap: 80, now: 0, deadline: 10_000 }));
check('stop when the wall clock is past', stopSyncPage({ applied: 0, calls: 0, callCap: 80, now: 10_001, deadline: 10_000 }));
const pass = { since: null as string | null, offset: 80, pass_started: '2026-10-06T00:00:00.000Z', total: 4673 };
const mid = cursorAfterPage(pass, 15, { length: 40, size: 40 });
check('a page that stopped early resumes at that offset', mid.offset === 95 && resumeOffset(mid) === 95, mid);
const fullPage = cursorAfterPage({ ...pass, offset: 0 }, 40, { length: 40, size: 40 });
check('a full page advances and stays open', fullPage.offset === 40 && resumeOffset(fullPage) === 40, fullPage);
const closed = cursorAfterPage(pass, 10, { length: 10, size: 40 });
check('a short page closes the pass; the next run starts at 0', closed.offset === null && closed.since === pass.pass_started && resumeOffset(closed) === 0, closed);
check('history keeps a share while the outbox has rows', historyCallCap(0, 120) === 120 && historyCallCap(151, 120) === 40 && historyCallCap(1, 50) === 12);
check('a saved app with no token is named in the sync warnings',
  JSON.stringify(tokenWarnings([{ key: 'submissions', app_token: '  ' }, { key: 'deals', app_token: 'tok' }])) === JSON.stringify(['Submissions app has no token: not syncing']));

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
