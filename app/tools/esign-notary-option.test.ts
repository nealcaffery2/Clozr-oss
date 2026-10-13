// Email lock, signed-contract deal updates, option clocks, notary seals.
// Run: npx tsx tools/esign-notary-option.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addViewSeconds, emailsMatch, formatViewDuration, gateOk, hashAccessCode, maskEmail, signedBody, viewedTitle } from '../supabase/functions/_shared/esign-session';
import { contractSide, isPurchaseContract, nextDealStage, signedDealUpdate } from '../supabase/functions/_shared/contract-apply';
import { daysUntil, optionAlertAudience, optionAtRisk, optionReadouts } from '../supabase/functions/_shared/option-clock';
import { renderNotaryStamp, stampGaps } from '../supabase/functions/_shared/notary-stamp';

assert.equal(emailsMatch('Rlee2014@Example.com', ' rlee2014@example.com '), true);
assert.equal(emailsMatch('rlee2014@example.com', 'other@example.com'), false);
assert.equal(emailsMatch(null, 'rlee2014@example.com'), false);
assert.equal(maskEmail('rlee2014@example.com'), 'rl•••@example.com');
assert.equal(gateOk({ email: 'a@b.com', access_gate: 'abc', email_verified_at: '2026-09-26' }, 'abc'), true);
assert.equal(gateOk({ email: 'a@b.com', access_gate: 'abc', email_verified_at: null }, 'abc'), false);
assert.equal(viewedTitle('seller'), 'Seller viewed contract');
assert.equal(viewedTitle('buyer'), 'Buyer viewed contract');
assert.match(signedBody({ name: 'Robin Lee', email: 'rlee2014@example.com', viewSeconds: 360, signedAt: '2026-09-26T21:12:00Z' }), /Robin Lee/);
assert.match(signedBody({ name: 'Robin Lee', email: 'rlee2014@example.com', viewSeconds: 360, signedAt: '2026-09-26T21:12:00Z' }), /viewed 6 min/);
assert.equal(formatViewDuration(45), '45 sec');
const bumped = addViewSeconds('2026-09-26T21:00:00Z', 10, Date.parse('2026-09-26T21:00:30Z'));
assert.equal(bumped.view_seconds, 40);

const codeHash = await hashAccessCode(4, '123456');
assert.equal(codeHash, await hashAccessCode(4, '123456'));
assert.notEqual(codeHash, await hashAccessCode(4, '654321'));

assert.equal(contractSide('assignment', ['buyer', 'company']), 'buyer');
assert.equal(contractSide('amendment', ['seller']), 'seller');
assert.equal(contractSide('amendment', ['buyer']), 'buyer');

const sellerPsa = signedDealUpdate({
  kind: 'psa', roles: ['seller'], signedOn: '2026-09-26',
  tokens: [
    { name: 'Deal.PurchasePrice', value: '$185,000' },
    { name: 'Deal.EMD', value: '$500' },
    { name: 'Deal.ClosingDate', value: 'October 20, 2026' },
    { name: 'Trec.OptionDays', value: '14' },
  ],
});
assert.equal(sellerPsa.side, 'seller');
assert.equal(sellerPsa.patch.offer_amount, 185000);
assert.equal(sellerPsa.patch.earnest_money, 500);
assert.equal(sellerPsa.patch.close_date, '2026-10-20');
assert.equal(sellerPsa.patch.option_ends_on, '2026-10-10');
assert.equal(sellerPsa.patch.contract_status, 'Fully executed');

const buyer = signedDealUpdate({
  kind: 'assignment', roles: ['buyer'], signedOn: '2026-09-26',
  tokens: [
    { name: 'Deal.PurchasePrice', value: '$185,000' },
    { name: 'Deal.AssignmentPrice', value: '$210,000' },
    { name: 'Buyer.OptionEnd', value: '2026-10-05' },
    { name: 'Deal.ClosingDate', value: '2026-10-20' },
  ],
});
assert.equal(buyer.patch.sold_price, 210000);
assert.equal(buyer.patch.assignment_fee, 25000);
assert.equal(buyer.patch.dispo_fee, 25000);
assert.equal(buyer.patch.buyer_option_ends_on, '2026-10-05');
assert.ok(buyer.notes.some((n) => /profit/i.test(n)));

const extended = signedDealUpdate({
  kind: 'amendment', roles: ['seller'], signedOn: '2026-09-28',
  tokens: [
    { name: 'Amend.SalesPrice', value: '$180,000' },
    { name: 'Amend.ClosingDate', value: 'November 2, 2026' },
    { name: 'Amend.OptionEnd', value: '2026-10-18' },
  ],
});
assert.equal(extended.patch.offer_amount, 180000);
assert.equal(extended.patch.close_date, '2026-11-02');
assert.equal(extended.patch.option_ends_on, '2026-10-18');
assert.equal(extended.patch.contract_status, 'Amended');

const ended = signedDealUpdate({ kind: 'termination', roles: ['buyer'], signedOn: '2026-09-26', tokens: [] });
assert.equal(ended.patch.terminated, true);
assert.equal(ended.patch.option_ends_on, null);
assert.equal(ended.patch.buyer_option_ends_on, null);
assert.equal(nextDealStage('Buyer Under Contract', 'termination', 'buyer'), 'Terminated');
assert.equal(nextDealStage('Closed', 'psa', 'seller'), null);
assert.equal(nextDealStage('Prospect', 'psa', 'seller'), 'Under Contract Seller');
assert.equal(nextDealStage('New Lead', 'psa', 'seller'), 'Under Contract Seller');
assert.equal(nextDealStage('Contract Sent to Seller', 'psa', 'seller'), 'Under Contract Seller');
assert.equal(nextDealStage(null, 'psa', 'seller'), 'Under Contract Seller');
assert.equal(nextDealStage('Under Contract Seller', 'psa', 'seller'), null);
assert.equal(nextDealStage('Ready To Market', 'psa', 'seller'), null);
assert.equal(nextDealStage('Ready To Market', 'assignment', 'buyer'), 'Buyer Under Contract');
assert.equal(isPurchaseContract('psa'), true);
assert.equal(isPurchaseContract('other', 'trec_1_4', 'TREC One to Four Family Residential Contract (Resale)'), true);
assert.equal(isPurchaseContract('assignment', 'assignment', 'Assignment of Contract'), false);

const now = new Date('2026-09-26T18:00:00Z');
assert.equal(daysUntil('2026-09-28', now), 2);
assert.equal(optionAtRisk('2026-09-28', null, now), true);
assert.equal(optionAtRisk('2026-10-20', null, now), false);
const reads = optionReadouts('2026-09-28', '2026-10-12', now);
assert.equal(reads[0].label.includes('Seller option'), true);
assert.equal(reads[0].atRisk, true);
assert.equal(reads[1].atRisk, false);
assert.equal(optionAlertAudience('seller').dealParty, 'acquisitions');
assert.equal(optionAlertAudience('buyer').dealParty, 'dispositions');
assert.equal(optionAlertAudience('buyer').includeTc, true);

const tx = renderNotaryStamp({ name: 'Maria Alvarez', state: 'TX', expires: '2028-03-15' });
assert.match(tx, /MARIA ALVAREZ/);
assert.match(tx, /STATE OF TEXAS/);
assert.match(tx, /NOTARY PUBLIC/);
assert.match(tx, /COMMISSION EXPIRES/);
assert.match(tx, /polygon points/);
assert.deepEqual(stampGaps({ name: 'Maria Alvarez', state: 'TX', expires: '2028-03-15' }), []);
assert.ok(stampGaps({ name: 'Ada', state: 'CA', expires: '2028-01-01' }).includes('Commission number'));
assert.ok(stampGaps({ name: 'Ada', state: 'CA', expires: '2028-01-01', commissionNumber: '99' }).includes('County where the oath is filed'));
const ca = renderNotaryStamp({ name: 'Ada Lopez', state: 'CA', expires: '2028-01-01', commissionNumber: '99', county: 'Bexar' });
assert.match(ca, /BEXAR COUNTY/);
assert.match(ca, /NO. 99/);
const fl = renderNotaryStamp({ name: 'Sam Ortiz', state: 'FL', expires: '2027-06-01', commissionNumber: 'HH123' });
assert.match(fl, /NOTARY PUBLIC-STATE OF FLORIDA/);
assert.match(fl, /MY COMMISSION EXPIRES/);

// Regression: TX notary onboard payload (Robin) draws a seal; commission #
// and county are optional for Texas but must not break the stamp.
const robin = {
  name: 'Robin Edwards',
  state: 'TX',
  expires: '2029-09-24',
  commissionNumber: '123456789',
  county: 'Bexar',
};
assert.deepEqual(stampGaps(robin), []);
const robinSeal = renderNotaryStamp(robin);
assert.match(robinSeal, /ROBIN EDWARDS/);
assert.match(robinSeal, /STATE OF TEXAS/);
assert.match(robinSeal, /SEP 24, 2029/i);

// Migration 104 must keep 'notary' on both role CHECKs — without it,
// add-teammate invite upsert fails with the generic 500.
const mig = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/104_notary_workspace_role.sql'),
  'utf8',
);
assert.match(mig, /workspace_members_role_check[\s\S]*'notary'/);
assert.match(mig, /workspace_invites_role_check[\s\S]*'notary'/);

console.log('esign-notary-option.test.ts ok');
